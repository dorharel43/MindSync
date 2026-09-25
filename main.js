require('dotenv').config();
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const PDFParser = require('pdf2json'); // kept as a fallback only
const { extractPdfText } = require('./pdfExtract');
const aiProvider = require('./aiProvider');
const http = require('http');
const { google } = require('googleapis');
const api = require('./apiClient');
const authClient = require('./authClient');
const logger = require('./logger');

// =====================================
// Local AI Mechanism (Ollama)
// =====================================
// Switched from the custom 'MindSync-AI' (qwen2.5:3b based) to aya-expanse:8b,
// which is built for multilingual use and handles Hebrew far better - the 3B
// model kept falling into repetition loops on Hebrew documents. This is only
// used as the localModel fallback inside aiProvider now - see the note on
// callAIWithFallback below.
const LOCAL_MODEL = 'aya-expanse:8b';

// Hard cap on generated tokens. Without this, a model that doesn't know
// when to stop will generate until something else kills it - which looks
// exactly like a hang.
const MAX_OUTPUT_TOKENS = 800;

// IMPORTANT - this is much lower than it looks like it should be, on purpose:
// Hebrew tokenizes very poorly compared to Latin text. English runs roughly
// 4 characters per token, but Hebrew can be 1-3 TOKENS PER CHARACTER. So
// 4,600 Hebrew characters can blow past 8,000 tokens, overflow the context,
// and take minutes to process on CPU - which looks exactly like a hang.
const MAX_INPUT_CHARS = 2000;

// Splits long text into chunks small enough for one prompt each. We process
// every chunk instead of truncating, otherwise anything past the cutoff is
// silently invisible to the model (a 10-question exam would only ever yield
// the first few). Boundaries prefer line breaks so a task isn't cut in half.
function chunkForAI(text, chunkSize = MAX_INPUT_CHARS) {
    if (!text) return [];
    if (text.length <= chunkSize) return [text];

    const chunks = [];
    let index = 0;
    while (index < text.length) {
        let end = Math.min(index + chunkSize, text.length);
        if (end < text.length) {
            const lastBreak = text.lastIndexOf('\n', end);
            if (lastBreak > index + chunkSize * 0.5) end = lastBreak; // only if it isn't a tiny chunk
        }
        chunks.push(text.slice(index, end));
        index = end;
    }
    return chunks;
}

// NOTE (bug fix): this used to talk to Ollama directly and completely bypassed
// aiProvider.js - meaning every caller of this function (task urgency, event
// type classification, task extraction from PDFs, etc.) could NEVER use
// Gemini, even when the user had a Gemini key configured in Settings, and
// would hard-fail with "Ollama is not running" on any machine without Ollama
// installed. That's why "Add Task" worked on one machine and not another: it
// depended on whether Ollama happened to be running locally, not on the AI
// provider actually configured in the app.
//
// aiProvider.generateText() already implements the right policy (Gemini
// first when a key exists, Ollama as fallback/offline option), so this is now
// a thin adapter that keeps the existing call signature every caller here
// already uses, instead of a second, parallel AI implementation.
async function callAIWithFallback(prompt, systemOverride = null, maxTokens = MAX_OUTPUT_TOKENS, forceJson = false) {
    return aiProvider.generateText(prompt, {
        system: systemOverride,
        maxTokens,
        forceJson,
        localModel: LOCAL_MODEL
    });
}

// Best-effort recovery if the model insists on JSON anyway (e.g. its
// Modelfile bakes in a system prompt that overrides everything). Tries to
// pull readable text out of common shapes instead of showing raw JSON.
function coerceToPlainText(text) {
    const trimmed = (text || '').trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text; // already plain text

    try {
        const parsed = JSON.parse(extractJsonFromText(trimmed));
        if (typeof parsed === 'string') return parsed;
        if (Array.isArray(parsed)) {
            // Array of strings, or array of objects with a text-like field
            return parsed
                .map((item) => (typeof item === 'string' ? item : item.summary || item.text || item.content || JSON.stringify(item)))
                .map((line) => `• ${line}`)
                .join('\n');
        }
        if (parsed && typeof parsed === 'object') {
            const candidate = parsed.summary || parsed.text || parsed.content || parsed.result;
            if (typeof candidate === 'string') return candidate;
        }
    } catch (e) {
        // wasn't valid JSON after all - fall through and return the original text
    }
    return text;
}

function extractJsonFromText(text) {
    const firstCurly = text.indexOf('{');
    const lastCurly = text.lastIndexOf('}');
    const firstSquare = text.indexOf('[');
    const lastSquare = text.lastIndexOf(']');

    let start = -1;
    let end = -1;

    if (firstCurly !== -1 && firstSquare !== -1) {
        if (firstCurly < firstSquare) { start = firstCurly; end = lastCurly; }
        else { start = firstSquare; end = lastSquare; }
    } else if (firstCurly !== -1) {
        start = firstCurly; end = lastCurly;
    } else if (firstSquare !== -1) {
        start = firstSquare; end = lastSquare;
    }

    if (start !== -1 && end !== -1) {
        return text.substring(start, end + 1);
    }
    return text; 
}

// =====================================
// AI Operations (Smart Inputs)
// =====================================
ipcMain.handle('summarize-text', async (event, textToSummarize, sourcePath) => {
    try {
        const SUMMARY_MAX_OUTPUT_TOKENS = 2000;

        // BUG FIX: this always summarized the pre-extracted text (readPdf()
        // at upload time - the lossy pdfjs/pdf2json path, source of the
        // "Page (0) Break" / mangled-formula complaints) even though
        // generateFromPdf() (vision, reads the actual file, no extraction)
        // already exists and is used for study-item generation. There was
        // no reason Summarize couldn't use the same good path. When we have
        // the original file and Gemini is available, read it directly.
        if (sourcePath && fs.existsSync(sourcePath) && aiProvider.supportsVision()) {
            try {
                const buffer = fs.readFileSync(sourcePath);
                const sizeMb = buffer.length / (1024 * 1024);
                if (sizeMb <= 18) { // inline request body cap, same limit as generate-study-items-pdf
                    const visionPrompt = `You are a smart learning assistant for a student. Summarize this document clearly, in short and concise bullet points. Highlight important concepts, and preserve any formulas/equations exactly as shown rather than describing them.
Write every formula in LaTeX: inline formulas between single dollar signs ($\\bar{x}$), and standalone formulas on their own line between double dollar signs ($$...$$). The summary window renders these as real notation.
IMPORTANT: Write the summary in the same language as the document.`;
                    const raw = await aiProvider.generateFromPdf(buffer, visionPrompt, {
                        maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
                        thinkingLevel: 'low'
                    });
                    console.log('📝 summarize-text: used vision (direct PDF read)');
                    return coerceToPlainText(raw);
                }
            } catch (visionErr) {
                // Gemini unavailable or failed (no key, rate limit, transient
                // 503...) - fall through to the text-based path below rather
                // than erroring out. Quality drops to what it always was
                // before this fix, which still beats a hard failure.
                console.warn('⚠️ Vision summary failed, falling back to extracted text:', visionErr.message);
            }
        }

        console.log(`📝 summarize-text: received ${(textToSummarize || '').length} chars`);
        // BUG FIX: this was truncating to MAX_INPUT_CHARS (2000 - about one
        // paragraph) before the AI ever saw the document, and capping the
        // reply at the generic MAX_OUTPUT_TOKENS (800), both of which are
        // sized for short classification prompts, not "summarize this
        // document". A genuinely long file got summarized from roughly its
        // first page only, into a couple of sentences - which is exactly
        // "we uploaded a long file and it barely summarized anything".
        // Neither number is a hard ceiling the models can't handle - Gemini
        // in particular reads far more than this comfortably - so both are
        // raised specifically for summaries rather than reusing the general
        // defaults built for short prompts.
        const SUMMARY_MAX_INPUT_CHARS = 15000;

        const safeText = textToSummarize && textToSummarize.length > SUMMARY_MAX_INPUT_CHARS
            ? textToSummarize.slice(0, SUMMARY_MAX_INPUT_CHARS) + '\n\n[...document truncated...]'
            : (textToSummarize || '');

        const prompt = `You are a smart learning assistant for a student. Summarize the following study material clearly, in short and concise bullet points. Highlight important concepts. 
Write every formula in LaTeX: inline between single dollar signs, standalone formulas on their own line between double dollar signs ($$...$$).
IMPORTANT: Write the summary in the same language as the original text:

${safeText}`;
        const plainTextSystem = "You are a helpful writing assistant. Respond with plain natural-language text only. Do NOT respond with JSON, a code block, markdown fences, or any key-value/structured format - just the summary text itself, formatted as readable bullet points using '-' or '*'.";
        const rawResponse = await callAIWithFallback(prompt, plainTextSystem, SUMMARY_MAX_OUTPUT_TOKENS);
        return coerceToPlainText(rawResponse);
    } catch (error) {
        console.error("AI Error:", error);
        // Returned as a structured error (not a string that looks like a
        // summary) so the summary window never saves "Oops..." to the file.
        return { error: error.message };
    }
});

// Verifies that a task the model produced is actually grounded in the source
// text, by checking that its claimed sourceQuote really appears there. This is
// the guard against the model "planning" instead of extracting - e.g. inventing
// "review the literature" and "collect data" from a document that only says
// "submit the paper by 14.9". Comparison is loose on whitespace/punctuation
// because models rarely reproduce a quote byte-perfectly.
function normalizeForMatch(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[\s\u00A0]+/g, ' ')
        .replace(/["'`.,:;!?()\[\]־–—-]/g, '')
        .trim();
}

function isGroundedInSource(quote, sourceText) {
    const q = normalizeForMatch(quote);
    if (!q || q.length < 4) return false; // too short to be meaningful evidence
    const src = normalizeForMatch(sourceText);
    if (src.includes(q)) return true;

    // Word overlap fallback, with the same Hebrew handling used for study
    // questions. The original version compared whole tokens at a 0.8
    // threshold, which is far too strict for Hebrew: prefixes (ב/ל/ה/מ/ו/ש/כ)
    // attach to words, so "בלוחות" in the source failed to match "לוחות" in
    // the quote and legitimate instructions like
    // "בנו את לוחות האמת של הפסוקים הבאים" were discarded as invented.
    const words = q.split(' ').filter(w => w.length > 1);
    if (words.length === 0) return false;

    const present = words.filter(w => {
        if (src.includes(w)) return true;
        const stem = w.replace(/^(ב|ל|ה|מ|ו|ש|כ)/, '');
        if (stem.length > 2 && src.includes(stem)) return true;
        // Also try the other direction: quote has the bare word, source has
        // it prefixed.
        return ['ב', 'ל', 'ה', 'מ', 'ו', 'ש', 'כ'].some(p => src.includes(p + w));
    }).length;

    return present / words.length >= 0.65;
}

// Grounding check for GENERATED QUESTIONS, which needs different rules from
// the one used for extracted tasks.
//
// A task title tends to echo the source wording, so comparing it directly to
// the document works. A question is a *reformulation by design* - "What is the
// main purpose of using a queue?" will never appear verbatim in a document
// about queues. Falling back to matching the question text therefore rejected
// almost every perfectly valid question.
//
// So: verify the sourceQuote when the model supplies one, and otherwise fall
// back to the ANSWER, which does tend to reuse the source's own terms.
// The threshold is also looser than for tasks, because Hebrew prefixes
// (ב/ל/ה/מ/ו) change word forms and depress exact-token overlap.
function isQuestionGrounded(item, sourceText) {
    const src = normalizeForMatch(sourceText);

    const check = (text, threshold) => {
        const t = normalizeForMatch(text);
        if (!t || t.length < 6) return false;
        if (src.includes(t)) return true;

        const words = t.split(' ').filter(w => w.length > 2);
        if (words.length === 0) return false;

        // Match on stems: a source containing "בתור" should satisfy a quote
        // word of "תור". Comparing whole tokens misses this constantly.
        const present = words.filter(w => {
            if (src.includes(w)) return true;
            const stem = w.replace(/^(ב|ל|ה|מ|ו|ש|כ)/, '');
            return stem.length > 2 && src.includes(stem);
        }).length;

        return present / words.length >= threshold;
    };

    // The quote must be genuinely present, since for recall/explain items it
    // becomes the answer the student sees. A fabricated quote would be a
    // fabricated answer.
    if (item.sourceQuote && check(item.sourceQuote, 0.6)) return true;

    // Practice items don't show an answer, so a missing quote is survivable
    // as long as the question itself clearly comes from this text.
    if (item.mode === 'practice' && check(item.question, 0.5)) return true;

    return false;
}


// ==========================================
// Hebrew PDF text repair
// ==========================================
// pdf2json emits text runs in visual order. For right-to-left scripts that
// scrambles the result: sentence-final punctuation lands at the START of the
// next sentence, and word order within a line can be reversed outright.
//
// This is why a perfectly faithful quote came out as
//   ".זהו סימן במטא שפה .איננו קשר לוגי"
// The model quoted correctly; the text was already broken before it saw it.

// Removes slide list numbering ("3.", "4)") from a line.
//
// RTL extraction pushes the number to the END of the line, where clause
// reordering then strands it mid-sentence - producing answers like
// "אם היום יום שלישי. 3, אז יש משחק בליגת האלופות". It has to come off
// before the clauses are reversed, not after.
function stripListMarkers(line) {
    let t = String(line || '').trim();
    t = t.replace(/[\s.]*\b\d{1,2}\s*\.?\s*$/, '');   // trailing "3" / "3." / ". 3"
    t = t.replace(/^\s*\d{1,2}\s*[.)]\s*/, '');         // leading "3." / "3)"
    return t.trim();
}

// Reverses clause order on lines the extractor emitted backwards.
//
// The signature is a comma that PRECEDES a clause instead of following one:
//   "אז יש משחק בליגת האלופות ,אם היום יום שלישי."
// which is the correct sentence with its clauses in reverse:
//   "אם היום יום שלישי, אז יש משחק בליגת האלופות."
//
// Because the reversal is a permutation, it's undoable - this recovers the
// original text rather than discarding it, which matters because these are
// exactly the worked examples a lecture is built around.
function repairReversedClauses(line) {
    const t = String(line || '').trim();
    const hebrewChars = (t.match(/[\u0590-\u05FF]/g) || []).length;
    if (hebrewChars < 5) return t;

    // Only act on the artifact: " ,word" rather than "word, ".
    if (!/\s+[,;]\s*(?=[\u0590-\u05FF])/.test(t)) return t;

    const parts = t.split(/\s+[,;]\s*/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return t;

    // Keep sentence-final punctuation attached to what becomes the last clause.
    const last = parts[parts.length - 1];
    const trailing = /[.!?]$/.test(last) ? last.slice(-1) : '';
    if (trailing) parts[parts.length - 1] = last.slice(0, -1).trim();

    return parts.reverse().join(', ') + (trailing || '');
}

function repairHebrewPdfText(text) {
    if (!text) return '';

    return String(text).split('\n').map(line => {
        const hebrewChars = (line.match(/[\u0590-\u05FF]/g) || []).length;
        const dense = line.replace(/\s/g, '').length;
        // Only touch lines that are actually Hebrew - never rewrite code,
        // formulas or English.
        if (hebrewChars < 3 || dense === 0 || hebrewChars / dense < 0.3) return line;

        // Order matters: numbering comes off first, otherwise reversing the
        // clauses drags it into the middle of the sentence.
        let t = repairReversedClauses(stripListMarkers(line));

        // Move a terminator that leads a Hebrew segment onto the previous one.
        const parts = t.split(/(?<=[\u0590-\u05FF])\s*\.\s*/).filter(Boolean);
        if (parts.length > 1) {
            t = parts.map(p => p.trim().replace(/^[.,;:]\s*/, '')).join('. ');
            if (!/[.!?]$/.test(t)) t += '.';
        } else {
            t = t.replace(/^\s*[.,;:]\s*/, '').trim();
        }

        return t.replace(/\s{2,}/g, ' ');
    }).join('\n');
}

// Detects text whose word order was scrambled badly enough that no
// post-processing can recover it. Such passages must not be shown as answers
// - a garbled answer is worse than admitting we don't have one.
function looksMangled(text) {
    const t = String(text || '');
    const hebrewChars = (t.match(/[\u0590-\u05FF]/g) || []).length;
    if (hebrewChars < 5) return false;

    // Hebrew prefixes (ל ב כ מ ו ה ש) always attach to the following word.
    // Finding them standing alone means the tokens were reordered.
    const orphanPrefixes = (t.match(/(^|\s)[לבכמוהש](\s|$)/g) || []).length;
    if (orphanPrefixes >= 2) return true;

    // Punctuation still leading a Hebrew word after repair. A comma is
    // excluded here because repairReversedClauses() now handles that case;
    // flagging it again would reject text we just successfully recovered.
    if (/(^|\s)[.;:]\s*[\u0590-\u05FF]/.test(t)) return true;

    // Latin letters spliced into the middle of a Hebrew word (e.g. "hוך")
    // indicate the run boundaries themselves were interleaved - not fixable.
    if (/[\u0590-\u05FF][a-zA-Z]|[a-zA-Z][\u0590-\u05FF]/.test(t)) return true;

    // NOTE: a mid-sentence ellipsis is NOT treated as damage. It is almost
    // always the model abbreviating a long quote, and expandTruncatedQuote()
    // has already had a chance to restore it. Flagging it here rejected a
    // large amount of perfectly good material.

    return false;
}


// Recovers the full passage when the model abbreviated a quote with "...".
//
// The model routinely shortens long quotes ("כל מחרוזת סופית... היא מילה").
// That ellipsis was being misread as PDF garbling and the item discarded -
// but nothing is actually damaged: the complete passage is still sitting in
// the source. We locate the fragments either side and lift the whole span.
function expandTruncatedQuote(quote, sourceText) {
    const q = String(quote || '');
    if (!/\.{2,}|…/.test(q)) return q;

    const srcNormForTail = normalizeForMatch(sourceText);

    // Trailing ellipsis: the passage was cut off at the end rather than in the
    // middle ("אם ידוע שכל סטודנט לומד לפחות את אחד..."). There's only one
    // fragment, so the mid-quote logic below never fired and the sentence was
    // left hanging. Locate the fragment and read forward from it instead.
    if (/(?:\.{2,}|…)\s*$/.test(q)) {
        const head = normalizeForMatch(q.replace(/\s*(?:\.{2,}|…)\s*$/, ''));
        if (head.length > 8) {
            const at = srcNormForTail.indexOf(head);
            if (at !== -1) {
                const forward = srcNormForTail.slice(at, at + head.length + 260);
                // Stop at a sentence end so we don't trail into the next topic.
                const cut = forward.search(/[.!?](\s|$)/);
                const result = cut > head.length ? forward.slice(0, cut + 1) : forward;
                return result.trim();
            }
        }
        return q;
    }

    const pieces = q.split(/\s*(?:\.{2,}|…)\s*/).map(p => p.trim()).filter(p => p.length > 4);
    if (pieces.length < 2) return q;

    const srcNorm = normalizeForMatch(sourceText);
    const first = normalizeForMatch(pieces[0]);
    const last = normalizeForMatch(pieces[pieces.length - 1]);

    const start = srcNorm.indexOf(first);
    if (start === -1) return q;
    const endIdx = srcNorm.indexOf(last, start + first.length);
    if (endIdx === -1) return q;

    const span = srcNorm.slice(start, endIdx + last.length);
    // Guard against a loose match swallowing half the document.
    if (span.length > q.length * 4 || span.length > 400) return q;
    return span;
}




// NOTE ON \b AND HEBREW:
// JavaScript's \b is defined over [A-Za-z0-9_], so it never matches at the
// boundary of a Hebrew word - every Hebrew term wrapped in \b silently fails.
// This check uses explicit non-letter lookarounds instead. An earlier version
// used \b and therefore rejected valid passages like
// "פסוקים יסודיים אטומים נסמן באותיות קטנות" as if they had no verb.
const HEBREW_EXPLANATORY = /(?:^|[^\u0590-\u05FFa-zA-Z])(הוא|היא|הם|הן|נקרא|נקראת|נסמן|מסמנים|מוגדר|מוגדרת|מקבל|מתקבל|פירושה|פירושו|כלומר|כאשר|ניתן|אין|יש|מהווה|תהווה|אם ורק אם)(?:$|[^\u0590-\u05FFa-zA-Z])/;
const LATIN_EXPLANATORY = /\b(is|are|means|refers|defined|denotes)\b/i;

function hasExplanatoryVerb(text) {
    const t = String(text || '');
    return HEBREW_EXPLANATORY.test(t) || LATIN_EXPLANATORY.test(t);
}

// Pulls in the text that follows a quote ending in ':'.
//
// A colon announces content rather than delivering it: "עליה למלא שתי דרישות:"
// tells you requirements exist and nothing about what they are. The
// continuation is right there in the source, so complete the passage instead
// of discarding it.
function completeAfterColon(quote, sourceText) {
    const q = String(quote || '').trim();
    if (!/[:：]\s*$/.test(q)) return q;

    const srcN = normalizeForMatch(sourceText);
    const qN = normalizeForMatch(q);
    const idx = srcN.indexOf(qN);
    if (idx === -1) return q;

    const after = srcN.slice(idx + qN.length).trim();
    if (!after) return q;

    return (q + ' ' + after.slice(0, 220).trim()).trim();
}

// Detects a slide title being quoted as though it were an explanation.
// "Modus Ponens כלל ההיסק" names the topic; it doesn't say what the rule is.
function looksLikeHeading(text) {
    const t = String(text || '').trim();
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 6) return false;
    if (hasExplanatoryVerb(t)) return false;
    if (/[.!?]$/.test(t)) return false;   // a finished sentence, not a heading
    return true;
}

