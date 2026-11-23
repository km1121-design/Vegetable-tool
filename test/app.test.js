/**
 * ログイン → 配送リストの読み込み → 完了 → 追加 → 日当 の通し試験と、決まった計算の試験。
 * 本物の apps-script/endpoint.gs を模擬シートで動かす（Google には接続しない）。
 * 配送先の名前・住所・番号はすべて作りもの（本物のリストはキーボックスの番号を含むので入れない）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOKEN, loadAppsScript, call } from './sheet-harness.js';

process.env.APPS_SCRIPT_URL = 'https://script.example/exec';
process.env.APPS_SCRIPT_TOKEN = TOKEN;
process.env.LOGIN_FAILURE_DELAY_MS = '0';

const { default: login } = await import('../api/login.js');
const { default: day } = await import('../api/day.js');
const { default: nittou } = await import('../api/nittou.js');
const { default: health } = await import('../api/health.js');
const route = await import('../src/domain/route.js');
const { issueSession, verifySession } = await import('../src/auth/session.js');
const { SCRIPT_VERSION } = await import('../src/scriptVersion.js');

const USERS = [['山田', '1111', true, ''], ['佐藤', '2222', '停止', ''], ['事務', '9999', '', '管理者'], ['鈴木', '3333', true, '']];

async function signIn(code) {
  const { status, data } = await call(login, { body: { code } });
  assert.equal(status, 200);
  return data.token;
}

/* ---------- 見本の PDF（pdf.js が返す形の文字）を作る ---------- */

// 列の位置は本物の配送リストに近づけてある（会社名 ≒ 180、住所 ≒ 300、備考 ≒ 470）
const H = { name: 179, addr: 299, note: 467 };
const item = (x, y, s, w = s.length * 4.5) => ({ p: 1, x, y, w, s });
const cell = (center, y, s) => item(center - (s.length * 4.5) / 2, y, s);

/** rows: [{name, addr, note, check, y}] / sections: [{y, text}] */
function makeList({ rows, sections = [], withCheckHeader = false, stray = [] }) {
  const items = [
    ...(withCheckHeader ? [item(68, 62, '✔'), item(94, 62, '出発時間')] : []),
    cell(H.name + 9, 62, '会社名'), cell(H.addr + 5, 62, '住所'), cell(H.note + 5, 62, '備考'),
    ...sections.map((s) => item(274, s.y, s.text)),
    ...stray,
  ];
  for (const r of rows) {
    if (r.check) items.push(item(68, r.y, '✔'), item(74, r.y + 1, '️', 0));
    if (r.name) items.push(cell(H.name + 9, r.y, r.name));
    if (r.addr) items.push(cell(H.addr + 5, r.addrY ?? r.y, r.addr));
    for (const [i, line] of (r.note ?? []).entries()) items.push(cell(H.note + 5, (r.noteY ?? r.y) + i * 5, line));
  }
  return items;
}

/** A（コース表）の形：1便・2便、✔ が一部だけ、2行にまたがる備考、2件で1つの住所欄。 */
const LIST_A = makeList({
  withCheckHeader: true,
  sections: [{ y: 73, text: '1便→4時着車、積み込み後に出発' }, { y: 120, text: '2便→1便終了後に戻り次第出発' }],
  rows: [
    { y: 85, check: true, name: '見本商店 一号店', addr: '東京都板橋区見本町１丁目１−１', note: ['9時まで キーボックス 0000'] },
    { y: 96, check: true, name: '見本食堂', addr: '東京都豊島区見本２丁目２−２', note: ['8時まで', '裏口から入る'], noteY: 94 },
    { y: 108, check: false, name: '見本カフェ', addr: '東京都北区見本３丁目３−３' },
    { y: 132, check: true, name: '見本ビル 1F', addr: '東京都新宿区見本4-4-4', addrY: 137, note: ['扉前に置き配可'], noteY: 137 },
    { y: 143, check: true, name: '見本ビル 2F' },
    { y: 154, check: false, name: '見本バル', addr: '東京都新宿区見本５丁目５−５', note: ['14時まで'] },
  ],
});

/** B・C の形：✔ なし。左端に見出しの無い「1」の列がある。 */
const LIST_B = makeList({
  stray: [item(87, 83, '1'), item(87, 96, '1')],
  rows: [
    { y: 83, name: '見本パン', addr: '〒173-0000 東京都板橋区見本６−６', note: ['鍵あり'] },
    { y: 90, name: '見本園 保育園', addr: '〒173-0000 東京都板橋区見本７−７', addrY: 93 },
    { y: 96, name: '見本園 レストラン' },
    { y: 102, name: '見本バーガー', addr: '〒171-0000 東京都豊島区見本８−８ B1F', note: ['ソファーの上に置き配'] },
  ],
});

/* ---------- 決まった計算 ---------- */

