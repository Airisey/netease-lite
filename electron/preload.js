'use strict';
/**
 * The only bridge between the page and the main process.
 * `window.ne.call(method, ...args)` mirrors the Netease API surface.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Arguments injected by the main process through `webPreferences.additionalArguments`.
 * The skin has to be known *before* the stylesheets are parsed, otherwise switching
 * to 现代白 flashes a dark first paint, so it travels in argv rather than over IPC.
 */
function argvValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

/** '' in the main window, 'v' / 'h' in a floating mini window. */
const miniMode = argvValue('--mini-mode=');
const bootSkin = argvValue('--boot-skin=') || 'classic';
/**
 * 应用版本号（用户 m05071 第⑤点：设置里的「关于」要显示真实版本号）。
 *
 * 和皮肤一样从 argv 带进来而不是走 IPC：`app.getVersion()` 读的是 package.json，
 * 主进程在窗口创建时就有值，同步拿到比页面渲染完再异步补一个数字简单得多，
 * 「关于」页也就不会先闪一下旧版本号。
 */
const appVersion = argvValue('--app-version=');
const REPO_DESKTOP = 'https://github.com/Airisey/netease-lite';
const REPO_ANDROID = 'https://github.com/Airisey/netease-lite-android';

contextBridge.exposeInMainWorld('ne', {
  /** 版本号与两个仓库地址（「关于」页用），见上面的注释。 */
  appVersion,
  repo: { desktop: REPO_DESKTOP, android: REPO_ANDROID },

  /** Invoke a whitelisted API method. Resolves to the raw result, throws on error. */
  async call(method, ...args) {
    const res = await ipcRenderer.invoke('api', { method, args });
    if (!res.ok) {
      const err = new Error(res.error.message);
      err.code = res.error.code;
      err.needLogin = !!res.error.needLogin;
      throw err;
    }
    return res.result;
  },

  /** Same, but resolves `{ok:false,error}` instead of throwing. */
  callSafe(method, ...args) {
    return ipcRenderer.invoke('api', { method, args });
  },

  auth: {
    state: () => ipcRenderer.invoke('auth:state'),
    setCookie: (c) => ipcRenderer.invoke('auth:setCookie', c),
    clearCookie: () => ipcRenderer.invoke('auth:clearCookie'),
  },

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },

  quality: {
    /** [{ key, label }] */
    list: () => ipcRenderer.invoke('quality:list'),
  },

  /** 缓存目录（第 13 点）：只负责选目录 / 复位，改完要重启才真正生效。 */
  cache: {
    get: () => ipcRenderer.invoke('cache:get'),
    choose: () => ipcRenderer.invoke('cache:choose'),
    reset: () => ipcRenderer.invoke('cache:reset'),
    /** 当前占用字节数（第 6 点「缓存最大大小」旁边要显示） */
    size: () => ipcRenderer.invoke('cache:size'),
    /** 超过上限时清空缓存；maxMb 为 0 表示不限制 */
    trim: (maxMb) => ipcRenderer.invoke('cache:trim', maxMb),
    /** 清掉所有缓存并重启（设置页的「刷新」）。不动登录态 */
    refresh: () => ipcRenderer.invoke('app:refresh'),
  },

  window: {
    control: (action) => ipcRenderer.invoke('window:control', action),
    minimize: () => ipcRenderer.invoke('window:control', 'minimize'),
    maximize: () => ipcRenderer.invoke('window:control', 'maximize'),
    close: () => ipcRenderer.invoke('window:control', 'close'),
    toggleDevTools: () => ipcRenderer.invoke('window:control', 'toggleDevTools'),
    onState: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('window:state', h);
      return () => ipcRenderer.removeListener('window:state', h);
    },
    /** 从小窗回到主界面时，主进程先通知这里挂入场动画的起始类，等我们回执再显示窗口 */
    onAppear: (cb) => {
      const h = () => cb();
      ipcRenderer.on('window:appear', h);
      return () => ipcRenderer.removeListener('window:appear', h);
    },
    shown: () => ipcRenderer.send('window:shown'),
  },

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // ---------------------------------------------------------------- 下载（第 5 点）

  /**
   * 下载跑在主进程（渲染层没有 fs，而且直链要带 Referer 才不被 CDN 拒）。
   * 这里只做转发：设置读写、挑目录、投递任务、收进度事件。
   */
  download: {
    settings: () => ipcRenderer.invoke('download:settings'),
    set: (patch) => ipcRenderer.invoke('download:set', patch),
    chooseDir: () => ipcRenderer.invoke('download:chooseDir'),
    resetDir: () => ipcRenderer.invoke('download:resetDir'),
    /** songs 是歌曲对象数组；quality 不传就用设置里的默认音质 */
    add: (songs, quality) => ipcRenderer.invoke('download:add', { songs, quality }),
    cancel: (key) => ipcRenderer.invoke('download:cancel', key),
    pause: (key) => ipcRenderer.invoke('download:pause', key),
    resume: (key) => ipcRenderer.invoke('download:resume', key),
    pauseAll: () => ipcRenderer.invoke('download:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('download:resumeAll'),
    clearAll: () => ipcRenderer.invoke('download:clearAll'),
    clearFinished: () => ipcRenderer.invoke('download:clearFinished'),
    list: () => ipcRenderer.invoke('download:list'),
    reveal: (key) => ipcRenderer.invoke('download:reveal', key),
    onList: (cb) => {
      const h = (_e, list) => cb(list);
      ipcRenderer.on('download:list', h);
      return () => ipcRenderer.removeListener('download:list', h);
    },
  },

  /** 把一张封面图另存到本地（第 9 点）。 */
  saveCover: (url, name) => ipcRenderer.invoke('cover:save', { url, name }),

  // ---------------------------------------------------------------- 本地扫描（m35069 第 2 点）

  /**
   * 本机已有的歌曲索引。渲染层据此做两件事：歌曲行的「√」是否亮起、
   * 播放时优先走本地文件。
   *
   * 扫描本身在主进程（渲染层没有 fs，几千个文件的递归遍历也会卡住界面）。
   */
  local: {
    /** { count, dirs, at } */
    info: () => ipcRenderer.invoke('local:info'),
    /** 已匹配到的歌曲 id 数组 */
    ids: () => ipcRenderer.invoke('local:ids'),
    /** 索引的完整内容：[{ id, file, quality, name, size, mtime }]（已下载音乐页的列表源） */
    entries: () => ipcRenderer.invoke('local:entries'),
    /**
     * 查一首歌的本地文件 → { file, url, mime, name, quality } | null
     *
     * 第二个参数 `want` 是用户当前选的音质（用户 m11461 第③点）：传了就只有
     * 「本地这份够这一档」时才返回，不够返回 null 让播放器去取新流。
     */
    resolve: (id, want) => ipcRenderer.invoke('local:resolve', id, want),
    /** 弹框挑文件夹并扫描；songs 是当前歌单的歌曲数组 */
    choose: (songs) => ipcRenderer.invoke('local:choose', songs),
    /** 直接扫一个已知目录（不弹框） */
    scan: (dir, songs) => ipcRenderer.invoke('local:scan', { dir, songs }),
    /** 剔除索引里失效的条目（文件被删 / 挪走），返回 { removed, total } */
    rescan: () => ipcRenderer.invoke('local:rescan'),
    /** 剔掉单首歌的索引（文件在但解不了码时由播放器上报） */
    drop: (id) => ipcRenderer.invoke('local:drop', id),
    /** 清空索引 */
    forget: () => ipcRenderer.invoke('local:forget'),
    /** 在资源管理器里定位本地文件 */
    reveal: (id) => ipcRenderer.invoke('local:reveal', id),
    /** 索引变化（扫描完成 / 下载完成）时推过来 { ids, info } */
    onChanged: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('local:changed', h);
      return () => ipcRenderer.removeListener('local:changed', h);
    },
    /** 扫描进度（m00001 第②点）：{ phase, pct, file, done, total, found } */
    onProgress: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('local:progress', h);
      return () => ipcRenderer.removeListener('local:progress', h);
    },
  },

  /**
   * 音乐云盘的上传（用户 m05718）。
   *
   * `upload()` 弹系统文件框并开始传，返回 `{ ok, added, failed, canceled }`；
   * 进度走 `onProgress`：`{ stage, index, count, name, sent, total }`。
   */
  cloud: {
    upload: () => ipcRenderer.invoke('cloud:upload'),
    onProgress: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('cloud:progress', h);
      return () => ipcRenderer.removeListener('cloud:progress', h);
    },
  },

  /** Rewrite a CDN url through the main-process image proxy. */
  img: (url) => (url ? `neimg://img/?u=${encodeURIComponent(url)}` : ''),

  // ---------------------------------------------------------------- 皮肤（第 8/9 点）

  /** 'classic' | 'light' — read synchronously in <head> by boot.js. */
  bootSkin,
  skin: {
    get: () => ipcRenderer.invoke('skin:get'),
    set: (id) => ipcRenderer.invoke('skin:set', id),
    onChanged: (cb) => {
      const h = (_e, id) => cb(id);
      ipcRenderer.on('skin:changed', h);
      return () => ipcRenderer.removeListener('skin:changed', h);
    },
  },

  // ---------------------------------------------------------------- 悬浮小窗（第 6/7 点）

  /** '' in the main window; 'v' | 'h' in a mini window. */
  miniMode,
  mini: {
    open: (mode) => ipcRenderer.invoke('mini:open', mode),
    close: () => ipcRenderer.invoke('mini:close'),
    focusMain: () => ipcRenderer.invoke('mini:focusMain'),
    onTop: (on) => ipcRenderer.invoke('mini:onTop', on),
    // 拖动：渲染进程只报"按下/松开"，位置由主进程轮询光标算
    dragStart: () => ipcRenderer.send('mini:dragStart'),
    dragEnd: () => ipcRenderer.send('mini:dragEnd'),
    /**
     * 主进程正在做移出 / 移入滑动。滑动期间要摘掉歌词 mask 和发光这类昂贵合成，
     * 否则透明窗口每移一帧都要重算一遍，看起来就是卡顿（同拖动时的 `.is-dragging`）。
     */
    onSliding: (cb) => {
      const h = (_e, on) => cb(!!on);
      ipcRenderer.on('mini:sliding', h);
      return () => ipcRenderer.removeListener('mini:sliding', h);
    },
    // 小窗 → 主窗口（播放控制、跳转）
    cmd: (payload) => ipcRenderer.send('mini:cmd', payload),
    onCmd: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('mini:cmd', h);
      return () => ipcRenderer.removeListener('mini:cmd', h);
    },
    // 主窗口 → 小窗
    hello: () => ipcRenderer.send('mini:hello'),
    onHello: (cb) => {
      const h = () => cb();
      ipcRenderer.on('mini:hello', h);
      return () => ipcRenderer.removeListener('mini:hello', h);
    },
    onOpened: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('mini:opened', h);
      return () => ipcRenderer.removeListener('mini:opened', h);
    },
    state: (payload) => ipcRenderer.send('mini:state', payload),
    onState: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('mini:state', h);
      return () => ipcRenderer.removeListener('mini:state', h);
    },
    queue: (payload) => ipcRenderer.send('mini:queue', payload),
    onQueue: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('mini:queue', h);
      return () => ipcRenderer.removeListener('mini:queue', h);
    },
  },
});
