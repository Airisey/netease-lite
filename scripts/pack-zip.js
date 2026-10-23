#!/usr/bin/env node
/**
 * 把打包好的绿色版压成 zip（用于 GitHub Release 附件）。
 *
 *   node scripts/pack-zip.js                       # 输出到 D:\down\Tools\FromAI\_release\
 *   node scripts/pack-zip.js --out D:\somewhere    # 换输出目录
 *
 * 为什么单独写一个脚本、而不是每次手敲 tar：
 *
 * 成品目录里的 `resources/app/data/` 是**用户自己的运行时数据** ——
 * `config.json` 里存着登录 cookie（MUSIC_U）、音质、音量、播放队列，
 * 另外还有 `local-index.json`（本机音乐索引）和 `download-history.json`。
 * 直接 `tar -a -c -f x.zip 网易云音乐 Lite` 会把这些一起压进去，传到公开的
 * Release 就等于把账号会话发出去了。2026-10 就发生过一次，事后只能删附件重传。
 *
 * 所以这里把「排除 data 目录」写死，不给忘的机会。压缩包内保留顶层目录名
 * `网易云音乐 Lite/`，解压出来是一个完整文件夹，不会散一地。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const distParent = process.env.NETEASE_LITE_DIST || 'D:\\down\\Tools\\FromAI';
const folderName = '网易云音乐 Lite';
const srcDir = path.join(distParent, folderName);

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = pkg.version;

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 && argv[outIdx + 1]
  ? path.resolve(argv[outIdx + 1])
  : path.join(distParent, '_release');

if (!fs.existsSync(path.join(srcDir, '网易云音乐 Lite.exe'))) {
  console.error(`[zip] 找不到成品：${srcDir}\\网易云音乐 Lite.exe`);
  console.error('[zip] 先跑 node publish-release.mjs desktop');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `netease-lite-${version}-win-x64.zip`);
fs.rmSync(outFile, { force: true });

// --exclude 的匹配是相对归档内路径的，所以写成 */resources/app/data 这种形式。
const args = [
  '-a', '-c', '-f', outFile,
  '--exclude', '*/resources/app/data',
  '--exclude', '*/resources/app/data/*',
  '-C', distParent,
  folderName,
];

const t0 = Date.now();
const r = spawnSync('tar.exe', args, { stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`[zip] tar 失败（退出码 ${r.status}）`);
  process.exit(r.status || 1);
}

// 压完自检：只要还看得到 app/data 就说明排除没生效，宁可失败也别上传。
const list = spawnSync('tar.exe', ['-tf', outFile], { encoding: 'utf8' });
const entries = String(list.stdout || '').split(/\r?\n/).filter(Boolean);
const leaked = entries.filter((e) => /resources\/app\/data(\/|$)/.test(e));
if (leaked.length) {
  console.error(`[zip] 自检失败：包里仍有 ${leaked.length} 个 data 条目，已删除该包`);
  fs.rmSync(outFile, { force: true });
  process.exit(1);
}

const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[zip] 完成 ✔ ${outFile}`);
console.log(`[zip] ${mb} MB / ${entries.length} 条目 / ${secs}s（已排除 resources\\app\\data，不含登录态与本地索引）`);
