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
// The summary instructions, shared by both paths below.
//
// WHY THE OLD SUMMARIES WERE BASIC: the prompt literally asked for "short and
// concise bullet points", at the lowest thinking level, with a 2000-token
// budget that the model's thinking ALSO comes out of - about a page of room
// for a 40-page lecture. A stronger model given the same instructions writes
// the same thin list, just more politely. This asks for what a student
// actually studies from: full explanations, every symbol in a formula, a
// worked example, the mistakes people make, and what's likely on the exam.
//
// Formatting is limited to what the summary window can draw (summary.js):
// ## / ### headings, "- " bullets, "1. " lists, **bold**, LaTeX, and ```
// code blocks. No tables - they'd show up as rows of pipes.
function buildSummaryPrompt() {
    return `You are writing a study summary for a university student who will use it to prepare for an exam on this material. They have the original file; what they need is ONE place that actually explains it - not a list of slide titles.

LANGUAGE: write in the same language as the material (Hebrew material -> Hebrew summary, including all headings). Keep a technical term in the form the material uses; where the material gives both, write both once, e.g. "רגרסיה לינארית (Linear Regression)".

STRUCTURE:
1. "## " + the subject of the material, then 2-3 sentences: what this material is about and what problem it solves.
2. One "## " section per main topic, in the material's order. In each one:
   - Explain the idea in full sentences, the way a good teaching assistant would. Say WHY it works and WHEN it's used - not only WHAT it is.
   - The first time a key term appears, write it in **bold** together with its definition.
   - Every formula: on its own line between double dollar signs, then a "- " bullet for EVERY symbol in it saying what it means, then one sentence on when to use it.
   - A procedure or algorithm: numbered steps ("1. ").
   - An example in the material: walk through it step by step, with the numbers. If a topic has no example and one would really help, add a short one and label it clearly as not from the material (in the material's language, e.g. "דוגמה (לא מהחומר)").
   - Code: copy it exactly, in a code block (three backticks on their own line before and after).
3. "## " + "Common mistakes" (in the material's language): the confusions a student is likely to have - especially between concepts that look alike in THIS material - and how to tell them apart.
4. "## " + "Key points for the exam" (in the material's language): 5-10 bullets, the points most likely to be tested.

RULES:
- Stay faithful to the material. Do not invent facts. Anything you add (an example, an intuition) must be labelled as your addition.
- Skip course logistics: dates, grading, the lecturer's contact details, reading lists.
- Length follows the material. A short file gets a short summary; a long lecture gets a long one. Never pad, never skip a topic.
- Formatting: only "## " and "### " headings, "- " bullets, "1. " numbered steps, **bold**, LaTeX and code blocks. NO tables and NO nested (indented) bullets - they cannot be displayed.
- LaTeX: inline between single dollar signs ($\\bar{x}$), a standalone formula on its own line between double dollar signs ($$...$$).
- Output only the summary itself - no "Here is the summary" line before it and no offer to help after it.`;
}

