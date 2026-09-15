// aiProvider.js
// ---------------------------------------------------------------------------
// One interface over two very different AI backends.
//
// Why this exists:
//   Everything in this app talked directly to Ollama. That worked, but it tied
//   the whole feature set to one local model's limits - and those limits turned
//   out to be the binding constraint on maths, formulas and code.
//
//   More importantly, the worst failures weren't the model's fault at all. PDF
//   text extraction destroys formulas, subscripts and Hebrew before the model
//   ever sees them; no model can recover characters that aren't there. The fix
//   is to stop extracting text and let a vision model READ THE PAGE, the way a
//   person does. That needs a provider that can accept images, which Ollama
//   text models can't.
//
// Design:
//   - 'gemini'  : cloud, multimodal, BYOK. Each user supplies their own free
//                 API key, so distribution costs nothing and scales with no
//                 shared quota.
//   - 'ollama'  : local, text only, fully offline. Kept as the privacy option
//                 and the fallback.
//   - 'auto'    : Gemini when a key exists, otherwise Ollama.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// ---- Configuration persistence ----------------------------------------------
// The API key belongs to the user and must survive restarts, so it lives in a
// JSON file under the app's user-data directory rather than in the project.
let configPath = null;
let cachedConfig = null;

function initConfig(userDataPath) {
    configPath = path.join(userDataPath, 'ai-config.json');
}

function readConfig() {
    if (cachedConfig) return cachedConfig;
    try {
        cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
        // No geminiModel here on purpose: resolveGeminiModel() decides, so a
        // fresh install can never be born pinned to a model that will age out.
        cachedConfig = { provider: 'auto', geminiKey: '' };
    }
    return cachedConfig;
}

function writeConfig(updates) {
    const next = { ...readConfig(), ...updates };
    cachedConfig = next;
    try {
        fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
    } catch (e) {
        console.error('Could not save AI config:', e.message);
    }
    return next;
}

// ---- Ollama (local, text) ---------------------------------------------------
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const AI_IDLE_TIMEOUT_MS = 60000;
const AI_TOTAL_TIMEOUT_MS = 300000;

async function callOllama(prompt, { model, maxTokens = 800, forceJson = false, system = null, contextSize = 8192 }) {
    const controller = new AbortController();
    const startedAt = Date.now();
    let lastTokenAt = Date.now();
    let fullResponse = '';
    let tokenCount = 0;

    const watchdog = setInterval(() => {
        if (Date.now() - lastTokenAt > AI_IDLE_TIMEOUT_MS || Date.now() - startedAt > AI_TOTAL_TIMEOUT_MS) {
            controller.abort();
        }
    }, 1000);

    try {
        const body = {
            model,
            prompt,
            stream: true,
            options: {
                num_predict: maxTokens,
                num_ctx: contextSize,
                temperature: 0.2,
                repeat_penalty: 1.3,
                repeat_last_n: 256
            }
        };
        if (forceJson) body.format = 'json';
        if (system) body.system = system;

        console.log(`🤖 Ollama (${model}): prompt ${prompt.length} chars...`);

        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Ollama returned ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const chunk = JSON.parse(line);
                    if (chunk.response) {
                        fullResponse += chunk.response;
                        tokenCount++;
                        lastTokenAt = Date.now();
                    }
                } catch { /* partial line */ }
            }
        }

        console.log(`🤖 Ollama done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${tokenCount} tokens`);
        return fullResponse;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(tokenCount === 0
                ? `Ollama produced nothing within ${AI_IDLE_TIMEOUT_MS / 1000}s. Is the model loaded? Try: ollama run ${model}`
                : `Ollama stalled after ${tokenCount} tokens.`);
        }
        throw new Error('Ollama is not reachable. Open the Ollama app and try again.');
    } finally {
        clearInterval(watchdog);
    }
}

