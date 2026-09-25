// summary.js - runs inside the separate summary window (summary.html).
// Shows the saved summary of one file, or generates and saves one if the
// file doesn't have one yet.
const { ipcRenderer, clipboard } = require('electron');

const fileId = new URLSearchParams(window.location.search).get('fileId');

const nameEl = document.getElementById('sum-file-name');
const metaEl = document.getElementById('sum-meta');
const contentEl = document.getElementById('sum-content');
const copyBtn = document.getElementById('sum-copy');
const regenBtn = document.getElementById('sum-regenerate');

let file = null;
let currentSummary = '';

// ---- Theme: same keys the main window writes, so both windows match ----
(function applyTheme() {
    const theme = localStorage.getItem('mindsync.theme') || 'ink';
    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.toggle('dark-mode', localStorage.getItem('mindsync.darkMode') === '1');
})();

// ---- Text size, remembered between windows ----
const FONT_KEY = 'mindsync.summaryFontSize';
let fontSize = parseInt(localStorage.getItem(FONT_KEY), 10) || 16;
function applyFontSize() {
    fontSize = Math.min(24, Math.max(12, fontSize));
    contentEl.style.setProperty('--sum-font-size', `${fontSize}px`);
    localStorage.setItem(FONT_KEY, String(fontSize));
}
document.getElementById('sum-smaller').onclick = () => { fontSize -= 1; applyFontSize(); };
document.getElementById('sum-larger').onclick = () => { fontSize += 1; applyFontSize(); };
applyFontSize();

// ---- Rendering ----
// SECURITY: the summary is model output derived from a PDF's content, so it
// is untrusted - a crafted document could try to smuggle in HTML/script.
// Everything is escaped FIRST, and only then is the small markdown subset
// turned into tags. (The old modal inserted it as raw HTML, and with
// nodeIntegration on, script in this window would have full Node access.)
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Formulas: the model writes maths as LaTeX ($\sigma^2$, $$\frac{a}{b}$$),
// which used to show up as raw code. KaTeX draws it as real notation -
// fractions, roots, subscripts - offline. It's an npm dependency; if it's
// missing for any reason the formula is still shown, as code, rather than
// breaking the window. KaTeX escapes its own input and, with the default
// trust:false, refuses \href and friends, so its output is safe to insert.
let katex = null;
try { katex = require('katex'); } catch (e) { console.warn('KaTeX not installed - formulas will show as code.'); }

function renderMath(tex, displayMode) {
    if (katex) {
        try {
            return katex.renderToString(tex, { throwOnError: false, displayMode, output: 'html' });
        } catch (e) { /* fall through to the plain version */ }
    }
    return `<code>${escapeHtml(tex)}</code>`;
}

