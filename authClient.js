// authClient.js
// ---------------------------------------------------------------------------
// Holds the logged-in user's session (JWT + basic profile) for the lifetime
// of the app, and persists it to disk so the person isn't asked to log in
// again every time they open the app. Mirrors aiProvider.js's config
// pattern on purpose - same shape, same place, one less thing to relearn.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

let sessionPath = null;
let cachedSession = null; // { token, user: { id, email, name, degree } } | null

function initSession(userDataPath) {
    sessionPath = path.join(userDataPath, 'auth-session.json');
}

function readSession() {
    if (cachedSession !== null) return cachedSession;
    try {
        cachedSession = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
        cachedSession = null;
    }
    return cachedSession;
}

function saveSession(session) {
    cachedSession = session;
    try {
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    } catch (e) {
        console.error('Could not save session:', e.message);
    }
}

function clearSession() {
    cachedSession = null;
    try {
        if (sessionPath && fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    } catch (e) {
        console.error('Could not clear session:', e.message);
    }
}

// What apiClient.js calls on every request to decide whether (and what) to
// put in the Authorization header. A plain string, not an object, so the
// caller never has to reach into session shape it shouldn't care about.
function getToken() {
    const session = readSession();
    return session ? session.token : null;
}

function getUser() {
    const session = readSession();
    return session ? session.user : null;
}

module.exports = { initSession, readSession, saveSession, clearSession, getToken, getUser };
