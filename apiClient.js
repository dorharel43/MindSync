// apiClient.js
// Thin wrapper around the MindSync server's REST API. main.js calls these
// functions instead of talking to the database or local storage directly.
// Centralising fetch here means every IPC handler gets the same error shape
// and the same "server is down" handling for free.

// BUG FIX: .env doesn't travel inside a packaged .exe (npm run dist) - it's
// gitignored on purpose, and electron-builder doesn't bundle it either. A
// friend running the built app therefore always got this exact fallback,
// which used to be localhost:5000 - a server that only exists on YOUR
// machine. The default now points at the real shared server, so a packaged
// build works out of the box for anyone; .env stays as your own override
// for local development against a server running on your machine.
const SERVER_URL = process.env.MINDSYNC_SERVER_URL || 'https://mindsync-server-gags.onrender.com/api';
const SERVER_ROOT = SERVER_URL.replace(/\/api\/?$/, ''); // health check lives at '/', not '/api'
const authClient = require('./authClient');

// BUG FIX: only ping() had a timeout. Every other call went through fetch()
// with no AbortController at all - so a stuck/overloaded server left the
// whole modal frozen on "Processing..." forever, with no error and no log.
// Same class of bug as the missing Gemini timeout.
// BUG FIX: was 30000 - shorter than the 30-50s this very comment says a
// cold start takes, so the first request after the server slept could fail
// even though nothing was wrong.
const REQUEST_TIMEOUT_MS = 60000; // Render free tier cold-starts after idle (30-50s) - too short a timeout misreads that as "stuck"

// A predictable error for IPC handlers to catch: has a clear .message and,
// when the server responded with structured JSON, .status and .details.
class ApiClientError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.details = details;
  }
}

