# linear-discord-bot

A Discord bot that turns forum threads into [Linear](https://linear.app) issues.

When someone adds a configured **trigger tag** (default: `TODO`) to a thread in a
Discord **forum channel**, the bot creates a Linear issue in the team mapped to
that forum:

- the **thread title** becomes the issue **title**,
- the thread's **starter message** becomes the issue **description** (with a
  link back to the Discord thread and any attachments),
- the thread's **forum tags** are mapped to **Linear labels** via config
  (plus optional always-applied default labels),
- and after creation, **new messages in the thread are mirrored as Linear
  comments** (edits update the comment, deletes remove it) when
  `syncMessages` is on (the default).

It supports **multiple Discord servers**, **any number of forum channels per
server**, and a **different Linear team per forum** (`forums[].team`).

## How the trigger works

The bot listens to two gateway events:

- **Thread updated**: it diffs the thread's applied tags before vs. after the
  update. Only the transition *trigger tag absent -> present* creates an issue.
  Adding other tags, renaming the thread, or re-saving tags does nothing.
- **Thread created**: covers posts created with the trigger tag already
  selected in the "new post" dialog.

The trigger tag is matched **by name, case-insensitively**, against the forum's
own tag list, so config stays human-readable (`TODO`, not a tag ID).

**No duplicates:** every processed thread is recorded in a small JSON store
(`data/processed.json` by default) mapping thread ID -> created issue. The store
is checked before creating and written immediately after, and it persists
across restarts. Removing and re-adding the trigger tag will *not* create a
second issue.

## Message sync

Message sync is one-directional (Discord -> Linear), gated by `syncMessages`
(on by default, can be turned off globally with `defaults.syncMessages: false`
or per forum with `forums[].syncMessages`).

Once a thread has a Linear issue, the bot copies each new human message in the
thread to the issue as a comment. Editing the Discord message updates the
comment; deleting it removes the comment. The bot's starter message is not
duplicated (it is already the issue description). Bot and system messages are
ignored.

## Prerequisites

### 1. Discord application & bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and **New Application**.
2. Under **Bot**:
   - **Reset Token** and save it; this is your `DISCORD_TOKEN`.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent**:
     required to read the thread starter message for the issue description
     (without it Discord hands the bot empty content). Message sync needs no
     additional portal setting: the Guild Messages intent it uses is
     non-privileged and is requested in code.
3. Under **OAuth2 > URL Generator**:
   - Scopes: `bot`
   - Bot permissions: **View Channels**, **Send Messages**,
     **Send Messages in Threads**, **Read Message History**
   - Open the generated URL and invite the bot to every server you want it in.

