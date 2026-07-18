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
  formatIssueDescription,
  labelNamesFor,
  shouldTrigger,
  tagNamesFromIds,
  truncate,
} from './pipeline.js';

const log = childLogger('discord');

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
  /** Keys we already warned about, to avoid log spam on every event. */
  const warned = new Set();

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
        'Configured channel is not a forum channel (GuildForum); ignoring it — fix config.yml',
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

      // Persist BEFORE announcing: if the reply fails we still never duplicate.
      // A failed persist keeps the entry in memory (dedupe holds until restart)
      // but is logged loudly so an operator can reconcile — a restart could
      // otherwise re-create this issue.
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
          'Created Linear issue but FAILED to persist the dedupe record; a restart may create a duplicate — reconcile manually',
        );
      }

      log.info(
        { threadId: thread.id, thread: thread.name, issue: issue.identifier, team: issue.teamKey, trigger },
        'Created Linear issue from forum thread',
      );

      try {
        await thread.send(`Created Linear issue **${issue.identifier}** for this thread: ${issue.url}`);
      } catch (err) {
        log.warn({ threadId: thread.id, issue: issue.identifier, err: err.message },
          'Issue created but could not post confirmation in the thread (missing permissions?)');
      }
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

  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    // Discord also emits ThreadCreate when the bot gains access to an
    // existing thread — only genuinely new threads matter here.
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

  client.on(Events.ClientReady, async (readyClient) => {
    log.info({ user: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, 'Discord client ready');
    await auditConfiguredChannels(readyClient);
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
        log.warn({ guildId }, 'Configured guild not found — is the bot invited to this server?');
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
      await client.destroy();
    },
  };
}
