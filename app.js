/* =================================================================
   Calculator — vanilla JS, zero dependencies.

   Data model
   ----------
   Every value the user can still edit lives in `state.value` as a
   CANONICAL string: "." is always the decimal separator and there is
   never any thousands grouping. Grouping and the locale decimal
   separator exist ONLY inside formatValue(), i.e. at render time.
   That is what keeps backspace, mid-typing states like "12." and
   locale independence from fighting each other.
   ================================================================= */

'use strict';

const MAX_DIGITS = 15;
const MAX_HISTORY = 100;
const STORAGE_KEY = 'calculadora-web.history.v1';
const ERROR_TEXT = 'Error';
const EMPTY_TEXT = 'Todavía no hay cálculos';

const SYM = {
  add: '+',
  subtract: '\u2212', // −
  multiply: '\u00d7', // ×
  divide: '\u00f7', // ÷
};

/* ------------------------------------------------------------------ */
/* Locale: derive the group/decimal separators from the browser locale */
/* ------------------------------------------------------------------ */

const pageLocale = resolveLocale();
const SEPARATORS = resolveSeparators(pageLocale);

function resolveLocale() {
  if (typeof navigator === 'undefined') return 'en-US';
  const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  return list.find(Boolean) || 'en-US';
}

function resolveSeparators(locale) {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.89);
    return {
      group: parts.find((p) => p.type === 'group')?.value ?? ',',
      decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    };
  } catch {
    return { group: ',', decimal: '.' };
  }
}

/* ------------------------------------------------------------------ */
/* Number helpers                                                      */
/* ------------------------------------------------------------------ */

/** Display-ready string: groups the integer part, swaps in locale separators. */
function formatValue(canonical) {
  if (canonical === null || canonical === undefined || canonical === '') return '0';

  const raw = String(canonical);
  if (/[eE]/.test(raw)) return raw; // exponential range: show it verbatim

  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const decPart = dot === -1 ? null : body.slice(dot + 1);

  // Function replacer so a "$"-like group separator can never be read as a pattern.
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, () => SEPARATORS.group);

  let out = decPart === null ? grouped : grouped + SEPARATORS.decimal + decPart;
  return negative ? '-' + out : out;
}

/** Formats a JS number for display (used for the small expression line). */
function fmt(num) {
  if (num === null || num === undefined || !Number.isFinite(num)) return '0';
  return formatValue(String(num));
}

/** canonical string -> number, or null when it is not parseable. */
function toNumber(canonical) {
  const n = Number.parseFloat(canonical);
  return Number.isFinite(n) ? n : null;
}

/** Float-noise killer: 0.1 + 0.2 must come back as "0.3", not 20 decimals. */
function normalize(value) {
  if (!Number.isFinite(value)) return '0';
  let n = Number.parseFloat(value.toPrecision(12));
  if (Object.is(n, -0) || n === 0) return '0';
  return String(n);
}

function applyOp(op, a, b) {
  switch (op) {
    case 'add':
      return a + b;
    case 'subtract':
      return a - b;
    case 'multiply':
      return a * b;
    case 'divide':
      return b === 0 ? null : a / b;
    default:
      return null;
  }
}

function digitCount(canonical) {
  return (canonical.match(/\d/g) || []).length;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  value: '0', // canonical string shown big
  accumulator: null, // left operand of the pending operation
  pendingOp: null, // 'add' | 'subtract' | 'multiply' | 'divide' | null
  waiting: false, // next digit starts a fresh operand
  exprText: '', // left-hand side of the pending operation, e.g. "2 + 3"
  expression: '', // what the small line shows: exprText + operator / "= "
  error: false,
  last: { op: null, operand: null }, // for repeating "="
};

const FRESH = { op: null, operand: null };

function resetNumbers() {
  state.value = '0';
  state.accumulator = null;
  state.pendingOp = null;
  state.waiting = false;
  state.exprText = '';
  state.expression = '';
  state.error = false;
  state.last = FRESH;
}

function clearAll() {
  resetNumbers();
  render();
}

function showError() {
  state.value = ERROR_TEXT;
  state.exprText = '';
  state.expression = '';
  state.accumulator = null;
  state.pendingOp = null;
  state.waiting = true;
  state.error = true;
  state.last = FRESH;
  render();
}

/* ------------------------------------------------------------------ */
/* Input rules                                                         */
/* ------------------------------------------------------------------ */

function startFreshIfResult() {
  // Pressing a digit after "=" or after a history click starts a new number,
  // but pressing it after an operator continues the current expression.
  if (state.pendingOp === null) {
    state.exprText = '';
    state.expression = '';
    state.last = FRESH;
  }
}

