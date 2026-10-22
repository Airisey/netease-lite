#!/usr/bin/env node
'use strict';
/**
 * Build a portable Windows distribution.
 *
 * The app itself has no runtime npm dependencies — the only third-party library
 * (qrcode-generator) is vendored into renderer/js/vendor — so packaging is just
 * "copy the Electron runtime, then drop our sources into resources/app".
 * No asar, no bundler, no electron-builder: the result is a folder the user can
 * move anywhere and run, and the source stays readable for debugging.
 *
 * Usage: node scripts/build.js [输出目录]
 *
 * 输出位置默认是 D:\down\Tools\FromAI（用户放成品的地方），不再写进项目里的
 * dist\。原因：绿色版是 330 MB 级别的产物，留在工作区里既拖慢文件扫描，也会
 * 让「源码树」和「构建产物」混在一起 —— 用户明确要求成品不要留在默认工作区。
 * 需要临时改到别处时用第一个参数，或设 NETEASE_LITE_DIST 环境变量覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

// 成品目录：命令行参数 > 环境变量 > 默认值。解析成绝对路径，这样从任何
// 工作目录调用 build.js 的结果都一样。
const DEFAULT_DIST_PARENT = 'D:\\down\\Tools\\FromAI';
const distParent = path.resolve(
  process.argv[2] || process.env.NETEASE_LITE_DIST || DEFAULT_DIST_PARENT
);

const APP_NAME = '网易云音乐 Lite';
const outDir = path.join(distParent, APP_NAME);
const appDir = path.join(outDir, 'resources', 'app');
const electronDist = path.join(projectRoot, 'node_modules', 'electron', 'dist');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (filter && !filter(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Read the portable build's saved settings (login cookie, quality, volume)
 * before the output directory is wiped, so a rebuild does not log the user out.
 * Falls back to the source-tree profile, then to a probe backup.
 */
