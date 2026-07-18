import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Silence app logging before any app module is loaded (dynamic import below
// so the env assignment is guaranteed to run first, despite ESM hoisting).
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';

const {
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  truncate,
  escapeMarkdown,
  isDiscordCdnUrl,
  findTagId,
  tagNamesFromIds,
  shouldTrigger,
  labelNamesFor,
  formatIssueDescription,
} = await import('../src/pipeline.js');

describe('shouldTrigger — the core "issue only on tag appearing" rule', () => {
  const TAG = 'trigger-tag-id';

  test('fires on absent -> present transition', () => {
    assert.equal(shouldTrigger([TAG], [], TAG), true);
    assert.equal(shouldTrigger(['other', TAG], ['other'], TAG), true);
  });

  test('does NOT fire when the tag was already present (re-save / unrelated update)', () => {
    assert.equal(shouldTrigger([TAG], [TAG], TAG), false);
    assert.equal(shouldTrigger([TAG, 'other'], [TAG], TAG), false);
  });

  test('does NOT fire when the tag is absent in both states', () => {
    assert.equal(shouldTrigger([], [], TAG), false);
    assert.equal(shouldTrigger(['other'], ['other'], TAG), false);
  });

  test('does NOT fire on removal (present -> absent)', () => {
    assert.equal(shouldTrigger([], [TAG], TAG), false);
    assert.equal(shouldTrigger(['other'], [TAG, 'other'], TAG), false);
  });

  test('thread creation modeled as previous=[] fires when the tag is present', () => {
    assert.equal(shouldTrigger([TAG, 'other'], [], TAG), true);
  });

  test('null/undefined previous tags are treated as empty', () => {
    assert.equal(shouldTrigger([TAG], null, TAG), true);
    assert.equal(shouldTrigger([TAG], undefined, TAG), true);
    assert.equal(shouldTrigger([], null, TAG), false);
  });

  test('null/undefined current tags are treated as empty', () => {
    assert.equal(shouldTrigger(null, [], TAG), false);
    assert.equal(shouldTrigger(undefined, [TAG], TAG), false);
  });

  test('does NOT fire when the trigger tag is not among current tags', () => {
    assert.equal(shouldTrigger(['a', 'b'], [], TAG), false);
  });

  test('does NOT fire when other tags are added but not the trigger', () => {
    assert.equal(shouldTrigger(['a', 'b', 'c'], ['a'], TAG), false);
  });
});

describe('findTagId', () => {
  const tags = [
    { id: '1', name: 'TODO' },
    { id: '2', name: 'Bug' },
  ];

  test('exact match', () => {
    assert.equal(findTagId(tags, 'TODO'), '1');
  });

  test('case-insensitive match', () => {
    assert.equal(findTagId(tags, 'todo'), '1');
    assert.equal(findTagId(tags, 'bUg'), '2');
  });

  test('no match returns null', () => {
    assert.equal(findTagId(tags, 'Escalate'), null);
  });

  test('empty availableTags returns null', () => {
    assert.equal(findTagId([], 'TODO'), null);
  });
});

describe('tagNamesFromIds', () => {
  const tags = [
    { id: 'a', name: 'Bug' },
    { id: 'b', name: 'Feature' },
  ];

  test('maps ids to names, preserving applied order', () => {
    assert.deepEqual(tagNamesFromIds(tags, ['b', 'a']), ['Feature', 'Bug']);
  });

  test('drops unknown ids', () => {
    assert.deepEqual(tagNamesFromIds(tags, ['a', 'nope', 'b']), ['Bug', 'Feature']);
    assert.deepEqual(tagNamesFromIds(tags, ['nope']), []);
    assert.deepEqual(tagNamesFromIds([], ['a']), []);
  });
});

describe('labelNamesFor', () => {
  const cfg = {
    labelMap: { Bug: 'Bug', Feature: 'Feature Request' },
    defaultLabels: ['discord'],
  };

  test('maps tag names via labelMap case-insensitively', () => {
    assert.deepEqual(labelNamesFor(cfg, ['bug']), ['discord', 'Bug']);
    assert.deepEqual(labelNamesFor(cfg, ['FEATURE']), ['discord', 'Feature Request']);
  });

  test('unions defaultLabels with mapped labels', () => {
    assert.deepEqual(labelNamesFor(cfg, ['Bug', 'Feature']), ['discord', 'Bug', 'Feature Request']);
  });

  test('de-duplicates when a mapped label equals a default label', () => {
    const cfg2 = { labelMap: { Bug: 'discord' }, defaultLabels: ['discord'] };
    assert.deepEqual(labelNamesFor(cfg2, ['Bug']), ['discord']);
  });

  test('ignores tags with no mapping', () => {
    assert.deepEqual(labelNamesFor(cfg, ['Question', 'Bug']), ['discord', 'Bug']);
  });

  test('empty tag list yields just the default labels', () => {
    assert.deepEqual(labelNamesFor(cfg, []), ['discord']);
  });

  test('empty config yields empty list', () => {
    assert.deepEqual(labelNamesFor({ labelMap: {}, defaultLabels: [] }, ['Bug']), []);
  });
});

describe('formatIssueDescription', () => {
  const base = {
    threadName: 'My thread',
    threadUrl: 'https://discord.com/channels/1/2/3',
    authorTag: 'user#1234',
    content: 'hello\nworld',
    attachments: [],
  };

  test('provenance line is present and comes first', () => {
    const out = formatIssueDescription(base);
    const [first] = out.split('\n\n');
    assert.ok(out.startsWith('Created from Discord thread ['));
    assert.ok(first.includes(`](${base.threadUrl})`));
    assert.ok(first.includes('by **user\\#1234**'));
    // The separator follows immediately after the provenance line.
    assert.equal(out.split('\n\n')[1], '---');
  });

  test('a malicious thread name cannot break out of the provenance link', () => {
    const out = formatIssueDescription({ ...base, threadName: 'x](http://evil)' });
    // The unescaped breakout sequence must not survive…
    assert.ok(!out.includes('](http://evil)'));
    // …and the real thread URL is still the link target.
    assert.ok(out.includes(`](${base.threadUrl})`));
    assert.ok(out.includes('x\\]\\(http://evil\\)'));
  });

  test('content is blockquoted under the User-submitted content label', () => {
    const out = formatIssueDescription(base);
    assert.ok(out.includes('**User-submitted content:**\n> hello\n> world'));
  });

  test('empty/null content produces the no-text fallback', () => {
    for (const content of [null, '', '   \n  ']) {
      const out = formatIssueDescription({ ...base, content });
      assert.ok(out.includes('*No text content in the thread starter message.*'));
      assert.ok(!out.includes('User-submitted content'));
    }
  });

  test('null authorTag omits the author segment', () => {
    const out = formatIssueDescription({ ...base, authorTag: null });
    assert.ok(!out.includes(' by **'));
    assert.ok(out.includes(`](${base.threadUrl}).`));
  });

  test('non-CDN attachments are filtered out; CDN ones are kept', () => {
    const out = formatIssueDescription({
      ...base,
      attachments: [
        { name: 'good.png', url: 'https://cdn.discordapp.com/attachments/1/2/good.png' },
        { name: 'evil.png', url: 'https://evil.example.com/evil.png' },
        { name: 'alsogood.txt', url: 'https://media.discordapp.net/attachments/1/2/alsogood.txt' },
      ],
    });
    assert.ok(out.includes('**Attachments**'));
    assert.ok(out.includes('(https://cdn.discordapp.com/attachments/1/2/good.png)'));
    assert.ok(out.includes('(https://media.discordapp.net/attachments/1/2/alsogood.txt)'));
    assert.ok(!out.includes('evil.example.com'));
  });

  test('no Attachments block when every attachment is filtered out or the list is empty', () => {
    const none = formatIssueDescription({ ...base, attachments: [] });
    assert.ok(!none.includes('**Attachments**'));
    const filtered = formatIssueDescription({
      ...base,
      attachments: [{ name: 'x', url: 'https://evil.example.com/x' }],
    });
    assert.ok(!filtered.includes('**Attachments**'));
    const nullish = formatIssueDescription({ ...base, attachments: null });
    assert.ok(!nullish.includes('**Attachments**'));
  });

  test('attachment names are markdown-escaped', () => {
    const out = formatIssueDescription({
      ...base,
      attachments: [{ name: 'a](x).png', url: 'https://cdn.discordapp.com/attachments/1/2/a.png' }],
    });
    assert.ok(out.includes('- [a\\]\\(x\\)\\.png](https://cdn.discordapp.com/attachments/1/2/a.png)'));
  });
});

describe('truncate', () => {
  test('text under the limit is unchanged', () => {
    assert.equal(truncate('short', 250), 'short');
    assert.equal(truncate('', 10), '');
    assert.equal(truncate('x'.repeat(250), 250), 'x'.repeat(250)); // exactly at limit
  });

  test('text over the limit ends with … and fits within max', () => {
    const out = truncate('x'.repeat(300), MAX_TITLE_LENGTH);
    assert.equal(out.length, MAX_TITLE_LENGTH);
    assert.ok(out.endsWith('…'));
    assert.ok(out.length <= MAX_TITLE_LENGTH);
  });

  test('description limit constant is respected', () => {
    const out = truncate('y'.repeat(MAX_DESCRIPTION_LENGTH + 5), MAX_DESCRIPTION_LENGTH);
    assert.equal(out.length, MAX_DESCRIPTION_LENGTH);
    assert.ok(out.endsWith('…'));
  });
});

describe('escapeMarkdown', () => {
  test('brackets, parens, and backticks are backslash-escaped', () => {
    assert.equal(escapeMarkdown('[x](y)'), '\\[x\\]\\(y\\)');
    assert.equal(escapeMarkdown('`code`'), '\\`code\\`');
  });

  test('emphasis and structure characters are escaped too', () => {
    assert.equal(escapeMarkdown('*bold* _it_ #h > q'), '\\*bold\\* \\_it\\_ \\#h \\> q');
    assert.equal(escapeMarkdown('a\\b'), 'a\\\\b');
  });

  test('plain text passes through', () => {
    assert.equal(escapeMarkdown('hello world 123'), 'hello world 123');
  });
});

describe('isDiscordCdnUrl', () => {
  test('accepts Discord CDN hosts only', () => {
    assert.equal(isDiscordCdnUrl('https://cdn.discordapp.com/a/b.png'), true);
    assert.equal(isDiscordCdnUrl('https://media.discordapp.net/a/b.png'), true);
    assert.equal(isDiscordCdnUrl('https://evil.example.com/b.png'), false);
    assert.equal(isDiscordCdnUrl('https://cdn.discordapp.com.evil.com/b.png'), false);
  });

  test('unparseable URLs are rejected, not thrown', () => {
    assert.equal(isDiscordCdnUrl('not a url'), false);
    assert.equal(isDiscordCdnUrl(''), false);
  });
});
