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

// ---- Models --------------------------------------------------------------------
// 3.8 Flash costs the same as 3.6 Flash (the old default) and is newer.
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

// Used when the main model is overloaded (503) or out of quota (429). It runs
// on separate capacity and, on the free tier, has its own separate quota - so
// it is usually available exactly when the main model isn't. Its questions and
// summaries are a bit plainer, but far better than the extracted-text path.
const FALLBACK_GEMINI_MODEL = 'gemini-3.5-flash-lite';

// Configs saved before the upgrade carry the old default in ai-config.json.
// Nobody picked it on purpose (there was no model picker back then).
const LEGACY_DEFAULT_MODELS = ['gemini-3.6-flash'];

function activeGeminiModel(cfg) {
    const m = cfg && cfg.geminiModel;
    return !m || LEGACY_DEFAULT_MODELS.includes(m) ? DEFAULT_GEMINI_MODEL : m;
}

// "gemini-3.1-pro-preview" -> "Gemini 3.1 Pro", for showing people which
// model actually wrote something.
function modelLabel(model) {
    const m = String(model || '');
    if (m.startsWith('ollama:')) return 'the local model';
    return m
        .replace(/-preview$/, '')
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
        .replace(/Flash Lite/, 'Flash-Lite');
}

// Not every model accepts every thinking level (Google's thinking docs):
//   Flash (3.6+) : low, medium, high       - no 'minimal'
//   Flash-Lite   : minimal, low, medium, high
//   3.1 Pro      : low, high               - no 'minimal', no 'medium'
// Question generation asks for 'medium', which Pro rejects - so switching to
// Pro would have broken it. Map to the nearest level the model accepts;
// 'medium' becomes 'high' on Pro because quality is the reason to pick Pro.
function thinkingLevelFor(model, level) {
    const wanted = level || 'low';
    if (/pro/i.test(model)) return (wanted === 'medium' || wanted === 'high') ? 'high' : 'low';
    if (/lite/i.test(model)) return wanted;
    return wanted === 'minimal' ? 'low' : wanted;
}

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
        cachedConfig = { provider: 'auto', geminiKey: '', geminiModel: DEFAULT_GEMINI_MODEL };
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

// BUG FIX: this request had no timeout at all, unlike callOllama's watchdog.
// If Google's endpoint stalls (an outage, a dropped connection) fetch() just
// hangs forever with no error and no log line - which is exactly the "stuck
// on Processing... with nothing in the terminal" symptom. 90s is generous
// enough for a slow PDF/vision call but still finite.
const GEMINI_TIMEOUT_MS = 90000;

// An Error that also says what KIND of failure it was, so the retry logic
// below can tell "Google is busy, try again" from "your key is wrong".
function geminiError(message, fields = {}) {
    return Object.assign(new Error(message), fields);
}

// When a free key's DAILY quota resets: midnight US Pacific time, whatever
// the user's own time zone. Returned as a timestamp.
function nextPacificMidnight(now = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
    const secondsIntoDay = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
    return now + (86400 - secondsIntoDay) * 1000;
}

