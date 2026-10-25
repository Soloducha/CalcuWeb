/* End-to-end test: drives the real page in headless Chrome/Edge.
   Skips cleanly when no browser is installed.
   Scratch lives outside the worktree in os.tmpdir() and is always removed. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const browser = BROWSERS.find((p) => existsSync(p));
const skip = browser ? false : 'no Chrome/Edge found (set CHROME_PATH to enable)';

/* Reports what the DOM actually says, as JSON in the document title. */
const PROBE = `
<script>
window.__errs = [];
window.addEventListener('error', function (e) { window.__errs.push(String(e.message || e)); });
window.addEventListener('unhandledrejection', function (e) { window.__errs.push('rejection: ' + e.reason); });
window.addEventListener('DOMContentLoaded', function () {
  var out = { errors: window.__errs };
  function v() { return document.getElementById('display-value').textContent; }
  function x() { return document.getElementById('expression').textContent; }
  function click(sel) {
    var el = document.querySelector(sel);
    if (!el) { out.missing = (out.missing || []).concat(sel); return; }
    el.click();
  }
  function key(k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }

  click('[data-digit="1"]'); click('[data-digit="2"]');
  click('[data-operator="add"]');
  click('[data-digit="3"]'); click('[data-action="equals"]');
  out.mouse12plus3 = v() + ' | ' + x();

  var first = document.querySelector('.history__item');
  out.historyCount = document.querySelectorAll('.history__item').length;
  out.historyLabel = first ? first.getAttribute('aria-label') : null;
  out.historyIsButton = first ? first.tagName === 'BUTTON' : false;
  out.clearEnabled = !document.getElementById('clear-history').disabled;

  click('[data-digit="7"]');
  key('9');
  out.afterMouse7ThenKey9 = v();

  key('Escape');
  out.afterEscape = v();

  key('5'); key('+'); key('6'); key('Enter');
  out.keyboard5plus6 = v() + ' | ' + x();
  out.historyCount2 = document.querySelectorAll('.history__item').length;
  out.emptyStateGone = !document.querySelector('.history__empty');

  var again = document.querySelector('.history__item');
  if (again) again.click();
  out.afterHistoryClick = v();
  key('/');  out.slashMapsToDivide = x();
  key('+');  out.plusSwapsOperator = x();

  var keypad = document.getElementById('keypad');
  out.keypadButtonCount = keypad.querySelectorAll('button').length;
  out.allKeysAreButtons = keypad.querySelectorAll('button').length ===
    keypad.querySelectorAll(':scope > *').length;
  out.focusableKeys = keypad.querySelectorAll('button:not([disabled]):not([tabindex="-1"])').length;
  out.displayTag = document.getElementById('display-value').tagName;
  out.logRole = document.getElementById('history-log').getAttribute('role');
  out.logIsReadOnly = !document.querySelector('#history-log input, #history-log textarea');
  out.editableFields = document.querySelectorAll('input, textarea, [contenteditable="true"]').length;

  out.stackedColumns = getComputedStyle(document.querySelector('.layout'))
    .gridTemplateColumns.trim().split(/\\s+/).length;
  out.noHorizontalOverflow =
    document.documentElement.scrollWidth === document.documentElement.clientWidth;

  out.errors = window.__errs;
  document.title = JSON.stringify(out);
});
</script>
`;

function drive() {
  const scratch = join(tmpdir(), 'calc-browser-test');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  try {
    for (const f of ['styles.css', 'app.js']) copyFileSync(join(ROOT, f), join(scratch, f));
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace('</body>', PROBE + '\n  </body>');
    writeFileSync(join(scratch, 'index.html'), html);

    let dom = '';
    try {
      dom = execFileSync(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${join(scratch, 'profile')}`,
          '--virtual-time-budget=3000',
          '--dump-dom',
          `file:///${scratch.replace(/\\/g, '/')}/index.html`,
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      dom = String(err.stdout || '');
      if (!dom) throw err;
    }

    const m = dom.match(/<title>([\s\S]*?)<\/title>/);
    assert.ok(m, 'the probe did not report back through document.title');
    return JSON.parse(
      m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* Lazy so a missing browser skips the run instead of failing at collection. */
let cached = null;
function report() {
  if (!cached) cached = drive();
  return cached;
}

describe('real page in headless Chrome', { skip }, () => {
  test('never throws while being driven', () => {
    const r = report();
    assert.deepEqual(r.errors, []);
    assert.equal(r.missing, undefined, 'every selector the probe used must resolve');
  });

  test('mouse input computes and records', () => {
    const r = report();
    assert.equal(r.mouse12plus3, '15 | 12 + 3 =');
    assert.equal(r.historyCount, 1);
    assert.equal(r.historyLabel, '12 + 3 = 15');
    assert.equal(r.clearEnabled, true);
  });

  test('physical keyboard input computes', () => {
    const r = report();
    assert.equal(r.afterMouse7ThenKey9, '79');
    assert.equal(r.afterEscape, '0');
    assert.equal(r.keyboard5plus6, '11 | 5 + 6 =');
  });

  test('the log grows, drops its empty state, and recalls a result', () => {
    const r = report();
    assert.equal(r.historyCount2, 2);
    assert.equal(r.emptyStateGone, true);
    assert.equal(r.afterHistoryClick, '11');
  });

  test('keyboard operators map to the right symbols', () => {
    const r = report();
    assert.equal(r.slashMapsToDivide, '11 \u00f7');
    assert.equal(r.plusSwapsOperator, '11 +');
  });

  test('the keypad is 20 real, focusable buttons', () => {
    const r = report();
    assert.equal(r.keypadButtonCount, 20);
    assert.equal(r.allKeysAreButtons, true);
    assert.equal(r.focusableKeys, 20);
  });

  test('the log is a read-only live region, not a field', () => {
    const r = report();
    assert.equal(r.displayTag, 'OUTPUT');
    assert.equal(r.logRole, 'log');
    assert.equal(r.logIsReadOnly, true);
    assert.equal(r.editableFields, 0);
  });

  test('layout stacks and does not overflow at the tested width', () => {
    const r = report();
    // Chrome's minimum window width is ~534 CSS px, which is already below
    // the 780px container breakpoint, so exactly one column is expected.
    assert.equal(r.stackedColumns, 1);
    assert.equal(r.noHorizontalOverflow, true);
  });
});
