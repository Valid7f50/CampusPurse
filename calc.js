'use strict';

(function () {

/**
 * CampusPurse calculation engine (Version 1)
 *
 * Pure functions only. No DOM, no localStorage, no Date.now() unless
 * `today` is omitted. Safe to test in Node and to reuse in React later.
 *
 * Conventions:
 * - Amounts are plain numbers in naira, rounded to 2 decimals internally.
 * - Dates are 'YYYY-MM-DD' strings.
 * - Functions never throw on bad input. They return { ok: false, errors }.
 */

const ESSENTIAL_CATEGORIES = ['food', 'transport', 'data', 'school'];
const CATEGORIES = [...ESSENTIAL_CATEGORIES, 'other'];
const MAX_AMOUNT = 1e9;
/**
 * Initial "tight" threshold (adjust after testing with students).
 * A purchase is "tight" when the flexible money left AFTER buying it
 * is below this amount (in naira), including exactly zero.
 */
const TIGHT_BUFFER = 1000;
const DAY_MS = 86400000;

/* ---------- small helpers ---------- */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const err = (code, message, field) => ({ code, message, field });
const fail = (errors) => ({ ok: false, errors });

function fmt(n) {
  const v = round2(Math.abs(n));
  const [whole, dec] = (Number.isInteger(v) ? String(v) : v.toFixed(2)).split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + '\u20A6' + withCommas + (dec ? '.' + dec : '');
}

function isAmount(v, allowZero) {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v <= MAX_AMOUNT &&
    (allowZero ? v >= 0 : v > 0)
  );
}

/** Strict 'YYYY-MM-DD' parser. Returns UTC midnight in ms, or null. */
function parseDate(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  ) {
    return null; // e.g. 2026-02-30
  }
  return ms;
}

function toISO(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `today` may be omitted (uses device date), a Date, or 'YYYY-MM-DD'. */
function resolveToday(today) {
  if (today === undefined) {
    const d = new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }
  if (today instanceof Date && !Number.isNaN(today.getTime())) {
    return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  }
  if (typeof today === 'string') return parseDate(today);
  return null;
}

/* ---------- validation ---------- */

function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') {
    return [err('INVALID_PLAN', 'Plan is missing or invalid.', 'plan')];
  }
  if (!isAmount(plan.startingBalance, true)) {
    errors.push(err('INVALID_AMOUNT', 'Starting balance must be a number of 0 or more.', 'startingBalance'));
  }
  if (parseDate(plan.nextIncomeDate) === null) {
    errors.push(err('INVALID_DATE', 'Next income date must be a real date (YYYY-MM-DD).', 'nextIncomeDate'));
  }
  if (!plan.planned || typeof plan.planned !== 'object') {
    errors.push(err('INVALID_PLAN', 'Planned budgets are missing.', 'planned'));
  } else {
    for (const c of ESSENTIAL_CATEGORIES) {
      if (!isAmount(plan.planned[c], true)) {
        errors.push(err('INVALID_AMOUNT', `Planned ${c} must be a number of 0 or more.`, `planned.${c}`));
      }
    }
  }
  if (errors.length === 0) {
    const total = ESSENTIAL_CATEGORIES.reduce((s, c) => s + plan.planned[c], 0);
    if (round2(total) > round2(plan.startingBalance)) {
      errors.push(
        err(
          'INSUFFICIENT_FUNDS',
          `Planned expenses (${fmt(total)}) are more than your balance (${fmt(plan.startingBalance)}).`,
          'planned'
        )
      );
    }
  }
  return errors;
}

function validateSpending(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return [err('INVALID_SPENDING', 'Spending entry is missing or invalid.', 'entry')];
  }
  if (!isAmount(entry.amount, false)) {
    errors.push(err('INVALID_AMOUNT', 'Amount must be a number greater than 0.', 'amount'));
  }
  if (!CATEGORIES.includes(entry.category)) {
    errors.push(err('INVALID_CATEGORY', 'Category must be food, transport, data, school or other.', 'category'));
  }
  if (entry.date !== undefined && parseDate(entry.date) === null) {
    errors.push(err('INVALID_DATE', 'Spending date must be a real date (YYYY-MM-DD).', 'date'));
  }
  return errors;
}

/* ---------- core allocation ---------- */

/**
 * One spending rule, used by everything.
 * Essential category: category budget first, overflow hits flexible.
 * Other: straight from flexible.
 */
function allocate(remaining, flexible, amount, category) {
  const fromCategory =
    category === 'other' ? 0 : round2(Math.min(amount, remaining[category]));
  const fromFlexible = round2(amount - fromCategory);
  const nextRemaining = { ...remaining };
  if (category !== 'other') {
    nextRemaining[category] = round2(remaining[category] - fromCategory);
  }
  return {
    remaining: nextRemaining,
    flexible: round2(flexible - fromFlexible),
    fromCategory,
    fromFlexible,
  };
}

