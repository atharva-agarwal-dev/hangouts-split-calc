import test from 'node:test';
import assert from 'node:assert/strict';
import { split, debts, pairs, settledKeys, locked, validate, enforceLocks } from '../public/ledger.js';

const clone = value => structuredClone(value);
const at = '2026-10-16T12:00:00.000Z';
const blank = () => ({
  name: 'Saturday food crawl', date: '2026-10-16', closed: false,
  people: ['A', 'B', 'C', 'D'].map(name => ({ id: name.toLowerCase(), name })),
  payments: [], settlements: [],
});
function payment(id, payer, shares, tag = 'Snacks at XYZ') {
  const amount = Object.values(shares).reduce((sum, value) => sum + value, 0);
  return { id, payer, amount, tag, items: [{ id: `${id}-item`, name: 'Snacks', amount, shares }] };
}
function example() {
  const event = blank();
  event.payments.push(payment('snacks', 'a', { a: 50_000, b: 70_000, c: 0, d: 80_000 }));
  return event;
}
function opposing(first = 70_000, second = 30_000) {
  const event = blank();
  event.payments.push(payment('snacks', 'a', { b: first }));
  event.payments.push(payment('fuel', 'b', { a: second }, 'Fuel for ABC'));
  return event;
}
function settlementFor(pair, id = 'settlement-1') {
  return { id, keys: [...pair.keys], from: pair.from, to: pair.to, amount: pair.amount, at };
}

test('original ₹2,000 example preserves exact original debts and excludes self and zero shares', () => {
  const event = example();
  assert.equal(validate(event), event);
  assert.deepEqual(debts(event), [
    { key: 'snacks:b', payment: 'snacks', from: 'b', to: 'a', amount: 70_000, tag: 'Snacks at XYZ', items: ['Snacks'] },
    { key: 'snacks:d', payment: 'snacks', from: 'd', to: 'a', amount: 80_000, tag: 'Snacks at XYZ', items: ['Snacks'] },
  ]);
});

test('item-based fries and burgers total ₹1,000, with precise paise and optional individual Red Bull', () => {
  const event = blank();
  event.payments.push({ id: 'food', payer: 'a', tag: 'Dinner', amount: 100_000, items: [
    { id: 'fries', name: 'Fries', amount: 50_000, shares: split(50_000, ['a', 'b', 'c']) },
    { id: 'burgers', name: '2 burgers', amount: 50_000, shares: split(50_000, ['b', 'c']) },
  ] });
  validate(event);
  assert.deepEqual(debts(event).map(debt => [debt.from, debt.amount]), [['b', 41_667], ['c', 41_666]]);
  assert.deepEqual(debts(event)[0].items, ['Fries', '2 burgers']);
  event.payments[0].items.push({ id: 'redbull', name: 'Red Bull', amount: 10_000, shares: { c: 10_000 } });
  assert.throws(() => validate(event), /payment total/);
  event.payments[0].amount = 110_000;
  validate(event);
  assert.equal(debts(event).find(debt => debt.from === 'c').amount, 51_666);
});

test('even split conserves paise for many amounts and group sizes', () => {
  for (let size = 1; size <= 30; size++) {
    const people = Array.from({ length: size }, (_, index) => `p${index}`);
    for (const amount of [0, 1, 2, 7, 99, 100, 50_000, 1_000_000_000]) {
      const shares = Object.values(split(amount, people));
      assert.equal(shares.reduce((sum, share) => sum + share, 0), amount);
      assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
      assert.ok(shares.every(Number.isSafeInteger));
    }
  }
  assert.deepEqual(split(10, []), {});
  assert.throws(() => split(10, ['a', 'a']));
  assert.throws(() => split(10, ['__proto__']));
  for (const amount of [-1, 0.1, '100', NaN, Infinity, 1_000_000_001]) assert.throws(() => split(amount, ['a']));
});

test('opposite debts cancel only within each pair, while original debts remain visible', () => {
  const event = opposing();
  event.payments.push(payment('taxi', 'c', { b: 15_000 }));
  validate(event);
  const balances = pairs(event);
  assert.equal(balances.length, 6);
  assert.deepEqual(balances.find(pair => pair.from === 'b' && pair.to === 'a'), {
    from: 'b', to: 'a', amount: 40_000, keys: ['snacks:b', 'fuel:a'], count: 2,
  });
  assert.equal(balances.find(pair => pair.from === 'b' && pair.to === 'c').amount, 15_000);
  assert.equal(balances.find(pair => pair.from === 'a' && pair.to === 'c').amount, 0);
  assert.equal(debts(event).length, 3);
});