// ---- Gemini (cloud, multimodal) ---------------------------------------------
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini({ apiKey, model, parts, maxTokens = 2048, forceJson = false, system = null, thinkingLevel = 'low', onProgress = null }) {
    // Progress is reported outward, never printed only to a terminal the user
    // will not see. A silent 90-second retry sequence is indistinguishable
    // from a frozen app.
    const report = (msg) => { try { if (onProgress) onProgress(msg); } catch { /* never break a generation over a UI message */ } };
    // Media resolution only applies when something visual is attached.
    const hasMedia = parts.some(p => p.inlineData);
    // Note: Gemini 3.x ignores temperature / topK / topP, and rejects the
    // frequency and presence penalty parameters outright. Sending them would
    // be at best pointless and at worst a 400, so the request carries only
    // what the model actually honours.
    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            maxOutputTokens: maxTokens,

            // Gemini 3 is a reasoning model and its thinking is paid for out of
            // the OUTPUT token budget. Left at the default (high for Flash) a
            // small maxOutputTokens gets consumed entirely by reasoning and the
            // response comes back empty - which is exactly what an earlier
            // 10-token key test did.
            //
            // 'low' rather than 'minimal': minimal requires thought signatures
            // to be passed back and returns 400 without them.
            thinkingConfig: { thinkingLevel: thinkingLevel },

            // Reading a page is a detail task - subscripts, superscripts and
            // dense formulas only survive at high media resolution.
            ...(hasMedia ? { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } : {}),

            ...(forceJson ? { responseMimeType: 'application/json' } : {})

            // Note: temperature is deliberately absent. Google recommends
            // leaving it at the default for Gemini 3; lowering it can cause
            // looping and degrade maths and reasoning performance.
        }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const started = Date.now();

    // Transient failures get retried rather than thrown at the user.
    //
    // A 503 UNAVAILABLE means Google is busy this second, not that anything
    // is wrong with the request - the identical call usually succeeds moments
    // later. That matters most on PDF generation, where a failure throws away
    // an upload, a minute of reading and the whole batch of questions, and
    // the only recovery is to start the entire flow again.
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const RETRYABLE = new Set([429, 500, 502, 503, 504]);
    // 2s, 4s, 8s - about fifteen seconds per model.
    //
    // Deliberately short. A saturated serving pool takes 30-120 minutes to
    // recover, so waiting longer here buys nothing: the win is reaching the
    // NEXT model in the chain, which sits on its own capacity. Time spent
    // backing off on a model that is full is time not spent asking one that
    // isn't.
    const MAX_ATTEMPTS = 4;

    let res = null;
    let raw = '';
    let data = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            // Authenticate with the header rather than a query parameter. It's
            // the documented form, and it keeps the key out of URLs - which
            // end up in proxy logs, crash reports and error messages.
            res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify(body)
            });
        } catch (netErr) {
            // Dropped connection mid-upload: also worth another go.
            if (attempt === MAX_ATTEMPTS) {
                throw new Error(`Can't reach Gemini after ${MAX_ATTEMPTS} attempts: ${netErr.message}`);
            }
            const wait = 2000 * Math.pow(2, attempt - 1);
            console.warn(`⏳ Network error reaching Gemini (${netErr.message}) — retrying in ${(wait / 1000).toFixed(0)}s [${attempt}/${MAX_ATTEMPTS}]`);
            report(`Network problem — retrying in ${Math.round(wait / 1000)}s (${attempt}/${MAX_ATTEMPTS})`);
            await sleep(wait);
            continue;
        }

        raw = await res.text();
        try { data = JSON.parse(raw); } catch { data = null; }

        if (res.ok) break;

        if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
            // Google's own Retry-After wins when it sends one; otherwise back
            // off exponentially with a little jitter, so several requests
            // that failed together don't all return at the same instant.
            const retryAfter = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 2000 * Math.pow(2, attempt - 1) + Math.round(Math.random() * 500);
            console.warn(`⏳ Gemini ${res.status} ${res.statusText} — retrying in ${(wait / 1000).toFixed(1)}s [${attempt}/${MAX_ATTEMPTS}]`);
            report(res.status === 429
                ? `Rate limited — waiting ${Math.round(wait / 1000)}s (${attempt}/${MAX_ATTEMPTS})`
                : `${model} is busy — retrying in ${Math.round(wait / 1000)}s (${attempt}/${MAX_ATTEMPTS})`);
            await sleep(wait);
            continue;
        }

        break; // not retryable, or attempts exhausted - handled below
    }

    if (!res.ok) {
        const msg = data?.error?.message || `Gemini returned ${res.status}`;
        // Log the full response. Swallowing it meant a rejection showed a
        // one-line toast and nothing in the terminal, which left no way to
        // tell a revoked key from a disabled project or a quota problem.
        console.error(`❌ Gemini HTTP ${res.status} ${res.statusText}`);
        console.error('   status :', data?.error?.status || '(none)');
        console.error('   message:', msg);
        if (data?.error?.details) {
            console.error('   details:', JSON.stringify(data.error.details));
        }
        if (!data) console.error('   raw body:', raw.slice(0, 500));
        // Surface the common, actionable failures in plain language rather
        // than passing Google's raw error through to the user.
        if ((res.status === 400 || res.status === 401 || res.status === 403) && /API key|credential|unauthenticated|permission/i.test(msg)) {
            // Auth ("AQ.") keys are bound to a service account and are
            // restricted to the Generative Language API by default, so a
            // rejection here usually means the key was revoked, the project
            // is inactive, or the API isn't enabled on it - not that the key
            // is the wrong shape.
            // Standard "AIza" keys stopped being accepted in September 2026,
            // so an otherwise valid-looking old key is worth calling out.
            if (/^AIza/.test(apiKey)) {
                throw new Error('This is an older "AIza" standard key. Google stopped accepting those in September 2026 — create a new key at aistudio.google.com/apikey and it will be issued in the current "AQ." format.');
            }
            throw new Error(`Google rejected the key: ${msg}`);
        }
        if (res.status === 429) {
            throw new Error('Gemini rate limit reached. Wait a minute, or switch to the local model in Settings.');
        }
        if (res.status === 503 || res.status === 502 || res.status === 504) {
            const overloaded = new Error(`Gemini is overloaded right now. The app retried ${MAX_ATTEMPTS} times and it was still busy — this is on Google's side and usually passes within a few minutes. Try again shortly, or switch to the local model in Settings.`);
            // Tagged so the caller can try a different model: capacity is
            // per-model, so one being full says nothing about the others.
            overloaded.geminiOverloaded = true;
            throw overloaded;
        }
        throw new Error(msg);
    }

    const text = (data?.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || '')
        .join('')
        .trim();

    // Always report the token split. Thinking is billed from the output
    // budget, so "the model was brief" and "the budget ran out" look
    // identical from the outside without this.
    const usage = data?.usageMetadata || {};
    const finish = data?.candidates?.[0]?.finishReason;
    console.log(
        `🤖 Gemini (${model}) ${((Date.now() - started) / 1000).toFixed(1)}s | ` +
        `in ${usage.promptTokenCount || 0} | thinking ${usage.thoughtsTokenCount || 0} | ` +
        `out ${usage.candidatesTokenCount || 0} | ${text.length} chars | finish=${finish}`
    );
    if (finish === 'MAX_TOKENS') {
        console.warn('⚠️ Response was cut off by the token limit - raise maxOutputTokens.');
    }

    if (!text) {
        const reason = data?.candidates?.[0]?.finishReason;
        const usage = data?.usageMetadata || {};
        console.error(`❌ Gemini returned no text. finishReason=${reason}, thoughts=${usage.thoughtsTokenCount || 0}, output=${usage.candidatesTokenCount || 0}`);

        if (reason === 'SAFETY') throw new Error('Gemini declined to answer for this content.');
        if (reason === 'MAX_TOKENS') {
            throw new Error('The reply hit the token limit before any text was produced - the thinking budget consumed it. Raising maxOutputTokens or lowering thinkingLevel fixes this.');
        }
        throw new Error(`Gemini returned an empty response (finishReason: ${reason || 'unknown'}).`);
    }
    return text;
}