function localTimeLabel(ts) {
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Which quota a 429 hit. Google names it in the error details, e.g.
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier" (limit: 20).
function parseQuotaFailure(data, message) {
    const violations = (data?.error?.details || [])
        .filter(d => String(d['@type'] || '').includes('QuotaFailure'))
        .flatMap(d => d.violations || []);
    const daily = violations.some(v => /PerDay/i.test(String(v.quotaId || '')));
    const m = /limit:\s*(\d+)/.exec(String(message || ''));
    return { daily, limit: m ? Number(m[1]) : null, freeTier: violations.some(v => /FreeTier/i.test(String(v.quotaId || ''))) };
}

// Google's 429 may say how long to wait ("retryDelay": "12s").
function parseRetryDelayMs(data) {
    const info = (data?.error?.details || []).find(d => String(d['@type'] || '').includes('RetryInfo'));
    const m = info && /^(\d+(?:\.\d+)?)s$/.exec(String(info.retryDelay || ''));
    return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}

async function callGemini({ apiKey, model, parts, maxTokens = 2048, forceJson = false, system = null, thinkingLevel = 'low', timeoutMs = GEMINI_TIMEOUT_MS }) {
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
            // thinkingLevelFor() keeps the level to one this model accepts.
            thinkingConfig: { thinkingLevel: thinkingLevelFor(model, thinkingLevel) },

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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
        // Authenticate with the header rather than a query parameter. It's the
        // documented form, and it keeps the key out of URLs - which end up in
        // proxy logs, crash reports and error messages.
        res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw geminiError(`Gemini did not respond within ${Math.round(timeoutMs / 1000)}s (likely a Google outage or a network stall). Try again in a few minutes.`, { timedOut: true });
        }
        // A dropped connection is usually momentary - worth another try.
        throw geminiError(`Could not reach Gemini: ${err.message}`, { retryable: true });
    } finally {
        clearTimeout(timeoutId);
    }

    const raw = await res.text();
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        data = null;
    }

    if (!res.ok) {
        const msg = data?.error?.message || `Gemini returned ${res.status}`;
        // Log the full response. Swallowing it meant a rejection showed a
        // one-line toast and nothing in the terminal, which left no way to
        // tell a revoked key from a disabled project or a quota problem.
        console.error(`❌ Gemini (${model}) HTTP ${res.status} ${res.statusText}`);
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
                throw geminiError('This is an older "AIza" standard key. Google stopped accepting those in September 2026 — create a new key at aistudio.google.com/apikey and it will be issued in the current "AQ." format.', { status: res.status });
            }
            throw geminiError(`Google rejected the key: ${msg}`, { status: res.status });
        }
        if (res.status === 429) {
            // Either a short per-minute limit (Google says how long to wait)
            // or the day's quota for this model. The retry logic waits out
            // the first and switches model for the second.
            //
            // BUG FIX: a free key's DAILY limit (20 requests a day for 3.8
            // Flash) also comes with "retry in 19s", so it was retried - 20
            // seconds of waiting on every action, all day, for a quota that
            // only comes back at midnight Pacific time. Daily = no retry, and
            // the model is skipped until the reset (see callGeminiResilient).
            const quota = parseQuotaFailure(data, msg);
            if (quota.daily) {
                const resetAt = nextPacificMidnight();
                throw geminiError(
                    `Today's ${quota.freeTier ? 'free ' : ''}Gemini quota for ${model} is used up` +
                    `${quota.limit ? ` (${quota.limit} requests a day${quota.freeTier ? ' on a free key' : ''})` : ''}. It resets at ${localTimeLabel(resetAt)}.`,
                    { status: 429, dailyQuota: true, retryable: false, resetAt }
                );
            }
            const retryAfterMs = parseRetryDelayMs(data);
            throw geminiError('Gemini rate limit reached. Wait a minute, or switch to the local model in Settings.', {
                status: 429,
                retryable: retryAfterMs !== null && retryAfterMs <= 20000,
                retryAfterMs
            });
        }
        if ([500, 502, 503, 504].includes(res.status)) {
            // 503 "The model is overloaded" - Google's side, not the key.
            // Usually clears within seconds, so it's worth retrying.
            throw geminiError(`Google's AI servers are busy right now (${res.status}). This isn't a problem with your key.`, {
                status: res.status,
                retryable: true,
                overloaded: true
            });
        }
        throw geminiError(msg, { status: res.status });
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

