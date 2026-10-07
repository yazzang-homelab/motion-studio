// Live preview server: serves the project over http (ES modules + fetch need it) and prints one link per format.
import { spawn } from 'node:child_process';
import { FORMATS, UsageError, isMainModule, loadConfig, log, main, parseArgs, projectRoot, startServer, usage } from './studio.mjs';

export const DEFAULT_PORT = 4178;

export const SPEC = {
  port: { type: 'number', arg: '<n>', desc: `Port on 127.0.0.1 (default ${DEFAULT_PORT}, falls back to a free port; 0 = any)` },
  open: { type: 'boolean', desc: 'Open the primary-format link in the default browser' },
  json: { type: 'boolean', desc: 'Print one JSON line with the links, then keep serving' },
};

const TITLE = `Usage: node tools/serve.mjs [--open] [--port N]

Preview the film in a normal browser: Space play/pause, arrows step frames, Shift+arrows step beats,
[ ] jump shots, F cycles formats, G toggles safe-area guides. Ctrl+C stops the server.`;

/** Open a URL with the OS default handler; detached and silent on failure (preview still works via the printed link). */
export function openUrl(url) {
  try {
    const child = process.platform === 'win32'
      // Verbatim args: cmd.exe does not understand Node's MSVCRT quoting; the empty title keeps `start` from eating the URL.
      ? spawn('cmd', ['/d', '/c', 'start', '""', url.replace(/[&^|<>]/g, '^$&')], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* no opener available */ }
}

async function cli(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  if (flags.port !== undefined && !(Number.isInteger(flags.port) && flags.port >= 0 && flags.port <= 65535))
    throw new UsageError(`--port must be an integer 0-65535 (got ${flags.port})`);
  const root = projectRoot();
  const cfg = loadConfig(root);
  let server;
  try {
    server = await startServer(root, { port: flags.port ?? DEFAULT_PORT });
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || flags.port !== undefined) throw err;
    server = await startServer(root, { port: 0 });
    log(`port ${DEFAULT_PORT} is busy; using ${server.port}`);
  }
  const links = Object.fromEntries(cfg.formats.map((f) => [f, `${server.url}/index.html?format=${f}`]));
  const primary = links[cfg.primaryFormat];
  if (flags.json) process.stdout.write(JSON.stringify({ ok: true, url: server.url, primary, links }) + '\n');
  else {
    const w = Math.max(...cfg.formats.map((f) => (FORMATS[f]?.label ?? f).length));
    log(`motion-studio preview: ${cfg.title} (${root})`);
    for (const f of cfg.formats) log(`  ${(FORMATS[f]?.label ?? f).padEnd(w)}  ${links[f]}${f === cfg.primaryFormat ? '   (primary)' : ''}`);
    log('Ctrl+C stops the server.');
  }
  if (flags.open) openUrl(primary);
  const stop = () => { server.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return undefined;
}

if (isMainModule(import.meta.url)) main(() => cli(process.argv.slice(2)));