The equivalent invite URL (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=274877975552
```

### 2. Finding Discord IDs

Enable **Developer Mode** in Discord (User Settings > Advanced > Developer
Mode). Then:

- **Guild (server) ID**: right-click the server icon > *Copy Server ID*
- **Forum channel ID**: right-click the forum channel > *Copy Channel ID*

Only **Forum**-type channels work. If you configure a text/announcement/etc.
channel, the bot logs a warning at startup and ignores it.

### 3. Linear API key & team

- API key: [linear.app/settings/api](https://linear.app/settings/api) >
  *Personal API keys* > create one. This is your `LINEAR_API_KEY`.
- Team: use either the short **team key** shown in issue identifiers
  (e.g. `ENG` in `ENG-123`, also visible under Settings > Teams) or the team
  **UUID**. The config accepts both: anything that looks like a UUID is
  treated as an ID, everything else as a key.
- Labels referenced in `labelMap` / `defaultLabels` must already exist in
  Linear (team-scoped or workspace-scoped). Unknown labels are skipped with a
  warning; they never break issue creation.

## Configuration

```bash
cp config.example.yml config.yml
cp .env.example .env
# edit both
```

Secrets stay out of `config.yml` via `${ENV_VAR}` interpolation: any string
value in the YAML may reference an environment variable, and `.env` is loaded
automatically at startup. Startup fails with a clear message listing every
missing variable or invalid field.

### All config fields

| Field | Required | Description |
|---|---|---|
| `linear.apiKey` | yes | Linear personal API key. Use `${LINEAR_API_KEY}`. |
| `discord.token` | yes | Discord bot token. Use `${DISCORD_TOKEN}`. |
| `store.path` | no | Path of the JSON dedupe store. Default `./data/processed.json`. Directory is auto-created. |
| `defaults.triggerTag` | no | Global trigger tag name. Default `TODO`. |
| `defaults.syncMessages` | no | Mirror thread messages as Linear comments (create/edit/delete). Default `true`. |
| `guilds[]` | yes | One entry per Discord server. |
| `guilds[].id` | yes | Guild ID (quote it; it's a string). |
| `guilds[].name` | no | Friendly name, used only in logs. |
| `guilds[].forums[]` | yes | One entry per forum channel in that guild. |
| `forums[].channelId` | yes | Forum channel ID (quoted string). |
| `forums[].team` | yes | Linear team **key** (`ENG`) or team **UUID**. Issues from this forum land in this team. |
| `forums[].triggerTag` | no | Per-forum override of `defaults.triggerTag`. |
| `forums[].syncMessages` | no | Per-forum override of `defaults.syncMessages`. |
| `forums[].labelMap` | no | Mapping of Discord forum **tag name** -> Linear **label name**. Tags on the thread that appear here become labels on the issue. Matching is case-insensitive on both sides. |
| `forums[].defaultLabels` | no | Linear label names applied to **every** issue created from this forum. |

**What the bot posts to Discord.** Nothing. The bot does not post in the forum
thread, send issue-creation confirmations, or send DMs; issue creation is
logged at info level. Its only write path is Linear: thread messages become
issue comments when `syncMessages` is on.

Environment variables (see `.env.example`): `DISCORD_TOKEN`, `LINEAR_API_KEY`,
and optionally `CONFIG_PATH` (config file location, default `./config.yml`),
`LOG_LEVEL` (default `info`), `LOG_PRETTY`.

## Run locally

Requires **Node.js 22+** (the Docker image and CI use the current LTS, Node 24).

```bash
npm install
npm start           # or: npm run dev  (auto-restarts on file changes)
```

You can also point at a different config file: `node src/index.js /path/to/config.yml`.

On startup the bot logs each forum it is watching and warns about anything
misconfigured (unknown channels, non-forum channels, missing trigger tags).

## Run with Docker

Build:

```bash
docker build -t linear-discord-bot .
```

Run - mount your `config.yml`, pass secrets via env, and persist `data/` so
the dedupe store survives restarts:

```bash
docker run -d --name linear-discord-bot \
  --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/config.yml:/app/config.yml:ro" \
  -v linear-discord-data:/app/data \
  linear-discord-bot
```

Notes:

- `--env-file .env` supplies `DISCORD_TOKEN` / `LINEAR_API_KEY` for the
  `${...}` references in the config (or use `-e VAR=...`).
- The named volume `linear-discord-data` holds `/app/data/processed.json`.
  **Do not skip it**: without persistence, a restarted container would
  re-create issues for threads that get their tags edited again.
- The container runs as the unprivileged `node` user.
- Logs: `docker logs -f linear-discord-bot`.

## Operational notes

- One failing thread never takes the bot down: every event handler is wrapped,
  errors are logged with thread/issue context, and processing continues.
- The bot never writes to Discord; it never posts issue-creation notices, so a
  created issue itself leaks nothing to the public thread.
- `SIGINT`/`SIGTERM` trigger a graceful shutdown: the Discord client
  disconnects and pending store writes are flushed.
- The bot caches Linear team and label lookups in memory. If you add new
  labels or teams in Linear, restart the bot to pick them up.
- Issue descriptions escape and quote user-submitted content (thread titles,
  starter message, attachment names) so a crafted post can't forge the trusted
  provenance link; only attachment links served from Discord's own CDN are
  rendered, and the bot never pings anyone (`allowedMentions` disabled).

## Known limitations

- **Triggers added while the bot is offline are not backfilled.** If the trigger
  tag is applied while the bot is down, the transition isn't replayed on
  reconnect, so no issue is created. Re-add the tag (remove then add) after the
  bot is back to trigger it.
- **Issue creation is gated solely by the trigger tag.** An issue is
  created only when the trigger tag transitions from absent to present on a
  thread; the dedupe store guarantees *at most one issue per thread*. There is
  intentionally no separate rate limit. If your forums are open to untrusted
  members, control who can apply the trigger tag via Discord's tag/channel
  permissions (e.g. make it a moderated tag).
- A **`package-lock.json` is included** for reproducible, integrity-checked
  installs (the Docker build uses `npm ci --ignore-scripts`). Re-run
  `npm install` and commit the updated lockfile when you change dependencies.
