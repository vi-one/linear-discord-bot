/**
 * Configuration loading, ${ENV_VAR} interpolation, and validation.
 *
 * The config is a YAML file (default: ./config.yml, overridable via the
 * CONFIG_PATH env var or a CLI argument). String values may reference
 * environment variables with `${VAR_NAME}` so secrets never have to live
 * in the file itself.
 *
 * Validation is strict and errors are collected so the user sees all
 * problems at once instead of fixing them one restart at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/; // Discord IDs are 17-20 digit snowflakes

export const DEFAULT_TRIGGER_TAG = 'TODO';
export const DEFAULT_STORE_PATH = './data/processed.json';

/**
 * Recursively walk a parsed YAML value and replace `${VAR}` references in
 * strings with the corresponding environment variable. Missing variables are
 * collected into `missing` so we can report them all together.
 */
function interpolateEnv(value, missing) {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_PATTERN, (match, name) => {
      const resolved = process.env[name];
      if (resolved === undefined) {
        missing.add(name);
        return match; // leave as-is; we abort before it is ever used
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnv(item, missing));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, interpolateEnv(val, missing)]),
    );
  }
  return value;
}

/** Error carrying every config problem found, for a single clear report. */
export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the raw parsed config and normalize it into the shape the rest of
 * the app consumes. Returns the normalized config or throws ConfigError.
 */
