import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Silence app logging before the app module is loaded.
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';

const { ProcessedStore } = await import('../src/store.js');

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-store-test-'));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let dirCounter = 0;
function freshStorePath() {
  const dir = path.join(tmpDir, `case-${dirCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'processed.json');
}

describe('ProcessedStore', () => {
  test('set/has/get round-trip', async () => {
    const store = await new ProcessedStore(freshStorePath()).load();
    assert.equal(store.has('t1'), false);
    assert.equal(store.get('t1'), undefined);

    const record = { issueId: 'i1', identifier: 'ENG-1', url: 'https://linear.app/x/ENG-1' };
    await store.set('t1', record);
    assert.equal(store.has('t1'), true);
    assert.deepEqual(store.get('t1'), record);
  });

  test('entries persist across a reload', async () => {
    const filePath = freshStorePath();
    const store = await new ProcessedStore(filePath).load();
    await store.set('t1', { identifier: 'ENG-1' });
    await store.set('t2', { identifier: 'ENG-2' });

    const reloaded = await new ProcessedStore(filePath).load();
    assert.equal(reloaded.has('t1'), true);
    assert.equal(reloaded.has('t2'), true);
    assert.deepEqual(reloaded.get('t2'), { identifier: 'ENG-2' });
  });

  test('20 concurrent set() calls all persist, none lost', async () => {
    const filePath = freshStorePath();
    const store = await new ProcessedStore(filePath).load();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`thread-${i}`, { identifier: `ENG-${i}` })),
    );

    const reloaded = await new ProcessedStore(filePath).load();
    for (let i = 0; i < 20; i++) {
      assert.equal(reloaded.has(`thread-${i}`), true, `thread-${i} missing after reload`);
      assert.deepEqual(reloaded.get(`thread-${i}`), { identifier: `ENG-${i}` });
    }
  });

  test('no leftover .tmp files after writes', async () => {
    const filePath = freshStorePath();
    const store = await new ProcessedStore(filePath).load();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.set(`t${i}`, { i })),
    );
    await store.flush();

    const leftovers = fs.readdirSync(path.dirname(filePath)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('corrupt JSON makes load() throw instead of wiping history', async () => {
    const filePath = freshStorePath();
    fs.writeFileSync(filePath, '{ this is not valid json', 'utf8');
    await assert.rejects(new ProcessedStore(filePath).load(), /invalid JSON/);
    // The corrupt file must still be there, untouched.
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{ this is not valid json');
  });

  test('array or other wrong-shape content makes load() throw', async () => {
    const arrayPath = freshStorePath();
    fs.writeFileSync(arrayPath, '["a", "b"]', 'utf8');
    await assert.rejects(new ProcessedStore(arrayPath).load(), /unexpected shape/);

    const numberPath = freshStorePath();
    fs.writeFileSync(numberPath, '42', 'utf8');
    await assert.rejects(new ProcessedStore(numberPath).load(), /unexpected shape/);
  });

  test('store file is written with mode 0600', async () => {
    const filePath = freshStorePath();
    const store = await new ProcessedStore(filePath).load();
    await store.set('t1', { identifier: 'ENG-1' });

    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test('missing file means a fresh empty store (no throw)', async () => {
    const store = await new ProcessedStore(freshStorePath()).load();
    assert.equal(store.has('anything'), false);
  });
});
