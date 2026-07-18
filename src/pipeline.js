/**
 * Pure domain logic for the forum-thread -> Linear-issue pipeline.
 *
 * Everything here is plain data in, plain data out: no I/O, no discord.js or
 * Linear SDK objects. This keeps the trigger rule and the issue formatting
 * directly unit-testable, while src/discord.js stays a thin layer of event
 * wiring, fetching, and logging.
 */

/** Linear caps issue titles; keep some headroom. */
export const MAX_TITLE_LENGTH = 250;
/** Keep descriptions bounded so a pathological post can't blow up the API call. */
export const MAX_DESCRIPTION_LENGTH = 40_000;
/** Attachment links are only trusted when served from Discord's own CDN. */
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Escape markdown link/emphasis metacharacters in user-controlled text so a
 * crafted thread name or filename can't break out of a `[text](url)` link and
 * point the "trusted" footer link somewhere else (or forge bot-authored
 * structure inside the issue).
 */
export function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, '\\$&');
}

export function isDiscordCdnUrl(url) {
  try {
    return DISCORD_CDN_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * Resolve a tag NAME to its tag ID within a forum's available tags,
 * case-insensitively. Returns the tag id, or null when no tag matches.
 *
 * @param {{id: string, name: string}[]} availableTags
 * @param {string} tagName
 * @returns {string | null}
 */
export function findTagId(availableTags, tagName) {
  const wanted = tagName.toLowerCase();
  const tag = availableTags.find((t) => t.name.toLowerCase() === wanted);
  return tag?.id ?? null;
}

/**
 * Map applied Discord tag IDs to their human-readable names via the forum's
 * available tags. IDs that don't resolve to a known tag are dropped.
 *
 * @param {{id: string, name: string}[]} availableTags
 * @param {string[]} appliedTagIds
 * @returns {string[]}
 */
export function tagNamesFromIds(availableTags, appliedTagIds) {
  const byId = new Map(availableTags.map((t) => [t.id, t.name]));
  return appliedTagIds.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * THE core trigger rule: an issue is created only when the trigger tag
 * transitions absent -> present. Re-saving an already-present tag, removing
 * it, or adding unrelated tags never fires. Thread creation is modeled as
 * `previousTagIds = []`, so a thread born with the tag fires too.
 * Null/undefined tag arrays are treated as empty.
 *
 * @param {string[] | null | undefined} currentTagIds
 * @param {string[] | null | undefined} previousTagIds
 * @param {string} triggerTagId
 * @returns {boolean}
 */
export function shouldTrigger(currentTagIds, previousTagIds, triggerTagId) {
  return (currentTagIds ?? []).includes(triggerTagId) && !(previousTagIds ?? []).includes(triggerTagId);
}

/**
 * Collect the Linear label names to apply: mapped Discord tags (matched
 * case-insensitively against the configured labelMap) plus default labels.
 *
 * @param {{labelMap: Record<string, string>, defaultLabels: string[]}} forumCfg
 * @param {string[]} tagNames
 * @returns {string[]} de-duplicated label names
 */
export function labelNamesFor(forumCfg, tagNames) {
  const mapByLowerTag = new Map(
    Object.entries(forumCfg.labelMap).map(([tag, label]) => [tag.toLowerCase(), label]),
  );
  const names = new Set(forumCfg.defaultLabels);
  for (const tagName of tagNames) {
    const label = mapByLowerTag.get(tagName.toLowerCase());
    if (label) names.add(label);
  }
  return [...names];
}

/**
 * Shape a thread's starter-message data into issue markdown.
 *
 * @param {{
 *   threadName: string,
 *   threadUrl: string,
 *   authorTag: string | null,
 *   content: string | null,
 *   attachments: {name: string, url: string}[] | null,
 * }} input
 * @returns {string}
 */
export function formatIssueDescription({ threadName, threadUrl, authorTag, content, attachments }) {
  const parts = [];
  // Trusted provenance line FIRST, with the user's thread name escaped so it
  // cannot break out of the link. Anything below is clearly user-submitted.
  const author = authorTag ? ` by **${escapeMarkdown(authorTag)}**` : '';
  parts.push(`Created from Discord thread [${escapeMarkdown(threadName)}](${threadUrl})${author}.`);
  parts.push('---');

  // User content is quoted and clearly labelled so it can't masquerade as
  // bot-authored structure (e.g. forge its own "Created from…" footer).
  if (content?.trim()) {
    const body = truncate(content.trim(), MAX_DESCRIPTION_LENGTH);
    const quoted = body.split('\n').map((line) => `> ${line}`).join('\n');
    parts.push(`**User-submitted content:**\n${quoted}`);
  } else {
    parts.push('*No text content in the thread starter message.*');
  }

  if (attachments?.length) {
    const links = attachments
      .filter((a) => isDiscordCdnUrl(a.url)) // don't render links to arbitrary hosts
      .map((a) => `- [${escapeMarkdown(a.name)}](${a.url})`);
    if (links.length) parts.push(`**Attachments**\n${links.join('\n')}`);
  }

  return parts.join('\n\n');
}
