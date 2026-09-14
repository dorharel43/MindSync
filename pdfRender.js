// pdfRender.js  (runs in the RENDERER process)
// ---------------------------------------------------------------------------
// Renders PDF pages to PNG images so a vision model can read them.
//
// Why this lives in the renderer rather than the main process:
//   Rasterising a PDF needs a canvas. The main process has no DOM, so doing it
//   there would mean pulling in node-canvas - a native module that needs a
//   build toolchain and is a well-known source of install failures on Windows.
//   The renderer already has a real canvas built in, so the page is rendered
//   here and handed to main as base64. No native dependency, nothing to
//   compile, and it works the same on every platform.
//
// Why images at all:
//   Text extraction flattens the page. Everything that carries meaning through
//   layout - a fraction, a subscript, a matrix, indented code, right-to-left
//   ordering - is either mangled or lost before any model sees it. Rendering
//   keeps the page exactly as it looks, so the model reads what you read.
// ---------------------------------------------------------------------------

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Rendering scale. 2.0 is roughly 150dpi: small enough to keep the payload
// reasonable, large enough that subscripts and dense formulas stay legible.
// Below ~1.5 the model starts misreading indices.
const RENDER_SCALE = 2.0;

// Vision requests are billed and rate-limited per page, and a long deck would
// blow the free tier in one go, so the number of pages sent is capped.
const MAX_PAGES = 12;

/**
 * @param {string} filePath
 * @param {object} opts { maxPages }
 * @returns {Promise<Array<{pageNumber:number, mimeType:string, data:string}>>}
 */
async function renderPdfToImages(filePath, opts = {}) {
    const fs = require('fs');
    const maxPages = opts.maxPages || MAX_PAGES;

    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjsLib.getDocument({
        data,
        disableFontFace: false,   // real fonts matter here - we want it to LOOK right
        useSystemFonts: true,
        verbosity: 0
    }).promise;

    const total = Math.min(doc.numPages, maxPages);
    const images = [];

    for (let pageNum = 1; pageNum <= total; pageNum++) {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: RENDER_SCALE });

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');

        // Slides are often transparent; without a white fill they render as
        // black boxes and the model sees nothing.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: context, viewport }).promise;

        // JPEG rather than PNG: roughly a quarter of the size for slide
        // content, and the difference is invisible at this scale.
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        images.push({
            pageNumber: pageNum,
            mimeType: 'image/jpeg',
            data: dataUrl.split(',')[1]
        });

        page.cleanup();
        canvas.width = 0;   // release the backing store immediately
        canvas.height = 0;
    }

    await doc.destroy();

    return {
        images,
        totalPages: doc.numPages,
        renderedPages: total,
        truncated: doc.numPages > total
    };
}

module.exports = { renderPdfToImages, MAX_PAGES };
