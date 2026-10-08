/* ==========================================================================
   MindSync i18n - English / Hebrew (30/9)
   --------------------------------------------------------------------------
   The app is written in English. In Hebrew mode this file translates what is
   on the screen, instead of every line of code asking for a translation:

     - on load, every text in the page, and the placeholder / title /
       aria-label attributes;
     - afterwards, anything the code puts on the screen (a MutationObserver) -
       toasts, dialogs, lists, buttons whose words change.

   Where the words come from (i18n-he.js, loaded right after this file):
     I18N_HE.text      exact English text -> Hebrew
     I18N_HE.html      elements with inline markup (<strong>, <bdi>...),
                       matched on their whole innerHTML
     I18N_HE.patterns  [RegExp, replacement] for text with numbers or names in
                       it ("You know 4 of 11.") - $1, $2 as in String.replace
   A text that isn't found is split into sentences / " · " pieces and each
   piece is tried on its own, so "Exam in 7 days · Wed 7/10" works piecewise.
   Anything still not found simply stays in English - nothing breaks.

   In code, t('English text', {n: 3}) returns the translation directly; use
   it where a string never reaches the DOM as-is (document.title, confirm
   texts built from pieces...). The language is stored per device
   (localStorage mindsync.lang); default = the browser's language.

   Load order: i18n.js, i18n-he.js, then ui.js, renderer.js. The page must
   not flash English: the <html> dir/lang are set here, before the body
   paints, and the first pass runs on DOMContentLoaded.
   ========================================================================== */
// Blocked site storage (30/9): some browsers/privacy settings make every
// localStorage access throw - the app then died at start-up. This is the
// first script on the page, so it puts an in-memory stand-in in place
// (preferences just aren't remembered after closing).
(function () {
    try { const k = '__ms_probe'; window.localStorage.setItem(k, '1'); window.localStorage.removeItem(k); return; } catch (e) { /* blocked */ }
    const mem = new Map();
    const stub = {
        getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
        setItem: (k, v) => { mem.set(String(k), String(v)); },
        removeItem: (k) => { mem.delete(String(k)); },
        clear: () => mem.clear(),
        key: (i) => [...mem.keys()][i] || null,
        get length() { return mem.size; }
    };
    try { Object.defineProperty(window, 'localStorage', { value: stub, configurable: true }); } catch (e) { /* can't replace - nothing more to do */ }
})();

