import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildAppHtml } from './server/mcp-resource.ts';
import { loadRuntimeConfig } from './config/runtime.ts';

function instanceIdentity(instanceId: string): Plugin {
  return {
    name: 'lab-instance-identity',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: 'lab-instance-id', content: instanceId },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

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

export default defineConfig(({ mode }) => {
  const config = loadRuntimeConfig();
  return {
    root: config.rootDir,
    envDir: false,
    base: config.environment.PAGES_BASE_PATH ?? '/',
    define: { __LAB_INSTANCE_ID__: JSON.stringify(config.instanceId) },
    plugins: [
      react(),
      instanceIdentity(config.instanceId),
      ...(mode === 'pages' ? [staticAppResources()] : []),
    ],
    preview: {
      host: '127.0.0.1',
      port: config.previewPort,
      strictPort: true,
      // Vite otherwise inherits server.proxy and accidentally requires a local API.
      proxy: {},
    },
    server: {
      host: '127.0.0.1',
      port: config.webPort,
      strictPort: true,
      proxy: {
        '/api': config.apiOrigin,
        '/mcp': config.apiOrigin,
      },
    },
  };
});
