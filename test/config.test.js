import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Silence app logging and provide the env vars the configs reference,
// before any app module is loaded.
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.LINEAR_API_KEY = 'lin_test_key_value';
process.env.DISCORD_TOKEN = 'discord_test_token_value';

const { loadConfig, ConfigError, DEFAULT_TRIGGER_TAG, DEFAULT_STORE_PATH, DEFAULT_MODERATOR_PERMISSION } =
  await import('../src/config.js');

const EXAMPLE_CONFIG = fileURLToPath(new URL('../config.example.yml', import.meta.url));

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-config-test-'));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let fileCounter = 0;
function writeYaml(content) {
  const p = path.join(tmpDir, `config-${fileCounter++}.yml`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/** A structurally valid config body, for tests that mutate one aspect. */
function validYaml(guildsBlock) {
  return `
linear:
  apiKey: \${LINEAR_API_KEY}
discord:
  token: \${DISCORD_TOKEN}
guilds:
${guildsBlock}
`;
}

function assertConfigError(configPath, pattern) {
  assert.throws(
    () => loadConfig(configPath),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err.constructor.name}: ${err.message}`);
      assert.match(err.message, pattern);
      return true;
    },
  );
}

describe('loadConfig', () => {
  test('the shipped config.example.yml loads and normalizes', () => {
    const config = loadConfig(EXAMPLE_CONFIG);

    // Env interpolation happened.
    assert.equal(config.linear.apiKey, 'lin_test_key_value');
    assert.equal(config.discord.token, 'discord_test_token_value');

    // Two guilds, with the expected forums.
    assert.equal(config.guilds.length, 2);
    assert.equal(config.guilds[0].id, '111111111111111111');
    assert.equal(config.guilds[0].forums.length, 2);
    assert.equal(config.guilds[1].forums.length, 1);

    // Default trigger tag applies where not overridden; overrides stick.
    assert.equal(config.defaults.triggerTag, 'TODO');
    assert.equal(config.guilds[0].forums[0].triggerTag, 'TODO'); // explicit
    assert.equal(config.guilds[0].forums[1].triggerTag, 'TODO'); // inherited default
    assert.equal(config.guilds[1].forums[0].triggerTag, 'Escalate'); // per-forum override

    // labelMap / defaultLabels normalized shapes.
    assert.deepEqual(config.guilds[0].forums[0].labelMap, {
      Bug: 'Bug',
      Feature: 'Feature Request',
      Question: 'Support',
    });
    assert.deepEqual(config.guilds[0].forums[0].defaultLabels, ['discord']);
    assert.deepEqual(config.guilds[0].forums[1].labelMap, {});
    assert.deepEqual(config.guilds[0].forums[1].defaultLabels, ['community']);
    assert.equal(config.store.path, './data/processed.json');

    // moderatorPermission: global default inherited where not overridden; per-forum overrides.
    assert.equal(config.defaults.moderatorPermission, 'ManageThreads');
    assert.equal(config.guilds[0].forums[0].moderatorPermission, 'ManageThreads'); // inherited
    assert.equal(config.guilds[0].forums[1].moderatorPermission, 'ManageThreads'); // inherited
    assert.equal(config.guilds[1].forums[0].moderatorPermission, 'ManageChannels'); // per-forum override
  });

  test('unquoted numeric guild id is rejected with a "quoted" hint', () => {
    const p = writeYaml(validYaml(`
  - id: 111111111111111111
    forums:
      - channelId: "222222222222222222"
        team: ENG
`));
    assertConfigError(p, /quoted/i);
  });

  test('duplicate guild id is rejected ("more than once")', () => {
    const p = writeYaml(validYaml(`
  - id: "111111111111111111"
    forums:
      - channelId: "222222222222222222"
        team: ENG
  - id: "111111111111111111"
    forums:
      - channelId: "333333333333333333"
        team: OPS
`));
    assertConfigError(p, /more than once/);
  });

  test('duplicate channel id is rejected', () => {
    const p = writeYaml(validYaml(`
  - id: "111111111111111111"
    forums:
      - channelId: "222222222222222222"
        team: ENG
      - channelId: "222222222222222222"
        team: OPS
`));
    assertConfigError(p, /channel 222222222222222222 is configured more than once/);
  });

  test('case-colliding labelMap keys are rejected', () => {
    const p = writeYaml(validYaml(`
  - id: "111111111111111111"
    forums:
      - channelId: "222222222222222222"
        team: ENG
        labelMap:
          Bug: One
          bug: Two
`));
    assertConfigError(p, /more than once \(matching is case-insensitive\)/);
  });

  test('missing environment variable is reported by name', () => {
    delete process.env.LDB_TEST_DEFINITELY_UNSET;
    const p = writeYaml(`
linear:
  apiKey: \${LDB_TEST_DEFINITELY_UNSET}
discord:
  token: \${DISCORD_TOKEN}
guilds:
  - id: "111111111111111111"
    forums:
      - channelId: "222222222222222222"
        team: ENG
`);
    assertConfigError(p, /LDB_TEST_DEFINITELY_UNSET/);
  });

  test('missing config file is a ConfigError, not a raw fs error', () => {
    assertConfigError(path.join(tmpDir, 'does-not-exist.yml'), /Cannot read config file/);
  });

  test('a valid minimal config passes and is normalized', () => {
    const p = writeYaml(`
linear:
  apiKey: \${LINEAR_API_KEY}
discord:
  token: \${DISCORD_TOKEN}
guilds:
  - id: "12345678901234567"
    forums:
      - channelId: "76543210987654321"
        team: "  ENG  "
        labelMap:
          "  Bug  ": "  Linear Bug  "
        defaultLabels:
          - "  discord  "
`);
    const config = loadConfig(p);
    assert.equal(config.defaults.triggerTag, DEFAULT_TRIGGER_TAG);
    assert.equal(config.store.path, DEFAULT_STORE_PATH);
    const forum = config.guilds[0].forums[0];
    assert.equal(forum.team, 'ENG'); // trimmed
    assert.equal(forum.triggerTag, DEFAULT_TRIGGER_TAG); // inherited default
    assert.deepEqual(forum.labelMap, { Bug: 'Linear Bug' }); // keys and values trimmed
    assert.deepEqual(forum.defaultLabels, ['discord']); // trimmed
    assert.equal(forum.moderatorPermission, DEFAULT_MODERATOR_PERMISSION); // inherited default
  });

  test('a forum without labelMap/defaultLabels normalizes to empty containers', () => {
    const p = writeYaml(validYaml(`
  - id: "12345678901234567"
    forums:
      - channelId: "76543210987654321"
        team: ENG
`));
    const config = loadConfig(p);
    const forum = config.guilds[0].forums[0];
    assert.deepEqual(forum.labelMap, {});
    assert.deepEqual(forum.defaultLabels, []);
    assert.equal(forum.moderatorPermission, DEFAULT_MODERATOR_PERMISSION);
  });

  test('moderatorPermission: per-forum overrides the inherited global default', () => {
    const p = writeYaml(`
linear:
  apiKey: \${LINEAR_API_KEY}
discord:
  token: \${DISCORD_TOKEN}
defaults:
  moderatorPermission: ManageGuild
guilds:
  - id: "12345678901234567"
    forums:
      - channelId: "76543210987654321"
        team: ENG
      - channelId: "76543210987654322"
        team: OPS
        moderatorPermission: ManageChannels
`);
    const config = loadConfig(p);
    assert.equal(config.defaults.moderatorPermission, 'ManageGuild');
    assert.equal(config.guilds[0].forums[0].moderatorPermission, 'ManageGuild'); // inherited default
    assert.equal(config.guilds[0].forums[1].moderatorPermission, 'ManageChannels'); // per-forum override
  });

  test('an unknown per-forum moderatorPermission is rejected with the allowed list', () => {
    const p = writeYaml(validYaml(`
  - id: "12345678901234567"
    forums:
      - channelId: "76543210987654321"
        team: ENG
        moderatorPermission: BanHammer
`));
    assertConfigError(p, /moderatorPermission must be one of: .*ManageThreads/);
  });

  test('an unknown defaults.moderatorPermission is rejected', () => {
    const p = writeYaml(`
linear:
  apiKey: \${LINEAR_API_KEY}
discord:
  token: \${DISCORD_TOKEN}
defaults:
  moderatorPermission: Nope
guilds:
  - id: "12345678901234567"
    forums:
      - channelId: "76543210987654321"
        team: ENG
`);
    assertConfigError(p, /defaults\.moderatorPermission must be one of/);
  });
});
