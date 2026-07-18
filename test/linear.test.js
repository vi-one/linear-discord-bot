import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Silence app logging before the app module is loaded.
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';

const { LinearService, fetchAllNodes } = await import('../src/linear.js');

const TEAM_UUID = '01234567-89ab-cdef-0123-456789abcdef';

/**
 * Fake a Linear SDK connection with the real SDK's semantics: `fetchNext()`
 * ACCUMULATES each new page's nodes into `connection.nodes` (returning the
 * same object) and flips `pageInfo.hasNextPage` when exhausted.
 *
 * @param {object[][]} pages
 */
function fakeConnection(pages) {
  let idx = 0;
  const conn = {
    nodes: [...pages[0]],
    pageInfo: { hasNextPage: pages.length > 1 },
    async fetchNext() {
      idx += 1;
      conn.nodes.push(...pages[idx]);
      conn.pageInfo = { hasNextPage: idx < pages.length - 1 };
      return conn;
    },
  };
  return conn;
}

/** Minimal-but-faithful fake of the LinearClient surface the service uses. */
function makeFakeClient({
  teamsPages = [[{ id: 'team-1', key: 'ENG', name: 'Engineering' }]],
  teamById = { id: TEAM_UUID, key: 'ENG', name: 'Engineering' },
  workspaceLabels = [],
  teamLabels = [],
  createdIssue = { id: 'issue-1', identifier: 'ENG-42', url: 'https://linear.app/x/issue/ENG-42', title: 'T' },
  createIssueSuccess = true,
  createdCommentId = 'comment-1',
  createCommentSuccess = true,
  updateCommentSuccess = true,
} = {}) {
  const calls = { team: [], teams: [], issueLabels: [], createIssue: [], createComment: [], updateComment: [], deleteComment: [] };
  const client = {
    calls,
    get viewer() {
      return Promise.resolve({ id: 'viewer-1', name: 'Test User' });
    },
    async team(id) {
      calls.team.push(id);
      return teamById;
    },
    async teams(args) {
      calls.teams.push(args);
      return fakeConnection(teamsPages);
    },
    async issueLabels(args) {
      calls.issueLabels.push(args);
      // Route on the filter shape the service uses: workspace labels are
      // requested with { team: { null: true } }, team labels with an id eq.
      if (args?.filter?.team?.null) return fakeConnection([workspaceLabels]);
      return fakeConnection([teamLabels]);
    },
    async createIssue(input) {
      calls.createIssue.push(input);
      return { success: createIssueSuccess, issue: Promise.resolve(createIssueSuccess ? createdIssue : null) };
    },
    async createComment(input) {
      calls.createComment.push(input);
      return {
        success: createCommentSuccess,
        comment: Promise.resolve(createCommentSuccess ? { id: createdCommentId } : null),
      };
    },
    async updateComment(id, input) {
      calls.updateComment.push([id, input]);
      return { success: updateCommentSuccess, comment: Promise.resolve({ id }) };
    },
    async deleteComment(id) {
      calls.deleteComment.push(id);
      return { success: true };
    },
  };
  return client;
}

describe('fetchAllNodes', () => {
  test('drains all pages without duplicating any node', async () => {
    const pages = [
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'c' }, { id: 'd' }],
      [{ id: 'e' }, { id: 'f' }],
    ];
    const nodes = await fetchAllNodes(fakeConnection(pages));
    assert.equal(nodes.length, 6);
    assert.deepEqual(nodes.map((n) => n.id), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(new Set(nodes.map((n) => n.id)).size, 6, 'no duplicate nodes across pages');
  });

  test('single-page connection returns its nodes as-is', async () => {
    const nodes = await fetchAllNodes(fakeConnection([[{ id: 'only' }]]));
    assert.deepEqual(nodes, [{ id: 'only' }]);
  });

  test('empty connection returns an empty array', async () => {
    const nodes = await fetchAllNodes(fakeConnection([[]]));
    assert.deepEqual(nodes, []);
  });
});

describe('resolveTeam', () => {
  test('a UUID reference goes through client.team()', async () => {
    const client = makeFakeClient();
    const svc = new LinearService('key', client);
    const team = await svc.resolveTeam(TEAM_UUID);
    assert.deepEqual(client.calls.team, [TEAM_UUID]);
    assert.equal(client.calls.teams.length, 0);
    assert.equal(team.key, 'ENG');
  });

  test('a key reference filters client.teams() case-insensitively', async () => {
    const client = makeFakeClient({ teamsPages: [[{ id: 'team-9', key: 'OPS' }]] });
    const svc = new LinearService('key', client);
    const team = await svc.resolveTeam('ops');
    assert.deepEqual(client.calls.teams, [{ filter: { key: { eqIgnoreCase: 'ops' } } }]);
    assert.equal(team.id, 'team-9');
  });

  test('successful lookups are cached (second call does not hit the client)', async () => {
    const client = makeFakeClient();
    const svc = new LinearService('key', client);
    await svc.resolveTeam('ENG');
    await svc.resolveTeam('ENG');
    assert.equal(client.calls.teams.length, 1);
  });

  test('an unknown key rejects with a helpful message', async () => {
    const client = makeFakeClient({ teamsPages: [[]] });
    const svc = new LinearService('key', client);
    await assert.rejects(svc.resolveTeam('NOPE'), /No Linear team found with key "NOPE"/);
  });

  test('a rejected lookup is NOT cached; the next call retries', async () => {
    let failures = 0;
    const client = makeFakeClient();
    client.teams = async (args) => {
      client.calls.teams.push(args);
      if (client.calls.teams.length === 1) {
        failures += 1;
        throw new Error('transient network failure');
      }
      return fakeConnection([[{ id: 'team-1', key: 'ENG' }]]);
    };

    const svc = new LinearService('key', client);
    await assert.rejects(svc.resolveTeam('ENG'), /transient network failure/);
    const team = await svc.resolveTeam('ENG'); // retry must reach the client again
    assert.equal(failures, 1);
    assert.equal(client.calls.teams.length, 2);
    assert.equal(team.id, 'team-1');
  });
});