// Formulas are pulled out into placeholders BEFORE escaping and markdown, so
// neither can mangle them (a "*" in a formula isn't bold, a "_" isn't
// anything), then put back as rendered HTML at the very end.
const MATH_TOKEN = /\u0000M(\d+)\u0000/g;
function extractMath(text) {
    const math = [];
    const keep = (tex, display) => { math.push({ tex: tex.trim(), display }); return `\u0000M${math.length - 1}\u0000`; };
    let out = String(text || '')
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => `\n${keep(t, true)}\n`)
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `\n${keep(t, true)}\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => keep(t, false))
        // Inline $...$ on one line. Not "$5 and $10": the content can't start
        // or end with a space, the usual rule for telling maths from prices.
        .replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_, t) => keep(t, false));
    return { text: out, math };
}

function inline(text, math) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // dir="ltr" isolates each formula, so inside a Hebrew sentence it
        // doesn't get reversed or scramble the words around it.
        .replace(MATH_TOKEN, (_, i) => `<span class="math-inline" dir="ltr">${renderMath(math[i].tex, false)}</span>`);
}

function renderSummary(text) {
    const { text: body, math } = extractMath(text);
    const lines = body.split(/\r?\n/);
    let html = '';
    let listType = null; // 'ul' | 'ol' | null

    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
    const openList = (type) => {
        if (listType !== type) { closeList(); html += `<${type} dir="auto">`; listType = type; }
    };

    for (const raw of lines) {
        const line = raw.trim();
        let m;
        if (!line) { closeList(); continue; }
        if ((m = line.match(/^\u0000M(\d+)\u0000$/)) && math[m[1]].display) {
            closeList();
            html += `<div class="math-display" dir="ltr">${renderMath(math[m[1]].tex, true)}</div>`;
            continue;
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { closeList(); html += '<hr>'; continue; }
        if ((m = line.match(/^#{1,2}\s+(.*)$/))) { closeList(); html += `<h2 dir="auto">${inline(m[1], math)}</h2>`; continue; }
        if ((m = line.match(/^#{3,6}\s+(.*)$/))) { closeList(); html += `<h3 dir="auto">${inline(m[1], math)}</h3>`; continue; }
        if ((m = line.match(/^[-*•]\s+(.*)$/))) { openList('ul'); html += `<li dir="auto">${inline(m[1], math)}</li>`; continue; }
        if ((m = line.match(/^\d+[.)]\s+(.*)$/))) { openList('ol'); html += `<li dir="auto">${inline(m[1], math)}</li>`; continue; }
        closeList();
        html += `<p dir="auto">${inline(line, math)}</p>`;
    }
    closeList();
    return html;
}

function showSummary(text, savedAt) {
    currentSummary = text;
    contentEl.innerHTML = renderSummary(text);
    metaEl.textContent = savedAt
        ? `Saved ${new Date(savedAt).toLocaleString()}`
        : 'Saved';
    copyBtn.disabled = false;
    regenBtn.disabled = false;
}

function showLoading() {
    contentEl.innerHTML = `
        <div class="sum-state">
            <div class="sum-spinner"></div>
            <div>Reading the document and writing the summary…</div>
            <div style="font-size: 0.85em; margin-top: 6px;">This can take up to a minute for a long file.</div>
        </div>`;
    copyBtn.disabled = true;
    regenBtn.disabled = true;
}

function showError(message) {
    contentEl.innerHTML = `
        <div class="sum-state">
            <div class="sum-error">${escapeHtml(message)}</div>
            <button class="sum-btn" id="sum-retry">Try again</button>
        </div>`;
    document.getElementById('sum-retry').onclick = generate;
    // Keep an older saved summary reachable even if a regeneration failed.
    regenBtn.disabled = false;
    copyBtn.disabled = !currentSummary;
}

// ---- Generate + save ----
async function generate() {
    if (!file) return;
    showLoading();
    try {
        const result = await ipcRenderer.invoke('summarize-text', file.content || '', file.sourcePath || '');
        if (!result || typeof result !== 'string' || result.error) {
            showError((result && result.error) || 'The AI did not return a summary.');
            return;
        }
        const saved = await ipcRenderer.invoke('save-file-summary', fileId, result);
        if (saved && saved.error) {
            // The summary exists - show it rather than throwing it away, but
            // be honest that it won't be there next time.
            showSummary(result, null);
            metaEl.textContent = `Not saved: ${saved.error}`;
            return;
        }
        showSummary(result, saved && saved.summaryUpdatedAt);
    } catch (err) {
        showError(err.message);
    }
}

regenBtn.onclick = generate;

copyBtn.onclick = () => {
    clipboard.writeText(currentSummary);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = original; }, 1500);
};

// ---- Boot ----
(async () => {
    if (!fileId) { showError('No file was specified.'); return; }
    const result = await ipcRenderer.invoke('get-file', fileId);
    if (!result || result.error) {
        nameEl.textContent = 'Summary';
        showError((result && result.error) || 'Could not load this file.');
        return;
    }
    file = result;
    nameEl.textContent = file.name || 'Summary';
    document.title = `Summary - ${file.name || ''}`;

    if (file.summary && file.summary.trim()) {
        showSummary(file.summary, file.summaryUpdatedAt);
    } else {
        await generate();
    }
})();