import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { initStore } from '../public/storage.js';

// Local preview uses browser APIs only. These fakes leave production code intact.
let values;
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    locks: { request: async (_name, callback) => callback() },
  } });
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
  };
});

const blank = () => ({
  name: 'Saturday', date: '2026-10-16', people: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  payments: [], settlements: [], closed: false,
});
function withPayment() {
  const data = blank();
  data.payments.push({
    id: 'food', payer: 'a', amount: 100_000, tag: 'Snacks at XYZ',
    items: [{ id: 'fries', name: 'Fries', amount: 100_000, shares: { a: 30_000, b: 70_000 } }],
  });
  return data;
}
function paid() {
  const data = withPayment();
  data.settlements.push({
    id: 'paid-food', keys: ['food:b'], from: 'b', to: 'a', amount: 70_000, at: '2026-10-16T12:00:00.000Z',
  });
  return data;
}

test('create stores a valid outing and returns independent 256-bit event and owner keys', async () => {
  const store = await initStore();
  assert.equal(store.mode, 'local');
  const data = blank();
  const created = await store.create(data);
  assert.match(created.id, /^[a-f0-9]{64}$/);
  assert.match(created.token, /^[a-f0-9]{64}$/);
  assert.notEqual(created.id, created.token);
  assert.equal(created.revision, 1);
  data.name = 'Changed original';
  created.data.name = 'Changed returned copy';
  assert.equal((await store.get(created.id)).data.name, 'Saturday');
});

test('viewer records never return the owner token and invalid tokens cannot edit', async () => {
  const store = await initStore();
  const created = await store.create(blank());
  const view = await store.get(created.id);
  assert.deepEqual(Object.keys(view).sort(), ['data', 'id', 'revision']);
  assert.equal(JSON.stringify(view).includes(created.token), false);
  assert.equal(await store.canEdit(created.id, created.token), true);
  for (const token of [undefined, '', 'wrong', '0'.repeat(64)]) {
    assert.equal(await store.canEdit(created.id, token), false);
    await assert.rejects(store.save(created.id, token, 1, blank()), { code: 'permission-denied' });
  }
  assert.equal((await store.get(created.id)).revision, 1);
});

test('save increments the revision and stale edits cannot overwrite a newer save', async () => {
  const store = await initStore();
  const created = await store.create(blank());
  const saved = await store.save(created.id, created.token, 1, { ...blank(), name: 'Sunday' });
  assert.equal(saved.revision, 2);
  assert.equal('token' in saved, false);
  await assert.rejects(store.save(created.id, created.token, 1, blank()), { code: 'conflict' });
  const latest = await store.get(created.id);
  assert.equal(latest.revision, 2);
  assert.equal(latest.data.name, 'Sunday');
});

test('invalid financial totals and reserved extra event fields are rejected before persistence', async () => {
  const store = await initStore();
  const bad = withPayment();
  bad.payments[0].items[0].shares.b = 69_999;
  await assert.rejects(store.create(bad), error => error.code === 'invalid-data' && /shares must add up/.test(error.message));
  await assert.rejects(store.create({ ...blank(), ownerToken: 'do-not-share' }), { code: 'invalid-data' });
  await assert.rejects(store.create({ ...blank(), date: '2026-02-30' }), { code: 'invalid-data' });
  assert.equal(values.size, 0);
  const created = await store.create(blank());
  await assert.rejects(store.save(created.id, created.token, 1, bad), { code: 'invalid-data' });
  assert.equal((await store.get(created.id)).data.payments.length, 0);
});

test('adapter limits match the ledger: 100-character outing names and 2–30 people', async () => {
  const store = await initStore();
  await store.create({ ...blank(), name: 'x'.repeat(100) });
  await assert.rejects(store.create({ ...blank(), name: 'x'.repeat(101) }), { code: 'invalid-data' });
  await assert.rejects(store.create({ ...blank(), people: blank().people.slice(0, 1) }), { code: 'invalid-data' });
  const people = Array.from({ length: 30 }, (_, i) => ({ id: `friend-${i}`, name: `Friend ${i}` }));
  await store.create({ ...blank(), people });
  await assert.rejects(store.create({ ...blank(), people: [...people, { id: 'extra', name: 'Extra' }] }), { code: 'invalid-data' });
});

