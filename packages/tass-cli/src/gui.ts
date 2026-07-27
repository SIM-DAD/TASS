/**
 * tass gui — the human GUI: a zero-dependency local web app. One node:http server bound to
 * 127.0.0.1 serving a single embedded page; every action POSTs to /api/call, which invokes the
 * SAME tool adapters the MCP server exposes ({@link callTool}). Three drivers — CLI, MCP, GUI —
 * one code path. Nothing leaves the machine; nothing renders without the user starting it.
 *
 * Design language (the M4 desktop shell inherits these tokens; UI/UX pass 2026-07-26):
 *  - Instrument, not dashboard: paper surface, one accent (TASS green), hairline borders,
 *    tabular numerals, no gradients, no emoji iconography, no decorative filler.
 *  - Accessibility as construction: WCAG-checked token pairs (body 17.1:1, secondary 7.3:1,
 *    accent text 6.4:1, primary button 6.7:1; dark mode validated separately), real tab
 *    semantics with arrow-key navigation, labels on every field, fieldsets for groups,
 *    aria-live result regions, role=alert errors, skip link, visible focus, color never the
 *    only signal (license classes carry text badges). axe-core WCAG 2.2 AA pass 2026-07-27:
 *    wordmark promoted to the page h1 and the tablist wrapped in a <nav> landmark so every
 *    element sits inside a landmark (axe page-has-heading-one + region).
 *  - System font stack only (obligation-free: no bundled webfonts).
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { callTool, toolList } from './mcp';
import { VERSION } from './cli';
import type { Io } from './cli';
import { HELP_TOPICS } from './help-topics';

const escHtml = (s: string): string =>
    s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/**
 * The Help panel: the SAME topic table the CLI prints (`tass help <topic>`) and the desktop
 * workbench renders, server-rendered as accessible disclosure widgets. Indented lines in a
 * topic body are command examples and render as <pre>.
 */
/**
 * P1-15: the GUI-first path, prepended to the getting-started topic in THIS surface only
 * (the shared CLI topic text in help-topics.ts is untouched; it follows under its own heading).
 */
const GUI_GETTING_STARTED = `<h3 class="help-sub">In this app</h3>
<ol class="help-steps">
<li>Open the <strong>Score a file</strong> tab and paste the absolute path of your CSV (one row per document) into Input file.</li>
<li>Check the text column (once the path is valid, the field offers the CSV's own columns) and tick the lexicons to score with.</li>
<li>Press <strong>Score</strong>. The output field can stay blank: TASS writes the scored CSV next to your input and shows a preview plus download links.</li>
<li>Use the <strong>Concordance</strong> and <strong>Exemplars</strong> tabs on the same file to trace any number back to the exact words behind it.</li>
</ol>
<h3 class="help-sub">From the terminal</h3>`;

