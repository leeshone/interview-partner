import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { personaById, typeLabel, type Message, type SessionDetail } from '../../shared/types';
import { Modal, useApp } from '../App';
import { api, RequestError, streamRespond } from '../lib/api';
import { latestProblem, MicError, parseContent, Recorder, Speaker } from '../lib/audio';
import { FeedbackCard, Rich } from '../components/Rich';
import { Workspace, type WorkspaceTab } from '../components/Workspace';
import { Icon } from '../components/Icon';

type Phase = 'loading' | 'ready' | 'live' | 'paused';

const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(Math.abs(sec)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function useDarkMode(theme: string) {
  const [sysDark, setSysDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSysDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return theme === 'dark' || (theme === 'system' && sysDark);
}

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest?.('.monaco-editor'));
};

export function Interview() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh;
  const { settings, setSettings, toast, models } = useApp();
  const dark = useDarkMode(settings.theme);

  const [s, setS] = useState<SessionDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [streamText, setStreamText] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const [respondErr, setRespondErr] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState('');
  const [lang, setLang] = useState('python');
  const [elapsed, setElapsed] = useState(0);
  const [answerLeft, setAnswerLeft] = useState<number | null>(null);
  const [fbLoading, setFbLoading] = useState<number[]>([]);
  const [fbErrors, setFbErrors] = useState<Record<number, string>>({});
  const [awaiting, setAwaiting] = useState<number | null>(null); // coaching mode: answer awaiting "Continue"
  const [speaking, setSpeaking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [level, setLevel] = useState(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [grading, setGrading] = useState(false);
  const [sending, setSending] = useState(false);

  // Refs for use inside timers and async callbacks.
  const sRef = useRef(s);
  sRef.current = s;
  const elapsedRef = useRef(0);
  const respondingRef = useRef(false);
  const speakingRef = useRef(false);
  const codeRef = useRef(code);
  codeRef.current = code;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const abortRef = useRef<AbortController | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const pressAt = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const startedRef = useRef(false);

  const persona = s ? personaById(s.config.persona) : null;
  const voiceRef = useRef(settings.voice);
  voiceRef.current = settings.voice;
  const speaker = useMemo(
    () =>
      new Speaker({
        persona: () => sRef.current?.config.persona ?? 'friendly-recruiter',
        voice: () => voiceRef.current,
        sessionId: () => sRef.current?.id,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  speaker.muted = !settings.autoSpeak;

  useEffect(() => {
    speaker.onError = (m) => toast(m, 'error');
    const unsub = speaker.subscribe((v) => {
      speakingRef.current = v;
      setSpeaking(v);
    });
    return () => {
      unsub();
      speaker.stop();
      abortRef.current?.abort();
      recRef.current?.cancel();
    };
  }, [speaker, toast]);

  // ---------- Load ----------
  useEffect(() => {
    let alive = true;
    api
      .getSession(id)
      .then((d) => {
        if (!alive) return;
        if (d.status !== 'active') return navigate(`/report/${id}`, { replace: true });
        setS(d);
        setCode(d.code);
        setNotes(d.notes);
        setLang(d.config.codeLanguage);
        setElapsed(d.elapsedSec);
        elapsedRef.current = d.elapsedSec;
        setPhase('ready');
      })
      .catch((e) => alive && setLoadErr(e.message));
    return () => {
      alive = false;
    };
  }, [id, navigate]);

  const refresh = useCallback(async () => {
    const d = await api.getSession(id);
    setS(d);
    return d;
  }, [id]);

  // ---------- Interviewer turn ----------
  const respond = useCallback(
    async (event?: 'start' | 'skip' | 'timeout' | 'wrapup' | 'resume') => {
      if (respondingRef.current || !sRef.current) return;
      respondingRef.current = true;
      setResponding(true);
      setRespondErr(null);
      setStreamText('');
      setAnswerLeft(null);
      const handle = speaker.begin(`pending-${Date.now()}`);
      const ac = new AbortController();
      abortRef.current = ac;
      let doneMsg: Message | null = null;
      try {
        await streamRespond(
          id,
          { event, elapsedSec: elapsedRef.current },
          (e) => {
            if (e.type === 'delta') {
              setStreamText((t) => (t ?? '') + e.text);
              handle.push(e.text);
            } else if (e.type === 'notice') toast(e.text);
            else if (e.type === 'error') setRespondErr(e.error);
            else if (e.type === 'done') {
              doneMsg = e.message;
              handle.setKey(String(e.message.id));
            }
          },
          ac.signal,
        );
      } catch (e) {
        if (!ac.signal.aborted) setRespondErr((e as Error).message);
      } finally {
        handle.end();
        respondingRef.current = false;
        setResponding(false);
        abortRef.current = null;
        try {
          await refresh();
        } catch {
          /* keep local state */
        }
        setStreamText(null);
        const cfg = sRef.current?.config;
        if (doneMsg && cfg?.answerTimerSec && event !== 'wrapup') setAnswerLeft(cfg.answerTimerSec);
      }
    },
    [id, refresh, speaker, toast],
  );

  const begin = useCallback(() => {
    if (!sRef.current || startedRef.current) return;
    startedRef.current = true;
    speaker.unlock();
    setPhase('live');
    const msgs = sRef.current.messages;
    const last = msgs[msgs.length - 1];
    if (!msgs.length) void respond('start');
    else if (last.role !== 'interviewer') {
      if (last.role === 'candidate' && sRef.current.config.feedbackMode === 'every-answer' && !sRef.current.feedback.some((f) => f.messageId === last.id))
        setAwaiting(last.id);
      else void respond();
    } else if (sRef.current.config.answerTimerSec) setAnswerLeft(sRef.current.config.answerTimerSec);
  }, [respond, speaker]);

  // Fresh sessions start straight away (the "Start interview" click counts as the user gesture for audio).
  useEffect(() => {
    if (phase === 'ready' && fresh && s && !s.messages.length) begin();
  }, [phase, fresh, s, begin]);

  // ---------- Clock ----------
  const tickRef = useRef<() => void>(() => undefined);
  tickRef.current = () => {
    elapsedRef.current += 1;
    setElapsed(elapsedRef.current);
    if (answerLeft !== null && !respondingRef.current && !speakingRef.current && awaiting === null) setAnswerLeft((a) => (a === null ? a : a - 1));
  };
  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => tickRef.current(), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Periodic save of the clock.
  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => api.patchSession(id, { elapsedSec: elapsedRef.current }).catch(() => undefined), 15000);
    return () => clearInterval(t);
  }, [phase, id]);

  // Autosave code and notes.
  useEffect(() => {
    if (!s) return;
    const t = setTimeout(() => api.patchSession(id, { code, notes }).catch(() => undefined), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, notes, id]);

  // Model change in settings applies to the live session.
  useEffect(() => {
    if (!s || s.config.model === settings.model) return;
    api.patchSession(id, { config: { model: settings.model } }).then(() => setS((x) => (x ? { ...x, config: { ...x.config, model: settings.model } } : x)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.model, id, s?.config.model]);

  const totalSec = (s?.config.lengthMin ?? 30) * 60;
  const remaining = totalSec - elapsed;
  const wrapupDone = !!s?.messages.some((m) => m.meta.event === 'wrapup');

  // Time's up: the interviewer wraps up.
  useEffect(() => {
    if (phase === 'live' && remaining <= 0 && !wrapupDone && !responding && awaiting === null && !recording) void respond('wrapup');
  }, [phase, remaining, wrapupDone, responding, awaiting, recording, respond]);

  // ---------- Candidate answers ----------
  const getFeedback = useCallback(
    async (mid: number) => {
      setFbLoading((x) => [...x, mid]);
      setFbErrors((x) => {
        const { [mid]: _, ...rest } = x;
        return rest;
      });
      try {
        const { feedback, usage } = await api.feedback(id, mid);
        setS((x) => (x ? { ...x, usage, feedback: [...x.feedback.filter((f) => f.messageId !== mid || f.retried), feedback] } : x));
      } catch (e) {
        setFbErrors((x) => ({ ...x, [mid]: (e as Error).message }));
      } finally {
        setFbLoading((x) => x.filter((y) => y !== mid));
      }
    },
    [id],
  );

  const shareCode = s ? s.config.type === 'coding' || s.config.type === 'role-specific' : false;
  const shareNotes = s ? s.config.type !== 'behavioral' : false;

  const submit = useCallback(
    async (text: string, timedOut = false) => {
      const cur = sRef.current;
      if (!cur || respondingRef.current) return;
      const t = text.trim();
      if (!t && !timedOut) return;
      speaker.stop();
      setAnswerLeft(null);
      setSending(true);
      let m: Message;
      try {
        m = await api.addMessage(id, {
          text: t,
          timedOut,
          code: shareCode ? codeRef.current : undefined,
          notes: shareNotes ? notesRef.current : undefined,
        });
      } catch (e) {
        toast(`Couldn’t send your answer: ${(e as Error).message}`, 'error');
        setSending(false);
        return;
      }
      setSending(false);
      setDraft('');
      setS((x) => (x ? { ...x, messages: [...x.messages, m] } : x));
      const mode = cur.config.feedbackMode;
      if (mode === 'end-only' || !t) void respond();
      else if (mode === 'both') {
        void getFeedback(m.id);
        void respond();
      } else {
        setAwaiting(m.id);
        void getFeedback(m.id);
      }
    },
    [getFeedback, id, respond, shareCode, shareNotes, speaker, toast],
  );

  const continueInterview = () => {
    setAwaiting(null);
    void respond();
  };

  const retryAnswer = async (mid: number) => {
    if (respondingRef.current) return;
    speaker.stop();
    const old = sRef.current?.messages.find((m) => m.id === mid)?.content ?? '';
    try {
      const d = await api.retry(id, mid);
      setS(d);
      setAwaiting(null);
      setDraft(old);
      if (d.config.answerTimerSec) setAnswerLeft(d.config.answerTimerSec);
      toast('Have another go. Your previous answer is in the box to edit.');
      setTimeout(() => taRef.current?.focus(), 50);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // ---------- Voice input ----------
  const levelLoop = useRef(0);
  const startRec = useCallback(async () => {
    if (recRef.current || respondingRef.current) return;
    speaker.stop(); // barge in
    const r = new Recorder();
    recRef.current = r;
    try {
      await r.start();
    } catch (e) {
      recRef.current = null;
      toast(e instanceof MicError ? e.message : (e as Error).message, 'error');
      return;
    }
    setRecording(true);
    const loop = () => {
      setLevel(r.level());
      levelLoop.current = requestAnimationFrame(loop);
    };
    loop();
  }, [speaker, toast]);

  const stopRec = useCallback(
    async (thenSubmitTimedOut = false) => {
      const r = recRef.current;
      if (!r) return;
      recRef.current = null;
      cancelAnimationFrame(levelLoop.current);
      setLevel(0);
      const { blob, durationSec } = await r.stop();
      setRecording(false);
      if (durationSec < 0.6 || blob.size < 1500) {
        if (thenSubmitTimedOut) void submit(draftRef.current, true);
        else toast('That was too short to transcribe. Hold the mic button (or Space) while you talk, or click once to start and again to stop.');
        return;
      }
      setTranscribing(true);
      try {
        const { text, usage } = await api.transcribe(blob, id, durationSec);
        if (usage) setS((x) => (x ? { ...x, usage } : x));
        const next = [draftRef.current.trim(), text].filter(Boolean).join(' ');
        setDraft(next);
        if (thenSubmitTimedOut) void submit(next, true);
        else setTimeout(() => taRef.current?.focus(), 30);
        if (!text) toast('No speech detected. Check your microphone.');
      } catch (e) {
        toast(`Transcription failed: ${(e as Error).message}`, 'error');
        if (thenSubmitTimedOut) void submit(draftRef.current, true);
      } finally {
        setTranscribing(false);
      }
    },
    [id, submit, toast],
  );

  const onMicDown = async () => {
    if (recRef.current) return stopRec();
    pressAt.current = performance.now();
    await startRec();
  };
  const onMicUp = () => {
    if (recRef.current && performance.now() - pressAt.current > 450) void stopRec();
  };

  // Hold Space to talk (when not typing).
  useEffect(() => {
    if (phase !== 'live') return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target) || awaiting !== null) return;
      e.preventDefault();
      pressAt.current = 0;
      void startRec();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      if (recRef.current) {
        e.preventDefault();
        void stopRec();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [phase, startRec, stopRec, awaiting]);

  // ---------- Answer timer runs out ----------
  useEffect(() => {
    if (answerLeft === null || answerLeft > 0 || phase !== 'live') return;
    setAnswerLeft(null);
    if (recRef.current) void stopRec(true);
    else if (draftRef.current.trim()) void submit(draftRef.current, true);
    else void respond('timeout');
  }, [answerLeft, phase, respond, stopRec, submit]);

  // ---------- Controls ----------
  const pause = () => {
    setPhase('paused');
    speaker.stop();
    if (recRef.current) {
      recRef.current.cancel();
      recRef.current = null;
      cancelAnimationFrame(levelLoop.current);
      setRecording(false);
    }
    api.patchSession(id, { elapsedSec: elapsedRef.current }).catch(() => undefined);
  };
  const skip = () => {
    if (respondingRef.current) return;
    speaker.stop();
    setAwaiting(null);
    void respond('skip');
  };
  const endInterview = async () => {
    setConfirmEnd(false);
    abortRef.current?.abort();
    speaker.stop();
    recRef.current?.cancel();
    setPhase('paused');
    setGrading(true);
    try {
      await api.end(id, { elapsedSec: elapsedRef.current, code: codeRef.current, notes: notesRef.current });
    } catch (e) {
      toast((e as RequestError).message, 'error');
    }
    navigate(`/report/${id}`);
  };
  const toggleMute = () => {
    if (settings.autoSpeak) speaker.stop();
    setSettings({ autoSpeak: !settings.autoSpeak });
  };

  // Auto-scroll when new content arrives (unless the user scrolled up).
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 220) el.scrollTop = el.scrollHeight;
  }, [s?.messages.length, streamText, fbLoading.length, s?.feedback.length, respondErr]);

  // Warn before leaving mid-interview.
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (phase === 'live') e.preventDefault();
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [phase]);

  // ---------- Render ----------
  if (loadErr)
    return (
      <div className="main">
        <div className="alert error">{loadErr}</div>
      </div>
    );
  if (!s || !persona)
    return (
      <div className="empty">
        <span className="spinner lg" style={{ margin: '0 auto' }} />
      </div>
    );

  const cfg = s.config;
  const tabs: WorkspaceTab[] = cfg.type === 'coding' ? ['code', 'notes'] : cfg.type === 'role-specific' ? ['notes', 'code'] : ['notes'];
  const problem = latestProblem([...s.messages.filter((m) => m.role === 'interviewer').map((m) => m.content), ...(streamText ? [streamText] : [])]);
  const fbFor = new Map(s.feedback.filter((f) => !f.retried).map((f) => [f.messageId, f]));
  const lastCandidate = [...s.messages].reverse().find((m) => m.role === 'candidate');
  const showFeedback = cfg.feedbackMode !== 'end-only';
  const busy = responding || sending || transcribing;
  const inputLocked = phase !== 'live' || awaiting !== null;
  const modelLabel = models.find((m) => m.id === cfg.model)?.label.split(' (')[0] ?? cfg.model;

  return (
    <div className={`iv ${cfg.type === 'behavioral' ? 'no-workspace' : ''}`} style={{ position: 'relative' }}>
      {/* Top bar */}
      <div className="iv-bar">
        <div className="iv-persona">
          <div className={`avatar ${speaking ? 'speaking' : ''}`} aria-hidden>
            {persona.name[0]}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650 }}>
              {persona.name} <span className="faint small">· {persona.label}</span>
            </div>
            <div className="tiny faint">
              {typeLabel(cfg.type)} · {cfg.difficulty} · {modelLabel}
            </div>
          </div>
        </div>
        <span className="spacer" />
        <span className={`timer ${remaining <= 0 ? 'over' : remaining <= 180 ? 'low' : ''}`} title="Interview time remaining">
          <Icon name="clock" size={13} /> {remaining >= 0 ? `${fmtClock(remaining)} left` : `+${fmtClock(remaining)} over`}
        </span>
        {answerLeft !== null && (
          <span className={`timer ${answerLeft <= 15 ? 'over' : answerLeft <= 45 ? 'low' : ''}`} title="Time left for this answer">
            Answer {fmtClock(answerLeft)}
          </span>
        )}
        <span
          className="badge"
          title={`Approximate cost so far\nModel: $${s.usage.chat.cost.toFixed(4)} (${s.usage.chat.inputTokens.toLocaleString()} in / ${s.usage.chat.outputTokens.toLocaleString()} out tokens)\nTranscription: $${s.usage.stt.cost.toFixed(4)}\nVoice: $${s.usage.tts.cost.toFixed(4)} (${s.usage.tts.chars.toLocaleString()} chars)`}
        >
          ≈ ${s.usage.total.toFixed(s.usage.total < 1 ? 3 : 2)}
        </span>
        <button className="btn sm ghost" onClick={toggleMute} title={settings.autoSpeak ? 'Mute interviewer voice' : 'Unmute interviewer voice'} aria-label="Toggle voice">
          <Icon name={settings.autoSpeak ? 'volume' : 'mute'} size={16} />
        </button>
        <button className="btn sm" onClick={pause} disabled={phase !== 'live'}>
          <Icon name="pause" size={14} /> <span className="btn-label">Pause</span>
        </button>
        <button className="btn sm" onClick={skip} disabled={phase !== 'live' || responding || wrapupDone}>
          <Icon name="skip" size={14} /> <span className="btn-label">Skip question</span>
        </button>
        <button className="btn sm primary" onClick={() => setConfirmEnd(true)} disabled={grading}>
          End interview
        </button>
      </div>

      {/* Conversation */}
      <section className="iv-chat" aria-label="Interview conversation">
        <div className="iv-log" ref={logRef}>
          {s.messages.map((m) => {
            if (m.role === 'event') {
              const label = m.meta.event === 'skip' ? 'You skipped the question' : m.meta.event === 'timeout' ? 'Answer time ran out' : m.meta.event === 'wrapup' ? 'Interview time is up' : m.meta.event === 'resume' ? 'You rejoined' : null;
              return label ? (
                <div key={m.id} className="event-line">
                  — {label} —
                </div>
              ) : null;
            }
            if (m.role === 'interviewer')
              return (
                <div key={m.id} className="msg">
                  <div className="avatar" style={{ width: 30, height: 30, fontSize: 13 }} aria-hidden>
                    {persona.name[0]}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <InterviewerBubble content={m.content} />
                    <div className="msg-tools">
                      <button onClick={() => speaker.replay(String(m.id), m.content)} title="Replay audio">
                        <Icon name="replay" size={12} /> Replay
                      </button>
                    </div>
                  </div>
                </div>
              );
            const fb = fbFor.get(m.id);
            const isLast = lastCandidate?.id === m.id;
            const coachingThis = awaiting === m.id;
            return (
              <div key={m.id}>
                <div className="msg candidate">
                  <div className="bubble">
                    {m.content || <span className="faint">(no answer)</span>}
                    {m.meta.timedOut && (
                      <div>
                        <span className="badge warn" style={{ marginTop: 6 }}>
                          Time ran out
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                {showFeedback && m.content.trim() && (
                  <FeedbackCard
                    fb={fb}
                    loading={fbLoading.includes(m.id)}
                    error={fbErrors[m.id]}
                    open={coachingThis || cfg.feedbackMode === 'every-answer'}
                    onRegenerate={() => getFeedback(m.id)}
                    onRetry={isLast && !responding && phase === 'live' ? () => retryAnswer(m.id) : undefined}
                    onContinue={coachingThis ? continueInterview : undefined}
                  />
                )}
              </div>
            );
          })}

          {streamText !== null && (
            <div className="msg">
              <div className={`avatar ${speaking ? 'speaking' : ''}`} style={{ width: 30, height: 30, fontSize: 13 }} aria-hidden>
                {persona.name[0]}
              </div>
              <div style={{ minWidth: 0 }}>
                {streamText ? (
                  <InterviewerBubble content={streamText} />
                ) : (
                  <div className="bubble muted">
                    <span className="dots">{persona.name} is thinking</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {respondErr && (
            <div className="alert error" style={{ marginBottom: 14 }}>
              <Icon name="alert" />
              <div style={{ flex: 1 }}>
                <strong>The interviewer couldn’t respond.</strong> {respondErr}
              </div>
              <button className="btn sm" onClick={() => respond()} disabled={responding}>
                Try again
              </button>
            </div>
          )}

          {wrapupDone && !responding && (
            <div className="alert info" style={{ marginBottom: 14 }}>
              <Icon name="clock" />
              <div style={{ flex: 1 }}>Time’s up. You can keep talking, or end the interview to get your scorecard.</div>
              <button className="btn sm primary" onClick={() => setConfirmEnd(true)}>
                End and get scorecard
              </button>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="composer">
          <div className="quick">
            {(cfg.type === 'coding' || cfg.type === 'role-specific'
              ? ['I’m done coding. Please take a look.', 'Could you clarify the constraints?', 'Can I have a moment to think?']
              : cfg.type === 'system-design'
                ? ['Could you tell me more about the scale?', 'Here’s my high-level design; see my notes.', 'Can I have a moment to think?']
                : ['Could you repeat the question?', 'Can I have a moment to think?']
            ).map((q) => (
              <button key={q} className="chip" style={{ cursor: 'pointer' }} disabled={busy || inputLocked} onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <button
              className={`mic ${recording ? 'rec' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault();
                void onMicDown();
              }}
              onPointerUp={onMicUp}
              onPointerLeave={() => recording && pressAt.current && onMicUp()}
              disabled={inputLocked || responding || transcribing || sending}
              aria-label={recording ? 'Stop recording' : 'Record answer'}
              title={recording ? 'Click (or release) to stop' : 'Hold to talk, or click to start and click again to stop. You can also hold Space.'}
            >
              {recording && <span className="level" style={{ transform: `scale(${1 + level * 0.35})` }} />}
              {transcribing ? <span className="spinner" /> : <Icon name={recording ? 'stop' : 'mic'} size={22} />}
            </button>
            <div style={{ flex: 1 }}>
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit(draft);
                  }
                }}
                placeholder={
                  recording
                    ? 'Listening… release or click the mic to stop.'
                    : transcribing
                      ? 'Transcribing…'
                      : awaiting !== null
                        ? 'Review the feedback, then retry or continue.'
                        : 'Speak with the mic (or hold Space), or type your answer. Ctrl+Enter sends.'
                }
                disabled={inputLocked}
                aria-label="Your answer"
              />
            </div>
            <button className="btn primary" onClick={() => submit(draft)} disabled={!draft.trim() || busy || inputLocked} style={{ height: 52 }}>
              {sending ? <span className="spinner" /> : <Icon name="send" size={16} />} Send
            </button>
          </div>
        </div>
      </section>

      {/* Workspace */}
      <Workspace
        tabs={tabs}
        problem={problem}
        code={code}
        onCode={setCode}
        notes={notes}
        onNotes={setNotes}
        language={lang}
        onLanguage={(l) => {
          setLang(l);
          api.patchSession(id, { config: { codeLanguage: l } }).catch(() => undefined);
          setS((x) => (x ? { ...x, config: { ...x.config, codeLanguage: l } } : x));
        }}
        dark={dark}
        notesPrivate={cfg.type === 'behavioral'}
      />

      {/* Overlays */}
      {(phase === 'ready' || phase === 'paused') && !grading && !(phase === 'ready' && fresh && !s.messages.length) && (
        <div className="overlay">
          <div className="card">
            {phase === 'paused' ? (
              <>
                <h2>Paused</h2>
                <p className="muted">The clock is stopped. Take a breath.</p>
              </>
            ) : (
              <>
                <h2>{s.messages.length ? 'Ready to continue?' : 'Ready when you are'}</h2>
                <p className="muted">
                  {s.messages.length
                    ? `You’re ${Math.floor(elapsed / 60)} minute${Math.floor(elapsed / 60) === 1 ? '' : 's'} into your ${cfg.lengthMin}-minute interview with ${persona.name}.`
                    : `${persona.name} will open the interview. Allow microphone access when your browser asks, or just type.`}
                </p>
              </>
            )}
            <button
              className="btn primary lg"
              onClick={() => {
                if (phase === 'paused') {
                  speaker.unlock();
                  setPhase('live');
                } else begin();
              }}
            >
              <Icon name="play" size={16} /> {phase === 'paused' ? 'Resume' : s.messages.length ? 'Continue interview' : 'Start interview'}
            </button>
          </div>
        </div>
      )}
      {grading && (
        <div className="overlay">
          <div className="card">
            <span className="spinner lg" style={{ margin: '0 auto 14px' }} />
            <h2>Preparing your scorecard</h2>
            <p className="muted">Reviewing the whole interview. This usually takes 20 to 60 seconds.</p>
          </div>
        </div>
      )}
      {confirmEnd && (
        <Modal onClose={() => setConfirmEnd(false)}>
          <h2>End the interview?</h2>
          <p className="muted">You’ll get a full scorecard with question-by-question feedback. You can’t continue this session afterwards.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={() => setConfirmEnd(false)}>
              Keep going
            </button>
            <button className="btn primary" onClick={endInterview}>
              End and get scorecard
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function InterviewerBubble({ content }: { content: string }) {
  const parts = parseContent(content);
  return (
    <div className="bubble">
      {parts.map((p, i) =>
        p.kind === 'problem' ? (
          <div key={i} className="problem-card">
            <div className="label">Problem (also shown in the side panel)</div>
            <Rich text={p.text} />
          </div>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}
