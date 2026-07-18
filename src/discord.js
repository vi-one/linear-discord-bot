/**
 * Discord side of the bot: client setup, event handling, and the
 * forum-thread -> Linear-issue pipeline.
 *
 * Trigger model:
 *  - `ThreadUpdate`: we diff `oldThread.appliedTags` vs `newThread.appliedTags`
 *    and act only when the trigger tag transitions absent -> present. Adding
 *    other tags, renaming the thread, or re-saving an already-present tag
 *    never fires the pipeline.
 *  - `ThreadCreate`: covers threads born with the trigger tag already applied
 *    (Discord lets users pick tags in the "new post" dialog).
 *
 * Duplicate prevention is two layers:
 *  - a persistent store (threadId -> issue), checked before and written after
 *    each creation, surviving restarts;
 *  - an in-memory "in flight" set guarding against the create/update events
 *    racing each other for the same thread within one process.
 */
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { childLogger } from './logger.js';
import {
  MAX_TITLE_LENGTH,
  findTagId,
  formatComment,
  formatIssueDescription,
  formatLinearComment,
  labelNamesFor,
  shouldTrigger,
  tagNamesFromIds,
  truncate,
} from './pipeline.js';

const log = childLogger('discord');

// Reserved store key (not a snowflake) that persists the last poll time for
// the Linear -> Discord comment sync inside the existing store.
const POLL_STATE_KEY = '#linear-poll-state';

/**
 * Build the routing table: guildId -> (channelId -> forum config).
 * This is what makes multi-guild / multi-forum support O(1) at event time.
 * (Duplicate guild/channel IDs are rejected during config validation, so no
 * entry here can silently clobber another.)
 */
function buildRoutes(config) {
  const routes = new Map();
  for (const guild of config.guilds) {
    const forums = new Map();
    for (const forum of guild.forums) {
      forums.set(forum.channelId, { ...forum, guildName: guild.name });
    }
    routes.set(guild.id, forums);
  }
  return routes;
}