// ---- Retries and fallback model ---------------------------------------------
// BUG FIX: one 503 ("model is overloaded") used to fail the whole generation
// on the spot. Those are momentary and Google's own guidance is to retry with
// a growing wait. The app then fell back to extracted text - which also went
// to the same overloaded Gemini - and then to Ollama, which most users don't
// have. So a busy minute at Google meant "Could not create questions".
//
// Now: retry the same model after 2s, 5s and 12s (plus a little randomness,
// so many clients don't all retry at the same instant). If it is still busy -
// or out of quota, or timed out - switch to the fallback model once.
const RETRY_DELAYS_MS = [2000, 5000, 12000];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(opts, delays = RETRY_DELAYS_MS) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await callGemini(opts);
        } catch (err) {
            if (!err.retryable || attempt >= delays.length) throw err;
            const wait = err.retryAfterMs || (delays[attempt] + Math.floor(Math.random() * 500));
            console.warn(`⏳ Gemini (${opts.model}) ${err.status || 'network'} - retry ${attempt + 1}/${delays.length} in ${(wait / 1000).toFixed(1)}s`);
            await sleep(wait);
        }
    }
}

// Returns { text, model } - which model actually answered, so a caller can
// say so. When you pick Pro to compare it with Flash, a summary that was
// quietly written by a fallback must not pass for Pro's work.
//
// Fallback order: the chosen model, then the default Flash (when the chosen
// one was something else - e.g. Pro on a key without billing, which Pro
// needs), then Flash-Lite.
// Models whose daily quota ran out -> when it comes back. Skipped until
// then, instead of asking Google (and waiting) again on every action.
const dailyQuotaUntil = {};