const HELP_HTML = HELP_TOPICS.map(t => {
    const blocks = t.body.split('\n\n').map(p =>
        p.split('\n').every(l => l === '' || l.startsWith('    '))
            ? `<pre class="log">${escHtml(p.replace(/^ {4}/gm, ''))}</pre>`
            : `<p>${escHtml(p)}</p>`
    ).join('\n');
    const guiFirst = t.id === 'getting-started' ? GUI_GETTING_STARTED : '';
    return `<details class="help-topic" id="help-${t.id}">
<summary><strong>${escHtml(t.title)}</strong> <span class="note">${escHtml(t.summary)}</span></summary>
<div class="help-body">${guiFirst}${blocks}</div>
</details>`;
}).join('\n');

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TASS ${VERSION}: local analysis instrument</title>
<style>
 :root {
  color-scheme: light dark;
  --paper: #FDFDFC; --surface: #F6F5F2; --ink: #1A1A1A; --muted: #555555;
  --accent: #009E73; --accent-text: #006B4F; --btn: #00694B; --btn-ink: #FFFFFF;
  --border: #E8E5E0; --border-strong: #C9C5BE;
  --warn-surface: #FBF6E9; --warn-border: #B98A00; --warn-ink: #6B5000;
  --err-surface: #FBEFEE; --err-border: #B3352C; --err-ink: #8A2620;
 }
 @media (prefers-color-scheme: dark) {
  :root {
   --paper: #161615; --surface: #1E1E1D; --ink: #EDEDEB; --muted: #9E9E9A;
   --accent: #2FBF92; --accent-text: #3ECF9C; --btn: #3ECF9C; --btn-ink: #001F14;
   --border: #2E2E2C; --border-strong: #4A4A47;
   --warn-surface: #2A2416; --warn-border: #C99B22; --warn-ink: #E4C36A;
   --err-surface: #2B1B19; --err-border: #D06158; --err-ink: #ECA49E;
  }
 }
 * { box-sizing: border-box; }
 body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.55 system-ui, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
 }
 .skip { position: absolute; left: -9999px; top: 0; background: var(--btn); color: var(--btn-ink); padding: .5rem .9rem; z-index: 10; }
 .skip:focus { left: .5rem; top: .5rem; }
 .shell { max-width: 980px; margin: 0 auto; padding: 0 1.25rem 4rem; }

 header.top { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; padding: 1.4rem 0 1rem; border-bottom: 1px solid var(--border); }
 .mark { width: .7em; height: .7em; background: var(--accent); display: inline-block; transform: translateY(.02em); }
 .wordmark { font-size: 1.35rem; font-weight: 700; letter-spacing: .02em; margin: 0; }
 .wordmark small { font-weight: 400; color: var(--muted); font-size: .8rem; margin-left: .45rem; }
 .trust { margin-left: auto; color: var(--muted); font-size: .8rem; }

 nav [role=tablist] { display: flex; gap: .25rem; flex-wrap: wrap; padding: .8rem 0; border-bottom: 1px solid var(--border); }
 nav [role=tab] {
  appearance: none; font: inherit; font-size: .9rem; cursor: pointer;
  background: transparent; color: var(--muted);
  border: 1px solid transparent; border-radius: 4px; padding: .4rem .85rem;
 }
 nav [role=tab]:hover { color: var(--ink); border-color: var(--border); }
 nav [role=tab][aria-selected=true] { color: var(--accent-text); border-color: var(--border-strong); background: var(--surface); font-weight: 600; }
 :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

 main { padding-top: 1.4rem; }
 [role=tabpanel] { display: none; }
 [role=tabpanel].on { display: block; }
 .lede { color: var(--muted); font-size: .88rem; margin: 0 0 1.1rem; max-width: 60ch; }

 label { display: block; font-weight: 600; font-size: .84rem; margin: .9rem 0 .25rem; }
 .help { font-weight: 400; color: var(--muted); font-size: .78rem; margin-top: .2rem; }
 input[type=text], textarea, select {
  width: 100%; padding: .5rem .65rem; font: inherit; color: var(--ink);
  background: var(--paper); border: 1px solid var(--border-strong); border-radius: 4px;
 }
 textarea { min-height: 7.5rem; resize: vertical; }
 .path { font-family: ui-monospace, Consolas, monospace; font-size: .86rem; }
 .row { display: flex; gap: 1rem; flex-wrap: wrap; } .row > div { flex: 1 1 16rem; }

 fieldset { border: 1px solid var(--border); border-radius: 4px; padding: .6rem .9rem .8rem; margin: .9rem 0 0; }
 legend { font-weight: 600; font-size: .84rem; padding: 0 .35rem; }
 .pickall { margin-left: .6rem; font-weight: 400; }
 button.linkish {
  appearance: none; background: none; border: 0; padding: 0 .3rem; font: inherit; font-size: .78rem;
  color: var(--accent-text); text-decoration: underline; cursor: pointer;
 }
 .checks { display: flex; gap: .35rem 1.1rem; flex-wrap: wrap; }
 .checks label { display: inline-flex; gap: .4rem; align-items: center; font-weight: 400; font-size: .88rem; margin: .15rem 0; }
 .lexset { columns: 3 11rem; } .lexset label { display: block; font-weight: 400; font-size: .88rem; margin: .12rem 0; }
 input[type=checkbox] { accent-color: var(--btn); width: 1rem; height: 1rem; }

 button.go {
  margin-top: 1.15rem; padding: .55rem 1.5rem; font: inherit; font-weight: 600; cursor: pointer;
  background: var(--btn); color: var(--btn-ink); border: 0; border-radius: 4px;
 }
 button.go:hover { filter: brightness(1.08); }
 button.go[disabled] { opacity: .55; cursor: progress; }

 .result { margin-top: 1.4rem; }
 .note { color: var(--muted); font-size: .8rem; }
 table { border-collapse: collapse; width: 100%; margin-top: .8rem; font-size: .86rem; font-variant-numeric: tabular-nums; }
 caption { text-align: left; font-weight: 600; font-size: .84rem; padding-bottom: .35rem; }
 th, td { text-align: left; padding: .34rem .6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
 th { font-size: .78rem; color: var(--muted); font-weight: 600; }
 td.num, th.num { text-align: right; }
 .bar { display: inline-block; height: .55em; background: var(--accent); vertical-align: baseline; margin-right: .45rem; border-radius: 1px; }
 .matched { color: var(--muted); font-size: .8rem; }

 .card { border: 1px solid var(--border); border-radius: 4px; padding: .8rem 1rem; margin-top: .8rem; background: var(--surface); }
 .card h2 { margin: 0 0 .15rem; font-size: .95rem; }
 .badge { display: inline-block; font-size: .72rem; font-weight: 600; padding: .05rem .45rem; border: 1px solid var(--border-strong); border-radius: 3px; margin-left: .5rem; vertical-align: middle; }
 .badge.ok { color: var(--accent-text); border-color: var(--accent-text); }
 .badge.restricted { color: var(--warn-ink); border-color: var(--warn-border); background: var(--warn-surface); }
 .cite { color: var(--muted); font-size: .78rem; margin-top: .3rem; }

 .alert { border: 1px solid var(--err-border); background: var(--err-surface); color: var(--err-ink); border-radius: 4px; padding: .7rem .9rem; margin-top: 1rem; font-size: .88rem; white-space: pre-wrap; }
 .alert .hint { display: block; margin-top: .3rem; font-style: italic; }
 .alert details { margin-top: .45rem; white-space: normal; }
 .alert summary { cursor: pointer; font-size: .8rem; }
 .alert pre.log { color: var(--ink); margin: .35rem 0 0; }
 .catlist { font-family: ui-monospace, Consolas, monospace; font-size: .75rem; color: var(--muted); margin-top: .3rem; overflow-wrap: anywhere; }
 .scroll { overflow-x: auto; }
 .artifacts { list-style: none; padding: 0; margin: .9rem 0 0; }
 .artifacts li { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; padding: .3rem 0; border-bottom: 1px solid var(--border); font-size: .86rem; }
 button.mini { appearance: none; font: inherit; font-size: .78rem; cursor: pointer; background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong); border-radius: 4px; padding: .2rem .6rem; }
 button.mini:hover { color: var(--accent-text); border-color: var(--accent-text); }
 .actions { margin-top: .8rem; display: flex; gap: .6rem; flex-wrap: wrap; }
 .help-sub { font-size: .84rem; margin: .5rem 0 .2rem; }
 .help-steps { margin: .2rem 0 .9rem; padding-left: 1.25rem; }
 .help-steps li { margin: .18rem 0; }
 .callout { border-left: 3px solid var(--accent); padding: .1rem 0 .1rem .8rem; color: var(--muted); font-size: .84rem; margin-top: 1rem; }
 pre.log { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: .7rem .9rem; font-size: .8rem; overflow-x: auto; white-space: pre-wrap; }

 footer { margin-top: 3rem; border-top: 1px solid var(--border); padding-top: .8rem; color: var(--muted); font-size: .78rem; display: flex; gap: 1rem; flex-wrap: wrap; }
 @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to workspace</a>
<div class="shell">

<header class="top">
 <h1 class="wordmark"><span class="mark" aria-hidden="true"></span> TASS<small>Text Analysis for Social Scientists · ${VERSION}</small></h1>
 <span class="trust">Local instrument. Nothing leaves this machine.</span>
</header>

