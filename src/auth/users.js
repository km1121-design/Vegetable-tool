/**
 * 利用コードを、シートの「利用者」タブと照合する。
 *
 * 一覧はシートにあり、シートを直すだけで追加・停止できる。照合は呼び出しのたびに
 * 行うので、「有効」を外した時点で使えなくなる。
 */

import { appsScriptConfig, callAppsScript } from '../storage/appsScript.js';
import { readBearer, verifySession } from './session.js';

/** コードの表記ゆれ（全角・空白・ハイフン）を吸収する。 */
export function normalizeCode(code) {
  return String(code ?? '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s　-]/g, '')
    .trim();
}

/** コードが有効なら {name, admin}、無効なら null。照合先に届かないときは throw。 */
export async function lookupUser(code) {
  if (!normalizeCode(code) || !appsScriptConfig()) return null;
  try {
    const data = await callAppsScript({ action: 'login', code: normalizeCode(code) });
    if (!data?.user) return null;
    return { name: String(data.user), admin: data.admin === true };
  } catch (error) {
    if (error?.code === 'unauthorized') return null;
    throw error;
  }
}

/**
 * API の入口で呼ぶ。通れば {name, code, admin}。通らなければ 401/502 を返して null。
 * 権限（admin）は画面の表示に頼らず、ここで毎回シートから読み直したものを使う。
 */
export async function requireUser(request, response) {
  const session = verifySession(readBearer(request));
  const deny = (message) => {
    response.status(401).json({ code: 'unauthorized', error: message });
    return null;
  };
  if (!session) return deny('利用コードを入力してください。');

  let user;
  try {
    user = await lookupUser(session.code);
  } catch (error) {
    console.error('[auth]', error);
    response.status(502).json({ code: 'network', error: 'コードの確認先に接続できませんでした。' });
    return null;
  }
  if (!user) return deny('このコードは使えなくなりました。');
  return { ...user, code: normalizeCode(session.code) };
}
