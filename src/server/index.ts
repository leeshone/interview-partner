import './env';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  CATEGORIES,
  CHAT_MODELS,
  DEFAULT_CONFIG,
  PERSONAS,
  TTS_VOICES,
  WEAKNESS_TAGS,
  personaById,
  tagLabel,
  typeLabel,
  type AnswerFeedback,
  type InterviewType,
  type Message,
  type Scorecard,
  type SessionConfig,
} from '../shared/types';
import * as db from './db';
import {
  ApiError,
  chatCost,
  hasRealKey,
  loadPricing,
  priceFor,
  speak,
  streamChat,
  structuredChat,
  transcribe,
} from './hopscotch';
import {
  ANSWER_FEEDBACK_SCHEMA,
  SCORECARD_SCHEMA,
  answerFeedbackMessages,
  buildInterviewerMessages,
  cleanInterviewerText,
  scorecardMessages,
  transcriptText,
} from './prompts';

const PORT = Number(process.env.PORT || 8787);
const app = express();
app.use(express.json({ limit: '4mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const pid = (req: Request) => String(req.params.id);
function mustSession(id: string) {
  const s = db.getSession(id);
  if (!s) throw new HttpError(404, 'Session not found');
  return s;
}

function sanitizeConfig(input: Partial<SessionConfig>): SessionConfig {
  const c = { ...DEFAULT_CONFIG, ...input };
  const pick = <T,>(v: T, allowed: readonly T[], d: T) => (allowed.includes(v) ? v : d);
  return {
    type: pick(c.type, ['behavioral', 'coding', 'system-design', 'role-specific'] as const, 'behavioral'),
    difficulty: pick(c.difficulty, ['junior', 'mid', 'senior', 'staff'] as const, 'mid'),
    persona: pick(c.persona, PERSONAS.map((p) => p.id), 'friendly-recruiter'),
    lengthMin: pick(Number(c.lengthMin) as SessionConfig['lengthMin'], [15, 30, 45, 60] as const, 30),
    answerTimerSec: pick(Number(c.answerTimerSec) as SessionConfig['answerTimerSec'], [0, 60, 120, 180, 300] as const, 0),
    feedbackMode: pick(c.feedbackMode, ['both', 'end-only', 'every-answer'] as const, 'both'),
    model: String(c.model || DEFAULT_CONFIG.model),
    voice: TTS_VOICES.includes(c.voice) ? c.voice : '',
    jobDescription: String(c.jobDescription ?? '').slice(0, 30000),
    resume: String(c.resume ?? '').slice(0, 30000),
    targetRole: String(c.targetRole ?? '').slice(0, 120),
    codeLanguage: String(c.codeLanguage || 'python').slice(0, 30),
    focusAreas: Array.isArray(c.focusAreas) ? c.focusAreas.filter((t) => WEAKNESS_TAGS.some((w) => w.id === t)).slice(0, 4) : [],
  };
}

// ---------------------------------------------------------------------------
// Config & health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true, hasRealKey }));

app.get(
  '/api/config',
  route(async (_req, res) => {
    await loadPricing();
    res.json({
      models: CHAT_MODELS.map((m) => ({ ...m, pricing: priceFor(m.id) ?? null })),
      voices: TTS_VOICES,
      hasRealKey,
    });
  }),
);

// ---------------------------------------------------------------------------
// Resume upload (PDF or text)
// ---------------------------------------------------------------------------

app.post(
  '/api/resume',
  upload.single('file'),
  route(async (req, res) => {
    const f = req.file;
    if (!f) throw new HttpError(400, 'No file uploaded');
    let text = '';
    const isPdf = f.mimetype === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      const { extractText, getDocumentProxy } = await import('unpdf');
      try {
        const pdf = await getDocumentProxy(new Uint8Array(f.buffer));
        const out = await extractText(pdf, { mergePages: true });
        text = Array.isArray(out.text) ? out.text.join('\n') : out.text;
      } catch (e) {
        throw new HttpError(400, `Couldn't read that PDF: ${(e as Error).message}`);
      }
    } else {
      text = f.buffer.toString('utf8');
    }
    text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new HttpError(400, 'No text found in that file. If it is a scanned PDF, paste the text instead.');
    res.json({ text: text.slice(0, 30000) });
  }),
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

app.post(
  '/api/sessions',
  route((req, res) => {
    const config = sanitizeConfig(req.body?.config ?? {});
    if (config.type === 'role-specific' && !config.jobDescription.trim() && !config.targetRole.trim())
      throw new HttpError(400, 'Role-specific interviews need a job description or at least a target role.');
    res.json(db.getSessionDetail(db.createSession(config).id));
  }),
);

app.get('/api/sessions', (_req, res) => {
  res.json(
    db.listSessions().map((s) => ({
      ...s,
      config: { ...s.config, jobDescription: s.config.jobDescription ? '[…]' : '', resume: s.config.resume ? '[…]' : '' },
      scorecard: s.scorecard ? { overall_score: s.scorecard.overall_score, hire_signal: s.scorecard.hire_signal } : null,
    })),
  );
});

app.get('/api/sessions/:id', (req, res) => {
  const s = db.getSessionDetail(pid(req));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json(s);
});

app.patch(
  '/api/sessions/:id',
  route((req, res) => {
    const s = mustSession(pid(req));
    const { code, notes, elapsedSec, config } = req.body ?? {};
    db.updateSession(s.id, {
      code: typeof code === 'string' ? code : undefined,
      notes: typeof notes === 'string' ? notes : undefined,
      elapsedSec: typeof elapsedSec === 'number' ? elapsedSec : undefined,
      // Only a few settings can change mid-session.
      config: config ? sanitizeConfig({ ...s.config, model: config.model ?? s.config.model, voice: config.voice ?? s.config.voice, codeLanguage: config.codeLanguage ?? s.config.codeLanguage }) : undefined,
    });
    res.json({ ok: true });
  }),
);

app.delete('/api/sessions/:id', (req, res) => {
  db.deleteSession(pid(req));
  res.json({ ok: true });
});

app.post(
  '/api/sessions/:id/messages',
  route((req, res) => {
    const s = mustSession(pid(req));
    const { text, code, notes, timedOut } = req.body ?? {};
    const content = String(text ?? '').slice(0, 20000);
    const meta: Message['meta'] = {};
    if (typeof code === 'string') {
      meta.code = code.slice(0, 50000);
      meta.codeLanguage = s.config.codeLanguage;
    }
    if (typeof notes === 'string') meta.notes = notes.slice(0, 30000);
    if (timedOut) meta.timedOut = true;
    if (!content.trim() && !timedOut) throw new HttpError(400, 'Empty answer');
    const m = db.addMessage(s.id, 'candidate', content, meta);
    db.updateSession(s.id, { code: meta.code, notes: meta.notes });
    res.json(m);
  }),
);

// Interviewer turn, streamed as server-sent events.
const inFlight = new Set<string>();
app.post(
  '/api/sessions/:id/respond',
  route(async (req, res) => {
    const s = mustSession(pid(req));
    const { event, elapsedSec } = req.body ?? {};
    if (inFlight.has(s.id)) throw new HttpError(409, 'The interviewer is already responding.');
    if (typeof elapsedSec === 'number') db.updateSession(s.id, { elapsedSec });
    const elapsed = typeof elapsedSec === 'number' ? elapsedSec : s.elapsedSec;

    if (event && ['start', 'skip', 'timeout', 'wrapup', 'resume'].includes(event)) {
      const msgs = db.getMessages(s.id);
      if (!(event === 'start' && msgs.length)) db.addMessage(s.id, 'event', '', { event });
    }

    inFlight.add(s.id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let partial = '';
    const persona = personaById(s.config.persona);
    try {
      await loadPricing();
      const messages = buildInterviewerMessages(s.config, db.getMessages(s.id), elapsed);
      const result = await streamChat({
        model: s.config.model,
        messages,
        maxTokens: 1500,
        signal: abort.signal,
        onDelta: (t) => {
          partial += t;
          send({ type: 'delta', text: t });
        },
        onFallback: (from, to, reason) =>
          send({ type: 'notice', text: `${from} is unavailable (${reason}). Switched to ${to}.` }),
      });
      const msg = db.addMessage(s.id, 'interviewer', cleanInterviewerText(result.text, persona.name), { model: result.model });
      const usage = db.addUsage(s.id, (u) => {
        u.chat.inputTokens += result.usage.inputTokens;
        u.chat.outputTokens += result.usage.outputTokens;
        u.chat.cost += chatCost(result.model, result.usage.inputTokens, result.usage.outputTokens);
        u.chat.calls += 1;
      });
      send({ type: 'done', message: msg, usage });
    } catch (e) {
      if (abort.signal.aborted) {
        // The candidate interrupted (pause/end). Keep what was already said.
        if (partial.trim()) db.addMessage(s.id, 'interviewer', cleanInterviewerText(partial, persona.name) + ' …', { model: s.config.model });
      } else {
        const err = e as ApiError;
        console.error('[respond]', err.message);
        send({ type: 'error', error: friendlyError(err) });
      }
    } finally {
      inFlight.delete(s.id);
      res.end();
    }
  }),
);

function friendlyError(e: Error & { status?: number }) {
  if (e.status === 0) return `Couldn't reach the Hopscotch API. Check your network connection. (${e.message})`;
  if (e.status === 401 || e.status === 403) return 'The Hopscotch API rejected the credentials. Set HOPSCOTCH_API_KEY and restart the server.';
  if (e.status === 429) return 'Rate limited by the API. Wait a moment and try again.';
  return e.message || 'Something went wrong talking to the model.';
}

function precedingQuestion(messages: Message[], idx: number) {
  for (let i = idx - 1; i >= 0; i--) if (messages[i].role === 'interviewer') return messages[i].content;
  return '';
}

app.post(
  '/api/sessions/:id/feedback',
  route(async (req, res) => {
    const s = mustSession(pid(req));
    const messageId = Number(req.body?.messageId);
    const messages = db.getMessages(s.id);
    const i = messages.findIndex((m) => m.id === messageId);
    if (i < 0 || messages[i].role !== 'candidate') throw new HttpError(404, 'Answer not found');
    const answer = messages[i];
    const question = precedingQuestion(messages, i);
    const context = transcriptText(s.config, messages.slice(Math.max(0, i - 8), i));
    await loadPricing();
    const out = await structuredChat<Omit<AnswerFeedback, 'id' | 'sessionId' | 'messageId' | 'question' | 'createdAt' | 'retried'>>({
      model: s.config.model,
      messages: answerFeedbackMessages(s.config, context, question, answer.content, answer.meta.code),
      schemaName: 'answer_feedback',
      schema: ANSWER_FEEDBACK_SCHEMA,
      maxTokens: 1200,
    });
    db.addUsage(s.id, (u) => {
      u.chat.inputTokens += out.usage.inputTokens;
      u.chat.outputTokens += out.usage.outputTokens;
      u.chat.cost += chatCost(out.model, out.usage.inputTokens, out.usage.outputTokens);
      u.chat.calls += 1;
    });
    const d = out.data;
    const fb = db.addFeedback({
      sessionId: s.id,
      messageId,
      question,
      score: clamp(Math.round(d.score), 1, 5),
      summary: d.summary,
      tips: d.tips.slice(0, 3),
      star: d.star,
      tags: d.tags.slice(0, 3),
    });
    res.json({ feedback: fb, usage: db.getSession(s.id)!.usage });
  }),
);

app.post(
  '/api/sessions/:id/retry',
  route((req, res) => {
    const s = mustSession(pid(req));
    if (inFlight.has(s.id)) throw new HttpError(409, 'Wait for the interviewer to finish first.');
    const messageId = Number(req.body?.messageId);
    const m = db.getMessage(messageId);
    if (!m || m.sessionId !== s.id || m.role !== 'candidate') throw new HttpError(404, 'Answer not found');
    db.markFeedbackRetried(s.id, messageId);
    db.truncateFrom(s.id, m.idx);
    res.json(db.getSessionDetail(s.id));
  }),
);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

async function gradeSession(id: string) {
  const s = mustSession(id);
  const messages = db.getMessages(id);
  const answered = messages.filter((m) => m.role === 'candidate' && m.content.trim());
  if (!answered.length) {
    db.updateSession(id, { status: 'completed', endedAt: s.endedAt ?? new Date().toISOString() });
    return;
  }
  db.updateSession(id, { status: 'grading' });
  try {
    await loadPricing();
    const out = await structuredChat<Scorecard>({
      model: s.config.model,
      messages: scorecardMessages(s.config, transcriptText(s.config, messages, { includeCode: true }), s.code, s.notes),
      schemaName: 'interview_scorecard',
      schema: SCORECARD_SCHEMA,
      maxTokens: 9000,
    });
    const sc = out.data;
    sc.overall_score = clamp(Math.round(sc.overall_score), 0, 100);
    for (const c of CATEGORIES) sc.categories[c.id].score = clamp(Math.round(sc.categories[c.id].score), 1, 5);
    sc.questions.forEach((q) => (q.score = clamp(Math.round(q.score), 1, 5)));
    sc.next_steps = sc.next_steps.slice(0, 3);
    db.addUsage(id, (u) => {
      u.chat.inputTokens += out.usage.inputTokens;
      u.chat.outputTokens += out.usage.outputTokens;
      u.chat.cost += chatCost(out.model, out.usage.inputTokens, out.usage.outputTokens);
      u.chat.calls += 1;
    });
    db.updateSession(id, { status: 'completed', scorecard: sc, overallScore: sc.overall_score, endedAt: s.endedAt ?? new Date().toISOString() });
  } catch (e) {
    // Leave it completed without a scorecard; the report page offers "Generate scorecard" again.
    db.updateSession(id, { status: 'completed', endedAt: s.endedAt ?? new Date().toISOString() });
    throw e;
  }
}

app.post(
  '/api/sessions/:id/end',
  route(async (req, res) => {
    const s = mustSession(pid(req));
    const { elapsedSec, code, notes } = req.body ?? {};
    db.updateSession(s.id, {
      elapsedSec: typeof elapsedSec === 'number' ? elapsedSec : undefined,
      code: typeof code === 'string' ? code : undefined,
      notes: typeof notes === 'string' ? notes : undefined,
      endedAt: new Date().toISOString(),
    });
    try {
      await gradeSession(s.id);
    } catch (e) {
      return res.status(502).json({ error: `The interview was saved, but the scorecard failed: ${friendlyError(e as ApiError)}`, session: db.getSessionDetail(s.id) });
    }
    res.json(db.getSessionDetail(s.id));
  }),
);

app.post(
  '/api/sessions/:id/regrade',
  route(async (req, res) => {
    const s = mustSession(pid(req));
    try {
      await gradeSession(s.id);
    } catch (e) {
      return res.status(502).json({ error: `Scorecard failed: ${friendlyError(e as ApiError)}` });
    }
    res.json(db.getSessionDetail(s.id));
  }),
);

app.get('/api/sessions/:id/export.md', (req, res) => {
  const s = db.getSessionDetail(pid(req));
  if (!s) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="interview-${s.createdAt.slice(0, 10)}-${s.id.slice(0, 8)}.md"`);
  res.send(toMarkdown(s));
});

function toMarkdown(s: NonNullable<ReturnType<typeof db.getSessionDetail>>) {
  const c = s.config;
  const p = personaById(c.persona);
  const L: string[] = [];
  L.push(`# ${s.title}`, '');
  L.push(`- **Date:** ${new Date(s.createdAt).toLocaleString()}`);
  L.push(`- **Type:** ${typeLabel(c.type)} · **Level:** ${c.difficulty} · **Interviewer:** ${p.name} (${p.label})`);
  L.push(`- **Duration:** ${Math.round(s.elapsedSec / 60)} of ${c.lengthMin} min · **Approx. cost:** $${s.usage.total.toFixed(3)}`, '');
  const sc = s.scorecard;
  if (sc) {
    L.push(`## Scorecard: ${sc.overall_score}/100 (${sc.hire_signal.replace('-', ' ')})`, '', sc.summary, '');
    L.push('| Category | Score | Comment |', '|---|---|---|');
    for (const cat of CATEGORIES) L.push(`| ${cat.label} | ${sc.categories[cat.id].score}/5 | ${sc.categories[cat.id].comment.replace(/\|/g, '\\|')} |`);
    L.push('', '### Strengths', ...sc.strengths.map((x) => `- ${x}`), '', '### Weaknesses', ...sc.weaknesses.map((x) => `- ${x}`), '');
    if (sc.weakness_tags.length) L.push(`**Weak-spot tags:** ${sc.weakness_tags.map(tagLabel).join(', ')}`, '');
    L.push('### Top 3 things to practise next', ...sc.next_steps.map((x, i) => `${i + 1}. ${x}`), '');
    L.push('## Question by question', '');
    sc.questions.forEach((q, i) => {
      L.push(`### ${i + 1}. ${q.question} (${q.score}/5)`, '', `**Your answer:** ${q.answer_summary}`, '', `**Critique:** ${q.critique}`, '', `**Stronger answer:**`, '', ...q.improved_answer.split('\n').map((l) => `> ${l}`), '');
    });
  }
  L.push('## Transcript', '');
  const fbBy = new Map(s.feedback.filter((f) => !f.retried).map((f) => [f.messageId, f]));
  for (const m of s.messages) {
    if (m.role === 'interviewer') L.push(`**${p.name}:** ${m.content.replace(/<\/?problem>/g, '\n')}`, '');
    else if (m.role === 'candidate') {
      L.push(`**You:** ${m.content || '_(no answer)_'}`, '');
      const f = fbBy.get(m.id);
      if (f) L.push(`> _Feedback (${f.score}/5): ${f.summary}_`, ...f.tips.map((t) => `> - ${t}`), '');
    } else if (m.meta.event && m.meta.event !== 'start') L.push(`_[${m.meta.event === 'skip' ? 'Skipped question' : m.meta.event === 'timeout' ? 'Answer time ran out' : m.meta.event === 'wrapup' ? 'Time up' : m.meta.event}]_`, '');
  }
  if (s.code.trim()) L.push('## Final code', '', '```' + c.codeLanguage, s.code, '```', '');
  if (s.notes.trim()) L.push('## Notes', '', s.notes, '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

app.post(
  '/api/transcribe',
  upload.single('audio'),
  route(async (req, res) => {
    const f = req.file;
    if (!f || f.size < 200) throw new HttpError(400, 'No audio received. Try holding the mic button a little longer.');
    await loadPricing();
    const ext = f.mimetype.includes('mp4') ? 'mp4' : f.mimetype.includes('ogg') ? 'ogg' : f.mimetype.includes('wav') ? 'wav' : f.mimetype.includes('mpeg') ? 'mp3' : 'webm';
    const out = await transcribe(f.buffer, `answer.${ext}`, f.mimetype || 'audio/webm');
    const sessionId = String(req.body?.sessionId ?? '');
    const seconds = Number(req.body?.durationSec) || 0;
    const usage = sessionId
      ? db.addUsage(sessionId, (u) => {
          u.stt.seconds += seconds;
          u.stt.cost += out.cost;
          u.stt.calls += 1;
        })
      : null;
    res.json({ text: out.text, model: out.model, usage });
  }),
);

app.post(
  '/api/tts',
  route(async (req, res) => {
    const { text, sessionId, persona: personaId, voice } = req.body ?? {};
    const clean = String(text ?? '').trim().slice(0, 4000);
    if (!clean) throw new HttpError(400, 'Nothing to say');
    const persona = personaById(personaId);
    const out = await speak({
      text: clean,
      voice: TTS_VOICES.includes(voice) ? voice : persona.voice,
      fallbackVoice: persona.fallbackVoice,
      instructions: persona.voiceInstructions,
    });
    if (sessionId && db.getSession(String(sessionId)))
      db.addUsage(String(sessionId), (u) => {
        u.tts.chars += clean.length;
        u.tts.cost += out.cost;
        u.tts.calls += 1;
      });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-TTS-Model', out.model);
    res.send(out.audio);
  }),
);

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

app.get('/api/progress', (_req, res) => {
  const sessions = db.listSessions().filter((s) => s.scorecard).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const all = db.listSessions();
  const points = sessions.map((s) => ({
    id: s.id,
    date: s.createdAt,
    title: s.title,
    type: s.config.type,
    difficulty: s.config.difficulty,
    overall: s.scorecard!.overall_score,
    categories: Object.fromEntries(CATEGORIES.map((c) => [c.id, s.scorecard!.categories[c.id]?.score ?? null])),
  }));

  const byType = (['behavioral', 'coding', 'system-design', 'role-specific'] as InterviewType[])
    .map((t) => {
      const xs = points.filter((p) => p.type === t);
      return { type: t, label: typeLabel(t), count: xs.length, avg: xs.length ? xs.reduce((a, p) => a + p.overall, 0) / xs.length : null };
    })
    .filter((x) => x.count > 0);

  // Weak spots: scorecard tags count double, per-answer tags count once. "Recurring" = seen in 2+ sessions.
  const tagStats = new Map<string, { weight: number; sessions: Set<string> }>();
  const bump = (tag: string, sid: string, w: number) => {
    const t = tagStats.get(tag) ?? { weight: 0, sessions: new Set<string>() };
    t.weight += w;
    t.sessions.add(sid);
    tagStats.set(tag, t);
  };
  for (const s of sessions) for (const t of s.scorecard!.weakness_tags) bump(t, s.id, 2);
  for (const s of all) for (const f of db.getFeedback(s.id)) if (!f.retried) for (const t of f.tags) bump(t, s.id, 1);
  const weakSpots = [...tagStats.entries()]
    .map(([id, v]) => ({ id, label: tagLabel(id), hint: WEAKNESS_TAGS.find((w) => w.id === id)?.hint ?? '', weight: v.weight, sessions: v.sessions.size }))
    .sort((a, b) => b.sessions - a.sessions || b.weight - a.weight);

  const recent = points.slice(-5);
  const categoryAvg = Object.fromEntries(
    CATEGORIES.map((c) => {
      const xs = recent.map((p) => p.categories[c.id]).filter((x): x is number => x != null);
      return [c.id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null];
    }),
  );
  const prev = points.slice(-10, -5);
  const avg = (xs: { overall: number }[]) => (xs.length ? xs.reduce((a, p) => a + p.overall, 0) / xs.length : null);
  const lastType = all[0]?.config.type ?? 'behavioral';

  res.json({
    points,
    byType,
    weakSpots,
    categoryAvg,
    totals: {
      sessions: all.length,
      graded: points.length,
      minutes: Math.round(all.reduce((a, s) => a + s.elapsedSec, 0) / 60),
      cost: all.reduce((a, s) => a + s.usage.total, 0),
      recentAvg: avg(recent),
      prevAvg: avg(prev),
    },
    suggestion: {
      type: lastType,
      focusAreas: weakSpots.slice(0, 3).map((w) => w.id),
    },
  });
});

// ---------------------------------------------------------------------------
// Errors & static
// ---------------------------------------------------------------------------

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const dist = path.resolve(process.cwd(), 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err instanceof ApiError ? (err.status >= 400 && err.status < 600 ? 502 : 502) : 500;
  if (!(err instanceof HttpError)) console.error('[error]', err.message);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err instanceof HttpError ? err.message : friendlyError(err) });
});

app.listen(PORT, () => {
  console.log(`Interview Partner API listening on http://localhost:${PORT}`);
  console.log(hasRealKey ? 'Using HOPSCOTCH_API_KEY from the environment.' : 'No HOPSCOTCH_API_KEY set; using a placeholder (works where a proxy injects credentials).');
  loadPricing().then((p) => console.log(`Loaded pricing for ${Object.keys(p).length} models.`));
});
