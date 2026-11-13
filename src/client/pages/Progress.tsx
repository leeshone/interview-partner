import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CATEGORIES, typeLabel } from '../../shared/types';
import { useApp } from '../App';
import { api, type ProgressData } from '../lib/api';
import { BarList, LineChart } from '../components/Charts';
import { Icon } from '../components/Icon';

const fmtDate = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function Progress() {
  const { toast } = useApp();
  const navigate = useNavigate();
  const [d, setD] = useState<ProgressData | null>(null);
  const [tables, setTables] = useState(false);

  useEffect(() => {
    api
      .progress()
      .then(setD)
      .catch((e) => toast(e.message, 'error'));
  }, [toast]);

  if (!d)
    return (
      <div className="empty">
        <span className="spinner lg" style={{ margin: '0 auto' }} />
      </div>
    );

  const t = d.totals;
  const delta = t.recentAvg != null && t.prevAvg != null ? t.recentAvg - t.prevAvg : null;
  const pts = d.points.map((p, i) => ({ x: i, y: p.overall, label: fmtDate(p.date), sub: `${typeLabel(p.type as never)} · ${p.difficulty}` }));
  const weakest = CATEGORIES.map((c) => ({ ...c, v: d.categoryAvg[c.id] })).filter((c) => c.v != null).sort((a, b) => a.v! - b.v!)[0];
  const practise = () =>
    navigate('/', { state: { prefill: { type: d.suggestion.type, focusAreas: d.suggestion.focusAreas } } });

  return (
    <div>
      <div className="page-head row wrap">
        <div style={{ flex: 1 }}>
          <h1>Progress</h1>
          <p>How your scores are trending, and where you keep losing points.</p>
        </div>
        {d.points.length > 0 && (
          <button className="btn sm" onClick={() => setTables((x) => !x)} aria-pressed={tables}>
            <Icon name={tables ? 'chart' : 'table'} size={15} /> {tables ? 'Show charts' : 'Show as tables'}
          </button>
        )}
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Sessions</div>
          <div className="value">{t.sessions}</div>
          <div className="tiny faint">{t.graded} with a scorecard</div>
        </div>
        <div className="tile">
          <div className="label">Practice time</div>
          <div className="value">{t.minutes < 120 ? `${t.minutes} min` : `${(t.minutes / 60).toFixed(1)} h`}</div>
        </div>
        <div className="tile">
          <div className="label">Average, last 5</div>
          <div className="value">{t.recentAvg != null ? Math.round(t.recentAvg) : '–'}</div>
          {delta != null && (
            <div className="delta" style={{ color: delta >= 0 ? 'var(--good-text)' : 'var(--bad-text)' }}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta))} vs previous 5
            </div>
          )}
        </div>
        <div className="tile">
          <div className="label">Total spend</div>
          <div className="value">${t.cost.toFixed(2)}</div>
          <div className="tiny faint">approximate</div>
        </div>
      </div>

      {d.points.length === 0 ? (
        <div className="card empty">
          <p>No scored interviews yet. Finish an interview to start tracking progress.</p>
          <Link className="btn primary" to="/">
            Start practising
          </Link>
        </div>
      ) : (
        <>
          <section className="card">
            <div className="row wrap" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <h2>Recurring weak spots</h2>
                <p className="muted small">
                  Pulled from your scorecards and per-answer feedback.{' '}
                  {weakest && (
                    <>
                      Your weakest category recently is <strong>{weakest.label}</strong> ({weakest.v!.toFixed(1)}/5).
                    </>
                  )}
                </p>
              </div>
              {d.suggestion.focusAreas.length > 0 && (
                <button className="btn primary" onClick={practise}>
                  <Icon name="target" size={15} /> Practise my weak spots
                </button>
              )}
            </div>
            {d.weakSpots.length === 0 ? (
              <p className="muted">No weak spots recorded yet.</p>
            ) : tables ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Weak spot</th>
                    <th className="num">Sessions</th>
                    <th>How to fix</th>
                  </tr>
                </thead>
                <tbody>
                  {d.weakSpots.map((w) => (
                    <tr key={w.id}>
                      <td>{w.label}</td>
                      <td className="num">{w.sessions}</td>
                      <td className="small muted">{w.hint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <BarList
                rows={d.weakSpots.slice(0, 8).map((w) => ({ key: w.id, label: w.label, value: w.sessions, tip: w.hint }))}
                max={Math.max(...d.weakSpots.map((w) => w.sessions), 1)}
                valueLabel={(v) => `${v} session${v === 1 ? '' : 's'}`}
              />
            )}
          </section>

          <section className="card">
            <h2>Overall score</h2>
            {tables ? (
              <ScoreTable d={d} />
            ) : (
              <LineChart title="Overall score by session" points={pts} yMax={100} yTicks={[0, 25, 50, 75, 100]} valueLabel={(v) => String(Math.round(v))} />
            )}
          </section>

          {!tables && (
            <section className="card">
              <h2>By category</h2>
              <p className="muted small">Each score is out of 5.</p>
              <div className="multiples">
                {CATEGORIES.map((c) => {
                  const cp = d.points
                    .map((p) => ({ p, v: p.categories[c.id] }))
                    .filter((x) => x.v != null)
                    .map((x, i) => ({ x: i, y: x.v!, label: fmtDate(x.p.date), sub: x.p.title }));
                  return (
                    <div key={c.id}>
                      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
                        {c.label}
                      </div>
                      <LineChart title={`${c.label} score by session`} points={cp} yMax={5} yTicks={[1, 3, 5]} height={110} compact valueLabel={(v) => v.toFixed(0)} />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {d.byType.length > 0 && (
            <section className="card">
              <h2>Average by interview type</h2>
              {tables ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th className="num">Sessions</th>
                      <th className="num">Average score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.byType.map((b) => (
                      <tr key={b.type}>
                        <td>{b.label}</td>
                        <td className="num">{b.count}</td>
                        <td className="num">{b.avg != null ? Math.round(b.avg) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <BarList
                  rows={d.byType.map((b) => ({ key: b.type, label: b.label, value: b.avg ?? 0, tip: `${b.count} session${b.count === 1 ? '' : 's'}` }))}
                  max={100}
                  valueLabel={(v) => `${Math.round(v)} / 100`}
                />
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ScoreTable({ d }: { d: ProgressData }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Session</th>
            <th className="num">Overall</th>
            {CATEGORIES.map((c) => (
              <th key={c.id} className="num">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.points.map((p) => (
            <tr key={p.id}>
              <td className="small">{fmtDate(p.date)}</td>
              <td>
                <Link to={`/report/${p.id}`}>{p.title}</Link>
              </td>
              <td className="num">
                <strong>{p.overall}</strong>
              </td>
              {CATEGORIES.map((c) => (
                <td key={c.id} className="num">
                  {p.categories[c.id] ?? '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
