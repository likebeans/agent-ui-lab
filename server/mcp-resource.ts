import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const appEntry = fileURLToPath(new URL('../src/mcp-app.ts', import.meta.url));
type AppLayout = 'cards' | 'list';
let appBundlePromise: Promise<string> | undefined;

function buildAppBundle(): Promise<string> {
  if (!appBundlePromise) {
    appBundlePromise = build({
      entryPoints: [appEntry],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
      minify: true,
      legalComments: 'none',
    })
      .then((result) => {
        const javascript = result.outputFiles[0]?.text;
        if (!javascript) throw new Error('MCP App bundle 为空。');
        return javascript.replace(/<\/script/gi, '<\\/script');
      })
      .catch((error) => {
        appBundlePromise = undefined;
        throw error;
      });
  }
  return appBundlePromise;
}

export async function buildAppHtml(layout: AppLayout): Promise<string> {
  return renderAppDocument(await buildAppBundle(), layout);
}

function renderAppDocument(javascript: string, layout: AppLayout): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>城市活动选择器</title>
  <style>
    :root{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#202332;background:#fff;color-scheme:light;--bg:#fff;--soft:#f7f7fb;--text:#202332;--muted:#677083;--border:#e4e6ec;--accent:#6f4b24;--accent-soft:#fbf1e5;--ok:#23785e;--danger:#b13d4a}
    @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color:#ececf5;background:#1d1f2a;color-scheme:dark;--bg:#1d1f2a;--soft:#252733;--text:#ececf5;--muted:#b0b5c6;--border:#3a3d4d;--accent:#edbf88;--accent-soft:#3c3125;--ok:#8bd2af;--danger:#ffa5af}}
    :root[data-theme="dark"]{color:#ececf5;background:#1d1f2a;color-scheme:dark;--bg:#1d1f2a;--soft:#252733;--text:#ececf5;--muted:#b0b5c6;--border:#3a3d4d;--accent:#edbf88;--accent-soft:#3c3125;--ok:#8bd2af;--danger:#ffa5af}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button{font:inherit}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.app{padding:22px;min-height:320px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.eyebrow{font-size:10px;letter-spacing:.12em;color:var(--accent);font-weight:700}.top h1{font-size:22px;margin:7px 0 5px;line-height:1.35}.top p{margin:0;color:var(--muted);font-size:12px;line-height:1.7}.fixture{font-size:10px;white-space:nowrap;border:1px solid var(--border);background:var(--soft);padding:6px 8px;border-radius:6px;color:var(--muted)}.status{margin:18px 0 14px;padding:10px 12px;border:1px solid var(--border);border-radius:7px;background:var(--soft);color:var(--muted);font-size:11px;line-height:1.6}.status.error{color:var(--danger)}.cities{display:flex;gap:8px;flex-wrap:wrap}.city{min-height:40px;padding:8px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);cursor:pointer}.city:hover:not(:disabled),.city[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}.city:disabled{cursor:not-allowed;opacity:.5}.heading{display:flex;align-items:end;justify-content:space-between;gap:12px;margin:20px 0 10px}.heading h2{font-size:15px;margin:0}.heading span{font-size:10px;color:var(--muted)}.activities{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.activity{border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--soft)}.activity strong{display:block;font-size:12px;line-height:1.5}.activity p{margin:7px 0;color:var(--muted);font-size:11px;line-height:1.65}.layout-list .activities{grid-template-columns:1fr}.layout-list .activity{display:grid;grid-template-columns:minmax(140px,.7fr) minmax(0,1.7fr) auto;align-items:center;gap:12px}.layout-list .activity p{margin:0}.layout-list .meta{justify-content:flex-end}.meta{display:flex;gap:7px;flex-wrap:wrap;color:var(--accent);font-size:9px}.empty{padding:24px;border:1px dashed var(--border);border-radius:8px;color:var(--muted);text-align:center;font-size:12px}.retry{margin-top:9px;min-height:36px;border:1px solid var(--danger);color:var(--danger);background:transparent;border-radius:7px;padding:7px 12px;cursor:pointer}.foot{margin-top:15px;padding-top:12px;border-top:1px solid var(--border);color:var(--muted);font-size:9px;line-height:1.7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
    @media(max-width:560px){.app{padding:17px}.top{display:block}.fixture{display:inline-block;margin-top:10px}.activities{grid-template-columns:1fr}.layout-list .activity{display:block}.layout-list .activity p{margin:7px 0}.layout-list .meta{justify-content:flex-start}.city{flex:1;min-width:82px}.top h1{font-size:20px}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style>
</head>
<body>
  <!-- intelligent-ui-lab:mcp-trip-picker -->
  <div id="app" data-layout="${layout}" aria-busy="true"></div>
  <script>${javascript}</script>
</body>
</html>`;
}
