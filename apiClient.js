// apiClient.js
// Thin wrapper around the MindSync server's REST API. main.js calls these
// functions instead of talking to the database or local storage directly.
// Centralising fetch here means every IPC handler gets the same error shape
// and the same "server is down" handling for free.

// Where the server lives.
//
// Resolved at call time rather than fixed when this file loads, because an
// installed app has no environment variables to read: the person who double
// clicks an icon never set MINDSYNC_SERVER_URL, and never should have to.
// The order below runs from most specific to most general - a developer's
// override, then whatever the app was built pointing at, then localhost for
// running the two halves side by side.
let serverUrl = null;

function normaliseServerUrl(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  // Accept both "https://host" and "https://host/api" - forgetting the suffix
  // is the obvious mistake and there is no reason to punish it.
  return /\/api$/.test(trimmed) ? trimmed : `${trimmed}/api`;
}

// Called once by main.js at startup, after the saved settings are read.
function setServerUrl(url) {
  serverUrl = normaliseServerUrl(url);
  return serverUrl;
}

function getServerUrl() {
  return serverUrl
    || normaliseServerUrl(process.env.MINDSYNC_SERVER_URL)
    || 'http://localhost:5000/api';
}

// The health check lives at '/', not '/api'.
function getServerRoot() {
  return getServerUrl().replace(/\/api\/?$/, '');
}

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

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(`${getServerUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    // Server not running, wrong port, no network. This is the most common
    // failure mode once the app depends on a separate process.
    throw new ApiClientError(
      `Can't reach the MindSync server at ${getServerUrl()}. Is it running? (${networkErr.message})`
    );
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.error?.message || `Server responded with ${response.status}`;
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
  setServerUrl,
  getServerUrl,
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
  getFiles: async (opts = {}) => withIdAliases(await request('GET', `/files${opts.light ? '?light=1' : ''}`)),
  getFile: async (id) => withIdAlias(await request('GET', `/files/${id}`)),
  createFile: (file) => request('POST', '/files', file).then(withIdAlias),
  deleteFile: (id) => request('DELETE', `/files/${id}`),

  // ---- Profile ----
  getProfile: () => request('GET', '/profile'),
  updateProfile: (profile) => request('PUT', '/profile', profile),

  clearAutoScheduledEvents: () => request('DELETE', '/events/auto-scheduled'),
  clearEventsForTask: (taskId) => request('DELETE', `/events/by-task/${taskId}`),

  // ---- Study stats ----
  // The XP/level/streak endpoints were removed along with the feature.

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
    // Callers that never touch review history ask for the light form.
    if (opts.light) params.set('light', '1');
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
      const res = await fetch(getServerRoot(), { signal: controller.signal });
      if (!res.ok) throw new Error(`Health check returned ${res.status}`);
      return true;
    } finally {
      clearTimeout(timeout);
    }
  },
};