// Capacity on Google's side is allocated per model, so one being full says
// nothing about the others: a 503 on one Flash model is routine while the
// next one answers immediately. When the primary model stays overloaded
// after every retry, the same request is sent to the next model in this list
// rather than failing the whole generation.
//
// Verified against Google's model list in September 2026. Only the Gemini 3
// line is here: the 2.x models are two generations back and are no longer
// served, so listing them would just burn attempts on a guaranteed failure.
//
// Ordered newest first, with the Lite models last. That tail is not an
// afterthought: a saturated pool on a heavy model takes 30-120 minutes to
// recover, while the Lite pools recover in 5-15 and are far harder to
// saturate in the first place. A Lite model writes weaker questions - but
// every generated question passes through the approval screen anyway, and
// weaker questions the student can filter beat no questions at all on the
// night before an exam.
//
// This list WILL go stale - Google shipped three Flash models in this line
// alone. A name that no longer exists is skipped, not fatal, so an
// out-of-date entry costs one wasted call and nothing more.
const GEMINI_FALLBACK_CHAIN = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
];

// Newest first, so the head of the chain is also the default. Adding a newer
// model to the top of the list above is the only change needed to move every
// call onto it.
const DEFAULT_GEMINI_MODEL = GEMINI_FALLBACK_CHAIN[0];

