'use strict';
/**
 * Main process: window, IPC bridge to the NetEase API, image proxy, config store.
 *
 * The renderer is sandboxed with contextIsolation and talks to us only through
 * `window.ne` (see preload.js). No Node APIs leak into the page.
 */
const { app, BrowserWindow, ipcMain, protocol, shell, net, screen, dialog, Notification, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { Netease, QUALITY } = require('./api/endpoints.js');
const { Downloader } = require('./download.js');
const { LocalIndex } = require('./local.js');

// ---------------------------------------------------------------- profile dir
//
// Where the login and settings live. The portable build keeps them inside the
// folder (resources/app/data) so the whole thing stays copyable; that is the
// first candidate and the one that always wins in practice.
//
// This used to be described as "the launcher creates the directory because
// Chromium aborts with 0xC0000005 if it cannot create its own profile dir".
// That turned out not to be the case here: mkdirSync below runs before any
// window is created and is enough on its own, which was confirmed by launching
// the packaged exe with no arguments at all and watching it create
// resources/app/data and come up logged in. The fallback candidates only matter
// if the app folder itself is read-only.
//
// `app.getPath('userData')` is only safe once that directory exists; if it does
// not, calling it would take the process down, so it is wrapped.
function resolveUserDataDir() {
  const appRoot = path.join(__dirname, '..');
  const candidates = [
    path.join(appRoot, 'data'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'NeteaseLite'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'NeteaseLite'),
    path.join(require('node:os').tmpdir(), 'NeteaseLite'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try the next candidate */ }
  }
  return null;
}

const userDataDir = resolveUserDataDir();
if (userDataDir) {
  try {
    app.setPath('userData', userDataDir);
    app.setPath('sessionData', userDataDir);
  } catch { /* already set by an explicit --user-data-dir */ }
} else {
  console.error('[main] 找不到可写的用户数据目录，登录状态将无法保存');
}

// `neimg://` lets the page show NetEase CDN art without ever hitting a
// referer/CORS wall: we fetch in the main process and stream bytes back.
protocol.registerSchemesAsPrivileged([
  { scheme: 'neimg', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } },
]);

const ne = new Netease();

// 皮肤 id → 窗口首帧底色。加皮肤时这里要跟着加，否则冷启动会闪一下经典黑的深灰。
// 取值与 skins.css / mini.css 里各皮肤的 --bg-0 对齐。
const SKIN_BG = {
  classic: '#1a1a1c',
  light: '#f6f7f9',
  swiss: '#f5f2eb',
  sunset: '#121010',
  arcade: '#f7f8f3',
};
const SKIN_IDS = Object.keys(SKIN_BG);

let mainWindow = null;
let config = {
  cookie: '',
  quality: 'exhigh',
  volume: 0.7,
  muted: false,
  // 皮肤：'classic'（经典黑，默认）| 'light'（现代白）| 'swiss'（瑞士风）
  //      | 'sunset'（落日余晖）| 'arcade'（街机风）
  skin: 'classic',
  // 设置页里那些开关，见 renderer/js/settings.js 的 DEFAULTS
  settings: {},
  // 左侧栏个性化：被隐藏的 data-side 键名
  sideHidden: [],
  // 缓存目录（第 13 点）。空串 = 跟随 Electron 默认位置（userData 下的 Cache）。
  // 它必须在 app ready 之前交给 app.setPath('cache')，所以是在模块加载阶段读的，
  // 不能等到 whenReady 里的 loadConfig()。
  cacheDir: '',
  // 下载（第 5 点）：{ dir, quality, organize, template }
  // dir 空串 = 系统的「音乐」文件夹；organize: none | artist | album
  download: {},
};
let configPath = userDataDir ? path.join(userDataDir, 'config.json') : '';

// ---------------------------------------------------------------- config

function loadConfig() {
  try {
    let raw = fs.readFileSync(configPath, 'utf8');
    // 外部编辑器 / PowerShell 的 Set-Content 会写 UTF-8 BOM，JSON.parse 会直接抛错，
    // 而这里的 catch 是「首次运行」用的，会把损坏的配置静默当成空配置（丢失登录态）。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    Object.assign(config, JSON.parse(raw));
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.error('[config] load failed:', e.message);
  }
  if (config.cookie) ne.setCookieString(config.cookie);
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      console.error('[config] save failed:', e.message);
    }
  }, 250);
}

// ---------------------------------------------------------------- 缓存目录（第 13 点）
//
// Chromium 的缓存目录必须在 app ready 之前定好，`app.setPath('cache')` 之后
// 再改是无效的（缓存已经建好了）。而配置文件又只有我们知道在哪，所以这里在
// 模块加载阶段直接同步读一次 config.json，只取 cacheDir 一个字段 ——
// loadConfig() 到 whenReady 才跑，那时已经太晚。
//
// 默认留空：跟随 Electron 自己的 userData/Cache。用户在设置页改完之后
// 重启生效，这一点在设置页里写明了。
function earlyCacheDir() {
  if (!configPath) return '';
  try {
    let raw = fs.readFileSync(configPath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    return typeof j.cacheDir === 'string' ? j.cacheDir.trim() : '';
  } catch { return ''; }
}

// 实际生效的自定义目录。用户配了但目录不可用时会被清空 —— 这样 cache:get
// 报给设置页的状态跟真实情况一致，不会显示一个其实没用上的路径。
let cacheDir = earlyCacheDir();
if (cacheDir) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.accessSync(cacheDir, fs.constants.W_OK);
    app.setPath('cache', cacheDir);
  } catch (e) {
    console.error('[cache] 缓存目录不可用，回退到默认位置：', cacheDir, e.message);
    cacheDir = '';
  }
}

// ---------------------------------------------------------------- 下载（第 5 点）

/** 给所有活着的窗口广播一个事件（下载进度、本地索引变化都走它）。 */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/**
 * 本地扫描索引（m35069 第 2 点）。索引文件跟 config.json 同目录，但它单独
 * 一份 —— 几千条记录不能塞进每次改设置都要整份重写的 config.json。
 */
const localIndex = new LocalIndex({
  getIndexPath: () => (userDataDir ? path.join(userDataDir, 'local-index.json') : ''),
});

/**
 * 下载队列住在主进程（见 download.js 顶部的理由）。这里只负责接线：
 * 直链用 v1 方言（能指定 MP3 / FLAC 容器），事件广播给所有窗口，
 * 下载完弹一次系统通知。
 */