ipcMain.handle('summarize-text', async (event, textToSummarize, sourcePath) => {
    try {
        // Always a string (30/9): an array used to slip past the length check.
        textToSummarize = typeof textToSummarize === 'string' ? textToSummarize : String(textToSummarize == null ? '' : textToSummarize);
        // Was 2000 - and Gemini's thinking is paid out of this same budget,
        // which left roughly one page of actual summary. A long lecture
        // needs room; the model stops when it's done, so a short file still
        // gets a short (and cheap) summary.
        const SUMMARY_MAX_OUTPUT_TOKENS = 16384;
        // A full summary of a long file takes longer than the 90s default.
        const SUMMARY_TIMEOUT_MS = 180000;
        const summaryPrompt = buildSummaryPrompt();

        // Returns the summary AND which model wrote it, so the summary
        // window can say so (and say when the chosen model wasn't available).
        const result = (text, model) => ({
            summary: coerceToPlainText(text),
            model,
            modelLabel: aiProvider.modelLabel(model),
            requestedModelLabel: aiProvider.modelLabel(aiProvider.activeGeminiModel())
        });

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
                    const r = await aiProvider.generateFromPdf(buffer, summaryPrompt, {
                        maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
                        // Explaining a topic well is reasoning, not copying.
                        thinkingLevel: 'medium',
                        timeoutMs: SUMMARY_TIMEOUT_MS,
                        withMeta: true
                    });
                    console.log(`📝 summarize-text: used vision (direct PDF read) - ${r.model}`);
                    return result(r.text, r.model);
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
        // Gemini reads far more than a local model can: 15,000 characters was
        // about 5 pages, so a long file was summarized from its beginning
        // only. Gemini now gets up to ~120,000; the local model keeps the
        // smaller limit its context window can actually hold.
        const SUMMARY_MAX_INPUT_CHARS = aiProvider.resolveProvider() === 'gemini' ? 120000 : 15000;

        const safeText = textToSummarize && textToSummarize.length > SUMMARY_MAX_INPUT_CHARS
            ? textToSummarize.slice(0, SUMMARY_MAX_INPUT_CHARS) + '\n\n[...document truncated...]'
            : (textToSummarize || '');

        const prompt = `${summaryPrompt}

THE MATERIAL (extracted text - formulas and layout may be damaged; reconstruct them only where the meaning is clear):

${safeText}`;
        const plainTextSystem = "You write study summaries. Respond with the summary text only - never JSON, never a key-value structure.";
        const r = await aiProvider.generateText(prompt, {
            system: plainTextSystem,
            maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
            thinkingLevel: 'medium',
            timeoutMs: SUMMARY_TIMEOUT_MS,
            localModel: LOCAL_MODEL,
            withMeta: true
        });
        return result(r.text, r.model);
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

// =====================================
// Import from a syllabus
// =====================================
// "Find exams & deadlines" - replaces the old "Find deadlines" (extract-tasks-from-text). That one read the
// file's extracted text in 2,000-character pieces - a syllabus table cut in
// half loses which date belongs to which row - turned everything into tasks
// (an exam is not a task, it belongs in the Planner), and added it all at
// once with no chance to check it.
//
// Now it's two steps:
//   1. read-syllabus: reads the whole file (the PDF itself when possible)
//      and returns what it found - exams and submissions with their dates -
//      WITHOUT saving anything.
//   2. import-syllabus-items: adds only what the user left ticked: exams go
//      to the Planner as dated events, submissions go to Tasks.

const MONTHS_FOR_MATCH = [
    ['ינואר', 'january', 'jan'], ['פברואר', 'february', 'feb'], ['מרץ', 'מרס', 'march', 'mar'],
    ['אפריל', 'april', 'apr'], ['מאי', 'may'], ['יוני', 'june', 'jun'],
    ['יולי', 'july', 'jul'], ['אוגוסט', 'august', 'aug'], ['ספטמבר', 'september', 'sep', 'sept'],
    ['אוקטובר', 'october', 'oct'], ['נובמבר', 'november', 'nov'], ['דצמבר', 'december', 'dec']
];

function buildSyllabusPrompt(todayISO) {
    return `You read a university course document - usually a syllabus (סילבוס), a course schedule or an assignment sheet - and list its DATED ACADEMIC EVENTS, so a student can put them in their calendar. Today's date is ${todayISO}.

Find three kinds of items:
- "class": a WEEKLY meeting with a fixed day and time - the lecture (הרצאה), the tutorial (תרגול), a lab (מעבדה). One item per meeting, e.g. "מועדי ההרצאה: יום ד' 8:30-12:30" -> {"kind": "class", "title": "הרצאה", "weekday": "Wednesday", "time": "08:30", "endTime": "12:30"}. Office hours (שעות קבלה) are NOT a class.
- "exam": a test the student sits - final exam (מבחן / בחינה סופית), each sitting (מועד א / מועד ב / מועד ג - each sitting is its OWN item), midterm (בוחן אמצע), quiz (בוחן), oral exam.
- "assignment": something the student must SUBMIT or PRESENT by a date - homework or an exercise to hand in (מטלה, תרגיל להגשה, ממ"ן, עבודה), a project or a project milestone, a lab report, a presentation, a paper.

Do NOT list: the TOPICS of each lecture ("שיעור 3: סדרות"), reading without a deadline, holidays, office hours, how the grade is weighted, rules and policies.

MANY SYLLABI HAVE NO DATES. That's fine - still list what's there:
- An exam with no date given ("מבחן סוף סמסטר") -> the exam item with "date": null.
- Homework / exercises with no dates -> ONE item for all of them, e.g. {"kind": "assignment", "title": "תרגילי בית (10)", "date": null} - not one item per exercise.

For every item return:
- "kind": "exam" or "assignment".
- "title": a short name in the document's language, the way the document names it ("מטלה 2", "בוחן אמצע", "מבחן סופי - מועד א"). Do NOT add the course name.
- "date": {"day": number, "month": number, "year": number or null} - ONLY a date written in the document for this item. "year": null if the document doesn't write the year. No date written for this item -> "date": null. Never guess, and never work a date out from a week number ("שבוע 5") - use null.
- "time": "HH:MM" if the document gives a time for it, otherwise null.
- "durationMinutes": the exam's length in minutes if the document gives it, otherwise null.
- For "class" only: "weekday" (English day name, e.g. "Wednesday") and "endTime" ("HH:MM" or null). Classes have no "date".
- "sourceQuote": the exact text in the document where this item and its date appear (for a table: that row). Copy it as written.

A deadline given as a range ("להגיש בין 1.11 ל-5.11") -> use the LAST day.
Also return "course": the course name as the document writes it (without the course number), or null.
Also return "classesUntil": the date the weekly classes END, ONLY if the document writes it (the semester's end date, "סוף הסמסטר 15.1", or the date of the last lecture) - as {"day", "month", "year"}. Not written -> null. Never guess it.

If the document has no exams and no submissions (lecture slides, notes, an exercise sheet with no due date), return {"course": null, "items": []}. For such a file, an empty list is the correct answer.

Return ONLY JSON: {"course": "...", "classesUntil": null, "items": [{"kind": "exam|assignment|class", "title": "...", "date": {"day": 1, "month": 1, "year": null}, "time": null, "durationMinutes": null, "weekday": null, "endTime": null, "sourceQuote": "..."}]}`;
}

// {day, month, year} (or "YYYY-MM-DD" / "DD.MM(.YYYY)") -> "YYYY-MM-DD", or
// null. A syllabus often leaves out the year: pick the year that puts the
// date within ~100 days back (a semester that already started) to ~265 days
// ahead. So in late September, "15.2" and "1.6" are next year, and "20.9" is
// last week, not next September.
function resolveSyllabusDate(raw, now = new Date()) {
    if (!raw) return null;
    let day, month, year = null;
    if (typeof raw === 'string') {
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw.trim());
        if (m) { year = +m[1]; month = +m[2]; day = +m[3]; }
        else if ((m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/.exec(raw.trim()))) {
            day = +m[1]; month = +m[2]; year = m[3] ? +m[3] : null;
        } else return null;
    } else if (typeof raw === 'object') {
        day = Number(raw.day); month = Number(raw.month);
        year = raw.year === null || raw.year === undefined || raw.year === '' ? null : Number(raw.year);
    } else return null;

    if (!Number.isInteger(day) || !Number.isInteger(month) || day < 1 || day > 31 || month < 1 || month > 12) return null;
    if (year !== null) {
        if (!Number.isInteger(year)) return null;
        if (year < 100) year += 2000;
        if (year < 2000 || year > 2100) return null;
    } else {
        const today = new Date(now); today.setHours(0, 0, 0, 0);
        year = today.getFullYear();
        const probe = new Date(year, month - 1, day);
        const daysFromToday = Math.round((probe - today) / 86400000);
        if (daysFromToday < -100) year += 1;
        else if (daysFromToday > 265) year -= 1;
    }
    const d = new Date(year, month - 1, day);
    if (d.getDate() !== day || d.getMonth() !== month - 1) return null; // 31.2 and the like
    return toLocalIsoDate(d);
}

// "Wednesday" / "Wed" / "רביעי" / "יום ד'" / "ד" -> "Wednesday", or null.
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function normalizeWeekday(raw) {
    const t = String(raw || '').trim().toLowerCase().replace(/^יום\s+/, '').replace(/['׳"״.]/g, '');
    if (!t) return null;
    const en = WEEKDAYS_EN.find(d => d.toLowerCase() === t || d.toLowerCase().slice(0, 3) === t);
    if (en) return en;
    const he = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'].indexOf(t);
    if (he !== -1) return WEEKDAYS_EN[he];
    const letter = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'].indexOf(t);
    return letter !== -1 ? WEEKDAYS_EN[letter] : null;
}

function normalizeTimeText(raw) {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(raw || '').trim());
    if (!m) return null;
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Is this date actually written in the file's text? "26.10", "26/10/2026",
// "26-10-26", "26 באוקטובר", "October 26". Used to flag a date the AI may
// have made up. true / false, or null when there's no text to check against.
function dateAppearsInText(isoDate, text) {
    const src = String(text || '');
    if (src.trim().length < 200) return null;
    const [, mm, dd] = isoDate.split('-').map(Number);
    const numeric = new RegExp(`(?<!\\d)0?${dd}\\s*[./\\-\\\\]\\s*0?${mm}(?!\\d)`);
    if (numeric.test(src)) return true;
    const names = MONTHS_FOR_MATCH[mm - 1].join('|');
    const lower = src.toLowerCase();
    const dayThenMonth = new RegExp(`(?<!\\d)0?${dd}(?:st|nd|rd|th)?\\s*(?:ב|ל|of\\s+)?(?:${names})(?![a-z])`, 'i');
    const monthThenDay = new RegExp(`(?<![a-z])(?:${names})\\.?\\s+0?${dd}(?!\\d)`, 'i');
    return dayThenMonth.test(lower) || monthThenDay.test(lower);
}

// "מבחן סופי - מועד א" + "סטטיסטיקה" -> "מבחן סופי - מועד א - סטטיסטיקה", so
// the Planner says WHICH exam. Left alone if the title already names it.
function titleWithCourse(title, course) {
    const t = String(title || '').trim();
    const c = String(course || '').trim();
    if (!c || normalizeForMatch(t).includes(normalizeForMatch(c))) return t;
    return `${t} - ${c}`;
}

function sameItemTitle(a, b) {
    const x = normalizeForMatch(a), y = normalizeForMatch(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// Task.date is "DD/MM/YYYY" (or "Not set") -> "YYYY-MM-DD" or null.
function taskDateToIso(dateStr) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dateStr || ''));
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

ipcMain.handle('read-syllabus', async (event, file = {}) => {
    try {
        const now = new Date();
        const todayIso = toLocalIsoDate(now);
        const prompt = buildSyllabusPrompt(todayIso);
        const sourceText = String(file.content || '');
        const sourcePath = file.sourcePath || '';

        // 1. The PDF itself: a syllabus is mostly TABLES, and extracted text
        //    loses which date sits in which row.
        let r = null;
        let usedPdf = false;
        if (/\.pdf$/i.test(sourcePath) && fs.existsSync(sourcePath) && aiProvider.supportsVision()) {
            const buffer = fs.readFileSync(sourcePath);
            if (buffer.length <= 18 * 1024 * 1024) {
                try {
                    r = await aiProvider.generateFromPdf(buffer, prompt, {
                        forceJson: true, maxTokens: 8192, thinkingLevel: 'low', timeoutMs: 120000, withMeta: true
                    });
                    usedPdf = true;
                } catch (err) {
                    // Out of quota: the text path would hit the same wall.
                    if (/quota/i.test(err.message)) return { error: err.message };
                    console.warn('⚠️ read-syllabus: direct PDF read failed, using the extracted text:', err.message);
                }
            }
        }

        // 2. Otherwise the text we stored at upload - all of it in ONE request
        //    (not 2,000-character pieces), so a table stays together.
        if (!r) {
            if (!sourceText.trim()) return { error: 'This file has no readable text.' };
            const maxChars = aiProvider.resolveProvider() === 'gemini' ? 120000 : 15000;
            r = await aiProvider.generateText(`${prompt}\n\nTHE DOCUMENT (extracted text - table layout may be lost):\n${sourceText.slice(0, maxChars)}`, {
                // No local-model fallback: a small offline model reads a
                // syllabus badly (it returned items with no dates), and a wrong
                // exam date is worse than "try again later".
                forceJson: true, maxTokens: 8192, thinkingLevel: 'low', timeoutMs: 120000, withMeta: true, noFallback: true
            });
        }

        let parsed;
        try {
            parsed = JSON.parse(extractJsonFromText(r.text || ''));
        } catch (e) {
            console.error('❌ read-syllabus: not JSON:', String(r.text).slice(0, 300));
            return { error: 'The AI answer could not be read. Try again.' };
        }
        const rawItems = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
        // '' when the document doesn't name its course - the renderer then
        // uses the file's folder, a course the user already has, or the
        // file name, in that order.
        const course = String((parsed && parsed.course) || '').trim().slice(0, 80);
        // When the weekly classes stop, if the file says so. Only kept when
        // that date is actually written in the file's text (or the text
        // couldn't be read well enough to check).
        let classesUntil = resolveSyllabusDate(parsed && parsed.classesUntil, now);
        if (classesUntil && sourceText.trim().length >= 200 && dateAppearsInText(classesUntil, sourceText) === false && !usedPdf) classesUntil = null;

        // What's already in the app, so importing the same syllabus twice
        // doesn't add everything twice.
        const [tasks, events] = await Promise.all([
            api.getTasks().catch(() => []),
            api.getEvents().catch(() => [])
        ]);

        const items = [];
        const seen = new Set();
        let rejected = 0;
        for (const raw of rawItems) {
            if (!raw || typeof raw !== 'object') continue;
            const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            if (!title) continue;
            let kind = ['exam', 'assignment', 'class'].includes(raw.kind) ? raw.kind : null;
            if (!kind) kind = classifyEventByKeywords(title) === 'exam' ? 'exam' : 'assignment';

            const quote = String(raw.sourceQuote || '').replace(/\s+/g, ' ').trim().slice(0, 300);
            // Grounding. From extracted text, an item that isn't in that
            // text was made up - dropped, as before. From the PDF, the
            // extracted text can be garbled (Hebrew, tables), so a mismatch
            // there only marks the item for the user to check.
            const canCheck = sourceText.trim().length >= 200;
            const inText = canCheck ? isGroundedInSource(quote || title, sourceText) : null;
            if (!usedPdf && inText === false) {
                console.warn(`   ⛔ read-syllabus: rejected, not in the document: "${title}"`);
                rejected++;
                continue;
            }

            // A weekly class: a day and a start time, or it's useless.
            if (kind === 'class') {
                const weekday = normalizeWeekday(raw.weekday);
                const start = normalizeTimeText(raw.time);
                if (!weekday || !start) continue;
                const end = normalizeTimeText(raw.endTime);
                const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
                const len = end ? toMin(end) - toMin(start) : null;
                const key = `class|${weekday}|${start}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                    kind, title, date: null, weekday, time: start, endTime: end,
                    until: classesUntil,
                    durationMinutes: len && len >= 15 && len <= 720 ? len : null,
                    sourceQuote: quote, isPast: false, needsCheck: inText === false,
                    alreadyExists: (events || []).some(e => !e.date && e.day === weekday && e.time === start)
                });
                continue;
            }

            const date = resolveSyllabusDate(raw.date, now);
            const dateInText = date ? dateAppearsInText(date, sourceText) : null;
            const time = normalizeTimeText(raw.time);
            const dur = Number(raw.durationMinutes);
            const durationMinutes = Number.isFinite(dur) && dur >= 15 && dur <= 600 ? Math.round(dur) : null;

            const key = `${kind}|${date}|${normalizeForMatch(title)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const fullTitle = kind === 'exam' ? titleWithCourse(title, course) : title;
            const alreadyExists = kind === 'exam'
                ? (events || []).some(e => e.date && e.date === date && (sameItemTitle(e.title, fullTitle) || sameItemTitle(e.title, title)))
                : (tasks || []).some(t => taskDateToIso(t.date) === date && sameItemTitle(t.title, title));

            items.push({
                kind, title, date, time, durationMinutes, sourceQuote: quote,
                isPast: !!date && date < todayIso,
                // Worth a second look: the date isn't written in the file's
                // text, or the item itself couldn't be found there.
                needsCheck: dateInText === false || inText === false,
                alreadyExists
            });
        }

        // Weekly classes first (the student's timetable), then by date,
        // undated last.
        const rank = (i) => (i.kind === 'class' ? '0' : '1') + (i.date || '9999');
        items.sort((a, b) => rank(a).localeCompare(rank(b)));
        console.log(`📅 read-syllabus: ${items.length} item(s) via ${usedPdf ? 'PDF' : 'text'} (${r.model})` + (rejected ? `, ${rejected} rejected` : ''));
        return { course, classesUntil, items, usedPdf, model: r.model, modelLabel: aiProvider.modelLabel(r.model), rejected };
    } catch (error) {
        console.error('❌ read-syllabus failed:', error.message);
        return { error: error.message };
    }
});

// Adds the items the user kept. Exams -> dated Planner events (optionally
// also in Google Calendar), submissions -> tasks under the course. Returns
// the new ids so the renderer's Undo can remove exactly these.
ipcMain.handle('import-syllabus-items', async (event, items = [], options = {}) => {
    // A syllabus has tens of dates, never hundreds (30/9: 5000 were accepted).
    items = Array.isArray(items) ? items.slice(0, 100) : [];
    options = options && typeof options === 'object' ? options : {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const course = String(options.course || '').trim().slice(0, 80);
    const created = { events: [], tasks: [] };
    const errors = [];
    const syncErrors = [];

    for (const item of (Array.isArray(items) ? items : [])) {
        try {
            const title = String(item.title || '').trim().slice(0, 200);
            if (!title) continue;
            const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ? item.date : null;

            if (item.kind === 'class') {
                const day = normalizeWeekday(item.weekday);
                const time = normalizeTimeText(item.time);
                if (!day || !time) { errors.push(`"${title}" has no day or time`); continue; }
                const evt = {
                    title: titleWithCourse(title, course),
                    day, date: null,           // null = repeats every week
                    // ...until this date, when known (the semester's end).
                    until: /^\d{4}-\d{2}-\d{2}$/.test(item.until || '') ? item.until : null,
                    time, type: 'lesson',
                    ...(item.durationMinutes ? { durationMinutes: item.durationMinutes } : {})
                };
                if (options.syncToGoogle) {
                    const g = await syncToGoogleCalendar(evt);
                    if (g.success) evt.googleEventId = g.eventId;
                    else syncErrors.push(g.error);
                }
                const saved = await api.createEvent(evt);
                created.events.push({ ...evt, id: saved && (saved._id || saved.id) });
                continue;
            }
            if (item.kind === 'exam') {
                if (!date) { errors.push(`"${title}" has no date`); continue; }
                const [y, m, d] = date.split('-').map(Number);
                const evt = {
                    title: titleWithCourse(title, course),
                    day: dayNames[new Date(y, m - 1, d).getDay()],
                    date,
                    // The server needs a time. No time in the syllabus -> 09:00,
                    // and the import window says so.
                    time: normalizeTimeText(item.time) || '09:00',
                    type: 'exam',
                    ...(item.durationMinutes ? { durationMinutes: item.durationMinutes } : {})
                };
                if (options.syncToGoogle) {
                    const g = await syncToGoogleCalendar(evt);
                    if (g.success) evt.googleEventId = g.eventId;
                    else syncErrors.push(g.error);
                }
                const saved = await api.createEvent(evt);
                created.events.push({ ...evt, id: saved && (saved._id || saved.id) });
            } else {
                // T00:00:00 = local midnight (a bare YYYY-MM-DD is read as UTC).
                const due = date ? resolveDueDate(`${date}T00:00:00`) : { label: 'Not set', urgency: 'Normal' };
                const task = { title, date: due.label, category: course, urgency: due.urgency };
                const saved = await api.createTask(task);
                created.tasks.push({ ...task, id: saved && (saved._id || saved.id) });
            }
        } catch (err) {
            console.error('❌ import-syllabus-items:', item && item.title, err.message);
            errors.push(err.message);
        }
    }
    return { created, errors, syncErrors };
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

// "... עד 15.1" / "until 15/1/2027" -> the last day a WEEKLY event repeats.
// Returns { iso, phrase } or null. No year: the next time that date comes
// round (today counts). Only numeric dates - "עד סוף הסמסטר" has no date.
function extractUntilDate(text, now) {
    const m = /(?<![א-ת\w])(?:עד|until)\s+(?:ה-?|ל-?|the\s+)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/i.exec(text);
    if (!m) return null;
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    let yyyy = m[3] ? parseInt(m[3], 10) : today.getFullYear();
    if (yyyy < 100) yyyy += 2000;
    let d = new Date(yyyy, mm - 1, dd);
    if (!m[3] && d < today) d = new Date(yyyy + 1, mm - 1, dd);
    if (d.getDate() !== dd) return null; // 31/2 and similar
    return { iso: toLocalIsoDate(d), phrase: m[0] };
}

// Google's rule for a weekly event, optionally ending on `until`
// (YYYY-MM-DD, inclusive). RFC 5545 wants UNTIL in UTC when the start has a
// time zone; the end of that day in UTC is after any class on it.
function weeklyRule(until) {
    return /^\d{4}-\d{2}-\d{2}$/.test(until || '')
        ? `RRULE:FREQ=WEEKLY;UNTIL=${until.replace(/-/g, '')}T235959Z`
        : 'RRULE:FREQ=WEEKLY';
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
            title: String(cleanTitle || '').slice(0, 300),   // the server's limit (30/9)
            date: targetDate,
            category: String(category || '').slice(0, 100),
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

        // "כל יום רביעי ב-8:30 עד 15.1": the date after עד is when a WEEKLY
        // event stops. Read it first - otherwise it would become the event's
        // own date. On a one-time event "עד 26.10" is its deadline, so it is
        // only taken as an end date when the rest reads as weekly (said
        // "every", or a class on a weekday) and names no other date.
        let untilIso = null;
        const untilHit = extractUntilDate(freeText, now);
        if (untilHit) {
            const rest = freeText.replace(untilHit.phrase, ' ');
            const restSaysEvery = /(?<![א-ת])ב?כל\s+(?:(?:ה)?שבוע|(?:יום\s+)?(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))(?![א-ת])/.test(rest) || /\bevery\b|\bweekly\b/i.test(rest);
            const classOnDay = !!detectHebrewDay(rest) && classifyEventByKeywords(rest) === 'lesson';
            if ((restSaysEvery || classOnDay) && !resolveRelativeDate(rest, now)) {
                freeText = rest;
                untilIso = untilHit.iso;
            }
        }

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
            // Always sent, so editing a weekly item and dropping "עד ..." clears it.
            until: weekly ? untilIso : null,
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
        // Bounded input (30/9): 20,000 fake tasks froze the whole server for
        // seconds. A real week has tens of each.
        currentTasks = Array.isArray(currentTasks) ? currentTasks.slice(0, 300) : [];
        currentEvents = Array.isArray(currentEvents) ? currentEvents.slice(0, 1500) : [];
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
            // A weekly class that has ended (its `until` is before today)
            // doesn't take up time any more.
            if (!evt.date && evt.until && evt.until < toLocalIsoDate(today)) return;
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
    // Two files with the same name in different subfolders (Week 1/HW.pdf,
    // Week 2/HW.pdf) keep their subfolder in the name - otherwise the second
    // was taken for "already uploaded" and silently not saved (30/9).
    const baseCount = {};
    paths.forEach(p => { const b = path.basename(p); baseCount[b] = (baseCount[b] || 0) + 1; });
    const root = isFolder ? result.filePaths[0] : null;
    return {
        files: paths.map(p => {
            const base = path.basename(p);
            const name = root && baseCount[base] > 1 ? path.relative(root, p).split(path.sep).join('/') : base;
            return { path: p, name };
        }),
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
        // Same cap as the server keeps (FileItem.content, 1.5M chars) - a
        // bigger text used to be refused whole (30/9).
        return { fileName: path.basename(filePath), fileContent: String(content || '').slice(0, 1500000), filePath };
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

// Deletes the account and all its data on the server (asks the password
// again), then ends the session here. Copies this app put in the person's
// own Google Calendar stay there - that calendar is theirs.
ipcMain.handle('auth-delete-account', async (event, password) => {
  try {
    await api.deleteMe(String(password || ''));
    authClient.clearSession();
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// New password: the server logs out every other device and returns a
// fresh token for this one (30/9).
ipcMain.handle('auth-change-password', async (event, { currentPassword, newPassword } = {}) => {
  try {
    const { token, user } = await api.changePassword(String(currentPassword || ''), String(newPassword || ''));
    authClient.saveSession({ token, user });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
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
// opts.strict (30/9): report a failure as { error } instead of an empty
// list - for callers that must not mistake "couldn't load" for "none".
ipcMain.handle('get-tasks', async (event, opts = {}) => {
  try { return await api.getTasks(); }
  catch (err) { return opts && opts.strict ? { error: err.message } : []; }
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
// Two ways in, one set of rules (buildStudyPrompt + finaliseStudyItems below):
//   generate-study-items-pdf  - the PDF itself (the normal path)
//   generate-study-items      - the text we extracted at upload (non-PDF files,
//                               or when the PDF can't be sent)
//
// REMOVED (29/9): the old text path cut the document into 2,000-character
// pieces and asked the AI once PER PIECE - 20 to 40 requests for one lecture.
// A free Gemini key has 20 a day, so one fallback run used up the whole day.
// It also came with ~1,000 lines of repair filters (garbled Hebrew, slide
// titles quoted as answers, agenda slides...) written for the small local
// model that used to do this job. Now: the whole text in ONE request, with
// the same prompt and filters as the PDF path.
ipcMain.handle('generate-study-items', async (event, sourceText, options = {}) => {
    try {
        options = options && typeof options === 'object' ? options : {};
        // Short strings (30/9): the course name goes into the prompt and into
        // every question - a megabyte of it used to go to the AI.
        const category = String(options.category || '').slice(0, 100);
        const sourceFile = String(options.sourceFile || '').slice(0, 300);
        const text = String(sourceText || '');
        console.log(`🧠 generate-study-items (text): ${text.length} chars, category "${category}"`);
        if (!text.trim()) return JSON.stringify({ error: 'This file has no readable text.' });

        // Gemini reads ~120,000 characters in one go; a local model's context
        // window holds far less.
        const maxChars = aiProvider.resolveProvider() === 'gemini' ? 120000 : 15000;
        const prompt = `${buildStudyPrompt(category)}

THE MATERIAL (text extracted from the file - formulas, tables and right-to-left order may be damaged; skip anything you can't read with confidence rather than guessing):

${text.slice(0, maxChars)}`;

        const responseText = await aiProvider.generateText(prompt, {
            forceJson: true,
            maxTokens: 16384,
            thinkingLevel: 'medium',
            timeoutMs: 180000,
            // No quiet switch to the small local model when Gemini is out of
            // quota or busy: its questions were the reason for all those
            // filters. Say what happened instead. (A user who ONLY has the
            // local model still gets it - noFallback only stops the switch.)
            noFallback: true,
            localModel: LOCAL_MODEL
        });
        return JSON.stringify(finaliseStudyItems(responseText, category, sourceFile));
    } catch (error) {
        console.error('❌ generate-study-items failed:', error.message);
        return JSON.stringify({ error: error.message });
    }
});

// =====================================
// "When is the X exam?" (Study screen)
// =====================================
// The Study screen asks this about a course that has questions but no exam in
// the Planner. The student answers in their own words: "12.2", "מועד א 12.2
// מועד ב 5.3", "ביום חמישי ב-9", "בעוד שבועיים". Read without AI where
// possible (instant, costs no quota); the AI only for what the rules miss.
// Returns { exams: [{ label, date: 'YYYY-MM-DD', time: 'HH:MM' | null }] } or { error }.
const EXAM_LABEL_RE = /(מועד\s*[אבגabc]['׳]?|בוחן(?:\s+אמצע)?|מבחן(?:\s+(?:אמצע|סופי|גמר))?|בחינה(?:\s+(?:סופית|אמצע))?|midterm|final|quiz|moed\s*[abc])/i;

function nextOccurrenceIso(day, month, year, today) {
    let y = year || today.getFullYear();
    if (y < 100) y += 2000;
    let d = new Date(y, month - 1, day);
    if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
    // No year written and the date already passed -> they mean next year.
    if (!year && d < today) d = new Date(y + 1, month - 1, day);
    return toLocalIsoDate(d);
}

ipcMain.handle('parse-exam-dates', async (event, text) => {
    try {
        const input = String(text || '').trim();
        if (!input) return { error: 'Write when the exam is.' };
        if (input.length > 300) return { error: 'That\'s too long - just the date is enough, e.g. "12.2".' };

        const now = new Date();
        const today = new Date(now); today.setHours(0, 0, 0, 0);
        const todayIso = toLocalIsoDate(today);
        const exams = [];

        // 1. Written dates: 12.2 / 12/2/27 / 12.02.2027, each with the label
        //    and time written next to it ("מועד א 12.2 ב-9").
        const DATE = /(?<![\d:.\/])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/g;
        const matches = [...input.matchAll(DATE)];
        matches.forEach((m, i) => {
            const date = nextOccurrenceIso(+m[1], +m[2], m[3] ? +m[3] : null, today);
            if (!date) return;
            const segStart = i === 0 ? 0 : matches[i - 1].index + matches[i - 1][0].length;
            const segEnd = i + 1 < matches.length ? matches[i + 1].index : input.length;
            const before = input.slice(segStart, m.index);
            const after = input.slice(m.index + m[0].length, segEnd);
            const labelHit = before.match(new RegExp(EXAM_LABEL_RE.source, 'gi'));
            const t = after.match(/(?:ב-?|בשעה\s*|at\s*)?\b([01]?\d|2[0-3]):([0-5]\d)\b/) || after.match(/(?:(?<![א-ת])ב-?|בשעה\s*)([01]?\d|2[0-3])(?![\d:./])/);
            const time = t ? `${String(+t[1]).padStart(2, '0')}:${t[2] || '00'}` : null;
            exams.push({ label: labelHit ? labelHit[labelHit.length - 1].trim() : '', date, time });
        });

        // 2. No written date: "מחר", "בעוד שבוע", "ביום חמישי".
        if (!exams.length) {
            const rel = resolveRelativeDate(input, now);
            let date = rel ? toLocalIsoDate(rel.date) : null;
            if (!date) {
                const dayWord = detectHebrewDay(input);
                if (dayWord) {
                    const dow = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 }[dayWord];
                    const d = new Date(today); d.setDate(d.getDate() + (((dow - d.getDay()) + 7) % 7 || 7));
                    date = toLocalIsoDate(d);
                }
            }
            if (date) {
                const l = input.match(EXAM_LABEL_RE);
                const t = input.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
                exams.push({ label: l ? l[0].trim() : '', date, time: t ? `${String(+t[1]).padStart(2, '0')}:${t[2]}` : null });
            }
        }

        // 3. Still nothing ("באמצע פברואר", "end of January"): ask the AI.
        if (!exams.length) {
            const prompt = `Today is ${todayIso}. A student wrote when their exam(s) are: "${input.replace(/"/g, "'")}".
Return ONLY JSON: {"exams": [{"label": "the sitting's name as written (e.g. מועד א) or empty", "date": {"day": number, "month": number, "year": number or null}, "time": "HH:MM" or null}]}.
Only dates the student actually gave; if the text gives no usable date, return {"exams": []}.`;
            try {
                const out = JSON.parse(extractJsonFromText(await aiProvider.generateText(prompt, { forceJson: true, maxTokens: 400, noFallback: true })));
                (out.exams || []).forEach(e => {
                    const d = e && e.date && typeof e.date === 'object'
                        ? nextOccurrenceIso(Number(e.date.day), Number(e.date.month), e.date.year ? Number(e.date.year) : null, today) : null;
                    const t = /^([01]\d|2[0-3]):[0-5]\d$/.test(e.time || '') ? e.time : null;
                    if (d) exams.push({ label: String(e.label || '').trim().slice(0, 40), date: d, time: t });
                });
            } catch (err) {
                return { error: /quota|overloaded|busy/i.test(err.message) ? err.message : 'Couldn\'t tell the date. Try writing it like "12.2".' };
            }
        }

        const valid = exams.filter(e => e.date >= todayIso && e.date <= toLocalIsoDate(new Date(today.getFullYear() + 1, today.getMonth() + 3, today.getDate())));
        if (!valid.length) return { error: exams.length ? 'That date has already passed.' : 'Couldn\'t tell the date. Try writing it like "12.2".' };
        valid.sort((a, b) => a.date.localeCompare(b.date));
        return { exams: valid.slice(0, 4) };
    } catch (err) {
        console.error('❌ parse-exam-dates failed:', err.message);
        return { error: err.message };
    }
});

// Moves every question from one course name to another. Used once, quietly,
// to fix questions made before the course defaulted to the file's folder:
// their "course" is a file name ("הרצאה 3 - ..."), which never matches an exam.
ipcMain.handle('recategorize-study-items', async (event, from, to) => {
    try {
        const source = String(from || '').trim();
        const target = String(to || '').trim().slice(0, 100);
        if (!source || !target || source === target) return { updated: 0 };
        const items = await api.getStudyItems({ light: 1 });
        const matching = (items || []).filter(i => (i.category || '').trim() === source);
        for (const i of matching) await api.updateStudyItem(i.id || i._id, { category: target });
        return { updated: matching.length };
    } catch (err) {
        console.error('❌ recategorize-study-items failed:', err.message);
        return { error: err.message };
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

// Checks what the student TYPED against the question (and the stored answer,
// when there is one). Replaces "grade yourself", which students do kindly -
// and the "sure but wrong" list is only worth something if the grading is
// honest. One short request (a "light" job on the web's daily allowance).
// Returns { verdict: 'correct' | 'partial' | 'wrong', feedback } or { error }.
ipcMain.handle('grade-study-answer', async (event, payload = {}) => {
    try {
        const question = String(payload.question || '').slice(0, 2000);
        const expected = String(payload.expected || '').slice(0, 4000);
        const userAnswer = String(payload.userAnswer || '').trim().slice(0, 3000);
        const solve = payload.mode === 'practice';
        const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

        // "I don't know": nothing to judge - just the short, direct answer,
        // since the stored one is a quote that often opens with an intro.
        if (payload.explainOnly) {
            if (!question) return { error: 'No question.' };
            const explainPrompt = `A university student did not know the answer to this practice question. Give the correct answer, short and direct: 1-2 sentences${solve ? ' (the final result and the key step)' : ''}, in the SAME LANGUAGE as the question, no introduction ("There is another type of..."), just what answers it.
${expected ? 'Base it on the reference answer from the course material.' : 'There is no reference answer: work it out yourself.'}

Question: ${question}
${expected ? `Reference answer (from the course material): ${expected}\n` : ''}
Return ONLY JSON: {"answer": "the short direct answer"}`;
            const out = await aiProvider.generateText(explainPrompt, { forceJson: true, maxTokens: 700, thinkingLevel: 'low', noFallback: true, timeoutMs: 30000 });
            const answer = clean(JSON.parse(extractJsonFromText(String(out))).answer, 500);
            return answer ? { answer } : { error: 'No answer came back.' };
        }

        if (!question || !userAnswer) return { error: 'Nothing to check.' };
        const prompt = `You check a university student's answer to a practice question. Judge the MEANING, not the wording: a short answer that has the key idea is correct; a different but valid method is correct.
${solve ? 'This is a problem to solve. The student may give only the final result - judge that result.' : ''}
Verdicts:
- "correct": the key idea (or the right result) is there.
- "partial": on the right track, but something important is missing or slightly wrong.
- "wrong": wrong, or does not answer the question.
${expected ? 'Use the reference answer as the standard, but accept anything equivalent.' : 'There is no reference answer: work out the correct answer yourself first, then judge.'}

Question: ${question}
${expected ? `Reference answer (from the course material): ${expected}\n` : ''}Student's answer: ${userAnswer}

Also write "answer": the correct answer to the question itself, short and direct - 1-2 sentences, in the SAME LANGUAGE as the question, no introduction ("There is another type of..."), just what answers it.${expected ? ' Base it on the reference answer.' : ''}

Return ONLY JSON: {"verdict": "correct|partial|wrong", "feedback": "ONE short sentence in the SAME LANGUAGE as the question - what is missing or wrong; if correct, a small useful addition or 'exactly right'", "answer": "the short direct answer"}`;
        const text = await aiProvider.generateText(prompt, { forceJson: true, maxTokens: 900, thinkingLevel: 'low', noFallback: true, timeoutMs: 30000 });
        const data = JSON.parse(extractJsonFromText(String(text)));
        const verdict = ['correct', 'partial', 'wrong'].includes(data.verdict) ? data.verdict : null;
        if (!verdict) return { error: 'The check did not come back clearly.' };
        return { verdict, feedback: clean(data.feedback, 300), answer: clean(data.answer, 500) };
    } catch (err) {
        console.error('❌ grade-study-answer:', err.message);
        return { error: err.message };
    }
});

ipcMain.handle('delete-study-item', async (event, id) => {
    try { return await api.deleteStudyItem(id); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('update-study-item', async (event, id, updates) => {
    try { return await api.updateStudyItem(id, updates); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('get-study-items', async (event, opts = {}) => {
    try { return await api.getStudyItems(opts); } catch (err) {
        console.error('get-study-items failed:', err.message);
        return opts && opts.strict ? { error: err.message } : [];
    }
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

Also return "course": the name of the course this material belongs to, as the material itself shows it (title slide, header, footer) - without a course number. null if the material doesn't say.

Return ONLY JSON:
{"course": "...", "items": [{"question": "...", "answer": "...", "mode": "recall|practice", "solutionSource": "document|ai", "topic": "short skill or topic name"}]}`;
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

    // No course given (a file outside any folder): use the course the AI saw
    // in the material itself - it came in the same answer, no extra request.
    // The renderer then matches it against courses the user already has.
    if (!String(category || '').trim() && parsed && !Array.isArray(parsed) && parsed.course) {
        category = String(parsed.course).trim().slice(0, 100);
    }

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
        options = options && typeof options === 'object' ? options : {};
        const category = String(options.category || '').slice(0, 100);
        const sourceFile = String(options.sourceFile || '').slice(0, 300);

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

// ---- AI provider settings ----
ipcMain.handle('get-ai-config', async () => {
    const cfg = aiProvider.readConfig();
    // Never hand the full key back to the renderer - a masked form is enough
    // to show that one is configured.
    return {
        provider: cfg.provider,
        // The model actually in use (an old saved default shows as its
        // replacement), so the Settings picker shows the truth.
        geminiModel: aiProvider.activeGeminiModel(),
        hasKey: Boolean(cfg.geminiKey),
        keyPreview: cfg.geminiKey ? `${cfg.geminiKey.slice(0, 6)}...${cfg.geminiKey.slice(-4)}` : '',
        active: aiProvider.resolveProvider(),
        visionAvailable: aiProvider.supportsVision()
    };
});

// Only these models can be picked in Settings. Anything else is dropped
// rather than saved - a typo'd model id would fail every AI call.
const PICKABLE_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.1-pro-preview'];

ipcMain.handle('save-ai-config', async (event, updates) => {
    try {
        const clean = { ...(updates || {}) };
        if ('geminiModel' in clean && !PICKABLE_GEMINI_MODELS.includes(clean.geminiModel)) delete clean.geminiModel;
        aiProvider.writeConfig(clean);
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
                    ...(dateMatch ? {} : { recurrence: [weeklyRule(evtData.until)] })
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
// opts.strict (30/9): report a failure as { error } instead of an empty
// list - for callers that must not mistake "couldn't load" for "none".
ipcMain.handle('get-events', async (event, opts = {}) => {
  try { return await api.getEvents(); }
  catch (err) { return opts && opts.strict ? { error: err.message } : []; }
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

// Removes the Google Calendar copy of an event, if it has one. Never
// throws: Google may already have had it deleted by hand (a 404/410), and a
// Google problem must not block deleting or editing the event in MindSync.
async function deleteGoogleCopy(googleEventId) {
    if (!googleEventId) return;
    try {
        await callGoogleWithReauth(async (auth) => {
            const calendar = google.calendar({ version: 'v3', auth });
            // Same timeout fix as the insert call above.
            await calendar.events.delete({ calendarId: 'primary', eventId: googleEventId }, { timeout: 15000 });
        });
        console.log("Deleted from Google Calendar.");
    } catch (err) {
        console.error("Google Calendar delete error:", err.message);
    }
}

// Deletes one event from Google Calendar (if it was mirrored there) and
// then from our database. Shared by delete-event and by the task handlers
// below, which clean up a task's planned blocks.
async function deleteEventEverywhere(id, knownEvent = null) {
    const evt = knownEvent || await api.getEvent(id);

    // מנגנון מחיקה מגוגל שעובד יחד עם מסד הנתונים
    if (evt && evt.googleEventId) await deleteGoogleCopy(evt.googleEventId);

    // מחיקה מקומית לאחר המחיקה מגוגל
    await api.deleteEvent(id);
}

// Edits an existing calendar event: the renderer sends what the AI read from
// the edited sentence (title, day, date, time, type).
//
// Google copy: replaced (delete + insert) rather than patched. A weekly
// event and a one-time event are different kinds of Google event (one has
// a repeat rule), so an edit that turns one into the other can't be done
// by patching. `options.syncToGoogle` decides whether a copy exists after
// the edit; left out, it keeps whatever the event had.
//
// The database is updated FIRST: if Google then fails, MindSync still holds
// the edit, and the event is marked as having no Google copy rather than
// pointing at one that was just deleted.
ipcMain.handle('update-event', async (event, id, changes = {}, options = {}) => {
  try {
    const before = await api.getEvent(id);
    if (!before) return { error: 'That calendar item no longer exists.' };

    const updates = {};
    for (const key of ['title', 'day', 'date', 'until', 'time', 'type', 'durationMinutes']) {
      if (changes[key] !== undefined) updates[key] = changes[key];
    }
    if (updates.date === '') updates.date = null; // '' would fail the server's YYYY-MM-DD check
    if (updates.until === '') updates.until = null;
    // A block the planner placed becomes YOURS once you edit it - otherwise
    // the next "Plan study time" would sweep your change away. (Undo passes
    // the original value back explicitly.)
    updates.autoScheduled = changes.autoScheduled === undefined ? false : !!changes.autoScheduled;

    const updated = await api.updateEvent(id, updates);

    const hadGoogle = !!before.googleEventId;
    const wantGoogle = options.syncToGoogle === undefined ? hadGoogle : !!options.syncToGoogle;
    let googleEventId = before.googleEventId || null;
    let googleSyncError = null;

    if (hadGoogle || wantGoogle) {
      if (hadGoogle) await deleteGoogleCopy(before.googleEventId);
      googleEventId = null;
      if (wantGoogle) {
        const g = await syncToGoogleCalendar({ ...before, ...updates });
        if (g.success) googleEventId = g.eventId;
        else googleSyncError = g.error;
      }
      await api.updateEvent(id, { googleEventId }).catch(err =>
        console.warn('⚠️ Could not store the new Google event id:', err.message));
    }

    return {
      event: { ...updated, id: updated.id || updated._id, googleEventId },
      previous: { ...before, id: before.id || before._id },
      googleSyncError
    };
  } catch (err) {
    console.error('❌ update-event failed:', err.message);
    return { error: err.message };
  }
});

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
  const [files, stats, events, tasks, me] = await Promise.all([
    safe(api.getFilesLight(), []),
    safe(api.getStudyStats(), null),
    safe(api.getEvents(), []),
    safe(api.getTasks(), []),
    safe(api.getMe(), null)
  ]);
  if (failed) return { error: 'unavailable' };
  return {
    // Finished (or hidden) once = never again, even after deleting every
    // question or on a new computer. Stored on the account.
    guideDone: Boolean(me && me.guideDone),
    dueCount: stats ? stats.dueCount || 0 : 0,
    hasKey: Boolean(aiProvider.readConfig().geminiKey),
    files: (files || []).length,
    questions: stats ? stats.totalItems || 0 : 0,
    reviews: stats ? stats.reviewsAllTime || 0 : 0,
    calendarItems: (events || []).length + (tasks || []).length
  };
});

ipcMain.handle('mark-guide-done', async (event, done = true) => {
  try { await api.updateMe({ guideDone: done !== false }); return true; }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('get-files-light', async () => {
  try { return await api.getFilesLight(); } catch (err) { return []; }
});

ipcMain.handle('get-files', async (event, opts = {}) => {
  try { return await api.getFiles(); } catch (err) { return opts && opts.strict ? { error: err.message } : []; }
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