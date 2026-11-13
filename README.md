# Interview Partner

A local web app for realistic mock-interview practice, by voice or text. An AI interviewer runs the interview in character, asks follow-up questions, and probes vague answers. A separate AI coach gives you feedback on each answer and a full scorecard at the end. Everything runs through the [Hopscotch API](https://api.hopscotchlabs.ai), an OpenAI-compatible gateway.

## Features

- **Four interview types:** behavioral, technical/coding (with a Monaco code editor), system design (with a notes pad and Mermaid diagram preview), and role-specific (tailored to a job description and your resume, which you can paste or upload as a PDF or text file).
- **Four levels and four interviewer personas:** Junior, Mid, Senior and Staff+; a friendly recruiter, a tough hiring manager, a skeptical principal engineer, and a neutral big-tech interviewer. Each persona has its own tone and voice.
- **Voice:** push-to-talk (hold the mic button or hold Space, or click to start and click again to stop). Your speech is transcribed into an editable text box before you send it. The interviewer's replies stream in as text and are spoken sentence by sentence, with mute and replay controls. Typing always works too.
- **Realistic pacing:** a session clock (15, 30, 45 or 60 minutes), an optional per-answer timer, a gentle "let's move on" when an answer runs over, and an in-character wrap-up when time is up. You can pause, skip a question, or end the interview at any time.
- **Feedback modes:**
  - **Tips + final scorecard:** a short feedback card after each answer.
  - **End-only:** no feedback until the interview is over.
  - **Coaching mode:** feedback appears before the interviewer continues, and you can retry the answer.

  Per-answer feedback includes a 1–5 score, two or three specific tips, and a STAR check for behavioral answers.
- **Scorecard:** an overall score out of 100 and a hire signal; five category scores (communication, structure, technical depth, problem solving, role fit); strengths and weaknesses; a question-by-question critique with a stronger model answer; and the top three things to practise next. You can export it to Markdown or PDF.
- **History and progress:** every session is saved locally in SQLite. The Progress page shows score trends, per-category charts, averages by interview type, and recurring weak spots. **Practise my weak spots** starts a new session that targets them.
- **Cost meter:** the approximate token usage and cost of each session, based on live pricing from `/v1/models`.

## Requirements

- **Node.js 22.13 or later.** The app uses Node's built-in `node:sqlite`, so there are no native modules to compile.
- **A Hopscotch API key.**

## Setup

```bash
npm install
cp .env.example .env      # then put your key in .env
npm run dev
```

Open http://localhost:5173 and allow microphone access when asked.

`npm run dev` starts the API server on port 8787 and the Vite dev server on port 5173, which proxies `/api` to the API server.

### Production build

```bash
npm run build
npm start                 # serves the built app and API on http://localhost:8787
```

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `HOPSCOTCH_API_KEY` | *(placeholder)* | Your API key. It is only ever used on the server and never sent to the browser. If it's unset, a placeholder is sent, which works only where a proxy injects credentials (as in a Claude Code cloud environment). |
| `HOPSCOTCH_BASE_URL` | `https://api.hopscotchlabs.ai/v1` | API base URL. |
| `PORT` | `8787` | API server port. |
| `DATA_DIR` | `./data` | Where the SQLite database is stored. |

If you're behind an HTTPS proxy, the npm scripts set `NODE_USE_ENV_PROXY=1`, so the server respects `HTTPS_PROXY`.

## Models

| Purpose | Model | Fallback |
|---|---|---|
| Interviewer and coach | `anthropic/claude-opus-5-5` (selectable in Settings) | Sonnet 5.5, then Haiku 5.5 |
| Speech to text | `openai-main/gpt-4o-mini-transcribe` | `deepinfra/whisper-large-v3` |
| Text to speech | `openai-main/gpt-4o-mini-tts` | `deepinfra/Kokoro-82M` |

If a model is unavailable, the app falls back to the next one automatically and tells you. As a rough guide, a 30-minute session on Opus costs between a few tens of cents and about a dollar, including grading. Haiku is roughly 40 times cheaper.

## How it works

```
src/
  shared/types.ts        Types, personas, weak-spot taxonomy (shared by server and client)
  server/
    index.ts             Express routes: sessions, SSE interviewer turns, feedback, scorecard, speech, progress
    prompts.ts           Interviewer system prompts (per type, persona and level) and grader prompts and JSON schemas
    hopscotch.ts         API client: streaming, model fallback, structured output, speech, pricing
    db.ts                SQLite storage
  client/
    pages/               Setup, Interview, Report, History, Progress
    components/          Workspace (Monaco + notes/Mermaid), feedback cards, charts
    lib/audio.ts         Sentence-streamed TTS playback and MediaRecorder capture
```

- **The interviewer and the grader are separate calls**, so the interviewer never breaks character to coach you. The grader uses strict `json_schema` structured output.
- The interviewer sees your code and notes, along with an interview clock and events (skip, answer timeout, time up), through platform notes attached to your turns. The prompts tell it never to mention them.
- Coding and design problems are written inside `<problem>` tags. They are shown on screen and pinned in the side panel, but not read aloud.
- Weak spots use a fixed tag list, so they can be counted across sessions.

## Troubleshooting

- **"Microphone access was blocked":** allow the mic for `localhost` in your browser's site settings, or just type your answers.
- **No interviewer voice:** check that it isn't muted (the speaker icon in the interview bar) and that **Speak interviewer replies aloud** is on in Settings. Some browsers block audio until you click on the page.
- **401 or 403 errors:** set `HOPSCOTCH_API_KEY` in `.env` and restart the server.
