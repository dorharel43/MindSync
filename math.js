// Formulas on the screens (2/10). The AI writes maths as LaTeX - $\frac{a}{b}$
// inline, $$...$$ on its own line - and KaTeX draws it, offline (an npm
// dependency here; a <script> from the server on the web). Text without a
// formula is set exactly as before (textContent). Everything around a formula
// is escaped; KaTeX escapes its own input and, with trust:false, refuses
// \href and friends, so the result is safe to insert.
//
// main.js keeps only formulas KaTeX can draw when it saves the AI's text (see
// keepFormulas there); one that still fails here is shown as its source text,
// never as a red error.
(function () {
    let katex = null;
    try { katex = (typeof window !== 'undefined' && window.katex) || require('katex'); } catch (e) { katex = null; }

    // $$...$$ (on its own line) or $...$ (inline) - the same rule as main.js's
    // MATH_SEGMENT. Inline $ can't touch a space inside ("$5 and $10" is
    // money), nor be followed by a digit ("$5-$10"). Not \(...\) / \[...\]:
    // in code those are regular expressions.
    const segments = () => /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
    // Never given to KaTeX (main.js's TEX_REFUSED): a macro definition (expands
    // for seconds and freezes the page), commands that need trust, Hebrew.
    const REFUSED = /\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global|href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData|message|errmessage|show)(?![a-zA-Z])|[\u0590-\u05FF]/;

    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    function hasMath(text) {
        return !!katex && segments().test(String(text == null ? '' : text));
    }

    // A line that looks like code - ends in ; { or }, or is indented like a
    // block - keeps its $ as they are: PHP and shell variables ($x, $HOME)
    // aren't maths.
    const CODE_LINE = /[;{}]\s*$|^(?: {4}|\t)\S/;
    function inCodeLine(src, index, length) {
        const start = src.lastIndexOf('\n', index - 1) + 1;
        const endAt = src.indexOf('\n', index + length);
        return CODE_LINE.test(src.slice(start, endAt === -1 ? src.length : endAt));
    }

    function render(tex, display) {
        if (!katex || tex.length > 1000 || REFUSED.test(tex)) return null;
        try {
            return katex.renderToString(tex, { throwOnError: true, displayMode: display, strict: 'ignore', trust: false, output: 'html', maxSize: 20, maxExpand: 1000 });
        } catch (e) {
            return null;
        }
    }

    // Each formula is isolated left to right (dir="ltr"): inside a Hebrew
    // sentence it isn't reversed and doesn't scramble the words around it.
    function toHtml(text) {
        const src = String(text == null ? '' : text);
        let out = '', last = 0;
        for (const m of src.matchAll(segments())) {
            out += escapeHtml(src.slice(last, m.index));
            const display = m[1] !== undefined;
            // (only an inline one: the first line of a $$ block often ends in "}")
            if (!display && inCodeLine(src, m.index, m[0].length)) {
                out += escapeHtml(m[0]);
                last = m.index + m[0].length;
                continue;
            }
            const tex = (m[1] ?? m[2]).trim();
            const html = tex ? render(tex, display) : null;
            // (one that can't be drawn is shown exactly as written, $ and all)
            out += html
                ? `<span class="${display ? 'math-display' : 'math-inline'}" dir="ltr">${html}</span>`
                : escapeHtml(m[0]);
            last = m.index + m[0].length;
        }
        return out + escapeHtml(src.slice(last));
    }

    // el.textContent = text, with its formulas drawn.
    function setText(el, text) {
        const s = String(text == null ? '' : text);
        if (hasMath(s)) el.innerHTML = toHtml(s);
        else el.textContent = s;
    }

    // Text cut to `max` characters, never inside a formula (back to before it).
    function cut(text, max) {
        const t = String(text == null ? '' : text);
        if (t.length <= max) return t;
        for (const m of t.matchAll(segments())) {
            if (m.index >= max) break;
            if (m.index + m[0].length > max) {
                // (under half left - one long formula: cut plainly, as main.js does)
                const before = t.slice(0, m.index).replace(/\s+$/, '');
                return before.length >= max / 2 ? before : t.slice(0, max);
            }
        }
        return t.slice(0, max);
    }

    window.MathText = { setText, toHtml, hasMath, cut };
})();