function readSavedConfig() {
  const candidates = [
    path.join(appDir, 'data', 'config.json'),
    path.join(projectRoot, 'data', 'config.json'),
    path.join(projectRoot, '_probe', 'user-config-backup.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.cookie) return { file: p, data: j };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Turn the copied Electron runtime into a single obviously-named executable.
 *
 * Electron has to keep its resources next to a binary called electron.exe, but
 * shipping that name in the finished product is confusing: the folder used to
 * contain electron.exe (the real app), a compiled launcher "网易云音乐 Lite.exe"
 * (what you actually double-clicked) and a 启动.bat — three ways in, and the two
 * obvious ones behaved differently.
 *
 * So: rename electron.exe to the product name and give it the product's icon and
 * version info directly, via PE resource editing. Electron locates resources by
 * the *directory* it runs from (resources/app, resources/*.pak, locales/, the
 * DLLs), not by its own file name, so a renamed binary starts exactly the same.
 *
 * The C# launcher is gone with it. Its two jobs — exporting
 * ELECTRON_DISABLE_SANDBOX before Chromium initialises the sandbox, and creating
 * the profile directory before Electron starts — both turned out to be
 * unnecessary here: main.js sets the sandbox switch via app.commandLine and
 * creates the profile directory itself (see resolveUserDataDir), which was
 * verified by launching the renamed exe with no arguments and no
 * --user-data-dir and watching it come up with a working profile.
 *
 * resedit is a devDependency, loaded lazily and as ESM: its CommonJS entry point
 * only exposes { load }, so `require('resedit')` would not give us the
 * constructors.
 */
async function renameAndBrandExe(outDir) {
  const oldExe = path.join(outDir, 'electron.exe');
  const newExe = path.join(outDir, APP_NAME + '.exe');

  if (!fs.existsSync(oldExe)) {
    throw new Error('未找到 ' + oldExe + '（Electron 运行时结构变了？）');
  }
  fs.renameSync(oldExe, newExe);

  let ResEdit;
  try {
    ResEdit = await import('resedit');
  } catch {
    throw new Error('缺少 resedit，请先运行: npm install');
  }

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(newExe));
  const res = ResEdit.NtExecutableResource.from(exe);

  // 1) Icon. Replace icon group 1 (the one Explorer, the taskbar and
  //    Alt-Tab all read) with every size in our .ico.
  const ico = path.join(projectRoot, 'renderer', 'assets', 'icon.ico');
  if (fs.existsSync(ico)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, 1, 1033, iconFile.icons.map((i) => i.data)
    );
    console.log('[build] 写入图标  :', iconFile.icons.length, '档',
      iconFile.icons.map((i) => (i.width || 256) + 'px').join('/'));
  } else {
    console.warn('[build] 未找到图标，跳过:', ico);
  }

  // 2) Version info, so the exe describes itself in Explorer's Details tab
  //    instead of showing Electron's own name and version.
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = pkg.version || '1.0.0';
  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = viList.length ? viList[0] : ResEdit.Resource.VersionInfo.createEmpty();
  // Write into whatever language tables already exist (Electron ships en-US);
  // createEmpty() has none, so fall back to en-US Unicode.
  const langs = vi.getAllLanguagesForStringValues();
  const tr = langs.length ? langs[0] : { lang: 1033, codepage: 1200 };
  for (const [key, value] of Object.entries({
    ProductName: APP_NAME,
    FileDescription: APP_NAME,
    InternalName: APP_NAME,
    OriginalFilename: APP_NAME + '.exe',
    CompanyName: 'netease-lite',
    LegalCopyright: '© netease-lite',
  })) {
    vi.setStringValue(tr, key, value, true);
  }
  // setStringValue does not touch the numeric file/product version, so set it too.
  vi.setFileVersion(version, tr.lang);
  vi.setProductVersion(version, tr.lang);
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(newExe, Buffer.from(exe.generate()));

  // Electron also keeps a copy of its own name in these; left alone the app
  // would still say "electron.exe" in a couple of places.
  console.log('[build] 可执行文件:', path.basename(newExe),
    '(' + (fs.statSync(newExe).size / 1024 / 1024).toFixed(1) + ' MB, v' + version + ')');
}

/**
 * Nudge the Windows shell into re-reading the exe's icon after a rebuild.
 *
 * Explorer keys its icon cache by *path*, not by content. The finished folder is
 * rebuilt in place, so the exe keeps the same path every time — and Explorer can
 * happily keep serving whatever icon it cached the first time it ever saw that
 * path. That is why a rebuild carrying a brand-new icon.ico can still show the
 * old artwork in a window that is already open: the exe is correct all along
 * (verified byte-for-byte against the .ico's RT_ICON entries, and pixel-identical
 * to what the shell returns once the cache is dropped), only the shell's copy is
 * stale.
 *
 * ie4uinit.exe -show is the long-standing way to make the shell drop and rebuild
 * its per-user icon cache. Best-effort on purpose: the artifacts are already
 * complete by the time this runs, so a missing binary or a locked cache must
 * never fail the build.
 */
function refreshShellIconCache() {
  if (process.platform !== 'win32') return;
  const { spawnSync } = require('node:child_process');
  try {
    const r = spawnSync('ie4uinit.exe', ['-show'], { stdio: 'ignore', timeout: 15000 });
    if (r.status === 0) console.log('[build] 刷新图标缓存: 已通知资源管理器重新读取');
    else console.warn('[build] 刷新图标缓存返回', r.status, '（不影响构建，图标本身已写入）');
  } catch {
    console.warn('[build] 刷新图标缓存不可用（不影响构建，图标本身已写入）');
  }
}

/**
 * Strip the Mark-of-the-Web from everything this build produced (m36690 第⑧点).
 *
 * When a file arrives from the Internet — a downloaded zip, an attachment, a
 * folder copied out of a chat client — Windows attaches a `Zone.Identifier`
 * alternate data stream holding `ZoneId=3`. That stream, not the missing code
 * signature, is what makes double-clicking the exe raise 「打开文件 - 安全警告 /
 * 来自 Internet 的文件可能对你有所帮助」. Users read that dialog as "this is a
 * virus", and the only way past it is a checkbox most people never find.
 *
 * The build output is assembled locally, so a freshly built folder is normally
 * clean already — but the *default* delivery path is "zip it and send it", and
 * whoever unzips it inherits the tags. Removing them here means the folder is
 * clean before it is ever packed, and re-running the build also repairs an
 * already-tagged dist folder in place.
 *
 * `:Zone.Identifier` is addressed as a path suffix: Node maps `file:stream` onto
 * the Win32 stream syntax, so no native module is needed. A file without the
 * stream throws ENOENT, which is the common case and not an error.
 */
function stripMotw(dir) {
  if (process.platform !== 'win32') return 0;
  let cleaned = 0;
  const walk = (p) => {
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) { walk(q); continue; }
      try {
        fs.rmSync(q + ':Zone.Identifier');
        cleaned++;
      } catch { /* ENOENT: this file was never tagged — the normal case */ }
    }
  };
  walk(dir);
  return cleaned;
}