<nav aria-label="Workspace">
 <div role="tablist" aria-label="Workspace">
  <button role="tab" id="tab-analyze" aria-controls="analyze" aria-selected="true">Analyze text</button>
  <button role="tab" id="tab-score" aria-controls="score" aria-selected="false" tabindex="-1">Score a file</button>
  <button role="tab" id="tab-kwic" aria-controls="kwic" aria-selected="false" tabindex="-1">Concordance</button>
  <button role="tab" id="tab-exemplars" aria-controls="exemplars" aria-selected="false" tabindex="-1">Exemplars</button>
  <button role="tab" id="tab-dicts" aria-controls="dicts" aria-selected="false" tabindex="-1">Dictionaries</button>
  <button role="tab" id="tab-help" aria-controls="help" aria-selected="false" tabindex="-1">Help</button>
 </div>
</nav>

<main id="main">

<section id="analyze" role="tabpanel" aria-labelledby="tab-analyze" class="on" tabindex="-1">
 <p class="lede">Paste text and score it against the open dictionaries. Every number traces back to the exact words that produced it.</p>
 <label for="a-text">Text to analyze</label>
 <textarea id="a-text" placeholder="Paste or type text here."></textarea>
 <fieldset><legend>Lexicons</legend><div id="a-lex" class="lexset note">Loading the bundle…</div></fieldset>
 <div class="checks" style="margin-top:.7rem">
  <label><input type="checkbox" id="a-vr" checked> VADER-rules sentiment</label>
  <label><input type="checkbox" id="a-zero"> Include zero-hit categories</label>
 </div>
 <button class="go" id="a-go">Analyze</button>
 <div id="a-out" class="result" aria-live="polite"></div>
</section>

<section id="score" role="tabpanel" aria-labelledby="tab-score" tabindex="-1">
 <p class="lede">Score a CSV (one row per document) or a TXT file on this machine. Outputs are written next to the file, and every run writes a provenance manifest with input hashes and lexicon citations.</p>
 <div class="row">
  <div>
   <label for="s-in">Input file</label>
   <input type="text" id="s-in" class="path" placeholder="C:\\data\\turns.csv" autocomplete="off">
   <p class="help">Absolute path to a .csv (needs a text column) or .txt file.</p>
  </div>
  <div>
   <label for="s-out">Output CSV <span class="note">(optional)</span></label>
   <input type="text" id="s-out" class="path" placeholder="C:\\data\\turns-scored.csv" autocomplete="off">
   <p class="help">Leave blank to write beside the input; the manifest lands beside the output.</p>
   <p class="help" id="s-out-hint" hidden>Will write: <span id="s-out-derived" class="path"></span></p>
  </div>
 </div>
 <div class="row">
  <div>
   <label for="s-col">Text column</label>
   <input type="text" id="s-col" value="text" autocomplete="off">
   <p class="help">CSV only: the column holding each document's text.</p>
  </div>
  <div>
   <label for="s-group">Group columns <span class="note">(optional)</span></label>
   <input type="text" id="s-group" placeholder="speaker,session" autocomplete="off" list="s-groupcols">
   <datalist id="s-groupcols"></datalist>
   <p class="help">Comma-separated; adds a per-group summary CSV.</p>
  </div>
 </div>
 <fieldset><legend>Metrics</legend>
  <div class="checks">
   <label><input type="checkbox" class="s-metric" value="percent" checked> percent of tokens</label>
   <label><input type="checkbox" class="s-metric" value="hits"> raw hits</label>
   <label><input type="checkbox" class="s-metric" value="weighted"> weighted sum</label>
   <label><input type="checkbox" class="s-metric" value="mean"> mean weight</label>
   <label><input type="checkbox" id="s-vr"> VADER-rules columns</label>
  </div>
 </fieldset>
 <fieldset><legend>Lexicons</legend><div id="s-lex" class="lexset note">Loading the bundle…</div></fieldset>
 <button class="go" id="s-go">Score</button>
 <div id="s-out2" class="result" aria-live="polite"></div>
</section>

<section id="kwic" role="tabpanel" aria-labelledby="tab-kwic" tabindex="-1">
 <p class="lede">Keyword-in-context: every occurrence of a word (or a stem like <em>happi*</em>) with its surrounding text, so a count is never a black box.</p>
 <div class="row">
  <div><label for="k-in">Input file</label><input type="text" id="k-in" class="path" autocomplete="off"><p class="help">Absolute path (.csv or .txt).</p></div>
  <div><label for="k-col">Text column</label><input type="text" id="k-col" value="text" autocomplete="off"></div>
  <div><label for="k-q">Query</label><input type="text" id="k-q" placeholder="happi*" autocomplete="off"><p class="help">A word, or a stem wildcard ending in *.</p></div>
 </div>
 <button class="go" id="k-go">Find in context</button>
 <div id="k-out" class="result" aria-live="polite"></div>
</section>

<section id="exemplars" role="tabpanel" aria-labelledby="tab-exemplars" tabindex="-1">
 <p class="lede">Trace-back: the highest-scoring documents for one category, with the exact matched terms — the quotable evidence behind a score.</p>
 <div class="row">
  <div><label for="e-in">Input file</label><input type="text" id="e-in" class="path" autocomplete="off"></div>
  <div><label for="e-col">Text column</label><input type="text" id="e-col" value="text" autocomplete="off"></div>
 </div>
 <div class="row">
  <div><label for="e-lex">Lexicon</label><select id="e-lex"><option value="">Loading the bundle&hellip;</option></select><p class="help">The bundled dictionaries; details on the Dictionaries tab.</p></div>
  <div><label for="e-cat">Category</label><select id="e-cat"></select><p class="help">Repopulates from the chosen lexicon.</p></div>
  <div><label for="e-metric">Rank by</label><select id="e-metric">
   <option value="percent">percent of tokens</option>
   <option value="hits">raw hits</option>
   <option value="weighted">weighted sum</option>
   <option value="mean">mean (signed)</option>
  </select><p class="help">Signed lexicons (AFINN, VADER, labMT, SocialSent, Warriner VAD) default to signed mean.</p></div>
  <div><label for="e-top">Top N</label><input type="text" id="e-top" value="10" inputmode="numeric" autocomplete="off"></div>
 </div>
 <button class="go" id="e-go">Find exemplars</button>
 <div id="e-out" class="result" aria-live="polite"></div>
</section>

