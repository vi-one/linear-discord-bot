/**
 * Linear service: team resolution, label resolution, and issue creation.
 *
 * Teams may be configured either by UUID or by their human-readable key
 * (e.g. "ENG"). Labels are matched case-insensitively by name against the
 * labels available to the team (team labels + workspace labels); unknown
 * labels are logged and skipped rather than failing the issue.
 *
 * Team and label lookups are cached in-memory since they change rarely;
 * a restart picks up new teams/labels.
 */
import { LinearClient } from '@linear/sdk';
import { childLogger } from './logger.js';

const log = childLogger('linear');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drain a paginated Linear SDK connection into a plain array.
 *
 * `fetchNext()` mutates the connection, accumulating every page's nodes into
 * `connection.nodes` and returning the same object, so we page to the end
 * and read the final, complete `nodes` once (reading it earlier would double
 * up the first page).
 */
export async function fetchAllNodes(connection) {
  let page = connection;
  while (page.pageInfo?.hasNextPage) {
    page = await page.fetchNext();
  }
  return [...page.nodes];
}

/**
 * Memoize an async computation by key, evicting the entry if it rejects so a
 * transient API failure stays retryable (a successful result is cached for the
 * process lifetime). The `.catch` is attached before the promise is stored, so
 * a stale delete can never remove a newer retry promise.
 */
function cacheAsync(cache, key, compute) {
  if (!cache.has(key)) {
    cache.set(
      key,
      compute().catch((err) => {
        cache.delete(key);
        throw err;
      }),
    );
  }
  return cache.get(key);
}

export class LinearService {
  /**
   * @param {string} apiKey Linear personal API key.
   * @param {LinearClient} [client] Injectable client (defaults to a real one; override in tests).
   */
  constructor(apiKey, client = new LinearClient({ apiKey })) {
    this.client = client;
    /** @type {Map<string, Promise<import('@linear/sdk').Team>>} teamRef -> team */
    this._teamCache = new Map();
    /** @type {Map<string, Promise<Map<string, {id: string, name: string}>>>} teamId -> lowercased label name -> label */
    this._labelCache = new Map();
  }

  /** Verify the API key works and log who we are. Throws on auth failure. */
  async verifyAuth() {
    const viewer = await this.client.viewer;
    // Name only; the account email is PII we don't need in logs.
    log.info({ user: viewer.name }, 'Authenticated with Linear');
  }

  /**
   * High-level entry point: resolve the team + labels and create the issue in
   * one call so callers (the Discord layer) don't orchestrate Linear's internal
   * steps or pass Linear-shaped intermediates around.
   *
   * @param {{teamRef: string, title: string, description: string, labelNames: string[]}} input
   * @returns {Promise<{id: string, identifier: string, url: string, title: string, teamKey: string}>}
   */
  async createIssueFromThread({ teamRef, title, description, labelNames }) {
    const team = await this.resolveTeam(teamRef);
    const labelIds = await this.resolveLabelIds(team, labelNames);
    const issue = await this.createIssue({ teamId: team.id, title, description, labelIds });
    return { ...issue, teamKey: team.key ?? teamRef };
  }

  /**
   * Resolve a team by UUID or by key (e.g. "ENG"). Cached per reference.
   * Throws with a clear message when the team cannot be found.
   */
  async resolveTeam(teamRef) {
    return cacheAsync(this._teamCache, teamRef.toLowerCase(), () => this._lookupTeam(teamRef));
  }

  async _lookupTeam(teamRef) {
    if (UUID_PATTERN.test(teamRef)) {
      try {
        return await this.client.team(teamRef);
      } catch (err) {
        throw new Error(`Linear team with id "${teamRef}" not found or not accessible: ${err.message}`);
      }
    }

    // Not a UUID: treat it as a team key. Keys are uppercase in Linear, but
    // we match case-insensitively to be forgiving about config typing.
    const connection = await this.client.teams({ filter: { key: { eqIgnoreCase: teamRef } } });
    const teams = await fetchAllNodes(connection);
    if (teams.length === 0) {
      throw new Error(
        `No Linear team found with key "${teamRef}". Check the key in Linear (Settings -> Teams) or use the team UUID.`,
      );
    }
    return teams[0];
  }

  /**
   * Map label *names* to Linear label IDs for a team, case-insensitively.
   * Names that do not exist in Linear are logged as warnings and skipped.
   *
   * @param {import('@linear/sdk').Team} team
   * @param {string[]} labelNames
   * @returns {Promise<string[]>} de-duplicated label IDs
   */
  async resolveLabelIds(team, labelNames) {
    if (labelNames.length === 0) return [];

    const labelsByName = await this._getTeamLabels(team);
    const ids = new Set();
    for (const name of labelNames) {
      const label = labelsByName.get(name.toLowerCase());
      if (label) {
        ids.add(label.id);
      } else {
        log.warn(
          { team: team.key, label: name },
          'Configured Linear label does not exist for this team; skipping it (create it in Linear to use it)',
        );
      }
    }
    return [...ids];
  }

  /** Fetch (and cache) all labels usable by a team: team-scoped + workspace-scoped. */
  _getTeamLabels(team) {
    return cacheAsync(this._labelCache, team.id, async () => {
      // Two queries so we know each label's scope without touching lazy
      // relation getters: workspace labels first, then team labels, so a
      // team-scoped label wins any name collision.
      const [workspaceConn, teamConn] = await Promise.all([
        this.client.issueLabels({ filter: { team: { null: true } } }),
        this.client.issueLabels({ filter: { team: { id: { eq: team.id } } } }),
      ]);
      const [workspaceLabels, teamLabels] = await Promise.all([
        fetchAllNodes(workspaceConn),
        fetchAllNodes(teamConn),
      ]);
      const byName = new Map();
      for (const label of [...workspaceLabels, ...teamLabels]) {
        byName.set(label.name.toLowerCase(), { id: label.id, name: label.name });
      }
      log.debug({ team: team.key, count: byName.size }, 'Cached Linear labels for team');
      return byName;
    });
  }

  /**
   * Create a Linear issue and return its essentials.
   *
   * @returns {Promise<{id: string, identifier: string, url: string, title: string}>}
   */
  async createIssue({ teamId, title, description, labelIds }) {
    const payload = await this.client.createIssue({ teamId, title, description, labelIds });
    if (!payload.success) {
      throw new Error('Linear rejected the issue creation (createIssue returned success=false)');
    }
    const issue = await payload.issue;
    if (!issue) {
      throw new Error('Linear created the issue but did not return it');
    }
    return { id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title };
  }

  /**
   * Create a comment on an issue. Returns the comment id so the caller can
   * track it for later edits/deletes.
   *
   * @param {string} issueId
   * @param {string} body
   * @returns {Promise<string>} the created comment's id
   */
  async createComment(issueId, body) {
    const payload = await this.client.createComment({ issueId, body });
    if (!payload.success) throw new Error('Linear rejected the comment creation (success=false)');
    const comment = await payload.comment;
    if (!comment) throw new Error('Linear created the comment but did not return it');
    return comment.id;
  }

  /** Replace a comment's body. */
  async updateComment(commentId, body) {
    const payload = await this.client.updateComment(commentId, { body });
    if (!payload.success) throw new Error('Linear rejected the comment update (success=false)');
  }

  /** Delete a comment. */
  async deleteComment(commentId) {
    await this.client.deleteComment(commentId);
  }
}