export function createBot({ config, store, linear }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, // guild + thread lifecycle events
      GatewayIntentBits.GuildMessages, // message create/update/delete events in threads (non-privileged)
      GatewayIntentBits.MessageContent, // privileged: read the starter message body for issue descriptions
    ],
    // Threads/messages may arrive uncached; partials keep events flowing.
    partials: [Partials.Channel, Partials.Message],
    // The bot never needs to ping anyone; disable all mentions so no
    // user-controlled string in a reply can ever become an @everyone/@role/@user.
    allowedMentions: { parse: [] },
  });

  const routes = buildRoutes(config);
  /** Threads currently being processed, to serialize racing events. */
  const inFlight = new Set();
  /** Message IDs currently being mirrored to Linear, to serialize racing events. */
  const commentInFlight = new Set();
  /** Keys we already warned about, to avoid log spam on every event. */
  const warned = new Set();
  /** Timer + reentrancy guard for the Linear comment poller. */
  let pollTimer = null;
  let polling = false;

  /** Log a warning only once per key (shared by the event path and startup audit). */
  function warnOnce(key, fields, message) {
    if (warned.has(key)) return;
    warned.add(key);
    log.warn(fields, message);
  }

  /** Look up the forum config for a thread, or null if we don't manage it. */
  function forumConfigFor(thread) {
    const guildForums = routes.get(thread.guildId);
    if (!guildForums) return null;
    return guildForums.get(thread.parentId) ?? null;
  }

  /**
   * Resolve the configured trigger tag NAME to its tag ID on this specific
   * forum (each forum has its own tag set, so IDs differ per channel).
   */
  function resolveTriggerTagId(forumChannel, forumCfg) {
    const id = findTagId(forumChannel.availableTags, forumCfg.triggerTag);
    if (!id) {
      warnOnce(
        `tag:${forumChannel.id}`,
        { channel: forumChannel.name, channelId: forumChannel.id, triggerTag: forumCfg.triggerTag },
        'Forum has no tag matching the configured trigger tag; create it in the forum settings',
      );
    }
    return id;
  }

  /** Guard: is this thread's parent a real forum channel we manage? */
  async function validForumParent(thread, forumCfg) {
    let parent = thread.parent;
    if (!parent && thread.parentId) {
      // Parent channel may be uncached (reconnects/cache eviction). Fetch it
      // before giving up, so we don't silently drop a trigger on a managed forum.
      try {
        parent = await thread.guild.channels.fetch(thread.parentId);
      } catch (err) {
        warnOnce(`noparent:${thread.id}`, { threadId: thread.id, err: err.message },
          'Could not resolve thread parent channel; skipping');
        return null;
      }
    }
    if (!parent) {
      warnOnce(`noparent:${thread.id}`, { threadId: thread.id }, 'Thread has no resolvable parent channel; skipping');
      return null;
    }
    if (parent.type !== ChannelType.GuildForum) {
      warnOnce(
        `type:${parent.id}`,
        { channelId: parent.id, channel: parent.name, type: ChannelType[parent.type], guild: forumCfg.guildName },
        'Configured channel is not a forum channel (GuildForum); ignoring it - fix config.yml',
      );
      return null;
    }
    return parent;
  }

  /** Fetch the thread's starter message and shape it into issue markdown. */
  async function buildDescription(thread) {
    let starter = null;
    try {
      starter = await thread.fetchStarterMessage();
    } catch (err) {
      log.warn({ threadId: thread.id, err: err.message }, 'Could not fetch starter message (deleted?)');
    }

    return formatIssueDescription({
      threadName: thread.name,
      threadUrl: thread.url,
      authorTag: starter?.author?.tag ?? starter?.author?.username ?? null,
      content: starter?.content ?? null,
      attachments: starter?.attachments
        ? [...starter.attachments.values()].map((a) => ({ name: a.name, url: a.url }))
        : [],
    });
  }

  /**
   * Core pipeline: turn a triggered thread into a Linear issue exactly once.
   */
  async function processThread(thread, forumCfg, forumChannel, trigger) {
    if (store.has(thread.id)) {
      const existing = store.get(thread.id);
      log.debug({ threadId: thread.id, issue: existing?.identifier }, 'Thread already has a Linear issue; skipping');
      return;
    }
    if (inFlight.has(thread.id)) {
      log.debug({ threadId: thread.id }, 'Thread is already being processed; skipping racing event');
      return;
    }
    inFlight.add(thread.id);

    try {
      // Re-check after acquiring the guard: another event may have finished
      // while this one was queued behind an await upstream.
      if (store.has(thread.id)) return;

      const tagNames = tagNamesFromIds(forumChannel.availableTags, thread.appliedTags);
      const issue = await linear.createIssueFromThread({
        teamRef: forumCfg.team,
        title: truncate(thread.name, MAX_TITLE_LENGTH),
        description: await buildDescription(thread),
        labelNames: labelNamesFor(forumCfg, tagNames),
      });

      // Persist the dedupe record. If it fails, the entry stays in memory
      // (dedupe holds until restart) but we log an error so an operator can
      // reconcile; a restart could otherwise re-create this issue.
      try {
        await store.set(thread.id, {
          issueId: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          guildId: thread.guildId,
          channelId: thread.parentId,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        log.error(
          { err, threadId: thread.id, issue: issue.identifier },
          'Created Linear issue but FAILED to persist the dedupe record; a restart may create a duplicate - reconcile manually',
        );
      }

      // Nothing is posted to Discord: the issue lives in Linear. This log line
      // is the record that it was created.
      log.info(
        { threadId: thread.id, thread: thread.name, issue: issue.identifier, team: issue.teamKey, trigger },
        'Created Linear issue from forum thread',
      );
    } finally {
      inFlight.delete(thread.id);
    }
  }

  /** Shared entry for both events: route, validate, detect trigger, process. */
  async function maybeHandle(thread, { previousTagIds, trigger }) {
    const forumCfg = forumConfigFor(thread);
    if (!forumCfg) return; // not a channel we manage

    const forumChannel = await validForumParent(thread, forumCfg);
    if (!forumChannel) return;

    const triggerTagId = resolveTriggerTagId(forumChannel, forumCfg);
    if (!triggerTagId) return;

    // Fire only on the absent -> present transition (or presence at creation).
    if (!shouldTrigger(thread.appliedTags, previousTagIds, triggerTagId)) return;

    await processThread(thread, forumCfg, forumChannel, trigger);
  }

  // --- Message sync: mirror thread messages as Linear comments -------------

  // The thread's issue record + its forum config, if this message belongs to a
  // managed thread that has an issue and has message-sync enabled. channelId of a
  // thread message equals the thread id; rec.channelId is the parent forum id.
  function commentContextFor(message) {
    const rec = store.get(message.channelId);
    if (!rec) return null;
    const forumCfg = routes.get(message.guildId)?.get(rec.channelId);
    if (!forumCfg || !forumCfg.syncMessages) return null;
    return { rec, forumCfg };
  }

  /** Shape a discord.js message into formatComment input. */
  function commentInputFrom(message) {
    return {
      authorTag: message.author?.tag ?? message.author?.username ?? null,
      content: message.content ?? null,
      attachments: [...(message.attachments?.values() ?? [])].map((a) => ({ name: a.name, url: a.url })),
    };
  }

  async function handleMessageCreate(message) {
    // Mirrored Linear comments are bot-authored, so this guard also stops them
    // from being synced back to Linear (no loop).
    if (message.author?.bot || message.system) return;
    if (message.id === message.channelId) return; // forum starter message is already the issue description
    const ctx = commentContextFor(message);
    if (!ctx) return;
    if (ctx.rec.comments?.[message.id] || commentInFlight.has(message.id)) return;
    commentInFlight.add(message.id);
    try {
      if (ctx.rec.comments?.[message.id]) return;
      const commentId = await linear.createComment(ctx.rec.issueId, formatComment(commentInputFrom(message)));
      ctx.rec.comments ??= {};
      ctx.rec.comments[message.id] = commentId;
      await store.set(message.channelId, ctx.rec);
      log.debug({ threadId: message.channelId, messageId: message.id, comment: commentId }, 'Synced Discord message to Linear comment');
    } finally {
      commentInFlight.delete(message.id);
    }
  }

  async function handleMessageUpdate(oldMessage, newMessage) {
    let msg = newMessage;
    if (msg.partial) { try { msg = await msg.fetch(); } catch { return; } }
    if (msg.author?.bot || msg.system) return;
    const ctx = commentContextFor(msg);
    if (!ctx) return;
    const commentId = ctx.rec.comments?.[msg.id];
    if (!commentId) return; // message was never synced
    if (!oldMessage?.partial && oldMessage?.content === msg.content) return; // no content change (embed load, pin, etc.)
    await linear.updateComment(commentId, formatComment(commentInputFrom(msg)));
    log.debug({ threadId: msg.channelId, messageId: msg.id, comment: commentId }, 'Updated Linear comment from edited message');
  }

  // Works with partial messages: only ids are needed to find the mapping.
  async function handleMessageDelete(message) {
    const rec = store.get(message.channelId);
    const commentId = rec?.comments?.[message.id];
    if (!commentId) return;
    const forumCfg = routes.get(message.guildId)?.get(rec.channelId);
    if (forumCfg && !forumCfg.syncMessages) return; // sync off; leave it. (If unresolvable, still clean up.)
    await linear.deleteComment(commentId);
    delete rec.comments[message.id];
    await store.set(message.channelId, rec);
    log.debug({ threadId: message.channelId, messageId: message.id, comment: commentId }, 'Deleted Linear comment for deleted message');
  }

  // --- Reverse sync: poll Linear comments into Discord threads -------------

  // Reverse index: Linear issue id -> tracked thread. Skips the reserved
  // poll-state record and any record without an issueId.
  function issueThreadIndex() {
    const idx = new Map();
    for (const [threadId, rec] of store.entries) {
      if (rec?.issueId) idx.set(rec.issueId, { threadId, rec });
    }
    return idx;
  }

  // Mirror one Linear comment into its Discord thread (create or edit).
  // Persists the commentId -> discord messageId mapping in rec.linearComments.
  async function mirrorLinearComment(threadId, rec, comment) {
    const body = formatLinearComment({ authorName: comment.authorName, body: comment.body, url: comment.url });
    let channel;
    try {
      channel = await client.channels.fetch(threadId);
    } catch (err) {
      log.warn({ threadId, commentId: comment.id, err: err.message }, 'Could not fetch thread to mirror Linear comment');
      return;
    }
    if (!channel?.isTextBased?.()) return;
    rec.linearComments ??= {};
    const existingMsgId = rec.linearComments[comment.id];
    try {
      if (existingMsgId) {
        const msg = await channel.messages.fetch(existingMsgId).catch(() => null);
        if (msg) { await msg.edit(body); return; }
      }
      const sent = await channel.send(body);
      rec.linearComments[comment.id] = sent.id;
      await store.set(threadId, rec);
    } catch (err) {
      log.warn({ threadId, commentId: comment.id, err: err.message }, 'Could not post/edit Linear comment in thread');
    }
  }

  // One poll cycle: fetch comments updated since the last cycle and mirror
  // them. Non-overlapping (polling guard); skips the bot's own comments and
  // untracked issues; only forums with syncMessages on.
  async function pollLinearComments() {
    if (polling) return;
    polling = true;
    try {
      const stored = store.get(POLL_STATE_KEY);
      const since = stored?.lastPollAt ?? new Date().toISOString();
      const nextSince = new Date().toISOString();
      const comments = await linear.pollComments(since);
      const index = issueThreadIndex();
      for (const comment of comments) {
        if (!comment.issueId) continue;
        if (comment.authorId && comment.authorId === linear.viewerId) continue; // our own comment (originated from Discord)
        const target = index.get(comment.issueId);
        if (!target) continue; // not a tracked issue
        const forumCfg = routes.get(target.rec.guildId)?.get(target.rec.channelId);
        if (!forumCfg || !forumCfg.syncMessages) continue;
        await mirrorLinearComment(target.threadId, target.rec, comment);
      }
      await store.set(POLL_STATE_KEY, { lastPollAt: nextSince });
    } catch (err) {
      log.error({ err }, 'Linear comment poll cycle failed');
    } finally {
      polling = false;
    }
  }

  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    // Discord also emits ThreadCreate when the bot gains access to an
    // existing thread; only newly created threads matter here.
    if (!newlyCreated) return;
    try {
      await maybeHandle(thread, { previousTagIds: [], trigger: 'thread-create' });
    } catch (err) {
      log.error({ err, threadId: thread.id, thread: thread.name }, 'Failed handling ThreadCreate');
    }
  });

  client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
    try {
      await maybeHandle(newThread, {
        previousTagIds: oldThread.appliedTags ?? [],
        trigger: 'tag-added',
      });
    } catch (err) {
      log.error({ err, threadId: newThread.id, thread: newThread.name }, 'Failed handling ThreadUpdate');
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try { await handleMessageCreate(message); } catch (err) { log.error({ err, messageId: message.id }, 'Failed handling MessageCreate'); }
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    try { await handleMessageUpdate(oldMessage, newMessage); } catch (err) { log.error({ err, messageId: newMessage?.id }, 'Failed handling MessageUpdate'); }
  });

  client.on(Events.MessageDelete, async (message) => {
    try { await handleMessageDelete(message); } catch (err) { log.error({ err, messageId: message?.id }, 'Failed handling MessageDelete'); }
  });

  client.on(Events.MessageBulkDelete, async (messages) => {
    for (const message of messages.values()) {
      try { await handleMessageDelete(message); } catch (err) { log.error({ err, messageId: message?.id }, 'Failed handling bulk delete'); }
    }
  });

  client.on(Events.ClientReady, async (readyClient) => {
    log.info({ user: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, 'Discord client ready');
    await auditConfiguredChannels(readyClient);
    if (config.linear.pollCommentsSeconds > 0) {
      const ms = config.linear.pollCommentsSeconds * 1000;
      log.info({ seconds: config.linear.pollCommentsSeconds }, 'Polling Linear for new comments');
      pollTimer = setInterval(() => { pollLinearComments(); }, ms);
      if (pollTimer.unref) pollTimer.unref();
    }
  });

  client.on(Events.Error, (err) => log.error({ err }, 'Discord client error'));
  client.on(Events.Warn, (message) => log.warn({ message }, 'Discord client warning'));

  /**
   * Startup audit: surface config problems (unknown guilds/channels,
   * non-forum channels, missing trigger tags) immediately instead of
   * silently at the first event.
   */
  async function auditConfiguredChannels(readyClient) {
    for (const [guildId, forums] of routes) {
      const guild = readyClient.guilds.cache.get(guildId);
      if (!guild) {
        log.warn({ guildId }, 'Configured guild not found; is the bot invited to this server?');
        continue;
      }
      for (const [channelId, forumCfg] of forums) {
        try {
          const channel = await readyClient.channels.fetch(channelId);
          if (!channel) {
            log.warn({ guildId, channelId }, 'Configured channel not found; skipping');
          } else if (channel.type !== ChannelType.GuildForum) {
            // Warn once and seed the guard so the event path won't re-warn.
            warnOnce(
              `type:${channelId}`,
              { guildId, channelId, channel: channel.name, type: ChannelType[channel.type] },
              'Configured channel is not a forum channel (GuildForum); it will be ignored',
            );
          } else {
            resolveTriggerTagId(channel, forumCfg); // warns if the tag is missing
            log.info(
              { guild: guild.name, channel: channel.name, team: forumCfg.team, triggerTag: forumCfg.triggerTag },
              'Watching forum channel',
            );
          }
        } catch (err) {
          log.warn({ guildId, channelId, err: err.message }, 'Could not fetch configured channel (missing access?)');
        }
      }
    }
  }

  return {
    client,
    async start() {
      await client.login(config.discord.token);
    },
    async stop() {
      if (pollTimer) clearInterval(pollTimer);
      await client.destroy();
    },
  };
}