function inputDigit(digit) {
  if (state.error) clearAll();

  if (state.waiting) {
    state.value = digit;
    state.waiting = false;
    startFreshIfResult();
  } else if (state.value === '0') {
    state.value = digit;
  } else if (digitCount(state.value) < MAX_DIGITS) {
    state.value += digit;
  }
  render();
}

function inputDecimal() {
  if (state.error) clearAll();

  if (state.waiting) {
    state.value = '0.';
    state.waiting = false;
    startFreshIfResult();
  } else if (!state.value.includes('.')) {
    state.value += '.';
  }
  render();
}

function inputOperator(op) {
  if (state.error) return; // stay in error until C / Esc
  const current = toNumber(state.value);
  if (current === null) return;

  if (state.pendingOp !== null) {
    if (state.waiting) {
      // Swap the operator without recalculating: "12 +" becomes "12 ×".
    } else {
      const result = applyOp(state.pendingOp, state.accumulator, current);
      if (result === null) return showError();
      const rightText = formatValue(state.value);
      state.value = normalize(result);
      state.accumulator = toNumber(state.value);
      state.exprText = `${state.exprText} ${SYM[state.pendingOp]} ${rightText}`;
    }
  } else {
    state.accumulator = current;
    state.exprText = formatValue(state.value);
  }

  state.expression = `${state.exprText} ${SYM[op]}`;
  state.pendingOp = op;
  state.waiting = true;
  state.last = FRESH;
  render();
}

function equals() {
  if (state.error) return clearAll();

  let left;
  let op;
  let right;
  let exprText;

  if (state.pendingOp !== null) {
    left = state.accumulator;
    op = state.pendingOp;
    right = toNumber(state.value);
    if (left === null || right === null) return;
    exprText = `${state.exprText} ${SYM[op]} ${formatValue(state.value)}`;
  } else if (state.last.op !== null) {
    // Repeat the previous operation: "5 + 3 =" then "=" again.
    left = toNumber(state.value);
    op = state.last.op;
    right = state.last.operand;
    if (left === null || right === null) return;
    exprText = `${formatValue(state.value)} ${SYM[op]} ${fmt(right)}`;
  } else {
    return; // nothing to evaluate
  }

  const result = applyOp(op, left, right);
  if (result === null) return showError();

  const res = normalize(result);
  state.value = res;
  state.exprText = exprText;
  state.expression = `${exprText} =`;
  state.accumulator = null;
  state.pendingOp = null;
  state.waiting = true;
  state.error = false;
  state.last = { op, operand: right };

  addHistory(exprText, res);
  render();
}

function backspace() {
  if (state.error) return clearAll();
  if (state.waiting) return; // a committed result is not editable character by character

  state.value = state.value.slice(0, -1);
  if (state.value === '' || state.value === '-') state.value = '0';
  render();
}

function negate() {
  if (state.error) return;
  if (state.value === '0') return;
  state.value = state.value.startsWith('-') ? state.value.slice(1) : '-' + state.value;
  render();
}

function percent() {
  if (state.error) return clearAll();
  const value = toNumber(state.value);
  if (value === null) return;

  // "200 + 10%" -> 200 + 20; anywhere else "%" simply means /100.
  const relative =
    (state.pendingOp === 'add' || state.pendingOp === 'subtract') &&
    state.accumulator !== null &&
    !state.waiting;

  const next = relative ? (state.accumulator * value) / 100 : value / 100;
  state.value = normalize(next);
  state.waiting = false;
  render();
}

function restoreResult(canonical) {
  state.value = canonical;
  state.accumulator = null;
  state.pendingOp = null;
  state.waiting = true;
  state.exprText = '';
  state.expression = '';
  state.error = false;
  state.last = FRESH;
  render();
  flashValue();
}

/* ------------------------------------------------------------------ */
/* History (read-only log, newest first, persisted in localStorage)    */
/* ------------------------------------------------------------------ */

let calcHistory = loadHistory();

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry).slice(0, MAX_HISTORY);
  } catch {
    return []; // private mode, disabled storage, or a file:// origin
  }
}

function isValidEntry(entry) {
  return Boolean(entry) && typeof entry.expr === 'string' && typeof entry.result === 'string';
}

function persistHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(calcHistory));
  } catch {
    /* storage unavailable: the log still works for this session */
  }
}

function addHistory(expr, result) {
  calcHistory.unshift({ expr, result });
  if (calcHistory.length > MAX_HISTORY) calcHistory.length = MAX_HISTORY;
  persistHistory();
  renderHistory();
}

