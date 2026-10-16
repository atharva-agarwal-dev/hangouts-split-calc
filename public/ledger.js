// All money is stored as integer paise. This module has no browser or network dependencies.
const MAX_PAYMENT = 1_000_000_000;
const MAX_PAYMENTS = 500;
const MAX_SETTLEMENT = MAX_PAYMENT * MAX_PAYMENTS;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const id = value => typeof value === 'string' && ID_PATTERN.test(value) && !RESERVED_IDS.has(value);
const money = (value, maximum = MAX_PAYMENT) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const label = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const fail = message => { throw new Error(message); };

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 30) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

// Comparing sorted object keys avoids treating a harmless JSON field reorder as an edit.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Split equally; the first people in the supplied order receive any spare paise. */
export function split(amount, personIds) {
  if (!money(amount)) fail('Enter a valid amount in paise.');
  if (!Array.isArray(personIds) || personIds.length > 30 || personIds.some(person => !id(person))
      || new Set(personIds).size !== personIds.length) fail('Select each friend only once.');
  if (personIds.length === 0) return {};
  const base = Math.floor(amount / personIds.length);
  const remainder = amount % personIds.length;
  return Object.fromEntries(personIds.map((person, index) => [person, base + (index < remainder ? 1 : 0)]));
}

/** Original debts, including those that have since been settled. A payer never owes themselves. */
export function debts(event) {
  return event.payments.flatMap(payment => event.people
    .filter(person => person.id !== payment.payer)
    .map(person => ({
      key: `${payment.id}:${person.id}`,
      payment: payment.id,
      from: person.id,
      to: payment.payer,
      amount: payment.items.reduce((total, item) => total + (item.shares[person.id] || 0), 0),
      tag: payment.tag,
      items: payment.items.filter(item => item.shares[person.id] > 0).map(item => item.name),
    }))
    .filter(debt => debt.amount > 0));
}

export function settledKeys(event) {
  return new Set(event.settlements.flatMap(settlement => settlement.keys));
}

/** One balance for each unordered pair, even if it is zero. No debts are rerouted through a third person. */
export function pairs(event) {
  const paid = settledKeys(event);
  const outstanding = debts(event).filter(debt => !paid.has(debt.key));
  return event.people.flatMap((person, index) => event.people.slice(index + 1).map(other => {
    const involved = outstanding.filter(debt =>
      (debt.from === person.id && debt.to === other.id) || (debt.from === other.id && debt.to === person.id));
    const net = involved.reduce((total, debt) => total + (debt.from === person.id ? debt.amount : -debt.amount), 0);
    return {
      from: net >= 0 ? person.id : other.id,
      to: net >= 0 ? other.id : person.id,
      amount: Math.abs(net),
      keys: involved.map(debt => debt.key),
      count: involved.length,
    };
  }));
}

export function locked(event, paymentId) {
  return event.settlements.some(settlement => settlement.keys.some(key => key.startsWith(`${paymentId}:`)));
}