/**
 * The same treatment for a Start Menu / Desktop shortcut pointing at this build.
 *
 * The reported dialog named `...\Start Menu\Programs\网易云音乐 Lite.lnk`, not the
 * exe: a shortcut created *from* a tagged folder is itself tagged, and Windows
 * then warns every single time it is double-clicked. The shortcut lives outside
 * the output directory and this script does not create it, so it cannot be
 * cleaned by the recursive pass above.
 *
 * Shortcuts are matched by exact file name rather than by resolving their
 * target: parsing a .lnk means either a COM call or a binary parser, and the
 * product name is already unique on this machine. Best-effort throughout —
 * the all-users Start Menu needs administrator rights to modify, and a build
 * must never fail because it could not tidy someone's shortcut.
 */
function stripMotwFromShortcuts() {
  if (process.platform !== 'win32') return 0;
  const name = APP_NAME + '.lnk';
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData',
      'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '',
      'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.USERPROFILE || '', 'Desktop'),
    'C:\\Users\\Public\\Desktop',
  ];
  let cleaned = 0;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const walk = (p) => {
      let entries;
      try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) { walk(q); continue; }
        if (e.name !== name) continue;
        try {
          fs.rmSync(q + ':Zone.Identifier');
          cleaned++;
          console.log('[build] 已去掉快捷方式的安全警告标记:', q);
        } catch { /* ENOENT = 本来就没被标记；EACCES = 需要管理员权限 */ }
      }
    };
    walk(root);
  }
  return cleaned;
}