function validateAndNormalize(raw, configPath) {
  const problems = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError([`${configPath} must contain a YAML mapping at the top level`]);
  }

  if (!isNonEmptyString(raw.linear?.apiKey)) {
    problems.push('linear.apiKey is required (set LINEAR_API_KEY and reference it as ${LINEAR_API_KEY})');
  }
  if (!isNonEmptyString(raw.discord?.token)) {
    problems.push('discord.token is required (set DISCORD_TOKEN and reference it as ${DISCORD_TOKEN})');
  }

  const defaultTriggerTag = raw.defaults?.triggerTag ?? DEFAULT_TRIGGER_TAG;
  if (!isNonEmptyString(defaultTriggerTag)) {
    problems.push('defaults.triggerTag must be a non-empty string when set');
  }
  // A guaranteed-safe string for normalization below, even when the default is
  // invalid (the problem above still makes us throw before returning).
  const safeDefaultTag = isNonEmptyString(defaultTriggerTag) ? defaultTriggerTag.trim() : DEFAULT_TRIGGER_TAG;

  const storePath = raw.store?.path ?? DEFAULT_STORE_PATH;
  if (!isNonEmptyString(storePath)) {
    problems.push('store.path must be a non-empty string when set');
  }

  const guilds = [];
  if (!Array.isArray(raw.guilds) || raw.guilds.length === 0) {
    problems.push('guilds must be a non-empty list; the bot has nothing to do without at least one guild');
  } else {
    raw.guilds.forEach((guild, gi) => {
      const where = `guilds[${gi}]${guild?.name ? ` ("${guild.name}")` : ''}`;

      // IDs must be QUOTED strings in YAML. An unquoted 17-20 digit number is
      // silently corrupted by IEEE-754 precision, yet its String() form can
      // still look like a valid snowflake, so require an actual string.
      const guildId = typeof guild?.id === 'string' ? guild.id : '';
      if (typeof guild?.id !== 'string' || !SNOWFLAKE_PATTERN.test(guildId)) {
        problems.push(`${where}.id must be a quoted Discord guild ID string (17-20 digits). Unquoted numbers are corrupted by YAML precision.`);
      }

      const forums = [];
      if (!Array.isArray(guild?.forums) || guild.forums.length === 0) {
        problems.push(`${where}.forums must be a non-empty list of forum channel configs`);
      } else {
        guild.forums.forEach((forum, fi) => {
          const fwhere = `${where}.forums[${fi}]`;

          const channelId = typeof forum?.channelId === 'string' ? forum.channelId : '';
          if (typeof forum?.channelId !== 'string' || !SNOWFLAKE_PATTERN.test(channelId)) {
            problems.push(`${fwhere}.channelId must be a quoted Discord channel ID string (17-20 digits). Unquoted numbers are corrupted by YAML precision.`);
          }
          if (!isNonEmptyString(forum?.team)) {
            problems.push(`${fwhere}.team is required (a Linear team key like "ENG" or a team UUID)`);
          }
          if (forum?.triggerTag !== undefined && !isNonEmptyString(forum.triggerTag)) {
            problems.push(`${fwhere}.triggerTag must be a non-empty string when set`);
          }

          const labelMap = {};
          if (forum?.labelMap !== undefined) {
            if (forum.labelMap === null || typeof forum.labelMap !== 'object' || Array.isArray(forum.labelMap)) {
              problems.push(`${fwhere}.labelMap must be a mapping of Discord tag name -> Linear label name`);
            } else {
              const seenTagKeys = new Set();
              for (const [rawTag, labelName] of Object.entries(forum.labelMap)) {
                const tagName = rawTag.trim();
                if (tagName === '') {
                  problems.push(`${fwhere}.labelMap has an empty tag-name key`);
                  continue;
                }
                // Tag matching is case-insensitive downstream, so two keys that
                // differ only by case would silently collide; reject that.
                const lowerKey = tagName.toLowerCase();
                if (seenTagKeys.has(lowerKey)) {
                  problems.push(`${fwhere}.labelMap has tag "${tagName}" more than once (matching is case-insensitive)`);
                  continue;
                }
                seenTagKeys.add(lowerKey);
                if (!isNonEmptyString(labelName)) {
                  problems.push(`${fwhere}.labelMap["${rawTag}"] must map to a non-empty Linear label name`);
                } else {
                  labelMap[tagName] = labelName.trim();
                }
              }
            }
          }

          const defaultLabels = [];
          if (forum?.defaultLabels !== undefined) {
            if (!Array.isArray(forum.defaultLabels)) {
              problems.push(`${fwhere}.defaultLabels must be a list of Linear label names`);
            } else {
              forum.defaultLabels.forEach((label, li) => {
                if (!isNonEmptyString(label)) {
                  problems.push(`${fwhere}.defaultLabels[${li}] must be a non-empty string`);
                } else {
                  defaultLabels.push(label.trim());
                }
              });
            }
          }

          forums.push({
            channelId,
            team: typeof forum?.team === 'string' ? forum.team.trim() : forum?.team,
            triggerTag: isNonEmptyString(forum?.triggerTag) ? forum.triggerTag.trim() : safeDefaultTag,
            labelMap,
            defaultLabels,
          });
        });
      }

      guilds.push({
        id: guildId,
        name: typeof guild?.name === 'string' ? guild.name : undefined,
        forums,
      });
    });

    // Duplicate guild IDs would let one entry's forum map clobber another's at
    // routing time; duplicate channel IDs make behavior ambiguous. Reject both.
    const seenGuilds = new Set();
    for (const guild of guilds) {
      if (guild.id && seenGuilds.has(guild.id)) {
        problems.push(`guild ${guild.id} is configured more than once; merge its forums into a single entry`);
      }
      seenGuilds.add(guild.id);
    }
    const seenChannels = new Set();
    for (const guild of guilds) {
      for (const forum of guild.forums) {
        if (forum.channelId && seenChannels.has(forum.channelId)) {
          problems.push(`forum channel ${forum.channelId} is configured more than once`);
        }
        seenChannels.add(forum.channelId);
      }
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    linear: { apiKey: raw.linear.apiKey.trim() },
    discord: { token: raw.discord.token.trim() },
    store: { path: storePath },
    defaults: { triggerTag: safeDefaultTag },
    guilds,
  };
}

/**
 * Load, interpolate, validate, and normalize the YAML config file.
 *
 * @param {string} [configPath] Path to config.yml (defaults to CONFIG_PATH env or ./config.yml)
 * @returns normalized config object
 * @throws {ConfigError} when the file is missing, unparseable, references
 *         undefined env vars, or fails validation.
 */
export function loadConfig(configPath = process.env.CONFIG_PATH ?? './config.yml') {
  const resolved = path.resolve(configPath);

  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ConfigError([
      `Cannot read config file at ${resolved}: ${err.message}`,
      'Copy config.example.yml to config.yml and fill it in, or set CONFIG_PATH.',
    ]);
  }

  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    throw new ConfigError([`Config file ${resolved} is not valid YAML: ${err.message}`]);
  }

  const missing = new Set();
  const interpolated = interpolateEnv(parsed, missing);
  if (missing.size > 0) {
    throw new ConfigError(
      [...missing].map(
        (name) => `Environment variable ${name} is referenced in ${resolved} but is not set (check your .env file)`,
      ),
    );
  }

  return validateAndNormalize(interpolated, resolved);
}