const downloader = new Downloader({
  getConfig: () => config,
  saveConfig,
  songUrl: (id, quality, encodeType) => ne.songUrlV1(id, quality, encodeType),
  // 下载时补音轨号 / 碟号（每日推荐等接口不回 no/cd），见 download.js 的
  // _fillTrackNumbers。
  songDetail: (ids) => ne.songDetail(ids),
  // 下载记录跟配置、本地索引放在同一个 userData 目录里：换 --user-data-dir
  // 跑 dev / 打包两套实例时，历史不会串到一起。
  historyPath: userDataDir ? path.join(userDataDir, 'download-history.json') : '',
  /**
   * 「这批歌里哪些本机已经有了」（m02599 第①点）。
   *
   * 判断必须走 `LocalIndex.resolve()` 而不是 `ids()`：前者会顺手 `existsSync`
   * 一次（用户在资源管理器里删掉的文件不会再算「有」），而且带音质比较 ——
   * 本地是 128k、用户这次要无损时返回 `satisfied: false`，那就该老实去下；
   * 本地无损、这次只要 320k 时算够，直接用本地的就行。
   */
  isLocal: (id, quality) => {
    const hit = localIndex.resolve(id, quality);
    return !!(hit && hit.satisfied);
  },
  emit: broadcast,
  onTaskDone: (task) => {
    // 下载完成 = 本机确实有这个文件了，顺手登记进本地索引：歌曲行上的「√」
    // 立刻亮起来，下次播这首歌也直接走本地文件，不必再请求一次直链。
    // 放在通知之前 —— 通知弹不出来（系统关了通知）不该连带索引也丢。
    if (task.state === 'done' && task.file) {
      // 档位一起登记（用户 m11461 第③点）：切音质时要靠它判断「本地这份够不够」，
      // 不记的话切到无损还是放同一个 320k 文件，听起来毫无变化。
      localIndex.add(task.songId, task.file, task.quality);
      broadcast('local:changed', { ids: localIndex.ids(), info: localIndex.info() });
    }
    // 通知只在主窗口开着的时候弹；用户关了窗口还在下（进程还活着）也不打扰
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: '下载完成',
          body: path.basename(task.file || ''),
          silent: true,
        }).show();
      }
    } catch { /* 通知失败不影响下载本身 */ }
  },
});

