import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { CODE_LANGUAGES } from '../../shared/types';
import { Rich } from './Rich';
import { Icon } from './Icon';

const CodeEditor = lazy(() => import('./CodeEditor'));

export type WorkspaceTab = 'code' | 'notes';

export function Workspace({
  tabs,
  problem,
  code,
  onCode,
  notes,
  onNotes,
  language,
  onLanguage,
  dark,
  notesPrivate,
}: {
  tabs: WorkspaceTab[];
  problem: string | null;
  code: string;
  onCode: (v: string) => void;
  notes: string;
  onNotes: (v: string) => void;
  language: string;
  onLanguage: (v: string) => void;
  dark: boolean;
  notesPrivate?: boolean;
}) {
  const [tab, setTab] = useState<WorkspaceTab>(tabs[0]);
  const [problemOpen, setProblemOpen] = useState(true);
  return (
    <div className="iv-side">
      <div className="ws-tabs">
        {tabs.map((t) => (
          <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            <span className="row" style={{ gap: 6 }}>
              <Icon name={t === 'code' ? 'code' : 'notes'} size={15} />
              {t === 'code' ? 'Code editor' : notesPrivate ? 'Scratchpad' : 'Notes & diagram'}
            </span>
          </button>
        ))}
        <span className="spacer" />
        {tab === 'code' && (
          <select value={language} onChange={(e) => onLanguage(e.target.value)} style={{ width: 'auto', padding: '4px 30px 4px 10px', fontSize: '0.85rem' }} aria-label="Language">
            {CODE_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        )}
        <span className="tiny faint" title={notesPrivate && tab === 'notes' ? 'Only you can see this.' : 'The interviewer sees this when you send a message.'}>
          {notesPrivate && tab === 'notes' ? 'Private' : 'Shared with interviewer'}
        </span>
      </div>
      {problem && (
        <div className="ws-problem">
          <button className="btn ghost sm" style={{ float: 'right', marginTop: -2 }} onClick={() => setProblemOpen((o) => !o)}>
            {problemOpen ? 'Hide' : 'Show'}
          </button>
          <div className="label tiny faint" style={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Problem
          </div>
          {problemOpen && <Rich text={problem} />}
        </div>
      )}
      <div className="ws-body">
        {tab === 'code' ? (
          <Suspense
            fallback={
              <div className="row muted small" style={{ padding: 16 }}>
                <span className="spinner" /> Loading editor…
              </div>
            }
          >
            <CodeEditor value={code} onChange={onCode} language={language} dark={dark} />
          </Suspense>
        ) : (
          <NotesPad value={notes} onChange={onNotes} dark={dark} />
        )}
      </div>
    </div>
  );
}

const MERMAID_TEMPLATE = '\n```mermaid\nflowchart LR\n  Client --> API[API gateway]\n  API --> Svc[Service]\n  Svc --> DB[(Database)]\n```\n';

function NotesPad({ value, onChange, dark }: { value: string; onChange: (v: string) => void; dark: boolean }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', gap: 6 }}>
        <div className="segmented" style={{ padding: 2 }}>
          <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')} style={{ padding: '3px 12px' }}>
            Edit
          </button>
          <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')} style={{ padding: '3px 12px' }}>
            Preview
          </button>
        </div>
        <span className="spacer" />
        <button
          className="btn sm ghost"
          onClick={() => {
            onChange(value + MERMAID_TEMPLATE);
            setMode('edit');
          }}
          title="Insert a Mermaid diagram block"
        >
          + Diagram
        </button>
      </div>
      {mode === 'edit' ? (
        <textarea
          className="notes-area"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'Requirements, estimates, components, trade-offs…\n\nAdd a ```mermaid block for diagrams, then use Preview.'}
          spellCheck={false}
          aria-label="Notes"
        />
      ) : (
        <NotesPreview text={value} dark={dark} />
      )}
    </div>
  );
}

function NotesPreview({ text, dark }: { text: string; dark: boolean }) {
  const parts = text.split(/```mermaid\n([\s\S]*?)```/g);
  return (
    <div className="mermaid-preview">
      {!text.trim() && <div className="faint small">Nothing to preview yet.</div>}
      {parts.map((p, i) => (i % 2 === 1 ? <Mermaid key={i} code={p} dark={dark} /> : p.trim() ? <Rich key={i} text={p} /> : null))}
    </div>
  );
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function Mermaid({ code, dark }: { code: string; dark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const id = 'm' + useId().replace(/[^a-zA-Z0-9]/g, '');
  useEffect(() => {
    let alive = true;
    mermaidPromise ??= import('mermaid').then((m) => m.default);
    mermaidPromise
      .then(async (mermaid) => {
        mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
        const { svg } = await mermaid.render(id, code);
        if (alive && ref.current) {
          ref.current.innerHTML = svg;
          setErr(null);
        }
      })
      .catch((e: Error) => alive && setErr(e.message.split('\n')[0]));
    return () => {
      alive = false;
    };
  }, [code, dark, id]);
  return (
    <div style={{ margin: '8px 0' }}>
      {err && <div className="alert error small">Diagram error: {err}</div>}
      <div ref={ref} />
    </div>
  );
}
