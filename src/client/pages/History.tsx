import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { INTERVIEW_TYPES, personaById, typeLabel, type InterviewType, type Session } from '../../shared/types';
import { Modal, useApp } from '../App';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';

export function History() {
  const { toast } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<Session[] | null>(null);
  const [filter, setFilter] = useState<InterviewType | 'all'>('all');
  const [del, setDel] = useState<Session | null>(null);

  const load = () =>
    api
      .listSessions()
      .then(setItems)
      .catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = (items ?? []).filter((s) => filter === 'all' || s.config.type === filter);

  return (
    <div>
      <div className="page-head row wrap">
        <div style={{ flex: 1 }}>
          <h1>History</h1>
          <p>Every practice session, saved on this computer.</p>
        </div>
        <div className="segmented">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          {INTERVIEW_TYPES.map((t) => (
            <button key={t.id} className={filter === t.id ? 'on' : ''} onClick={() => setFilter(t.id)}>
              {t.label.split(' /')[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {items === null ? (
          <div className="empty">
            <span className="spinner lg" style={{ margin: '0 auto' }} />
          </div>
        ) : shown.length === 0 ? (
          <div className="empty">
            {items.length ? 'No sessions of this type yet.' : 'No sessions yet.'}{' '}
            <Link to="/">Start your first mock interview</Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Date</th>
                  <th>Interviewer</th>
                  <th className="num">Length</th>
                  <th className="num">Score</th>
                  <th className="num">Cost</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const p = personaById(s.config.persona);
                  const href = s.status === 'active' ? `/interview/${s.id}` : `/report/${s.id}`;
                  return (
                    <tr key={s.id} className="clickable" onClick={() => navigate(href)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{s.title}</div>
                        <div className="tiny faint">
                          {typeLabel(s.config.type)} · {s.config.difficulty}
                        </div>
                      </td>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(s.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="small">{p.name}</td>
                      <td className="num small">
                        {Math.round(s.elapsedSec / 60)}/{s.config.lengthMin} min
                      </td>
                      <td className="num">
                        {s.status === 'active' ? (
                          <span className="badge accent">In progress</span>
                        ) : s.status === 'grading' ? (
                          <span className="badge">Grading…</span>
                        ) : s.overallScore != null ? (
                          <strong>{s.overallScore}</strong>
                        ) : (
                          <span className="faint">–</span>
                        )}
                      </td>
                      <td className="num small faint">${s.usage.total.toFixed(2)}</td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <button className="btn ghost icon" aria-label="Delete session" title="Delete" onClick={() => setDel(s)}>
                          <Icon name="trash" size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {del && (
        <Modal onClose={() => setDel(null)}>
          <h2>Delete “{del.title}”?</h2>
          <p className="muted">This permanently removes the transcript, feedback and scorecard.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn" onClick={() => setDel(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }}
              onClick={async () => {
                await api.deleteSession(del.id).catch((e) => toast(e.message, 'error'));
                setDel(null);
                void load();
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