test('original debt checkbox changes pair balance and can be undone', () => {
  const event = example();
  event.settlements.push({ id: 'paid-d', keys: ['snacks:d'], from: 'd', to: 'a', amount: 80_000, at });
  validate(event);
  assert.deepEqual([...settledKeys(event)], ['snacks:d']);
  assert.equal(locked(event, 'snacks'), true);
  assert.equal(locked(event, 'snack'), false);
  assert.equal(pairs(event).find(pair => pair.from === 'a' && pair.to === 'd').amount, 0);
  assert.equal(debts(event).length, 2);
  event.settlements = [];
  assert.equal(locked(event, 'snacks'), false);
  assert.equal(pairs(event).find(pair => pair.from === 'd' && pair.to === 'a').amount, 80_000);
});

test('net settlement settles and reopens the exact group of original debts', () => {
  const event = opposing();
  const net = pairs(event).find(pair => pair.count > 0);
  event.settlements.push(settlementFor(net));
  validate(event);
  assert.deepEqual([...settledKeys(event)].sort(), ['fuel:a', 'snacks:b']);
  assert.equal(pairs(event).filter(pair => pair.count > 0).length, 0);
  assert.ok(locked(event, 'snacks') && locked(event, 'fuel'));
  const reopened = clone(event);
  reopened.settlements = [];
  enforceLocks(event, reopened);
  assert.equal(pairs(reopened).find(pair => pair.count > 0).amount, 40_000);
});

test('exactly opposite debts support a zero-money grouped clearance', () => {
  const event = opposing(30_000, 30_000);
  const pair = pairs(event).find(pair => pair.count > 0);
  assert.equal(pair.amount, 0);
  assert.equal(pair.count, 2);
  event.settlements.push(settlementFor(pair));
  validate(event);
  assert.equal(settledKeys(event).size, 2);
});

test('group settlement can exceed a single payment limit without losing integer precision', () => {
  const event = blank();
  event.payments = [payment('large-1', 'a', { b: 1_000_000_000 }), payment('large-2', 'a', { b: 1_000_000_000 })];
  event.settlements.push(settlementFor(pairs(event).find(pair => pair.count > 0)));
  validate(event);
  assert.equal(event.settlements[0].amount, 2_000_000_000);
});

test('validation rejects malformed top-level event values and impossible calendar dates', () => {
  for (const value of [null, [], undefined, 12, 'event']) assert.throws(() => validate(value));
  for (const date of ['2026-02-30', '2025-02-29', '2026-13-01', 'not-a-date', 5]) {
    const event = blank(); event.date = date; assert.throws(() => validate(event));
  }
  const leap = blank(); leap.date = '2024-02-29'; validate(leap);
  for (const mutate of [
    e => { e.name = ' '; }, e => { e.name = 'x'.repeat(101); }, e => { e.closed = 'false'; },
    e => { e.people = [e.people[0]]; }, e => { e.payments = {}; }, e => { e.settlements = null; },
  ]) { const event = blank(); mutate(event); assert.throws(() => validate(event)); }
});

test('validation rejects duplicate and invalid participant, payment, item, and settlement IDs', () => {
  for (const mutate of [
    e => { e.people[1].id = e.people[0].id; },
    e => { e.people[1].name = ' a '; },
    e => { e.people[1] = null; },
    e => { e.people[1].id = 'bad:id'; },
    e => { e.people[1].id = '__proto__'; },
    e => { e.people[1].name = 'x'.repeat(41); },
    e => { e.payments.push(clone(e.payments[0])); },
    e => { e.payments[0].id = 'bad:id'; },
    e => { e.payments[0].items[0].id = ''; },
    e => { const second = payment('second', 'b', { a: 100 }); second.items[0].id = e.payments[0].items[0].id; e.payments.push(second); },
    e => { e.payments[0].items.push(clone(e.payments[0].items[0])); e.payments[0].amount *= 2; },
  ]) { const event = example(); mutate(event); assert.throws(() => validate(event)); }
  const event = example();
  event.settlements = [
    { id: 'same', keys: ['snacks:b'], from: 'b', to: 'a', amount: 70_000, at },
    { id: 'same', keys: ['snacks:d'], from: 'd', to: 'a', amount: 80_000, at },
  ];
  assert.throws(() => validate(event));
});

test('validation rejects malformed monetary values, unknown participants and mismatched totals', () => {
  for (const amount of [-1, NaN, Infinity, 0.5, '70000', 1_000_000_001, null]) {
    const event = example(); event.payments[0].items[0].shares.b = amount; assert.throws(() => validate(event));
  }
  for (const mutate of [
    e => { e.payments[0].amount = 0; },
    e => { e.payments[0].amount += 1; },
    e => { e.payments[0].payer = 'unknown'; },
    e => { e.payments[0].tag = ''; },
    e => { e.payments[0].items = []; },
    e => { e.payments[0].items[0] = null; },
    e => { e.payments[0].items[0].name = ''; },
    e => { e.payments[0].items[0].amount = 0; },
    e => { e.payments[0].items[0].shares = []; },
    e => { e.payments[0].items[0].shares = {}; },
    e => { e.payments[0].items[0].shares = { stranger: 200_000 }; },
    e => { e.payments[0].items[0].shares.b += 1; },
    e => { e.payments[0].items[0].shares = Object.create({ b: 200_000 }); },
  ]) { const event = example(); mutate(event); assert.throws(() => validate(event)); }
});