async function main() {
  if (!fs.existsSync(electronDist)) {
    console.error('[build] 未找到 Electron 运行时:', electronDist);
    console.error('[build] 请先运行: npm install');
    process.exit(1);
  }

  // The portable build keeps its login inside resources/app/data/config.json.
  // rmrf(outDir) below would delete it and silently log the user out on every
  // rebuild, so read it out first and write it back at the end.
  const savedConfig = readSavedConfig();

  console.log('[build] 清理输出目录 ...');
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('[build] 复制 Electron 运行时 ...');
  copyDir(electronDist, outDir);

  // Drop the bundled demo app so ours is the only one Electron can find.
  rmrf(path.join(outDir, 'resources', 'default_app.asar'));

  // Electron writes these beside the exe when it is run from the build folder
  // during testing; they are not part of a clean distribution.
  for (const stray of fs.readdirSync(outDir)) {
    if (/^_\w+\.log$/i.test(stray)) rmrf(path.join(outDir, stray));
  }

  console.log('[build] 复制应用源码 ...');
  for (const dir of ['electron', 'renderer', 'scripts']) {
    copyDir(path.join(projectRoot, dir), path.join(appDir, dir));
  }
  for (const file of ['package.json']) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(appDir, file));
  }

  // Put the README where someone unzipping the portable build will actually see
  // it, not only inside resources/app.
  fs.copyFileSync(path.join(projectRoot, 'README.md'), path.join(outDir, 'README.md'));

  // Rename electron.exe to the product name and give it our icon and version
  // info. Must run after the runtime copy above and before the size report.
  console.log('[build] 重命名并写入图标/版本信息 ...');
  await renameAndBrandExe(outDir);

  // A convenience .bat beside the exe, for people who keep a terminal open.
  //
  // The script must stay pure ASCII: cmd.exe reads .bat files in the OEM code
  // page (936 on a Chinese system), so writing the product's Chinese file name
  // here would come out as mojibake and the `start` would fail. It therefore
  // discovers the exe with a wildcard — after renameAndBrandExe there is exactly
  // one .exe in the folder, and this file is not one of them.
  const launcher = [
    '@echo off',
    'rem ============================================================',
    'rem  NetEase Cloud Music Lite - Windows launcher',
    'rem  Double-click the .exe in this folder, or run this file.',
    'rem ============================================================',
    'setlocal',
    'cd /d "%~dp0"',
    '',
    'set ELECTRON_DISABLE_SECURITY_WARNINGS=1',
    'rem Some shells export this; it turns the exe into a plain Node',
    'rem interpreter and the app would exit immediately.',
    'set ELECTRON_RUN_AS_NODE=',
    '',
    'set "EXE="',
    'for %%F in ("*.exe") do if not defined EXE set "EXE=%%~fF"',
    'if not defined EXE (',
    '  echo [ERROR] No .exe found next to this script.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'start "" "%EXE%" %*',
    'endlocal',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(outDir, '启动.bat'), launcher, 'utf8');

  // A portable build keeps its profile (and therefore the login) inside the
  // folder; create it up front because Electron cannot create it itself.
  const dataDir = path.join(appDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Put the user's saved login/settings back so the rebuilt folder is a drop-in
  // replacement rather than something that asks them to scan a QR code again.
  if (savedConfig) {
    fs.writeFileSync(path.join(dataDir, 'config.json'),
      JSON.stringify(savedConfig.data, null, 2), 'utf8');
    const nick = (savedConfig.data.profile && savedConfig.data.profile.nickname) || '(未登录)';
    console.log(`[build] 保留登录状态 <- ${path.relative(projectRoot, savedConfig.file)} (${nick})`);
  } else {
    console.log('[build] 未找到已保存的登录状态，首次运行需扫码登录');
  }

  const size = (dir) => {
    let total = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q);
        else total += fs.statSync(q).size;
      }
    };
    walk(dir);
    return total;
  };

  console.log('\n[build] 完成 ✔');
  console.log('[build] 输出目录:', outDir);
  console.log('[build] 总大小  :', (size(outDir) / 1024 / 1024).toFixed(1), 'MB');
  console.log('[build] 启动方式: 双击「' + APP_NAME + '.exe」');

  // Last, so it also covers a run that changed nothing: the shell may still be
  // holding an icon for this path from an earlier build.
  refreshShellIconCache();

  // 第⑧点：去掉 Mark-of-the-Web，否则双击启动会弹「打开文件 - 安全警告」。
  // 放在最后：前面所有写文件的操作都已经结束，不会再引入新的标记。
  const motwFiles = stripMotw(outDir);
  const motwLinks = stripMotwFromShortcuts();
  if (motwFiles || motwLinks) {
    console.log(`[build] 已清除下载来源标记: ${motwFiles} 个文件, ${motwLinks} 个快捷方式`);
  } else {
    console.log('[build] 下载来源标记: 干净（无需清除）');
  }
}

main().catch((err) => {
  console.error('\n[build] 失败:', err && err.message ? err.message : err);
  process.exit(1);
});
