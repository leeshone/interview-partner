import type { PersonaId } from '../../shared/types';

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export interface ContentPart {
  kind: 'text' | 'problem';
  text: string;
}

/** Split interviewer output into spoken text and written <problem> blocks. */
export function parseContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  // An unclosed <problem> (while streaming) runs to the end of the text.
  const re = /<problem>([\s\S]*?)(?:<\/problem>|$)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m.index > last) parts.push({ kind: 'text', text: content.slice(last, m.index) });
    parts.push({ kind: 'problem', text: m[1].replace(/<\/[a-z]*$/i, '').trim() });
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push({ kind: 'text', text: content.slice(last) });
  return parts
    .map((p) => (p.kind === 'text' ? { ...p, text: p.text.replace(/<\/?[a-z]*$/i, '').trim() } : p))
    .filter((p) => p.text);
}

export function speakableText(content: string) {
  return content
    .replace(/<problem>[\s\S]*?(<\/problem>|$)/gi, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[*_#`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function latestProblem(contents: string[]): string | null {
  for (let i = contents.length - 1; i >= 0; i--) {
    const p = parseContent(contents[i]).filter((x) => x.kind === 'problem');
    if (p.length) return p[p.length - 1].text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Speaker: streams text in, speaks it sentence by sentence via /api/tts
// ---------------------------------------------------------------------------

type Listener = (speaking: boolean) => void;

interface Segment {
  text: string;
  audio: Promise<Blob | null>;
}

export class Speaker {
  private el = new Audio();
  private gen = 0;
  private queue: Segment[] = [];
  private playing = false;
  private listeners = new Set<Listener>();
  private cache = new Map<string, Blob[]>();
  muted = false;
  onError?: (msg: string) => void;

  constructor(private opts: { persona: () => PersonaId; voice: () => string; sessionId: () => string | undefined }) {
    this.el.preload = 'auto';
  }

  get speaking() {
    return this.playing;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setPlaying(v: boolean) {
    if (this.playing === v) return;
    this.playing = v;
    this.listeners.forEach((l) => l(v));
  }

  /** Browsers only allow audio after a user gesture; call this from a click handler. */
  unlock() {
    try {
      this.el.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
      const p = this.el.play();
      if (p) p.catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  private fetchAudio(text: string): Promise<Blob | null> {
    return fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, persona: this.opts.persona(), voice: this.opts.voice(), sessionId: this.opts.sessionId() }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `TTS failed (${r.status})`);
        return r.blob();
      })
      .catch((e: Error) => {
        this.onError?.(`Voice playback failed: ${e.message}`);
        return null;
      });
  }

  /** Begin a streamed utterance. Push raw interviewer text deltas into it. */
  begin(key: string) {
    const myGen = ++this.gen;
    let cacheKey = key;
    let raw = '';
    let spokenUpTo = 0; // index into the speakable string
    const blobs: Blob[] = [];
    const segs: Segment[] = [];
    const enqueue = (text: string) => {
      text = text.trim();
      if (!text || this.muted || myGen !== this.gen) return;
      const seg: Segment = { text, audio: this.fetchAudio(text) };
      seg.audio.then((b) => b && blobs.push(b));
      segs.push(seg);
      this.queue.push(seg);
      void this.pump(myGen);
    };
    const flush = (final: boolean) => {
      // Hold back anything from an unclosed <problem> tag (or a partial "<pro").
      let safe = raw;
      const open = safe.search(/<problem>(?![\s\S]*<\/problem>)/i);
      if (open >= 0) safe = safe.slice(0, open);
      if (!final) safe = safe.replace(/<[a-z/]*$/i, '');
      const speak = speakableText(safe);
      let pending = speak.slice(spokenUpTo);
      if (final) {
        spokenUpTo = speak.length;
        enqueue(pending);
        return;
      }
      // Emit whole sentences, in chunks of a reasonable size to keep requests few.
      const re = /[.!?…](?=\s)/g;
      let cut = -1;
      let m: RegExpExecArray | null;
      while ((m = re.exec(pending))) {
        if (m.index + 1 >= (segs.length === 0 ? 30 : 90)) {
          cut = m.index + 1;
          break;
        }
      }
      if (cut > 0) {
        enqueue(pending.slice(0, cut));
        spokenUpTo += cut;
        pending = pending.slice(cut);
        flush(false);
      }
    };
    return {
      push: (delta: string) => {
        if (myGen !== this.gen) return;
        raw += delta;
        flush(false);
      },
      end: () => {
        if (myGen !== this.gen) return;
        flush(true);
        Promise.all(segs.map((s) => s.audio)).then(() => blobs.length && this.cache.set(cacheKey, blobs.slice()));
      },
      /** Re-key the cached audio (e.g. once the message has its database id). */
      setKey: (k: string) => {
        cacheKey = k;
      },
    };
  }

  private async pump(myGen: number) {
    if (this.playing) return;
    while (this.queue.length && myGen === this.gen) {
      this.setPlaying(true);
      const seg = this.queue.shift()!;
      const blob = await seg.audio;
      if (!blob || myGen !== this.gen) continue;
      await this.playBlob(blob, myGen);
    }
    if (myGen === this.gen) this.setPlaying(false);
  }

  private playBlob(blob: Blob, myGen: number) {
    return new Promise<void>((resolve) => {
      if (myGen !== this.gen) return resolve();
      const url = URL.createObjectURL(blob);
      const done = () => {
        URL.revokeObjectURL(url);
        this.el.onended = this.el.onerror = this.el.onpause = null;
        resolve();
      };
      this.el.onended = done;
      this.el.onerror = done;
      this.el.onpause = () => {
        if (!this.el.ended) done();
      };
      this.el.src = url;
      this.el.play().catch(() => {
        this.onError?.('Your browser blocked audio playback. Click anywhere on the page, then press Replay.');
        done();
      });
    });
  }

  /** Speak a full message again (uses cached audio when available). */
  replay(key: string, content: string) {
    this.stop();
    const myGen = this.gen;
    const cached = this.cache.get(key);
    if (cached?.length) {
      for (const b of cached) this.queue.push({ text: '', audio: Promise.resolve(b) });
      void this.pump(myGen);
      return;
    }
    const wasMuted = this.muted;
    this.muted = false;
    const h = this.begin(key);
    h.push(content);
    h.end();
    this.muted = wasMuted;
  }

  stop() {
    this.gen++;
    this.queue = [];
    try {
      this.el.pause();
    } catch {
      /* ignore */
    }
    this.setPlaying(false);
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export class MicError extends Error {}

export class Recorder {
  private rec?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private analyser?: AnalyserNode;
  private ctx?: AudioContext;

  static supported() {
    return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }

  async start() {
    if (!Recorder.supported()) throw new MicError('This browser can’t record audio. Use the text box instead.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' || name === 'SecurityError')
        throw new MicError('Microphone access was blocked. Allow the mic for this site in your browser settings (the icon in the address bar), or type your answer.');
      if (name === 'NotFoundError') throw new MicError('No microphone found. Plug one in or type your answer.');
      throw new MicError(`Couldn’t start the microphone: ${(e as Error).message}`);
    }
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.startedAt = performance.now();
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
    } catch {
      /* level meter is optional */
    }
  }

  /** 0..1 input level for a simple meter. */
  level() {
    if (!this.analyser) return 0;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  stop(): Promise<{ blob: Blob; durationSec: number }> {
    return new Promise((resolve) => {
      const rec = this.rec;
      const finish = () => {
        const blob = new Blob(this.chunks, { type: rec?.mimeType || 'audio/webm' });
        const durationSec = (performance.now() - this.startedAt) / 1000;
        this.stream?.getTracks().forEach((t) => t.stop());
        this.ctx?.close().catch(() => undefined);
        this.rec = undefined;
        resolve({ blob, durationSec });
      };
      if (!rec || rec.state === 'inactive') return finish();
      rec.onstop = finish;
      rec.stop();
    });
  }

  cancel() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => undefined);
    this.rec = undefined;
  }
}
