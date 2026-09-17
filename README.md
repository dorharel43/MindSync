# MindSync

> An AI study assistant that tells you what you actually know — not what you think you know.

MindSync is a desktop application for students. It reads your course material,
turns it into tasks and study sessions, and quizzes you in a way that measures
the gap between how confident you feel and how much you actually recall.

This repository contains the **Electron desktop client**.
The API lives in a separate repository: [MindSync-Server](https://github.com/dorharel43/MindSync-Server).

---

## Why I built it

Reading a summary creates a feeling of understanding that was never tested, and
a chat bot makes it worse — the more fluent the explanation, the stronger the
illusion. MindSync measures the gap between subjective confidence and actual
recall, and shows it to you.

That thesis drives the design: **a confidently wrong answer is worse than no
answer**, so the model's job was reduced from "know the material" to "find the
relevant passage in the material".

---

## Features

| | |
|---|---|
| **My Day / Weekly Plan** | Tasks and events for today and for the week ahead |
| **Study Materials** | Upload PDFs, organise them into folders, extract tasks and questions from them |
| **Study sessions** | Recall questions generated from your own material, answered by direct quotes from the source |
| **Confidence calibration** | Rate your confidence before each answer, then see where confidence and accuracy diverge |
| **Progress** | Track what has been studied and what is still weak |
| **Google Calendar sync** | Two-way sync of extracted events |
| **Three themes** | Light, dark and high contrast, all driven by the same design tokens |

Hebrew and English course material are both supported, including right-to-left PDFs.

---

## Tech stack

**Client:** Electron · vanilla JavaScript · custom CSS design-token system
**AI:** Google Gemini (cloud) with a local [Ollama](https://ollama.com) model as fallback
**PDF:** `pdfjs-dist` for page rendering, `pdf2json` for text extraction
**Integrations:** Google Calendar API
**Server (separate repo):** Node.js · Express 5 · MongoDB (Mongoose) · JWT auth

---

## Getting started

### Prerequisites

- Node.js 18 or newer
- A running MindSync server — see [MindSync-Server](https://github.com/dorharel43/MindSync-Server)
- A Google Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- *(Optional)* [Ollama](https://ollama.com) for offline AI

### Install

```bash
git clone https://github.com/dorharel43/MindSync.git
cd MindSync
npm install
cp .env.example .env     # then edit .env
npm start
```

### Configuration

Copy `.env.example` to `.env` and fill it in. Nothing secret is ever committed.

| Variable | Required | Description |
|---|---|---|
| `MINDSYNC_SERVER_URL` | no | API base URL. Defaults to the deployed server; set it to `http://localhost:5000/api` for local development |

The Gemini API key is **not** stored in `.env`. It is entered once in the app's
Settings screen and saved to the OS user-data directory, so it never reaches the
repository.

Google Calendar sync additionally needs `credentials.json` (an OAuth client from
the Google Cloud Console) in the project root. `token.json` is generated
automatically on first sync. Both are git-ignored.

### Optional: local AI fallback

```bash
ollama pull aya-expanse:8b
```

Ollama must be running in the background. The model name is set at the top of
`main.js` (`LOCAL_MODEL`).

### Build a Windows installer

```bash
npm run dist
```

---

## Architecture

```
main.js          Electron main process — IPC, AI prompts, content filters
renderer.js      All UI logic
apiClient.js     REST wrapper around the server, with timeouts on every call
authClient.js    Stores the session token in the OS user-data directory
aiProvider.js    Abstraction over Gemini / Ollama, with two-way fallback
logger.js        Mirrors console.error/warn to a file — a packaged .exe has no terminal
pdfExtract.js    RTL-aware text extraction
pdfRender.js     Page-to-image rendering for the vision path
weekPlanner.js   Weekly plan view
tokens.css       Design tokens — spacing, colour, radius
themes.css       Three themes, all reading the same tokens
ui-kit.css       Reusable components
```

### Design decisions worth calling out

- **The AI locates answers, it does not write them.** A recall answer is a
  verbatim quote from the course material. When the model wrote answers itself
  it produced confident, plausible, wrong content — unacceptable in a product
  whose whole premise is truth.
- **Grounding check.** An extracted task must quote its source document or it is
  discarded, which stops the model inventing plausible-sounding steps.
- **Urgency is derived, not guessed.** It is computed in code from the extracted
  due date, never taken from the model.
- **Hebrew is matched by keywords first.** Day names and event types are resolved
  deterministically before any model call, because small models mishandle
  translation-plus-inference in Hebrew.
- **Chunking.** Long documents are split, processed in parts, then merged and
  deduplicated, so nothing past a context cutoff is silently lost.
- **A timeout on every network call.** Both AI providers included — a hung
  request must degrade, not freeze the UI.

---

## Roadmap

- [ ] Replace `nodeIntegration` with a preload script and `contextBridge`
- [ ] Automated tests for the extraction pipeline
- [ ] macOS and Linux builds
- [ ] Spaced repetition scheduling for recall questions

---

## Author

**Dor Harel** — Information Systems student, Yezreel Valley College
[github.com/dorharel43](https://github.com/dorharel43)

## License

[MIT](LICENSE)
