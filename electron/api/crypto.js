'use strict';
/**
 * NetEase Cloud Music request encryption.
 *
 * The public web API accepts plain GETs for read-only endpoints, but every
 * state-changing endpoint (login, playlist edits, likes) goes through /weapi/
 * and expects an AES+RSA wrapped body.
 *
 *   params    = AES-128-CBC( AES-128-CBC(json, PRESET_KEY), secretKey )   -> base64
 *   encSecKey = RSA( secretKey )  -- textbook modexp, little-endian input
 */
const crypto = require('node:crypto');

const IV = Buffer.from('0102030405060708');
const PRESET_KEY = Buffer.from('0CoJUm6Qyw8W8jud');
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUB_KEY = '010001';
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629' +
  'ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d8' +
  '13cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';

const BI_PUB = BigInt('0x' + PUB_KEY);
const BI_MOD = BigInt('0x' + MODULUS);

function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

/** Textbook RSA over the little-endian byte order the site uses. */
function rsaEncrypt(text) {
  const reversedHex = Buffer.from(text, 'utf8').reverse().toString('hex');
  const m = BigInt('0x' + reversedHex);
  return modPow(m, BI_PUB, BI_MOD).toString(16).padStart(256, '0');
}

/**
 * 密码摘要（m03577 第⑧点）。
 *
 * 手机号密码登录的密文接口只认 `md5_password`：服务端拿到 `password` 之后
 * 不会再帮你算一遍，直接把明文当摘要去比对，于是永远 502「账号或密码错误」。
 * 参考实现（NeteaseCloudMusicApi 的 login_cellphone）也是这么处理的：
 *   `[captcha ? 'captcha' : 'password']: captcha ? captcha : md5_password || MD5(password)`
 * 所以这里必须由客户端先做一次 MD5，再把 32 位小写十六进制塞进 password 字段。
 * 验证码登录走的是 `captcha` 分支，不需要这个。
 */
function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function randomKey(len = 16) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += BASE62[bytes[i] % BASE62.length];
  return out;
}

/** Build the { params, encSecKey } form body for a /weapi/ POST. */
function weapi(data) {
  const text = JSON.stringify(data);
  const secretKey = randomKey(16);
  return {
    params: aesEncrypt(aesEncrypt(text, PRESET_KEY), Buffer.from(secretKey, 'utf8')),
    encSecKey: rsaEncrypt(secretKey),
  };
}

module.exports = { weapi, aesEncrypt, rsaEncrypt, randomKey, md5 };
