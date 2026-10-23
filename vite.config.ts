import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildAppHtml } from './server/mcp-resource.ts';

function staticAppResources(): Plugin {
  return {
    name: 'static-mcp-app-resources',
    apply: 'build',
    async generateBundle() {
      for (const layout of ['cards', 'list'] as const) {
        this.emitFile({
          type: 'asset',
          fileName: `mcp-app/${layout}.html`,
          source: await buildAppHtml(layout),
        });
      }
      this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: process.env.PAGES_BASE_PATH ?? '/',
  plugins: [react(), ...(mode === 'pages' ? [staticAppResources()] : [])],
  preview: { proxy: {} },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3100',
      '/mcp': 'http://127.0.0.1:3100',
    },
  },
}));
