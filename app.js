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
  power: '^',
};

/* Precedence table: higher binds tighter. "power" is the only operator that
   associates to the right, so 2^3^2 is 2^(3^2) and not (2^3)^2. */
const PRECEDENCE = { add: 1, subtract: 1, multiply: 2, divide: 2, power: 3 };
const RIGHT_ASSOCIATIVE = 'power';

/* Grouping tokens live in the same token list as numbers and operators. */
const OPEN = '(';
const CLOSE = ')';

function isOperator(token) {
  return Object.prototype.hasOwnProperty.call(PRECEDENCE, token);
}

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
    case 'power': {
      // 0^-1 is Infinity and (-8)^0.5 is NaN: neither is a number to show.
      const result = a ** b;
      return Number.isFinite(result) ? result : null;
    }
    default:
      return null;
  }
}

/** Rounds one intermediate step the way the old left-to-right engine did. */
function settle(value) {
  return Number.parseFloat(normalize(value));
}

/* Evaluates "num op num op num..." with real precedence and grouping.
   Returns the canonical string result, or null when any step fails. */
function evaluateTokens(tokens) {
  const values = [];
  const ops = [];

  const reduceTop = () => {
    const op = ops.pop();
    if (op === OPEN) {
      ops.push(op);
      return false;
    }
    const right = values.pop();
    const left = values.pop();
    if (op === undefined || left === undefined || right === undefined) return false;
    const result = applyOp(op, left, right);
    if (result === null) return false;
    values.push(settle(result));
    return true;
  };

  for (const token of tokens) {
    if (token === OPEN) {
      ops.push(token);
      continue;
    }

    if (token === CLOSE) {
      while (ops.length > 0 && ops[ops.length - 1] !== OPEN) {
        if (!reduceTop()) return null;
      }
      if (ops.length === 0) return null; // a ")" with no matching "("
      ops.pop(); // drop the "("
      continue;
    }

    if (isOperator(token)) {
      while (ops.length > 0 && ops[ops.length - 1] !== OPEN) {
        const top = ops[ops.length - 1];
        const bindsTighter =
          token === RIGHT_ASSOCIATIVE
            ? PRECEDENCE[top] > PRECEDENCE[token]
            : PRECEDENCE[top] >= PRECEDENCE[token];
        if (!bindsTighter) break;
        if (!reduceTop()) return null;
      }
      ops.push(token);
      continue;
    }

    const value = toNumber(token);
    if (value === null) return null;
    values.push(value);
  }

  while (ops.length > 0) {
    if (ops[ops.length - 1] === OPEN) return null; // an unclosed "("
    if (!reduceTop()) return null;
  }

  return values.length === 1 ? normalize(values[0]) : null;
}

/** Renders a token list as the small expression line: "(2 + 3) × 4". */
function renderTokens(tokens) {
  return tokens
    .map((token) => {
      if (token === OPEN || token === CLOSE) return token;
      return isOperator(token) ? SYM[token] : formatValue(token);
    })
    .join(' ')
    .replace(/\(\s+/g, OPEN)
    .replace(/\s+\)/g, CLOSE);
}

/** Index of the last "(" that has not been closed yet, or -1. */
function lastUnmatchedOpen(tokens) {
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === CLOSE) depth++;
    else if (tokens[i] === OPEN) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return -1;
}

/** Index of the "(" that matches the ")" at closeIndex, or -1. */
function matchingOpen(tokens, closeIndex) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    if (tokens[i] === CLOSE) depth++;
    else if (tokens[i] === OPEN) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when the token list already holds a complete value (")" counts). */
function endsWithValue(tokens) {
  return tokens[tokens.length - 1] === CLOSE;
}

/** True when the next thing typed has to be a new operand. */
function expectingOperand() {
  if (state.tokens.length === 0) return state.waiting || state.value === '0';
  const last = state.tokens[state.tokens.length - 1];
  return isOperator(last) || last === OPEN;
}

/** Running total to show while the expression is still being typed. */
function previewValue(tokens) {
  const openIndex = lastUnmatchedOpen(tokens);
  const scoped = openIndex === -1 ? tokens : tokens.slice(openIndex + 1);
  const trimmed =
    scoped.length > 0 && isOperator(scoped[scoped.length - 1]) ? scoped.slice(0, -1) : scoped;
  if (trimmed.length === 0) return '0';
  return evaluateTokens(trimmed);
}

function digitCount(canonical) {
  return (canonical.match(/\d/g) || []).length;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  value: '0', // canonical string shown big
  tokens: [], // the live expression as typed: numbers and operator names
  waiting: false, // next digit starts a fresh operand
  expression: '', // what the small line shows
  error: false,
  last: { op: null, operand: null }, // for repeating "="
  // Derived so callers never dig into the token list by hand.
  get pendingOp() {
    const last = this.tokens[this.tokens.length - 1];
    return isOperator(last) ? last : null;
  },
};

const FRESH = { op: null, operand: null };