// Which model a request actually uses.
//
// The settings screen has no model picker - it only ever sends `provider` and
// `geminiKey` - so a model name sitting in ai-config.json was never chosen by
// the user. It is a leftover: whatever shipped as the default on the day that
// file was first written. Treating it as a preference would pin everyone to
// an old model forever and make upgrading the default a no-op.
//
// So a name we recognise as one of our own defaults is ignored in favour of
// the current one. A name we don't recognise was typed into the file by hand
// and is respected, as is anything marked `modelPinned` - the escape hatch
// for staying on a specific model deliberately.
function resolveGeminiModel(cfg = readConfig()) {
    const stored = String(cfg.geminiModel || '').trim();
    if (cfg.modelPinned && stored) return stored;
    if (!stored || GEMINI_FALLBACK_CHAIN.includes(stored)) return DEFAULT_GEMINI_MODEL;
    return stored;
}

function modelChain(configured) {
    const primary = configured || GEMINI_FALLBACK_CHAIN[0];
    return [primary, ...GEMINI_FALLBACK_CHAIN.filter(m => m !== primary)];
}

// callGemini, plus "if this model is full, try the next one".
async function callGeminiResilient(options) {
    const chain = modelChain(options.model);
    let firstOverload = null;

    for (let i = 0; i < chain.length; i++) {
        try {
            if (options.onProgress) {
                options.onProgress(i === 0
                    ? `Reading the document with ${chain[i]}...`
                    : `Retrying with ${chain[i]}...`);
            }
            const text = await callGemini({ ...options, model: chain[i] });
            if (i > 0) console.log(`✅ Answered by the fallback model ${chain[i]}.`);
            return text;
        } catch (err) {
            // A fallback model failing for its own reasons - renamed,
            // retired, or not enabled on this key - must not replace the real
            // story, which is that the model the user chose was overloaded.
            if (i > 0 && !err.geminiOverloaded) {
                console.warn(`⚠️ Fallback model ${chain[i]} unusable, skipping it: ${err.message}`);
                continue;
            }
            if (!err.geminiOverloaded) throw err;

            firstOverload = firstOverload || err;
            if (chain[i + 1]) {
                console.warn(`⚠️ ${chain[i]} is overloaded — trying ${chain[i + 1]} instead.`);
                if (options.onProgress) {
                    options.onProgress(`${chain[i]} is overloaded — switching to ${chain[i + 1]}`);
                }
            }
        }
    }

    throw firstOverload;
}

// ---- Public interface --------------------------------------------------------

function resolveProvider() {
    const cfg = readConfig();
    if (cfg.provider === 'gemini') return cfg.geminiKey ? 'gemini' : 'ollama';
    if (cfg.provider === 'ollama') return 'ollama';
    return cfg.geminiKey ? 'gemini' : 'ollama';   // 'auto'
}

/**
 * Text-only generation. Works on both providers.
 */
async function generateText(prompt, options = {}) {
    const cfg = readConfig();
    const provider = options.forceProvider || resolveProvider();

    if (provider === 'gemini') {
        try {
            return await callGeminiResilient({
                apiKey: cfg.geminiKey,
                model: resolveGeminiModel(cfg),
                parts: [{ text: prompt }],
                maxTokens: options.maxTokens || 2048,
                forceJson: options.forceJson,
                system: options.system,
                thinkingLevel: options.thinkingLevel || 'low',
                onProgress: options.onProgress || null
            });
        } catch (err) {
            // Falling back keeps the app usable when the network or the quota
            // gives out - the original reason for preferring a local model.
            console.warn('⚠️ Gemini failed, falling back to Ollama:', err.message);
            if (options.noFallback) throw err;
        }
    }

    return callOllama(prompt, {
        model: options.localModel || 'aya-expanse:8b',
        maxTokens: options.maxTokens || 800,
        forceJson: options.forceJson,
        system: options.system
    });
}

