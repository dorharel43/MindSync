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

    // $$...$$ / \[...\] (on its own line) or $...$ / \(...\) (inline). Inline $
    // can't touch a space inside ("$5 and $10" is money) - the same rule as
    // main.js's MATH_SEGMENT.
    const segments = () => /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

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
        // Hebrew inside a formula has no font metrics in KaTeX - shown as text.
        if (!katex || /[\u0590-\u05FF]/.test(tex)) return null;
        try {
            return katex.renderToString(tex, { throwOnError: true, displayMode: display, strict: 'ignore', trust: false, output: 'html' });
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
            const display = m[1] !== undefined || m[2] !== undefined;
            if (m[4] !== undefined && inCodeLine(src, m.index, m[0].length)) {
                out += escapeHtml(m[0]);
                last = m.index + m[0].length;
                continue;
            }
            const tex = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
            const html = tex ? render(tex, display) : null;
            out += html
                ? `<span class="${display ? 'math-display' : 'math-inline'}" dir="ltr">${html}</span>`
                : escapeHtml(tex);
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

    window.MathText = { setText, toHtml, hasMath };
})();
