import type * as Monaco from 'monaco-editor';

export type MonacoApi = typeof Monaco;

let loader: Promise<MonacoApi> | undefined;

/**
 * Lazy-load Monaco as its own chunk and configure it once: worker wiring for
 * the esbuild bundler and the Pear theme (hex approximations of the oklch
 * design tokens).
 */
export function loadMonaco(): Promise<MonacoApi> {
  if (!loader) {
    loader = (async () => {
      (self as { MonacoEnvironment?: Monaco.Environment }).MonacoEnvironment = {
        getWorker: () =>
          new Worker(new URL('./editor.worker', import.meta.url), { type: 'module' }),
      };
      const monaco = await import('monaco-editor');
      monaco.editor.defineTheme('pear-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '7b8087', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'a3b3e8' },
          { token: 'string', foreground: '9ed3a8' },
          { token: 'number', foreground: 'e0b380' },
          { token: 'variable', foreground: 'e0a291' },
          { token: 'type', foreground: '8ad1cb' },
        ],
        colors: {
          'editor.background': '#212429',
          'editor.foreground': '#f3f4f6',
          'editorLineNumber.foreground': '#565b63',
          'editorLineNumber.activeForeground': '#c6c9ce',
          'editor.lineHighlightBackground': '#282b31',
          'editor.selectionBackground': '#7ab8b340',
          'editorCursor.foreground': '#7ab8b3',
          'editorWidget.background': '#1c1f24',
          'editorWidget.border': '#3a3e45',
          'scrollbarSlider.background': '#3a3e4580',
          'scrollbarSlider.hoverBackground': '#4a4f57b0',
        },
      });
      return monaco;
    })();
  }
  return loader;
}