test('validation rejects overlap, missing debts, wrong parties, direction and amount in settlements', () => {
  for (const mutate of [
    e => { e.settlements[0].keys.push(e.settlements[0].keys[0]); },
    e => { e.settlements.push({ ...e.settlements[0], id: 'duplicate-coverage' }); },
    e => { e.settlements[0].keys = ['missing:b']; },
    e => { e.settlements[0].from = 'c'; },
    e => { e.settlements[0].to = 'b'; },
    e => { e.settlements[0].amount += 1; },
    e => { e.settlements[0].amount = -1; },
    e => { [e.settlements[0].from, e.settlements[0].to] = [e.settlements[0].to, e.settlements[0].from]; },
    e => { e.settlements[0].at = 'yesterday'; },
    e => { e.settlements[0].keys = []; },
    e => { e.settlements[0].keys.push({}); },
  ]) {
    const event = opposing(); event.settlements.push(settlementFor(pairs(event).find(pair => pair.count > 0)));
    mutate(event); assert.throws(() => validate(event));
  }
});

test('settled payments cannot be edited, deleted or reopened and edited in the same save', () => {
  const event = example();
  event.settlements.push({ id: 'paid-d', keys: ['snacks:d'], from: 'd', to: 'a', amount: 80_000, at });
  const edited = clone(event); edited.payments[0].tag = 'Updated tag';
  assert.throws(() => enforceLocks(event, edited), /Reopen the related settlements/);
  edited.settlements = [];
  assert.throws(() => enforceLocks(event, edited), /Reopen the related settlements/);
  const removed = clone(event); removed.payments = []; removed.settlements = [];
  assert.throws(() => enforceLocks(event, removed), /Reopen the related settlements/);
  const reopened = clone(event); reopened.settlements = [];
  enforceLocks(event, reopened);
  enforceLocks(reopened, edited);
});

test('grouped settlements are immutable until the entire group is reopened', () => {
  const event = opposing(); event.settlements.push(settlementFor(pairs(event).find(pair => pair.count > 0)));
  const partial = clone(event);
  partial.settlements[0].keys = ['snacks:b']; partial.settlements[0].amount = 70_000;
  validate(partial);
  assert.throws(() => enforceLocks(event, partial), /whole settlement/);
  partial.settlements[0].id = 'new-id';
  assert.throws(() => enforceLocks(event, partial), /whole settlement/);
  const timestampEdit = clone(event); timestampEdit.settlements[0].at = '2026-10-17T12:00:00.000Z';
  assert.throws(() => enforceLocks(event, timestampEdit), /whole settlement/);
});

test('settlement lock comparison tolerates JSON property ordering', () => {
  const event = example();
  event.settlements.push({ id: 'paid-d', keys: ['snacks:d'], from: 'd', to: 'a', amount: 80_000, at });
  const reordered = clone(event);
  reordered.payments[0] = Object.fromEntries(Object.entries(reordered.payments[0]).reverse());
  reordered.payments[0].items[0].shares = { d: 80_000, c: 0, b: 70_000, a: 50_000 };
  enforceLocks(event, reordered);
});

test('people are editable before the first payment and fixed after it', () => {
  const event = blank(); const edited = clone(event); edited.people[0].name = 'Alex';
  enforceLocks(event, edited);
  event.payments = example().payments; edited.payments = example().payments;
  assert.throws(() => enforceLocks(event, edited), /Friend names are fixed/);
  const reordered = clone(event); reordered.people.reverse();
  assert.throws(() => enforceLocks(event, reordered), /Friend names are fixed/);
});

test('finished outings allow settlement changes but require saved reopening before payment changes', () => {
  const event = example(); event.closed = true;
  const settled = clone(event);
  settled.settlements.push({ id: 'paid-d', keys: ['snacks:d'], from: 'd', to: 'a', amount: 80_000, at });
  enforceLocks(event, settled);
  const edited = clone(event); edited.payments[0].tag = 'Updated tag';
  assert.throws(() => enforceLocks(event, edited), /Reopen the outing/);
  edited.closed = false;
  assert.throws(() => enforceLocks(event, edited), /Reopen the outing/);
  const reopened = clone(event); reopened.closed = false;
  enforceLocks(event, reopened);
  enforceLocks(reopened, edited);
});
