/* Unit + markup-contract tests for the calculator.
   Runs with the Node built-in test runner:  node --test
   No dependencies, no build step. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_SRC = readFileSync(join(ROOT, 'app.js'), 'utf8');
const HTML_SRC = readFileSync(join(ROOT, 'index.html'), 'utf8');
const CSS_SRC = readFileSync(join(ROOT, 'styles.css'), 'utf8');

/* app.js is a classic script (it must run from file://, where ES modules are
   blocked by CORS), so it exports nothing. We evaluate it inside an isolated
   vm context with a pinned browser locale and hand the harness a handle to its
   internals. `document` stays undefined so the script's self-init is skipped. */
const EXPOSE = `
;globalThis.__calc = {
  state, MAX_HISTORY, pageLocale, SEPARATORS,
  formatValue, normalize, applyOp, toNumber, digitCount,
  inputDigit, inputDecimal, inputOperator, equals, clearAll, backspace,
  negate, percent, squareRoot, restoreResult, addHistory, clearHistory, keyToSelector,
  evaluateTokens, PRECEDENCE,
  getHistory: () => calcHistory,
};
`;

function load(locale) {
  const sandbox = {
    navigator: { language: locale, languages: [locale] },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + EXPOSE, sandbox, { filename: 'app.js' });
  return sandbox.__calc;
}

/** Drives the calculator the way a human does: one character at a time. */
function type(calc, sequence) {
  for (const ch of sequence) {
    if (ch >= '0' && ch <= '9') calc.inputDigit(ch);
    else if (ch === '.') calc.inputDecimal();
    else if (ch === '+') calc.inputOperator('add');
    else if (ch === '-') calc.inputOperator('subtract');
    else if (ch === '*') calc.inputOperator('multiply');
    else if (ch === '/') calc.inputOperator('divide');
    else if (ch === '^') calc.inputOperator('power');
    else if (ch === 'r') calc.squareRoot();
    else if (ch === '=') calc.equals();
    else if (ch === 'C') calc.clearAll();
    else if (ch === '<') calc.backspace();
    else if (ch === '%') calc.percent();
    else throw new Error(`unmapped sequence character: ${JSON.stringify(ch)}`);
  }
}

const calc = load('en-US');
const fresh = () => {
  calc.clearAll();
  calc.clearHistory();
};

/* ------------------------------------------------------------------ */
/* Locale-aware rendering                                              */
/* ------------------------------------------------------------------ */

describe('locale rendering', () => {
  test('pins the browser locale instead of hard-coding one', () => {
    assert.equal(calc.pageLocale, 'en-US');
    // Compare field by field: SEPARATORS was created inside the vm realm, so a
    // deepStrictEqual against a host-realm object fails on prototype identity.
    assert.equal(calc.SEPARATORS.group, ',');
    assert.equal(calc.SEPARATORS.decimal, '.');
  });

  test('groups thousands and swaps the decimal separator per locale', () => {
    assert.equal(calc.formatValue('1234567.89'), '1,234,567.89');
    assert.equal(load('es-AR').formatValue('1234567.89'), '1.234.567,89');
    assert.equal(load('de-DE').formatValue('1234567.89'), '1.234.567,89');
    assert.equal(load('es-AR').formatValue('-1234.5'), '-1.234,5');
  });

  test('groups correctly when the separator is non-ASCII whitespace', () => {
    // fr-FR groups with U+202F NARROW NO-BREAK SPACE (or U+00A0 on older ICU);
    // deriving it keeps the assertion honest across ICU versions.
    const fr = load('fr-FR');
    const parts = new Intl.NumberFormat('fr-FR').formatToParts(1234567.89);
    const group = parts.find((p) => p.type === 'group').value;
    const decimal = parts.find((p) => p.type === 'decimal').value;
    assert.notEqual(group, ',', 'sanity: fr-FR must not use the en-US group separator');
    assert.equal(fr.formatValue('1234567.89'), `1${group}234${group}567${decimal}89`);
  });

  test('keeps a trailing decimal separator so mid-typing states are editable', () => {
    assert.equal(calc.formatValue('12.'), '12.');
    assert.equal(load('es-AR').formatValue('12.'), '12,');
  });

  test('leaves values below 1000 and empty values alone', () => {
    assert.equal(calc.formatValue('999'), '999');
    assert.equal(calc.formatValue(''), '0');
    assert.equal(calc.formatValue(null), '0');
  });

  test('shows exponential results verbatim instead of mangling them', () => {
    assert.equal(calc.formatValue('1e+21'), '1e+21');
  });
});

