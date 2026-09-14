// apiClient.js
// Thin wrapper around the MindSync server's REST API. main.js calls these
// functions instead of talking to the database or local storage directly.
// Centralising fetch here means every IPC handler gets the same error shape
// and the same "server is down" handling for free.

const SERVER_URL = process.env.MINDSYNC_SERVER_URL || 'http://localhost:5000/api';
const SERVER_ROOT = SERVER_URL.replace(/\/api\/?$/, ''); // health check lives at '/', not '/api'

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
    response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    // Server not running, wrong port, no network. This is the most common
    // failure mode once the app depends on a separate process.
    throw new ApiClientError(
      `Can't reach the MindSync server at ${SERVER_URL}. Is it running? (${networkErr.message})`
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
  createFile: (file) => request('POST', '/files', file).then(withIdAlias),
  deleteFile: (id) => request('DELETE', `/files/${id}`),

  // ---- Profile ----
  getProfile: () => request('GET', '/profile'),
  updateProfile: (profile) => request('PUT', '/profile', profile),

  // ---- Stats ----
  getStats: () => request('GET', '/stats'),
  completeTaskXP: (urgency) => request('POST', '/stats/complete-task', { urgency }),

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
