/**
 * ログイン状態を表す、署名つきの通行証。
 *
 * 中身は {名前, コード, 期限}。署名はサーバーだけが知る秘密で行うので、
 * 端末側で書き換えると検証に通らない。通行証が正しくても、呼び出しのたびに
 * シート側でコードが有効かを確かめ直す（users.js）。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** ログインが保たれる期間。 */
export const SESSION_DAYS = 90;

/**
 * 署名の秘密。SESSION_SECRET があればそれを、無ければ APPS_SCRIPT_TOKEN から派生させる
 * （環境変数を増やさずに済ませるため）。
 */
function secret() {
  const base = process.env.SESSION_SECRET?.trim() || process.env.APPS_SCRIPT_TOKEN?.trim();
  if (!base) return null;
  return createHash('sha256').update(`field-app-session:${base}`).digest();
}

const encode = (buffer) => Buffer.from(buffer).toString('base64url');
const sign = (payload, key) => encode(createHmac('sha256', key).update(payload).digest());

export function issueSession({ name, code }, now = Date.now()) {
  const key = secret();
  if (!key) throw new Error('署名の秘密が設定されていません。');
  const payload = encode(JSON.stringify({ n: name, c: code, exp: now + SESSION_DAYS * 86_400_000 }));
  return `${payload}.${sign(payload, key)}`;
}

/** 正しければ {name, code}、そうでなければ null。 */
export function verifySession(token, now = Date.now()) {
  const key = secret();
  if (!key || typeof token !== 'string') return null;

  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data?.exp !== 'number' || data.exp < now) return null;
    if (typeof data.c !== 'string' || !data.c) return null;
    return { name: String(data.n ?? ''), code: data.c };
  } catch {
    return null;
  }
}

export function readBearer(request) {
  const header = request.headers?.authorization ?? request.headers?.Authorization ?? '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