<section id="dicts" role="tabpanel" aria-labelledby="tab-dicts" tabindex="-1">
 <p class="lede">The bundled lexicons. Every one is open, licensed for commercial use, and citable; each run's manifest records exactly which were used. Restricted resources (LIWC, NRC) are never bundled — import your own licensed copy from the command line.</p>
 <div id="d-out" aria-live="polite"><p class="note">Loading the bundle…</p></div>
</section>

<section id="help" role="tabpanel" aria-labelledby="tab-help" tabindex="-1">
 <p class="lede">Task-oriented guides for the whole workflow. The same text is available in the terminal as <code>tass help &lt;topic&gt;</code> and in the printed user guide.</p>
 ${HELP_HTML}
 <div class="callout">Command reference: any command explains itself with <code>--help</code>, for example <code>tass score --help</code>. What TASS can claim scientifically is documented in <code>docs/METHODS.md</code>; read it before reporting numbers.</div>
</section>

</main>

<footer>
 <span>Provenance: every score writes <code>&lt;output&gt;.manifest.json</code>.</span>
 <span>Citations: <code>tass cite --manifest &lt;manifest&gt;</code>.</span>
 <span>Automation: <code>tass mcp</code> serves these same tools to AI agents.</span>
</footer>

</div>
<script>
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
};
var BASE_TITLE = document.title;

// P2-21: bring a freshly rendered result region into view, honouring reduced motion.
function revealResult(el) {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try { el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }); } catch (e) { /* older engines */ }
}

// Copy helper (P1-8 / P1-13): clipboard when available, prompt fallback.
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).catch(function () { window.prompt('Copy this text:', t); });
  } else {
    window.prompt('Copy this text:', t);
  }
}

// P1-7: one shared corpus path across Score / Concordance / Exemplars.
var PATH_KEY = 'tass:last-input';
var lastPath = '';
try { lastPath = window.localStorage.getItem(PATH_KEY) || ''; } catch (e) { /* storage may be off */ }
function rememberPath(v) {
  v = String(v || '').trim();
  if (!v) { return; }
  lastPath = v;
  try { window.localStorage.setItem(PATH_KEY, v); } catch (e) { /* best effort */ }
}
function prefillPath(id) {
  var el = $(id);
  if (el && lastPath && !el.value.trim()) {
    el.value = lastPath;
    if (id === 's-in') { updateDerivedHint(); scheduleColumns(); }
  }
}

// ── Tabs: real tablist semantics with arrow-key navigation ──
var PANEL_INPUT = { score: 's-in', kwic: 'k-in', exemplars: 'e-in' };
var tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab]'));
function selectTab(tab) {
  tabs.forEach(function (t) {
    var on = t === tab;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).classList.toggle('on', on);
  });
  document.title = BASE_TITLE + ' · ' + tab.textContent; // P2-24
  var inputId = PANEL_INPUT[tab.getAttribute('aria-controls')];
  if (inputId) { prefillPath(inputId); } // P1-7: prefill the empty field on tab switch
}
tabs.forEach(function (t, i) {
  t.addEventListener('click', function () { selectTab(t); });
  t.addEventListener('keydown', function (e) {
    var j = null;
    if (e.key === 'ArrowRight') { j = (i + 1) % tabs.length; }
    else if (e.key === 'ArrowLeft') { j = (i - 1 + tabs.length) % tabs.length; }
    else if (e.key === 'Home') { j = 0; }
    else if (e.key === 'End') { j = tabs.length - 1; }
    if (j !== null) { e.preventDefault(); tabs[j].focus(); selectTab(tabs[j]); }
  });
});

// ── Tool calls (the same adapters MCP serves) ──
function call(name, args) {
  return fetch('/api/call', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: name, arguments: args })
  }).then(function (res) { return res.json(); }).then(function (body) {
    var text = (body.content && body.content[0] && body.content[0].text) || '';
    return { ok: !body.isError, text: text };
  });
}
function busy(btn, on, label, busyLabel) {
  btn.disabled = on;
  btn.textContent = on ? busyLabel : label;
}
// P1-9: map common raw filesystem failures to plain language; keep the raw text in a
// collapsed details block. Engine messages (e.g. column-not-found) pass through untouched.
function renderError(el, text) {
  var raw = String(text);
  var parts = raw.split(/\\n\\s*hint: /);
  var pathMatch = raw.match(/'([^']+)'/);
  var human = null;
  if (/\\bENOENT\\b/.test(parts[0])) {
    human = 'That file does not exist; check the path' + (pathMatch ? ' (' + pathMatch[1] + ')' : '') + '.';
  } else if (/\\bEACCES\\b|\\bEPERM\\b|\\bEBUSY\\b/.test(parts[0])) {
    human = 'Windows is blocking access to that file (is it open in Excel?).';
  }
  if (human) {
    el.innerHTML = '<div class="alert" role="alert">' + esc(human)
      + '<details><summary>Technical detail</summary><pre class="log">' + esc(raw) + '</pre></details></div>';
  } else {
    el.innerHTML = '<div class="alert" role="alert">' + esc(parts[0])
      + (parts[1] ? '<span class="hint">Hint: ' + esc(parts[1]) + '</span>' : '') + '</div>';
  }
  revealResult(el);
}

// P1-6: a blank output derives "<input>-scored.csv" beside the input.
function derivedOutput(inp) {
  inp = String(inp || '').trim();
  if (!inp) { return ''; }
  return inp.replace(/\\.[A-Za-z0-9]+$/, '') + '-scored.csv';
}
function updateDerivedHint() {
  var hint = $('s-out-hint');
  var d = $('s-out').value.trim() ? '' : derivedOutput($('s-in').value);
  if (d) { $('s-out-derived').textContent = d; hint.hidden = false; }
  else { hint.hidden = true; }
}