/* ------------------------------------------------------------------ */
/* Arithmetic                                                          */
/* ------------------------------------------------------------------ */

describe('arithmetic', () => {
  test('adds, subtracts, multiplies and divides', () => {
    fresh();
    type(calc, '2+3=');
    assert.equal(calc.state.value, '5');
    fresh();
    type(calc, '7-9=');
    assert.equal(calc.state.value, '-2');
    fresh();
    type(calc, '10*10=');
    assert.equal(calc.state.value, '100');
    fresh();
    type(calc, '84/2=');
    assert.equal(calc.state.value, '42');
  });

  test('never leaks float noise into a result', () => {
    fresh();
    type(calc, '0.1+0.2=');
    assert.equal(calc.state.value, '0.3');
  });

  test('bounds precision at 12 significant digits', () => {
    fresh();
    type(calc, '1/3=');
    assert.equal(calc.state.value, '0.333333333333');
  });

  test('divides by zero into an explicit error, not a number', () => {
    fresh();
    type(calc, '1/0=');
    assert.equal(calc.state.value, 'Error');
    assert.equal(calc.state.error, true);
    assert.equal(calc.getHistory().length, 0, 'a failed calculation must not be logged');
  });

  test('evaluate helpers refuse to fabricate a value', () => {
    assert.equal(calc.applyOp('divide', 5, 0), null);
    assert.equal(calc.normalize(Infinity), '0');
    assert.equal(calc.toNumber('Error'), null);
  });
});

/* ------------------------------------------------------------------ */
/* Operators and chaining                                              */
/* ------------------------------------------------------------------ */