test('曜日でコースが決まる（水曜・日曜は専用、ほかはコース表）', () => {
  assert.equal(route.courseForDate('2026-11-23'), 'コース表'); // 月
  assert.equal(route.courseForDate('2026-11-25'), '水曜コース');
  assert.equal(route.courseForDate('2026-11-28'), 'コース表'); // 土
  assert.equal(route.courseForDate('2026-11-29'), '日曜コース');
  assert.equal(route.jstNow(Date.UTC(2026, 10, 22, 20, 5)).date, '2026-11-23');
  assert.equal(route.jstNow(Date.UTC(2026, 10, 22, 20, 5)).time, '05:05');
});

test('A の形：便・✔・複数行の備考・2件で1つの住所欄を読み取る', () => {
  const { stops, checked, error } = route.parseListItems(LIST_A);
  assert.equal(error, undefined);
  assert.deepEqual(stops.map((s) => s.name), ['見本商店 一号店', '見本食堂', '見本カフェ', '見本ビル 1F', '見本ビル 2F', '見本バル']);
  assert.deepEqual(stops.map((s) => s.run), ['1便', '1便', '1便', '2便', '2便', '2便']);
  assert.equal(checked, 4);
  assert.equal(stops[1].note, '8時まで\n裏口から入る');
  assert.equal(stops[0].note, '9時まで キーボックス 0000');
  // 結合された住所欄は2件とも同じ住所・備考
  assert.equal(stops[3].address, '東京都新宿区見本4-4-4');
  assert.equal(stops[4].address, '東京都新宿区見本4-4-4');
  assert.equal(stops[4].note, '扉前に置き配可');
  assert.equal(stops[5].address, '東京都新宿区見本５丁目５−５');

  const picked = route.pickStops(stops);
  assert.deepEqual(picked.map((s) => s.name), ['見本商店 一号店', '見本食堂', '見本ビル 1F', '見本ビル 2F']);
  assert.deepEqual(picked.map((s) => s.order), [1, 2, 3, 4]);
});

test('B・C の形：✔ が無ければ全部。見出しの無い列の「1」は無視する', () => {
  const { stops, checked } = route.parseListItems(LIST_B);
  assert.equal(checked, 0);
  assert.deepEqual(stops.map((s) => s.name), ['見本パン', '見本園 保育園', '見本園 レストラン', '見本バーガー']);
  assert.equal(stops[1].address, '〒173-0000 東京都板橋区見本７−７');
  assert.equal(stops[2].address, '〒173-0000 東京都板橋区見本７−７');
  assert.equal(route.pickStops(stops).length, 4);
});

test('離れた文字のかけらの間には空白を入れ、くっついたかけらはつなぐ', () => {
  const items = [cell(188, 62, '会社名'), cell(304, 62, '住所'), cell(472, 62, '備考'),
    item(173, 80, 'z', 2), item(175.2, 80, 'tt', 3), item(178.2, 80, 'o', 2), item(181.6, 80, 'mo', 6), item(187.6, 80, 'rning', 8),
    item(260, 80, '東京都千代田区見本', 40)];
  assert.equal(route.parseListItems(items).stops[0].name, 'ztto morning');
});

test('見出しの無い PDF は分かる言葉で断る', () => {
  assert.match(route.parseListItems([item(10, 10, 'こんにちは')]).error, /見出し/);
  assert.match(route.parseListItems([]).error, /見出し/);
});

test('道案内のリンク（〒を外す・出発地点から10件ずつ・今いる場所から）', () => {
  const one = route.directionsLink('〒160-0000 東京都新宿区見本1-1');
  assert.ok(one.startsWith('https://www.google.com/maps/dir/?api=1&destination='));
  assert.equal(new URL(one).searchParams.get('destination'), '東京都新宿区見本1-1');
  assert.equal(new URL(one).searchParams.get('origin'), null);

  const addresses = Array.from({ length: 23 }, (u, i) => `東京都見本${i + 1}`);
  const links = route.routeLinks(addresses);
  assert.deepEqual(links.map((l) => [l.from, l.to]), [[1, 10], [11, 20], [21, 23]]);
  const first = new URL(links[0].url).searchParams;
  assert.equal(first.get('origin'), '東京都板橋区高島平７丁目３５−３ メゾン新高島平');
  assert.equal(first.get('destination'), '東京都見本10');
  assert.equal(first.get('waypoints').split('|').length, 9);
  assert.equal(new URL(links[1].url).searchParams.get('origin'), '東京都見本10');
  assert.equal(new URL(route.routeLinks(addresses, { from: '' })[0].url).searchParams.get('origin'), null);
});

