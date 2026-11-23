/**
 * その日の配送先。
 *
 *   GET  ?date=YYYY-MM-DD                         … その日の配送先・コース・道案内リンク
 *   POST {action:'preview', items}                … 配送リスト PDF の文字から配送先を組み立てて返す（保存しない）
 *   POST {action:'save', date, course, items}     … 読み取って、配る分（✔ があれば ✔ だけ）でその日を置き換える
 *   POST {action:'add', date, course, stop, after} … 急な追加を1件（after 番目の次。空なら最後）
 *   POST {action:'done', date, id, done}          … 完了にする・戻す（時刻はサーバーの日本時間）
 *
 * 読み取りは src/domain/route.js の決まった計算で行う（AI は使わない）。
 */

import { requireUser } from '../src/auth/users.js';
import { callAppsScript } from '../src/storage/appsScript.js';
import {
  DEPARTURE, COURSES, courseForDate, isCourse, isDate, jstNow,
  parseListItems, pickStops, cleanStop, directionsLink, routeLinks,
} from '../src/domain/route.js';

const MAX_ITEMS = 20000;

const fail = (response, status, error) => response.status(status).json({ code: status === 400 ? 'invalid' : 'server', error });

function withLinks(date, stops) {
  const list = (stops ?? []).map((s, i) => ({ ...s, no: i + 1, mapUrl: directionsLink(s.address) }));
  const left = list.filter((s) => !s.doneAt);
  return {
    date,
    course: list[0]?.course || courseForDate(date),
    courses: COURSES.map((c) => c.name),
    departure: DEPARTURE,
    stops: list,
    // 出発地点から順にまわる道案内
    routes: routeLinks(list.map((s) => s.address)),
    // 途中からは、今いる場所から残りの配送先を順にまわる道案内
    restRoutes: left.length && left.length < list.length ? routeLinks(left.map((s) => s.address), { from: '' }) : [],
  };
}

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const user = await requireUser(request, response);
  if (!user) return;

  try {
    if (request.method === 'GET') {
      const date = request.query?.date || jstNow().date;
      if (!isDate(date)) return fail(response, 400, '日付が正しくありません。');
      const data = await callAppsScript({ action: 'dayGet', code: user.code, date });
      return response.status(200).json(withLinks(date, data.stops));
    }
    if (request.method !== 'POST') return fail(response, 405, 'GET か POST で呼び出してください。');

    const body = request.body ?? {};
    const action = body.action;

    if (action === 'preview' || action === 'save') {
      if (!Array.isArray(body.items) || !body.items.length) return fail(response, 400, 'PDF から文字を読み取れませんでした。文字の入った PDF か確かめてください。');
      if (body.items.length > MAX_ITEMS) return fail(response, 400, 'PDF が大きすぎます。');
      const parsed = parseListItems(body.items);
      if (parsed.error) return fail(response, 400, parsed.error);
      const picked = pickStops(parsed.stops);
      if (action === 'preview') {
        return response.status(200).json({ total: parsed.stops.length, checked: parsed.checked, stops: picked });
      }
      const date = body.date;
      if (!isDate(date)) return fail(response, 400, '日付が正しくありません。');
      const course = isCourse(body.course) ? body.course : courseForDate(date);
      const stops = picked.map(({ run, name, address, note }) => ({ run, name, address, note }));
      const data = await callAppsScript({ action: 'daySave', code: user.code, date, course, stops });
      return response.status(200).json(withLinks(date, data.stops));
    }

    if (action === 'add') {
      const date = body.date;
      if (!isDate(date)) return fail(response, 400, '日付が正しくありません。');
      const { stop, error } = cleanStop(body.stop);
      if (error) return fail(response, 400, error);
      const after = body.after === '' || body.after === null || body.after === undefined ? '' : Number(body.after);
      if (after !== '' && (!Number.isInteger(after) || after < 0)) return fail(response, 400, '入れる位置は数字で入れてください。');
      const id = /^[A-Za-z0-9_-]{6,40}$/.test(String(body.stop?.id ?? '')) ? String(body.stop.id) : newId();
      const course = isCourse(body.course) ? body.course : courseForDate(date);
      const data = await callAppsScript({ action: 'dayAdd', code: user.code, date, course, stop: { ...stop, id }, after });
      return response.status(200).json(withLinks(date, data.stops));
    }

    if (action === 'done') {
      const date = body.date;
      if (!isDate(date)) return fail(response, 400, '日付が正しくありません。');
      const id = String(body.id ?? '');
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return fail(response, 400, '配送先の指定が正しくありません。');
      const time = body.done === false ? '' : jstNow().time;
      const data = await callAppsScript({ action: 'dayDone', code: user.code, date, id, time });
      return response.status(200).json(withLinks(date, data.stops));
    }

    return fail(response, 400, '操作の指定が正しくありません。');
  } catch (error) {
    console.error('[day]', error);
    return response.status(error.status ?? 500).json({
      code: error.code ?? 'server',
      error: error.message ?? '処理に失敗しました。',
      ...(error.detail ? { detail: error.detail } : {}),
    });
  }
}