/** Replays all spending from the original plan. Never stores running totals. */
function replay(plan, spendings) {
  let remaining = {};
  let planTotal = 0;
  for (const c of ESSENTIAL_CATEGORIES) {
    remaining[c] = round2(plan.planned[c]);
    planTotal += plan.planned[c];
  }
  const flexiblePlanned = round2(plan.startingBalance - planTotal);
  let flexible = flexiblePlanned;
  const spill = { food: 0, transport: 0, data: 0, school: 0 };
  let otherSpent = 0;
  let totalSpent = 0;

  for (const s of spendings) {
    const amount = round2(s.amount);
    const r = allocate(remaining, flexible, amount, s.category);
    remaining = r.remaining;
    flexible = r.flexible;
    totalSpent = round2(totalSpent + amount);
    if (s.category === 'other') otherSpent = round2(otherSpent + amount);
    else spill[s.category] = round2(spill[s.category] + r.fromFlexible);
  }
  return { remaining, flexible, flexiblePlanned, spill, otherSpent, totalSpent };
}

/* ---------- public API ---------- */

/**
 * Validates a new plan. The income date must be in the future.
 * Returns { ok, plan } or { ok: false, errors }.
 */
function createPlan(input, today) {
  const errors = validatePlan(input);
  const todayMs = resolveToday(today);
  if (todayMs === null) errors.push(err('INVALID_DATE', 'Today\'s date is invalid.', 'today'));
  if (errors.length) return fail(errors);

  if (parseDate(input.nextIncomeDate) <= todayMs) {
    return fail([err('DATE_NOT_FUTURE', 'Next income date must be after today.', 'nextIncomeDate')]);
  }
  const plan = {
    startingBalance: round2(input.startingBalance),
    nextIncomeDate: input.nextIncomeDate,
    startDate: toISO(todayMs),
    planned: {},
  };
  for (const c of ESSENTIAL_CATEGORIES) plan.planned[c] = round2(input.planned[c]);
  return { ok: true, plan };
}

/**
 * Full dashboard numbers for a plan plus its spending log.
 * Works on ended plans too (status 'ended').
 */
function computeState(plan, spendings, today) {
  const log = spendings === undefined ? [] : spendings;
  const errors = validatePlan(plan);
  if (!Array.isArray(log)) {
    errors.push(err('INVALID_SPENDING', 'Spending log must be an array.', 'spendings'));
  } else {
    log.forEach((s, i) => {
      validateSpending(s).forEach((e) => errors.push({ ...e, index: i }));
    });
  }
  const todayMs = resolveToday(today);
  if (todayMs === null) errors.push(err('INVALID_DATE', 'Today\'s date is invalid.', 'today'));
  if (errors.length) return fail(errors);

  const r = replay(plan, log);
  const daysRemaining = Math.round((parseDate(plan.nextIncomeDate) - todayMs) / DAY_MS);
  const planEnded = daysRemaining <= 0;

  const categories = {};
  let reserved = 0;
  for (const c of ESSENTIAL_CATEGORIES) {
    categories[c] = {
      planned: round2(plan.planned[c]),
      remaining: r.remaining[c],
      spilledToFlexible: r.spill[c],
    };
    reserved += r.remaining[c];
  }
  reserved = round2(reserved);

  const moneyRemaining = round2(plan.startingBalance - r.totalSpent);
  const flexibleRemaining = r.flexible; // can be negative when overspent
  const usableFlexible = Math.max(0, flexibleRemaining);
  const safeDailySpend = planEnded ? 0 : round2(usableFlexible / daysRemaining);

  let status = 'on_track';
  if (planEnded) status = 'ended';
  else if (moneyRemaining <= 0) status = 'out_of_money';
  else if (flexibleRemaining < 0) status = 'overspent';

  return {
    ok: true,
    state: {
      startingBalance: round2(plan.startingBalance),
      totalSpent: r.totalSpent,
      moneyRemaining,
      reservedRemaining: reserved,
      categories,
      other: { spent: r.otherSpent },
      flexible: {
        planned: r.flexiblePlanned,
        remaining: flexibleRemaining,
        overspentBy: flexibleRemaining < 0 ? round2(-flexibleRemaining) : 0,
      },
      daysRemaining,
      planEnded,
      safeDailySpend,
      status,
    },
  };
}

/**
 * Adds a spending entry if it is valid and affordable.
 * Returns a NEW array, never mutates the old one.
 */
function addSpending(plan, spendings, entry, today) {
  const current = computeState(plan, spendings, today);
  if (!current.ok) return current;
  const errors = validateSpending(entry);
  if (errors.length) return fail(errors);

  const s = current.state;
  if (s.planEnded) {
    return fail([err('PLAN_ENDED', 'This plan has ended. Start a new plan to log more spending.', 'plan')]);
  }
  const amount = round2(entry.amount);
  if (amount > s.moneyRemaining) {
    return fail([
      err('INSUFFICIENT_FUNDS', `You only have ${fmt(s.moneyRemaining)} left.`, 'amount'),
    ]);
  }
  const todayMs = resolveToday(today);
  const normalized = {
    amount,
    category: entry.category,
    description: typeof entry.description === 'string' ? entry.description.trim().slice(0, 100) : '',
    date: entry.date || toISO(todayMs),
  };
  return { ok: true, spendings: [...spendings, normalized], entry: normalized };
}

