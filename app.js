/**
 * CampusPurse UI (Version 1)
 *
 * This file only reads the page, calls calc.js for every number and
 * storage.js for every save, then draws the result. It contains no budget
 * rules of its own.
 */
(function () {
  'use strict';

  const calc = window.CampusCalc;
  const storageApi = window.CampusStorage;
  if (!calc || !storageApi) {
    document.body.textContent = 'CampusPurse could not load calc.js or storage.js. Check the file names.';
    return;
  }

  const store = storageApi.createStorage();
  const money = calc.fmt;
  const $ = (sel, root) => (root || document).querySelector(sel);

  const LABELS = {
    food: 'Food',
    transport: 'Transport',
    data: 'Data',
    school: 'School',
    other: 'Other',
    flexible: 'Flexible money',
  };
  const ICONS = {
    food: '\uD83C\uDF72',
    transport: '\uD83D\uDE8C',
    data: '\uD83D\uDCF1',
    school: '\uD83C\uDF93',
    flexible: '\uD83D\uDCB8',
    other: '\uD83E\uDDFE',
  };

  /* ---------- state ---------- */

  let active = null; // { id, plan, spendings } or null
  let state = null; // latest result of calc.computeState
  let editing = null; // { index, entry } while the spending form is in edit mode
  let pendingDelete = null; // { index, entry } while the delete prompt is open
  let showAllRecent = false;
  let noticeTimer = null;

  /* ---------- small helpers ---------- */

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === false || v === null || v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) node.append(kid);
    return node;
  }

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function addDaysISO(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function formatDate(iso, withWeekday) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      weekday: withWeekday ? 'short' : undefined,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  /** Typed text to number. Returns `blank` for empty text, NaN for junk. */
  function parseAmount(text, blank) {
    const cleaned = String(text).replace(/[\s,\u20A6]/g, '');
    if (cleaned === '') return blank;
    if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return NaN;
    return Number(cleaned);
  }

  function pluralDays(n) {
    return `${n} day${n === 1 ? '' : 's'}`;
  }

  function openDialog(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeDialog(dlg) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function notify(message) {
    const box = $('#notice');
    box.textContent = message;
    box.hidden = false;
    $('#announcer').textContent = message; // always-present live region for screen readers
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      box.hidden = true;
      box.textContent = '';
    }, 6000);
  }

  function showWarning(message) {
    const box = $('#warning');
    box.textContent = message;
    box.hidden = !message;
  }

  /* ---------- form errors ---------- */

  function clearErrors(form) {
    form.querySelectorAll('[data-error-for]').forEach((p) => (p.textContent = ''));
    form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
    const general = $('.form-error', form);
    if (general) general.textContent = '';
  }

  /** Puts each error next to its field. Anything else goes in the form-level message. */
  function showErrors(form, errors) {
    clearErrors(form);
    const general = [];
    let firstInvalid = null;
    for (const e of errors) {
      const msg = form.querySelector(`[data-error-for="${e.field}"]`);
      const input = form.querySelector(`[data-field="${e.field}"]`);
      if (msg && input) {
        msg.textContent = msg.textContent ? `${msg.textContent} ${e.message}` : e.message;
        input.setAttribute('aria-invalid', 'true');
        if (!firstInvalid) firstInvalid = input;
      } else {
        general.push(e.message);
      }
    }
    const generalBox = $('.form-error', form);
    if (generalBox) generalBox.textContent = general.join(' ');
    if (firstInvalid) firstInvalid.focus();
  }

  /* ---------- views ---------- */

  const views = { setup: $('#view-setup'), dashboard: $('#view-dashboard') };

  function showView(name) {
    for (const key of Object.keys(views)) views[key].hidden = key !== name;
  }

  function showFatal(message) {
    $('#main').replaceChildren(el('p', { class: 'alert alert-bad', role: 'alert' }, message));
  }

  /* ---------- setup ---------- */

  const planForm = $('#plan-form');
  const setupInputs = {
    balance: $('#in-balance'),
    date: $('#in-income-date'),
    food: $('#in-food'),
    transport: $('#in-transport'),
    data: $('#in-data'),
    school: $('#in-school'),
  };

  function readPlanInput() {
    return {
      startingBalance: parseAmount(setupInputs.balance.value, NaN),
      nextIncomeDate: setupInputs.date.value,
      planned: {
        food: parseAmount(setupInputs.food.value, 0),
        transport: parseAmount(setupInputs.transport.value, 0),
        data: parseAmount(setupInputs.data.value, 0),
        school: parseAmount(setupInputs.school.value, 0),
      },
    };
  }

  /** Live preview only. The real checks happen in calc.createPlan on save. */
  function updateSetupSummary() {
    const box = $('#setup-summary');
    const input = readPlanInput();
    const values = [input.startingBalance, ...Object.values(input.planned)];
    box.classList.remove('is-bad');
    if (values.some((v) => Number.isNaN(v))) {
      box.textContent = '';
      return;
    }
    const planned = Object.values(input.planned).reduce((a, b) => a + b, 0);
    const flexible = Math.round((input.startingBalance - planned) * 100) / 100;
    if (flexible < 0) {
      box.classList.add('is-bad');
      box.textContent = `Your planned expenses are ${money(-flexible)} more than the money you have.`;
    } else {
      box.textContent = `Planned expenses: ${money(planned)}. Flexible money: ${money(flexible)}.`;
    }
  }

  function showSetup(options) {
    const opts = options || {};
    planForm.reset();
    clearErrors(planForm);
    setupInputs.date.min = addDaysISO(todayISO(), 1);
    $('#setup-summary').textContent = '';
    $('#btn-setup-cancel').hidden = !opts.canCancel;
    $('#setup-archive-note').hidden = !active;
    $('#setup-title').textContent = active ? 'Start a new plan' : 'Set up your plan';
    showView('setup');
    if (opts.problem) $('.form-error', planForm).textContent = opts.problem;
    $('#setup-title').focus();
  }

  planForm.addEventListener('input', updateSetupSummary);

  planForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const created = calc.createPlan(readPlanInput());
    if (!created.ok) {
      showErrors(planForm, created.errors);
      return;
    }
    let finalState;
    if (active) {
      const current = calc.computeState(active.plan, active.spendings);
      if (current.ok) finalState = current.state;
    }
    const result = store.startNewPlan(created.plan, { finalState });
    if (!result.ok) {
      showErrors(planForm, result.errors);
      if (result.archived) {
        // Old plan is safely archived but the new one did not save.
        active = null;
        showWarning('Your previous plan was archived, but the new plan could not be saved. Please try again.');
      }
      return;
    }
    showWarning('');
    active = result.active;
    showAllRecent = false;
    renderDashboard();
    showView('dashboard');
    notify('Your new plan is ready.');
    $('#dash-title').focus();
  });

  $('#btn-setup-cancel').addEventListener('click', () => {
    renderDashboard();
    if (state) showView('dashboard');
  });

  /* ---------- dashboard ---------- */

  function levelFor(planned, remaining, over, overLabel) {
    if (over) return { cls: 'bad', label: overLabel };
    if (planned <= 0) return { cls: 'none', label: 'No budget' };
    if (remaining <= 0) return { cls: 'bad', label: 'Used up' };
    if (((planned - remaining) / planned) * 100 >= 75) return { cls: 'low', label: 'Running low' };
    return { cls: 'ok', label: 'On track' };
  }

  /** Percent of the original budget used, capped at 100 for the bar. */
  function percentUsed(planned, remaining, over) {
    if (over) return 100;
    if (planned <= 0) return 0;
    let pct = Math.round(((planned - remaining) / planned) * 100);
    pct = Math.min(100, Math.max(0, pct));
    if (remaining > 0 && pct === 100) pct = 99; // never say "100% used" while money is left
    return pct;
  }

  function barRow(opts) {
    const { key, planned, remaining, overspentText, overLabel } = opts;
    const over = Boolean(overspentText);
    const level = levelFor(planned, remaining, over, overLabel);
    const pct = percentUsed(planned, remaining, over);
    const left = Math.max(0, remaining);
    const label = LABELS[key];

    const li = el('li', { class: `level-${level.cls}` });
    li.append(
      el(
        'div',
        { class: 'bar-head' },
        el('span', { class: 'bar-name' }, el('span', { 'aria-hidden': 'true' }, ICONS[key] + ' '), label),
        el('span', { class: 'pill' }, level.label)
      )
    );

    const fill = el('div', { class: 'bar-fill' });
    fill.style.width = pct + '%';
    li.append(
      el(
        'div',
        {
          class: 'bar',
          role: 'progressbar',
          'aria-label': `${label} budget used`,
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(pct),
          'aria-valuetext': `${pct}% used. ${money(left)} left of ${money(planned)}.${over ? ' ' + overspentText : ''}`,
        },
        fill
      )
    );

    li.append(
      el(
        'div',
        { class: 'bar-foot' },
        el('span', null, el('strong', null, `${money(left)} left`), ` of ${money(planned)}`),
        el('span', null, `${pct}% used`)
      )
    );
    if (over) li.append(el('p', { class: 'bar-over' }, overspentText));
    return li;
  }

  function renderBars(s) {
    const list = $('#bars');
    list.replaceChildren();
    for (const key of calc.ESSENTIAL_CATEGORIES) {
      const c = s.categories[key];
      list.append(
        barRow({
          key,
          planned: c.planned,
          remaining: c.remaining,
          overLabel: 'Over budget',
          overspentText:
            c.spilledToFlexible > 0
              ? `${money(c.spilledToFlexible)} over budget, taken from flexible money.`
              : '',
        })
      );
    }
    const f = s.flexible;
    list.append(
      barRow({
        key: 'flexible',
        planned: f.planned,
        remaining: f.remaining,
        overLabel: 'Overspent',
        overspentText:
          f.overspentBy > 0
            ? `${money(f.overspentBy)} overspent. This is using money set aside for other essentials.`
            : '',
      })
    );
    $('#other-note').textContent =
      `${ICONS.other} Other spending so far: ${money(s.other.spent)}. ` +
      'It comes straight out of flexible money and has no budget of its own.';
  }

  const RECENT_LIMIT = 10;

  function renderRecent() {
    const list = $('#recent');
    const toggle = $('#btn-recent-toggle');
    list.replaceChildren();
    const total = active.spendings.length;
    if (total === 0) {
      list.append(el('li', null, el('span', { class: 'empty' }, 'No spending logged yet.')));
      toggle.hidden = true;
      return;
    }
    const lowest = showAllRecent ? 0 : Math.max(0, total - RECENT_LIMIT);
    // Newest first. `i` is the entry's real position in the log, used by Edit and Delete.
    for (let i = total - 1; i >= lowest; i--) {
      const e = active.spendings[i];
      const name = e.description || LABELS[e.category];
      list.append(
        el(
          'li',
          null,
          el(
            'span',
            null,
            el('span', { class: 'what' }, name),
            el('br'),
            el('span', { class: 'meta' }, `${LABELS[e.category]} \u00B7 ${formatDate(e.date, false)}`)
          ),
          el('span', { class: 'amt' }, money(e.amount)),
          el(
            'div',
            { class: 'entry-actions' },
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn-secondary btn-small',
                'data-action': 'edit',
                'data-index': String(i),
                'aria-label': `Edit ${name}, ${money(e.amount)}`,
              },
              'Edit'
            ),
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn-danger-outline btn-small',
                'data-action': 'delete',
                'data-index': String(i),
                'aria-label': `Delete ${name}, ${money(e.amount)}`,
              },
              'Delete'
            )
          )
        )
      );
    }
    toggle.hidden = total <= RECENT_LIMIT;
    toggle.textContent = showAllRecent ? 'Show fewer' : `Show all ${total} entries`;
  }

  function bannerFor(s) {
    if (s.status === 'ended') {
      return { cls: 'alert-bad', text: 'Your plan has ended. Start a new plan to keep tracking.' };
    }
    if (s.status === 'out_of_money') {
      return { cls: 'alert-bad', text: 'You have no money left in this plan.' };
    }
    if (s.status === 'overspent') {
      return {
        cls: 'alert-bad',
        text: `You are ${money(s.flexible.overspentBy)} past your flexible money. That is using money set aside for other essentials.`,
      };
    }
    if (s.flexible.planned > 0 && s.flexible.remaining === 0) {
      return { cls: 'alert-low', text: 'No flexible money left. Stick to your planned categories.' };
    }
    return null;
  }

  function renderDashboard() {
    if (!active) return;
    const result = calc.computeState(active.plan, active.spendings);
    if (!result.ok) {
      state = null;
      showSetup({
        canCancel: false,
        problem:
          'Your saved plan has problems (' +
          result.errors.map((e) => e.message).join(' ') +
          ') Starting a new plan will archive it.',
      });
      return;
    }
    const s = result.state;
    state = s;

    // Hero numbers
    const flexAmount = $('#flex-amount');
    flexAmount.textContent = money(s.flexible.remaining);
    flexAmount.classList.toggle('is-bad', s.flexible.remaining < 0);
    $('#flex-sub').textContent =
      s.flexible.remaining < 0
        ? 'Overspent. Other essentials are covering it.'
        : `of ${money(s.flexible.planned)} planned`;

    $('#safe-amount').textContent = money(s.safeDailySpend);
    let safeSub;
    if (s.planEnded) safeSub = 'Plan has ended';
    else if (s.flexible.remaining <= 0) safeSub = 'No flexible money to spend';
    else safeSub = `for the next ${pluralDays(s.daysRemaining)}`;
    $('#safe-sub').textContent = safeSub;

    // Info row
    $('#income-date').textContent = formatDate(active.plan.nextIncomeDate, true);
    $('#days-left').textContent =
      s.daysRemaining > 0
        ? pluralDays(s.daysRemaining)
        : s.daysRemaining === 0
        ? 'Income day is today'
        : 'Income date has passed';
    $('#total-amount').textContent = money(s.moneyRemaining);
    $('#total-sub').textContent =
      s.flexible.remaining < 0
        ? `${money(s.reservedRemaining)} set aside for essentials, minus ${money(s.flexible.overspentBy)} overspent`
        : `${money(s.reservedRemaining)} set aside for essentials + ${money(s.flexible.remaining)} flexible`;

    // Banner
    const banner = $('#banner');
    const b = bannerFor(s);
    banner.hidden = !b;
    banner.className = b ? `alert ${b.cls}` : 'alert';
    banner.textContent = b ? b.text : '';

    // Buttons
    $('#btn-log').disabled = s.planEnded;
    $('#btn-afford').disabled = s.planEnded;

    renderBars(s);
    renderRecent();
  }

  /* ---------- log, edit and delete spending ---------- */

  const logDialog = $('#log-dialog');
  const logForm = $('#log-form');
  const logCategory = $('#log-category');
  const deleteDialog = $('#delete-dialog');
  const deleteForm = $('#delete-form');

  const copy = (value) => JSON.parse(JSON.stringify(value));

  function updateLogHint() {
    const cat = logCategory.value;
    let text;
    if (cat === 'other') {
      text = 'Other has no budget. It comes straight out of flexible money.';
    } else if (editing) {
      text = `${LABELS[cat]} has a budget of ${money(state.categories[cat].planned)}. Spending above it comes out of flexible money.`;
    } else {
      text = `${LABELS[cat]} has ${money(state.categories[cat].remaining)} left. Anything above that comes out of flexible money.`;
    }
    $('#log-hint').textContent = text;
  }

  /** index === null opens the form to add; a number opens it to edit that entry. */
  function openLogDialog(index) {
    if (!state) return;
    logForm.reset();
    clearErrors(logForm);
    const date = $('#log-date');
    date.max = todayISO();
    if (index === null) {
      editing = null;
      $('#log-title').textContent = 'Log spending';
      $('#log-submit').textContent = 'Add spending';
      date.value = todayISO();
    } else {
      const entry = active.spendings[index];
      if (!entry) return;
      editing = { index, entry: copy(entry) };
      $('#log-title').textContent = 'Edit spending';
      $('#log-submit').textContent = 'Save changes';
      $('#log-amount').value = String(entry.amount);
      logCategory.value = entry.category;
      $('#log-desc').value = entry.description;
      date.value = entry.date;
    }
    updateLogHint();
    openDialog(logDialog);
    $('#log-amount').focus();
  }

  /**
   * Edit and delete work by position in the log, so first make sure the saved
   * entry is still the one on screen (it may have changed in another tab).
   */
  function entryIsCurrent(index, expected) {
    const loaded = store.loadActive();
    if (!loaded.ok) return { ok: false, errors: loaded.errors };
    const same =
      loaded.active &&
      loaded.active.id === active.id &&
      JSON.stringify(loaded.active.spendings[index]) === JSON.stringify(expected);
    if (same) return { ok: true };
    active = loaded.active;
    return { ok: false, stale: true };
  }

  function handleStale() {
    closeDialog(logDialog);
    closeDialog(deleteDialog);
    editing = null;
    pendingDelete = null;
    showWarning('Your spending log changed in another tab, so CampusPurse reloaded it. Please try again.');
    if (active) {
      renderDashboard();
      if (state) showView('dashboard');
    } else {
      showSetup({ canCancel: false });
    }
  }

  function afterCorrection(message) {
    showWarning('');
    renderDashboard();
    notify(message);
    $('#recent-title').focus(); // the button that opened the dialog may no longer exist
  }

  $('#btn-log').addEventListener('click', () => {
    if (!state || state.planEnded) return;
    openLogDialog(null);
  });

  logCategory.addEventListener('change', updateLogHint);

  logForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const entry = {
      amount: parseAmount($('#log-amount').value, NaN),
      category: logCategory.value,
      description: $('#log-desc').value,
      date: $('#log-date').value || undefined,
    };

    let result;
    if (editing) {
      const fresh = entryIsCurrent(editing.index, editing.entry);
      if (!fresh.ok) {
        if (fresh.stale) handleStale();
        else showErrors(logForm, fresh.errors);
        return;
      }
      result = calc.editSpending(active.plan, active.spendings, editing.index, entry);
    } else {
      result = calc.addSpending(active.plan, active.spendings, entry);
    }
    if (!result.ok) {
      showErrors(logForm, result.errors);
      return;
    }

    // Only replace the in-memory log once it has been saved.
    const saved = store.saveSpendings(result.spendings);
    if (!saved.ok) {
      showErrors(logForm, saved.errors);
      return;
    }
    active = saved.active;
    closeDialog(logDialog);
    const what = `${money(result.entry.amount)} on ${LABELS[result.entry.category]}`;
    if (editing) {
      editing = null;
      afterCorrection(`Updated entry: ${what}.`);
    } else {
      renderDashboard();
      notify(`Logged ${what}.`);
    }
  });

  function openDeleteDialog(index) {
    const entry = active.spendings[index];
    if (!entry) return;
    pendingDelete = { index, entry: copy(entry) };
    clearErrors(deleteForm);
    $('#delete-summary').textContent =
      `${entry.description || LABELS[entry.category]}: ${money(entry.amount)} on ${LABELS[entry.category]}, ` +
      `${formatDate(entry.date, false)}.`;
    openDialog(deleteDialog);
    $('#delete-cancel').focus(); // safest default for a destructive action
  }

  deleteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pendingDelete) return;
    const fresh = entryIsCurrent(pendingDelete.index, pendingDelete.entry);
    if (!fresh.ok) {
      if (fresh.stale) handleStale();
      else showErrors(deleteForm, fresh.errors);
      return;
    }
    const result = calc.deleteSpending(active.plan, active.spendings, pendingDelete.index);
    if (!result.ok) {
      showErrors(deleteForm, result.errors);
      return;
    }
    const saved = store.saveSpendings(result.spendings);
    if (!saved.ok) {
      showErrors(deleteForm, saved.errors);
      return;
    }
    active = saved.active;
    pendingDelete = null;
    closeDialog(deleteDialog);
    afterCorrection(`Deleted ${money(result.removed.amount)} on ${LABELS[result.removed.category]}.`);
  });

  $('#recent').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn || !active) return;
    const index = Number(btn.dataset.index);
    if (btn.dataset.action === 'edit') openLogDialog(index);
    else if (btn.dataset.action === 'delete') openDeleteDialog(index);
  });

  $('#btn-recent-toggle').addEventListener('click', () => {
    showAllRecent = !showAllRecent;
    renderRecent();
  });

  /* ---------- can I afford this ---------- */

  const affordDialog = $('#afford-dialog');
  const affordForm = $('#afford-form');
  const affordResult = $('#afford-result');

  const VERDICTS = {
    fits: { cls: 'level-ok', title: 'Yes, this fits your plan' },
    tight: { cls: 'level-low', title: "Yes, but it's tight" },
    over_plan: { cls: 'level-bad', title: 'Over your plan' },
    insufficient_funds: { cls: 'level-bad', title: "You can't afford this" },
    plan_ended: { cls: 'level-bad', title: 'Your plan has ended' },
  };

  function row(label, value) {
    return el('div', null, el('dt', null, label), el('dd', null, value));
  }

  function renderAffordResult(r) {
    const v = VERDICTS[r.verdict];
    affordResult.className = `result ${v.cls}`;
    const box = el('div', { class: 'result-box' }, el('h3', null, v.title), el('p', null, r.message));

    if (r.moneyAfter !== undefined && r.flexibleAfter !== undefined) {
      const list = el('dl', { class: 'result-list' });
      if (r.category !== 'other') {
        const from = `${money(r.fromCategory)} from ${LABELS[r.category]}` +
          (r.fromFlexible > 0 ? `, ${money(r.fromFlexible)} from flexible` : '');
        list.append(row('Paid from', from));
      } else {
        list.append(row('Paid from', 'Flexible money'));
      }
      list.append(row('Flexible money after', money(r.flexibleAfter)));
      list.append(row('Safe per day after', money(r.safeDailyAfter)));
      list.append(row('Total money after', money(r.moneyAfter)));
      box.append(list);
    }
    affordResult.replaceChildren(box);
  }

  function clearAffordResult() {
    affordResult.replaceChildren();
    affordResult.className = 'result';
  }

  $('#btn-afford').addEventListener('click', () => {
    if (!state || state.planEnded) return;
    affordForm.reset();
    clearErrors(affordForm);
    clearAffordResult();
    openDialog(affordDialog);
    $('#afford-amount').focus();
  });

  affordForm.addEventListener('input', clearAffordResult);

  affordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    clearAffordResult();
    const purchase = {
      amount: parseAmount($('#afford-amount').value, NaN),
      category: $('#afford-category').value,
    };
    const checked = calc.canAfford(active.plan, active.spendings, purchase);
    if (!checked.ok) {
      showErrors(affordForm, checked.errors);
      return;
    }
    clearErrors(affordForm);
    renderAffordResult(checked.result);
  });

  /* ---------- shared dialog behaviour ---------- */

  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.querySelectorAll('[data-close]').forEach((btn) =>
      btn.addEventListener('click', () => closeDialog(dlg))
    );
    // Click on the dimmed backdrop closes the dialog
    dlg.addEventListener('click', (event) => {
      if (event.target === dlg) closeDialog(dlg);
    });
  });

  $('#btn-new-plan').addEventListener('click', () => showSetup({ canCancel: Boolean(active) }));

  // Keep "days left" correct if the tab stays open overnight
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active && !views.dashboard.hidden) renderDashboard();
  });

  /* ---------- start ---------- */

  function init() {
    const loaded = store.loadActive();
    if (!loaded.ok) {
      showFatal(loaded.errors[0].message + ' Try a different browser or turn off private browsing.');
      return;
    }
    if (loaded.warning) showWarning(loaded.warning.message);
    active = loaded.active;
    if (active) {
      renderDashboard();
      if (state) showView('dashboard');
    } else {
      showSetup({ canCancel: false });
    }
  }

  init();
})();