// AUTH: every request now carries the logged-in user's token unless it's
// explicitly exempted (register/login themselves - there's no token yet).
// This is the one place that needs to know about auth at all; every
// exported function below stays exactly as it was.
async function request(method, path, body, { skipAuth = false } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers = { 'Content-Type': 'application/json' };
  if (!skipAuth) {
    const token = authClient.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (networkErr) {
    if (networkErr.name === 'AbortError') {
      throw new ApiClientError(`The MindSync server at ${SERVER_URL} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s. Is it stuck or overloaded?`);
    }
    // Server not running, wrong port, no network. This is the most common
    // failure mode once the app depends on a separate process.
    throw new ApiClientError(
      `Can't reach the MindSync server at ${SERVER_URL}. Is it running? (${networkErr.message})`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  // BUG FIX: while Render is deploying or restarting it answers with an HTML
  // error page, not JSON. JSON.parse threw, and the user saw
  // "Unexpected token '<', "<!DOCTYPE"..." instead of a real explanation.
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiClientError(
        response.ok
          ? 'The server sent back something unexpected. Try again in a moment.'
          : `The server is not available right now (${response.status}). It may be restarting - try again in a minute.`,
        response.status
      );
    }
  }

  if (!response.ok) {
    const message = data?.error?.message || `Server responded with ${response.status}`;
    // A 401 here means the token is missing/expired/invalid - not a request
    // that can be retried, but a session that's over. Clearing it locally
    // means the next call, or the next app start, correctly asks the person
    // to log in again instead of silently repeating the same failure.
    if (response.status === 401 && !skipAuth) {
      authClient.clearSession();
    }
    // details carries Mongoose validation messages, which is what makes a
    // "Validation failed" actually diagnosable.
    throw new ApiClientError(message, data?.error?.status || response.status, data?.error?.details);
  }

  return data;
}

// Adds a plain `id` string mirrored from Mongo's `_id`, so renderer.js code
// that reads `item.id` keeps working unchanged.
function withIdAlias(doc) {
  if (!doc) return doc;
  return { ...doc, id: doc._id };
}
function withIdAliases(docs) {
  return Array.isArray(docs) ? docs.map(withIdAlias) : docs;
}

module.exports = {
  ApiClientError,

  // ---- Tasks ----
  getTasks: async () => withIdAliases(await request('GET', '/tasks')),
  createTask: (task) => request('POST', '/tasks', task).then(withIdAlias),
  updateTask: (id, updates) => request('PUT', `/tasks/${id}`, updates).then(withIdAlias),
  deleteTask: (id) => request('DELETE', `/tasks/${id}`),
  getTaskCategories: () => request('GET', '/tasks/categories'),

  // ---- Subtasks (checklist) ----
  addSubtask: (taskId, title) =>
    request('POST', `/tasks/${taskId}/subtasks`, { title }).then(withIdAlias),
  toggleSubtask: (taskId, subtaskId, completed) =>
    request('PATCH', `/tasks/${taskId}/subtasks/${subtaskId}`, { completed }).then(withIdAlias),
  deleteSubtask: (taskId, subtaskId) =>
    request('DELETE', `/tasks/${taskId}/subtasks/${subtaskId}`).then(withIdAlias),

  // ---- Events ----
  getEvents: async () => withIdAliases(await request('GET', '/events')),
  getEvent: (id) => request('GET', `/events/${id}`).then(withIdAlias),
  createEvent: (evt) => request('POST', '/events', evt).then(withIdAlias),
  updateEvent: (id, updates) => request('PUT', `/events/${id}`, updates).then(withIdAlias),
  deleteEvent: (id) => request('DELETE', `/events/${id}`),

  // ---- Folders ----
  getFolders: async () => withIdAliases(await request('GET', '/folders')),
  createFolder: (folder) => request('POST', '/folders', folder).then(withIdAlias),
  deleteFolder: (id) => request('DELETE', `/folders/${id}`),

  // ---- Files ----
  getFiles: async () => withIdAliases(await request('GET', '/files')),
  // Names/folders only - the server's ?light=1 leaves out each file's full
  // extracted text, which the duplicate check before an upload doesn't need.
  getFilesLight: async () => withIdAliases(await request('GET', '/files?light=1')),
  createFile: (file) => request('POST', '/files', file).then(withIdAlias),
  getFile: (id) => request('GET', `/files/${id}`).then(withIdAlias),
  updateFile: (id, updates) => request('PUT', `/files/${id}`, updates).then(withIdAlias),
  deleteFile: (id) => request('DELETE', `/files/${id}`),

  // ---- Auth ----
  // register/login skip the auth header - there's no token to send yet.
  register: (email, password, name, degree) =>
    request('POST', '/auth/register', { email, password, name, degree }, { skipAuth: true }),
  login: (email, password) =>
    request('POST', '/auth/login', { email, password }, { skipAuth: true }),
  // Replaces the old getProfile/updateProfile - name/degree now live on the
  // User document itself (see routes/auth.js), not a separate Profile.
  getMe: () => request('GET', '/auth/me'),
  updateMe: (updates) => request('PUT', '/auth/me', updates),

  // ---- Stats: removed with /api/stats (XP/levels/streak dropped server-side) ----

  // ---- Settings / blocked apps ----
  getBlockedApps: () => request('GET', '/settings/blocked-apps'),
  addBlockedApp: (appName) => request('POST', '/settings/blocked-apps', { appName }),
  removeBlockedApp: (appName) =>
    request('DELETE', `/settings/blocked-apps/${encodeURIComponent(appName)}`),

  // ---- Study (spaced repetition) ----
  getDueStudyItems: async (opts = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.category) params.set('category', opts.category);
    const qs = params.toString();
    return withIdAliases(await request('GET', `/study/due${qs ? '?' + qs : ''}`));
  },
  getStudyItems: async (opts = {}) => {
    const params = new URLSearchParams();
    if (opts.category) params.set('category', opts.category);
    if (opts.mode) params.set('mode', opts.mode);
    const qs = params.toString();
    return withIdAliases(await request('GET', `/study${qs ? '?' + qs : ''}`));
  },
  getStudyStats: () => request('GET', '/study/stats'),
  deleteStudyItemsBulk: (ids) => request('POST', '/study/bulk-delete', { ids }),
  deleteAllStudyItems: () => request('DELETE', '/study/all/everything'),
  getStudyCategories: () => request('GET', '/study/categories'),
  createStudyItemsBulk: (items) => request('POST', '/study/bulk', { items }),
  submitStudyReview: (id, payload) => request('POST', `/study/${id}/review`, payload),
  updateStudyItem: (id, updates) => request('PUT', `/study/${id}`, updates).then(withIdAlias),
  deleteStudyItem: (id) => request('DELETE', `/study/${id}`),

  // ---- Admin ----
  hardReset: () => request('POST', '/admin/hard-reset'),

  // Health check for the connection-status banner. Short timeout so an
  // unreachable server doesn't leave the UI hanging in "connecting...".
  ping: async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(SERVER_ROOT, { signal: controller.signal });
      if (!res.ok) throw new Error(`Health check returned ${res.status}`);
      return true;
    } finally {
      clearTimeout(timeout);
    }
  },
};