async function callGeminiResilient(opts) {
    const chain = [opts.model];
    if (opts.model !== DEFAULT_GEMINI_MODEL) chain.push(DEFAULT_GEMINI_MODEL);
    if (!chain.includes(FALLBACK_GEMINI_MODEL)) chain.push(FALLBACK_GEMINI_MODEL);

    let firstErr = null;
    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        if (dailyQuotaUntil[model] && dailyQuotaUntil[model] > Date.now()) {
            const skipped = geminiError(`Today's Gemini quota for ${model} is used up. It resets at ${localTimeLabel(dailyQuotaUntil[model])}.`,
                { status: 429, dailyQuota: true, resetAt: dailyQuotaUntil[model] });
            if (!firstErr) firstErr = skipped;
            lastErr = skipped;
            console.warn(`⏭️ ${model}: daily quota used up - skipped until ${localTimeLabel(dailyQuotaUntil[model])}`);
            continue;
        }
        try {
            // Full retries on the chosen model; one retry on each fallback -
            // they run on separate capacity, and the user has already waited.
            const text = await callGeminiWithRetry({ ...opts, model }, i === 0 ? RETRY_DELAYS_MS : [3000]);
            if (i > 0) console.warn(`↪️ Answered by fallback ${model} (${chain[0]} unavailable)`);
            return { text, model };
        } catch (err) {
            if (!firstErr) firstErr = err;
            lastErr = err;
            if (err.dailyQuota) dailyQuotaUntil[model] = err.resetAt;
            // 404 on the CHOSEN model = a model id Google doesn't know (a
            // retired preview, say) - worth falling back to one that exists.
            const worthSwitching = err.overloaded || err.timedOut || err.status === 429 || (i === 0 && err.status === 404);
            if (!worthSwitching) throw err;
            if (i < chain.length - 1) console.warn(`↪️ ${model} unavailable (${err.message}) - trying ${chain[i + 1]}`);
        }
    }

    console.error(`❌ All models failed. First: ${firstErr.message} | Last: ${lastErr.message}`);
    if (firstErr.status === 429 && lastErr.status === 429) {
        const reset = firstErr.resetAt || lastErr.resetAt;
        throw new Error(`You've used today's Gemini quota on every model. It resets${reset ? ` at ${localTimeLabel(reset)}` : ' within 24 hours'}.`);
    }
    if (firstErr.dailyQuota) {
        // The usual case on a free key: the main model's day is used up and
        // the backup is overloaded. Say BOTH - "Google is overloaded" alone
        // hides that the main model won't come back in a few minutes.
        throw new Error(`${firstErr.message} The backup model is overloaded right now, so nothing could answer.`);
    }
    throw new Error('Google\'s AI servers are overloaded right now - not a problem with your key or your file. Try again in a few minutes.');
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
    let geminiError = null;

    if (provider === 'gemini') {
        try {
            const r = await callGeminiResilient({
                apiKey: cfg.geminiKey,
                model: activeGeminiModel(cfg),
                parts: [{ text: prompt }],
                maxTokens: options.maxTokens || 2048,
                forceJson: options.forceJson,
                system: options.system,
                thinkingLevel: options.thinkingLevel || 'low',
                ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
            });
            return options.withMeta ? r : r.text;
        } catch (err) {
            // Falling back keeps the app usable when the network or the quota
            // gives out - the original reason for preferring a local model.
            console.warn('⚠️ Gemini failed, falling back to Ollama:', err.message);
            if (options.noFallback) throw err;
            geminiError = err;
        }
    }

    try {
        const localModel = options.localModel || 'aya-expanse:8b';
        const text = await callOllama(prompt, {
            model: localModel,
            maxTokens: options.maxTokens || 800,
            forceJson: options.forceJson,
            system: options.system
        });
        return options.withMeta ? { text, model: `ollama:${localModel}` } : text;
    } catch (ollamaErr) {
        // BUG FIX: this used to just let ollamaErr propagate alone, which
        // for someone who only ever configured Gemini (no Ollama installed)
        // meant seeing "Ollama is not reachable. Open the Ollama app and try
        // again." - confusing and actionable-sounding for an app they never
        // set up, while the actual cause (Gemini's real error - rate limit,
        // bad key, outage...) was logged to the console and never shown to
        // them at all. Now: someone who uses Gemini just sees Gemini's
        // reason; the Ollama part is only added if Ollama is actually set up.
        if (geminiError) {
            if (/not reachable/i.test(ollamaErr.message)) throw geminiError;
            throw new Error(`Gemini failed (${geminiError.message}) and the local fallback also failed (${ollamaErr.message}).`);
        }
        throw ollamaErr;
    }
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

    // One PDF, or several in one request (1/10: a course's past exams read
    // together, to see what repeats between them).
    const parts = [
        { text: prompt },
        ...(Array.isArray(pdfBuffer) ? pdfBuffer : [pdfBuffer]).map(b => ({ inlineData: { mimeType: 'application/pdf', data: b.toString('base64') } }))
    ];

    const r = await callGeminiResilient({
        apiKey: cfg.geminiKey,
        model: activeGeminiModel(cfg),
        parts,
        maxTokens: options.maxTokens || 8192,
        forceJson: options.forceJson,
        system: options.system,
        thinkingLevel: options.thinkingLevel || 'low',
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    });
    return options.withMeta ? r : r.text;
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

    const r = await callGeminiResilient({
        apiKey: cfg.geminiKey,
        model: activeGeminiModel(cfg),
        parts,
        maxTokens: options.maxTokens || 4096,
        forceJson: options.forceJson,
        system: options.system,
        thinkingLevel: options.thinkingLevel || 'low',
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    });
    return options.withMeta ? r : r.text;
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
        // Retries, but no model switch: this is a test of the key.
        const text = await callGeminiWithRetry({
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
        // BUG FIX: a busy Google used to show "Key rejected" for a perfectly
        // good key.
        if (err.overloaded || err.timedOut) {
            return { ok: false, error: 'Google\'s servers are busy, so the key couldn\'t be checked. This doesn\'t mean the key is wrong - try again in a minute.' };
        }
        return { ok: false, error: err.message };
    }
}

module.exports = {
    initConfig,
    readConfig,
    writeConfig,
    resolveProvider,
    generateText,
    generateFromPdf,
    generateFromImages,
    testGeminiKey,
    supportsVision: () => resolveProvider() === 'gemini',
    activeGeminiModel: () => activeGeminiModel(readConfig()),
    modelLabel,
    DEFAULT_GEMINI_MODEL,
    FALLBACK_GEMINI_MODEL
};