test('急な追加の入力を整える', () => {
  assert.ok(route.cleanStop({ name: '', address: 'x' }).error);
  assert.ok(route.cleanStop({ name: 'x', address: ' ' }).error);
  assert.deepEqual(route.cleanStop({ name: ' 見本 ', address: '東京都 見本', note: 'a\r\n\n b ' }).stop, { name: '見本', address: '東京都 見本', note: 'a\nb', run: '' });
});

/* ---------- 通し試験 ---------- */

test('有効なコードだけがログインでき、全角や空白は吸収する', async () => {
  loadAppsScript(USERS);
  const ok = await call(login, { body: { code: '１１ １１' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user, '山田');
  assert.equal(ok.data.admin, false);
  assert.equal((await call(login, { body: { code: '2222' } })).status, 401, '停止中');
  assert.equal((await call(login, { body: { code: '0000' } })).status, 401, '存在しない');
  assert.equal((await call(login, { body: { code: '9999' } })).data.admin, true);
});

test('PDF を読み込んで保存 → 完了 → 追加 → 読み込み直しても完了と追加は残る', async () => {
  const { tab } = loadAppsScript(USERS);
  const yamada = await signIn('1111');
  const date = '2026-11-24';

  const preview = await call(day, { token: yamada, body: { action: 'preview', items: LIST_A } });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.total, 6);
  assert.equal(preview.data.checked, 4);
  assert.equal(preview.data.stops.length, 4);
  assert.equal(tab('配送'), null, 'preview では保存しない');

  const saved = await call(day, { token: yamada, body: { action: 'save', date, course: 'コース表', items: LIST_A } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.course, 'コース表');
  assert.deepEqual(saved.data.stops.map((s) => s.no), [1, 2, 3, 4]);
  assert.equal(saved.data.routes.length, 1);
  assert.ok(saved.data.stops[0].mapUrl.includes('destination='));

  // 2件目を完了に
  const second = saved.data.stops[1];
  const done = await call(day, { token: yamada, body: { action: 'done', date, id: second.id } });
  assert.match(done.data.stops[1].doneAt, /^\d{2}:\d{2}$/);
  assert.equal(done.data.stops[1].doneBy, '山田');
  assert.equal(done.data.restRoutes.length, 1, '途中からは残りの道案内も出る');

  // 1件目の次に急な追加。同じ ID で2回送っても1件
  const add = { action: 'add', date, after: 1, stop: { id: 'add00001', name: '見本 追加店', address: '東京都新宿区見本9-9', note: '急ぎ' } };
  await call(day, { token: yamada, body: add });
  const added = await call(day, { token: yamada, body: add });
  assert.deepEqual(added.data.stops.map((s) => s.name), ['見本商店 一号店', '見本 追加店', '見本食堂', '見本ビル 1F', '見本ビル 2F']);
  assert.equal(added.data.stops[1].added, true);

  // ほかの日は混ざらない
  await call(day, { token: yamada, body: { action: 'save', date: '2026-11-25', items: LIST_B } });
  const wed = await call(day, { token: yamada, method: 'GET', url: '/api/day?date=2026-11-25' });
  assert.equal(wed.data.course, '水曜コース');
  assert.equal(wed.data.stops.length, 4);

  // 同じ日を読み込み直す：完了は残り、追加は最後に残る
  const again = await call(day, { token: yamada, body: { action: 'save', date, course: 'コース表', items: LIST_A } });
  assert.deepEqual(again.data.stops.map((s) => s.name), ['見本商店 一号店', '見本食堂', '見本ビル 1F', '見本ビル 2F', '見本 追加店']);
  assert.ok(again.data.stops[1].doneAt);
  const got = await call(day, { token: yamada, method: 'GET', url: `/api/day?date=${date}` });
  assert.equal(got.data.stops.length, 5);
  assert.equal(tab('配送').rows.length, 1 + 5 + 4, '行が余分に増えない');

  // 完了を戻す
  const undo = await call(day, { token: yamada, body: { action: 'done', date, id: again.data.stops[1].id, done: false } });
  assert.equal(undo.data.stops[1].doneAt, '');
});

test('配送タブの行数が足りなくなっても、行を足して書き込める', async () => {
  const { tab } = loadAppsScript(USERS);
  const yamada = await signIn('1111');
  await call(day, { token: yamada, body: { action: 'save', date: '2026-11-24', items: LIST_A } });
  tab('配送').setMaxRows(3);
  const res = await call(day, { token: yamada, body: { action: 'save', date: '2026-11-25', items: LIST_B } });
  assert.equal(res.status, 200);
  assert.ok(tab('配送').getMaxRows() >= 9);
  assert.equal((await call(day, { token: yamada, method: 'GET', url: '/api/day?date=2026-11-24' })).data.stops.length, 4);
});

test('配送の API は入力を確かめる', async () => {
  loadAppsScript(USERS);
  const yamada = await signIn('1111');
  assert.equal((await call(day, { method: 'GET', url: '/api/day?date=2026-11-24' })).status, 401);
  assert.equal((await call(day, { token: yamada, method: 'GET', url: '/api/day?date=11/24' })).status, 400);
  assert.equal((await call(day, { token: yamada, body: { action: 'preview', items: [] } })).status, 400);
  assert.equal((await call(day, { token: yamada, body: { action: 'save', date: 'x', items: LIST_A } })).status, 400);
  assert.equal((await call(day, { token: yamada, body: { action: 'add', date: '2026-11-24', stop: { name: 'x' } } })).status, 400);
  assert.equal((await call(day, { token: yamada, body: { action: 'done', date: '2026-11-24', id: 'nothere1' } })).status, 404);
  assert.equal((await call(day, { token: yamada, body: { action: 'nope' } })).status, 400);
});

test('日当：出発と終了を押すと件数と時刻が残る。自分の分だけ見え、管理者は全員分', async () => {
  loadAppsScript(USERS);
  const yamada = await signIn('1111');
  const suzuki = await signIn('3333');
  const admin = await signIn('9999');
  const date = '2026-11-24';

  assert.equal((await call(nittou, { token: yamada, body: { kind: 'end', date } })).status, 409, '出発の前に終了は押せない');

  await call(day, { token: yamada, body: { action: 'save', date, items: LIST_A } });
  const start = await call(nittou, { token: yamada, body: { kind: 'start', date, course: 'コース表' } });
  assert.equal(start.status, 200);
  assert.match(start.data.pay.start, /^\d{2}:\d{2}$/);
  assert.equal(start.data.pay.planned, 4);

  const { data } = await call(day, { token: yamada, method: 'GET', url: `/api/day?date=${date}` });
  for (const s of data.stops.slice(0, 3)) await call(day, { token: yamada, body: { action: 'done', date, id: s.id } });
  const end = await call(nittou, { token: yamada, body: { kind: 'end', date } });
  assert.equal(end.data.pay.done, 3);
  assert.equal(end.data.pay.course, 'コース表');
  assert.match(end.data.pay.end, /^\d{2}:\d{2}$/);
  assert.equal(end.data.pay.start, start.data.pay.start, '終了を押しても出発の時刻は変わらない');

  await call(nittou, { token: suzuki, body: { kind: 'start', date: '2026-11-25' } });

  const mine = await call(nittou, { token: yamada, method: 'GET', url: '/api/nittou?month=2026-11' });
  assert.deepEqual(mine.data.pays.map((p) => p.name), ['山田']);
  assert.equal(mine.data.done, 3);
  assert.equal((await call(nittou, { token: yamada, method: 'GET', url: '/api/nittou?month=2026-11&all=1' })).status, 403);
  const all = await call(nittou, { token: admin, method: 'GET', url: '/api/nittou?month=2026-11&all=1' });
  assert.deepEqual(all.data.pays.map((p) => p.name), ['山田', '鈴木']);
  assert.equal((await call(nittou, { token: admin, method: 'GET', url: '/api/nittou?month=2026-10&all=1' })).data.pays.length, 0);
});

test('シート側でも、管理者でなければ全員分の日当は読めない', async () => {
  const { context } = loadAppsScript(USERS);
  const res = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ token: TOKEN, code: '1111', action: 'payList', all: true }) } }));
  assert.deepEqual(res, { ok: false, error: 'admin' });
  const bad = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ token: TOKEN, code: '1111', action: 'dayGet', date: 'x' }) } }));
  assert.equal(bad.error, 'date');
});