describe('resolveLabelIds', () => {
  const team = { id: 'team-1', key: 'ENG' };

  test('maps names to ids case-insensitively and skips unknown names', async () => {
    const client = makeFakeClient({
      workspaceLabels: [{ id: 'w-discord', name: 'Discord' }],
      teamLabels: [{ id: 't-bug', name: 'Bug' }],
    });
    const svc = new LinearService('key', client);
    const ids = await svc.resolveLabelIds(team, ['bug', 'DISCORD', 'does-not-exist']);
    assert.deepEqual(ids, ['t-bug', 'w-discord']);
  });

  test('team-scoped label wins a name collision with a workspace label', async () => {
    const client = makeFakeClient({
      workspaceLabels: [{ id: 'w-bug', name: 'Bug' }],
      teamLabels: [{ id: 't-bug', name: 'Bug' }],
    });
    const svc = new LinearService('key', client);
    assert.deepEqual(await svc.resolveLabelIds(team, ['Bug']), ['t-bug']);
  });

  test('empty name list short-circuits without hitting the client', async () => {
    const client = makeFakeClient();
    const svc = new LinearService('key', client);
    assert.deepEqual(await svc.resolveLabelIds(team, []), []);
    assert.equal(client.calls.issueLabels.length, 0);
  });
});

describe('createIssueFromThread', () => {
  test('resolves team + labels and creates the issue with the right ids', async () => {
    const client = makeFakeClient({
      teamsPages: [[{ id: 'team-1', key: 'ENG' }]],
      workspaceLabels: [{ id: 'w-discord', name: 'discord' }],
      teamLabels: [{ id: 't-bug', name: 'Bug' }],
    });
    const svc = new LinearService('key', client);

    const result = await svc.createIssueFromThread({
      teamRef: 'ENG',
      title: 'My thread',
      description: 'body',
      labelNames: ['Bug', 'discord'],
    });

    assert.equal(client.calls.createIssue.length, 1);
    assert.deepEqual(client.calls.createIssue[0], {
      teamId: 'team-1',
      title: 'My thread',
      description: 'body',
      labelIds: ['t-bug', 'w-discord'],
    });
    assert.equal(result.identifier, 'ENG-42');
    assert.equal(result.url, 'https://linear.app/x/issue/ENG-42');
    assert.equal(result.teamKey, 'ENG');
  });

  test('rejects when Linear reports success=false', async () => {
    const client = makeFakeClient({ createIssueSuccess: false });
    const svc = new LinearService('key', client);
    await assert.rejects(
      svc.createIssueFromThread({ teamRef: 'ENG', title: 't', description: 'd', labelNames: [] }),
      /success=false/,
    );
  });
});

describe('comment sync methods', () => {
  test('createComment passes issueId + body and returns the comment id', async () => {
    const client = makeFakeClient({ createdCommentId: 'comment-77' });
    const svc = new LinearService('key', client);
    const id = await svc.createComment('issue-1', 'the body');
    assert.deepEqual(client.calls.createComment, [{ issueId: 'issue-1', body: 'the body' }]);
    assert.equal(id, 'comment-77');
  });

  test('createComment rejects when Linear reports success=false', async () => {
    const client = makeFakeClient({ createCommentSuccess: false });
    const svc = new LinearService('key', client);
    await assert.rejects(svc.createComment('issue-1', 'body'), /success=false/);
  });

  test('updateComment passes the id and { body }', async () => {
    const client = makeFakeClient();
    const svc = new LinearService('key', client);
    await svc.updateComment('comment-1', 'new body');
    assert.deepEqual(client.calls.updateComment, [['comment-1', { body: 'new body' }]]);
  });

  test('updateComment rejects when Linear reports success=false', async () => {
    const client = makeFakeClient({ updateCommentSuccess: false });
    const svc = new LinearService('key', client);
    await assert.rejects(svc.updateComment('comment-1', 'body'), /success=false/);
  });

  test('deleteComment passes the id', async () => {
    const client = makeFakeClient();
    const svc = new LinearService('key', client);
    await svc.deleteComment('comment-9');
    assert.deepEqual(client.calls.deleteComment, ['comment-9']);
  });
});

describe('verifyAuth', () => {
  test('resolves when the client viewer is reachable', async () => {
    const svc = new LinearService('key', makeFakeClient());
    await svc.verifyAuth(); // must not throw
  });
});
