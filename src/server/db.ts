import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  emptyUsage,
  typeLabel,
  type AnswerFeedback,
  type Message,
  type MessageRole,
  type Scorecard,
  type Session,
  type SessionConfig,
  type SessionDetail,
  type Usage,
} from '../shared/types';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'interview-partner.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    config TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    elapsed_sec INTEGER NOT NULL DEFAULT 0,
    scorecard TEXT,
    overall_score REAL,
    usage TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, idx);
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    score INTEGER NOT NULL,
    summary TEXT NOT NULL,
    tips TEXT NOT NULL,
    star TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    retried INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feedback_session ON feedback(session_id);
`);

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

function rowToSession(r: Row): Session {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    endedAt: (r.ended_at as string) ?? null,
    status: r.status as Session['status'],
    config: JSON.parse(r.config as string),
    code: r.code as string,
    notes: r.notes as string,
    elapsedSec: Number(r.elapsed_sec),
    scorecard: r.scorecard ? JSON.parse(r.scorecard as string) : null,
    overallScore: r.overall_score == null ? null : Number(r.overall_score),
    usage: { ...emptyUsage(), ...JSON.parse(r.usage as string) },
    title: r.title as string,
  };
}

function rowToMessage(r: Row): Message {
  return {
    id: Number(r.id),
    sessionId: r.session_id as string,
    idx: Number(r.idx),
    role: r.role as MessageRole,
    content: r.content as string,
    createdAt: r.created_at as string,
    meta: JSON.parse(r.meta as string),
  };
}

function rowToFeedback(r: Row): AnswerFeedback {
  return {
    id: Number(r.id),
    sessionId: r.session_id as string,
    messageId: Number(r.message_id),
    question: r.question as string,
    score: Number(r.score),
    summary: r.summary as string,
    tips: JSON.parse(r.tips as string),
    star: JSON.parse(r.star as string),
    tags: JSON.parse(r.tags as string),
    retried: Boolean(r.retried),
    createdAt: r.created_at as string,
  };
}

function makeTitle(c: SessionConfig) {
  const role = c.targetRole.trim() || (c.type === 'role-specific' ? firstLine(c.jobDescription) : '');
  return role ? `${typeLabel(c.type)}: ${role}` : typeLabel(c.type);
}
function firstLine(s: string) {
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 60 ? line.slice(0, 57) + '…' : line;
}

export function createSession(config: SessionConfig): Session {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, created_at, status, config, usage, title) VALUES (?, ?, 'active', ?, ?, ?)`,
  ).run(id, now(), JSON.stringify(config), JSON.stringify(emptyUsage()), makeTitle(config));
  return getSession(id)!;
}

export function getSession(id: string): Session | null {
  const r = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowToSession(r) : null;
}

export function getSessionDetail(id: string): SessionDetail | null {
  const s = getSession(id);
  if (!s) return null;
  return { ...s, messages: getMessages(id), feedback: getFeedback(id) };
}

export function listSessions(): Session[] {
  return (db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC`).all() as Row[]).map(rowToSession);
}

export function deleteSession(id: string) {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function updateSession(
  id: string,
  patch: Partial<{ code: string; notes: string; elapsedSec: number; status: Session['status']; endedAt: string; scorecard: Scorecard; overallScore: number; config: SessionConfig }>,
) {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.code !== undefined) (cols.push('code = ?'), vals.push(patch.code));
  if (patch.notes !== undefined) (cols.push('notes = ?'), vals.push(patch.notes));
  if (patch.elapsedSec !== undefined) (cols.push('elapsed_sec = ?'), vals.push(Math.round(patch.elapsedSec)));
  if (patch.status !== undefined) (cols.push('status = ?'), vals.push(patch.status));
  if (patch.endedAt !== undefined) (cols.push('ended_at = ?'), vals.push(patch.endedAt));
  if (patch.scorecard !== undefined) (cols.push('scorecard = ?'), vals.push(JSON.stringify(patch.scorecard)));
  if (patch.overallScore !== undefined) (cols.push('overall_score = ?'), vals.push(patch.overallScore));
  if (patch.config !== undefined) (cols.push('config = ?'), vals.push(JSON.stringify(patch.config)));
  if (!cols.length) return;
  vals.push(id);
  db.prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
}

export function addUsage(id: string, fn: (u: Usage) => void) {
  const s = getSession(id);
  if (!s) return null;
  const u = s.usage;
  fn(u);
  u.total = u.chat.cost + u.stt.cost + u.tts.cost;
  db.prepare(`UPDATE sessions SET usage = ? WHERE id = ?`).run(JSON.stringify(u), id);
  return u;
}

export function getMessages(sessionId: string): Message[] {
  return (db.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY idx`).all(sessionId) as Row[]).map(rowToMessage);
}

export function getMessage(id: number): Message | null {
  const r = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowToMessage(r) : null;
}

export function addMessage(sessionId: string, role: MessageRole, content: string, meta: Message['meta'] = {}): Message {
  const next = db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM messages WHERE session_id = ?`).get(sessionId) as { n: number };
  const res = db
    .prepare(`INSERT INTO messages (session_id, idx, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sessionId, next.n, role, content, now(), JSON.stringify(meta));
  return getMessage(Number(res.lastInsertRowid))!;
}

/** Remove a message and everything after it (used by "Retry this answer"). */
export function truncateFrom(sessionId: string, idx: number) {
  db.prepare(`DELETE FROM messages WHERE session_id = ? AND idx >= ?`).run(sessionId, idx);
}

export function getFeedback(sessionId: string): AnswerFeedback[] {
  return (db.prepare(`SELECT * FROM feedback WHERE session_id = ? ORDER BY id`).all(sessionId) as Row[]).map(rowToFeedback);
}

export function addFeedback(f: Omit<AnswerFeedback, 'id' | 'createdAt' | 'retried'>): AnswerFeedback {
  // A fresh grade for the same message replaces the old one.
  db.prepare(`DELETE FROM feedback WHERE session_id = ? AND message_id = ? AND retried = 0`).run(f.sessionId, f.messageId);
  const res = db
    .prepare(
      `INSERT INTO feedback (session_id, message_id, question, score, summary, tips, star, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(f.sessionId, f.messageId, f.question, f.score, f.summary, JSON.stringify(f.tips), JSON.stringify(f.star), JSON.stringify(f.tags), now());
  const r = db.prepare(`SELECT * FROM feedback WHERE id = ?`).get(Number(res.lastInsertRowid)) as Row;
  return rowToFeedback(r);
}

export function markFeedbackRetried(sessionId: string, messageId: number) {
  db.prepare(`UPDATE feedback SET retried = 1 WHERE session_id = ? AND message_id = ?`).run(sessionId, messageId);
}