test('通行証なし・改ざん・停止後は通らない', async () => {
  const { tab } = loadAppsScript(USERS);
  assert.equal((await call(nittou, { method: 'GET', url: '/api/nittou' })).status, 401);
  const token = await signIn('1111');
  assert.equal((await call(nittou, { token: `${token}x`, method: 'GET', url: '/api/nittou' })).status, 401);
  tab('利用者').rows[1][2] = '停止';
  assert.equal((await call(nittou, { token, method: 'GET', url: '/api/nittou' })).status, 401);
});

test('通行証は期限が切れると使えない', () => {
  const token = issueSession({ name: '山田', code: '1111' }, 0);
  assert.equal(verifySession(token, 1000)?.name, '山田');
  assert.equal(verifySession(token, 91 * 86_400_000), null);
});

test('スクリプトの版と画面側の最新版がそろっている', async () => {
  loadAppsScript(USERS);
  const gs = fs.readFileSync(new URL('../apps-script/endpoint.gs', import.meta.url), 'utf8');
  assert.equal(Number(gs.match(/const SCRIPT_VERSION = (\d+);/)[1]), SCRIPT_VERSION);
  const { data } = await call(health, { method: 'GET' });
  assert.equal(data.scriptVersion, SCRIPT_VERSION);
  assert.equal(data.scriptReady, true);
});
