import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CATEGORIES, personaById, tagLabel, typeLabel, type SessionDetail } from '../../shared/types';
import { Modal, useApp } from '../App';
import { api } from '../lib/api';
import { parseContent } from '../lib/audio';
import { FeedbackCard, Rich, ScorePips } from '../components/Rich';
import { Icon } from '../components/Icon';

const SIGNAL: Record<string, { label: string; cls: string }> = {
  'strong-no': { label: 'Strong no hire', cls: 'bad' },
  no: { label: 'No hire', cls: 'bad' },
  'lean-no': { label: 'Leaning no', cls: 'warn' },
  'lean-yes': { label: 'Leaning hire', cls: 'accent' },
  yes: { label: 'Hire', cls: 'good' },
  'strong-yes': { label: 'Strong hire', cls: 'good' },
};

export function ScoreRing({ score, size = 120 }: { score: number; size?: number }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  return (
    <div className="score-ring" style={{ width: size, height: size }} role="img" aria-label={`Overall score ${score} out of 100`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent-soft)" strokeWidth={8} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="num">
        <div>
          {score}
          <small>of 100</small>
        </div>
      </div>
    </div>
  );
}

export function Report() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useApp();
  const [s, setS] = useState<SessionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [regrading, setRegrading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .getSession(id)
        .then((d) => {
          if (!alive) return;
          setS(d);
          if (d.status === 'grading') timer = setTimeout(load, 3000);
        })
        .catch((e) => alive && setErr(e.message));
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  async function regrade() {
    setRegrading(true);
    try {
      setS(await api.regrade(id));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRegrading(false);
    }
  }

  function exportPdf() {
    const details = Array.from(document.querySelectorAll('details'));
    const wasOpen = details.map((d) => d.open);
    details.forEach((d) => (d.open = true));
    const restore = () => {
      details.forEach((d, i) => (d.open = wasOpen[i]));
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    setTimeout(() => window.print(), 50);
  }

  if (err) return <div className="alert error">{err}</div>;
  if (!s)
    return (
      <div className="empty">
        <span className="spinner lg" style={{ margin: '0 auto' }} />
      </div>
    );

  const c = s.config;
  const persona = personaById(c.persona);
  const sc = s.scorecard;
  const fbFor = new Map(s.feedback.filter((f) => !f.retried).map((f) => [f.messageId, f]));
  const sig = sc ? SIGNAL[sc.hire_signal] ?? { label: sc.hire_signal, cls: '' } : null;

  return (
    <div>
      <div className="page-head row wrap" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{s.title}</h1>
          <p>
            {new Date(s.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {typeLabel(c.type)} · {c.difficulty} · with {persona.name} (
            {persona.label.toLowerCase()}) · {Math.round(s.elapsedSec / 60)} of {c.lengthMin} min · ≈ ${s.usage.total.toFixed(3)}
          </p>
        </div>
        <div className="row wrap no-print">
          {s.status === 'active' && (
            <Link className="btn primary" to={`/interview/${s.id}`}>
              <Icon name="play" size={14} /> Resume interview
            </Link>
          )}
          <a className="btn" href={`/api/sessions/${s.id}/export.md`} download>
            <Icon name="download" size={15} /> Markdown
          </a>
          <button className="btn" onClick={exportPdf}>
            <Icon name="printer" size={15} /> PDF
          </button>
          <button className="btn" onClick={() => navigate('/', { state: { prefill: { ...c, focusAreas: sc?.weakness_tags.slice(0, 3) ?? [] } } })}>
            <Icon name="retry" size={15} /> Practise again
          </button>
          <button className="btn ghost danger icon" onClick={() => setConfirmDelete(true)} aria-label="Delete session" title="Delete session">
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>

      {s.status === 'grading' && (
        <div className="card row">
          <span className="spinner" /> Preparing your scorecard. This page updates automatically.
        </div>
      )}

      {!sc && s.status === 'completed' && (
        <div className="card row wrap">
          <div style={{ flex: 1 }}>
            <strong>No scorecard yet.</strong>{' '}
            <span className="muted">{s.messages.some((m) => m.role === 'candidate') ? 'Grading didn’t finish (for example, an API error).' : 'This interview ended before you answered anything.'}</span>
          </div>
          {s.messages.some((m) => m.role === 'candidate') && (
            <button className="btn primary" onClick={regrade} disabled={regrading}>
              {regrading ? <span className="spinner" /> : <Icon name="sparkle" size={15} />} Generate scorecard
            </button>
          )}
        </div>
      )}

      {sc && sig && (
        <>
          <section className="card">
            <div className="score-hero">
              <ScoreRing score={sc.overall_score} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span className={`badge ${sig.cls}`}>{sig.label}</span>
                  <span className="faint small">at {c.difficulty} level</span>
                </div>
                <p style={{ margin: 0 }}>{sc.summary}</p>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Scores by category</h2>
            {CATEGORIES.map((cat) => {
              const v = sc.categories[cat.id];
              return (
                <div className="cat-row" key={cat.id}>
                  <div style={{ fontWeight: 600 }}>{cat.label}</div>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="meter5" style={{ width: 70 }} aria-hidden>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <i key={i} className={i <= v.score ? 'on' : ''} />
                      ))}
                    </div>
                    <span className="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {v.score}/5
                    </span>
                  </div>
                  <div className="cat-comment small muted">{v.comment}</div>
                </div>
              );
            })}
          </section>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <section className="card" style={{ margin: 0 }}>
              <h3>Strengths</h3>
              <ul className="list-clean">
                {sc.strengths.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </section>
            <section className="card" style={{ margin: 0 }}>
              <h3>Weaknesses</h3>
              <ul className="list-clean">
                {sc.weaknesses.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              {sc.weakness_tags.length > 0 && (
                <div className="row wrap" style={{ marginTop: 12 }}>
                  {sc.weakness_tags.map((t) => (
                    <span key={t} className="chip">
                      {tagLabel(t)}
                    </span>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="card" style={{ marginTop: 16 }}>
            <h2>Top 3 things to practise next</h2>
            <ol className="list-clean">
              {sc.next_steps.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ol>
            <button
              className="btn primary no-print"
              style={{ marginTop: 14 }}
              onClick={() => navigate('/', { state: { prefill: { ...c, focusAreas: sc.weakness_tags.slice(0, 3) } } })}
            >
              <Icon name="target" size={15} /> Practise these now
            </button>
          </section>

          <section className="card">
            <h2>Question by question</h2>
            {sc.questions.length === 0 && <p className="muted">No main questions were answered.</p>}
            {sc.questions.map((q, i) => (
              <details key={i} className="q-card" open={i === 0}>
                <summary>
                  <span className="faint" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {i + 1}.
                  </span>
                  <span style={{ flex: 1, fontWeight: 600 }}>{q.question}</span>
                  <ScorePips score={q.score} />
                </summary>
                <div className="q-body stack">
                  <div>
                    <div className="tiny faint" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Your answer
                    </div>
                    <div>{q.answer_summary}</div>
                  </div>
                  <div>
                    <div className="tiny faint" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Critique
                    </div>
                    <div>{q.critique}</div>
                  </div>
                  <div>
                    <div className="tiny faint" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                      A stronger answer
                    </div>
                    <div className="improved">{q.improved_answer}</div>
                  </div>
                </div>
              </details>
            ))}
          </section>
        </>
      )}

      <section className="card">
        <details>
          <summary className="row">
            <h2 style={{ margin: 0 }}>Transcript</h2>
            <span className="faint small">{s.messages.filter((m) => m.role !== 'event').length} messages</span>
          </summary>
          <div style={{ marginTop: 14 }}>
            {s.messages.map((m) => {
              if (m.role === 'event')
                return m.meta.event && m.meta.event !== 'start' ? (
                  <div key={m.id} className="event-line">
                    — {m.meta.event === 'skip' ? 'Skipped question' : m.meta.event === 'timeout' ? 'Answer time ran out' : m.meta.event === 'wrapup' ? 'Time up' : 'Rejoined'} —
                  </div>
                ) : null;
              if (m.role === 'interviewer')
                return (
                  <div key={m.id} className="msg">
                    <div className="bubble">
                      <div className="tiny faint" style={{ fontWeight: 700 }}>
                        {persona.name}
                      </div>
                      {parseContent(m.content).map((p, i) =>
                        p.kind === 'problem' ? (
                          <div key={i} className="problem-card">
                            <Rich text={p.text} />
                          </div>
                        ) : (
                          <span key={i}>{p.text}</span>
                        ),
                      )}
                    </div>
                  </div>
                );
              const fb = fbFor.get(m.id);
              return (
                <div key={m.id}>
                  <div className="msg candidate">
                    <div className="bubble">
                      <div className="tiny faint" style={{ fontWeight: 700 }}>
                        You
                      </div>
                      {m.content || <span className="faint">(no answer)</span>}
                    </div>
                  </div>
                  {fb && <FeedbackCard fb={fb} />}
                </div>
              );
            })}
          </div>
        </details>
      </section>

      {(s.code.trim() || s.notes.trim()) && (
        <section className="card">
          {s.code.trim() && (
            <>
              <h3>Final code ({c.codeLanguage})</h3>
              <pre>{s.code}</pre>
            </>
          )}
          {s.notes.trim() && (
            <>
              <h3 style={{ marginTop: s.code.trim() ? 16 : 0 }}>Notes</h3>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{s.notes}</pre>
            </>
          )}
        </section>
      )}

      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(false)}>
          <h2>Delete this session?</h2>
          <p className="muted">The transcript, feedback and scorecard will be permanently removed.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}
              onClick={async () => {
                await api.deleteSession(s.id);
                navigate('/history');
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
