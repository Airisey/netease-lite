#!/usr/bin/env node
'use strict';
/**
 * Launcher for the Electron app.
 *
 * Three environment quirks have to be neutralised before Chromium will start:
 *
 *   1. ELECTRON_RUN_AS_NODE — if this is set in the parent environment,
 *      electron.exe behaves as a plain Node interpreter and `require('electron')`
 *      hands back a path string instead of the API, so main.js dies immediately.
 *   2. The Chromium sandbox cannot initialise on every Windows host (locked-down
 *      or virtualised machines die with STATUS_BREAKPOINT, exit 0x80000003 before
 *      any of our JS runs), so we pass --no-sandbox.
 *   3. The user-data directory must already exist before Electron boots. Chromium
 *      creates its profile lock during early startup and aborts the whole process
 *      with an access violation (0xC0000005) when that directory cannot be made;
 *      an `app.setPath('userData')` inside main.js runs too late to help. Plain
 *      Node is not subject to the same restriction, so we prepare the directory
 *      here and pass it down with --user-data-dir.
 *
 * Usage: node scripts/start.js [--dev] [-- <extra electron args>]
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const projectRoot = path.resolve(__dirname, '..');

function electronBinary() {
  // Prefer the vendored dist so we never depend on electron's own resolution.
  const exe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(exe)) return exe;
  // Fall back to the package's recorded path.
  try {
    return require(path.join(projectRoot, 'node_modules', 'electron'));
  } catch {
    throw new Error('未找到 Electron，请先运行 npm install');
  }
}

/**
 * Resolve a writable profile directory and make sure it exists *now*.
 * Mirrors the candidate order used by electron/main.js so both agree on where
 * the login and settings live.
 *
 * The app-local `data` folder comes first so the client is portable: copying the
 * folder carries the login with it, and it is the only location guaranteed to be
 * writable when the app runs inside a restricted environment. The roaming
 * profile is the fallback for read-only install locations.
 */
function prepareUserDataDir() {
  const candidates = [
    path.join(projectRoot, 'data'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'NeteaseLite'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'NeteaseLite'),
    path.join(os.tmpdir(), 'NeteaseLite'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try the next candidate */ }
  }
  console.error('[start] 找不到可写的用户数据目录，登录状态将无法保存');
  return null;
}

const passthrough = process.argv.slice(2);
const dev = passthrough.includes('--dev');
const extra = passthrough.filter((a) => a !== '--dev');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Keep the crash reporter quiet; we log renderer errors ourselves.
env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

const userDataDir = prepareUserDataDir();
// Let a caller override the profile location (useful for tests and for keeping
// several accounts side by side).
const explicitUserData = extra.find((a) => a.startsWith('--user-data-dir'));

const args = [
  projectRoot,
  '--no-sandbox',
  // The GPU stack is unavailable on some VMs and just adds startup noise.
  ...(process.env.DSH_NO_GPU ? ['--disable-gpu'] : []),
  ...(userDataDir && !explicitUserData ? [`--user-data-dir=${userDataDir}`] : []),
  ...(dev ? ['--dev'] : []),
  ...extra,
];

if (dev && userDataDir) console.log('[start] userData =', userDataDir);

const child = spawn(electronBinary(), args, {
  stdio: 'inherit',
  env,
  cwd: projectRoot,
});

child.on('exit', (code) => process.exit(code == null ? 0 : code));
child.on('error', (e) => {
  console.error('[start] 启动 Electron 失败:', e.message);
  process.exit(1);
});
