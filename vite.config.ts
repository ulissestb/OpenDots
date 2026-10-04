import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const vendor = (packages: string) =>
  new RegExp(`node_modules[\\\\/](${packages})[\\\\/]`);
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    rolldownOptions: {
      output: {
        // Stable vendor chunks cache across app releases. Only modules the
        // first page needs ($initial) are grouped, so lazy code (TipTap behind
        // the page editor, CopilotKit's on-demand renderers) stays lazy.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: vendor('react|react-dom|scheduler'),
              tags: ['$initial'],
              priority: 30,
            },
            {
              name: 'copilotkit',
              test: vendor('@copilotkit|@ag-ui'),
              tags: ['$initial'],
              priority: 20,
            },
            {
              name: 'icons',
              test: vendor('lucide-react'),
              tags: ['$initial'],
              priority: 10,
            },
            {
              name: 'tiptap',
              test: vendor('@tiptap|prosemirror-[^\\\\/]+'),
              priority: 5,
            },
          ],
        },
      },
    },
  },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