describe('operators and chaining', () => {
  test('gives multiplication and division priority over addition', () => {
    fresh();
    type(calc, '2+3*4=');
    assert.equal(calc.state.value, '14', '3 * 4 must happen before the +');
    assert.equal(calc.getHistory()[0].expr, '2 + 3 \u00d7 4');
    fresh();
    type(calc, '2*3+4=');
    assert.equal(calc.state.value, '10');
    fresh();
    type(calc, '10-6/3=');
    assert.equal(calc.state.value, '8');
    fresh();
    type(calc, '1+2*3+4*5=');
    assert.equal(calc.state.value, '27', '1 + 6 + 20');
    fresh();
    type(calc, '100-6/3*2=');
    assert.equal(calc.state.value, '96', '6 / 3 * 2 binds before the -');
  });

  test('keeps same-precedence operators left-associative', () => {
    fresh();
    type(calc, '2-3-4=');
    assert.equal(calc.state.value, '-5', '(2 - 3) - 4');
    fresh();
    type(calc, '100/10/2=');
    assert.equal(calc.state.value, '5', '(100 / 10) / 2');
  });

  test('keeps accumulating across several operators', () => {
    fresh();
    type(calc, '100-30-20=');
    assert.equal(calc.state.value, '50');
  });

  test('evaluates the left operand as soon as a second operator arrives', () => {
    fresh();
    type(calc, '2+3+');
    assert.equal(calc.state.value, '5');
    assert.equal(calc.state.expression, '2 + 3 +');
  });

  test('swaps a pending operator without recalculating', () => {
    fresh();
    type(calc, '12+*');
    assert.equal(calc.state.value, '12');
    assert.equal(calc.state.pendingOp, 'multiply');
    assert.equal(calc.state.expression, '12 \u00d7');
  });

  test('accepts an operator as the very first key', () => {
    fresh();
    type(calc, '+5=');
    assert.equal(calc.state.value, '5');
  });

  test('ignores "=" when there is nothing to evaluate', () => {
    fresh();
    type(calc, '9=');
    assert.equal(calc.state.value, '9');
    assert.equal(calc.getHistory().length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Power and root                                                      */
/* ------------------------------------------------------------------ */

describe('power', () => {
  test('raises a number to a power and logs the expression', () => {
    fresh();
    type(calc, '2^10=');
    assert.equal(calc.state.value, '1024');
    assert.equal(calc.getHistory()[0].expr, '2 ^ 10');
  });

  test('binds tighter than multiplication and addition', () => {
    fresh();
    type(calc, '2+3^2=');
    assert.equal(calc.state.value, '11', '3 ^ 2 must resolve before the +');
    fresh();
    type(calc, '2*3^2=');
    assert.equal(calc.state.value, '18');
    fresh();
    type(calc, '3^2+1=');
    assert.equal(calc.state.value, '10');
  });

  test('is right-associative: 2^3^2 means 2^(3^2)', () => {
    fresh();
    type(calc, '2^3^2=');
    assert.equal(calc.state.value, '512');
  });

  test('accepts a fractional exponent', () => {
    fresh();
    type(calc, '9^0.5=');
    assert.equal(calc.state.value, '3');
  });

  test('refuses results that are not finite numbers', () => {
    fresh();
    type(calc, '0^1');
    calc.negate(); // 0^-1 is Infinity
    calc.equals();
    assert.equal(calc.state.value, 'Error');
    assert.equal(calc.state.error, true);
    assert.equal(calc.getHistory().length, 0, 'a failed calculation must not be logged');

    fresh();
    type(calc, '2');
    calc.negate(); // (-2)^0.5 is NaN
    type(calc, '^0.5=');
    assert.equal(calc.state.value, 'Error');
  });
});

describe('square root', () => {
  test('takes the root of the current value immediately', () => {
    fresh();
    type(calc, '81r');
    assert.equal(calc.state.value, '9');
    fresh();
    type(calc, '2r');
    assert.equal(calc.state.value, '1.41421356237');
  });

  test('participates in a chain like any other operand', () => {
    fresh();
    type(calc, '81r+9=');
    assert.equal(calc.state.value, '18');
    fresh();
    type(calc, '9+16r=');
    assert.equal(calc.state.value, '13');
  });

  test('is an explicit error for negative numbers', () => {
    fresh();
    type(calc, '9');
    calc.negate();
    calc.squareRoot();
    assert.equal(calc.state.value, 'Error');
    assert.equal(calc.state.error, true);
  });

  test('clears a previous error instead of stacking on it', () => {
    fresh();
    type(calc, '1/0=');
    calc.squareRoot();
    assert.equal(calc.state.error, false);
    assert.equal(calc.state.value, '0');
  });
});

/* ------------------------------------------------------------------ */
/* Percentage                                                          */
/* ------------------------------------------------------------------ */

describe('percentage', () => {
  test('is relative to the accumulator after + or -', () => {
    fresh();
    type(calc, '200+10%');
    assert.equal(calc.state.value, '20');
  });

  test('resolves to a correct total through "="', () => {
    fresh();
    type(calc, '100+10%=');
    assert.equal(calc.state.value, '110');
  });

  test('divides by 100 on its own', () => {
    fresh();
    type(calc, '50%');
    assert.equal(calc.state.value, '0.5');
  });

  test('divides by 100 after a multiplicative operator', () => {
    fresh();
    type(calc, '8*50%');
    assert.equal(calc.state.value, '0.5');
  });

  test('is a plain /100 immediately after a result', () => {
    fresh();
    type(calc, '5+3=');
    calc.percent();
    assert.equal(calc.state.value, '0.08');
  });

  test('is harmless as the very first key', () => {
    fresh();
    calc.percent();
    assert.equal(calc.state.value, '0');
    assert.equal(calc.state.error, false);
  });

  test('feeds a chain correctly', () => {
    fresh();
    type(calc, '200+10%*2=');
    // Precedence now binds "10% * 2" to the multiplication: 200 + 20 * 2.
    assert.equal(calc.state.value, '240');
  });

  test('binds a percent to the operand immediately before it', () => {
    fresh();
    type(calc, '100+20*5+10%=');
    // 10% applies to the 5, so: 100 + 20 * 5 + 0.5.
    assert.equal(calc.state.value, '200.5');
  });
});

/* ------------------------------------------------------------------ */
/* Repeat equals                                                       */
/* ------------------------------------------------------------------ */

describe('repeating "="', () => {
  test('re-applies the last operation', () => {
    fresh();
    type(calc, '5+3=');
    assert.equal(calc.state.value, '8');
    calc.equals();
    assert.equal(calc.state.value, '11');
    calc.equals();
    assert.equal(calc.state.value, '14');
  });

  test('typing a digit after "=" breaks the chain', () => {
    fresh();
    type(calc, '5+3=');
    type(calc, '7');
    calc.equals();
    assert.equal(calc.state.value, '7');
    assert.equal(calc.state.last.op, null);
  });
});

/* ------------------------------------------------------------------ */
/* Editing rules                                                       */
/* ------------------------------------------------------------------ */

describe('editing', () => {
  test('backspace removes one digit at a time', () => {
    fresh();
    type(calc, '123<');
    assert.equal(calc.state.value, '12');
  });

  test('backspace clamps at zero instead of going empty', () => {
    fresh();
    type(calc, '<<<');
    assert.equal(calc.state.value, '0');
  });

  test('backspace will not shred a committed result', () => {
    fresh();
    type(calc, '5+3=');
    calc.backspace();
    assert.equal(calc.state.value, '8');
  });

  test('toggles the sign in both directions and skips zero', () => {
    fresh();
    type(calc, '5');
    calc.negate();
    assert.equal(calc.state.value, '-5');
    calc.negate();
    assert.equal(calc.state.value, '5');
    fresh();
    calc.negate();
    assert.equal(calc.state.value, '0');
  });

  test('caps input at 15 digits', () => {
    fresh();
    type(calc, '1234567890123456');
    assert.equal(calc.state.value, '123456789012345');
    assert.equal(calc.digitCount(calc.state.value), 15);
  });

  test('inserts a decimal point only once', () => {
    fresh();
    type(calc, '1.2.3');
    assert.equal(calc.state.value, '1.23');
  });

  test('clearing resets the arithmetic but keeps the log', () => {
    fresh();
    type(calc, '9*9=');
    assert.equal(calc.getHistory().length, 1);
    calc.clearAll();
    assert.equal(calc.state.value, '0');
    assert.equal(calc.state.pendingOp, null);
    assert.equal(calc.getHistory().length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Error recovery                                                      */
/* ------------------------------------------------------------------ */

describe('error recovery', () => {
  test('an operator pressed in the error state is ignored', () => {
    fresh();
    type(calc, '1/0+');
    assert.equal(calc.state.error, true);
    assert.equal(calc.state.value, 'Error');
  });

  test('"C" and "=" both clear the error state', () => {
    fresh();
    type(calc, '1/0=');
    calc.clearAll();
    assert.equal(calc.state.error, false);
    assert.equal(calc.state.value, '0');

    type(calc, '1/0=');
    calc.equals();
    assert.equal(calc.state.error, false);
    assert.equal(calc.state.value, '0');
  });
});

/* ------------------------------------------------------------------ */
/* History log                                                         */
/* ------------------------------------------------------------------ */

describe('history log', () => {
  test('records completed calculations newest first', () => {
    fresh();
    type(calc, '2+2=');
    type(calc, '3+3=');
    // Spread into a host-realm literal: .map() on a vm array returns a vm
    // array, which strict deep comparison rejects on prototype identity.
    assert.deepEqual([...calc.getHistory().map((e) => e.result)], ['6', '4']);
    assert.equal(calc.getHistory()[0].expr, '3 + 3');
  });

  test('does not record anything until a calculation completes', () => {
    fresh();
    type(calc, '5+');
    assert.equal(calc.getHistory().length, 0);
    type(calc, '5=');
    assert.equal(calc.getHistory().length, 1);
  });

  test('is capped so it cannot grow without bound', () => {
    fresh();
    for (let i = 0; i < calc.MAX_HISTORY + 5; i++) calc.addHistory(`${i} + 0`, String(i));
    assert.equal(calc.getHistory().length, calc.MAX_HISTORY);
  });

  test('recalling a result restores a clean, editable state', () => {
    fresh();
    type(calc, '9*9=');
    calc.restoreResult('42');
    assert.equal(calc.state.value, '42');
    assert.equal(calc.state.pendingOp, null);
    assert.equal(calc.state.expression, '');
    type(calc, '+1=');
    assert.equal(calc.state.value, '43');
  });

  test('clearing the log empties it without touching the display', () => {
    fresh();
    type(calc, '7*7=');
    assert.equal(calc.getHistory().length, 1);
    calc.clearHistory();
    assert.equal(calc.getHistory().length, 0);
    assert.equal(calc.state.value, '49');
  });
});

/* ------------------------------------------------------------------ */
/* Keyboard mapping                                                    */
/* ------------------------------------------------------------------ */

describe('keyboard mapping', () => {
  test('maps every key the calculator advertises', () => {
    assert.equal(calc.keyToSelector('7'), '[data-digit="7"]');
    assert.equal(calc.keyToSelector('Enter'), '[data-action="equals"]');
    assert.equal(calc.keyToSelector('='), '[data-action="equals"]');
    assert.equal(calc.keyToSelector('Escape'), '[data-action="clear"]');
    assert.equal(calc.keyToSelector('Backspace'), '[data-action="backspace"]');
    assert.equal(calc.keyToSelector('%'), '[data-action="percent"]');
    assert.equal(calc.keyToSelector(','), '[data-action="decimal"]');
    assert.equal(calc.keyToSelector('.'), '[data-action="decimal"]');
    assert.equal(calc.keyToSelector('+'), '[data-operator="add"]');
    assert.equal(calc.keyToSelector('-'), '[data-operator="subtract"]');
    assert.equal(calc.keyToSelector('*'), '[data-operator="multiply"]');
    assert.equal(calc.keyToSelector('/'), '[data-operator="divide"]');
    assert.equal(calc.keyToSelector('^'), '[data-operator="power"]');
    assert.equal(calc.keyToSelector('r'), '[data-action="sqrt"]');
  });

  test('ignores unmapped keys and modifier combinations', () => {
    assert.equal(calc.keyToSelector('q'), null);
    assert.equal(calc.keyToSelector('Control'), null);
    assert.equal(calc.keyToSelector('F5'), null);
  });
});

/* ------------------------------------------------------------------ */
/* Markup contract                                                     */
/* ------------------------------------------------------------------ */

describe('markup contract', () => {
  test('exposes every id app.js reads', () => {
    for (const id of ['expression', 'display-value', 'history-log', 'clear-history', 'keypad']) {
      assert.match(HTML_SRC, new RegExp(`id="${id}"`), `missing #${id}`);
    }
  });

  test('ships a complete keypad', () => {
    for (const d of '0123456789') {
      assert.ok(HTML_SRC.includes(`data-digit="${d}"`), `missing digit ${d}`);
    }
    for (const op of ['add', 'subtract', 'multiply', 'divide', 'power']) {
      assert.ok(HTML_SRC.includes(`data-operator="${op}"`), `missing operator ${op}`);
    }
    for (const action of ['clear', 'backspace', 'percent', 'decimal', 'negate', 'equals', 'sqrt']) {
      assert.ok(HTML_SRC.includes(`data-action="${action}"`), `missing action ${action}`);
    }
  });

  test('loads app.js as a classic deferred script, never as an ES module', () => {
    // type="module" is blocked by CORS on file:// and would break double-click.
    assert.ok(HTML_SRC.includes('src="app.js" defer'), 'expected a deferred classic script');
    assert.ok(!HTML_SRC.includes('type="module"'), 'ES modules must not be used');
  });

  test('links the stylesheet and declares the document basics', () => {
    assert.ok(HTML_SRC.includes('href="styles.css"'));
    assert.ok(HTML_SRC.includes('lang="es"'));
    assert.ok(HTML_SRC.includes('name="viewport"'));
    assert.ok(HTML_SRC.includes('<meta charset="utf-8"'));
  });

  test('marks the log as a live log region', () => {
    assert.ok(HTML_SRC.includes('role="log"'));
  });

  test('keeps the log read-only: no editable input anywhere', () => {
    assert.ok(!/<input\b/i.test(HTML_SRC), 'the log must not be an editable field');
    assert.ok(!/<textarea\b/i.test(HTML_SRC), 'the log must not be an editable field');
    assert.ok(!/<form\b/i.test(HTML_SRC), 'no form is needed');
  });

  test('uses a container query for the column breakpoint', () => {
    assert.match(CSS_SRC, /@container\s*\(/);
    assert.match(CSS_SRC, /container-type:\s*inline-size/);
    assert.ok(!/@media[^{]*max-width/.test(CSS_SRC), 'breakpoint should be container-driven');
  });
});
