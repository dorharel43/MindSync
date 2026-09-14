# MindSync AI

Smart learning assistant. Electron desktop client + Express/MongoDB server,
with local AI via Ollama.

## Layout

```
client/    Electron app (UI + AI + Google Calendar + app blocker)
server/    Express API, MongoDB via Mongoose ("black box" - owns all data)
```

## Setup

### 1. Server

```bash
cd server
npm install
cp .env.example .env      # then fill in MONGO_URI
npm run dev               # starts on http://localhost:5000
```

Required in `server/.env`:
- `MONGO_URI` — MongoDB Atlas connection string
- `PORT` — optional, defaults to 5000
- `ALLOWED_ORIGINS` — optional, comma-separated, for browser clients in production

### 2. Client

```bash
cd client
npm install
cp .env.example .env
npm start
```

You also need these in `client/` (NOT in version control):
- `credentials.json` — Google OAuth client, from Google Cloud Console
- `token.json` — generated automatically on first Calendar sync

### 3. Ollama (local AI)

```bash
ollama pull aya-expanse:8b
```

The model name is set at the top of `client/main.js` (`LOCAL_MODEL`).
Ollama must be running in the background for AI features to work.

**Start order:** server first, then the Electron client. The client shows a
connection banner and degrades gracefully if the server is unreachable.

## Notable implementation details

- **Grounding check** — extracted tasks must quote the source document, or
  they're discarded. Stops the model inventing plausible-sounding steps.
- **Urgency is derived, not guessed** — computed from the extracted due date
  in code, never taken from the model.
- **Hebrew handled by keywords first** — day names and event types are matched
  deterministically before any model call, because small models mis-handle
  Hebrew translation-plus-inference.
- **Chunking** — long documents are split and processed in parts, then merged
  and deduplicated, so nothing past a cutoff is silently lost.
- **Design tokens** — all spacing/colour lives in `tokens.css` + `themes.css`.
  Never hardcode a colour; three themes read from the same variables.

## Known gaps (not yet addressed)

- `nodeIntegration: true` / `contextIsolation: false` in `main.js` — must be
  replaced with a preload script + contextBridge before any public release.
- No authentication or per-user data separation on the server. Every client
  currently sees the same data set.
