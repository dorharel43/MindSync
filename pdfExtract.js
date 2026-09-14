// pdfExtract.js
// ---------------------------------------------------------------------------
// PDF text extraction with proper right-to-left support.
//
// Why this module exists:
//   pdf2json returns a flat stream of text runs in roughly visual order, with
//   no position or direction information exposed. For Hebrew that produces
//   scrambled output - sentence-final punctuation lands at the start of the
//   next sentence, clause order reverses, and slide list numbers end up in the
//   middle of sentences. We were repairing that damage downstream with a stack
//   of heuristics, which is a losing game: each fix handled one pattern and the
//   next document produced a new one.
//
//   pdfjs-dist (Mozilla's engine, the one Firefox uses) exposes each text item
//   with its position on the page and its resolved direction. That means we can
//   rebuild the reading order from the actual geometry instead of guessing at
//   it after the fact - fixing the cause rather than the symptoms.
//
// Install:
//   npm install pdfjs-dist@^3.11.174
//
// The legacy build is used deliberately: pdfjs-dist v4+ is ESM-only, and the
// v3 legacy bundle loads cleanly from CommonJS, which is what this app uses.
// ---------------------------------------------------------------------------

const fs = require('fs');

// Items on the same visual line rarely share an exact Y, so lines are grouped
// within a tolerance proportional to text height.
const LINE_TOLERANCE_RATIO = 0.5;

let pdfjsLib = null;

async function loadPdfjs() {
    if (pdfjsLib) return pdfjsLib;
    try {
        // Legacy CommonJS build.
        pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    } catch (e1) {
        try {
            pdfjsLib = require('pdfjs-dist');
        } catch (e2) {
            throw new Error(
                'pdfjs-dist is not installed. Run: npm install pdfjs-dist@^3.11.174'
            );
        }
    }
    return pdfjsLib;
}

// Decides whether a line should be read right-to-left.
// pdfjs tags individual items with a direction, but a line mixing Hebrew with
// Latin terms or formulas gets mixed tags - so the decision is made per line,
// by which script carries most of the content.
function lineIsRtl(items) {
    let rtlChars = 0;
    let ltrChars = 0;

    items.forEach(item => {
        const s = item.str || '';
        rtlChars += (s.match(/[\u0590-\u08FF]/g) || []).length;   // Hebrew, Arabic
        ltrChars += (s.match(/[A-Za-z]/g) || []).length;
    });

    if (rtlChars === 0) return false;
    return rtlChars >= ltrChars;
}

// Groups text items into visual lines using their Y coordinate.
function groupIntoLines(items) {
    const positioned = items
        .filter(it => it.str && it.str.trim().length > 0)
        .map(it => ({
            str: it.str,
            dir: it.dir,
            x: it.transform[4],
            y: it.transform[5],
            width: it.width || 0,
            height: it.height || Math.abs(it.transform[3]) || 10
        }));

    if (positioned.length === 0) return [];

    // Top of page first (PDF Y grows upwards, so descending Y = reading order).
    positioned.sort((a, b) => b.y - a.y);

    const lines = [];
    let current = [positioned[0]];
    let currentY = positioned[0].y;
    let currentH = positioned[0].height;

    for (let i = 1; i < positioned.length; i++) {
        const item = positioned[i];
        const tolerance = Math.max(currentH * LINE_TOLERANCE_RATIO, 2);

        if (Math.abs(item.y - currentY) <= tolerance) {
            current.push(item);
        } else {
            lines.push(current);
            current = [item];
            currentY = item.y;
            currentH = item.height;
        }
    }
    lines.push(current);

    return lines;
}

// Builds the text of one line, ordering items by their horizontal position in
// the direction the line is actually read.
function assembleLine(items) {
    const rtl = lineIsRtl(items);

    // This is the whole point: for an RTL line the rightmost item comes FIRST.
    // Reading it left-to-right (which is what a naive extractor does) is
    // exactly what reversed the clauses.
    const ordered = [...items].sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));

    let out = '';
    let prev = null;

    ordered.forEach(item => {
        if (prev) {
            // Insert a space when there's a visible horizontal gap between
            // runs, so words don't get glued together ("תהליך רקורסיביבניית").
            const gap = rtl
                ? prev.x - (item.x + item.width)
                : item.x - (prev.x + prev.width);
            const spaceWidth = (prev.height || 10) * 0.2;
            if (gap > spaceWidth) out += ' ';
        }
        out += item.str;
        prev = item;
    });

    return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Extracts text from a PDF with reading order preserved for RTL content.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractPdfText(filePath) {
    const pdfjs = await loadPdfjs();

    const data = new Uint8Array(fs.readFileSync(filePath));

    const loadingTask = pdfjs.getDocument({
        data,
        // No DOM available in the main process, and these features aren't
        // needed for plain text extraction.
        useSystemFonts: false,
        disableFontFace: true,
        isEvalSupported: false,
        verbosity: 0
    });

    const doc = await loadingTask.promise;
    const pages = [];

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const content = await page.getTextContent();

        const lines = groupIntoLines(content.items)
            .map(assembleLine)
            .filter(l => l.length > 0);

        pages.push(lines.join('\n'));
        page.cleanup();
    }

    await doc.destroy();

    return pages.join('\n\n');
}

module.exports = { extractPdfText };