// P2-17: fetch a CSV's header once per path; null means "no columns known, keep free text".
var columnsCache = {};
function fetchColumns(path) {
  path = String(path || '').trim();
  if (!path) { return Promise.resolve(null); }
  if (Object.prototype.hasOwnProperty.call(columnsCache, path)) { return Promise.resolve(columnsCache[path]); }
  if (!/\\.csv$/i.test(path)) { columnsCache[path] = null; return Promise.resolve(null); }
  return fetch('/api/columns?path=' + encodeURIComponent(path))
    .then(function (r) { return r.json(); })
    .then(function (b) {
      var cols = b && b.columns && b.columns.length ? b.columns : null;
      columnsCache[path] = cols;
      return cols;
    })
    .catch(function () { columnsCache[path] = null; return null; });
}
var colTimer = null;
function scheduleColumns() {
  if (colTimer) { clearTimeout(colTimer); }
  colTimer = setTimeout(applyScoreColumns, 400);
}
function applyScoreColumns() {
  fetchColumns($('s-in').value).then(function (cols) {
    var field = $('s-col');
    if (!cols) {
      if (field.tagName === 'SELECT') { // free-text fallback when the header is unreadable
        var input = document.createElement('input');
        input.type = 'text'; input.id = 's-col'; input.autocomplete = 'off'; input.value = field.value;
        field.parentNode.replaceChild(input, field);
      }
      $('s-groupcols').innerHTML = '';
      return;
    }
    var current = field.value || 'text';
    var pick = cols.indexOf(current) >= 0 ? current : (cols.indexOf('text') >= 0 ? 'text' : cols[0]);
    var sel = document.createElement('select');
    sel.id = 's-col';
    sel.innerHTML = cols.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === pick ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    field.parentNode.replaceChild(sel, field);
    $('s-groupcols').innerHTML = cols.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
  });
}

// Minimal quote-aware CSV parse for the preview chunk.
function parseCsvChunk(text) {
  var rows = []; var row = []; var cur = ''; var q = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
      else { cur += c; }
    } else if (c === '"') { q = true; }
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\\r') { cur += c; }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ── Bundle load: lexicon pickers + the Dictionaries panel ──
var bundle = [];
// P1-10: signed-valence lexicons rank exemplars by signed mean by default.
var SIGNED = { afinn: 1, vader: 1, labmt: 1, socialsent: 1, 'warriner-vad': 1 };
function bundleById(id) {
  for (var i = 0; i < bundle.length; i++) { if (bundle[i].id === id) { return bundle[i]; } }
  return null;
}
// P0-3: the Exemplars pickers come from the bundle, never free text.
function fillExemplarLexicons() {
  $('e-lex').innerHTML = bundle.map(function (l) {
    return '<option value="' + esc(l.id) + '"' + (l.id === 'empath' ? ' selected' : '') + '>' + esc(l.id) + '</option>';
  }).join('');
  fillExemplarCategories();
}
function fillExemplarCategories() {
  var l = bundleById($('e-lex').value);
  var cat = $('e-cat');
  if (!l) { cat.innerHTML = ''; return; }
  cat.innerHTML = l.categories.map(function (c) {
    var label = c.label && c.label !== c.id ? c.id + ' (' + c.label + ')' : c.id;
    return '<option value="' + esc(c.id) + '">' + esc(label) + '</option>';
  }).join('');
  $('e-metric').value = SIGNED[l.id] ? 'mean' : 'percent';
}
$('e-lex').addEventListener('change', fillExemplarCategories);
call('tass_dicts', {}).then(function (r) {
  if (!r.ok) { renderError($('d-out'), r.text); return; }
  bundle = JSON.parse(r.text);
  // Starter selection: sentiment + politeness. Ten dictionaries at once buries a first
  // result under psycholinguistic norms; "All" is one click away for the full sweep.
  var STARTER = { vader: 1, afinn: 1, politeness: 1 };
  var boxes = function (cls) {
    return bundle.map(function (l) {
      return '<label><input type="checkbox" class="' + cls + '" value="' + esc(l.id) + '"'
        + (STARTER[l.id] ? ' checked' : '') + '> ' + esc(l.id) + '</label>';
    }).join('');
  };
  var setAll = function (cls, on) {
    document.querySelectorAll('.' + cls).forEach(function (b) { b.checked = on; });
  };
  var pickerControls = function (cls) {
    var wrap = document.createElement('span');
    wrap.className = 'pickall';
    [['All', true], ['None', false]].forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'linkish'; b.textContent = p[0];
      b.addEventListener('click', function () { setAll(cls, p[1]); });
      wrap.appendChild(b);
    });
    return wrap;
  };
  $('a-lex').innerHTML = boxes('a-lexbox'); $('a-lex').classList.remove('note');
  $('s-lex').innerHTML = boxes('s-lexbox'); $('s-lex').classList.remove('note');
  $('a-lex').parentNode.querySelector('legend').appendChild(pickerControls('a-lexbox'));
  $('s-lex').parentNode.querySelector('legend').appendChild(pickerControls('s-lexbox'));
  fillExemplarLexicons();
  $('d-out').innerHTML = bundle.map(function (l) {
    var terms = l.categories.reduce(function (n, c) { return n + c.terms; }, 0);
    var restricted = l.licenseClass !== 'commercial-ok';
    var catIds = l.categories.map(function (c) { return c.id; });
    var catList = catIds.length > 12
      ? catIds.slice(0, 12).join(', ') + ' and ' + (catIds.length - 12) + ' more'
      : catIds.join(', ');
    return '<div class="card"><h2>' + esc(l.id)
      + '<span class="badge ' + (restricted ? 'restricted' : 'ok') + '">' + esc(l.licenseClass) + '</span>'
      + '<span class="badge">' + esc(l.license || 'license unspecified') + '</span></h2>'
      + '<div>' + esc(l.name) + ': ' + l.categories.length + ' categories, ' + terms + ' terms</div>'
      + '<div class="cite">Cite: ' + esc(l.citation || '(no citation recorded)') + '</div>'
      + '<div class="catlist">categories: ' + esc(catList) + '</div></div>';
  }).join('');
});
function picked(cls) {
  return Array.prototype.map.call(document.querySelectorAll('.' + cls + ':checked'), function (b) { return b.value; });
}

