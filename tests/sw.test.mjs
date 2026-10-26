// The service worker only deletes caches that carry its own prefix. Games published under the same
// github.io origin share cache storage, so a worker that wiped "every other cache" would delete the
// other game's offline copy.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test, assert } from './harness.mjs';

test('sw activate drops this game\'s old caches and leaves other games\' caches alone', async () => {
  const listeners = {};
  const deleted = [];
  const caches = {
    keys: async () => ['overforged-v2', 'overforged-v3', 'overclocked-v1', 'someone-elses-v1'],
    delete: async (k) => { deleted.push(k); return true; },
  };
  const self = {
    location: { origin: 'http://x' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), { self, caches, fetch: async () => ({}), URL, Response });
  let waited;
  listeners.activate({ waitUntil: (p) => { waited = p; } });
  await waited;
  assert.deepEqual(deleted, ['overforged-v2']);
});