/**
 * Sends a PDF file straight to the model.
 *
 * Gemini 3.x accepts PDFs as native input, so the file goes as-is: no text
 * extraction, and no rasterising pages either. The model reads the document
 * with its layout intact - formula structure, subscripts, matrix shape, code
 * indentation and right-to-left ordering all survive, because nothing is
 * flattened on the way in. This replaces the whole extract-then-repair
 * pipeline that every quality problem traced back to.
 *
 * @param {Buffer} pdfBuffer
 */
async function generateFromPdf(pdfBuffer, prompt, options = {}) {
    const cfg = readConfig();
    if (resolveProvider() !== 'gemini') {
        throw new Error('Reading PDFs directly requires a Gemini API key. Add one in Settings.');
    }

    const parts = [
        { text: prompt },
        { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } }
    ];

    return callGeminiResilient({
        apiKey: cfg.geminiKey,
        model: resolveGeminiModel(cfg),
        parts,
        maxTokens: options.maxTokens || 8192,
        forceJson: options.forceJson,
        system: options.system,
        thinkingLevel: options.thinkingLevel || 'low',
        onProgress: options.onProgress || null
    });
}

/**
 * Vision generation: reads page images directly.
 * Kept for non-PDF sources and as a fallback if a PDF is rejected.
 *
 * This is the whole point of adding a cloud provider. Text extraction flattens
 * a page and loses exactly what matters in technical material - the 2D layout
 * of a formula, sub/superscripts, matrix structure, code indentation, and
 * right-to-left ordering. A vision model sees the page as rendered, so none of
 * that is ever lost and none of it needs repairing afterwards.
 *
 * @param {Array<{mimeType:string, data:string}>} images  base64, no data: prefix
 */
async function generateFromImages(images, prompt, options = {}) {
    const cfg = readConfig();
    if (resolveProvider() !== 'gemini') {
        throw new Error('Reading pages as images requires a Gemini API key. Add one in Settings, or the app will fall back to text extraction.');
    }

    const parts = [
        { text: prompt },
        ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))
    ];

    return callGeminiResilient({
        apiKey: cfg.geminiKey,
        model: resolveGeminiModel(cfg),
        parts,
        maxTokens: options.maxTokens || 4096,
        forceJson: options.forceJson,
        system: options.system,
        thinkingLevel: options.thinkingLevel || 'low',
        onProgress: options.onProgress || null
    });
}

// Cheap round-trip to confirm a pasted key actually works, so the user finds
// out in Settings rather than when a generation silently fails.
async function testGeminiKey(apiKey, model = DEFAULT_GEMINI_MODEL) {
    const key = String(apiKey || '').trim();
    // Never log the key itself - only enough to confirm what was received.
    console.log(`🔑 Testing key: ${key.length} chars, prefix "${key.slice(0, 3)}", model ${model}`);

    if (!key) return { ok: false, error: 'No key entered.' };

    // Do NOT validate the key by its prefix.
    //
    // Google changed key formats in 2026: "AQ." authorization keys are now the
    // default and the only type AI Studio issues, while the older "AIza"
    // standard keys are being rejected outright from September 2026. Any check
    // that insists on "AIza" now blocks the correct key and accepts a dead one
    // - which is exactly the bug this replaced. The endpoint itself doesn't
    // care about the prefix, so neither should we.
    //
    // The one shape still worth catching is an OAuth client secret, because
    // it's easy to grab from credentials.json by mistake and it will never
    // authenticate here.
    if (key.startsWith('GOCSPX-')) {
        return { ok: false, error: 'That is an OAuth client secret (the kind inside credentials.json, used for Google Calendar), not a Gemini API key. Get one from aistudio.google.com/apikey.' };
    }

    try {
        const text = await callGemini({
            apiKey: key,
            model,
            parts: [{ text: 'Reply with exactly: OK' }],
            // Generous even for a two-token answer: thinking is billed from
            // this same budget, so a tight cap makes a working key look broken.
            maxTokens: 512,
            thinkingLevel: 'low'
        });
        return { ok: true, reply: text.slice(0, 40) };
    } catch (err) {
        console.error('🔑 Key test failed:', err.message);
        return { ok: false, error: err.message };
    }
}

module.exports = {
    initConfig,
    readConfig,
    writeConfig,
    resolveProvider,
    resolveGeminiModel,
    generateText,
    generateFromPdf,
    generateFromImages,
    testGeminiKey,
    supportsVision: () => resolveProvider() === 'gemini'
};