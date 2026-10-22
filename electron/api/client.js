'use strict';
/**
 * HTTP layer for NetEase Cloud Music.
 *
 * Two request dialects are needed:
 *   - plain:  GET /api/...            read-only endpoints, cookie is enough
 *   - weapi:  POST /weapi/...         login + all state-changing endpoints,
 *                                     body is AES+RSA wrapped (see crypto.js)
 *
 * Cookies live in a Map so a login can hand us MUSIC_U and we keep it for the
 * rest of the session, exactly like a browser.
 */
const { weapi } = require('./crypto.js');

const BASE = 'https://music.163.com';
/** App 方言走这个域名，少数 weapi 下永远失败的接口只在这里正常（见 postApp）。 */
const APP_BASE = 'https://interface.music.163.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const APP_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152';

class ApiError extends Error {
  constructor(code, message, payload) {
    super(message || `API error ${code}`);
    this.code = code;
    this.payload = payload;
  }
}

class NeteaseClient {
  constructor() {
    this.cookies = new Map();
    this.profile = null;
  }

  // ---------- cookie handling ----------

  /**
   * Replace the whole jar from a raw `document.cookie` style string.
   *
   * 用户 m08537 第⑦点：界面上的提示写着「从开发者工具复制 MUSIC_U」，
   * 很多人就真的只复制了那串值 —— 没有 `MUSIC_U=` 前缀、也没有分号。
   * 原来的实现只认 `k=v`，这种裸值会被 `i > 0` 过滤掉，jar 空空如也，
   * 于是明明是对的 cookie 也被报成「Cookie 无效或已过期」。
   * 现在：整串不含 `=` 时当作裸 MUSIC_U 值直接收下；含 `=` 但没写
   * 键名（`=xxx`）也按 MUSIC_U 处理。整段 Cookie 头照旧解析。
   */
  setCookieString(str) {
    this.cookies.clear();
    if (!str) return;
    const raw = String(str).trim().replace(/^cookie:\s*/i, '');
    if (!raw) return;
    if (!raw.includes('=')) {
      this.cookies.set('MUSIC_U', raw);
      return;
    }
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) this.cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      else if (i === 0 && part.trim().length > 1) this.cookies.set('MUSIC_U', part.slice(1).trim());
    }
  }

  getCookieString() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(key) {
    return this.cookies.has(key);
  }

  get csrf() {
    return this.cookies.get('__csrf') || '';
  }

  /** True when we hold the real auth token. */
  get isLoggedIn() {
    return this.cookies.has('MUSIC_U');
  }

  /** Absorb Set-Cookie headers returned by a response. */
  _absorb(res) {
    let list = [];
    try {
      list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    } catch { /* older runtimes */ }
    if (!list.length) {
      const single = res.headers.get('set-cookie');
      if (single) list = [single];
    }
    for (const raw of list) {
      const kv = raw.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) {
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (v === '' || /^EXPIRED$/i.test(v)) this.cookies.delete(k);
        else this.cookies.set(k, v);
      }
    }
    return list;
  }

  // ---------- requests ----------

  async _fetch(url, init) {
    const headers = Object.assign(
      {
        'User-Agent': UA,
        Referer: BASE + '/',
        Origin: BASE,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: '*/*',
      },
      init.headers || {}
    );
    const cookie = this.getCookieString();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, Object.assign({}, init, { headers }));
    this._absorb(res);
    return res;
  }

  /** Plain GET against /api/. `params` is an object of query values. */
  async get(path, params = {}, opts = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const url = (opts.base || BASE) + path + (qs.toString() ? '?' + qs : '');
    const res = await this._fetch(url, { method: 'GET' });
    return this._parse(res, path);
  }

  /** Encrypted POST against /weapi/. */
  async post(path, data = {}, lenient = false) {
    const url = `${BASE}/weapi/${path.replace(/^\/?weapi\//, '').replace(/^\//, '')}?csrf_token=${this.csrf}`;
    const body = new URLSearchParams(weapi(data)).toString();
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return this._parse(res, path, lenient);
  }

  /**
   * @param {boolean} lenient 为 true 时即使 code 非 200 也把响应体返回。
   *   风控接口会把成功写成**字符串** `"200"`（`json.code !== 200` 严格比较不成立），
   *   走严格模式会把成功当失败抛出，而抛出后 payload 又被 tryPost 丢掉。
   */
  async _parse(res, path, lenient = false) {
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(-1, `响应不是 JSON (${path}): ${text.slice(0, 120)}`, text);
    }
    if (!lenient && json.code && json.code !== 200) {
      throw new ApiError(json.code, json.message || json.msg || `code ${json.code}`, json);
    }
    return json;
  }

  /**
   * 明文 POST 到 `interface.music.163.com` 的 App 方言。
   *
   * 少数接口在 weapi 方言下永远失败（关注用户只会得到 code 250「关注异常」），
   * 但在这个方言下正常。它要求的 Cookie 不是浏览器那条，而是一串把 os /
   * appver / deviceId / __csrf / MUSIC_U 等字段百分号编码后拼起来的「头部
   * cookie」；缺少 MUSIC_U 时会退化成未登录。
   *
   * 成功响应里没有 code 字段（直接返回 user 对象），所以 `_parse` 会当作正常。
   */
  async postApp(path, data = {}) {
    const fields = {
      osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
      deviceId: 'NeteaseLite',
      os: 'pc',
      appver: '3.0.18.203152',
      versioncode: '140',
      mobilename: '',
      buildver: String(Date.now()).slice(0, 10),
      resolution: '1920x1080',
      __csrf: this.csrf,
      channel: 'netease',
      requestId: `${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`,
    };
    const musicU = this.cookies.get('MUSIC_U');
    if (musicU) fields.MUSIC_U = musicU;
    const cookie = Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('; ');

    const res = await fetch(APP_BASE + path, {
      method: 'POST',
      headers: {
        'User-Agent': APP_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: BASE + '/',
        Cookie: cookie,
      },
      body: new URLSearchParams(data).toString(),
    });
    return this._parse(res, path);
  }

  /**
   * Like `_parse` but never throws on a non-200 code — used where failure is normal.
   * @param {boolean} lenient 透传给 `post`：风控接口把成功写成字符串 `"200"`，
   *   严格模式会把它当失败抛出，而抛出后 `data` 就没了。
   */
  async tryPost(path, data, lenient = false) {
    try {
      return await this.post(path, data, lenient);
    } catch (e) {
      return { code: e.code ?? -1, message: e.message };
    }
  }

  async tryGet(path, params, opts) {
    try {
      return await this.get(path, params, opts);
    } catch (e) {
      return { code: e.code ?? -1, message: e.message };
    }
  }
}

module.exports = { NeteaseClient, ApiError, BASE, UA };