/** Validate a complete event before saving or calculating balances from imported data. */
export function validate(event) {
  if (!record(event) || !label(event.name, 100)) fail('Give the outing a name (up to 100 characters).');
  if (!calendarDate(event.date) || typeof event.closed !== 'boolean') fail('Check the outing date and status.');
  if (!Array.isArray(event.people) || event.people.length < 2 || event.people.length > 30) {
    fail('Add between 2 and 30 friends.');
  }
  const personIds = new Set();
  const names = new Set();
  for (const person of event.people) {
    if (!record(person) || !id(person.id) || personIds.has(person.id) || !label(person.name, 40)) {
      fail('Each friend needs a unique ID and a name of up to 40 characters.');
    }
    const normalizedName = person.name.trim().toLocaleLowerCase('en-IN');
    if (names.has(normalizedName)) fail('Use a different name or nickname for each friend.');
    personIds.add(person.id);
    names.add(normalizedName);
  }
  if (!Array.isArray(event.payments) || event.payments.length > MAX_PAYMENTS
      || !Array.isArray(event.settlements) || event.settlements.length > 15_000) {
    fail('This outing has too many entries.');
  }
  const paymentIds = new Set();
  const itemIds = new Set();
  for (const payment of event.payments) {
    if (!record(payment) || !id(payment.id) || paymentIds.has(payment.id)) fail('Each payment needs a unique valid ID.');
    paymentIds.add(payment.id);
    if (!personIds.has(payment.payer) || !money(payment.amount) || payment.amount === 0 || !label(payment.tag, 100)) {
      fail('Check the payer, positive payment total, and payment tag (up to 100 characters).');
    }
    if (!Array.isArray(payment.items) || payment.items.length === 0 || payment.items.length > 100) {
      fail('Add between 1 and 100 items to each payment.');
    }
    let paymentTotal = 0;
    for (const item of payment.items) {
      if (!record(item) || !id(item.id) || itemIds.has(item.id)) fail('Each item needs a unique valid ID.');
      itemIds.add(item.id);
      if (!label(item.name, 100) || !money(item.amount) || item.amount === 0 || !record(item.shares)) {
        fail('Each item needs a name, a positive amount, and valid shares.');
      }
      const entries = Object.entries(item.shares);
      if (entries.length === 0 || entries.some(([personId, amount]) => !personIds.has(personId) || !money(amount))
          || entries.reduce((total, [, amount]) => total + amount, 0) !== item.amount) {
        fail('Each item’s shares must add up to its amount and belong to friends in this outing.');
      }
      paymentTotal += item.amount;
    }
    if (paymentTotal !== payment.amount) fail('Item amounts must add up to the payment total.');
  }

  const originalDebts = new Map(debts(event).map(debt => [debt.key, debt]));
  const usedKeys = new Set();
  const settlementIds = new Set();
  for (const settlement of event.settlements) {
    if (!record(settlement) || !id(settlement.id) || settlementIds.has(settlement.id)
        || !Array.isArray(settlement.keys) || settlement.keys.length === 0 || settlement.keys.length > MAX_PAYMENTS
        || !personIds.has(settlement.from) || !personIds.has(settlement.to) || settlement.from === settlement.to
        || !money(settlement.amount, MAX_SETTLEMENT) || !timestamp(settlement.at)) {
      fail('Check the settlement details.');
    }
    settlementIds.add(settlement.id);
    let total = 0;
    for (const key of settlement.keys) {
      const debt = originalDebts.get(key);
      if (typeof key !== 'string' || !debt || usedKeys.has(key)
          || !((debt.from === settlement.from && debt.to === settlement.to)
            || (debt.from === settlement.to && debt.to === settlement.from))) {
        fail('A debt can be settled only once and only between the same two friends.');
      }
      usedKeys.add(key);
      total += debt.from === settlement.from ? debt.amount : -debt.amount;
    }
    if (total !== settlement.amount) fail('The settlement amount must match the selected debts and their direction.');
  }
  return event;
}

/** A reopening is saved first, so editing never silently rewrites a completed settlement. */
export function enforceLocks(previous, next) {
  validate(previous);
  validate(next);
  if (previous.payments.length && canonical(previous.people) !== canonical(next.people)) {
    fail('Friend names are fixed after the first payment.');
  }
  if (previous.closed && canonical(previous.payments) !== canonical(next.payments)) {
    fail('Reopen the outing and save before adding, editing, or deleting a payment.');
  }
  const nextPayments = new Map(next.payments.map(payment => [payment.id, payment]));
  for (const payment of previous.payments) {
    if (locked(previous, payment.id) && canonical(payment) !== canonical(nextPayments.get(payment.id))) {
      fail('Reopen the related settlements and save before editing or deleting this payment.');
    }
  }
  const nextSettlements = new Map(next.settlements.map(settlement => [settlement.id, settlement]));
  const nextSettledKeys = settledKeys(next);
  for (const settlement of previous.settlements) {
    const replacement = nextSettlements.get(settlement.id);
    if ((replacement && canonical(settlement) !== canonical(replacement))
        || (!replacement && settlement.keys.some(key => nextSettledKeys.has(key)))) {
      fail('Reopen the whole settlement before changing the debts it covers.');
    }
  }
  return next;
}