function clearHistory() {
  calcHistory = [];
  persistHistory();
  renderHistory();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

let exprEl = null;
let valueEl = null;
let logEl = null;
let clearBtn = null;

function render() {
  if (!valueEl) return;

  if (state.error) {
    exprEl.textContent = '';
    valueEl.textContent = ERROR_TEXT;
    valueEl.classList.add('is-error');
    valueEl.classList.remove('is-long', 'is-xlong');
    return;
  }

  exprEl.textContent = state.expression;
  valueEl.textContent = formatValue(state.value);
  valueEl.classList.remove('is-error');
  valueEl.classList.toggle('is-long', state.value.length > 11);
  valueEl.classList.toggle('is-xlong', state.value.length > 17);
}

function renderHistory() {
  if (!logEl) return;

  const frag = document.createDocumentFragment();

  if (calcHistory.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history__empty';
    empty.textContent = EMPTY_TEXT;
    frag.append(empty);
  } else {
    for (const entry of calcHistory) {
      const result = formatValue(entry.result);

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'history__item';
      item.dataset.result = entry.result;
      item.title = 'Usar este resultado';
      // textContent concatenates the spans with no spaces, so the readable
      // name has to be supplied explicitly for screen readers and copy/paste.
      item.setAttribute('aria-label', `${entry.expr} = ${result}`);

      const expr = document.createElement('span');
      expr.className = 'history__expr';
      expr.textContent = entry.expr;

      const sep = document.createElement('span');
      sep.className = 'history__sep';
      sep.textContent = '=';

      const resultEl = document.createElement('span');
      resultEl.className = 'history__result';
      resultEl.textContent = result;

      item.append(expr, sep, resultEl);
      frag.append(item);
    }
  }

  logEl.replaceChildren(frag);
  clearBtn.disabled = calcHistory.length === 0;
}

let valueFlashTimer = 0;

function flashValue() {
  if (!valueEl) return;
  valueEl.classList.add('is-restored');
  clearTimeout(valueFlashTimer);
  valueFlashTimer = setTimeout(() => valueEl.classList.remove('is-restored'), 450);
}

/* ------------------------------------------------------------------ */
/* Interaction wiring                                                  */
/* ------------------------------------------------------------------ */

function runAction(btn) {
  if (btn.dataset.digit !== undefined) {
    inputDigit(btn.dataset.digit);
    return;
  }
  if (btn.dataset.operator) {
    inputOperator(btn.dataset.operator);
    return;
  }
  switch (btn.dataset.action) {
    case 'clear':
      clearAll();
      break;
    case 'backspace':
      backspace();
      break;
    case 'percent':
      percent();
      break;
    case 'decimal':
      inputDecimal();
      break;
    case 'negate':
      negate();
      break;
    case 'equals':
      equals();
      break;
  }
}

function flashKey(btn) {
  btn.classList.add('is-pressed');
  setTimeout(() => btn.classList.remove('is-pressed'), 140);
}

function keyToSelector(key) {
  if (/^[0-9]$/.test(key)) return `[data-digit="${key}"]`;
  switch (key) {
    case '.':
    case ',':
      return '[data-action="decimal"]';
    case '+':
      return '[data-operator="add"]';
    case '-':
      return '[data-operator="subtract"]';
    case '*':
      return '[data-operator="multiply"]';
    case '/':
      return '[data-operator="divide"]';
    case 'Enter':
    case '=':
      return '[data-action="equals"]';
    case 'Escape':
      return '[data-action="clear"]';
    case 'Backspace':
      return '[data-action="backspace"]';
    case '%':
      return '[data-action="percent"]';
    default:
      return null;
  }
}

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const selector = keyToSelector(event.key);
  if (!selector) return;

  const btn = document.querySelector(`#keypad ${selector}`);
  if (!btn) return;

  event.preventDefault(); // stops "/" triggering Firefox quick-find
  flashKey(btn);
  runAction(btn);
}

function init() {
  exprEl = document.getElementById('expression');
  valueEl = document.getElementById('display-value');
  logEl = document.getElementById('history-log');
  clearBtn = document.getElementById('clear-history');

  const keypad = document.getElementById('keypad');
  keypad.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (btn) runAction(btn);
  });

  logEl.addEventListener('click', (event) => {
    const item = event.target.closest('.history__item');
    if (item) restoreResult(item.dataset.result);
  });

  clearBtn.addEventListener('click', clearHistory);
  document.addEventListener('keydown', onKeyDown);

  render();
  renderHistory();
}

if (typeof document !== 'undefined') init();
