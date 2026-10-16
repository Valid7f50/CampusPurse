'use strict';

(function () {

/**
 * CampusPurse storage layer (Version 1)
 *
 * - No DOM and no import of calc.js. The backend (localStorage by default)
 *   can be injected, so everything is testable in Node.
 * - Never throws. Every function returns { ok: true, ... } or
 *   { ok: false, errors: [{ code, message }] }.
 *
 * Data layout (three kinds of keys):
 *   campuspurse:v1:active          one active plan + its spending log
 *   campuspurse:v1:archive         array of archived plans (oldest first)
 *   campuspurse:v1:corrupt:<...>   quarantined copies of unreadable data
 *
 * Source of truth: an archived record's `plan` and `spendings` are stored
 * exactly as they were when archived. `summary` is derived for convenience
 * and must never be used to rebuild the plan.
 *
 * Archived records are only ever appended, never edited or removed.
 */

const VERSION = 1;
const KEYS = {
  active: 'campuspurse:v1:active',
  archive: 'campuspurse:v1:archive',
  corruptPrefix: 'campuspurse:v1:corrupt:',
};
const ESSENTIAL_CATEGORIES = ['food', 'transport', 'data', 'school'];
const CATEGORIES = [...ESSENTIAL_CATEGORIES, 'other'];

/* ---------- helpers ---------- */

const err = (code, message) => ({ code, message });
const fail = (...errors) => ({ ok: false, errors });
const clone = (v) => JSON.parse(JSON.stringify(v));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function isDate(str) {
  if (typeof str !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/* ---------- structural validation (shape only, no money rules) ---------- */

function planProblems(plan) {
  const p = [];
  if (!plan || typeof plan !== 'object') return ['plan is missing'];
  if (!isNum(plan.startingBalance) || plan.startingBalance < 0) p.push('startingBalance invalid');
  if (!isDate(plan.nextIncomeDate)) p.push('nextIncomeDate invalid');
  if (plan.startDate !== undefined && !isDate(plan.startDate)) p.push('startDate invalid');
  if (!plan.planned || typeof plan.planned !== 'object') {
    p.push('planned budgets missing');
  } else {
    for (const c of ESSENTIAL_CATEGORIES) {
      if (!isNum(plan.planned[c]) || plan.planned[c] < 0) p.push(`planned.${c} invalid`);
    }
  }
  return p;
}

function spendingsProblems(list) {
  if (!Array.isArray(list)) return ['spendings is not an array'];
  const p = [];
  list.forEach((s, i) => {
    if (!s || typeof s !== 'object') return p.push(`spendings[${i}] is not an object`);
    if (!isNum(s.amount) || s.amount <= 0) p.push(`spendings[${i}].amount invalid`);
    if (!CATEGORIES.includes(s.category)) p.push(`spendings[${i}].category invalid`);
    if (!isDate(s.date)) p.push(`spendings[${i}].date invalid`);
    if (typeof s.description !== 'string') p.push(`spendings[${i}].description invalid`);
  });
  return p;
}

function recordProblems(rec, isArchive) {
  if (!rec || typeof rec !== 'object') return ['record is not an object'];
  const p = [];
  if (rec.version !== VERSION) p.push('unsupported version');
  if (typeof rec.id !== 'string' || rec.id === '') p.push('id invalid');
  if (typeof rec.createdAt !== 'string') p.push('createdAt invalid');
  p.push(...planProblems(rec.plan), ...spendingsProblems(rec.spendings));
  if (isArchive) {
    if (typeof rec.archivedAt !== 'string') p.push('archivedAt invalid');
    if (!rec.summary || typeof rec.summary !== 'object') p.push('summary invalid');
  }
  return p;
}

/** Derived, convenience-only numbers. Plain sums, no budget logic. */
function buildSummary(active, finalState) {
  const spentByCategory = {};
  for (const c of CATEGORIES) spentByCategory[c] = 0;
  let totalSpent = 0;
  for (const s of active.spendings) {
    spentByCategory[s.category] = round2(spentByCategory[s.category] + s.amount);
    totalSpent = round2(totalSpent + s.amount);
  }
  let plannedTotal = 0;
  for (const c of ESSENTIAL_CATEGORIES) plannedTotal = round2(plannedTotal + active.plan.planned[c]);
  return {
    startingBalance: active.plan.startingBalance,
    nextIncomeDate: active.plan.nextIncomeDate,
    plannedTotal,
    totalSpent,
    endingBalance: round2(active.plan.startingBalance - totalSpent),
    entryCount: active.spendings.length,
    spentByCategory,
    finalState: finalState === undefined ? null : clone(finalState),
  };
}

/* ---------- factory ---------- */

function createStorage(options = {}) {
  const now = options.now || (() => Date.now());

  function getBackend() {
    if (options.backend) return options.backend;
    try {
      return globalThis.localStorage || null;
    } catch (e) {
      return null; // access can throw in some private modes
    }
  }

  const unavailable = () =>
    fail(err('STORAGE_UNAVAILABLE', 'Browser storage is not available. Data will not be saved.'));

  function read(b, key) {
    try {
      const raw = b.getItem(key);
      return { ok: true, raw: raw === undefined ? null : raw };
    } catch (e) {
      return fail(err('STORAGE_READ_FAILED', 'Could not read saved data.'));
    }
  }

  function write(b, key, value) {
    try {
      b.setItem(key, JSON.stringify(value));
      return { ok: true };
    } catch (e) {
      return fail(err('STORAGE_WRITE_FAILED', 'Could not save data. Storage may be full.'));
    }
  }

  function remove(b, key) {
    try {
      b.removeItem(key);
      return { ok: true };
    } catch (e) {
      return fail(err('STORAGE_WRITE_FAILED', 'Could not update saved data.'));
    }
  }

  function parse(raw) {
    try {
      return { value: JSON.parse(raw) };
    } catch (e) {
      return null;
    }
  }

  /** Copies unreadable data aside, then clears the original key. */
  function quarantine(b, key, raw) {
    const backupKey = `${KEYS.corruptPrefix}${now()}:${key.split(':').pop()}`;
    try {
      b.setItem(backupKey, raw);
      b.removeItem(key);
      return backupKey;
    } catch (e) {
      return null; // leave the original in place rather than lose it
    }
  }

  const corruptWarning = (code, message, problems, backupKey) => ({
    code,
    message,
    problems,
    backupKey,
  });

  /* ----- active plan ----- */

  /**
   * Returns { ok, active } where active is null when nothing is saved.
   * Unreadable data is quarantined (never silently deleted) and reported
   * through `warning`.
   */
  function loadActive() {
    const b = getBackend();
    if (!b) return unavailable();
    const r = read(b, KEYS.active);
    if (!r.ok) return r;
    if (r.raw === null) return { ok: true, active: null };

    const parsed = parse(r.raw);
    const problems = parsed ? recordProblems(parsed.value, false) : ['not valid JSON'];
    if (problems.length) {
      const backupKey = quarantine(b, KEYS.active, r.raw);
      return {
        ok: true,
        active: null,
        warning: corruptWarning(
          'CORRUPT_ACTIVE_PLAN',
          'Your saved plan could not be read, so it was set aside. You can start a new plan.',
          problems,
          backupKey
        ),
      };
    }
    return { ok: true, active: parsed.value };
  }

  /** Saves a brand-new active plan. Refuses to overwrite an existing one. */
  function saveNewPlan(plan, opts = {}) {
    const b = getBackend();
    if (!b) return unavailable();
    const problems = planProblems(plan);
    if (problems.length) {
      return fail(...problems.map((m) => err('INVALID_PLAN', m)));
    }
    const existing = loadActive();
    if (!existing.ok) return existing;
    if (existing.active) {
      return fail(err('ACTIVE_PLAN_EXISTS', 'An active plan already exists. Archive it first.'));
    }
    const active = {
      version: VERSION,
      id: opts.id || `plan_${now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date(now()).toISOString(),
      plan: clone(plan),
      spendings: [],
    };
    const w = write(b, KEYS.active, active);
    if (!w.ok) return w;
    return { ok: true, active: clone(active) };
  }

  /** Replaces the spending log of the active plan. The plan itself never changes. */
  function saveSpendings(spendings) {
    const b = getBackend();
    if (!b) return unavailable();
    const problems = spendingsProblems(spendings);
    if (problems.length) {
      return fail(...problems.map((m) => err('INVALID_SPENDING', m)));
    }
    const cur = loadActive();
    if (!cur.ok) return cur;
    if (!cur.active) return fail(err('NO_ACTIVE_PLAN', 'There is no active plan to save spending to.'));
    const next = { ...cur.active, spendings: clone(spendings) };
    const w = write(b, KEYS.active, next);
    if (!w.ok) return w;
    return { ok: true, active: clone(next) };
  }

  /* ----- archive ----- */

  /** Raw archive array, kept as-is so unreadable records are never dropped. */
  function readArchiveRaw(b) {
    const r = read(b, KEYS.archive);
    if (!r.ok) return r;
    if (r.raw === null) return { ok: true, list: [] };
    const parsed = parse(r.raw);
    if (parsed && Array.isArray(parsed.value)) return { ok: true, list: parsed.value };
    const backupKey = quarantine(b, KEYS.archive, r.raw);
    return {
      ok: true,
      list: [],
      warning: corruptWarning(
        'CORRUPT_ARCHIVE',
        'Your plan history could not be read, so it was set aside.',
        [parsed ? 'archive is not an array' : 'not valid JSON'],
        backupKey
      ),
    };
  }

  /** Returns every readable archived plan, oldest first. */
  function loadArchive() {
    const b = getBackend();
    if (!b) return unavailable();
    const r = readArchiveRaw(b);
    if (!r.ok) return r;
    const archive = r.list.filter((rec) => recordProblems(rec, true).length === 0);
    const out = { ok: true, archive: clone(archive), skipped: r.list.length - archive.length };
    if (r.warning) out.warning = r.warning;
    return out;
  }

  function getArchivedPlan(id) {
    const r = loadArchive();
    if (!r.ok) return r;
    const rec = r.archive.find((x) => x.id === id);
    if (!rec) return fail(err('NOT_FOUND', 'No archived plan with that id.'));
    return { ok: true, record: rec };
  }

  /**
   * Moves the active plan into the archive, unchanged, then clears the
   * active slot. The archive write happens first, so a failure can never
   * lose the plan. Safe to retry: an id already archived is not duplicated.
   * opts.finalState (optional) is stored inside the summary only.
   */
  function archiveActive(opts = {}) {
    const b = getBackend();
    if (!b) return unavailable();
    const cur = loadActive();
    if (!cur.ok) return cur;
    if (!cur.active) return fail(err('NO_ACTIVE_PLAN', 'There is no active plan to archive.'));

    const arch = readArchiveRaw(b);
    if (!arch.ok) return arch;

    const active = cur.active;
    const already = arch.list.find((rec) => rec && rec.id === active.id);
    let record = already;
    if (!already) {
      record = {
        version: VERSION,
        id: active.id,
        createdAt: active.createdAt,
        archivedAt: new Date(now()).toISOString(),
        plan: clone(active.plan),
        spendings: clone(active.spendings),
        summary: buildSummary(active, opts.finalState),
      };
      const w = write(b, KEYS.archive, [...arch.list, record]);
      if (!w.ok) return w; // active plan untouched
    }
    const rm = remove(b, KEYS.active);
    if (!rm.ok) return rm; // safe to retry, archive write is idempotent
    return { ok: true, record: clone(record) };
  }

  /**
   * "Start new plan": validates the new plan first, archives the current
   * one (if any), then saves the new plan under a fresh id. Old data is
   * never touched after archiving.
   * If the final save fails, the old plan is already safely archived and
   * the user can retry with saveNewPlan.
   */
  function startNewPlan(plan, opts = {}) {
    const problems = planProblems(plan);
    if (problems.length) {
      return fail(...problems.map((m) => err('INVALID_PLAN', m)));
    }
    const cur = loadActive();
    if (!cur.ok) return cur;

    let archived = null;
    if (cur.active) {
      const a = archiveActive({ finalState: opts.finalState });
      if (!a.ok) return a;
      archived = a.record;
    }
    const created = saveNewPlan(plan, { id: opts.id });
    if (!created.ok) {
      return { ...created, archived };
    }
    return { ok: true, active: created.active, archived };
  }

  return {
    loadActive,
    saveNewPlan,
    saveSpendings,
    archiveActive,
    startNewPlan,
    loadArchive,
    getArchivedPlan,
  };
}

const api = { createStorage, KEYS, VERSION };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.CampusStorage = api;

})();