import type { AnswerFeedback, Message, Session, SessionConfig, SessionDetail, Usage } from '../../shared/types';

export class RequestError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body instanceof FormData || body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError('Can’t reach the Interview Partner server. Is it running?', 0);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error || `${res.status} ${res.statusText}`;
    throw new RequestError(msg, res.status, data);
  }
  return data as T;
}

export interface ModelInfo {
  id: string;
  label: string;
  pricing: { input: number; output: number } | null;
}

export interface ProgressData {
  points: { id: string; date: string; title: string; type: string; difficulty: string; overall: number; categories: Record<string, number | null> }[];
  byType: { type: string; label: string; count: number; avg: number | null }[];
  weakSpots: { id: string; label: string; hint: string; weight: number; sessions: number }[];
  categoryAvg: Record<string, number | null>;
  totals: { sessions: number; graded: number; minutes: number; cost: number; recentAvg: number | null; prevAvg: number | null };
  suggestion: { type: SessionConfig['type']; focusAreas: string[] };
}

export const api = {
  config: () => req<{ models: ModelInfo[]; voices: string[]; hasRealKey: boolean }>('GET', '/api/config'),
  createSession: (config: SessionConfig) => req<SessionDetail>('POST', '/api/sessions', { config }),
  listSessions: () => req<Session[]>('GET', '/api/sessions'),
  getSession: (id: string) => req<SessionDetail>('GET', `/api/sessions/${id}`),
  patchSession: (id: string, patch: { code?: string; notes?: string; elapsedSec?: number; config?: Partial<SessionConfig> }) =>
    req<{ ok: true }>('PATCH', `/api/sessions/${id}`, patch),
  deleteSession: (id: string) => req<{ ok: true }>('DELETE', `/api/sessions/${id}`),
  addMessage: (id: string, body: { text: string; code?: string; notes?: string; timedOut?: boolean }) =>
    req<Message>('POST', `/api/sessions/${id}/messages`, body),
  feedback: (id: string, messageId: number) => req<{ feedback: AnswerFeedback; usage: Usage }>('POST', `/api/sessions/${id}/feedback`, { messageId }),
  retry: (id: string, messageId: number) => req<SessionDetail>('POST', `/api/sessions/${id}/retry`, { messageId }),
  end: (id: string, body: { elapsedSec: number; code?: string; notes?: string }) => req<SessionDetail>('POST', `/api/sessions/${id}/end`, body),
  regrade: (id: string) => req<SessionDetail>('POST', `/api/sessions/${id}/regrade`),
  progress: () => req<ProgressData>('GET', '/api/progress'),
  uploadResume: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ text: string }>('POST', '/api/resume', fd);
  },
  transcribe: (audio: Blob, sessionId: string, durationSec: number) => {
    const fd = new FormData();
    const ext = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm';
    fd.append('audio', audio, `answer.${ext}`);
    fd.append('sessionId', sessionId);
    fd.append('durationSec', String(durationSec));
    return req<{ text: string; usage: Usage | null }>('POST', '/api/transcribe', fd);
  },
};

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done'; message: Message; usage: Usage };

/** POST that returns server-sent events. */
export async function streamRespond(
  sessionId: string,
  body: { event?: string; elapsedSec: number },
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
) {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    throw new RequestError('Can’t reach the Interview Partner server. Is it running?', 0);
  }
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new RequestError(msg, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data:')) {
            try {
              onEvent(JSON.parse(line.slice(5).trim()));
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    throw e;
  }
}