// Detects agenda / table-of-contents slides.
//
// Such a slide lists the topics a lecture will cover, so it contains all the
// right keywords and none of the explanations. The model happily quotes it:
//   Q: "מהי טופולוגיית רשת פיזית?"
//   A: "סוגי רשתות לפי מרחקים נושאי ההרצאה◦ ארכיטקטורות בסיסיות◦ טופולוגיות"
// The word is there; the meaning never is. A keyword match can't tell the
// difference, but the shape of the text can.
function looksLikeOutline(text) {
    const t = String(text || '').trim();
    if (!t) return false;

    if (/נושאי ההרצאה|תוכן העניינים|תוכן ההרצאה|סדר היום|בהרצאה זו נלמד|agenda|outline|table of contents|in this lecture/i.test(t)) {
        return true;
    }

    // Dense bullet markers separating short fragments.
    const bullets = (t.match(/[◦•▪●‣·]|^\s*[-–]\s/gm) || []).length;
    if (bullets >= 2) {
        const segments = t.split(/[◦•▪●‣·\n]|(?:^|\s)[-–]\s/).map(x => x.trim()).filter(Boolean);
        const shortOnes = segments.filter(x => x.split(/\s+/).length <= 5).length;
        if (segments.length >= 3 && shortOnes / segments.length >= 0.6) return true;
    }

    // Noun phrases with no explanatory verb: a topic list, not a definition.
    const hasExplanatory = hasExplanatoryVerb(t);
    const wordCount = t.split(/\s+/).length;
    if (!hasExplanatory && wordCount <= 14 && bullets >= 1) return true;

    return false;
}

// Checks that the quote actually addresses what the question asks about.
//
// The RTL fix cleaned up the text, so quotes are no longer garbled - but the
// model can still pick the WRONG passage. Two real failures:
//   Q: "מהי משמעות הסימון ∨ ?"      A: a passage about connectives generally,
//                                      which never shows ∨ at all.
//   Q: "האם 'מה השעה?' נחשב לפסוק?" A: the slide's list of examples, i.e. the
//                                      question echoed back, with no answer.
//
// Deliberately only two rules, both precise. A third heuristic comparing
// keyword overlap between question and quote was tried and dropped: it
// rejected good pairs like ("מהי משמעות הסימון ∨", "הקשר ∨ (או) מקבל ערך אמת
// כאשר...") because the answer legitimately doesn't repeat the question's
// wording. A relevance check that discards correct answers is worse than none.
function quoteAnswersQuestion(question, quote) {
    const q = String(question || '');
    const a = String(quote || '');

    // 1. A symbol named in the question must appear in the quote.
    const symbols = q.match(/[∨∧¬→↔⊕⊨⊢∀∃∈⊆∪∩≡≠≤≥]/g) || [];
    for (const sym of symbols) {
        if (!a.includes(sym)) return { ok: false, why: `quote never shows the symbol ${sym}` };
    }

    // 2. If the question quotes a phrase, the passage must say something
    //    BEYOND repeating that phrase, or it answers nothing.
    const quotedPhrases = q.match(/['"״](.+?)['"״]/g) || [];
    if (quotedPhrases.length > 0) {
        let stripped = normalizeForMatch(a);
        quotedPhrases.forEach(p => {
            stripped = stripped.replace(normalizeForMatch(p.slice(1, -1)), '');
        });
        stripped = stripped.replace(/\d+/g, '').trim();
        const remaining = stripped.split(/\s+/).filter(w => w.length > 1).length;
        if (remaining < 5) {
            return { ok: false, why: 'quote only repeats the phrase from the question' };
        }
    }

    return { ok: true };
}



// Rejects answer passages damaged beyond use, or that carry no actual content.
//
// Three failures remained after the RTL fix, all in formula-heavy slides:
//
//  1. Font-mapping damage. Some PDFs embed fonts whose glyph-to-unicode table
//     is wrong, so the extractor emits real-looking but meaningless Hebrew
//     ("חרילן פסכו"). This is NOT a bidi problem and no reordering fixes it -
//     the characters themselves are wrong. It shows up as a Hebrew letter
//     fused directly onto a math glyph with no space ("חמב𝑖"), which never
//     happens in clean text.
//  2. Formula-only passages, which state a result without explaining it.
//  3. Model placeholders like "(...)".
function analyseAnswerText(text) {
    const t = String(text || '');
    const noSpace = t.replace(/\s/g, '');
    if (noSpace.length === 0) return { reject: true, why: 'empty passage' };

    if (/^\s*\(?\.{2,}\)?/.test(t) || /\(\s*\.{3}\s*\)/.test(t)) {
        return { reject: true, why: 'passage is a placeholder, not text' };
    }

    // Hebrew letter fused to a math alphanumeric = broken font mapping.
    if (/[\u0590-\u05FF][\u{1D400}-\u{1D7FF}]|[\u{1D400}-\u{1D7FF}][\u0590-\u05FF]/u.test(t)) {
        return { reject: true, why: 'text damaged by the PDF font encoding' };
    }

    const mathChars = (t.match(/[∨∧¬→↔⊕⊨⊢∀∃∈⊆∪∩≡≠≤≥⋀⋁⋯…±×÷√∑∏∫⎬⎫]|[\u{1D400}-\u{1D7FF}]/gu) || []).length;
    const words = t.match(/[\u0590-\u05FF]{3,}|[A-Za-z]{3,}/g) || [];
    const mathRatio = mathChars / noSpace.length;

    if (mathRatio > 0.25 && words.length < 6) {
        return { reject: true, why: `mostly formula (${Math.round(mathRatio * 100)}% symbols)` };
    }
    if (words.length < 3) {
        return { reject: true, why: 'passage has almost no prose' };
    }

    // An exercise statement quoted as an answer. These show up when the file
    // is a problem sheet rather than notes: the model finds no definition to
    // quote, so it grabs a whole question instead - complete with its data.
    // A run of numbers, or a question mark inside the "answer", gives it away.
    const dataRun = /(?:\b\d+[\s,]+){4,}\d+/.test(t);
    if (dataRun) {
        return { reject: true, why: 'passage is an exercise statement, not an explanation' };
    }
    if (t.length > 400) {
        return { reject: true, why: 'passage too long to be a definition' };
    }
    if (/[?？]/.test(t) && t.length > 120) {
        return { reject: true, why: 'passage is itself a question' };
    }

    return { reject: false };
}

// Rejects questions about the anecdote rather than the concept.
//
// Course material wraps ideas in motivating stories - the Konigsberg bridges,
// who proved what, which year. The story earns its place in a lecture; it has
// no place in revision. "In which city was the bridge problem set?" is trivia,
// while "what condition must a graph satisfy to have an Euler path?" is the
// thing the story exists to introduce.
function isHistoricalTrivia(question) {
    const q = String(question || '');

    const triviaShapes = [
        /באיזו (עיר|שנה|מדינה|ארץ|תקופה)/,
        /באיזה (מקום|זמן|עידן|יום)/,
        /מתי (התרחש|התגלה|הוכח|נוסח|חי|נולד)/,
        /מי (גילה|הוכיח|ניסח|פיתח|המציא|היה)/,
        /על שם (מי|של מי)/,
        /in (which|what) (city|year|country|century)/i,
        /who (discovered|proved|invented|formulated|was)/i,
        /when (was|did) .* (discovered|proved|invented)/i,
        // Course admin, which is not knowledge either.
        /מתי (יש|צריך) להגיש/, /מה (מרכיב|משקל) הציון/, /שעות קבלה/
    ];

    return triviaShapes.some(p => p.test(q));
}

// Rejects questions that only make sense while looking at the source.
//
// This is the "מהי המטרה של הפונקציה שתוכתב?" problem: perfectly sensible
// while the exam paper is in front of you, meaningless a week later in a
// review session. A study question has to carry its own context, because by
// definition you meet it without the document.
function isSelfContained(question) {
    const q = String(question || '');

    // Deictic references - they point at something outside the question.
    const danglingRefs = [
        'הפונקציה שתוכתב', 'הפונקציה הנתונה', 'הפונקציה המתוארת',
        'בטקסט', 'לפי הטקסט', 'כפי שמוזכר', 'כמתואר', 'כנדרש',
        'בתרגיל', 'בשאלה', 'בסעיף', 'במבחן', 'הנ"ל', 'המצורף',
        'as mentioned', 'in the text', 'according to the text',
        'the given function', 'the above', 'the following exercise'
    ];
    if (danglingRefs.some(r => q.includes(r))) return false;

    // "What is the output of the function?" fails the same way, more subtly:
    // a definite noun ("the function", "the algorithm") with nothing naming
    // WHICH one. If the question mentions a bare definite subject and is
    // short enough to have no other anchor, it can't stand alone.
    const bareSubjects = ['הפונקציה', 'האלגוריתם', 'המערך', 'התוכנית', 'הקוד', 'המבנה'];
    const wordCount = q.trim().split(/\s+/).length;
    if (wordCount <= 8 && bareSubjects.some(b => q.includes(b))) return false;

    if (/^מה(י|ו|ה)?\s+(המטרה|התפקיד|הפלט|הקלט|הדרישה)\s*(של\s*(ה\w+)?)?\s*\??$/.test(q.trim())) return false;

    // Too short to carry context.
    if (q.trim().length < 15) return false;

    return true;
}

// Rejects questions that ask about the CONSTRAINTS of one specific exercise
// rather than about knowledge worth carrying.
//
// "What data type do the elements use?" / "Is it allowed to modify the
// original list?" are properties of exercise 3 on one exam paper. Nobody
// needs to remember them, and they teach nothing. They pass the
// self-containment check while still being worthless, so they need their own
// filter.
// Rejects recall questions that demand reasoning, because the answer we show
// is a quoted passage. "Can we conclusively infer X? Explain" cannot be
// answered by a sentence lifted from a slide - the question and the answer
// are different kinds of thing, and the student gets a quote that doesn't
// address what was asked.
function needsReasoningNotQuote(question, mode) {
    // Applies to any mode where a quoted passage is SHOWN as the answer.
    // Only 'practice' shows no answer, so only it is exempt. Previously this
    // let 'explain' through - but explain items do display a quote, so a
    // reasoning question still ended up paired with a passage that answers
    // something else.
    if (mode === 'practice') return false;
    const q = String(question || '');
    const reasoningAsks = [
        // "explain your answer" appears in many forms - תשובתך, התשובה שלך,
        // את תשובתך - so match the stem rather than one exact phrasing.
        /הסבר(\s+את)?\s+(את\s+)?תשוב/, /הסביר(י)?\s+את\s+תשוב/,
        /הסבר מדוע/, /נמק/, /הוכח/, /הוכיחו/,
        /האם ניתן להסיק/, /האם תמיד/, /מדוע (זה|הדבר|כך)/,
        /הסבר את התהליך/, /תאר את התהליך/,
        /explain (your )?(answer|reasoning|the process)/i, /justify/i, /prove that/i, /why (is|does|do)/i
    ];
    return reasoningAsks.some(p => p.test(q));
}

function isExerciseTrivia(question, answer) {
    const q = String(question || '');

    const triviaPatterns = [
        /סוג הנתונים|טיפוס הנתונים|איזה טיפוס/,
        /האם מותר (לשנות|להשתמש)/,
        /האם ניתן לשנות/,
        /מה (מותר|אסור)/,
        /כמה נקודות/,
        /מה נדרש להחזיר|מה הפונקציה מחזירה\s*\?$/,
        /what data type|is it allowed to|how many points/i
    ];
    if (triviaPatterns.some(p => p.test(q))) return true;

    // A one- or two-word answer to a "what is" question is almost always a
    // parameter of the exercise rather than a concept.
    const a = String(answer || '').trim();
    if (a && a.split(/\s+/).length <= 3 && /^(מהו|מהי|מה)\s/.test(q)) return true;

    return false;
}

// Decides whether a document is teaching material or an assignment sheet.
// They need completely different treatment: from a textbook you generate
// recall questions, but from an exam paper the EXERCISE ITSELF is the study
// item - generating trivia about the exercise is noise.
function looksLikeExercisePaper(text) {
    const t = String(text || '').toLowerCase();
    const markers = [
        'עליכם לממש', 'עליך לממש', 'כתבו פונקציה', 'כתוב פונקציה', 'ממשו',
        'זמן הריצה', 'סיבוכיות', 'אין לשנות', 'מותר להשתמש',
        'שאלה 1', 'שאלה 2', 'סעיף א', 'סעיף ב', 'נקודות)',
        'implement a function', 'write a function', 'time complexity'
    ];
    const hits = markers.filter(m => t.includes(m)).length;
    return hits >= 2;
}

// Strips multiple-choice scaffolding. The model still occasionally emits
// options despite being told not to, and a question ending in "choose one:"
// with no options is worse than useless.
function stripMultipleChoice(question) {
    return String(question || '')
        .replace(/\s*(בחר\s*(אחת|אחד)|choose\s*one|select\s*one)\s*[:：]?\s*$/i, '')
        .replace(/\s*[\u0590-\u05FF]\s*\)\s*.+$/gm, '') // stray "א) ..." lines
        .trim();
}

// Turns a model-supplied ISO date into (a) a display label and (b) an urgency
// level derived purely from how many days away it is. Keeping this in code
// rather than in the prompt means urgency always has a real basis: if there's
// no date in the document, there's no urgency claim either.
function resolveDueDate(rawDate) {
    if (!rawDate || typeof rawDate !== 'string') {
        return { label: 'Not set', urgency: 'Normal' };
    }

    const parsed = new Date(rawDate);
    if (isNaN(parsed.getTime())) {
        return { label: 'Not set', urgency: 'Normal' };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    parsed.setHours(0, 0, 0, 0);

    const daysAway = Math.round((parsed - today) / (1000 * 60 * 60 * 24));
    const label = parsed.toLocaleDateString('en-GB'); // DD/MM/YYYY

    let urgency;
    if (daysAway < 0) urgency = 'Urgent';        // already overdue
    else if (daysAway <= 1) urgency = 'Urgent';  // today or tomorrow
    else if (daysAway <= 3) urgency = 'High';
    else if (daysAway <= 7) urgency = 'Medium';
    else urgency = 'Normal';

    return { label, urgency };
}

ipcMain.handle('extract-tasks-from-text', async (event, textToExtract) => {
    try {
        console.log(`📄 extract-tasks-from-text: received ${(textToExtract || '').length} chars`);
        const chunks = chunkForAI(textToExtract);
        console.log(`📄 Split into ${chunks.length} chunk(s)`);

        const seen = new Set();
        const allTasks = [];
        let rejectedCount = 0;
        let lastChunkError = null;
        let anyChunkSucceeded = false;

        for (let i = 0; i < chunks.length; i++) {
            console.log(`📄 Processing chunk ${i + 1}/${chunks.length}...`);

            const todayISO = new Date().toISOString().slice(0, 10);
            const prompt = `You are a text extraction tool. Today's date is ${todayISO}.
Your ONLY job is to COPY tasks that are literally written in the text below. You are FORBIDDEN from inferring, planning, or adding steps.

CRITICAL RULES - read carefully:
- Do NOT invent sub-steps. If the text says "submit a paper", that is ONE task. Do NOT add "research the literature", "collect data", "prepare slides" or any other step that is not written in the text.
- Do NOT use your general knowledge about how such work is usually done.
- If the text contains only 1 task, return exactly 1 task. Returning fewer correct tasks is much better than adding invented ones.
- Every task MUST appear word-for-word in the text.

A TASK is something with a DEADLINE or a SUBMISSION attached: an assignment to hand in, a project, a form to file, a reading due by a date.

Exam and worksheet QUESTIONS are NOT tasks. "Solve question 3", "prove the theorem", "find the DNF of..." are things you practise, not things you tick off a to-do list. They belong to study material. Extracting them buries the real deadlines under dozens of exercises, which is the opposite of what a task list is for.
If this document is an exam paper or a worksheet, it most likely contains NO tasks at all - return {"tasks": []} rather than converting its questions.

Never extract: exam questions, multiple-choice answer options, exam instructions, boilerplate ("good luck", "answer all questions"), headers, page numbers.

Return a JSON object with a single key "tasks" whose value is an array. Each item must have:
- "title": the task, in the original language, copied closely from the text.
- "sourceQuote": the EXACT substring from the text below that this task came from. Copy it character for character. If you cannot find such a substring, do not include this task at all.
- "dueDate": the deadline in "YYYY-MM-DD" format, ONLY if explicitly stated in the text (resolve "מחר"/"tomorrow" against today's date above). If no deadline is stated, use null. Never guess a date.

If the text contains no tasks at all, return {"tasks": []}.

Text:
${chunks[i]}`;

            let parsed;
            try {
                const responseText = await callAIWithFallback(prompt, null, MAX_OUTPUT_TOKENS, true);
                parsed = JSON.parse(extractJsonFromText(responseText));
                anyChunkSucceeded = true;
            } catch (chunkErr) {
                // One bad chunk shouldn't sink the whole import - log it and
                // keep going with the rest of the document. But if this is
                // the ONLY thing that ever happens (every chunk fails), that
                // failure needs to reach the user - see below.
                console.error(`⚠️ Chunk ${i + 1} failed, skipping it:`, chunkErr.message);
                lastChunkError = chunkErr.message;
                continue;
            }

            if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.tasks)) parsed = parsed.tasks;
            if (!Array.isArray(parsed)) parsed = [parsed];

            for (const t of parsed) {
                let task;
                // Urgency is DERIVED from the extracted deadline, never taken
                // from the model directly. The model's only job is to report a
                // date that actually appears in the text; how urgent that makes
                // the task is arithmetic, so it's done here where it can't be
                // hallucinated. No date in the text => no urgency signal =>
                // 'Normal', and the user can set it themselves.
                if (typeof t === 'string') {
                    task = { title: t, date: 'Not set', urgency: 'Normal' };
                } else if (t && t.title) {
                    // Grounding check: reject anything the model couldn't point
                    // to in the source. This is what stops it from turning
                    // "submit the paper" into a five-step research plan.
                    if (!isGroundedInSource(t.sourceQuote || t.title, chunks[i])) {
                        console.warn(`   ⛔ Rejected (not found in document): "${t.title}"`);
                        rejectedCount++;
                        continue;
                    }
                    const { label, urgency } = resolveDueDate(t.dueDate);
                    task = { title: String(t.title).trim(), date: label, urgency };
                } else continue;

                const key = task.title.toLowerCase();
                if (!key || seen.has(key)) continue; // dedupe across ALL chunks, not just within one
                seen.add(key);
                allTasks.push(task);
            }
        }

        const finalTasks = allTasks.slice(0, 30);
        console.log(`📄 extract-tasks-from-text: returning ${finalTasks.length} grounded task(s) from ${chunks.length} chunk(s)` + (rejectedCount > 0 ? ` (${rejectedCount} invented item(s) rejected)` : ''));

        if (finalTasks.length === 0) {
            // BUG FIX: this message used to fire whenever nothing came back,
            // whether the document genuinely had no tasks OR every single
            // chunk failed to even reach a model (no Gemini quota, no Ollama
            // running). The second case is a real failure, not "nothing
            // found", and was being told to the user as if the document was
            // just task-free - hiding exactly the information ("the AI
            // couldn't run at all") needed to fix it.
            if (!anyChunkSucceeded && lastChunkError) {
                return JSON.stringify({ error: `Could not read this document: ${lastChunkError}` });
            }
            return JSON.stringify({ error: 'The AI read the document but could not find any clear tasks.' });
        }
        return JSON.stringify(finalTasks);
    } catch (error) {
        console.error('❌ extract-tasks-from-text failed:', error.message);
        return JSON.stringify({ error: error.message });
    }
});

