// logger.js
// ---------------------------------------------------------------------------
// In a packaged .exe there is no visible terminal, so every console.error
// this whole session relied on for debugging goes nowhere for an actual
// friend running the app. This mirrors console.error/warn into a small file
// in userData (same pattern as aiProvider.js's config and authClient.js's
// session - one file per concern, in the same place), so there's something
// to actually retrieve when someone hits a bug.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let logPath = null;
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB cap - simple rotation, not unbounded growth on a machine that stays open for weeks

function initLogger(userDataPath) {
    logPath = path.join(userDataPath, 'mindsync.log');

    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    function writeLine(prefix, args) {
        try {
            const text = args.map(a => {
                if (typeof a === 'string') return a;
                if (a instanceof Error) return a.stack || a.message;
                try { return JSON.stringify(a); } catch { return String(a); }
            }).join(' ');
            const line = `[${new Date().toISOString()}] ${prefix} ${text}\n`;

            if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_SIZE) {
                fs.writeFileSync(logPath, `[log rotated at ${new Date().toISOString()}]\n`);
            }
            fs.appendFileSync(logPath, line);
        } catch (e) {
            // Logging must never be the thing that crashes the app.
        }
    }

    // Keep the original behavior (still prints when a terminal IS attached -
    // your own `npm start`) and add the file write alongside it.
    console.error = (...args) => { origError(...args); writeLine('ERROR', args); };
    console.warn = (...args) => { origWarn(...args); writeLine('WARN', args); };

    console.log(`📝 Diagnostic log: ${logPath}`);
}

// Returns the tail of the log as plain text - what the "Copy diagnostic log"
// Settings button sends to the clipboard. Capped so a huge log doesn't choke
// the clipboard or an IPC message.
function getLogTail(maxChars = 20000) {
    try {
        if (!logPath || !fs.existsSync(logPath)) return '(No log file yet - nothing has been logged this session.)';
        const content = fs.readFileSync(logPath, 'utf-8');
        return content.length > maxChars
            ? `...(truncated - showing the most recent part)...\n${content.slice(-maxChars)}`
            : content;
    } catch (e) {
        return `(Could not read the log file: ${e.message})`;
    }
}

module.exports = { initLogger, getLogTail };