(function () {
    'use strict';

    const KEY = 'mindsync.lang';
    function detect() {
        try {
            const saved = localStorage.getItem(KEY);
            if (saved === 'he' || saved === 'en') return saved;
        } catch (e) { /* storage blocked */ }
        const nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
        return /^he|^iw/i.test(nav) ? 'he' : 'en';
    }

    const lang = detect();
    const root = document.documentElement;
    // Not about language, but this is the first script on the page (30/9):
    // someone who was logged in last time gets a quiet loading screen while
    // the session is checked, instead of the login screen flashing up (on
    // every reload - switching the language reloads too).
    try { if (localStorage.getItem('mindsync.session') === '1') root.classList.add('has-session'); } catch (e) { /* storage blocked */ }
    root.lang = lang;
    root.dir = lang === 'he' ? 'rtl' : 'ltr';
    root.classList.toggle('is-rtl', lang === 'he');
    // Hebrew: keep the page hidden until the first translation pass, so it
    // never shows English for a moment (3 s at most, whatever happens).
    if (lang === 'he') {
        root.classList.add('i18n-pending');
        const st = document.createElement('style');
        st.textContent = 'html.i18n-pending body{visibility:hidden}';
        (document.head || root).appendChild(st);
        setTimeout(() => root.classList.remove('i18n-pending'), 3000);
    }

    let dict = null;   // filled by i18n-he.js via I18N.register()
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

    function lookup(text) {
        if (!dict) return null;
        const key = norm(text);
        if (!key || !/[A-Za-z]/.test(key)) return null;
        if (Object.prototype.hasOwnProperty.call(dict.text, key)) return dict.text[key];
        for (const [re, rep] of dict.patterns) {
            if (re.test(key)) return key.replace(re, rep);
        }
        // Piecewise: "A. B." or "A · B" - translate the pieces that are known.
        const pieces = key.split(/(\s·\s|(?<=[.!?])\s+(?=[A-Z0-9"]))/);
        if (pieces.length > 1) {
            let changed = false;
            const out = pieces.map(p => {
                if (/^\s·\s$/.test(p) || /^\s+$/.test(p)) return p;
                const tr = lookupWhole(p);
                if (tr != null) { changed = true; return tr; }
                return p;
            });
            if (changed) return out.join('');
        }
        return null;
    }
    function lookupWhole(text) {
        const key = norm(text);
        if (Object.prototype.hasOwnProperty.call(dict.text, key)) return dict.text[key];
        for (const [re, rep] of dict.patterns) {
            if (re.test(key)) return key.replace(re, rep);
        }
        return null;
    }

    // Public: t('English', {name: value}) - {name} placeholders filled after
    // translating, so the dictionary key keeps the placeholder.
    function t(text, vars) {
        let out = text;
        if (lang === 'he' && dict) {
            const tr = lookup(text);
            if (tr != null) out = tr;
        }
        if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
        return out;
    }

    // ---- DOM pass ----
    const ATTRS = ['placeholder', 'title', 'aria-label'];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT']);
    // What the USER wrote is never translated (30/9): a task called "Study"
    // or "Monday" became "תרגול" / "יום שני". These hold user content only;
    // any fallback text shown in them ("No course", "Guest") is translated
    // in the code with t().
    const USER_CONTENT = [
        '.task-title-text', '.task-category-tag', '.checklist-item span[dir="auto"]',
        '.task-card__title', '.task-card__location', '.timetable-row__where', '.timetable-row__ai-note', '.board-task__title', '.timeline-title', '.schedule-title', '.week-upcoming__title',
        '.attention-item__title', '.cat-row__name', '.readiness-row__name', '.study-course__name', '.study-file__name',
        '.study-exam-row__course', '.file-name', '.folder-name', '.syllabus-row__title', '.upload-row__name',
        '.manage-item__q', '.review-item__q', '.review-item__a', '.summary-surewrong__list',
        '#sidebar-profile-name', '#sidebar-profile-degree', '#home-greeting-name', '#settings-profile-name', '#settings-profile-meta', '#settings-profile-email',
        '#home-next-title', '#sidebar-next-title', '.sum-toolbar__name', '.sb-course__name', '.home-hero__exam-name', '.home-ready__oname'
    ].join(', ');
    // Placeholders the app itself puts in those spots before real content
    // arrives (or when there's none) - always translated.
    const ALWAYS_UI = new Set(['Loading…', 'Loading...', 'Loading data...', 'Please wait', 'Guest', 'Student', 'Uncategorized',
        'No course', 'Summary', 'No answer passage — this will be a practice prompt.']);
    function hardSkipped(el) {
        for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
            if (SKIP_TAGS.has(e.tagName)) return true;
            if (e.getAttribute('translate') === 'no') return true;
        }
        return false;
    }
    function skipped(el) {
        return hardSkipped(el) || !!(el && el.nodeType === 1 && el.closest && el.closest(USER_CONTENT));
    }

    function translateText(node) {
        const v = node.nodeValue;
        if (!v || !/[A-Za-z]/.test(v)) return;
        if (!node.parentNode) return;
        if (skipped(node.parentNode) && !(ALWAYS_UI.has(norm(v)) && !hardSkipped(node.parentNode))) return;
        const tr = lookup(v);
        if (tr == null) return;
        // Keep the spaces around it (inline text next to icons, "Hide · ").
        const lead = v.match(/^\s*/)[0];
        const trail = v.match(/\s*$/)[0];
        const next = lead + tr + trail;
        if (next !== v) node.nodeValue = next;
    }

    function translateAttrs(el) {
        for (const a of ATTRS) {
            const v = el.getAttribute(a);
            if (!v || !/[A-Za-z]/.test(v)) continue;
            const tr = lookup(v);
            if (tr != null && tr !== v) el.setAttribute(a, tr);
        }
    }

    function translateHtmlBlocks(scope) {
        if (!dict || !dict.htmlKeys.length) return;
        const els = scope.querySelectorAll ? scope.querySelectorAll('li, p, label, div, span, h1, h2, h3, h4, button, a, strong, td, th') : [];
        const list = scope.nodeType === 1 ? [scope, ...els] : [...els];
        for (const el of list) {
            if (!el.firstChild || el.children.length === 0) continue;
            const key = norm(el.innerHTML);
            if (key.length > 1500) continue;
            if (Object.prototype.hasOwnProperty.call(dict.html, key)) el.innerHTML = dict.html[key];
        }
    }

    function translateTree(scope) {
        if (lang !== 'he' || !dict || !scope) return;
        if (scope.nodeType === 3) { translateText(scope); return; }
        if (scope.nodeType !== 1 && scope.nodeType !== 9 && scope.nodeType !== 11) return;
        if (scope.nodeType === 1 && hardSkipped(scope)) return;   // user areas: walked, text decides (ALWAYS_UI)
        translateHtmlBlocks(scope);
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        let n = walker.currentNode;
        while (n) {
            if (n.nodeType === 3) translateText(n);
            else if (n.nodeType === 1) {
                if (SKIP_TAGS.has(n.tagName)) {
                    // A text box's own placeholder / title still gets translated -
                    // only what's typed inside it is left alone.
                    if (n.tagName === 'TEXTAREA' && !skipped(n.parentNode)) translateAttrs(n);
                    n = nextSkippingChildren(walker); continue;
                }
                if (!skipped(n)) translateAttrs(n);   // a user area's attributes (a file name as title) stay
            }
            n = walker.nextNode();
        }
    }
    function nextSkippingChildren(walker) {
        let n = walker.nextSibling();
        while (!n) {
            if (!walker.parentNode()) return null;
            n = walker.nextSibling();
        }
        return n;
    }

    let observer = null;
    function startObserver() {
        if (observer || lang !== 'he') return;
        observer = new MutationObserver((records) => {
            for (const r of records) {
                if (r.type === 'childList') r.addedNodes.forEach(translateTree);
                else if (r.type === 'characterData') translateText(r.target);
                else if (r.type === 'attributes' && r.target.nodeType === 1) {
                    const el = r.target;
                    if (el.tagName === 'TEXTAREA' ? !skipped(el.parentNode) : !skipped(el)) translateAttrs(el);
                }
            }
        });
        observer.observe(document.body, {
            subtree: true, childList: true, characterData: true,
            attributes: true, attributeFilter: ATTRS
        });
    }

    function register(d) {
        dict = {
            text: d.text || {},
            html: {},
            patterns: d.patterns || []
        };
        Object.entries(d.html || {}).forEach(([k, v]) => { dict.html[norm(k)] = v; });
        dict.htmlKeys = Object.keys(dict.html);
    }

    function setLang(next) {
        if (next !== 'he' && next !== 'en') return;
        try { localStorage.setItem(KEY, next); } catch (e) { /* storage blocked */ }
        location.reload();
    }

    window.I18N = { lang, t, register, setLang, translate: translateTree, isRtl: lang === 'he' };
    window.t = t;

    function first() {
        if (lang !== 'he') return;
        try {
            translateTree(document.body);
            if (document.title) document.title = t(document.title);
            startObserver();
        } finally {
            root.classList.remove('i18n-pending');
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', first);
    else first();
})();
