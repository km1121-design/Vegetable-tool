/**
 * 日当（誰が・いつ・どのコース・件数・出発と終了の時刻）。1便・2便は分けず、1日1行。
 *
 *   GET  ?month=YYYY-MM          … 自分の分。管理者は &all=1 で全員分
 *   POST {kind:'start'|'end'|'cancelEnd', date, course}
 *        出発・終了を押す。時刻はサーバーの日本時間。件数はシートの配送タブから数える
 *
 * 権限はシート側でも確かめる（ほかの人の日当は管理者しか読めない）。
 */

import { requireUser } from '../src/auth/users.js';
import { callAppsScript } from '../src/storage/appsScript.js';
import { courseForDate, isCourse, isDate, jstNow } from '../src/domain/route.js';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const user = await requireUser(request, response);
  if (!user) return;

  try {
    if (request.method === 'GET') {
      const all = request.query?.all === '1';
      if (all && !user.admin) return response.status(403).json({ code: 'forbidden', error: '管理者だけが使えます。' });
      const month = request.query?.month ?? jstNow().date.slice(0, 7);
      if (month && !/^\d{4}-\d{2}$/.test(month)) return response.status(400).json({ code: 'invalid', error: '月は YYYY-MM で指定してください。' });
      const data = await callAppsScript({ action: 'payList', code: user.code, all, month });
      const pays = (Array.isArray(data.pays) ? data.pays : []).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
      return response.status(200).json({ month, pays, days: pays.length, done: pays.reduce((sum, p) => sum + (Number(p.done) || 0), 0) });
    }
    if (request.method === 'POST') {
      const kind = request.body?.kind;
      if (!['start', 'end', 'cancelEnd'].includes(kind)) return response.status(400).json({ code: 'invalid', error: '操作の指定が正しくありません。' });
      const date = request.body?.date;
      if (!isDate(date)) return response.status(400).json({ code: 'invalid', error: '日付が正しくありません。' });
      const course = isCourse(request.body?.course) ? request.body.course : courseForDate(date);
      const data = await callAppsScript({ action: 'payPress', code: user.code, date, kind, time: jstNow().time, course });
      return response.status(200).json({ pay: data.pay });
    }
    return response.status(405).json({ code: 'server', error: 'GET か POST で呼び出してください。' });
  } catch (error) {
    console.error('[nittou]', error);
    return response.status(error.status ?? 500).json({
      code: error.code ?? 'server',
      error: error.message ?? '処理に失敗しました。',
      ...(error.detail ? { detail: error.detail } : {}),
    });
  }
}
