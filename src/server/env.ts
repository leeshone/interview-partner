// Load .env (if present) before anything reads process.env.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

// Hide two harmless startup notices: node:sqlite and the env-proxy agent are flagged "experimental".
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  if ((w as Error & { code?: string }).code === 'UNDICI-EHPA') return; // env-proxy support notice
  for (const l of defaultWarningListeners) l(w);
});