// ── Analyze ──
$('a-go').addEventListener('click', function () {
  var out = $('a-out');
  if (!$('a-text').value.trim()) {
    renderError(out, 'Nothing to analyze yet; paste some text above.');
    return;
  }
  busy(this, true, 'Analyze', 'Analyzing…');
  var btn = this;
  call('tass_analyze_text', {
    text: $('a-text').value, lexicons: picked('a-lexbox'),
    include_zero: $('a-zero').checked, vader_rules: $('a-vr').checked
  }).then(function (r) {
    busy(btn, false, 'Analyze', 'Analyzing…');
    if (!r.ok) { renderError(out, r.text); return; }
    var d = JSON.parse(r.text);
    // Display rounding only (4 decimals, trailing zeros trimmed); exports keep full precision.
    var num = function (v) {
      if (v === null || v === undefined) { return v; }
      return String(Math.round(v * 10000) / 10000);
    };
    var h = '<p class="note">' + d.totalTokens + ' tokens · deterministic (same text, same numbers)</p>';
    if (d.vaderRules) {
      h += '<table><caption>TASS VADER-rules sentiment</caption>'
        + '<tr><th class="num">compound</th><th class="num">positive</th><th class="num">neutral</th><th class="num">negative</th><th>contributing tokens</th></tr>'
        + '<tr><td class="num"><strong>' + num(d.vaderRules.compound) + '</strong></td><td class="num">' + num(d.vaderRules.positive)
        + '</td><td class="num">' + num(d.vaderRules.neutral) + '</td><td class="num">' + num(d.vaderRules.negative) + '</td>'
        + '<td class="matched">' + esc((d.vaderRules.matchedForms || []).join(', ')) + '</td></tr></table>'
        + '<p class="note">Report as "TASS VADER-rules compound" (see Methods).</p>';
    }
    var any = false;
    d.lexicons.forEach(function (lex) {
      if (!lex.categories.length) { return; }
      any = true;
      var maxPct = Math.max.apply(null, lex.categories.map(function (c) { return c.percent; })) || 1;
      h += '<table><caption>' + esc(lex.id) + '</caption>'
        + '<tr><th>category</th><th class="num">% of tokens</th><th class="num">hits</th><th class="num">weighted</th><th class="num">mean</th><th>matched forms</th></tr>'
        + lex.categories.map(function (c) {
          var w = Math.max(2, Math.round(60 * c.percent / maxPct));
          return '<tr><td>' + esc(c.label) + '</td>'
            + '<td class="num"><span class="bar" style="width:' + w + 'px" aria-hidden="true"></span>' + num(c.percent) + '</td>'
            + '<td class="num">' + c.hits + '</td><td class="num">' + num(c.weighted) + '</td>'
            + '<td class="num">' + (c.mean === null ? '&middot;' : num(c.mean)) + '</td>'
            + '<td class="matched">' + esc(c.matchedForms.join(', ')) + '</td></tr>';
        }).join('') + '</table>';
    });
    if (!any && !d.vaderRules) { h += '<p class="callout">No categories matched. Try more text, more lexicons, or "include zero-hit categories" to see everything that was checked.</p>'; }
    // P1-13: take the numbers with you.
    h += '<div class="actions"><button type="button" class="mini" id="a-copy">Copy summary</button>'
      + '<button type="button" class="mini" id="a-json">Download JSON</button></div>';
    out.innerHTML = h;
    $('a-copy').addEventListener('click', function () {
      var lines = [];
      if (d.vaderRules) {
        lines.push('TASS VADER-rules compound = ' + num(d.vaderRules.compound) + ' (report as "TASS VADER-rules compound")');
      }
      d.lexicons.forEach(function (lex) {
        lex.categories.forEach(function (c) {
          lines.push(lex.id + ' ' + c.label + ' = ' + num(c.percent) + ' percent of tokens');
        });
      });
      copyText(lines.join('\\n'));
    });
    $('a-json').addEventListener('click', function () {
      var blob = new Blob([r.text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tass-analyze.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    });
    revealResult(out);
  });
});

// ── Score ──
// P1-8: preview the first rows of a scored CSV via the session-scoped preview endpoint.
function renderScorePreview(path) {
  fetch('/api/preview?path=' + encodeURIComponent(path))
    .then(function (r) { if (!r.ok) { throw new Error('preview'); } return r.text(); })
    .then(function (text) {
      var truncated = text.length >= 65536 && text.charAt(text.length - 1) !== '\\n';
      var rows = parseCsvChunk(text);
      if (truncated) { rows.pop(); }
      if (rows.length < 2) { return; }
      var header = rows[0];
      var dataRows = rows.slice(1, 11);
      var clip = function (s) { return s.length > 80 ? s.slice(0, 79) + '\\u2026' : s; };
      var slot = $('s-preview');
      if (!slot) { return; }
      slot.innerHTML = '<div class="scroll"><table><caption>Preview: first ' + dataRows.length
        + ' row(s) of ' + esc(path.split(/[\\\\/]/).pop()) + '</caption>'
        + '<tr>' + header.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>'
        + dataRows.map(function (rw) {
            return '<tr>' + header.map(function (c, i) {
              return '<td>' + esc(clip(rw[i] === undefined ? '' : rw[i])) + '</td>';
            }).join('') + '</tr>';
          }).join('') + '</table></div>';
    })
    .catch(function () { /* the preview is best-effort; the download links still stand */ });
}
$('s-go').addEventListener('click', function () {
  var out = $('s-out2');
  var input = $('s-in').value.trim();
  if (!input) {
    renderError(out, 'An input file path is needed. The output can stay blank; TASS then writes the scored CSV next to the input.');
    return;
  }
  rememberPath(input);
  var outputPath = $('s-out').value.trim() || derivedOutput(input); // P1-6
  busy(this, true, 'Score', 'Scoring…');
  var btn = this;
  var args = {
    input: input, output: outputPath,
    text_column: $('s-col').value || undefined,
    lexicons: picked('s-lexbox'), metrics: picked('s-metric'),
    vader_rules: $('s-vr').checked
  };
  var g = $('s-group').value.trim();
  var groupsPath = null;
  if (g) {
    args.group_column = g;
    groupsPath = outputPath.replace(/\\.csv$/i, '') + '-groups.csv';
    args.group_summary = groupsPath;
  }
  call('tass_score_file', args).then(function (r) {
    busy(btn, false, 'Score', 'Scoring…');
    if (!r.ok) { renderError(out, r.text); return; }
    var body = JSON.parse(r.text);
    // P1-8: actionable results — preview plus real downloads for every artifact.
    var artifacts = [{ label: 'Scored CSV', path: outputPath }];
    if (groupsPath) { artifacts.push({ label: 'Group summary', path: groupsPath }); }
    artifacts.push({ label: 'Run manifest', path: outputPath + '.manifest.json' });
    out.innerHTML = '<pre class="log">' + esc(body.log.join('\\n')) + '</pre>'
      + '<div id="s-preview"></div>'
      + '<ul class="artifacts">' + artifacts.map(function (a, i) {
          return '<li><strong>' + esc(a.label) + '</strong>'
            + '<a class="path" href="/api/download?path=' + encodeURIComponent(a.path) + '" download>'
            + esc(a.path.split(/[\\\\/]/).pop()) + '</a>'
            + '<button type="button" class="mini copy-path" data-i="' + i + '">Copy path</button></li>';
        }).join('') + '</ul>'
      + '<p class="callout">Done. The manifest beside the output is the provenance record a methods section needs; <code>tass cite --manifest</code> turns it into a citation block.</p>';
    Array.prototype.forEach.call(out.querySelectorAll('.copy-path'), function (b) {
      b.addEventListener('click', function () { copyText(artifacts[Number(b.getAttribute('data-i'))].path); });
    });
    renderScorePreview(outputPath);
    revealResult(out);
  });
});

// ── KWIC ──
$('k-go').addEventListener('click', function () {
  var out = $('k-out');
  if (!$('k-in').value.trim() || !$('k-q').value.trim()) {
    renderError(out, 'A file path and a query are needed — e.g. query happi* for happy/happiness/…');
    return;
  }
  rememberPath($('k-in').value);
  busy(this, true, 'Find in context', 'Searching…');
  var btn = this;
  call('tass_kwic', { input: $('k-in').value, text_column: $('k-col').value || undefined, query: $('k-q').value })
  .then(function (r) {
    busy(btn, false, 'Find in context', 'Searching…');
    if (!r.ok) { renderError(out, r.text); return; }
    var body = JSON.parse(r.text);
    if (!body.output.length) { out.innerHTML = '<p class="callout">No occurrences found. Stems need a trailing * (happi*), and matching is case-insensitive.</p>'; revealResult(out); return; }
    out.innerHTML = '<table><caption>' + body.output.length + ' concordance line(s)</caption>'
      + '<tr><th>document</th><th class="num">left context</th><th>keyword</th><th>right context</th></tr>'
      + body.output.map(function (l) {
        var p = l.split('\\t');
        return '<tr><td class="matched">' + esc(p[0]) + '</td><td class="num">' + esc(p[1])
          + '</td><td><strong>' + esc(p[2]) + '</strong></td><td>' + esc(p[3]) + '</td></tr>';
      }).join('') + '</table>';
    revealResult(out);
  });
});

// ── Exemplars ──
$('e-go').addEventListener('click', function () {
  var out = $('e-out');
  var input = $('e-in').value.trim();
  var lex = $('e-lex').value;
  var cat = $('e-cat').value;
  if (!input || !cat) {
    renderError(out, !input
      ? 'A file path is needed; the lexicon and category come from the pickers above.'
      : 'The dictionary bundle has not loaded yet, so the category picker is empty. Give it a moment.');
    return;
  }
  rememberPath(input);
  var metric = $('e-metric').value || 'percent';
  busy(this, true, 'Find exemplars', 'Searching…');
  var btn = this;
  call('tass_exemplars', {
    input: input, text_column: $('e-col').value || undefined,
    lexicon: lex, category: cat, metric: metric,
    top: Number($('e-top').value) || 10
  }).then(function (r) {
    busy(btn, false, 'Find exemplars', 'Searching…');
    if (!r.ok) { renderError(out, r.text); return; }
    var body = JSON.parse(r.text);
    if (!body.output.length) {
      out.innerHTML = '<p class="callout">No documents scored on ' + esc(lex + ':' + cat) + '. Try another category or metric.</p>';
      revealResult(out);
      return;
    }
    // P1-10: a real table instead of the pipe dump. Column names (when readable) map the
    // passthrough fields, so group/speaker columns and the text excerpt come out by name.
    fetchColumns(input).then(function (cols) {
      var textCol = $('e-col').value.trim() || 'text';
      var lines = body.output.map(function (l) {
        var p = l.split('\\t');
        return { score: p[1], matched: String(p[2] || '').replace(/^\\[/, '').replace(/\\]$/, ''), rest: p.slice(3).join('\\t') };
      });
      var groupCols = [];
      var textIdx = -1;
      if (cols) {
        groupCols = cols.filter(function (c) { return ['speaker', 'group', 'session', 'condition'].indexOf(c.toLowerCase()) >= 0; });
        textIdx = cols.indexOf(textCol);
      }
      var clip = function (s) { return s.length > 220 ? s.slice(0, 219) + '\\u2026' : s; };
      var h = '<div class="scroll"><table><caption>'
        + esc('Top ' + lines.length + ' exemplars: ' + lex + ':' + cat + ', ranked by ' + metric) + '</caption>'
        + '<tr><th class="num">#</th><th class="num">' + esc(metric) + '</th><th>matched terms</th>'
        + groupCols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('')
        + '<th>text</th></tr>'
        + lines.map(function (ln, i) {
            var fields = ln.rest.split(' | ');
            var mapped = cols && fields.length === cols.length;
            var excerpt = mapped && textIdx >= 0 ? fields[textIdx] : ln.rest;
            return '<tr><td class="num">' + (i + 1) + '</td><td class="num">' + esc(ln.score) + '</td>'
              + '<td class="matched">' + esc(ln.matched) + '</td>'
              + groupCols.map(function (c) { return '<td>' + esc(mapped ? fields[cols.indexOf(c)] : '') + '</td>'; }).join('')
              + '<td>' + esc(clip(excerpt)) + '</td></tr>';
          }).join('') + '</table></div>';
      if (SIGNED[lex] && metric === 'mean') {
        h += '<p class="note">Ranked by signed mean, so strongly negative documents sink and positive ones rise; switch the Rank by metric to change.</p>';
      }
      h += '<p class="note">' + esc(body.log.join(' ')) + '</p>';
      out.innerHTML = h;
      revealResult(out);
    });
  });
});

// ── Wiring: shared path, derived output, column pickers, initial title ──
['s-in', 'k-in', 'e-in'].forEach(function (id) {
  $(id).addEventListener('change', function () { rememberPath(this.value); });
});
$('s-in').addEventListener('input', function () { updateDerivedHint(); scheduleColumns(); });
$('s-in').addEventListener('blur', applyScoreColumns);
$('s-out').addEventListener('input', updateDerivedHint);
prefillPath('s-in'); prefillPath('k-in'); prefillPath('e-in');
updateDerivedHint();
document.title = BASE_TITLE + ' · Analyze text';
})();
</script>
</body>
</html>
`;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * P1-8: artifact paths this server instance has written via tass_score_file. They are the
 * ONLY paths /api/download and /api/preview will serve; anything else is a 403. Exported so
 * tests can reset it between cases.
 */
export const issuedArtifacts = new Set<string>();

/** P1-9: map raw filesystem failures to plain language (null = no mapping, pass through). */
function humanFsError(raw: string): string | null {
    const path = /'([^']+)'/.exec(raw)?.[1];
    if (/\bENOENT\b/.test(raw)) { return `That file does not exist; check the path${path ? ` (${path})` : ''}.`; }
    if (/\bEACCES\b|\bEPERM\b|\bEBUSY\b/.test(raw)) { return 'Windows is blocking access to that file (is it open in Excel?).'; }
    return null;
}

/** Read at most `cap` bytes from the start of a file (P2-17 header sniff, P1-8 preview). */
function readFirstChunk(path: string, cap = 64 * 1024): string {
    const fd = openSync(path, 'r');
    try {
        const buf = Buffer.alloc(cap);
        const n = readSync(fd, buf, 0, cap, 0);
        return buf.subarray(0, n).toString('utf8');
    } finally { closeSync(fd); }
}

/** Quote-aware split of one CSV header line. */
function parseCsvHeader(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
            else { cur += c; }
        } else if (c === '"') { q = true; }
        else if (c === ',') { out.push(cur); cur = ''; }
        else { cur += c; }
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(s => s !== '');
}

/** Exported for tests: handle one request path against the tool layer. */
export async function handleApi(method: string | undefined, url: string | undefined, body: string):
    Promise<{ status: number; type: string; body: string; headers?: Record<string, string> }> {
    if (method === 'GET' && (url === '/' || url === '/index.html')) {
        return { status: 200, type: 'text/html; charset=utf-8', body: PAGE };
    }
    if (method === 'GET' && url === '/api/tools') {
        return { status: 200, type: 'application/json', body: JSON.stringify(toolList()) };
    }
    // P2-17: first CSV header line only (64KB cap) so the page can offer real column pickers.
    if (method === 'GET' && url && url.startsWith('/api/columns?')) {
        const p = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
        try {
            const header = readFirstChunk(p).split(/\r?\n/, 1)[0] ?? '';
            return { status: 200, type: 'application/json', body: JSON.stringify({ columns: parseCsvHeader(header) }) };
        } catch (e) {
            const raw = e instanceof Error ? e.message : String(e);
            return { status: 404, type: 'application/json', body: JSON.stringify({ error: humanFsError(raw) ?? raw, detail: raw }) };
        }
    }
    // P1-8: serve ONLY artifacts this session issued; everything else is a 403.
    if (method === 'GET' && url && (url.startsWith('/api/download?') || url.startsWith('/api/preview?'))) {
        const p = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
        if (!issuedArtifacts.has(p)) {
            return { status: 403, type: 'text/plain', body: 'not an artifact issued by this session' };
        }
        try {
            if (url.startsWith('/api/preview?')) {
                return { status: 200, type: 'text/plain; charset=utf-8', body: readFirstChunk(p) };
            }
            const type = /\.json$/i.test(p) ? 'application/json' : 'text/csv; charset=utf-8';
            return {
                status: 200, type,
                headers: { 'content-disposition': `attachment; filename="${basename(p).replace(/"/g, '')}"` },
                body: readFileSync(p, 'utf8'),
            };
        } catch (e) {
            const raw = e instanceof Error ? e.message : String(e);
            return { status: 404, type: 'text/plain', body: humanFsError(raw) ?? raw };
        }
    }
    if (method === 'POST' && url === '/api/call') {
        let parsed: { name?: unknown; arguments?: unknown };
        try { parsed = JSON.parse(body); } catch {
            return { status: 400, type: 'application/json', body: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'bad JSON' }] }) };
        }
        if (typeof parsed.name !== 'string') {
            return { status: 400, type: 'application/json', body: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'missing tool name' }] }) };
        }
        const result = callTool(parsed.name, (parsed.arguments ?? {}) as Record<string, unknown>);
        // P1-8: a successful score run issues its artifacts for download/preview.
        if (parsed.name === 'tass_score_file' && !result.isError) {
            const a = (parsed.arguments ?? {}) as Record<string, unknown>;
            if (typeof a.output === 'string' && a.output) {
                issuedArtifacts.add(a.output);
                issuedArtifacts.add(`${a.output}.manifest.json`);
            }
            if (typeof a.group_summary === 'string' && a.group_summary) { issuedArtifacts.add(a.group_summary); }
        }
        return { status: 200, type: 'application/json', body: JSON.stringify(result) };
    }
    return { status: 404, type: 'text/plain', body: 'not found' };
}

export function serveGui(port: number, openBrowser: boolean, io: Io): void {
    const server = createServer(async (req, res) => {
        try {
            const body = req.method === 'POST' ? await readBody(req) : '';
            const out = await handleApi(req.method, req.url, body);
            res.writeHead(out.status, { 'content-type': out.type, ...(out.headers ?? {}) });
            res.end(out.body);
        } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(e instanceof Error ? e.message : String(e));
        }
    });
    // localhost only — the GUI is a local tool, never a network service.
    server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        const actual = typeof addr === 'object' && addr ? addr.port : port;
        const urlStr = `http://127.0.0.1:${actual}/`;
        io.err(`TASS GUI at ${urlStr}  (Ctrl+C to stop)`);
        if (openBrowser) {
            const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', urlStr]]
                : process.platform === 'darwin' ? ['open', [urlStr]]
                : ['xdg-open', [urlStr]];
            try {
                spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
            } catch { /* browser open is best-effort */ }
        }
    });
}