function resetNumbers() {
  state.value = '0';
  state.tokens = [];
  state.waiting = false;
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
  state.tokens = [];
  state.expression = '';
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
  // but pressing it after an operator — or inside an open group — continues
  // the current expression.
  if (state.tokens.length === 0 || endsWithValue(state.tokens)) {
    state.tokens = [];
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
  if (toNumber(state.value) === null) return;

  if (state.waiting && state.pendingOp !== null) {
    // Swap the operator without recalculating: "12 +" becomes "12 ×".
    state.tokens[state.tokens.length - 1] = op;
  } else {
    // A closed group already sits in the token list as a complete value.
    if (!endsWithValue(state.tokens)) state.tokens.push(state.value);
    state.tokens.push(op);
    // Show the running total of everything typed so far, without the operator
    // whose right operand is still being chosen.
    const preview = previewValue(state.tokens);
    if (preview === null) return showError();
    state.value = preview;
  }

  state.expression = renderTokens(state.tokens);
  state.waiting = true;
  state.last = FRESH;
  render();
}

/** Commits a finished calculation: display, history entry and repeat state. */
function commit(canonical, exprText, op, operand) {
  state.value = canonical;
  state.tokens = [];
  state.expression = `${exprText} =`;
  state.waiting = true;
  state.error = false;
  state.last = op === null ? FRESH : { op, operand };
  addHistory(exprText, canonical);
  render();
}

function equals() {
  if (state.error) return clearAll();

  if (state.tokens.length === 0) {
    // Nothing pending: repeat the previous operation, or do nothing at all.
    if (state.last.op === null) return;
    const left = toNumber(state.value);
    if (left === null) return;
    const { op, operand } = state.last;
    const result = applyOp(op, left, operand);
    if (result === null) return showError();
    return commit(normalize(result), `${formatValue(state.value)} ${SYM[op]} ${fmt(operand)}`, op, operand);
  }

  const tokens = endsWithValue(state.tokens) ? state.tokens.slice() : state.tokens.concat(state.value);
  // Auto-close whatever the user left open: "(2 + 3" evaluates like "(2 + 3)".
  while (lastUnmatchedOpen(tokens) !== -1) tokens.push(CLOSE);

  const exprText = renderTokens(tokens);
  const op = state.pendingOp;
  const operand = toNumber(state.value);
  const result = evaluateTokens(tokens);
  if (result === null) return showError();
  commit(result, exprText, op, operand);
}

/** Opens a group, as in "(2 + 3". Only valid where a new operand is expected. */
function openGroup() {
  if (state.error) return clearAll();
  if (!expectingOperand()) return; // no implicit multiplication: "5(" is ignored

  state.tokens.push(OPEN);
  state.value = '0';
  state.waiting = true;
  state.expression = renderTokens(state.tokens);
  state.last = FRESH;
  render();
}

/** Closes the innermost open group and shows its result. */
function closeGroup() {
  if (state.error) return clearAll();
  if (lastUnmatchedOpen(state.tokens) === -1) return; // nothing to close
  // "()" or "(2 +)" still has no operand to close over.
  if (state.waiting && !endsWithValue(state.tokens)) return;

  if (!endsWithValue(state.tokens)) state.tokens.push(state.value);
  state.tokens.push(CLOSE);

  const closeIndex = state.tokens.length - 1;
  const openIndex = matchingOpen(state.tokens, closeIndex);
  const groupValue = evaluateTokens(state.tokens.slice(openIndex + 1, closeIndex));
  if (groupValue === null) return showError();

  state.value = groupValue;
  state.waiting = true;
  state.last = FRESH;
  state.expression = renderTokens(state.tokens);
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

/** The number sitting immediately left of the pending operator, or null. */
function leftOperandOf(op) {
  if (op === null) return null;
  for (let i = state.tokens.length - 2; i >= 0; i--) {
    const token = state.tokens[i];
    if (token === OPEN) return null; // the group has no operand yet
    if (token === CLOSE) {
      const open = matchingOpen(state.tokens, i);
      if (open === -1) return null;
      return toNumber(evaluateTokens(state.tokens.slice(open, i + 1)));
    }
    if (!isOperator(token)) return toNumber(token);
  }
  return null;
}

function percent() {
  if (state.error) return clearAll();
  const value = toNumber(state.value);
  if (value === null) return;

  // "200 + 10%" -> 200 + 20; anywhere else "%" simply means /100.
  const op = state.pendingOp;
  const base = leftOperandOf(op);
  const relative = (op === 'add' || op === 'subtract') && base !== null && !state.waiting;

  const next = relative ? (base * value) / 100 : value / 100;
  state.value = normalize(next);
  state.waiting = false;
  render();
}

/** Square root of the value on display: immediate, like "%" and "+/-". */
function squareRoot() {
  if (state.error) return clearAll();
  const value = toNumber(state.value);
  if (value === null) return;
  if (value < 0) return showError();

  state.value = normalize(Math.sqrt(value));
  state.waiting = false;
  render();
}

function restoreResult(canonical) {
  state.value = canonical;
  state.tokens = [];
  state.waiting = true;
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
    case 'sqrt':
      squareRoot();
      break;
    case 'paren-open':
      openGroup();
      break;
    case 'paren-close':
      closeGroup();
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
    case '^':
      return '[data-operator="power"]';
    case 'r':
    case 'R':
      return '[data-action="sqrt"]';
    case '(':
      return '[data-action="paren-open"]';
    case ')':
      return '[data-action="paren-close"]';
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

  const btn = document.querySelector(`.calculator ${selector}`);
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

  const calculator = document.querySelector('.calculator');
  calculator.addEventListener('click', (event) => {
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
