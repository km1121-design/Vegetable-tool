/**
 * 記録の保存と一覧（ひな形の業務 API。自分のアプリではここを書き換える）。
 *
 *   GET            … 自分の記録と合計。管理者は ?all=1 で全員分
 *   POST {record}  … 保存（id があれば上書き）
 *
 * 権限はシート側でも確かめる（ここを書き換えても、他人の記録は読めない）。
 */

import { requireUser } from '../src/auth/users.js';
import { callAppsScript } from '../src/storage/appsScript.js';
import { cleanRecord, summarize } from '../src/domain/records.js';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const user = await requireUser(request, response);
  if (!user) return;

  try {
    if (request.method === 'GET') {
      const all = request.query?.all === '1';
      if (all && !user.admin) return response.status(403).json({ code: 'forbidden', error: '管理者だけが使えます。' });
      const data = await callAppsScript({ action: 'recordList', code: user.code, all });
      const records = Array.isArray(data.records) ? data.records : [];
      return response.status(200).json({ records, summary: summarize(records) });
    }
    if (request.method === 'POST') {
      const { record, error } = cleanRecord(request.body?.record);
      if (error) return response.status(400).json({ code: 'invalid', error });
      const data = await callAppsScript({ action: 'recordSave', code: user.code, record });
      return response.status(200).json({ id: data.id });
    }
    return response.status(405).json({ code: 'server', error: 'GET か POST で呼び出してください。' });
  } catch (error) {
    console.error('[records]', error);
    return response.status(error.status ?? 500).json({
      code: error.code ?? 'server',
      error: error.message ?? '処理に失敗しました。',
      ...(error.detail ? { detail: error.detail } : {}),
    });
  }
}
