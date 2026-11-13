import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CODE_LANGUAGES,
  DEFAULT_CONFIG,
  DIFFICULTIES,
  INTERVIEW_TYPES,
  PERSONAS,
  WEAKNESS_TAGS,
  tagLabel,
  type FeedbackMode,
  type SessionConfig,
} from '../../shared/types';
import { useApp } from '../App';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';

const LAST_KEY = 'ip.lastConfig';

function loadLast(): SessionConfig {
  try {
    const c = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    return { ...DEFAULT_CONFIG, ...c, focusAreas: [] };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const FEEDBACK_MODES: { id: FeedbackMode; label: string; blurb: string }[] = [
  { id: 'both', label: 'Tips + final scorecard', blurb: 'A short feedback card after each answer, plus a full scorecard at the end.' },
  { id: 'end-only', label: 'Scorecard at the end only', blurb: 'Fully realistic: no feedback until the interview ends.' },
  { id: 'every-answer', label: 'Coaching mode', blurb: 'Feedback right after each answer, before the interviewer continues, with the option to retry.' },
];

export function Setup() {
  const { settings, toast } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as { prefill?: Partial<SessionConfig> } | null)?.prefill;
  const [c, setC] = useState<SessionConfig>(() => ({ ...loadLast(), ...(prefill ?? {}) }));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<SessionConfig>) => setC((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (prefill) window.history.replaceState({}, '');
  }, [prefill]);

  const roleSpecific = c.type === 'role-specific';
  const canStart = !roleSpecific || c.jobDescription.trim().length > 0 || c.targetRole.trim().length > 0;

  async function start() {
    setBusy(true);
    try {
      const config = { ...c, model: settings.model, voice: settings.voice };
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ ...config, focusAreas: [] }));
      } catch {
        /* ignore */
      }
      const s = await api.createSession(config);
      navigate(`/interview/${s.id}`, { state: { fresh: true } });
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  }

  async function onUpload(f: File) {
    setUploading(true);
    try {
      const { text } = await api.uploadResume(f);
      set({ resume: text });
      toast(`Loaded ${f.name} (${text.length.toLocaleString()} characters).`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function previewVoice(personaId: string) {
    const p = PERSONAS.find((x) => x.id === personaId)!;
    audioRef.current?.pause();
    setPreview(personaId);
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Hi, I'm ${p.name}. Thanks for making the time today. Shall we get started?`, persona: p.id, voice: settings.voice }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Voice preview failed');
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => setPreview(null);
      await a.play();
    } catch (e) {
      toast((e as Error).message, 'error');
      setPreview(null);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Set up a mock interview</h1>
        <p>Choose a format and an interviewer, then talk or type your answers. You’ll get feedback as you go and a scorecard at the end.</p>
      </div>

      {c.focusAreas.length > 0 && (
        <div className="alert info" style={{ marginBottom: 16 }}>
          <Icon name="target" />
          <div style={{ flex: 1 }}>
            <strong>Targeting your weak spots.</strong> The interviewer will choose questions that make you practise:
            <div className="row wrap" style={{ marginTop: 8 }}>
              {c.focusAreas.map((t) => (
                <span className="chip" key={t}>
                  {tagLabel(t)}
                  <button aria-label={`Remove ${tagLabel(t)}`} onClick={() => set({ focusAreas: c.focusAreas.filter((x) => x !== t) })}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <section className="card">
        <div className="section-title">
          <span className="step-num">1</span>
          <h2>Interview type</h2>
        </div>
        <div className="choices">
          {INTERVIEW_TYPES.map((t) => (
            <button key={t.id} className={`choice ${c.type === t.id ? 'on' : ''}`} onClick={() => set({ type: t.id })} aria-pressed={c.type === t.id}>
              <div className="choice-title">
                <Icon name={t.id === 'coding' ? 'code' : t.id === 'system-design' ? 'chart' : t.id === 'role-specific' ? 'target' : 'chat'} size={16} />
                {t.label}
              </div>
              <div className="choice-sub">{t.blurb}</div>
            </button>
          ))}
        </div>

        <div className="grid-2" style={{ marginTop: 18 }}>
          <div>
            <div style={{ fontWeight: 560, marginBottom: 6, fontSize: '0.92rem' }}>Level</div>
            <div className="segmented">
              {DIFFICULTIES.map((d) => (
                <button key={d.id} className={c.difficulty === d.id ? 'on' : ''} onClick={() => set({ difficulty: d.id })}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Target role {roleSpecific ? '' : <span className="faint">(optional)</span>}</span>
            <input type="text" value={c.targetRole} placeholder="e.g. Senior Backend Engineer at a fintech" onChange={(e) => set({ targetRole: e.target.value })} />
          </label>
        </div>

        {c.type === 'coding' && (
          <label className="field" style={{ marginTop: 16, maxWidth: 260 }}>
            <span>Programming language</span>
            <select value={c.codeLanguage} onChange={(e) => set({ codeLanguage: e.target.value })}>
              {CODE_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="card">
        <div className="section-title">
          <span className="step-num">2</span>
          <h2>Job and resume</h2>
          <span className="faint small">{roleSpecific ? 'A job description or target role is required' : 'Optional: tailors questions to you'}</span>
        </div>
        <div className="grid-2">
          <label className="field">
            <span>Job description</span>
            <textarea rows={8} value={c.jobDescription} placeholder="Paste the job posting here…" onChange={(e) => set({ jobDescription: e.target.value })} />
          </label>
          <div className="field">
            <div className="row" style={{ marginBottom: 6 }}>
              <span style={{ fontWeight: 560, fontSize: '0.92rem' }}>Your resume</span>
              <span className="spacer" />
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.txt,.md,application/pdf,text/plain"
                hidden
                onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
              />
              <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? <span className="spinner" /> : <Icon name="upload" size={15} />} Upload PDF or text
              </button>
            </div>
            <textarea rows={8} value={c.resume} placeholder="…or paste your resume text" onChange={(e) => set({ resume: e.target.value })} />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <span className="step-num">3</span>
          <h2>Interviewer</h2>
        </div>
        <div className="choices">
          {PERSONAS.map((p) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              className={`choice ${c.persona === p.id ? 'on' : ''}`}
              onClick={() => set({ persona: p.id })}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), set({ persona: p.id }))}
              aria-pressed={c.persona === p.id}
            >
              <div className="choice-title">
                {p.label}
                <span className="spacer" />
                <button
                  className="btn ghost sm"
                  style={{ padding: '2px 8px' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void previewVoice(p.id);
                  }}
                  title="Hear this voice"
                  aria-label={`Hear ${p.name}'s voice`}
                >
                  {preview === p.id ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="volume" size={15} />}
                </button>
              </div>
              <div className="choice-sub">
                <strong style={{ color: 'var(--text)' }}>{p.name}</strong>. {p.blurb}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <span className="step-num">4</span>
          <h2>Timing and feedback</h2>
        </div>
        <div className="grid-2">
          <div>
            <div style={{ fontWeight: 560, marginBottom: 6, fontSize: '0.92rem' }}>Session length</div>
            <div className="segmented">
              {([15, 30, 45, 60] as const).map((m) => (
                <button key={m} className={c.lengthMin === m ? 'on' : ''} onClick={() => set({ lengthMin: m })}>
                  {m} min
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Time limit per answer</span>
            <select value={c.answerTimerSec} onChange={(e) => set({ answerTimerSec: Number(e.target.value) as SessionConfig['answerTimerSec'] })}>
              <option value={0}>No limit</option>
              <option value={60}>1 minute</option>
              <option value={120}>2 minutes</option>
              <option value={180}>3 minutes</option>
              <option value={300}>5 minutes</option>
            </select>
          </label>
        </div>
        <div className="choices" style={{ marginTop: 16 }}>
          {FEEDBACK_MODES.map((f) => (
            <button key={f.id} className={`choice ${c.feedbackMode === f.id ? 'on' : ''}`} onClick={() => set({ feedbackMode: f.id })} aria-pressed={c.feedbackMode === f.id}>
              <div className="choice-title">{f.label}</div>
              <div className="choice-sub">{f.blurb}</div>
            </button>
          ))}
        </div>
        {c.focusAreas.length === 0 && (
          <details style={{ marginTop: 16 }}>
            <summary className="small muted">+ Focus on specific skills (optional)</summary>
            <div className="row wrap" style={{ marginTop: 10 }}>
              {WEAKNESS_TAGS.map((t) => (
                <button key={t.id} className="chip" style={{ cursor: 'pointer' }} onClick={() => set({ focusAreas: [...c.focusAreas, t.id].slice(0, 4) })} title={t.hint}>
                  {t.label}
                </button>
              ))}
            </div>
          </details>
        )}
      </section>

      <div className="setup-footer row wrap">
        <div className="small muted" style={{ flex: 1, minWidth: 220 }}>
          {INTERVIEW_TYPES.find((t) => t.id === c.type)?.label} · {DIFFICULTIES.find((d) => d.id === c.difficulty)?.label} ·{' '}
          {PERSONAS.find((p) => p.id === c.persona)?.name} · {c.lengthMin} min
          {!canStart && <div style={{ color: 'var(--bad-text)' }}>Add a job description or target role for a role-specific interview.</div>}
        </div>
        <button className="btn primary lg" onClick={start} disabled={busy || !canStart}>
          {busy ? <span className="spinner" /> : <Icon name="play" size={16} />} Start interview
        </button>
      </div>
    </div>
  );
}