test('direct adapter callers must reopen a settlement in a separate save before editing its payment', async () => {
  const store = await initStore();
  const created = await store.create(paid());
  const edited = paid();
  edited.payments[0].tag = 'Corrected tag';
  await assert.rejects(store.save(created.id, created.token, 1, edited), error => error.code === 'locked-data' && /Reopen the related settlements/.test(error.message));
  edited.settlements = [];
  await assert.rejects(store.save(created.id, created.token, 1, edited), { code: 'locked-data' });
  const reopened = paid();
  reopened.settlements = [];
  const first = await store.save(created.id, created.token, 1, reopened);
  const second = await store.save(created.id, created.token, first.revision, edited);
  assert.equal(second.revision, 3);
  assert.equal(second.data.payments[0].tag, 'Corrected tag');
});

test('deleting settled payments cannot bypass the lock by deleting their settlement too', async () => {
  const store = await initStore();
  const created = await store.create(paid());
  await assert.rejects(store.save(created.id, created.token, 1, blank()), { code: 'locked-data' });
  assert.equal((await store.get(created.id)).data.payments.length, 1);
});

test('finished outings must reopen in a separate save before expenses change', async () => {
  const store = await initStore();
  const data = withPayment();
  data.closed = true;
  const created = await store.create(data);
  const edited = withPayment();
  edited.payments[0].tag = 'New tag';
  await assert.rejects(store.save(created.id, created.token, 1, edited), error => error.code === 'locked-data' && /Reopen the outing/.test(error.message));
  const reopened = await store.save(created.id, created.token, 1, withPayment());
  await store.save(created.id, created.token, reopened.revision, edited);
});

test('participants cannot be renamed after the first payment, even while deleting all expenses', async () => {
  const store = await initStore();
  const created = await store.create(withPayment());
  const changed = blank();
  changed.people[0].name = 'Renamed';
  await assert.rejects(store.save(created.id, created.token, 1, changed), error => error.code === 'locked-data' && /Friend names are fixed/.test(error.message));
});

test('subscription receives initial and saved data, handles external storage events, and unsubscribes', async () => {
  const store = await initStore();
  const created = await store.create(blank());
  const observed = [];
  const errors = [];
  const unsubscribe = store.subscribe(created.id, record => observed.push(record.revision), error => errors.push(error.code));
  await Promise.resolve();
  await store.save(created.id, created.token, 1, { ...blank(), name: 'Changed' });
  assert.deepEqual(observed, [1, 2]);
  const key = `hangout.local.event.v1.${created.id}`;
  const external = JSON.parse(values.get(key));
  external.revision = 3;
  values.set(key, JSON.stringify(external));
  window.dispatchEvent(Object.assign(new Event('storage'), { key }));
  assert.deepEqual(observed, [1, 2, 3]);
  unsubscribe();
  window.dispatchEvent(Object.assign(new Event('storage'), { key }));
  assert.deepEqual(observed, [1, 2, 3]);
  assert.deepEqual(errors, []);
});

test('missing, invalid, and damaged local records produce recoverable errors', async () => {
  const store = await initStore();
  await assert.rejects(store.get('../events'), { code: 'invalid-link' });
  await assert.rejects(store.get('f'.repeat(64)), { code: 'not-found' });
  const created = await store.create(blank());
  values.set(`hangout.local.event.v1.${created.id}`, 'not-json');
  await assert.rejects(store.get(created.id), { code: 'storage-corrupt' });
});

test('unavailable or full browser storage never reports a successful save', async () => {
  const store = await initStore();
  localStorage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(store.create(blank()), { code: 'storage-full' });
  localStorage.getItem = () => { throw new Error('blocked'); };
  await assert.rejects(store.get('a'.repeat(64)), { code: 'storage-unavailable' });
});

test('oversized but structurally valid outings are rejected before storage', async () => {
  const store = await initStore();
  const data = withPayment();
  data.payments[0].notes = 'x'.repeat(750_000);
  await assert.rejects(store.create(data), { code: 'outing-too-large' });
  assert.equal(values.size, 0);
});

test('incomplete Firebase configuration rejects initialization rather than switching to local mode', async () => {
  // Import a configuration fixture without modifying the user's real config file.
  const source = await readFile(new URL('../public/storage.js', import.meta.url), 'utf8');
  const fixture = source
    .replace("import { firebaseConfig } from './firebase-config.js';", "const firebaseConfig = {projectId: 'incomplete'};")
    .replace("'./ledger.js'", JSON.stringify(new URL('../public/ledger.js', import.meta.url).href));
  const module = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`);
  await assert.rejects(module.initStore(), { code: 'firebase-config' });
});
