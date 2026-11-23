/**
 * 利用コードを確かめ、通行証を発行する。コードの一覧はシートの「利用者」タブにある。
 */

import { lookupUser, normalizeCode } from '../src/auth/users.js';
import { issueSession } from '../src/auth/session.js';
import { appsScriptConfig } from '../src/storage/appsScript.js';

/** 総当たりを遅くするため、失敗時は少し待ってから返す。 */
const FAILURE_DELAY_MS = 800;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ code: 'server', error: 'POSTで呼び出してください。' });
  if (!appsScriptConfig()) return response.status(501).json({ code: 'not_configured', error: '保存先が設定されていません。' });

  const code = normalizeCode(request.body?.code);
  let user;
  try {
    user = code ? await lookupUser(code) : null;
  } catch (error) {
    console.error('[login]', error);
    return response.status(error?.code === 'not_configured' ? 500 : 502).json({
      code: error?.code === 'not_configured' ? 'not_configured' : 'network',
      error: error?.message ?? 'コードの確認先に接続できませんでした。',
      ...(error?.detail ? { detail: error.detail } : {}),
    });
  }

  if (!user) {
    await wait(Number(process.env.LOGIN_FAILURE_DELAY_MS ?? FAILURE_DELAY_MS));
    return response.status(401).json({ code: 'unauthorized', error: 'コードが違うか、使えなくなっています。' });
  }
  response.status(200).json({ token: issueSession({ name: user.name, code }), user: user.name, admin: user.admin });
}
