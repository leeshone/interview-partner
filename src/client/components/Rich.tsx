import { Fragment, type ReactNode } from 'react';
import type { AnswerFeedback } from '../../shared/types';
import { Icon } from './Icon';

/** Minimal, safe markdown-ish renderer: fenced code, inline code, bold, lists, paragraphs. */
export function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    if (prose?.trim()) blocks.push(<Prose key={`p${i}`} text={prose} />);
    if (parts[i + 2] !== undefined) blocks.push(<pre key={`c${i}`}>{parts[i + 2].replace(/\n$/, '')}</pre>);
  }
  return <div className="rich">{blocks}</div>;
}

function Prose({ text }: { text: string }) {
  const paras = text.trim().split(/\n{2,}/);
  return (
    <>
      {paras.map((p, i) => {
        const lines = p.split('\n');
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]);
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#+\s*/, ''))}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={k++}>{tok.slice(1, -1)}</code> : <strong key={k++}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function ScorePips({ score, max = 5 }: { score: number; max?: number }) {
  return (
    <span className="score-pips" role="img" aria-label={`${score} out of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} className={i < score ? 'on' : ''} />
      ))}
    </span>
  );
}

const STAR_BADGE = { present: 'good', partial: 'warn', missing: 'bad' } as const;
const STAR_ICON = { present: 'check', partial: 'info', missing: 'x' } as const;

export function FeedbackCard({
  fb,
  loading,
  open,
  error,
  onRetry,
  onContinue,
  onRegenerate,
}: {
  fb?: AnswerFeedback;
  loading?: boolean;
  open?: boolean;
  error?: string;
  onRetry?: () => void;
  onContinue?: () => void;
  onRegenerate?: () => void;
}) {
  if (loading)
    return (
      <div className="fb no-print" style={{ padding: '8px 12px' }}>
        <div className="row small muted">
          <span className="spinner" style={{ width: 14, height: 14 }} /> Reviewing your answer<span className="dots" />
        </div>
      </div>
    );
  if (error)
    return (
      <div className="fb" style={{ padding: '8px 12px' }}>
        <div className="row small" style={{ color: 'var(--bad-text)' }}>
          <Icon name="alert" size={15} /> Feedback failed: {error}
          <span className="spacer" />
          {onRegenerate && (
            <button className="btn sm" onClick={onRegenerate}>
              Try again
            </button>
          )}
          {onContinue && (
            <button className="btn sm primary" onClick={onContinue}>
              Continue
            </button>
          )}
        </div>
      </div>
    );
  if (!fb) return null;
  return (
    <details className="fb" open={open}>
      <summary>
        <Icon name="sparkle" size={15} />
        <strong>Coach</strong>
        <ScorePips score={fb.score} />
        <span className="small muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fb.summary}
        </span>
      </summary>
      <div className="fb-body">
        <div className="small">{fb.summary}</div>
        <ul>
          {fb.tips.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
        {fb.star.applicable && (
          <>
            <div className="star">
              {(['situation', 'task', 'action', 'result'] as const).map((k) => (
                <span key={k} className={`badge ${STAR_BADGE[fb.star[k]]}`} title={`${k}: ${fb.star[k]}`}>
                  <Icon name={STAR_ICON[fb.star[k]]} size={12} />
                  {k[0].toUpperCase() + k.slice(1)}
                </span>
              ))}
            </div>
            {fb.star.note && <div className="small muted">{fb.star.note}</div>}
          </>
        )}
        {(onRetry || onContinue) && (
          <div className="row" style={{ marginTop: 10 }}>
            {onRetry && (
              <button className="btn sm" onClick={onRetry}>
                <Icon name="retry" size={14} /> Retry this answer
              </button>
            )}
            {onContinue && (
              <button className="btn sm primary" onClick={onContinue}>
                Continue the interview <Icon name="arrow" size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
