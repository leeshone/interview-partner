// Monaco, bundled locally (no CDN) so the editor also works offline.
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};
loader.config({ monaco });

export default function CodeEditor({ value, onChange, language, dark }: { value: string; onChange: (v: string) => void; language: string; dark: boolean }) {
  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <Editor
        height="100%"
        language={language}
        value={value}
        theme={dark ? 'vs-dark' : 'vs'}
        onChange={(v) => onChange(v ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 4,
          wordWrap: 'on',
          padding: { top: 12 },
          // Interview-realistic: no autocomplete "help".
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          parameterHints: { enabled: false },
          renderValidationDecorations: 'off',
        }}
      />
    </div>
  );
}