/**
 * Replaces the entry at `index` with a corrected one (same position, no
 * duplicate). The whole log is replayed afterwards by computeState, so no
 * balance is ever adjusted by hand. Allowed on an ended plan as long as
 * the plan is still the active one.
 */
function editSpending(plan, spendings, index, entry, today) {
  const current = computeState(plan, spendings, today);
  if (!current.ok) return current;
  if (!Array.isArray(spendings) || !Number.isInteger(index) || index < 0 || index >= spendings.length) {
    return fail([err('INVALID_ENTRY', 'That spending entry could not be found.', 'entry')]);
  }
  const errors = validateSpending(entry);
  if (errors.length) return fail(errors);

  const previous = spendings[index];
  const amount = round2(entry.amount);
  // Cash must never go negative: money left, ignoring the entry being replaced.
  const available = round2(current.state.moneyRemaining + previous.amount);
  if (amount > available) {
    return fail([
      err('INSUFFICIENT_FUNDS', `You only have ${fmt(available)} available for this entry.`, 'amount'),
    ]);
  }
  const normalized = {
    amount,
    category: entry.category,
    description: typeof entry.description === 'string' ? entry.description.trim().slice(0, 100) : '',
    date: entry.date || previous.date,
  };
  const next = spendings.map((s, i) => (i === index ? normalized : s));
  const check = computeState(plan, next, today);
  if (!check.ok) return check;
  return { ok: true, spendings: next, entry: normalized, previous };
}

/** Removes the entry at `index`. Returns a NEW array; balances come from replay. */
function deleteSpending(plan, spendings, index, today) {
  const current = computeState(plan, spendings, today);
  if (!current.ok) return current;
  if (!Array.isArray(spendings) || !Number.isInteger(index) || index < 0 || index >= spendings.length) {
    return fail([err('INVALID_ENTRY', 'That spending entry could not be found.', 'entry')]);
  }
  const next = spendings.filter((_, i) => i !== index);
  const check = computeState(plan, next, today);
  if (!check.ok) return check;
  return { ok: true, spendings: next, removed: spendings[index] };
}

/**
 * "Can I afford this?" Simulates the purchase without saving anything.
 * verdict: 'fits' | 'tight' | 'over_plan' | 'insufficient_funds' | 'plan_ended'
 */
function canAfford(plan, spendings, purchase, today) {
  const current = computeState(plan, spendings, today);
  if (!current.ok) return current;
  const errors = validateSpending({ category: 'other', ...purchase });
  if (errors.length) return fail(errors);

  const before = current.state;
  const category = purchase.category || 'other';
  const amount = round2(purchase.amount);

  const base = {
    amount,
    category,
    moneyBefore: before.moneyRemaining,
    flexibleBefore: before.flexible.remaining,
    safeDailyBefore: before.safeDailySpend,
  };

  if (before.planEnded) {
    return {
      ok: true,
      result: { ...base, verdict: 'plan_ended', message: 'Your plan has ended. Start a new plan first.' },
    };
  }
  if (amount > before.moneyRemaining) {
    return {
      ok: true,
      result: {
        ...base,
        verdict: 'insufficient_funds',
        moneyAfter: before.moneyRemaining,
        message: `You only have ${fmt(before.moneyRemaining)} left, so you can't afford ${fmt(amount)}.`,
      },
    };
  }

  const remaining = {};
  for (const c of ESSENTIAL_CATEGORIES) remaining[c] = before.categories[c].remaining;
  const sim = allocate(remaining, before.flexible.remaining, amount, category);

  const moneyAfter = round2(before.moneyRemaining - amount);
  const safeDailyAfter = round2(Math.max(0, sim.flexible) / before.daysRemaining);
  const common = {
    ...base,
    fromCategory: sim.fromCategory,
    fromFlexible: sim.fromFlexible,
    moneyAfter,
    flexibleAfter: sim.flexible,
    safeDailyAfter,
  };

  if (sim.flexible < 0) {
    return {
      ok: true,
      result: {
        ...common,
        verdict: 'over_plan',
        message: `You have the money, but this goes ${fmt(-sim.flexible)} past your flexible budget and eats into money set aside for essentials.`,
      },
    };
  }
  if (sim.flexible < TIGHT_BUFFER) {
    return {
      ok: true,
      result: {
        ...common,
        verdict: 'tight',
        message: `You can afford it, but it leaves only ${fmt(sim.flexible)} of flexible money. Safe daily spending drops from ${fmt(before.safeDailySpend)} to ${fmt(safeDailyAfter)}.`,
      },
    };
  }
  return {
    ok: true,
    result: {
      ...common,
      verdict: 'fits',
      message: `This fits your plan. Safe daily spending goes from ${fmt(before.safeDailySpend)} to ${fmt(safeDailyAfter)}.`,
    },
  };
}

const api = {
  CATEGORIES,
  ESSENTIAL_CATEGORIES,
  TIGHT_BUFFER,
  createPlan,
  computeState,
  addSpending,
  editSpending,
  deleteSpending,
  canAfford,
  validatePlan,
  validateSpending,
  fmt,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.CampusCalc = api;

})();