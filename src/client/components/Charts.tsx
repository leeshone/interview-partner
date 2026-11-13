import { useEffect, useRef, useState } from 'react';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export interface Pt {
  x: number; // index position
  y: number;
  label: string; // tooltip title (e.g. date)
  sub?: string;
}

/** Single-series line chart with a crosshair tooltip. */
export function LineChart({
  points,
  yMax,
  yTicks,
  height = 220,
  valueLabel,
  compact = false,
  title,
}: {
  points: Pt[];
  yMax: number;
  yTicks: number[];
  height?: number;
  valueLabel: (v: number) => string;
  compact?: boolean;
  title: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = compact ? { t: 10, r: 28, b: 8, l: 26 } : { t: 14, r: 44, b: 26, l: 34 };
  const iw = Math.max(10, width - m.l - m.r);
  const ih = height - m.t - m.b;
  const n = points.length;
  const xs = (i: number) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const ys = (v: number) => m.t + ih - (v / yMax) * ih;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.y).toFixed(1)}`).join(' ');
  const last = points[n - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!n) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(xs(i) - x) < Math.abs(xs(best) - x)) best = i;
    setHover(best);
  };

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
        <g className="grid">
          {yTicks.map((t) => (
            <line key={t} x1={m.l} x2={m.l + iw} y1={ys(t)} y2={ys(t)} />
          ))}
        </g>
        <g className="axis">
          {yTicks.map((t) => (
            <text key={t} x={m.l - 8} y={ys(t)} dy="0.32em" textAnchor="end">
              {t}
            </text>
          ))}
          {!compact && n > 0 && (
            <>
              <text x={xs(0)} y={height - 6} textAnchor={n > 1 ? 'start' : 'middle'}>
                {points[0].label}
              </text>
              {n > 1 && (
                <text x={xs(n - 1)} y={height - 6} textAnchor="end">
                  {last.label}
                </text>
              )}
            </>
          )}
        </g>
        {hover !== null && <line x1={xs(hover)} x2={xs(hover)} y1={m.t} y2={m.t + ih} stroke="var(--border-strong)" strokeWidth={1} />}
        {n > 1 && <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xs(i)}
            cy={ys(p.y)}
            r={hover === i ? 5 : n > 24 ? 2.5 : 4}
            fill="var(--series-1)"
            stroke="var(--surface)"
            strokeWidth={2}
          />
        ))}
        {last && (
          <text x={xs(n - 1) + 9} y={ys(last.y)} dy="0.32em" style={{ fill: 'var(--text)', fontSize: 12, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
            {valueLabel(last.y)}
          </text>
        )}
      </svg>
      {hover !== null && points[hover] && (
        <div className="tooltip" style={{ left: xs(hover), top: ys(points[hover].y) }}>
          <div className="t-title">{points[hover].label}</div>
          <div className="t-value">{valueLabel(points[hover].y)}</div>
          {points[hover].sub && <div className="t-title">{points[hover].sub}</div>}
        </div>
      )}
    </div>
  );
}

/** Horizontal single-hue bars with values at the tip and hover tooltips. */
export function BarList({ rows, max, valueLabel }: { rows: { key: string; label: string; value: number; tip?: string }[]; max: number; valueLabel: (v: number) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="bars" role="list">
      {rows.map((r) => (
        <div key={r.key} className="bar-row" role="listitem" onPointerEnter={() => setHover(r.key)} onPointerLeave={() => setHover(null)}>
          <div className="bar-label" title={r.label}>
            {r.label}
          </div>
          <div className="bar-track">
            <div className="bar" style={{ width: `calc(${Math.max(0, r.value / max) * 100}% - 48px)` }} />
            <span className="bar-value">{valueLabel(r.value)}</span>
          </div>
          {hover === r.key && r.tip && (
            <div className="tooltip" style={{ left: '50%', top: 0 }}>
              <div className="t-value">{r.label}</div>
              <div className="t-title">{r.tip}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
