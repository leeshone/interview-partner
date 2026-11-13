import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation, Link } from 'react-router-dom';
import { CHAT_MODELS, TTS_VOICES } from '../shared/types';
import { api, type ModelInfo } from './lib/api';
import { Setup } from './pages/Setup';
import { Interview } from './pages/Interview';
import { Report } from './pages/Report';
import { History } from './pages/History';
import { Progress } from './pages/Progress';
import { Icon } from './components/Icon';

// ---------------------------------------------------------------------------
// Settings (per browser)
// ---------------------------------------------------------------------------

export interface Settings {
  model: string;
  voice: string; // '' = persona default
  autoSpeak: boolean;
  theme: 'system' | 'light' | 'dark';
}
const DEFAULT_SETTINGS: Settings = { model: CHAT_MODELS[0].id, voice: '', autoSpeak: true, theme: 'system' };

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('ip.settings') || '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface AppCtx {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  models: ModelInfo[];
  toast: (text: string, kind?: 'info' | 'error') => void;
  openSettings: () => void;
}
const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

export function fmtPrice(p: ModelInfo['pricing']) {
  if (!p) return '';
  return `$${p.input.toFixed(p.input < 1 ? 2 : 0)} in / $${p.output.toFixed(p.output < 1 ? 2 : 0)} out per 1M tokens`;
}

// ---------------------------------------------------------------------------

export function App() {
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [models, setModels] = useState<ModelInfo[]>(CHAT_MODELS.map((m) => ({ ...m, pricing: null })));
  const [hasRealKey, setHasRealKey] = useState<boolean | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: 'info' | 'error' }[]>([]);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem('ip.settings', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const toast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.filter((x) => x.text !== text), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setModels(c.models);
        setHasRealKey(c.hasRealKey);
      })
      .catch((e) => toast(e.message, 'error'));
  }, [toast]);

  const ctx = useMemo<AppCtx>(() => ({ settings, setSettings, models, toast, openSettings: () => setDrawer(true) }), [settings, setSettings, models, toast]);
  const inInterview = location.pathname.startsWith('/interview/');

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <Link to="/" className="brand">
            <span className="brand-mark">
              <Icon name="chat" size={16} />
            </span>
            <span className="brand-name">Interview Partner</span>
          </Link>
          <nav className="nav">
            <NavLink to="/" end>
              Practice
            </NavLink>
            <NavLink to="/history">History</NavLink>
            <NavLink to="/progress">Progress</NavLink>
          </nav>
          <button className="btn ghost icon" onClick={() => setDrawer(true)} aria-label="Settings" title="Settings">
            <Icon name="settings" />
          </button>
        </header>
        <main className={inInterview ? 'main wide' : 'main'}>
          <Routes>
            <Route path="/" element={<Setup />} />
            <Route path="/interview/:id" element={<Interview />} />
            <Route path="/report/:id" element={<Report />} />
            <Route path="/history" element={<History />} />
            <Route path="/progress" element={<Progress />} />
            <Route path="*" element={<div className="empty">Page not found. <Link to="/">Start practising</Link></div>} />
          </Routes>
        </main>
      </div>

      {drawer && (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
          <aside className="drawer" role="dialog" aria-label="Settings">
            <div className="row" style={{ marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Settings</h2>
              <span className="spacer" />
              <button className="btn ghost icon" onClick={() => setDrawer(false)} aria-label="Close">
                <Icon name="x" />
              </button>
            </div>
            <div className="stack">
              <label className="field">
                <span>Interviewer model</span>
                <select value={settings.model} onChange={(e) => setSettings({ model: e.target.value })}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <div className="tiny faint" style={{ marginTop: 6 }}>
                  {fmtPrice(models.find((m) => m.id === settings.model)?.pricing ?? null)}
                  <br />
                  Used for the interviewer and the feedback. Applies to new interviews and to the one in progress. If a model is unavailable, the app falls back to the next one automatically.
                </div>
              </label>
              <label className="field">
                <span>Interviewer voice</span>
                <select value={settings.voice} onChange={(e) => setSettings({ voice: e.target.value })}>
                  <option value="">Persona default</option>
                  {TTS_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v[0].toUpperCase() + v.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.autoSpeak} onChange={(e) => setSettings({ autoSpeak: e.target.checked })} />
                <span>Speak interviewer replies aloud</span>
              </label>
              <div className="field">
                <span style={{ display: 'block', fontWeight: 560, marginBottom: 6, fontSize: '0.92rem' }}>Theme</span>
                <div className="segmented">
                  {(['system', 'light', 'dark'] as const).map((t) => (
                    <button key={t} className={settings.theme === t ? 'on' : ''} onClick={() => setSettings({ theme: t })}>
                      {t[0].toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="alert info small">
                <Icon name="key" size={16} />
                <div>
                  {hasRealKey
                    ? 'The server is using HOPSCOTCH_API_KEY from its environment.'
                    : 'No HOPSCOTCH_API_KEY is set, so the server sends a placeholder. That works where a proxy adds credentials (as in the Claude Code cloud environment). On your own machine, set HOPSCOTCH_API_KEY in .env.'}
                </div>
              </div>
            </div>
          </aside>
        </>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            <span>{t.text}</span>
            <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal" role="dialog">
        {children}
      </div>
    </>
  );
}