// Reads a duration hint out of free text ("ללמוד 3 שעות למבחן", "שעתיים",
// "חצי שעה", "2 hours") so the weekly planner can size a block correctly
// instead of assuming every task takes exactly one hour. Returns minutes,
// or null when nothing is mentioned.
// Finds the weekday a Hebrew phrase refers to. Shared by add-smart-task and
// parse-smart-event so both understand the same phrasings.
//
// BUG FIX: "בשבת" ("on Saturday") was never recognised. The only standalone
// check was (?<![א-ת])שבת - "no Hebrew letter before it" - and the prefix ב
// IS a Hebrew letter, so the most common way to say it failed silently and
// the event landed on today instead. The add-smart-task copy was worse still,
// using \bשבת\b, which never matches Hebrew at all.
//
// Order still matters: the unambiguous "יום X" / "ביום X" form is checked
// first, then ב + day ("בשבת", "בחמישי"). A bare ordinal without ב
// ("מבחן שני" = "second exam") is deliberately NOT treated as a day, except
// "שבת", which has no ordinal meaning.
function detectHebrewDay(text) {
    const DAYS = 'ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת';
    let m = text.match(new RegExp(`(?:ב?יום)\\s+(${DAYS})(?![א-ת])`));
    if (m) return m[1];
    m = text.match(new RegExp(`(?<![א-ת])ב(${DAYS})(?![א-ת])`));
    if (m) return m[1];
    if (/(?<![א-ת])שבת(?![א-ת])/.test(text)) return 'שבת';
    return null;
}