// ---------------------------------------------------------------- window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    frame: false,
    // 首帧底色跟着皮肤走，否则冷启动会先闪一下别的颜色再变过来。
    // 浅底皮肤共用一个近白底：它们之间差的是纸白/米色，冷启动那一帧看不出来，
    // 但要是用经典黑的深灰就会明显闪一下。
    backgroundColor: SKIN_BG[config.skin] || SKIN_BG.classic,
    titleBarStyle: 'hidden',
    // Taskbar / alt-tab / window icon. Points at the source tree copy so it works
    // both from `npm start` and from the packaged resources/app layout.
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
      // 首屏皮肤：preload 把它交给 boot.js，在样式表之前打到 <html data-skin>，
      // 否则切到「现代白」时会先闪一下黑底。
      additionalArguments: ['--boot-skin=' + (config.skin || 'classic')],
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Surface renderer errors on the terminal so a broken page is not silent.
  const devMode = process.argv.includes('--dev');
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] || 'LOG';
    if (!devMode && tag === 'LOG') return;
    console.log(`[renderer:${tag}] ${message}  (${(sourceId || '').split(/[\\/]/).pop()}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] gone:', details.reason, details.exitCode);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer] did-fail-load', code, desc, url);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (devMode) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  const emit = (evt) => () => mainWindow && mainWindow.webContents.send('window:state', { event: evt, maximized: mainWindow.isMaximized() });
  mainWindow.on('maximize', emit('maximize'));
  mainWindow.on('unmaximize', emit('unmaximize'));
  mainWindow.on('enter-full-screen', emit('enter-full-screen'));
  mainWindow.on('leave-full-screen', emit('leave-full-screen'));

  // External links open in the real browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; closeMini(true); });
}

// ---------------------------------------------------------------- image proxy

const imgCache = new Map(); // url -> { type, data }
const IMG_CACHE_MAX = 400;

async function fetchImage(rawUrl) {
  // The API hands back a mix of http:// and https:// CDN URLs. Electron's
  // net.fetch fails on the plain-http ones (502), while the same asset over
  // https loads fine, so normalise the scheme before hitting the network.
  const url = rawUrl.replace(/^http:\/\//i, 'https://');
  if (imgCache.has(url)) {
    const hit = imgCache.get(url);
    imgCache.delete(url);
    imgCache.set(url, hit); // LRU bump
    return hit;
  }
  const res = await net.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://music.163.com/',
    },
  });
  if (!res.ok) throw new Error('image HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const entry = { type: res.headers.get('content-type') || 'image/jpeg', data: buf };
  if (imgCache.size >= IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
  imgCache.set(url, entry);
  return entry;
}

function registerImageProtocol() {
  protocol.handle('neimg', async (request) => {
    try {
      const target = new URL(request.url).searchParams.get('u');
      if (!target) return new Response('missing u', { status: 400 });
      const { type, data } = await fetchImage(target);
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': type,
          'Cache-Control': 'public, max-age=86400, immutable',
        },
      });
    } catch (e) {
      return new Response('', { status: 502 });
    }
  });
}

// ---------------------------------------------------------------- 悬浮小窗
//
// 第 6 / 7 点：把主窗口收成一个悬浮小窗。小窗是独立的 BrowserWindow —— 音频仍然
// 只由主窗口里的那一个 <audio> 播放，小窗只负责显示状态、把操作转发回主窗口
// （见 renderer/js/mini.js）。
//
// 两个难点都在主进程解决：
//   1. 拖动。渲染进程拿不到窗口外的鼠标位置，所以拖动期间由这里轮询
//      screen.getCursorScreenPoint()，按位移移动窗口。
//   2. 贴边吸附 + 缩进屏幕。吸附后窗口大部分移出屏幕只留一条边，之后同样靠轮询
//      光标位置决定"滑进来"还是"滑出去"。透明无边框窗口只有卡片本身覆盖的区域
//      才会派发 mouseenter/mouseleave，靠事件判断会漏掉从屏幕外划入的那一段。

const MINI_SIZE = { v: { width: 320, height: 470 }, h: { width: 420, height: 96 } };
const MINI_SNAP = 56;          // 窗口边缘距屏幕边缘多少像素以内算"拖到边缘了"
const MINI_PEEK = 6;           // 缩进屏幕后仍留在屏幕内的宽度
const MINI_HOVER_PAD = 4;      // 判定"鼠标在小窗上"的容差
const MINI_HIDE_DELAY = 420;   // 鼠标移开后延迟多久缩回去，避免手抖闪烁
const MINI_SLIDE_MS = 190;     // 滑入 / 滑出动画时长

const mini = {
  win: null,
  mode: 'v',
  dock: null,        // 'left' | 'right' | 'top' | 'bottom' | null
  hidden: false,     // 是否已缩进屏幕
  shownBounds: null, // 吸附状态下完全显示时的位置
  hiddenBounds: null,
  drag: null,        // { cursor, origin, timer }
  poll: null,        // 吸附后的光标轮询
  hideTimer: null,
  slide: null,
};

function miniSend(channel, payload) {
  if (mini.win && !mini.win.isDestroyed()) mini.win.webContents.send(channel, payload);
}
function mainSend(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/**
 * 小窗是主窗口「收起来」的形态。关掉小窗 / 从小窗跳回主界面时，主窗口如果直接
 * show() 会硬生生弹出来，和收起时的过渡不对称。这里让渲染进程先给 <body> 挂上
 * `.main-in` 类（入场动画的起始状态），收到它的回执后再显示窗口。
 *
 * 顺序不能反：先 show() 再挂类会先闪一帧完全不透明的界面，然后跳回透明重新
 * 淡入，看起来像闪屏。所以这里是「通知渲染进程 → 等回执 → show」，并带一个
 * 兜底定时器 —— 万一页面还没监听到（或渲染进程卡住），窗口不能一直不显示。
 */
let appearTimer = null;
function mainAppear() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:appear');
  clearTimeout(appearTimer);
  appearTimer = setTimeout(showMainNow, 400);
}

function showMainNow() {
  clearTimeout(appearTimer);
  appearTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function workAreaFor(win) {
  const b = win.getBounds();
  const pt = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  return screen.getDisplayNearestPoint(pt).workArea;
}

function clampToWorkArea(b, work) {
  return {
    x: Math.min(Math.max(b.x, work.x), work.x + work.width - b.width),
    y: Math.min(Math.max(b.y, work.y), work.y + work.height - b.height),
  };
}

/** 某个方向吸附后，"完全显示"和"缩进屏幕"两种位置的坐标。 */
function dockPositions(edge, work, size) {
  const w = size.width;
  const h = size.height;
  switch (edge) {
    case 'left':
      return {
        shown: { x: work.x, y: work.y },
        hidden: { x: work.x - w + MINI_PEEK, y: work.y },
      };
    case 'right':
      return {
        shown: { x: work.x + work.width - w, y: work.y },
        hidden: { x: work.x + work.width - MINI_PEEK, y: work.y },
      };
    case 'top':
      return {
        shown: { x: work.x + Math.round((work.width - w) / 2), y: work.y },
        hidden: { x: work.x + Math.round((work.width - w) / 2), y: work.y - h + MINI_PEEK },
      };
    default: // bottom
      return {
        shown: { x: work.x + Math.round((work.width - w) / 2), y: work.y + work.height - h },
        hidden: { x: work.x + Math.round((work.width - w) / 2), y: work.y + work.height - MINI_PEEK },
      };
  }
}

/**
 * 主进程没有动画版 setBounds，自己按显示器刷新率步进做一次缓出滑动。
 *
 * 第 15 点（移出 / 移入卡顿）沿用拖动那套做法，原来的实现有三个毛病：
 *  1) `setInterval(…, 16)` 节拍是死的，和显示器刷新率对不上 —— 60Hz 下每帧会
 *     多跑或少跑一次，144Hz 上更明显，滑动看起来一顿一顿的。现在改成自调度的
 *     `setTimeout`，间隔按当前显示器刷新率算（`miniDragInterval()`，取不到就 60Hz）。
 *  2) 每帧都在无条件下发 `setPosition`，哪怕这一帧算出来的坐标和上一帧一模一样。
 *     缓出曲线在两端变化极小，头尾好几帧坐标是重复的，空调用白白吃掉合成时间。
 *     现在先比坐标，真变了才动窗口。
 *  3) 透明窗口滑动时，渲染进程那边歌词的 mask-image 和高亮发光都要按新尺寸重算，
 *     这在滑动途中是纯浪费，而且会让窗口边缘出现撕裂感。滑动期间给渲染进程发
 *     `mini:sliding`，让 <body> 挂上 `.is-sliding` 把这两项昂贵合成临时关掉
 *     （同 `.is-dragging`，见 mini.css），滑完再恢复。
 */
function slideMini(target, done) {
  if (!mini.win || mini.win.isDestroyed()) return;
  // 顶掉上一次滑动时必须用 stopMiniSlide()，它会顺手把 `.is-sliding` 摘掉。
  // 这里不能只 clearTimeout：滑出滑入会被轮询互相打断（鼠标一直停在窗口上，
  // miniShow 会在 miniHide 刚开始时把窗口又拉回来），而这次新的滑动如果算出来
  // 「已经在目标位置」，下面就会提前 return，那个 true 就再也没人收回 ——
  // 歌词的 mask 和发光会一直关着，比卡顿更糟。
  stopMiniSlide();
  const from = mini.win.getBounds();
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  if (!dx && !dy) { if (done) done(); return; }

  const state = { timer: null, x: from.x, y: from.y };
  mini.slide = state;
  const interval = miniDragInterval();
  const t0 = Date.now();
  // 滑动期间关掉昂贵的合成；结束（含窗口被销毁、被新滑动顶掉）时一定要恢复
  miniSend('mini:sliding', true);
  let announced = true;
  const finish = () => {
    if (announced) { announced = false; miniSend('mini:sliding', false); }
  };

  const step = () => {
    if (mini.slide !== state) { finish(); return; }
    if (!mini.win || mini.win.isDestroyed()) { mini.slide = null; finish(); return; }
    const p = Math.min(1, (Date.now() - t0) / MINI_SLIDE_MS);
    const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const nx = Math.round(from.x + dx * e);
    const ny = Math.round(from.y + dy * e);
    if (nx !== state.x || ny !== state.y) {
      state.x = nx;
      state.y = ny;
      mini.win.setPosition(nx, ny);
    }
    if (p >= 1) {
      mini.slide = null;
      finish();
      if (done) done();
      return;
    }
    state.timer = setTimeout(step, interval);
  };
  step();
}

/** 光标是否落在小窗（或它露在屏幕内那一条边）上。 */
function cursorOnMini() {
  if (!mini.win || mini.win.isDestroyed()) return false;
  const b = mini.win.getBounds();
  const p = screen.getCursorScreenPoint();
  let rect;
  if (mini.hidden) {
    const work = workAreaFor(mini.win);
    switch (mini.dock) {
      case 'left': rect = { x: work.x, y: b.y, width: MINI_PEEK + MINI_HOVER_PAD * 2, height: b.height }; break;
      case 'right': rect = { x: work.x + work.width - MINI_PEEK - MINI_HOVER_PAD * 2, y: b.y, width: MINI_PEEK + MINI_HOVER_PAD * 2, height: b.height }; break;
      case 'top': rect = { x: b.x, y: work.y, width: b.width, height: MINI_PEEK + MINI_HOVER_PAD * 2 }; break;
      default: rect = { x: b.x, y: work.y + work.height - MINI_PEEK - MINI_HOVER_PAD * 2, width: b.width, height: MINI_PEEK + MINI_HOVER_PAD * 2 };
    }
  } else {
    rect = { x: b.x - MINI_HOVER_PAD, y: b.y - MINI_HOVER_PAD, width: b.width + MINI_HOVER_PAD * 2, height: b.height + MINI_HOVER_PAD * 2 };
  }
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
}

function miniShow() {
  if (!mini.win) return;
  // 先撤掉待执行的缩回定时器：鼠标只要回到窗口上，之前那次「移出」就不算数了。
  // 这一句必须放在下面的提前 return 之前 —— 窗口还没缩回去时 mini.hidden 仍是
  // false，会被提前 return 挡掉，定时器留着照样把窗口收走，表现就是
  // 「鼠标刚移回来窗口还是缩了」。
  clearTimeout(mini.hideTimer);
  mini.hideTimer = null;
  if (!mini.hidden) return;
  mini.hidden = false;
  slideMini(mini.shownBounds);
}

function miniHide() {
  if (mini.hidden || !mini.win || !mini.dock) return;
  // 缩回前再看一眼光标。轮询是 80ms 一跳，而宽限定时器可能正好在两次轮询之间
  // 到点 —— 用户在这个缝里把鼠标挪回窗口上时，miniShow() 还没来得及清定时器，
  // 窗口就被收走了。用户要的是「只要鼠标在窗口内就不缩回」，所以这里补最后一道
  // 判定：光标还在窗口上，就当这次「移出」没发生过，直接放弃缩回。
  if (cursorOnMini()) return;
  mini.hidden = true;
  slideMini(mini.hiddenBounds);
}

function startMiniPoll() {
  stopMiniPoll();
  mini.poll = setInterval(() => {
    if (!mini.win || mini.win.isDestroyed()) { stopMiniPoll(); return; }
    if (mini.drag) return; // 拖动时不动
    if (cursorOnMini()) {
      miniShow();
    } else if (!mini.hidden) {
      // 先给一点宽限时间，鼠标短暂移出去（比如去点别处）不立刻缩回
      if (!mini.hideTimer) mini.hideTimer = setTimeout(() => { mini.hideTimer = null; miniHide(); }, MINI_HIDE_DELAY);
    }
  }, 80);
}

function stopMiniPoll() {
  if (mini.poll) { clearInterval(mini.poll); mini.poll = null; }
  clearTimeout(mini.hideTimer);
  mini.hideTimer = null;
}

function undockMini() {
  stopMiniPoll();
  mini.dock = null;
  mini.hidden = false;
  mini.shownBounds = null;
  mini.hiddenBounds = null;
}

function createMiniWindow(mode) {
  const size = MINI_SIZE[mode] || MINI_SIZE.v;
  const work = screen.getPrimaryDisplay().workArea;
  // 设置里的「悬浮小窗始终置顶」，默认开
  const onTop = !(config.settings && config.settings.miniOnTop === false);
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: work.x + work.width - size.width - 24,
    y: work.y + work.height - size.height - 24,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: onTop,
    title: '网易云音乐 Lite',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
      additionalArguments: ['--mini-mode=' + mode, '--boot-skin=' + (config.skin || 'classic')],
    },
  });
  if (onTop) win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'mini.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    // 让主窗口把当前播放状态推过来
    mainSend('mini:opened', { mode });
  });
  win.on('closed', () => {
    stopMiniPoll();
    if (mini.slide) { clearTimeout(mini.slide.timer); mini.slide = null; }
    if (mini.drag && mini.drag.timer) clearTimeout(mini.drag.timer);
    mini.win = null;
    mini.dock = null;
    mini.hidden = false;
    mini.drag = null;
    // 小窗是主窗口"收起来"的形态，关掉它就该把主窗口放回来 —— 带一次浮现动效
    if (mainWindow && !mainWindow.isDestroyed()) mainAppear();
  });
  return win;
}

function openMini(mode) {
  const want = MINI_SIZE[mode] ? mode : 'v';
  if (mini.win && !mini.win.isDestroyed()) {
    if (mini.mode !== want) {
      // 换一种形态：直接重建，省得两套布局互相打架
      const old = mini.win;
      mini.win = null;
      old.destroy();
    } else {
      undockMini();
      mini.win.showInactive();
      mainSend('mini:opened', { mode: want });
      return { ok: true, mode: want };
    }
  }
  mini.mode = want;
  mini.win = createMiniWindow(want);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  return { ok: true, mode: want };
}

function closeMini() {
  if (mini.win && !mini.win.isDestroyed()) mini.win.close();
  return { ok: true };
}

/** 拖动结束：判断是否拖到了屏幕边缘，是就吸附并缩进屏幕。 */
function finishMiniDrag() {
  if (!mini.win || mini.win.isDestroyed()) return;
  const work = workAreaFor(mini.win);
  const b = mini.win.getBounds();
  const size = { width: b.width, height: b.height };
  const dist = {
    left: b.x - work.x,
    right: (work.x + work.width) - (b.x + b.width),
    top: b.y - work.y,
    bottom: (work.y + work.height) - (b.y + b.height),
  };
  let edge = null;
  let best = MINI_SNAP;
  for (const k of ['left', 'right', 'top', 'bottom']) {
    if (dist[k] < best) { best = dist[k]; edge = k; }
  }
  if (!edge) {
    undockMini();
    const p = clampToWorkArea(b, work);
    mini.win.setPosition(p.x, p.y);
    return;
  }
  const pos = dockPositions(edge, work, size);
  // 垂直于吸附方向的位置保留用户拖到的地方，别硬拽回中间
  if (edge === 'left' || edge === 'right') {
    pos.shown.y = Math.min(Math.max(b.y, work.y), work.y + work.height - size.height);
    pos.hidden.y = pos.shown.y;
  } else {
    pos.shown.x = Math.min(Math.max(b.x, work.x), work.x + work.width - size.width);
    pos.hidden.x = pos.shown.x;
  }
  mini.dock = edge;
  mini.shownBounds = pos.shown;
  mini.hiddenBounds = pos.hidden;
  mini.hidden = false;
  // 先完整露一下再缩进屏幕，用户才看得见"吸住了"
  slideMini(pos.shown, () => {
    clearTimeout(mini.hideTimer);
    mini.hideTimer = setTimeout(() => { mini.hideTimer = null; miniHide(); }, 700);
  });
  startMiniPoll();
}

/**
 * 拖动。渲染进程只负责"按下 / 松开"，真正的位置由主进程轮询系统光标算出来：
 * 窗口跟着光标走，指针在窗口里的相对位置保持不变，所以缩放比、跨屏 DPI 都不会
 * 造成偏移。窗口一边动一边发 IPC 会在高刷屏上抖，轮询没有这个问题。
 *
 * 第 14 点（拖动卡顿）优化了两处：
 *  1) 原来用 `setInterval(…, 16)`，节拍是死的，和显示器刷新率对不上 —— 60Hz 下
 *     每帧会多跑或少跑一次，高刷屏上更明显，窗口一顿一顿地追光标。现在改成
 *     自调度的 `setTimeout`，间隔按当前显示器的刷新率算（取不到就退回 60Hz）。
 *  2) 光标没动时也在调 `setPosition`。透明窗口每移动一次都要把整个表面重新合成
 *     一遍，空调用白白吃掉一帧合成时间。现在先比坐标，真变了才动窗口。
 * 渲染进程那边同时会给 <body> 挂 `.is-dragging`，把歌词 mask / 发光这类昂贵的
 * 合成开销临时关掉（见 mini.css）。
 */
function miniDragStep() {
  if (!mini.win || mini.win.isDestroyed() || !mini.drag) return;
  const d = mini.drag;
  const p = screen.getCursorScreenPoint();
  const nx = Math.round(p.x - d.ox);
  const ny = Math.round(p.y - d.oy);
  if (nx !== d.x || ny !== d.y) {
    d.x = nx;
    d.y = ny;
    mini.win.setPosition(nx, ny);
  }
  d.timer = setTimeout(miniDragStep, d.interval);
}

/** 拖动循环的节拍：跟随显示器刷新率，夹在 4~16ms 之间。 */
function miniDragInterval() {
  let hz = 0;
  try {
    const b = mini.win && !mini.win.isDestroyed() ? mini.win.getBounds() : null;
    const pt = b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(pt);
    // displayFrequency 只有 Windows 上有，取不到就当 60Hz
    hz = Number(d && d.displayFrequency) || 0;
  } catch { hz = 0; }
  if (!(hz >= 30 && hz <= 360)) hz = 60;
  return Math.min(16, Math.max(4, Math.round(1000 / hz)));
}

/**
 * 中止正在进行的滑动（新滑动顶掉旧的、开始拖动、窗口关闭都走这里）。
 * 必须顺手把渲染进程的 `.is-sliding` 摘掉 —— 否则中途被打断时歌词的
 * mask / 发光就永远关着了，那比卡顿更糟。
 */
function stopMiniSlide() {
  if (!mini.slide) return;
  clearTimeout(mini.slide.timer);
  mini.slide = null;
  miniSend('mini:sliding', false);
}

function startMiniDrag() {
  if (!mini.win || mini.win.isDestroyed()) return;
  stopMiniSlide();
  clearTimeout(mini.hideTimer);
  mini.hideTimer = null;
  const b = mini.win.getBounds();
  const cur = screen.getCursorScreenPoint();
  mini.drag = {
    ox: cur.x - b.x,
    oy: cur.y - b.y,
    w: b.width,
    h: b.height,
    // 上一次真正下发的窗口坐标，用来跳过重复的 setPosition
    x: b.x,
    y: b.y,
    interval: 16,
    timer: null,
  };
  // 拖动期间不再吸附，也不做滑入滑出，否则会跟光标抢窗口
  mini.dock = null;
  mini.hidden = false;
  stopMiniPoll();
  mini.drag.interval = miniDragInterval();
  mini.drag.timer = setTimeout(miniDragStep, mini.drag.interval);
}

function endMiniDrag() {
  if (!mini.drag) return;
  clearTimeout(mini.drag.timer);
  mini.drag = null;
  finishMiniDrag();
}

// ---------------------------------------------------------------- IPC

/** Every renderer call lands here; method names map 1:1 onto Netease methods. */
const ALLOWED = new Set([
  'account', 'qrCreate', 'qrPoll', 'loginPhone', 'sendCaptcha', 'loginCaptcha', 'logout',
  'userPlaylists', 'playlistDetail', 'playlistTracks', 'dailyRecommend', 'recommendPlaylists',
  // songUrlV1 与 songUrl 是同一个操作的两个方言（v1 多一个 encodeType 参数，
  // 能指定拿 mp3 还是 flac）。下载队列在主进程里直接用它，渲染层要它是因为
  // 「这首歌到底能不能下成 MP3」要在菜单里提前算出来。
  'songDetail', 'songUrl', 'songUrlV1', 'songUrls', 'lyrics', 'comments', 'commentLike', 'likedIds',
  'playlistAdd', 'playlistRemove', 'playlistCreate', 'playlistDelete', 'playlistUpdate',
  'like', 'subscribePlaylist', 'scrobble', 'search', 'artistSongs', 'artistAllSongs', 'album',
  'userDetail', 'playRecord', 'dailyTask', 'userLevel', 'follows', 'followeds',
  'artistDetail', 'artistAlbums', 'artistDesc', 'artistSub', 'userFollow',
  'riskQr', 'riskQrStatus',
  // 榜单 / 播客（左侧栏新增的两个入口）
  'toplists', 'podcasts', 'podcastDetail', 'podcastPrograms',
]);

function registerIpc() {
  ipcMain.handle('api', async (_e, { method, args = [] }) => {
    if (!ALLOWED.has(method)) return { ok: false, error: { code: -2, message: 'blocked method ' + method } };
    try {
      const result = await ne[method](...args);
      // A login can change the cookie jar; persist it.
      if (method === 'loginPhone' || method === 'loginCaptcha' || method === 'qrPoll' || method === 'logout') {
        config.cookie = ne.isLoggedIn ? ne.exportCookie() : '';
        saveConfig();
      }
      return { ok: true, result };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: e.code ?? -1,
          message: e.message || String(e),
          // 301 while logged out is the single most common failure.
          // -462 is NOT a login problem: the user is logged in and Netease is
          // asking for SMS verification before it allows the write. Marking it
          // needLogin made api.explain() answer "请先登录网易云账号", which is
          // both wrong and unactionable.
          needLogin: e.code === 301,
        },
      };
    }
  });

  // Restoring a cookie from disk only puts MUSIC_U back in the jar — the profile
  // is not stored in the cookie, so `ne.profile` stays null until somebody asks
  // the account endpoint. Without this the renderer received loggedIn:true
  // together with uid:null, loadLibrary() bailed out on the missing uid, and
  // every page still claimed the user was logged out.
  ipcMain.handle('auth:state', async () => {
    if (ne.isLoggedIn && !ne.profile) {
      try { await ne.account(); } catch { /* offline — keep cookie, retry next call */ }
    }
    // Cache the profile on disk as well. If the account call above failed because
    // the machine is offline, a null uid would reproduce the original "登录后查看"
    // symptom on every page, so fall back to the last profile we saw. Note we do
    // NOT write the cached value into ne.profile: that would make the guard above
    // believe the profile is already fresh and stop retrying the account call.
    if (ne.profile) {
      if (JSON.stringify(ne.profile) !== JSON.stringify(config.profile)) {
        config.profile = ne.profile;
        saveConfig();
      }
    }
    const profile = ne.profile || config.profile || null;
    // QR and phone logins absorb fresh cookies from Set-Cookie, but nothing in
    // those paths writes them to disk, so a restart lost the session entirely.
    if (ne.isLoggedIn) {
      const fresh = ne.exportCookie();
      if (fresh && fresh !== config.cookie) { config.cookie = fresh; saveConfig(); }
    }
    return {
      loggedIn: ne.isLoggedIn,
      hasCookie: !!config.cookie,
      profile,
      uid: profile ? profile.userId : null,
    };
  });

  // Verifies the pasted cookie against the account endpoint before we keep it,
  // so the UI can say "invalid" instead of silently staying logged out.
  ipcMain.handle('auth:setCookie', async (_e, cookieStr) => {
    ne.setCookieString(cookieStr);
    // `isLoggedIn` only checks that a MUSIC_U cookie is *present*, so a stale or
    // forged value would pass. The account call is what actually proves the
    // cookie works, so a successful fetch is required before we persist it.
    let verified = false;
    try {
      const acct = await ne.account();
      verified = !!(acct && acct.profile);
    } catch { /* unverified — treated as a failed login below */ }
    const ok = verified && ne.isLoggedIn;
    if (ok) {
      config.cookie = ne.exportCookie();
      config.profile = ne.profile;
      saveConfig();
    } else {
      config.cookie = '';
      config.profile = null;
      ne.cookies.clear();
      ne.profile = null;
      saveConfig();
    }
    return {
      ok,
      loggedIn: ok,
      hasCookie: !!config.cookie,
      profile: ne.profile,
      uid: ne.profile ? ne.profile.userId : null,
    };
  });

  ipcMain.handle('auth:clearCookie', () => {
    ne.cookies.clear();
    ne.profile = null;
    config.cookie = '';
    config.profile = null;
    saveConfig();
    return { ok: true };
  });

  ipcMain.handle('config:get', () => ({ ...config, cookie: undefined, hasCookie: !!config.cookie }));
  ipcMain.handle('config:set', (_e, patch) => {
    Object.assign(config, patch);
    saveConfig();
    // 「悬浮小窗始终置顶」是主进程持有的属性，改完要立刻作用到已经开着的小窗上
    if (patch && patch.settings && mini.win && !mini.win.isDestroyed()) {
      const onTop = patch.settings.miniOnTop !== false;
      mini.win.setAlwaysOnTop(onTop, onTop ? 'floating' : 'normal');
    }
    return { ok: true, config: { ...config, cookie: undefined } };
  });

  ipcMain.handle('quality:list', () => Object.entries(QUALITY).map(([k, v]) => ({ key: k, label: v.label })));

  // ------------------------------------------------------------ 缓存目录（第 13 点）

  /**
   * 默认缓存目录。
   *
   * ⚠️ 不能用 `app.getPath('cache')`：在 Windows 上它返回的是 `%APPDATA%`
   * **本身**（实测 Electron 33：`app.getPath('cache')` = `C:\Users\<用户>\AppData\Roaming`），
   * 不是应用自己的缓存子目录。拿它去统计会把整个 Roaming 算成"缓存 7.4 GB"，
   * 拿它去清理更会删掉别的软件的配置。Chromium 真正用的是 `userData/Cache`，
   * 这里就以它为准（`sessionData` 默认等于 `userData`）。
   */
  const defaultCacheDir = () => path.join(app.getPath('userData'), 'Cache');
  const effectiveCacheDir = () => cacheDir || defaultCacheDir();

  /**
   * 防止把不该删的目录当成缓存删掉。
   *
   * 缓存目录来自两处：用户手选的自定义目录，和上面的默认位置。两处都可能被
   * 配置写坏（比如早期版本把 cacheDir 写成了盘根或 Roaming），而 cache:trim
   * 是 `rm -rf` 级别的操作，所以删之前必须挡一道：系统级目录一律拒绝。
   */
  function isSafeCacheDir(dir) {
    let norm;
    try { norm = path.resolve(dir).toLowerCase(); } catch { return false; }
    if (!norm || norm === path.parse(norm).root.toLowerCase()) return false;
    for (const key of ['appData', 'userData', 'sessionData', 'home', 'documents', 'music', 'downloads', 'pictures', 'desktop', 'temp', 'videos']) {
      try {
        if (path.resolve(app.getPath(key)).toLowerCase() === norm) return false;
      } catch { /* 该平台没有这个 key，跳过 */ }
    }
    return true;
  }

  /** 当前生效的缓存目录（只读）。默认位置见 defaultCacheDir() 的注释。 */
  ipcMain.handle('cache:get', () => ({
    dir: effectiveCacheDir(),
    custom: !!cacheDir,
    fallback: defaultCacheDir(),
  }));

  /** 弹系统目录选择框；选中后写进 config，重启生效。 */
  ipcMain.handle('cache:choose', async () => {
    if (!mainWindow) return { ok: false, canceled: true };
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择缓存目录',
      defaultPath: effectiveCacheDir(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此目录',
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      return { ok: false, error: '目录不可写：' + e.message };
    }
    config.cacheDir = dir;
    saveConfig();
    return { ok: true, dir };
  });

  /** 恢复默认（跟随 Electron 的 userData/Cache）。 */
  ipcMain.handle('cache:reset', () => {
    config.cacheDir = '';
    saveConfig();
    return { ok: true, dir: defaultCacheDir() };
  });

  /**
   * 当前缓存占了多少字节（第 6 点「缓存最大大小」要显示）。
   *
   * 递归求和，但要跳过 Chromium 的 `Cache_Data` 之外那些目录里的小文件吗？不用 ——
   * 用户在设置页看到的应该是「这块目录总共占了多大」，跟他去资源管理器里右键
   * 看属性一致，只挑一部分反而对不上账。软链接不跟进去，免得绕成死循环。
   */
  ipcMain.handle('cache:size', async () => {
    const dir = effectiveCacheDir();
    let total = 0;
    let files = 0;
    const walk = async (d, depth) => {
      if (depth > 6) return;
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { await walk(p, depth + 1); continue; }
        try { const st = await fsp.stat(p); total += st.size; files++; } catch { /* 正被写，跳过 */ }
      }
    };
    await walk(dir, 0);
    return { dir, bytes: total, files };
  });

  /** 按上限清理缓存（第 6 点）：超了就把整个 Cache 目录删掉重建。 */
  ipcMain.handle('cache:trim', async (_e, maxMb) => {
    const limit = Math.max(0, Number(maxMb) || 0);
    if (!limit) return { ok: true, skipped: true, bytes: 0 };
    const dir = effectiveCacheDir();
    // 兜底：宁可不清，也不能把 Roaming / 用户主目录这种地方整个删掉。
    if (!isSafeCacheDir(dir)) {
      return { ok: false, skipped: true, error: '缓存目录不像是应用自己的目录，已拒绝清理：' + dir };
    }
    let total = 0;
    const walk = async (d, depth) => {
      if (depth > 6) return;
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { await walk(p, depth + 1); continue; }
        try { const st = await fsp.stat(p); total += st.size; } catch { /* 忽略 */ }
      }
    };
    await walk(dir, 0);
    if (total <= limit * 1024 * 1024) return { ok: true, skipped: true, bytes: total };

    // 清理策略：整个目录删掉重建是最干净的（Chromium 的缓存索引和文件是一套的，
    // 只删文件不删索引会让它下次启动对不上账）。但当前进程正把 Cache_Data 里的
    // data_0 / index 之类开着，rm -rf 撞上任何一个都会整个 EPERM 失败 —— 实测
    // 319MB 里一个都删不掉。所以退一步：逐个文件删，锁住的跳过，最后再收掉
    // 空目录。删不干净的账如实报回去，下次启动时 Chromium 自己会重建索引。
    let removed = 0;
    let locked = 0;
    const sweep = async (d, depth) => {
      if (depth > 6) return;
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { await sweep(p, depth + 1); continue; }
        try {
          const st = await fsp.stat(p);
          await fsp.unlink(p);
          removed += st.size;
        } catch { locked++; }
      }
      // 目录空了就收掉；非空说明里面有锁住的，留着
      try {
        const rest = await fsp.readdir(d);
        if (!rest.length && d !== dir) await fsp.rmdir(d);
      } catch { /* 忽略 */ }
    };
    await sweep(dir, 0);
    try { await fsp.mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
    return { ok: true, bytes: total, cleared: removed, locked };
  });

  /**
   * 刷新：清掉所有缓存后重启（设置页的「刷新」）。
   *
   * 只清缓存，不动 cookie / localStorage —— 登录态和界面偏好都存在那儿，
   * 一起清掉等于把用户踢下线，那不是「刷新」而是「恢复出厂」。
   * 顺序上先尽量删盘上的缓存（复用 cache:trim 的逐文件删，锁住的跳过），
   * 再让 Chromium 自己清内存里的那份，最后重启。
   */
  ipcMain.handle('app:refresh', async () => {
    const dir = effectiveCacheDir();
    if (isSafeCacheDir(dir)) {
      const sweep = async (d, depth) => {
        if (depth > 6) return;
        let entries;
        try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) { await sweep(p, depth + 1); continue; }
          try { await fsp.unlink(p); } catch { /* 正被占用，交给 Chromium */ }
        }
        try {
          const rest = await fsp.readdir(d);
          if (!rest.length && d !== dir) await fsp.rmdir(d);
        } catch { /* 忽略 */ }
      };
      await sweep(dir, 0);
    }
    try {
      const ses = session.defaultSession;
      await ses.clearCache();
      await ses.clearStorageData({ storages: ['cachestorage', 'shadercache', 'serviceworkers'] });
    } catch { /* 清不掉也要把应用重启起来 */ }
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  // ------------------------------------------------------------ 下载（第 5 点）

  /** 当前下载设置 + 生效目录（没配过就是系统的「音乐」文件夹）。 */
  ipcMain.handle('download:settings', () => {
    const s = downloader.settings;
    return {
      ...s,
      dir: s.dir || '',
      effectiveDir: downloader.rootDir(),
      fallback: app.getPath('music'),
      custom: !!s.dir,
    };
  });

  /** 改下载设置。patch 里只认白名单字段，脏值一律落回默认。 */
  ipcMain.handle('download:set', (_e, patch) => {
    const cur = { ...downloader.settings };
    const p = patch || {};
    if (typeof p.dir === 'string') cur.dir = p.dir;
    // 音质收全部五档（用户 m36467 更正过口径：MP3 或 FLAC 都行，只要不是
    // 私有格式）。前三档下到 MP3，无损下到 FLAC，容器由 level 决定。
    // hires 档已按用户 m36690 第④点删除（与 lossless 同一音质）；渲染层还按老
    // 版本发过来的话直接折成无损，而不是丢掉这次修改。
    if (p.quality === 'hires') cur.quality = 'lossless';
    else if (['standard', 'higher', 'exhigh', 'lossless'].includes(p.quality)) cur.quality = p.quality;
    if (['none', 'artist', 'album'].includes(p.organize)) cur.organize = p.organize;
    // 模板留空就等于没有文件名，落回默认
    if (typeof p.template === 'string') cur.template = p.template.trim() || '{歌手名} - {歌曲名}';
    config.download = cur;
    saveConfig();
    return { ok: true, settings: { ...cur, effectiveDir: downloader.rootDir(), custom: !!cur.dir } };
  });

  /** 弹系统目录选择框挑下载位置。 */
  ipcMain.handle('download:chooseDir', async () => {
    if (!mainWindow) return { ok: false, canceled: true };
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载目录',
      defaultPath: downloader.rootDir(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此目录',
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      return { ok: false, error: '目录不可写：' + e.message };
    }
    config.download = { ...downloader.settings, dir };
    saveConfig();
    return { ok: true, dir, effectiveDir: downloader.rootDir() };
  });

  /** 恢复默认下载目录（系统的「音乐」文件夹）。 */
  ipcMain.handle('download:resetDir', () => {
    config.download = { ...downloader.settings, dir: '' };
    saveConfig();
    return { ok: true, dir: app.getPath('music') };
  });

  ipcMain.handle('download:add', (_e, payload) => {
    const { songs, quality } = payload || {};
    return downloader.enqueue(songs, quality);
  });
  ipcMain.handle('download:cancel', (_e, key) => downloader.cancel(key));
  ipcMain.handle('download:pause', (_e, key) => downloader.pause(key));
  ipcMain.handle('download:resume', (_e, key) => downloader.resume(key));
  // 批量：全部暂停 / 全部开始 / 清空（m02003 第②点）
  ipcMain.handle('download:pauseAll', () => downloader.pauseAll());
  ipcMain.handle('download:resumeAll', () => downloader.resumeAll());
  ipcMain.handle('download:clearAll', () => downloader.clearAll());
  ipcMain.handle('download:clearFinished', () => downloader.clearFinished());
  ipcMain.handle('download:list', () => downloader.tasks.map(({ _song, ...t }) => ({ ...t })));
  /** 在资源管理器里定位已下好的文件。 */
  ipcMain.handle('download:reveal', (_e, key) => {
    const t = downloader.tasks.find((x) => x.key === key);
    if (t && t.file) shell.showItemInFolder(t.file);
    return { ok: !!t };
  });

  // ------------------------------------------------------------ 本地扫描（m35069 第 2 点）

  /** 当前索引概况：条数、扫过的目录、更新时间。 */
  ipcMain.handle('local:info', () => localIndex.info());

  /** 已匹配到的歌曲 id（渲染层据此决定哪些行的「√」要亮）。 */
  ipcMain.handle('local:ids', () => localIndex.ids());

  /**
   * 索引的完整内容（m01537 第②点）：「已下载音乐」页按这份数据画列表。
   *
   * 以前这一页画的是下载任务，扫进来的歌在界面上不存在 —— 用户「能扫描出歌曲，
   * 但是不显示」就是这条断链。现在列表的数据源是本机索引，扫描和下载都往同一个
   * 地方写，扫到多少就能看到多少。
   */
  ipcMain.handle('local:entries', () => localIndex.entries());

  /**
   * 查一首歌的本地文件；没有 / 文件已被删就返回 null。
   *
   * 可选的第二个参数是「用户当前选的音质」（用户 m11461 第③点）。返回值里带
   * `satisfied`：本机这份够不够这一档。不够**也照样返回路径**（文件是好的，只是
   * 档位低），由渲染层决定去取新流；返回 null 只代表「本机没有 / 文件不见了」。
   * 切档那一刻要传 —— 否则索引里存着的 320k 会被当成「本地有」一直还回来。
   */
  ipcMain.handle('local:resolve', (_e, id, want) => localIndex.resolve(id, want));

  /**
   * 挑一个文件夹并扫描。
   *
   * 弹框和扫描都放主进程：渲染层没有 fs，而且几千个文件的递归遍历放渲染层
   * 会把界面卡住。songs 由渲染层给 —— 主进程不知道用户在哪个页面，
   * 而匹配的对象就是「这次会话里见过的所有歌」（见 renderer 的 scanDictionary）。
   *
   * 扫描改成异步 + 逐段广播进度（m00001 第②点）：以前 `localIndex.scan()`
   * 是同步跑完的，几千个文件要走十几秒，期间界面只有一个「扫描中…」的按钮，
   * 用户完全不知道它在动还是在卡死。
   */
  ipcMain.handle('local:choose', async (_e, songs) => {
    if (!mainWindow) return { ok: false, canceled: true };
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择音乐文件夹（按文件标签 / 文件名匹配本机已有的歌）',
      defaultPath: app.getPath('music'),
      properties: ['openDirectory'],
      buttonLabel: '扫描此文件夹',
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    try {
      const res = await localIndex.scanAsync(dir, songs || [], (p) => broadcast('local:progress', p));
      // 索引变了就广播，别的窗口（小窗）也能跟上
      broadcast('local:changed', { ids: localIndex.ids(), info: localIndex.info() });
      return res;
    } catch (e) {
      return { ok: false, error: '扫描失败：' + ((e && e.message) || e) };
    }
  });

  /** 直接扫一个已知目录（不弹框）：探针与重扫用，同样带进度。 */
  ipcMain.handle('local:scan', async (_e, payload) => {
    const { dir, songs } = payload || {};
    if (!dir) return { ok: false, error: '没有指定目录' };
    try {
      const res = await localIndex.scanAsync(dir, songs || [], (p) => broadcast('local:progress', p));
      broadcast('local:changed', { ids: localIndex.ids(), info: localIndex.info() });
      return res;
    } catch (e) {
      return { ok: false, error: '扫描失败：' + ((e && e.message) || e) };
    }
  });

  /**
   * 走一遍索引，剔掉文件已经不在了的条目（「已下载音乐」页的「重新扫描」）。
   *
   * 没有目录可扫时可以重扫的只有「失效」这件事：`local:scan` 需要用户给目录，
   * 而这一页要回答的是「现在本机到底还有多少首」，所以走 prune。
   */
  ipcMain.handle('local:rescan', () => {
    const res = localIndex.prune();
    broadcast('local:changed', { ids: localIndex.ids(), info: localIndex.info() });
    return res;
  });

  /**
   * 把一首歌从本地索引里剔掉（m36690 第⑥点）。
   *
   * 走这条路的只有一种情况：文件在、`existsSync` 也是 true，但 `<audio>`
   * 解不了码 —— 要么是没下完的半截文件，要么是扩展名和内容对不上。索引里
   * 留着它，「√」就会一直亮着，用户每次点播放都要再撞一次同样的错。
   *
   * 剔除后照例广播，别的窗口（小窗、歌单页）的标记也跟着灭。
   */
  ipcMain.handle('local:drop', (_e, id) => {
    const removed = localIndex.drop(id);
    if (removed) broadcast('local:changed', { ids: localIndex.ids(), info: localIndex.info() });
    return { ok: true, removed };
  });

  /** 清空索引（「清除本地索引」用）。 */
  ipcMain.handle('local:forget', () => {
    const res = localIndex.forget();
    broadcast('local:changed', { ids: [], info: localIndex.info() });
    return res;
  });

  /** 在资源管理器里定位某个本地文件。 */
  ipcMain.handle('local:reveal', (_e, id) => {
    const hit = localIndex.resolve(id);
    if (hit) shell.showItemInFolder(hit.file);
    return { ok: !!hit };
  });

  ipcMain.handle('window:control', (_e, action) => {
    if (!mainWindow) return { ok: false };
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break;
      case 'close': mainWindow.close(); break;
      case 'toggleDevTools': mainWindow.webContents.toggleDevTools(); break;
    }
    return { ok: true, maximized: mainWindow.isMaximized() };
  });

  // ------------------------------------------------------------ 封面另存为（第 9 点）

  /**
   * 把一张封面图存到用户挑的位置。
   *
   * 走主进程而不是渲染层的 `<a download>`：封面 URL 在 http:// 的 CDN 上，
   * 渲染成链接让 Chromium 自己下会因为同样的 http 问题拿不到内容；这里复用
   * `net.fetch`（已经把 scheme 升成 https）取字节，再让用户选路径。
   *
   * `suggestName` 只作为默认文件名，扩展名按响应头的 content-type 定，
   * 不信任调用方给的字符串。
   */
  ipcMain.handle('cover:save', async (_e, payload) => {
    if (!mainWindow) return { ok: false, canceled: true };
    const p = payload || {};
    const rawUrl = String(p.url || '');
    if (!/^https?:\/\//i.test(rawUrl)) return { ok: false, error: '无效的封面地址' };
    // 文件名里不能有路径分隔符和 Windows 保留字符
    const safe = String(p.name || '封面').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || '封面';
    try {
      const res = await net.fetch(rawUrl.replace(/^http:\/\//i, 'https://'), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://music.163.com/',
        },
      });
      if (!res.ok) return { ok: false, error: '下载封面失败 HTTP ' + res.status };
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : type.includes('gif') ? '.gif' : '.jpg';
      const r = await dialog.showSaveDialog(mainWindow, {
        title: '保存封面',
        defaultPath: path.join(app.getPath('pictures'), safe + ext),
        filters: [{ name: '图片', extensions: [ext.slice(1)] }],
        buttonLabel: '保存',
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(r.filePath, buf);
      return { ok: true, file: r.filePath, bytes: buf.length };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  // ------------------------------------------------------------ 悬浮小窗（第 6/7 点）

  ipcMain.handle('mini:open', (_e, mode) => openMini(mode));
  ipcMain.handle('mini:close', () => closeMini(false));
  ipcMain.handle('mini:focusMain', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainAppear();
    return { ok: true };
  });
  // 渲染进程已经把入场动画的起始状态挂好了，可以显示了
  ipcMain.on('window:shown', () => showMainNow());
  ipcMain.handle('mini:onTop', (_e, on) => {
    if (mini.win && !mini.win.isDestroyed()) mini.win.setAlwaysOnTop(!!on, 'floating');
    return { ok: true };
  });
  ipcMain.on('mini:dragStart', () => startMiniDrag());
  ipcMain.on('mini:dragEnd', () => endMiniDrag());
  // 小窗刚加载完就来要一次状态，主窗口负责把当前歌曲/歌词/进度推过来
  ipcMain.on('mini:hello', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mini:hello');
  });
  // 小窗 → 主窗口（播放控制、跳转）
  ipcMain.on('mini:cmd', (_e, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mini:cmd', payload);
  });
  // 主窗口 → 小窗（状态、队列）
  ipcMain.on('mini:state', (_e, payload) => miniSend('mini:state', payload));
  ipcMain.on('mini:queue', (_e, payload) => miniSend('mini:queue', payload));

  // ------------------------------------------------------------ 皮肤（第 8/9 点）

  ipcMain.handle('skin:get', () => ({ skin: config.skin || 'classic' }));
  ipcMain.handle('skin:set', (_e, skin) => {
    // 白名单校验：config.json 是可以手改的，脏值会让 <html> 上出现一个没有任何
    // 规则匹配的 data-skin，界面直接退化成裸样式。不认识就落回经典黑。
    const next = SKIN_IDS.includes(skin) ? skin : 'classic';
    config.skin = next;
    saveConfig();
    // 主窗口和小窗都要跟着换，小窗是独立进程，必须显式广播
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('skin:changed', next);
    }
    return { ok: true, skin: next };
  });
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    configPath = path.join(app.getPath('userData'), 'config.json');
    loadConfig();
    registerImageProtocol();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

process.on('uncaughtException', (e) => console.error('[main] uncaught:', e));