// Finds a date phrase OTHER than a weekday name (weekdays go through
// detectHebrewDay above). Returns { date, strip } - the resolved date, and
// the regexes that remove the phrase from the title - or null.
//
// Added because tasks now default to TODAY when no date is written, and
// that default is only safe if every real date phrase is recognised first.
// Before this, "מחרתיים" was read as "מחר" (it contains it), and "בעוד
// שבוע" / "ב-20/9" weren't recognised at all - harmless while the fallback
// was "Not set", but with a today-default they'd silently land on the
// wrong day.
// Local calendar date as YYYY-MM-DD. Not toISOString(): that's UTC, and
// in Israel (UTC+2/+3) local midnight is still "yesterday" in UTC.
function toLocalIsoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolveRelativeDate(text, now) {
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);
    const plusDays = (n) => { const d = new Date(base); d.setDate(base.getDate() + n); return d; };
    const H = (w) => `(?<![א-ת])${w}(?![א-ת])`;

    // 1. Explicit date: 20/9, 20/9/2026, 20.09.26, ב-20.9, עד 20.9. Not "1.5 שעות".
    // BUG FIX: a bare "3.2" was read as the 3rd of February - so "לפתור תרגיל
    // 3.2 בספר" became a task due next February (invisible on this week's
    // board) and lost the "3.2" from its title. Students write section and
    // exercise numbers like that all the time. Now a number that follows a
    // word like פרק/תרגיל/סעיף/עמ' (including the rest of a list: "סעיפים
    // 2.3-2.5", "תרגיל 3.2 ו-3.4") is never a date. "מבחן 20.10" still is.
    // matchAll, so a rejected "3.2" doesn't hide a real date later in the
    // text ("תרגיל 3.2 עד 30/9").
    const DATE_RE = /(?<![\d:.])(ב[\s-]?|עד\s+ה?-?|(?<![א-ת])ה-)?(\d{1,2})([./])(\d{1,2})(?:[./](\d{2,4}))?(?![\d:])(?!\s*(?:שע|hour))/g;
    const SECTION_WORD = /(?:פרק|פרקים|תרגיל|תרגילים|סעיף|סעיפים|שאלה|שאלות|עמוד|עמודים|עמ'|יחידה|הרצאה|מטלה|גרסה|chapter|section|exercise|ex\.?|page|p\.)\s*(?:[\d./,\-–\s]|ו)*$/i;
    for (const explicit of text.matchAll(DATE_RE)) {
        const [, prefix, ddStr, , mmStr, yyStr] = explicit;
        // "ב-"/"עד" in front means it IS a date, whatever came before it.
        if (!prefix && SECTION_WORD.test(text.slice(0, explicit.index))) continue;
        const dd = parseInt(ddStr, 10);
        const mm = parseInt(mmStr, 10);
        if (dd < 1 || dd > 31 || mm < 1 || mm > 12) continue;
        let yyyy = yyStr ? parseInt(yyStr, 10) : base.getFullYear();
        if (yyyy < 100) yyyy += 2000;
        let d = new Date(yyyy, mm - 1, dd);
        // No year given and the date already passed more than a week ago:
        // they almost certainly mean next year ("הגשה ב-5/1" in December).
        if (!yyStr && (base - d) > 7 * 86400000) d = new Date(yyyy + 1, mm - 1, dd);
        if (d.getDate() !== dd) continue; // rejects 31/2 and similar
        return { date: d, strip: [new RegExp(explicit[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')] };
    }

    // 2. מחרתיים before מחר - it contains it.
    if (new RegExp(H('מחרתיים')).test(text)) return { date: plusDays(2), strip: [new RegExp(H('מחרתיים'), 'g')] };

    // 3. "בעוד 3 ימים", "בעוד יומיים", "בעוד שבוע", "(ב)שבוע הבא"
    let m = text.match(/בעוד\s+(\d{1,2})\s+ימים/);
    if (m) return { date: plusDays(parseInt(m[1], 10)), strip: [/בעוד\s+\d{1,2}\s+ימים/g] };
    if (/בעוד\s+יומיים/.test(text)) return { date: plusDays(2), strip: [/בעוד\s+יומיים/g] };
    if (/בעוד\s+שבוע|ב?שבוע\s+הבא/.test(text)) return { date: plusDays(7), strip: [/בעוד\s+שבוע|ב?שבוע\s+הבא/g] };

    // 4. מחר
    if (new RegExp(H('מחר')).test(text)) return { date: plusDays(1), strip: [new RegExp(H('מחר'), 'g')] };

    // 5. היום - but not "כל היום" ("all day"), which isn't a date.
    if (new RegExp(`(?<!כל\\s)${H('היום')}`).test(text)) {
        return { date: plusDays(0), strip: [new RegExp(`(?<!כל\\s)${H('היום')}`, 'g')] };
    }
    return null;
}

function parseDurationMinutes(text) {
    if (/חצי\s*שעה/.test(text)) return 30;
    if (/רבע\s*שעה/.test(text)) return 15;
    if (/שעה\s*וחצי/.test(text)) return 90;
    if (/שעתיים/.test(text)) return 120;
    // BUG FIX: (\d+) alone read "1.5 שעות" as "5 שעות" - five hours instead
    // of an hour and a half. Decimals (1.5 / 1,5) are now part of the number.
    let m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:שעות|שעה|hours?|hrs?)(?![א-ת])/i);
    if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    m = text.match(/(\d+)\s*(?:דקות|דק'|דק|minutes?|mins?)(?![א-ת])/i);
    if (m) return parseInt(m[1], 10);
    if (/(?<![א-ת])שעה(?![א-ת])/.test(text)) return 60;
    return null;
}

// Saves a task right away with a default urgency, then classifies the
// urgency in the background and tells the window to refresh when it lands.
// PERFORMANCE: awaiting the AI before saving meant two network round-trips
// before the user saw anything. "Normal" is a safe default - worst case the
// urgency briefly reads one level calmer than it should, never scarier.
async function createTaskWithBackgroundUrgency(task, sender) {
    const created = await api.createTask(task);
    (async () => {
        try {
            const prompt = `Return ONLY a valid JSON object.
Classify the urgency of this task: "${task.title}"
Choose exactly one urgency: "Normal", "Medium", "High", or "Urgent".
Format: {"urgency": "your_choice"}`;
            let responseText = await callAIWithFallback(prompt);
            responseText = extractJsonFromText(responseText);
            const aiData = JSON.parse(responseText);
            if (aiData.urgency && aiData.urgency !== 'Normal' && (!task.urgency || task.urgency === 'Normal')) {
                await api.updateTask(created._id, { urgency: aiData.urgency });
                if (sender && !sender.isDestroyed()) sender.send('tasks-changed');
            }
        } catch (err) {
            // Non-fatal by design: the task already exists with a sane default.
            console.warn('⚠️ Background urgency classification failed:', err.message);
        }
    })();
    return created;
}

// Saves a task the user already reviewed in the Add Task preview.
ipcMain.handle('create-confirmed-task', async (event, task) => {
    try {
        const title = String((task && task.title) || '').trim();
        if (!title) return { error: 'The task needs a title.' };
        const clean = {
            title: title.slice(0, 300),
            date: task.date || 'Not set',
            category: String(task.category || '').trim(),
            urgency: ['Normal', 'Medium', 'High', 'Urgent'].includes(task.urgency) ? task.urgency : 'Normal',
            estimatedMinutes: task.estimatedMinutes ? Math.min(600, Math.max(5, Number(task.estimatedMinutes))) : undefined
        };
        const created = await createTaskWithBackgroundUrgency(clean, event.sender);
        // The id lets the "Added: ..." toast's Undo delete exactly this task.
        return { success: true, id: created && (created._id || created.id) };
    } catch (err) {
        console.error('❌ create-confirmed-task failed:', err.message);
        return { error: err.message };
    }
});

ipcMain.handle('add-smart-task', async (event, freeText, category = '', options = {}) => {
    try {
        // BUG FIX: the main process is single-threaded, and this handler
        // runs a chain of several regex passes over freeText. The HTML
        // input already has maxlength now, but that's a UI-layer guard -
        // this is the same check enforced here too, so an absurdly long
        // string (however it arrives) can't block the whole app's main
        // process, freezing every window, not just this field.
        if (freeText && freeText.length > 500) {
            return JSON.stringify({ error: 'That text is too long (max 500 characters). Try breaking it into a shorter task.' });
        }

        const now = new Date();

        // How long this will actually take, if the text says - the weekly
        // planner uses this to size the calendar block instead of always
        // assuming one hour (see generate-weekly-plan below).
        // Clamped to the server's allowed range (Task.estimatedMinutes is
        // 5-600) - "ללמוד 12 שעות" used to fail the whole save on validation.
        const parsedDuration = parseDurationMinutes(freeText);
        const durationMinutes = parsedDuration ? Math.min(600, Math.max(5, parsedDuration)) : null;

        // ---- Date resolution ----
        // BUG FIX: this used to build the date with toLocaleDateString('en-US'),
        // which returns M/D/YYYY (US month/day order). But renderer.js reads
        // task.date as DD/MM/YYYY everywhere else in the app (see the comment
        // above the date filter there: "task.date is stored as DD/MM/YYYY" -
        // the same format resolveDueDate() produces below for AI-extracted
        // tasks). Whenever the day and month numbers differed, that mismatch
        // silently turned the task's date into a different day - sometimes an
        // invalid one that rolled over into a completely wrong month/year.
        //
        // Also extended to recognise Hebrew weekday names ("ביום שלישי"), not
        // just מחר/היום, using the same detection order as parse-smart-event:
        // "יום X" is checked first because a bare day word like "שני" is also
        // the ordinal "second" ("מבחן שני" = "exam two", not "on Monday").
        const hebrewDayMap = {
            'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6
        };
        const toDDMMYYYY = (d) => d.toLocaleDateString('en-GB'); // matches resolveDueDate()

        let targetDate;
        let matchedHebrewDayWord = null;
        let matchedRelativeWord = null; // kept for the cleanup below; now always null
        let relativeStrip = [];

        matchedHebrewDayWord = detectHebrewDay(freeText);
        const relative = matchedHebrewDayWord ? null : resolveRelativeDate(freeText, now);

        if (matchedHebrewDayWord) {
            const targetDow = hebrewDayMap[matchedHebrewDayWord];
            const daysToAdd = (targetDow - now.getDay() + 7) % 7; // 0 = today, else next occurrence within the week
            const d = new Date(now);
            d.setDate(now.getDate() + daysToAdd);
            targetDate = toDDMMYYYY(d);
        } else if (relative) {
            targetDate = toDDMMYYYY(relative.date);
            relativeStrip = relative.strip;
        } else {
            // No date written at all -> today. It used to be "Not set", and a
            // task with no date has nowhere to appear on the Weekly Plan, so a
            // quick "בדיקה" simply vanished from the week. Safe only because
            // resolveRelativeDate catches every real date phrase first.
            targetDate = toDDMMYYYY(now);
        }

        // ---- Title cleanup ----
        // A Task only carries a due DATE, not a time (handoff decision #7:
        // a task is "something with a deadline", not a scheduled slot), so an
        // explicit time or time-of-day word in the text has no field to go
        // into. Previously only מחר/היום were stripped, so a phrase like
        // "מחר ב-9" left the stray fragment "ב-9" sitting in the title. We
        // now strip explicit times and time-of-day words too, the same way
        // parse-smart-event already does for events.
        let cleanTitle = freeText;
        relativeStrip.forEach(re => { cleanTitle = cleanTitle.replace(re, ''); });
        cleanTitle = cleanTitle
            .replace(/(?:ב\s*|ב-|בשעה\s*)?([0-1]?[0-9]|2[0-3]):([0-5][0-9])/g, '') // "9:00" / "ב-9:00"
            .replace(/(?:בשעה\s*|(?<![א-ת])ב[\s-]?)([0-1]?[0-9]|2[0-3])(?!:)(?![./]\d)\b(\s*(?:וחצי|ורבע))?/g, '')   // bare "ב9" / "ב 9" / "ב-9" / "בשעה 9", incl. "וחצי"/"ורבע" - but not the "20" of "ב-20/9"
            .replace(/חצי\s*שעה|רבע\s*שעה|שעה\s*וחצי|שעתיים|\d+(?:[.,]\d+)?\s*(?:שעות|שעה|hours?|hrs?)(?![א-ת])|\d+\s*(?:דקות|דק'|דק|minutes?|mins?)(?![א-ת])|(?<![א-ת])שעה(?![א-ת])/gi, ''); // duration phrase, now captured in estimatedMinutes instead

        // BUG FIX: \b (word boundary) is defined in JS over [A-Za-z0-9_] and
        // does not recognise Hebrew letters as "word characters" at all - so
        // \bמחר\b silently matches nothing, ever, and .replace() quietly does
        // nothing (see MindSync-handoff.md, "מלכודת" under decision #6). This
        // is the same trap, just in a new spot, so it gets the same fix used
        // elsewhere in this codebase: an explicit lookaround against the
        // Hebrew letter range instead of \b.
        const noHebrewNeighbor = (word) => new RegExp(`(?<![א-ת])${word}(?![א-ת])`, 'g');

        const timeOfDayWords = ['בבוקר', 'בוקר', 'בצהריים', 'צהריים', 'אחהצ', 'אחה"צ',
                                 'אחר הצהריים', 'בערב', 'ערב', 'בלילה', 'לילה'];
        for (const w of timeOfDayWords) {
            cleanTitle = cleanTitle.replace(noHebrewNeighbor(w), '');
        }

        if (matchedHebrewDayWord) {
            cleanTitle = cleanTitle
                .replace(new RegExp(`ב?יום\\s+${matchedHebrewDayWord}`, 'g'), '')
                .replace(noHebrewNeighbor(`ב?${matchedHebrewDayWord}`), '');
        }
        if (matchedRelativeWord) {
            cleanTitle = cleanTitle.replace(noHebrewNeighbor(matchedRelativeWord), '');
        }

        cleanTitle = cleanTitle
            .replace(/\s+/g, ' ')
            .replace(/^[\s,.\-־]+|[\s,.\-־]+$/g, '')
            .trim();
        if (!cleanTitle) cleanTitle = freeText.trim();

        // PERFORMANCE FIX: this used to await the AI urgency classification
        // BEFORE saving the task - two network round-trips back to back
        // (AI, then the server) before the user saw anything happen. The
        // task is now saved immediately with a default urgency, and
        // classification runs afterward in the background; the renderer is
        // notified to refresh once it lands. "Normal" is a safe default -
        // worst case the urgency briefly reads as one level calmer than it
        // should, never scarier.
        const task = {
            title: cleanTitle,
            date: targetDate,
            category: category || '',
            urgency: "Normal",
            estimatedMinutes: durationMinutes || undefined
        };

        // Preview mode: return what was understood WITHOUT saving, so the
        // Add Task window can show "להגיש עבודה · 30/09/2026" and let the
        // user fix it first. Saving then goes through create-confirmed-task.
        if (options && options.previewOnly) {
            return JSON.stringify({ preview: task });
        }

        await createTaskWithBackgroundUrgency(task, event.sender);
        return JSON.stringify({ success: true });
    } catch (error) {
        // BUG FIX: this used to swallow error.message and always return the
        // same generic string, which is exactly why a Gemini/Ollama failure
        // was invisible to the user - see callAIWithFallback above.
        console.error('❌ add-smart-task failed:', error.message);
        return JSON.stringify({ error: error.message || "Could not format the task." });
    }
});


// Classifies an event title into one of the four supported types using
// Hebrew and English keywords, before any model is involved.
//
// This exists because asking a small local model to classify a single Hebrew
// word was unreliable in exactly the way you'd expect: "מבחן" (exam) came
// back as "personal" while "בדיקה" (a check/test) came back as "exam". The
// model is being asked to translate AND infer at once, which is the same
// failure mode we hit with Hebrew weekday names. Keyword matching is boring,
// but for a closed set of four categories it is far more accurate, instant,
// and doesn't vary between runs.
//
// Returns null when nothing matches, so the caller can fall back to the model.
function classifyEventByKeywords(title) {
    const t = String(title || '').toLowerCase();

    // Order matters: the most specific category is checked first, since
    // "מבחן" should win over a generic study word appearing in the same title.
    const rules = [
        {
            type: 'exam',
            words: ['מבחן', 'בחינה', 'מבחנים', 'בוחן', 'מועד א', 'מועד ב', 'מועד ג',
                    'טסט', 'exam', 'test', 'quiz', 'midterm', 'final']
        },
        {
            type: 'lesson',
            words: ['שיעור', 'שיעורים', 'הרצאה', 'הרצאות', 'תרגול', 'מעבדה', 'סמינר',
                    'קורס', 'שיעור פרטי', 'lesson', 'lecture', 'class', 'seminar', 'lab', 'tutorial']
        },
        {
            type: 'study',
            words: ['ללמוד', 'לימוד', 'למידה', 'חזרה', 'להתכונן', 'הכנה', 'שיעורי בית',
                    'תרגיל', 'תרגילים', 'עבודה', 'מטלה', 'פרויקט', 'סיכום',
                    'study', 'revise', 'revision', 'homework', 'assignment', 'project', 'prep']
        },
        {
            type: 'personal',
            words: ['אישי', 'פגישה', 'רופא', 'ספורט', 'אימון', 'חדר כושר', 'ארוחה',
                    'יום הולדת', 'חופש', 'נסיעה', 'משפחה', 'חברים', 'מנוחה', 'הפסקה',
                    'personal', 'meeting', 'doctor', 'gym', 'workout', 'birthday', 'break']
        }
    ];

    // Intent overrides category: "ללמוד למבחן" (study for an exam) is a study
    // block, not the exam itself, even though it contains the word "מבחן".
    // The verb describes what you'll actually be doing.
    const studyIntent = ['ללמוד', 'להתכונן', 'לחזור על', 'הכנה ל', 'חזרה על',
                         'study for', 'prepare for', 'revise for'];
    if (studyIntent.some(w => t.includes(w))) return 'study';

    for (const rule of rules) {
        if (rule.words.some(w => t.includes(w))) return rule.type;
    }
    return null;
}

ipcMain.handle('parse-smart-event', async (event, freeText) => {
    try {
        // BUG FIX: same guard as add-smart-task above - this handler chains
        // several regex passes over freeText in a single-threaded process,
        // so an extremely long input could block the whole app, not just
        // this dialog.
        if (freeText && freeText.length > 500) {
            return JSON.stringify({ error: 'That text is too long (max 500 characters). Try breaking it into a shorter event.' });
        }

        const now = new Date();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        const hebrewDayMap = {
            'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6
        };

        let targetDayName = dayNames[now.getDay()]; // default: today
        let matchedHebrewDayWord = null;

        // In Hebrew every weekday name is ALSO an ordinal number ("שני" =
        // both "Monday" and "second"). Scanning for a bare day word therefore
        // misfires on phrases like "מבחן שני ביום שלישי" - it matches the
        // "שני" of "מבחן שני" and never reaches the real day.
        //
        // So we look for the unambiguous "יום X" / "ביום X" form FIRST. Only
        // "שבת" is safe to match on its own, since it has no ordinal meaning.
        matchedHebrewDayWord = detectHebrewDay(freeText);
        if (matchedHebrewDayWord) {
            targetDayName = dayNames[hebrewDayMap[matchedHebrewDayWord]];
        }

        // Everything that isn't a weekday name: explicit dates ("ב-20/9"),
        // מחרתיים, "בעוד שבוע", מחר, היום - resolved to a date, and the event
        // goes on that date's weekday. freeText.includes("מחר") used to also
        // catch "מחרתיים" and put it on the wrong day.
        // DATES: an event now keeps its real date unless it repeats weekly.
        // BUG FIX: a day word used to switch date reading off completely, and
        // the result was only ever a weekday - "להגיש מטלה ב-26.10" became
        // "Monday", shown on THIS week's Monday and repeating every week.
        let relativeStrip = [];
        let targetDate = null; // Date for one-time events, null = weekly
        const relative = resolveRelativeDate(freeText, now);
        const nextWeekWithDay = matchedHebrewDayWord && /ב?שבוע\s+הבא/.test(freeText);
        if (nextWeekWithDay) {
            // "ביום שני בשבוע הבא" = Monday of next week, not today + 7.
            const d = new Date(now); d.setHours(0, 0, 0, 0);
            d.setDate(d.getDate() - d.getDay() + 7 + hebrewDayMap[matchedHebrewDayWord]);
            targetDate = d;
            relativeStrip = [/ב?שבוע\s+הבא/g];
        } else if (relative && (!matchedHebrewDayWord || /\d/.test(relative.strip[0].source))) {
            // A written date (26.10) wins over a day word; a relative word
            // like "מחר" next to a day word is ambiguous, so the day word wins.
            targetDate = relative.date;
            relativeStrip = relative.strip;
        }
        if (targetDate) targetDayName = dayNames[targetDate.getDay()];

        // Weekly only when it's said ("כל יום שני", "every Monday"), or it's
        // a class given by weekday with no date. Everything else - an exam
        // on Thursday, the gym on Tuesday - is a one-time thing.
        const DAY_WORDS = 'ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת';
        const everyRe = new RegExp(`(?<![א-ת])ב?כל\\s+(?:(?:ה)?שבוע|(?:יום\\s+)?(?:${DAY_WORDS}))(?![א-ת])`);
        const saidEvery = everyRe.test(freeText) || /\bevery\b|\bweekly\b/i.test(freeText);

        // ---- Time resolution ----
        // The old fallback was "now + 1 hour", which has two problems: the
        // same sentence produces a different result depending on when you
        // type it, and it lands on ragged times like 14:37. People don't
        // schedule things at 14:37. We now read an explicit time if given,
        // fall back to common Hebrew time-of-day words, and only then to a
        // rounded-up hour.
        let targetTime = "";
        let matchedTimeWord = null;

        const timeRegex = /([0-1]?[0-9]|2[0-3]):([0-5][0-9])/;
        const timeMatch = freeText.match(timeRegex);

        // BUG FIX: a bare hour with no minutes ("ב9", "ב-9", "בשעה 9") never
        // matched the colon-only regex above, so it fell straight through to
        // the "current time + 1 hour" fallback below - which is exactly why
        // "ללמוד למבחן ביום שבת ב9" typed in the evening came out as 18:00
        // instead of 09:00, and the title kept a leftover "ב 9" verbatim.
        //
        // Also captures an optional "וחצי" (and a half) / "ורבע" (and a
        // quarter) right after the hour - "ב 9 וחצי" means 9:30, not 9:00,
        // and without this the word was left dangling, unrecognised, in the
        // title ("...וחצי את האפליקציה").
        // (?![./]\d): the "20" in "ב-20/9" is a date, not 20:00.
        const bareHourRegex = /(?:בשעה\s*|(?<![א-ת])ב[\s-]?)([0-1]?[0-9]|2[0-3])(?!:)(?![./]\d)\b(\s*(?:וחצי|ורבע))?/;
        const bareHourMatch = !timeMatch ? freeText.match(bareHourRegex) : null;
        const bareHourSuffix = bareHourMatch && bareHourMatch[2] ? bareHourMatch[2].trim() : null;

        // Rough time-of-day words -> a conventional hour.
        const timeOfDayMap = [
            { words: ['בבוקר', 'בוקר'], time: '09:00' },
            { words: ['בצהריים', 'צהריים'], time: '12:00' },
            { words: ['אחהצ', 'אחה"צ', 'אחר הצהריים'], time: '16:00' },
            { words: ['בערב', 'ערב'], time: '19:00' },
            { words: ['בלילה', 'לילה'], time: '21:00' },
            { words: ['כל היום', 'כל היום'], time: '09:00' }
        ];

        if (timeMatch) {
            // Pad to HH:MM. The server validates /^([01]\d|2[0-3]):([0-5]\d)$/,
            // so a bare "9:00" would be rejected - this was one cause of the
            // "Validation failed" errors.
            const h = String(parseInt(timeMatch[1], 10)).padStart(2, '0');
            const m = timeMatch[2];
            targetTime = `${h}:${m}`;
        } else if (bareHourMatch) {
            const h = String(parseInt(bareHourMatch[1], 10)).padStart(2, '0');
            const m = bareHourSuffix === 'וחצי' ? '30' : bareHourSuffix === 'ורבע' ? '15' : '00';
            targetTime = `${h}:${m}`;
        } else {
            const hit = timeOfDayMap.find(entry => entry.words.some(w => freeText.includes(w)));
            if (hit) {
                targetTime = hit.time;
                matchedTimeWord = hit.words.find(w => freeText.includes(w));
            } else {
                // Round UP to the next full hour rather than adding 60 minutes
                // to the current ragged time.
                const d = new Date(now.getTime() + 60 * 60 * 1000);
                d.setMinutes(0, 0, 0);
                targetTime = String(d.getHours()).padStart(2, '0') + ":00";
            }
        }

        // ניקוי העברית
        // Only strip the day phrase we actually matched - the old version
        // stripped every ordinal, which turned "מבחן שני ביום שלישי" into
        // just "מבחן" and threw away part of the real title.
        // BUG FIX: \b doesn't recognise Hebrew letters, so every \b-wrapped
        // Hebrew pattern below silently matched nothing (see handoff doc,
        // decision #6 "מלכודת"). Replaced with an explicit lookaround.
        const noHebrewNeighbor = (word) => new RegExp(`(?<![א-ת])${word}(?![א-ת])`, 'g');

        let cleanTitle = freeText;
        relativeStrip.forEach(re => { cleanTitle = cleanTitle.replace(re, ''); });
        cleanTitle = cleanTitle
            .replace(/(?:ב\s*|ב-|בשעה\s*)?([0-1]?[0-9]|2[0-3]):([0-5][0-9])/g, '');

        if (bareHourMatch) {
            cleanTitle = cleanTitle.replace(bareHourMatch[0], '');
        }

        if (saidEvery) {
            cleanTitle = cleanTitle
                .replace(new RegExp(`(?<![א-ת])ב?כל\\s+(?:ה)?שבוע(?![א-ת])`, 'g'), '')
                .replace(new RegExp(`(?<![א-ת])ב?כל\\s+(?=(?:ב?יום\\s+)?(?:${DAY_WORDS}))`, 'g'), '')
                .replace(/\bevery\b|\bweekly\b/gi, '');
        }

        if (matchedHebrewDayWord) {
            cleanTitle = cleanTitle
                .replace(new RegExp(`ב?יום\\s+${matchedHebrewDayWord}`, 'g'), '')
                .replace(noHebrewNeighbor(`ב?${matchedHebrewDayWord}`), '');
        }

        // Strip the relative day word - but NOT when it's part of "כל היום"
        // ("all day"), where "היום" is not a day reference at all. Removing it
        // blindly turned "זמן אישי היום כל היום" into "זמן אישי כל".
        cleanTitle = cleanTitle
            .replace(/כל\s+היום/g, '\u0000ALLDAY\u0000')   // shield it
            .replace(noHebrewNeighbor('מחר'), '')
            .replace(noHebrewNeighbor('היום'), '')
            .replace(/\u0000ALLDAY\u0000/g, 'כל היום');     // restore

        // Remove a matched time-of-day word from the title too, so we don't
        // end up with "מבחן בבוקר" when the time already says 09:00.
        if (matchedTimeWord && matchedTimeWord !== 'כל היום') {
            cleanTitle = cleanTitle.replace(noHebrewNeighbor(matchedTimeWord), '');
        }

        cleanTitle = cleanTitle
            .replace(/\s+/g, ' ')
            .replace(/^[\s,.\-־]+|[\s,.\-־]+$/g, '')
            .trim();

        if (!cleanTitle) cleanTitle = "New Event";

        const VALID_TYPES = ['lesson', 'exam', 'study', 'personal'];
        let eventType = "personal";

        // Keyword matching first - it's deterministic and handles Hebrew
        // correctly, which the model demonstrably does not.
        const keywordType = classifyEventByKeywords(cleanTitle);

        if (keywordType) {
            eventType = keywordType;
            console.log(`📆 Type "${eventType}" matched by keyword (no AI call needed).`);
        } else {
            // Nothing matched, so fall back to the model. Note the prompt now
            // states the text may be Hebrew and gives examples, rather than
            // handing over a bare word and hoping.
            const prompt = `Classify a calendar event into exactly one category.
The title may be in Hebrew or English.

Categories:
- "exam": a test or examination (Hebrew: מבחן, בחינה, בוחן)
- "lesson": a class or lecture to attend (Hebrew: שיעור, הרצאה, תרגול)
- "study": self-study, homework, an assignment to work on (Hebrew: ללמוד, שיעורי בית, תרגיל, מטלה)
- "personal": anything not academic (Hebrew: פגישה, אימון, זמן אישי)

Title: "${cleanTitle}"

Return ONLY this JSON, with no other text: {"type": "one_of_the_four"}`;

            try {
                let responseText = await callAIWithFallback(prompt, null, 50, true);
                responseText = extractJsonFromText(responseText);
                const aiData = JSON.parse(responseText);

                let candidate = null;
                if (Array.isArray(aiData) && aiData[0] && aiData[0].type) candidate = aiData[0].type;
                else if (aiData && aiData.type) candidate = aiData.type;

                if (candidate) {
                    const normalized = String(candidate).toLowerCase().trim();
                    if (VALID_TYPES.includes(normalized)) {
                        eventType = normalized;
                        console.log(`📆 Type "${eventType}" classified by AI.`);
                    } else {
                        console.warn(`parse-smart-event: model returned unsupported type "${candidate}", defaulting to personal.`);
                    }
                }
            } catch (aiErr) {
                console.warn('parse-smart-event: type classification failed, defaulting to personal:', aiErr.message);
            }
        }

        // Final guard before this leaves the process. Every field is checked
        // against exactly what the server will validate, so a malformed event
        // is caught here with a clear message instead of failing server-side.
        if (!dayNames.includes(targetDayName)) targetDayName = dayNames[now.getDay()];
        if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(targetTime)) targetTime = '09:00';

        const weekly = !targetDate && (saidEvery || (eventType === 'lesson' && !!matchedHebrewDayWord));
        if (!weekly && !targetDate) {
            // No date written: the next time that weekday comes round (today
            // counts only if the time hasn't passed yet).
            const d = new Date(now); d.setHours(0, 0, 0, 0);
            let add = (dayNames.indexOf(targetDayName) - d.getDay() + 7) % 7;
            const [hh, mm] = targetTime.split(':').map(Number);
            if (add === 0 && hh * 60 + mm <= now.getHours() * 60 + now.getMinutes()) add = matchedHebrewDayWord ? 7 : 1;
            d.setDate(d.getDate() + add);
            targetDate = d;
            targetDayName = dayNames[d.getDay()];
        }

        const events = [{
            title: cleanTitle,
            day: targetDayName,
            date: weekly ? null : toLocalIsoDate(targetDate),
            time: targetTime,
            type: eventType
        }];

        console.log('📆 parse-smart-event ->', JSON.stringify(events[0]));
        return JSON.stringify(events);
    } catch (error) {
        console.error("Event parse error:", error);
        return JSON.stringify({ error: "Could not format the event." });
    }
});

// =====================================
// =====================================
// AI Operations (Smart Weekly Planner)
// =====================================
// BUG FIX: despite the name, this never actually reasoned about anything.
// It hardcoded every block as type "study" regardless of the task, ignored
// estimatedMinutes entirely (so "ללמוד 3 שעות למבחן" got exactly one hour,
// same as everything else), and never looked at currentEvents even though
// it received it - so it happily stacked new blocks on top of existing
// lessons/exams, or just kept incrementing by a fixed 2 hours with no idea
// whether that slot was actually free.
ipcMain.handle('generate-weekly-plan', async (event, currentTasks, currentEvents) => {
    try {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const DAY_START = 9 * 60;   // don't schedule before 09:00
        const DAY_END = 21 * 60;    // or after 21:00
        const HORIZON_DAYS = 7;     // the board shows one week
        const now = new Date();
        const today = new Date(now); today.setHours(0, 0, 0, 0);

        const parseDue = (t) => {
            if (t.dueDate) { const d = new Date(t.dueDate); if (!isNaN(d)) { d.setHours(0, 0, 0, 0); return d; } }
            const parts = String(t.date || '').split('/').map(Number);
            if (parts.length !== 3 || parts.some(isNaN)) return null;
            const d = new Date(parts[2], parts[1] - 1, parts[0]);
            return isNaN(d) ? null : d;
        };

        // BUG FIX: this used to take only tasks with NO date ("Not set") - so
        // a task due Thursday never got study time, and now that new tasks
        // default to today it would have found nothing to plan at all. It
        // also never checked status, and happily scheduled finished tasks.
        // Now: every open task, earliest deadline first, then most urgent.
        const URGENCY_RANK = { Urgent: 0, High: 1, Medium: 2, Normal: 3 };
        const openTasks = (currentTasks || [])
            .filter(t => t.status !== 'completed')
            .map(t => ({ task: t, due: parseDue(t) }))
            .sort((a, b) => {
                const ad = a.due ? a.due.getTime() : Infinity;
                const bd = b.due ? b.due.getTime() : Infinity;
                if (ad !== bd) return ad - bd;
                return (URGENCY_RANK[a.task.urgency] ?? 3) - (URGENCY_RANK[b.task.urgency] ?? 3);
            });
        if (openTasks.length === 0) return JSON.stringify({ plan: [], unplaced: [] });

        // Real availability, seeded from what's already on the calendar.
        const occupied = {};
        dayNames.forEach(d => occupied[d] = []);
        // Dated events only take up time if they fall inside the 7 days
        // being planned; weekly ones take up their weekday every week.
        const horizonDates = {};
        for (let i = 0; i < HORIZON_DAYS; i++) {
            const d = new Date(today); d.setDate(today.getDate() + i);
            horizonDates[toLocalIsoDate(d)] = dayNames[d.getDay()];
        }
        (currentEvents || []).forEach(evt => {
            if (evt.date && !horizonDates[evt.date]) return;
            if (!occupied[evt.day]) return;
            const [h, m] = String(evt.time || '00:00').split(':').map(Number);
            const start = h * 60 + (m || 0);
            const dur = evt.durationMinutes || 60;
            occupied[evt.day].push([start, start + dur]);
        });

        // First open slot on `day` at least neededMinutes long, not before
        // `earliest` (used for today, so nothing lands in the past).
        function findSlot(day, neededMinutes, earliest) {
            const slots = occupied[day].slice().sort((a, b) => a[0] - b[0]);
            let cursor = Math.max(DAY_START, earliest || 0);
            for (const [start, end] of slots) {
                if (start - cursor >= neededMinutes) return cursor;
                cursor = Math.max(cursor, end);
            }
            return (DAY_END - cursor >= neededMinutes) ? cursor : null;
        }

        // Today's blocks start after "now", rounded up to the next quarter hour.
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const todayEarliest = Math.ceil((nowMinutes + 1) / 15) * 15;

        const plannedEvents = [];
        const unplaced = [];

        // Without these, everything went into today back to back - seven
        // straight hours with no gap. A short break after each planned block,
        // and a soft daily cap: once a day holds DAILY_CAP minutes of planned
        // work, later tasks spill to the next days - unless that day is the
        // task's deadline, where fitting it in beats respecting the cap.
        const BREAK_MINUTES = 15;
        const DAILY_CAP = 4 * 60;
        const plannedPerDay = {};
        dayNames.forEach(d => plannedPerDay[d] = 0);

        openTasks.forEach(({ task, due }) => {
            // Capped at 3 hours - one continuous block is what "study 3 hours
            // for the exam" means, not several disconnected ones.
            const blockMinutes = Math.min(task.estimatedMinutes || 60, 180);
            // BUG FIX: the block's colour came from keywords in the task's
            // title, so time planned for "להכין שיעורי בית" or "סיכום הרצאה 3"
            // was drawn as a Class. It's time set aside to work on a task, so
            // it's a study block - unless the task is clearly personal.
            const kwType = classifyEventByKeywords(task.title);
            const type = (kwType === 'lesson' || kwType === 'exam') ? 'study' : (kwType || 'personal');

            // BUG FIX: the search used to start TOMORROW, so a task due today
            // could only ever be scheduled after its own deadline. It now runs
            // from today up to the due date (overdue / undated: the whole week).
            let lastOffset = HORIZON_DAYS - 1;
            if (due && due >= today) {
                lastOffset = Math.min(lastOffset, Math.round((due - today) / 86400000));
            }

            let placed = false;
            for (let dayOffset = 0; dayOffset <= lastOffset && !placed; dayOffset++) {
                const targetDate = new Date(today);
                targetDate.setDate(today.getDate() + dayOffset);
                const day = dayNames[targetDate.getDay()];

                const isLastChance = dayOffset === lastOffset;
                if (!isLastChance && plannedPerDay[day] + blockMinutes > DAILY_CAP) continue;

                const startMinutes = findSlot(day, blockMinutes, dayOffset === 0 ? todayEarliest : 0);
                if (startMinutes === null) continue;

                const h = String(Math.floor(startMinutes / 60)).padStart(2, '0');
                const m = String(startMinutes % 60).padStart(2, '0');

                plannedEvents.push({
                    title: task.title,
                    day,
                    // A real date: a block planned for next Monday used to show
                    // on THIS week's (already past) Monday, and every Monday after.
                    date: toLocalIsoDate(targetDate),
                    time: `${h}:${m}`,
                    type,
                    durationMinutes: blockMinutes,
                    autoScheduled: true,
                    task: task._id || task.id || null
                });
                occupied[day].push([startMinutes, startMinutes + blockMinutes + BREAK_MINUTES]);
                plannedPerDay[day] += blockMinutes;
                placed = true;
            }

            if (!placed) unplaced.push(task.title);
        });

        // An object now, not a bare array, so the renderer can say which
        // tasks didn't fit instead of them silently disappearing.
        return JSON.stringify({ plan: plannedEvents, unplaced });
    } catch (error) {
        console.error("Weekly Planner Error:", error);
        return JSON.stringify({ error: error.message });
    }
});

// =====================================
// File Reading 
// =====================================

// Reads a PDF, preferring the geometry-aware extractor.
//
// pdfjs-dist reconstructs reading order from each text run's position on the
// page, which is what finally fixes Hebrew: the rightmost run on a line is
// read first, so clauses and punctuation come out in the right order instead
// of needing to be un-scrambled afterwards.
//
// pdf2json is kept as a fallback for the cases where pdfjs fails outright
// (unusual encodings, damaged files). When that happens the old repair
// heuristics still run, because that text will have the old problems.
async function readPdf(filePath) {
    try {
        const text = await extractPdfText(filePath);
        if (text && text.trim().length > 0) {
            console.log(`📄 PDF read with pdfjs (${text.length} chars, RTL-aware)`);
            return text;
        }
        console.warn('⚠️ pdfjs returned no text, falling back to pdf2json.');
    } catch (err) {
        console.warn('⚠️ pdfjs extraction failed, falling back to pdf2json:', err.message);
    }

    const legacy = await new Promise((resolve, reject) => {
        const pdfParser = new PDFParser(null, 1);
        pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
        pdfParser.on("pdfParser_dataReady", () => resolve(pdfParser.getRawTextContent()));
        pdfParser.loadPDF(filePath);
    });

    console.log(`📄 PDF read with pdf2json fallback (${legacy.length} chars) - applying RTL repairs`);
    return repairHebrewPdfText(legacy);
}

// ---- Multi-file / folder upload ----
// The old picker took exactly one file, and read it (PDF extraction and all)
// before showing anything - fine for one file, a long silent wait for
// twenty. Upload is now two steps: pick (returns the list instantly, nothing
// read yet), then read + save one file at a time so the window can show
// "Uploading 3 of 12". Whole folders are supported, subfolders included.
const UPLOAD_EXTENSIONS = ['pdf', 'txt', 'md', 'java', 'py', 'js', 'html', 'css', 'json'];
const UPLOAD_MAX_FILES = 100;

function collectUploadableFiles(dir, depth = 0, found = []) {
    if (depth > 5 || found.length > UPLOAD_MAX_FILES) return found;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
    // Sorted so a course folder uploads in the order it reads on disk
    // (lecture 1, lecture 2...) rather than whatever order the OS returns.
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('~$') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectUploadableFiles(full, depth + 1, found);
        else if (UPLOAD_EXTENSIONS.includes(path.extname(entry.name).slice(1).toLowerCase())) found.push(full);
    }
    return found;
}

// mode: 'files' (pick one or many) | 'folder' (pick a folder, take every
// supported file inside it). Returns { files: [{ path, name }], folderName,
// skipped, truncated } or null if the picker was cancelled.
ipcMain.handle('select-upload-files', async (event, mode = 'files') => {
    const isFolder = mode === 'folder';
    const result = await dialog.showOpenDialog({
        title: isFolder ? 'Choose a folder to upload' : 'Choose files to upload',
        properties: isFolder ? ['openDirectory'] : ['openFile', 'multiSelections'],
        filters: isFolder ? undefined : [{ name: 'Documents and Code', extensions: UPLOAD_EXTENSIONS }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    let paths = [];
    let folderName = null;
    if (isFolder) {
        folderName = path.basename(result.filePaths[0]);
        paths = collectUploadableFiles(result.filePaths[0]);
    } else {
        paths = result.filePaths.filter(p => UPLOAD_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase()));
    }
    const truncated = paths.length > UPLOAD_MAX_FILES;
    paths = paths.slice(0, UPLOAD_MAX_FILES);
    return {
        files: paths.map(p => ({ path: p, name: path.basename(p) })),
        folderName,
        truncated,
        maxFiles: UPLOAD_MAX_FILES,
        supported: UPLOAD_EXTENSIONS
    };
});

ipcMain.handle('read-upload-file', async (event, filePath) => {
    try {
        const ext = path.extname(filePath).toLowerCase();
        const content = ext === '.pdf' ? await readPdf(filePath) : fs.readFileSync(filePath, 'utf-8');
        return { fileName: path.basename(filePath), fileContent: content, filePath };
    } catch (err) {
        console.error('❌ Failed to read file:', filePath, err.message);
        return { error: err.message };
    }
});


// =====================================
// Stats - removed. /api/stats no longer exists server-side (XP/levels/
// streak were dropped as a product decision); these handlers had no caller
// left in renderer.js after Progress and task-completion were updated to
// not depend on them, so they're gone rather than left as dead code that
// calls an endpoint that will always 404.
// =====================================

// =====================================
// Auth
// =====================================
// Lets Settings offer a "Copy diagnostic log" button - the packaged app has
// no visible terminal, so this is the only way a friend can hand you
// anything useful when something breaks. See logger.js.
ipcMain.handle('get-diagnostic-log', async () => {
    return logger.getLogTail();
});

// On app startup, the renderer calls this once to decide whether to show
// the login screen or go straight into the app. A saved token isn't proof
// it still works (it could have expired, or the account could be gone), so
// this actually calls the server rather than just checking a file exists.
ipcMain.handle('auth-get-session', async () => {
  const token = authClient.getToken();
  if (!token) return { loggedIn: false };

  try {
    const user = await api.getMe();
    return { loggedIn: true, user };
  } catch (err) {
    // Token rejected (expired/invalid) - apiClient already cleared it via
    // the 401 handling in request(), so this just reports the outcome.
    return { loggedIn: false };
  }
});

ipcMain.handle('auth-register', async (event, { email, password, name, degree }) => {
  try {
    const { token, user } = await api.register(email, password, name, degree);
    authClient.saveSession({ token, user });
    return { success: true, user };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('auth-login', async (event, { email, password }) => {
  try {
    const { token, user } = await api.login(email, password);
    authClient.saveSession({ token, user });
    return { success: true, user };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('auth-logout', async () => {
  authClient.clearSession();
  return { success: true };
});

// =====================================
// Profile
// =====================================
// AUTH: these now read/write the logged-in User document (name/degree)
// via /auth/me instead of the old singleton Profile - see apiClient.js.
ipcMain.handle('get-profile', async () => {
  try { return await api.getMe(); }
  catch (err) { return { name: '', degree: '' }; }
});

ipcMain.handle('save-profile', async (event, profileData) => {
  try {
    await api.updateMe(profileData);
    return true;
  } catch (err) { return { error: err.message }; }
});

// =====================================
// Tasks
// =====================================
ipcMain.handle('get-tasks', async () => {
  try { return await api.getTasks(); } 
  catch (err) { return []; }
});

ipcMain.handle('save-task', async (event, newTask) => {
  try {
    await api.createTask(newTask);
    return true;
  } catch (err) { return { error: err.message }; }
});

// BUG FIX: finishing or deleting a task left the study blocks the weekly
// planner had placed for it on the calendar (and in Google Calendar)
// forever - nothing ever cleared them. The server even had a by-task delete
// route that nothing called. Only planner-placed blocks are removed; an
// event the user added by hand is theirs to delete.
async function clearPlannedBlocksForTask(taskId) {
  try {
    const events = await api.getEvents();
    const blocks = (events || []).filter(e =>
      e.autoScheduled && e.task && String(e.task) === String(taskId));
    for (const b of blocks) await deleteEventEverywhere(b.id || b._id, b);
    if (blocks.length) {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('events-changed');
      });
    }
  } catch (err) {
    // Never let cleanup fail the task action itself.
    console.warn('⚠️ Could not clear planned blocks for task', taskId, err.message);
  }
}

ipcMain.handle('delete-task', async (event, id) => {
  try {
    await api.deleteTask(id);
    await clearPlannedBlocksForTask(id);
    return true;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('update-task', async (event, id, updates) => {
  try {
    const updated = await api.updateTask(id, updates);
    if (updates && updates.status === 'completed') await clearPlannedBlocksForTask(id);
    return updated;
  } catch (err) { return { error: err.message }; }
});

// =====================================
// Subtasks (checklist) & Categories
// =====================================
ipcMain.handle('get-task-categories', async () => {
  try { return await api.getTaskCategories(); } catch (err) { return []; }
});

ipcMain.handle('add-subtask', async (event, taskId, title) => {
  try { return await api.addSubtask(taskId, title); } catch (err) { return { error: err.message }; }
});

// BUG FIX: the server marks a task completed by itself when its last
// checklist step is ticked (or the last unticked step is removed). That path
// never went through 'update-task', so the task's planned study blocks stayed
// on the calendar after it was done. Same cleanup here.
ipcMain.handle('toggle-subtask', async (event, taskId, subtaskId, completed) => {
  try {
    const updated = await api.toggleSubtask(taskId, subtaskId, completed);
    if (updated && updated.status === 'completed') await clearPlannedBlocksForTask(taskId);
    return updated;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('delete-subtask', async (event, taskId, subtaskId) => {
  try {
    const updated = await api.deleteSubtask(taskId, subtaskId);
    if (updated && updated.status === 'completed') await clearPlannedBlocksForTask(taskId);
    return updated;
  } catch (err) { return { error: err.message }; }
});


// =====================================
// Study item generation (spaced repetition)
// =====================================
// Turns uploaded material into practice items. Three modes are produced
// because different subjects fail differently:
//   recall   - definitions/concepts. Retrieval from memory works here.
//   practice - maths/statistics. You can't "remember" an integral, you
//              perform it, so the app tracks whether you managed rather than
//              trying to mark your answer. Crucially, a local 8B model is bad
//              at maths - having it grade your algebra would produce confident
//              wrong verdicts, which would destroy trust in an app whose
//              entire promise is telling you the truth.
//   explain  - open understanding questions, graded against the source later.
ipcMain.handle('generate-study-items', async (event, sourceText, options = {}) => {
    try {
        const category = options.category || '';
        const sourceFile = options.sourceFile || '';
        console.log(`🧠 generate-study-items: ${(sourceText || '').length} chars, category "${category}"`);

        const chunks = chunkForAI(sourceText);
        console.log(`🧠 Split into ${chunks.length} chunk(s)`);

        const seen = new Set();
        const allItems = [];
        let rejected = 0;
        // Tallied so a file that yields nothing can explain itself. Silent
        // failure is the worst outcome: a maths-heavy PDF returned zero
        // questions with no indication of whether the file was wrong, the
        // app was broken, or the material simply isn't suitable.
        const rejectReasons = {};
        const noteReject = (reason) => { rejectReasons[reason] = (rejectReasons[reason] || 0) + 1; };

        for (let i = 0; i < chunks.length; i++) {
            console.log(`🧠 Generating from chunk ${i + 1}/${chunks.length}...`);

            const isExercisePaper = looksLikeExercisePaper(chunks[i]);

            // An exam paper and a textbook chapter need opposite treatment.
            // From an exercise sheet, the exercise IS the study item; asking
            // "what is the purpose of the function?" produces questions that
            // are meaningless once the paper isn't in front of you.
            const modeGuidance = isExercisePaper
                ? `This text is an EXERCISE SHEET or EXAM PAPER, not teaching material.
Exercise sheets rarely define anything, so there may be little here worth turning into a question. That is fine - return {"items": []} rather than padding it out.
Only create a question where the text actually DEFINES or EXPLAINS something you can quote.
Do NOT turn the exercises themselves into questions, and do NOT ask ABOUT them ("what is the required runtime", "what data type is used").`
                : `This text is teaching material (lecture slides, a chapter, notes).
Create ONLY "recall" questions (definitions, concepts, facts stated in the text) and "explain" questions.
Do NOT create "practice" items from teaching material. Do not invent exercises such as "convert this formula to DNF" - an exercise you made up has no official solution anywhere, so the student would have to solve it, verify it elsewhere, and type the answer back in. That is worse than not asking.
Practice items belong only to real exercise sheets, where the student has to do the work regardless.`;

            const prompt = `You create study questions from a student's own course material.
You are working from part ${i + 1} of ${chunks.length} of a document.

${modeGuidance}

THE EXAM TEST - apply this to every question before you write it:
"Would a lecturer put this on an exam?"
If the answer is no, do not ask it.

Course material contains motivating stories, history and biography alongside the actual content. The story exists to introduce the idea; the IDEA is what gets examined.
BAD:  "In which city was the bridge problem set?"          (trivia about the anecdote)
BAD:  "Who first studied the seven bridges problem?"        (biography)
BAD:  "In which year was this theorem proved?"              (a date)
GOOD: "What condition must a graph satisfy to have an Euler path?"  (the concept the story introduces)
Never ask about: people's names, places, dates, historical events, who discovered what, or course admin (deadlines, grading, office hours).
Always ask about: definitions, conditions, properties, notation, methods, and the relationships between concepts.

CRITICAL - every question must stand completely alone:
The student will see it weeks later WITHOUT this document. A question that depends on the document is useless.
BAD:  "What is the purpose of the function to be written?"  (which function?)
GOOD: "Write a function that returns the largest value in a linked list without modifying the original list. What is the approach?"
BAD:  "What does the text say about runtime?"
GOOD: "What is the time complexity of searching an unsorted linked list?"
Never write "the function", "the exercise", "the text", "as mentioned", "בתרגיל", "לפי הטקסט", "הפונקציה שתוכתב".
Always name the actual data structure, algorithm or concept inside the question itself.

NEVER ask about the parameters of one specific exercise. These are worthless:
BAD: "What data type are the elements?"  "Is it allowed to modify the original list?"  "How many points is this question worth?"
Those describe one exam paper, not knowledge. Ask about concepts, methods and complexity instead.

Create questions that test whether the student can REPRODUCE the material from memory, not recognise it. Never write multiple-choice options.

Choose a mode per question:
- "recall": a definition, concept, term or fact stated in the text.
- Do NOT use "practice" mode. Never turn a problem or exercise into a question - there is no solution available for it, so it cannot be reviewed.
- "explain": an open question asking the student to explain something in their own words.

Rules:
- Base every question ONLY on what is written in the text below. Do not add outside knowledge.
- NEVER write multiple-choice questions. Do not write "choose one", "בחר אחת", or lettered options (א, ב, ג / a, b, c). The student must produce the answer from memory.
- "sourceQuote" is REQUIRED for every question: copy the exact sentence from the text that the question is based on, character for character. A question without a real quote will be discarded.
- Do NOT write answers. Your job is to LOCATE the passage that answers the question and copy it into "sourceQuote". The quote itself becomes the answer shown to the student, so it must be complete enough to actually answer the question on its own - include the full sentence or definition, not a fragment.
- Copy the passage in full. NEVER shorten it with "..." or "…" - write out every word between the start and end of the passage.
- Never quote a slide that only LISTS topics (an agenda, contents page, or a run of bullet headings). Those contain the words but not the meaning. Quote the slide that explains the concept.
- The passage must CONTAIN the answer, not merely be near it. If the question names a symbol (∨, ∧, ¬), the passage must show that symbol. If the question quotes an example, the passage must explain it, not just list it again. If no passage in this text actually answers the question, do not ask that question.

Because the answer shown to the student IS that passage, only ask questions a passage can actually answer.
GOOD: "What is the definition of logical equivalence?"  (a definition exists in the text)
GOOD: "Which two-place connectives are defined in propositional calculus?"  (a list exists)
BAD:  "Can we conclusively infer X? Explain your reasoning."  (needs an argument, not a passage)
BAD:  "Why is this approach better?"  (the text states facts, not justifications)
Do not ask the student to "explain", "justify" or "prove" in a recall question - if the material only states something, ask what it states.
- Write questions and answers in the SAME language as the text.
- Produce at most 8 questions from this part. Fewer good ones is better than padding.
- If this part is boilerplate (title page, instructions, table of contents), return {"items": []}.

Return ONLY a JSON object: {"items": [{"question": "...", "mode": "recall|practice|explain", "skillTag": "...", "sourceQuote": "..."}]}

Text:
${chunks[i]}`;

            let parsed;
            try {
                const responseText = await callAIWithFallback(prompt, null, 1200, true);
                parsed = JSON.parse(extractJsonFromText(responseText));
            } catch (chunkErr) {
                console.error(`⚠️ Chunk ${i + 1} failed, skipping:`, chunkErr.message);
                continue;
            }

            let list = [];
            if (parsed && Array.isArray(parsed.items)) list = parsed.items;
            else if (Array.isArray(parsed)) list = parsed;
            else if (parsed && parsed.question) list = [parsed];

            for (const raw of list) {
                if (!raw || !raw.question || String(raw.question).trim().length < 8) continue;

                // Grounding guard tuned for questions, not task titles.
                if (!isQuestionGrounded(raw, chunks[i])) {
                    console.warn(`   ⛔ Rejected (not grounded): "${String(raw.question).slice(0, 60)}"`);
                    noteReject('ungrounded');
                    rejected++;
                    continue;
                }

                const question = stripMultipleChoice(raw.question);
                if (!question || question.length < 8) continue;

                // Reject anything that leans on the document for meaning.
                if (!isSelfContained(question)) {
                    console.warn(`   ⛔ Rejected (needs the document to make sense): "${question.slice(0, 60)}"`);
                    noteReject('context-dependent');
                    rejected++;
                    continue;
                }

                let mode = ['recall', 'practice', 'explain'].includes(raw.mode) ? raw.mode : 'recall';

                // Hard rule, not just prompt guidance: a practice item with no
                // known solution is a chore, not a study aid. The student has
                // to solve an invented exercise, verify it somewhere else, and
                // then type back an answer they already know - all effort, no
                // learning. Only genuine exercise sheets produce practice
                // items, because there the work has to be done anyway and the
                // item is tracking real coursework.
                // No generated practice items, from any source.
                //
                // The previous rule allowed them from exercise sheets, but the
                // distinction doesn't survive contact with real files: lecture
                // decks contain worked examples, so "מצא את צורת ה-DNF של..."
                // still got through. And the underlying objection holds
                // regardless of source - the app cannot supply a solution, so
                // the student must solve it, verify it in a chat model, then
                // come back and type in an answer they already know. That is
                // work with no learning in it.
                //
                // The mode still exists in the schema for items created by
                // hand, where the student is choosing to track a problem they
                // already have a solution for.
                if (mode === 'practice') {
                    console.warn(`   ⛔ Rejected (practice item with no available solution): "${question.slice(0, 55)}"`);
                    noteReject('unanswerable problems');
                    rejected++;
                    continue;
                }

                if (isHistoricalTrivia(question)) {
                    console.warn(`   ⛔ Rejected (asks about the anecdote, not the concept): "${question.slice(0, 55)}"`);
                    noteReject('trivia');
                    rejected++;
                    continue;
                }

                if (needsReasoningNotQuote(question, mode)) {
                    console.warn(`   ⛔ Rejected (asks for reasoning, but the answer is a quote): "${question.slice(0, 60)}"`);
                    noteReject('reasoning questions');
                    rejected++;
                    continue;
                }

                if (isExerciseTrivia(question, raw.sourceQuote)) {
                    console.warn(`   ⛔ Rejected (exercise trivia, not knowledge): "${question.slice(0, 60)}"`);
                    noteReject('exercise trivia');
                    rejected++;
                    continue;
                }
                const key = question.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                // The ANSWER IS THE SOURCE QUOTE, never model-authored text.
                //
                // Letting the model write answers produced confident nonsense:
                // "two-pointer technique" for finding a maximum, "גרעין לוגי"
                // instead of "גרירה לוגית", and a definition of contradiction
                // that said nothing. An 8B model cannot reliably write precise
                // technical Hebrew, and a wrong answer in a study app doesn't
                // just fail to help - it teaches the wrong thing.
                //
                // The correct answer is already sitting in the student's own
                // course material. So the model's job shrinks from "know the
                // subject" to "find the relevant passage", which it is good
                // at, and the answer is correct by construction because the
                // lecturer wrote it.
                let answer = '';
                if (mode !== 'practice') {
                    const quote = String(raw.sourceQuote || '').trim();
                    // Only useful if it's substantial enough to actually answer.
                    if (quote.length >= 15) {
                        // A quote whose word order was scrambled by PDF
                        // extraction is unrecoverable. Showing it as an answer
                        // would teach gibberish, so the item is dropped
                        // entirely rather than kept with a broken answer.
                        // Try to restore anything the model abbreviated before
                        // judging whether the text is damaged.
                        const expanded = expandTruncatedQuote(quote, chunks[i]);

                        if (looksMangled(expanded)) {
                            console.warn(`   ⛔ Rejected (source text garbled by PDF extraction): "${expanded.slice(0, 50)}"`);
                            noteReject('garbled text');
                            rejected++;
                            continue;
                        }
                        // Complete a lead-in before judging it incomplete.
                        const completed = completeAfterColon(expanded, chunks[i]);

                        if (looksLikeHeading(completed)) {
                            console.warn(`   ⛔ Rejected (quote is a slide title, not an explanation): "${completed.slice(0, 50)}"`);
                            noteReject('slide titles');
                            rejected++;
                            continue;
                        }

                        if (looksLikeOutline(completed)) {
                            console.warn(`   ⛔ Rejected (quote is an agenda/contents slide, not an explanation): "${question.slice(0, 55)}"`);
                            noteReject('contents slides');
                            rejected++;
                            continue;
                        }

                        const quality = analyseAnswerText(completed);
                        if (quality.reject) {
                            console.warn(`   ⛔ Rejected (${quality.why}): "${question.slice(0, 50)}"`);
                            noteReject(quality.why);
                            rejected++;
                            continue;
                        }

                        const relevance = quoteAnswersQuestion(question, completed);
                        if (!relevance.ok) {
                            console.warn(`   ⛔ Rejected (${relevance.why}): "${question.slice(0, 55)}"`);
                            noteReject(relevance.why);
                            rejected++;
                            continue;
                        }

                        answer = completed;
                    }
                }

                allItems.push({
                    question,
                    answer,
                    mode,
                    // skillTag only matters for practice items; for others it
                    // would just create meaningless grouping.
                    skillTag: mode === 'practice' ? String(raw.skillTag || '').trim() : '',
                    category,
                    sourceFile
                });
            }
        }

        const final = allItems.slice(0, 60);
        const attempted = final.length + rejected;
        console.log(`🧠 generate-study-items: ${final.length} item(s)` + (rejected ? ` (${rejected} rejected as ungrounded)` : ''));

        // A high rejection rate usually means the grounding check is too
        // strict rather than the model being wildly creative - worth seeing
        // rather than silently discarding half the output.
        if (rejected > 0) {
            console.log('🧠 Rejection breakdown:', JSON.stringify(rejectReasons));
        }
        if (attempted > 0 && rejected / attempted > 0.35) {
            console.warn(`⚠️ ${Math.round((rejected / attempted) * 100)}% of generated questions were rejected. If they looked valid, the grounding threshold may be too strict.`);
        }

        if (final.length === 0) {
            // Explain the failure instead of a blank "couldn't do it". A maths
            // or exercise PDF genuinely may not contain anything worth
            // studying, and the user needs to know that's the reason - not
            // wonder whether the app is broken.
            const top = Object.entries(rejectReasons).sort((a, b) => b[1] - a[1]).slice(0, 2);
            let detail = '';
            if (top.length > 0) {
                detail = ' Most were discarded because of: ' + top.map(([r, n]) => `${r} (${n})`).join(', ') + '.';
            }

            let advice = '';
            const reasonText = Object.keys(rejectReasons).join(' ');
            if (/garbled|font encoding|formula|prose/.test(reasonText)) {
                advice = ' This file is heavy on formulas and symbols, which PDF text extraction mangles. Lecture notes or summaries written mostly in words work far better than slides full of equations.';
            } else if (/exercise|problems|question/.test(reasonText)) {
                advice = ' This looks like a problem sheet rather than teaching material. There are no definitions to quote, so try a lecture summary instead.';
            }

            return JSON.stringify({
                error: `No usable questions came out of this document.${detail}${advice}`
            });
        }
        return JSON.stringify(final);
    } catch (error) {
        console.error('❌ generate-study-items failed:', error.message);
        return JSON.stringify({ error: error.message });
    }
});

// ---- Study CRUD passthrough ----
ipcMain.handle('get-due-study-items', async (event, opts = {}) => {
    try { return await api.getDueStudyItems(opts); } catch (err) { console.error('get-due failed:', err.message); return []; }
});

ipcMain.handle('get-study-stats', async () => {
    try { return await api.getStudyStats(); } catch (err) { console.error('study stats failed:', err.message); return null; }
});

ipcMain.handle('save-study-items', async (event, items) => {
    try { return await api.createStudyItemsBulk(items); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('submit-study-review', async (event, id, payload) => {
    try { return await api.submitStudyReview(id, payload); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('delete-study-item', async (event, id) => {
    try { return await api.deleteStudyItem(id); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('update-study-item', async (event, id, updates) => {
    try { return await api.updateStudyItem(id, updates); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('get-study-items', async (event, opts = {}) => {
    try { return await api.getStudyItems(opts); } catch (err) { console.error('get-study-items failed:', err.message); return []; }
});

ipcMain.handle('delete-all-study-items', async () => {
    try { return await api.deleteAllStudyItems(); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('delete-study-items-bulk', async (event, ids) => {
    try { return await api.deleteStudyItemsBulk(ids); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('get-study-categories', async () => {
    try { return await api.getStudyCategories(); } catch (err) { return []; }
});





// Converts stray LaTeX commands into the characters they represent.
//
// The prompt asks for plain symbols, but the model reaches for LaTeX out of
// habit on maths content. Answers are rendered as plain text, so "\lambda"
// would appear literally - readable, but sloppy enough to undermine trust in
// a study answer.
// Command name -> the character it represents. The keys deliberately carry NO
// backslash: it's added when the regex is built, via a properly escaped
// literal. Writing "\\in" here and passing it to new RegExp() produced the
// pattern /\in/, which JavaScript reads as plain "in" - so the cleaner
// rewrote the word "Main" in a Java snippet as "Ma∈". Keeping the escaping in
// exactly one place stops that class of mistake recurring.
const LATEX_MAP = {
    lambda: 'λ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
    theta: 'θ', sigma: 'σ', mu: 'μ', pi: 'π', phi: 'φ', rho: 'ρ', tau: 'τ',
    Sigma: 'Σ', Delta: 'Δ', Omega: 'Ω', Gamma: 'Γ', Phi: 'Φ',
    cdot: '·', times: '×', div: '÷', pm: '±',
    leq: '≤', geq: '≥', neq: '≠', approx: '≈', equiv: '≡', sim: '~',
    in: '∈', notin: '∉', subseteq: '⊆', subset: '⊂', cup: '∪', cap: '∩',
    forall: '∀', exists: '∃', infty: '∞', sqrt: '√', emptyset: '∅',
    rightarrow: '→', to: '→', leftrightarrow: '↔', Rightarrow: '⇒',
    land: '∧', lor: '∨', neg: '¬', sum: 'Σ', prod: '∏', int: '∫'
};

function cleanMathNotation(text) {
    let t = String(text || '');

    // Accents applied to a variable: \bar{x} -> x̄, \hat{p} -> p̂.
    t = t.replace(/\\bar\s*\{([^{}]+)\}/g, '$1\u0304');
    t = t.replace(/\\hat\s*\{([^{}]+)\}/g, '$1\u0302');
    t = t.replace(/\\vec\s*\{([^{}]+)\}/g, '$1\u20D7');
    t = t.replace(/\\overline\s*\{([^{}]+)\}/g, '$1\u0304');

    // Sub and superscripts keep their braces stripped: T_{\bar{x}} -> T_x̄
    t = t.replace(/_\s*\{([^{}]+)\}/g, '_$1');
    t = t.replace(/\^\s*\{([^{}]+)\}/g, '^$1');

    // \frac{a}{b} -> (a)/(b)
    t = t.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)');

    for (const [cmd, sym] of Object.entries(LATEX_MAP)) {
        // '\\\\' is a single literal backslash in the pattern, so this only
        // ever matches a real LaTeX command and never a bare English word.
        t = t.replace(new RegExp('\\\\' + cmd + '(?![a-zA-Z])', 'g'), sym);
    }

    // Inline math delimiters. These are the most visible offenders - a
    // statistics answer came back as "$T_{\bar{x}}$ ... $\sigma^2$", which
    // renders literally and looks broken.
    t = t.replace(/\$\$?/g, '');
    t = t.replace(/\\text\s*\{([^{}]+)\}/g, '$1');
    t = t.replace(/\\mathrm\s*\{([^{}]+)\}/g, '$1');
    // Strip inline math delimiters and leftover braces around single terms.
    t = t.replace(/\$\$?/g, '').replace(/\\[()\[\]]/g, '');
    t = t.replace(/\{([^{}]{1,12})\}/g, '$1');
    return t.replace(/\s{2,}/g, ' ').trim();
}

// The study-question prompt, shared by the PDF and image paths so the two
// can't drift apart.
function buildStudyPrompt(category) {
    return `You are looking at a student's course material${category ? ` for "${category}"` : ''}. Turn it into study items.

FIRST, decide what kind of document this is:

(A) TEACHING MATERIAL - lecture slides, a chapter, notes. It explains concepts.
(B) WORKSHEET WITH SOLUTIONS - exercises AND their worked solutions (a tutor's booklet).
(C) ASSIGNMENT OR EXAM - exercises with NO solutions given.

A document can contain more than one kind. Handle each part by its own rules.

---
FOR (A) TEACHING MATERIAL -> mode "recall"
Ask about definitions, theorems, conditions, formulas, notation, methods.
The "answer" is the explanation as the material states it.
Set "solutionSource": "document".

THE EXAM TEST: "Would a lecturer put this on an exam?" If not, skip it.
Never ask about people, places, dates, who discovered what, or course admin.

---
FOR (B) WORKSHEET WITH SOLUTIONS -> mode "practice"
The exercise is the question; the solution printed in the document is the answer.
Copy the worked solution as given - do NOT rewrite or re-derive it. The tutor's
method is what the student is meant to learn.
Set "solutionSource": "document".

---
FOR (C) ASSIGNMENT OR EXAM (no solutions) -> mode "practice"
Solve the exercise yourself and give the full method in "answer": the approach,
the key steps, and the result. Show reasoning, not just a final number.
Set "solutionSource": "ai".
If an exercise is ambiguous or you are not confident in your solution, LEAVE IT
OUT entirely. The student will be told this answer came from an AI and needs
checking, but a wrong solution presented confidently is worse than no item.

---
FOR ALL PRACTICE ITEMS:
- "skillTag": the underlying skill, so repetition happens over the TYPE of
  problem rather than one specific instance. Examples: "hypothesis testing -
  unknown variance", "proof by induction", "eigenvalue computation",
  "linked list traversal".
- Restate the exercise so it stands alone, including any data it needs.

---
CODE in any document:
Ask what a function returns, its time complexity, what a construct does, or what
a snippet outputs and why. Put the code INSIDE the question, formatted. Never ask
the student to write a whole program - there is no way to check that.

---
RULES FOR EVERYTHING:
- Every item must stand alone. The student sees it weeks later without this
  document, so never write "the function", "this formula", "as shown", "לפי הטקסט".
  Name the actual thing and include any code or formula the item depends on.
- Write in the SAME language as the material.
- Write maths as READABLE TEXT, not LaTeX. The app renders plain text, so
  backslash commands appear literally.
  Use the real symbol: λ, α, β, θ, Σ, √, ≤, ≥, ≠, ∈, ⊆, ∪, ∩, ·, μ, σ
  BAD:  "\\lambda I", "A \\cdot v", "$\\sigma^2$"
  GOOD: "λI",          "A · v",       "σ^2"
  Use x_1 and x^2 for sub/superscripts.
- Cover the WHOLE document, start to finish.
- Aim for 10-20 items for a typical document. Give every distinct definition,
  theorem, formula, method or exercise its own item. Never pad to reach a number,
  and never stop early because the first page was enough.
- If there is no examinable content (title page, agenda, photo), return {"items": []}.

Return ONLY JSON:
{"items": [{"question": "...", "answer": "...", "mode": "recall|practice", "solutionSource": "document|ai", "topic": "short skill or topic name"}]}`;
}

// Shared validation for whatever the model returns.
function finaliseStudyItems(responseText, category, sourceFile) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonFromText(responseText));
    } catch (e) {
        console.error('❌ Response was not valid JSON:', String(responseText).slice(0, 300));
        return { error: 'The AI response could not be read. Try again.' };
    }

    let list = Array.isArray(parsed) ? parsed : (parsed.items || []);
    if (!Array.isArray(list)) list = [];

    const seen = new Set();
    const cleaned = [];

    for (const raw of list) {
        if (!raw || !raw.question) continue;

        const question = stripMultipleChoice(String(raw.question).trim());
        if (question.length < 10) continue;

        const key = question.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const mode = raw.mode === 'practice' ? 'practice' : 'recall';
        const solutionSource = raw.solutionSource === 'ai' ? 'ai' : 'document';

        // A stronger model asks better questions but isn't immune to leaning
        // on the document it just read, or to asking about the anecdote.
        if (!isSelfContained(question)) {
            console.warn(`   ⛔ Rejected (needs the document): "${question.slice(0, 55)}"`);
            continue;
        }
        if (isHistoricalTrivia(question)) {
            console.warn(`   ⛔ Rejected (trivia): "${question.slice(0, 55)}"`);
            continue;
        }
        // Recall answers are quoted statements, so a recall question demanding
        // an argument can't be answered by one. Practice items are exactly
        // where reasoning belongs, so they're exempt.
        if (mode === 'recall' && needsReasoningNotQuote(question, 'recall')) {
            console.warn(`   ⛔ Rejected (needs reasoning): "${question.slice(0, 55)}"`);
            continue;
        }

        const answer = cleanMathNotation(String(raw.answer || '').trim());

        // A practice item with no worked solution is the dead end we removed
        // earlier: solve it, go and verify it elsewhere, come back and type in
        // an answer you already know.
        const minLength = mode === 'practice' ? 25 : 5;
        if (!answer || answer.length < minLength) {
            console.warn(`   ⛔ Rejected (no usable answer): "${question.slice(0, 55)}"`);
            continue;
        }

        cleaned.push({
            question: cleanMathNotation(question),
            answer,
            mode,
            solutionSource,
            skillTag: String(raw.topic || '').trim().slice(0, 120),
            category,
            sourceFile
        });
    }

    const byKind = cleaned.reduce((acc, i) => {
        const k = i.mode === 'practice' ? (i.solutionSource === 'ai' ? 'practice (AI solved)' : 'practice (from document)') : 'recall';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
    }, {});
    console.log(`✅ ${cleaned.length} of ${list.length} item(s) kept:`, JSON.stringify(byKind));

    if (cleaned.length === 0) {
        return { error: 'No examinable content was found in this document.' };
    }
    return cleaned.slice(0, 40);
}

// Reads a PDF directly with the cloud model - no extraction, no rasterising.
// This is the simplest path and the least lossy one: the file goes to the
// model exactly as it is, so nothing can be mangled on the way in.
ipcMain.handle('generate-study-items-pdf', async (event, sourcePath, options = {}) => {
    try {
        const category = options.category || '';
        const sourceFile = options.sourceFile || '';

        if (!aiProvider.supportsVision()) {
            return JSON.stringify({ error: 'Reading PDFs directly needs a Gemini API key. Add one under Settings → AI engine.' });
        }
        if (!fs.existsSync(sourcePath)) {
            return JSON.stringify({ error: 'The original file has moved or been deleted. Upload it again under Materials.' });
        }

        const buffer = fs.readFileSync(sourcePath);
        const sizeMb = buffer.length / (1024 * 1024);
        console.log(`📕 generate-study-items-pdf: ${path.basename(sourcePath)} (${sizeMb.toFixed(1)} MB)`);

        // Inline request bodies are capped around 20MB by the API.
        if (sizeMb > 18) {
            return JSON.stringify({ error: `This PDF is ${sizeMb.toFixed(0)}MB, too large to send in one request. Split it into smaller files.` });
        }

        const prompt = buildStudyPrompt(category);
        const responseText = await aiProvider.generateFromPdf(buffer, prompt, {
            // Reading a whole document and drafting 15+ questions is a
            // multi-step task, so it gets a real thinking allowance and a
            // large output budget - the two share the same pool, and an
            // earlier run produced only two questions with both set tight.
            maxTokens: 16384,
            thinkingLevel: 'medium',
            forceJson: true
        });

        return JSON.stringify(finaliseStudyItems(responseText, category, sourceFile));
    } catch (error) {
        console.error('❌ PDF generation failed:', error.message);
        return JSON.stringify({ error: error.message });
    }
});

// =====================================
// Vision-based study item generation
// =====================================
// Reads rendered page images instead of extracted text.
//
// Every quality problem we hit on maths, logic and Hebrew traced back to the
// same place: text extraction had already destroyed the content before any
// model saw it. Formulas lost their structure, subscripts vanished, Hebrew
// came out reordered, and some PDFs emitted plainly wrong characters because
// their embedded font tables were broken. None of that is recoverable by a
// better model or a smarter heuristic - the information is gone.
//
// Reading the page as an image sidesteps all of it. The model sees the slide
// as rendered, so a fraction is a fraction, an index is an index, code keeps
// its indentation, and Hebrew reads right to left.
ipcMain.handle('generate-study-items-vision', async (event, images, options = {}) => {
    try {
        const category = options.category || '';
        const sourceFile = options.sourceFile || '';
        console.log(`👁️ generate-study-items-vision: ${images.length} page image(s), category "${category}"`);

        if (!aiProvider.supportsVision()) {
            return JSON.stringify({ error: 'Reading pages visually needs a Gemini API key. Add one under Settings → AI, or this file will be read as plain text instead.' });
        }

        const prompt = `You are looking at pages from a student's course material. Create study questions from what you can SEE on these pages.

THE EXAM TEST - apply to every question before writing it:
"Would a lecturer put this on an exam?"
If not, don't ask it. Never ask about people, places, dates, who discovered what, or course admin (deadlines, grading). Those belong to the story around the material, not the material.

WHAT TO ASK ABOUT, by content type:

Definitions and concepts -> "recall".
  Ask what something is, what conditions it must satisfy, how it's denoted.

Mathematical content (formulas, matrices, proofs) -> "recall".
  You can SEE the formula, so transcribe it accurately into the answer, keeping
  subscripts, superscripts, matrix shape and set notation. Ask what a formula
  states, when it applies, what each part means. Do NOT ask the student to
  compute a specific numeric result.

Code -> "recall".
  Ask what a function returns, what its time complexity is, what a language
  construct does, or what a given snippet outputs and why. Include the relevant
  code in the question itself, formatted, so the question stands alone. Do NOT
  ask the student to write a program - there'd be no way to check it.

Worked examples and exercises -> skip them. There is no solution to review against.

RULES:
- Answers must come from what is written on the page. Do not add outside knowledge.
- Every question must stand alone. The student sees it weeks later without these pages, so never write "the function", "this formula", "as shown", "לפי הטקסט". Name the actual thing, and include any code or formula the question depends on.
- Write in the SAME language as the material.
- Transcribe formulas and code faithfully. Use plain text notation (x_1, x^2, <=, and, or) where a symbol would be ambiguous.
- Produce at most 12 questions across all these pages. Fewer good ones beats more padded ones.
- If the pages contain no examinable content (a title page, an agenda, a photo), return {"items": []}.

Return ONLY JSON:
{"items": [{"question": "...", "answer": "...", "mode": "recall", "topic": "short topic name"}]}`;

        const responseText = await aiProvider.generateFromImages(images, prompt, {
            maxTokens: 4096,
            forceJson: true
        });

        let parsed;
        try {
            parsed = JSON.parse(extractJsonFromText(responseText));
        } catch (e) {
            console.error('❌ Vision response was not valid JSON:', responseText.slice(0, 300));
            return JSON.stringify({ error: 'The AI response could not be read. Try again.' });
        }

        let list = Array.isArray(parsed) ? parsed : (parsed.items || []);
        if (!Array.isArray(list)) list = [];

        const seen = new Set();
        const cleaned = [];

        for (const raw of list) {
            if (!raw || !raw.question) continue;

            const question = stripMultipleChoice(String(raw.question).trim());
            if (question.length < 10) continue;

            const key = question.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            // The self-containment and trivia filters still apply - a stronger
            // model asks better questions but is not immune to asking about
            // the anecdote or leaning on the page it just read.
            if (!isSelfContained(question)) {
                console.warn(`   ⛔ Rejected (needs the document): "${question.slice(0, 55)}"`);
                continue;
            }
            if (isHistoricalTrivia(question)) {
                console.warn(`   ⛔ Rejected (trivia): "${question.slice(0, 55)}"`);
                continue;
            }
            if (needsReasoningNotQuote(question, 'recall')) {
                console.warn(`   ⛔ Rejected (needs reasoning): "${question.slice(0, 55)}"`);
                continue;
            }

            const answer = String(raw.answer || '').trim();
            if (!answer || answer.length < 5) continue;

            cleaned.push({
                question,
                answer,
                mode: 'recall',
                skillTag: String(raw.topic || '').trim().slice(0, 120),
                category,
                sourceFile
            });
        }

        console.log(`👁️ generate-study-items-vision: ${cleaned.length} question(s) from ${images.length} page(s)`);

        if (cleaned.length === 0) {
            return JSON.stringify({ error: 'No examinable content was found on these pages.' });
        }
        return JSON.stringify(cleaned.slice(0, 40));
    } catch (error) {
        console.error('❌ Vision generation failed:', error.message);
        return JSON.stringify({ error: error.message });
    }
});

// ---- AI provider settings ----
ipcMain.handle('get-ai-config', async () => {
    const cfg = aiProvider.readConfig();
    // Never hand the full key back to the renderer - a masked form is enough
    // to show that one is configured.
    return {
        provider: cfg.provider,
        geminiModel: cfg.geminiModel,
        hasKey: Boolean(cfg.geminiKey),
        keyPreview: cfg.geminiKey ? `${cfg.geminiKey.slice(0, 6)}...${cfg.geminiKey.slice(-4)}` : '',
        active: aiProvider.resolveProvider(),
        visionAvailable: aiProvider.supportsVision()
    };
});

ipcMain.handle('save-ai-config', async (event, updates) => {
    try {
        aiProvider.writeConfig(updates);
        return { success: true, active: aiProvider.resolveProvider() };
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('test-gemini-key', async (event, key) => {
    return aiProvider.testGeminiKey(key);
});

// =====================================
// Google Calendar Sync Functions
// =====================================
async function authenticateGoogle(forceReauth = false) {
  const credentialsPath = path.join(__dirname, 'credentials.json');
  // BUG FIX: the token used to live in the app's own folder (__dirname).
  // (1) In the packaged .exe that folder is inside app.asar, which is
  // read-only - writing the token after a friend connects fails.
  // (2) If token.json sits in the project folder when you run `npm run dist`,
  // it can get packed INTO the .exe, and every friend would then be syncing
  // into YOUR Google Calendar. userData is per-person, per-computer and
  // writable. On your dev machine (npm start) an existing token.json is
  // MOVED over once, so you stay connected. Never in the packaged app: a
  // token.json found inside the .exe is somebody else's, not this user's.
  const tokenPath = path.join(app.getPath('userData'), 'google-token.json');
  const legacyTokenPath = path.join(__dirname, 'token.json');
  if (!app.isPackaged && !fs.existsSync(tokenPath) && fs.existsSync(legacyTokenPath)) {
    try { fs.renameSync(legacyTokenPath, tokenPath); } catch (e) { console.warn('⚠️ Could not move token.json:', e.message); }
  }
  console.log(`🔑 authenticateGoogle: looking for credentials at ${credentialsPath} (exists: ${fs.existsSync(credentialsPath)}), token at ${tokenPath} (exists: ${fs.existsSync(tokenPath)}), forceReauth=${forceReauth}`);
  if (!fs.existsSync(credentialsPath)) throw new Error("credentials.json file is missing in the folder.");

  if (forceReauth && fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath); // token is dead (expired/revoked) - force a fresh consent flow below
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath));
  const creds = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:3000/oauth2callback');

  if (!forceReauth && fs.existsSync(tokenPath)) {
    console.log('🔑 Using existing token.json (no browser popup expected).');
    const token = fs.readFileSync(tokenPath);
    oAuth2Client.setCredentials(JSON.parse(token));
    return oAuth2Client;
  }

  console.log('🔑 No usable token found - opening browser for consent...');
  return new Promise((resolve, reject) => {
      const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar.events'] });
      const server = http.createServer(async (req, res) => {
        try {
          if (req.url.indexOf('/oauth2callback') > -1) {
            const code = new URL(req.url, 'http://localhost:3000').searchParams.get('code');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1 style="text-align:center; margin-top:50px;">Successfully connected to MindSync! 🧠</h1><p style="text-align:center;">You can close this window.</p>');
            server.close();
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            fs.writeFileSync(tokenPath, JSON.stringify(tokens));
            resolve(oAuth2Client);
          }
        } catch (e) { reject(e); }
      });
      // BUG FIX: if port 3000 is already taken (a React/Node dev server is
      // the usual suspect on a student's machine) the 'error' event had no
      // listener - an uncaught error in the main process, and the connect
      // button waited forever. Now it fails with a message that says why.
      server.on('error', (err) => {
        reject(new Error(err.code === 'EADDRINUSE'
          ? 'Port 3000 is in use by another program (maybe a dev server). Close it and try connecting again.'
          : err.message));
      });
      // Closing the browser tab without approving used to leave this
      // waiting forever too. Five minutes is plenty to click "Allow".
      const giveUp = setTimeout(() => {
        server.close();
        reject(new Error('Google sign-in was not completed. Try connecting again.'));
      }, 5 * 60 * 1000);
      server.on('close', () => clearTimeout(giveUp));
      server.listen(3000, () => require('electron').shell.openExternal(authUrl));
  });
}

// Runs a Google Calendar API call; if it fails because the stored token is
// dead (expired/revoked - the "invalid_grant" family of errors, which is
// exactly what happens if the OAuth consent screen is still in "Testing"
// mode and the refresh_token silently expired after 7 days), it clears the
// token and retries once with a fresh browser consent flow instead of
// failing forever on every subsequent call.
async function callGoogleWithReauth(fn) {
  const auth = await authenticateGoogle(false);
  try {
    return await fn(auth);
  } catch (error) {
    const msg = (error.message || '').toLowerCase();
    const isDeadToken = msg.includes('invalid_grant') || msg.includes('invalid_token') || error.code === 401;
    if (!isDeadToken) throw error;

    console.warn('Google token appears expired/revoked - re-authenticating...');
    const freshAuth = await authenticateGoogle(true);
    return await fn(freshAuth);
  }
}

async function syncToGoogleCalendar(evtData) {
    console.log('📅 syncToGoogleCalendar called with:', JSON.stringify(evtData));
    try {
        return await callGoogleWithReauth(async (auth) => {
            const calendar = google.calendar({ version: 'v3', auth });

            const now = new Date();
            const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const targetDayIndex = dayNames.indexOf(evtData.day);

            // One-time events go on their own date. Weekly ones (no date)
            // start at the next occurrence of their day and repeat weekly in
            // Google too, the same as they do on the board.
            let startDate = new Date(now);
            const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(evtData.date || '');
            if (dateMatch) {
                startDate = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
            } else if (targetDayIndex !== -1) {
                let currentDayIndex = now.getDay();
                let daysToAdd = targetDayIndex - currentDayIndex;
                if (daysToAdd < 0) daysToAdd += 7;
                startDate.setDate(now.getDate() + daysToAdd);
            }

            const [hours, minutes] = evtData.time.split(':');
            startDate.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
            // BUG FIX: every event was exactly one hour in Google, even a
            // 3-hour planned study block.
            const endDate = new Date(startDate.getTime() + (Number(evtData.durationMinutes) || 60) * 60 * 1000);
            console.log(`📅 Inserting into Google Calendar: "${evtData.title}" at ${startDate.toString()}`);

            // BUG FIX: same class of bug already fixed for Gemini and the
            // local server - no timeout meant a slow/hung network call here
            // would block indefinitely. main.js is single-threaded, so that
            // doesn't just stall this sync, it freezes the whole app.
            const res = await calendar.events.insert({
                calendarId: 'primary',
                resource: {
                    summary: evtData.title,
                    description: 'Created via MindSync AI 🧠',
                    start: { dateTime: startDate.toISOString(), timeZone: 'Asia/Jerusalem' },
                    end: { dateTime: endDate.toISOString(), timeZone: 'Asia/Jerusalem' },
                    ...(dateMatch ? {} : { recurrence: ['RRULE:FREQ=WEEKLY'] })
                },
            }, { timeout: 15000 });

            console.log('✅ Google Calendar insert succeeded:', res.data.htmlLink);
            return { success: true, link: res.data.htmlLink, eventId: res.data.id };
        });
    } catch (error) {
        // Surface the real reason instead of a generic "skipped" - this is
        // what actually lets you (or me) diagnose a sync failure.
        console.error("❌ Google Calendar sync failed:", error.message);
        return { success: false, error: error.message };
    }
}

// =====================================
// Events
// =====================================
ipcMain.handle('get-events', async () => {
  try { return await api.getEvents(); } 
  catch (err) { return []; }
});

ipcMain.handle('save-event', async (event, newEvent) => {
  try {
    // 1. קודם כל שומרים מקומית - חסין תקלות, האירוע תמיד יופיע בתוכנה שלנו
    const savedEvent = await api.createEvent(newEvent);

    try {
        // 2. מושכים את פרופיל המשתמש כדי לבדוק הגדרות גלובליות
        const profile = await api.getMe().catch(() => ({}));
        const alwaysSync = profile.alwaysSyncGoogle === true;

        // 3. בודקים אם הצ'קבוקס סומן ספציפית דרך הממשק
        const isCheckboxChecked = newEvent.syncToGoogle === true;

        // 4. סנכרון לגוגל יקרה רק אם הדיפולט שונה בהגדרות או שהצ'קבוקס סומן
        if (alwaysSync || isCheckboxChecked) {
            const gCalResult = await syncToGoogleCalendar(newEvent);
            if (gCalResult.success) {
                savedEvent.googleEventId = gCalResult.eventId;
                // ניסיון שקט לעדכן את האירוע במסד הנתונים עם ה-ID של גוגל כדי שהמחיקה תעבוד
                if (api.updateEvent) {
                    await api.updateEvent(savedEvent._id, savedEvent).catch(() => {});
                }
            } else {
                console.error("Google Calendar sync failed for this event:", gCalResult.error);
                savedEvent.googleSyncError = gCalResult.error; // let the renderer show a soft warning if it wants to
            }
        }
    } catch (syncError) {
        // אם הסנכרון לגוגל נופל מאיזושהי סיבה (אין אינטרנט, שגיאת הרשאה), 
        // אנחנו בולמים את השגיאה כאן כדי שהמשתמש עדיין יקבל את האירוע השמור ביומן המקומי שלו!
        console.error("Google Sync failed but local event saved:", syncError.message);
    }
    
    return savedEvent;
  } catch (err) { 
    console.error("Save event error:", err.message);
    return { error: err.message }; 
  }
});

ipcMain.handle('add-to-google-calendar', async (event, evtData) => {
    console.log('📨 IPC add-to-google-calendar received:', JSON.stringify(evtData));
    return await syncToGoogleCalendar(evtData);
});

// Deletes one event from Google Calendar (if it was mirrored there) and
// then from our database. Shared by delete-event and by the task handlers
// below, which clean up a task's planned blocks.
async function deleteEventEverywhere(id, knownEvent = null) {
    const evt = knownEvent || await api.getEvent(id);

    // מנגנון מחיקה מגוגל שעובד יחד עם מסד הנתונים
    if (evt && evt.googleEventId) {
        try {
            await callGoogleWithReauth(async (auth) => {
                const calendar = google.calendar({ version: 'v3', auth });
                // Same timeout fix as the insert call above.
                await calendar.events.delete({ calendarId: 'primary', eventId: evt.googleEventId }, { timeout: 15000 });
            });
            console.log("Deleted from Google Calendar.");
        } catch (err) {
            // Google Calendar may have already had this event deleted manually -
            // that's a 404/410 from Google, not a real failure. Anything else,
            // log it so it's visible instead of silently vanishing.
            console.error("Google Calendar delete error:", err.message);
        }
    }

    // מחיקה מקומית לאחר המחיקה מגוגל
    await api.deleteEvent(id);
}

ipcMain.handle('delete-event', async (event, id) => {
  try {
    await deleteEventEverywhere(id);
    return true;
  } catch (err) { return { error: err.message }; }
});

// =====================================
// Folders & Files
// =====================================
ipcMain.handle('get-folders', async () => {
  try { return await api.getFolders(); } catch (err) { return []; }
});
ipcMain.handle('save-folder', async (event, newFolder) => {
  try { return await api.createFolder(newFolder); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('delete-folder', async (event, id) => {
  try { return await api.deleteFolder(id); } catch (err) { return { error: err.message }; }
});
// =====================================
// Summary window
// =====================================
// The summary used to live in a small fixed modal inside the main window:
// too cramped to read, impossible to keep next to a study session, and gone
// the moment it closed. It now opens in its own resizable window (one per
// file - clicking Summarize again just brings it to the front), and the
// summary itself is saved on the file on the server.
const summaryWindows = new Map(); // fileId -> BrowserWindow

ipcMain.handle('open-summary-window', async (event, fileId, fileName) => {
    const existing = summaryWindows.get(fileId);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return true;
    }
    const win = new BrowserWindow({
        width: 900,
        height: 820,
        minWidth: 420,
        minHeight: 360,
        title: `Summary - ${fileName || 'document'}`,
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadFile('summary.html', { query: { fileId: String(fileId) } });
    summaryWindows.set(fileId, win);
    win.on('closed', () => summaryWindows.delete(fileId));
    return true;
});

ipcMain.handle('get-file', async (event, id) => {
    try { return await api.getFile(id); }
    catch (err) { return { error: err.message }; }
});

ipcMain.handle('save-file-summary', async (event, id, summary) => {
    try {
        const updated = await api.updateFile(id, { summary });
        // Tell every open window, so the main window's Materials list can
        // flip "Summarize" to "View summary" without a manual refresh.
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) w.webContents.send('files-changed');
        });
        return updated;
    } catch (err) {
        return { error: err.message };
    }
});

// Getting-started checklist on Home: which of the first steps this user has
// already done. All checks run in parallel, and each one fails soft - one
// slow or broken call shouldn't blank the whole checklist.
ipcMain.handle('get-onboarding-status', async () => {
  // A failed call is NOT the same as "zero": if the server is down or still
  // waking up, an existing user would look brand new and suddenly get the
  // getting-started guide. Any failure -> report it, and the guide stays hidden.
  let failed = false;
  const safe = (p, fallback) => p.catch(() => { failed = true; return fallback; });
  const [files, stats, events, tasks] = await Promise.all([
    safe(api.getFilesLight(), []),
    safe(api.getStudyStats(), null),
    safe(api.getEvents(), []),
    safe(api.getTasks(), [])
  ]);
  if (failed) return { error: 'unavailable' };
  return {
    hasKey: Boolean(aiProvider.readConfig().geminiKey),
    files: (files || []).length,
    questions: stats ? stats.totalItems || 0 : 0,
    reviews: stats ? stats.reviewsAllTime || 0 : 0,
    calendarItems: (events || []).length + (tasks || []).length
  };
});

ipcMain.handle('get-files-light', async () => {
  try { return await api.getFilesLight(); } catch (err) { return []; }
});

ipcMain.handle('get-files', async () => {
  try { return await api.getFiles(); } catch (err) { return []; }
});
ipcMain.handle('save-file', async (event, newFile) => {
  try { return await api.createFile(newFile); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('delete-file', async (event, id) => {
  try { return await api.deleteFile(id); } catch (err) { return { error: err.message }; }
});

// =====================================
// App Blocker 
// =====================================
let isBlockingEnabled = false;
ipcMain.on('toggle-blocking', (event, status) => { isBlockingEnabled = status; });


// Lets the user pick an actual executable instead of typing its filename.
// Typing "chrome.exe" from memory is error-prone - the wrong name simply
// never matches anything and the block silently does nothing, with no
// feedback that it was wrong.
ipcMain.handle('pick-application', async () => {
  const isWindows = process.platform === 'win32';
  const result = await dialog.showOpenDialog({
    title: 'Choose an application to block',
    properties: ['openFile'],
    defaultPath: isWindows ? 'C:\\Program Files' : '/Applications',
    filters: isWindows
      ? [{ name: 'Applications', extensions: ['exe'] }]
      : [{ name: 'Applications', extensions: ['app'] }]
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  // The blocker matches against the process name, which is the file name.
  return { name: path.basename(result.filePaths[0]), fullPath: result.filePaths[0] };
});

// Common distractions, offered as one-tap presets so the usual cases need no
// typing or file browsing at all.
ipcMain.handle('get-suggested-apps', async () => {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    return [
      { label: 'Steam', value: 'steam.exe' },
      { label: 'Discord', value: 'Discord.exe' },
      { label: 'Epic Games', value: 'EpicGamesLauncher.exe' },
      { label: 'Battle.net', value: 'Battle.net.exe' },
      { label: 'League of Legends', value: 'LeagueClient.exe' },
      { label: 'Riot Client', value: 'RiotClientServices.exe' },
      { label: 'Telegram', value: 'Telegram.exe' },
      { label: 'WhatsApp', value: 'WhatsApp.exe' },
      { label: 'Spotify', value: 'Spotify.exe' },
      { label: 'Roblox', value: 'RobloxPlayerBeta.exe' },
      { label: 'Minecraft', value: 'Minecraft.exe' },
      { label: 'GOG Galaxy', value: 'GalaxyClient.exe' }
    ];
  }
  return [
    { label: 'Steam', value: 'Steam' },
    { label: 'Discord', value: 'Discord' },
    { label: 'Telegram', value: 'Telegram' },
    { label: 'WhatsApp', value: 'WhatsApp' },
    { label: 'Spotify', value: 'Spotify' }
  ];
});

ipcMain.handle('get-blocked-apps', async () => {
  try { return await api.getBlockedApps(); } catch (err) { return []; }
});
ipcMain.handle('add-blocked-app', async (event, appName) => {
  try { return await api.addBlockedApp(appName); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('remove-blocked-app', async (event, appName) => {
  try { return await api.removeBlockedApp(appName); } catch (err) { return { error: err.message }; }
});

async function checkAndBlockApps() {
  if (!isBlockingEnabled) return;
  let currentBlockedApps;
  try {
    currentBlockedApps = await api.getBlockedApps();
  } catch (err) { return; }
  exec('tasklist', (err, stdout) => {
    if (err) return;
    currentBlockedApps.forEach(appName => {
      if (stdout.toLowerCase().includes(appName.toLowerCase())) exec(`taskkill /IM ${appName} /F`);
    });
  });
}

// =====================================
// System Core
// =====================================
ipcMain.handle('hard-reset', async () => {
  try {
    // BUG FIX: the server wipes the events, but their Google Calendar copies
    // stayed behind forever with nothing left pointing at them. Remove those
    // first (best effort - a Google failure must not block the reset).
    try {
      const events = await api.getEvents();
      for (const e of (events || []).filter(ev => ev.googleEventId)) {
        await deleteEventEverywhere(e.id || e._id, e).catch(err =>
          console.warn('⚠️ Reset: could not remove Google copy of', e.title, err.message));
      }
    } catch (err) {
      console.warn('⚠️ Reset: skipped Google cleanup:', err.message);
    }
    await api.hardReset();
    return true;
  } catch (err) { return { error: err.message }; }
});

function createWindow () {
  const mainWindow = new BrowserWindow({ width: 1280, height: 800, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  mainWindow.loadFile('index.html');
  setInterval(checkAndBlockApps, 3000);
}

app.whenReady().then(() => {
    app.setAppUserModelId("com.mindsync.app");
    // Initialized first, deliberately - so any error during the rest of
    // startup (Gemini config, session restore) is itself captured in the log
    // instead of only existing in a terminal window a packaged app doesn't have.
    logger.initLogger(app.getPath('userData'));
    aiProvider.initConfig(app.getPath('userData'));
    authClient.initSession(app.getPath('userData'));
    createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });