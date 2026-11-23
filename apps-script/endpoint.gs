/**
 * シートを保存先にする受け口（Google Apps Script のウェブアプリ）。
 *
 * 使い方
 *   1. 保存先にするスプレッドシートで「拡張機能 → Apps Script」を開き、この全文を貼る
 *   2. 下の TOKEN を、長くて推測できない合言葉に書き換える（ホスティングの APPS_SCRIPT_TOKEN と同じもの）
 *   3. 「デプロイ → 新しいデプロイ → ウェブアプリ」実行ユーザー: 自分 / アクセスできるユーザー: 全員
 *   4. 出てきた URL をホスティングの APPS_SCRIPT_URL に入れる
 *   書き換えたら「デプロイを管理 → 編集 → バージョン: 新しいバージョン」で出し直す
 *
 * タブ（無ければ自動で作る）
 *   利用者 … 名前 / 利用コード / 有効 / 区分（「管理者」なら管理者）/ メモ
 *   配送   … 配送ID / 日付 / コース / 順番 / 便 / 会社名 / 住所 / 備考 / 追加 / 完了時刻 / 完了者
 *   日当   … 日当ID / 日付 / 名前 / コース / 予定件数 / 完了件数 / 出発 / 終了 / 更新日時
 *
 * 配送タブにはキーボックスの番号なども入る。シートの共有先は必要な人だけにする。
 *
 * 合言葉はこのスクリプトとホスティングの環境変数にだけ置く。GitHub やチャットには書かない。
 */

const TOKEN = 'ここに合言葉を書く';
const SCRIPT_VERSION = 1;

const USER_TAB = '利用者';
const USER_HEADER = ['名前', '利用コード', '有効', '区分', 'メモ'];
const STOP_TAB = '配送';
const STOP_HEADER = ['配送ID', '日付', 'コース', '順番', '便', '会社名', '住所', '備考', '追加', '完了時刻', '完了者'];
const PAY_TAB = '日当';
const PAY_HEADER = ['日当ID', '日付', '名前', 'コース', '予定件数', '完了件数', '出発', '終了', '更新日時'];

/** 「有効」列で停止を意味する値。空欄は有効。 */
const DISABLED_VALUES = ['false', '×', '✕', 'x', '停止', '無効', '0', 'いいえ', 'no', 'off'];

function doGet() {
  return json_({ ok: true, version: SCRIPT_VERSION, ready: TOKEN !== 'ここに合言葉を書く' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'body' });
  }
  if (TOKEN === 'ここに合言葉を書く' || body.token !== TOKEN) return json_({ ok: false, error: 'token' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const user = userOf_(body.code);
    if (!user) return json_({ ok: false, error: 'user' });
    if (/^(day|payPress)/.test(String(body.action)) && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) return json_({ ok: false, error: 'date' });
    switch (body.action) {
      case 'login': return json_({ ok: true, user: user.name, admin: user.admin });
      case 'dayGet': return json_(dayGet_(String(body.date || '')));
      case 'daySave': return json_(daySave_(String(body.date || ''), String(body.course || ''), Array.isArray(body.stops) ? body.stops : []));
      case 'dayAdd': return json_(dayAdd_(String(body.date || ''), String(body.course || ''), body.stop || {}, body.after));
      case 'dayDone': return json_(dayDone_(user, String(body.date || ''), String(body.id || ''), String(body.time || '')));
      case 'payPress': return json_(payPress_(user, String(body.date || ''), String(body.kind || ''), String(body.time || ''), String(body.course || '')));
      case 'payList': return json_(payList_(user, body.all === true, String(body.month || '')));
      default: return json_({ ok: false, error: 'action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 利用者 ---------- */

function normalizeCode_(code) {
  return String(code == null ? '' : code)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); })
    .replace(/[\s　-]/g, '');
}

function userOf_(code) {
  const wanted = normalizeCode_(code);
  if (!wanted) return null;
  const sheet = tab_(USER_TAB, USER_HEADER);
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const rows = sheet.getRange(2, 1, last - 1, USER_HEADER.length).getValues();
  for (let i = 0; i < rows.length; i += 1) {
    const name = String(rows[i][0] || '').trim();
    if (normalizeCode_(rows[i][1]) !== wanted) continue;
    const enabled = rows[i][2] !== false && DISABLED_VALUES.indexOf(String(rows[i][2]).trim().toLowerCase()) < 0;
    if (!name || !enabled) return null;
    return { name: name, admin: String(rows[i][3] || '').trim() === '管理者' };
  }
  return null;
}

/* ---------- 配送（その日の配送先） ---------- */

function dayRows_() {
  const sheet = tab_(STOP_TAB, STOP_HEADER);
  const last = sheet.getLastRow();
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, STOP_HEADER.length).getValues();
  return { sheet: sheet, rows: rows };
}

function stopOf_(r) {
  return {
    id: String(r[0]), date: dateText_(r[1]), course: String(r[2] || ''), order: Number(r[3]) || 0, run: String(r[4] || ''),
    name: String(r[5] || ''), address: String(r[6] || ''), note: String(r[7] || ''), added: String(r[8] || '') === '追加',
    doneAt: timeText_(r[9]), doneBy: String(r[10] || ''),
  };
}

function dayGet_(date) {
  const rows = dayRows_().rows.filter(function (r) { return r[0] && dateText_(r[1]) === date; });
  const stops = rows.map(stopOf_).sort(function (a, b) { return a.order - b.order; });
  return { ok: true, stops: stops };
}

/** その日の行だけを書き換える（ほかの日の行はそのまま）。 */
function writeDay_(sheet, rows, date, dayRows) {
  const others = rows.filter(function (r) { return r[0] && dateText_(r[1]) !== date; });
  const all = others.concat(dayRows);
  ensureRows_(sheet, all.length + 1);
  if (all.length) sheet.getRange(2, 1, all.length, STOP_HEADER.length).setValues(all);
  if (rows.length > all.length) sheet.getRange(2 + all.length, 1, rows.length - all.length, STOP_HEADER.length).clearContent();
}

/**
 * 読み込んだ配送リストでその日を置き換える。
 * すでに「完了」にした配送先は（会社名と住所が同じなら）完了のまま残し、手で足した配送先は最後に残す。
 */
function daySave_(date, course, stops) {
  const data = dayRows_();
  const old = data.rows.filter(function (r) { return r[0] && dateText_(r[1]) === date; }).map(stopOf_);
  const done = {};
  old.forEach(function (s) { if (s.doneAt) done[s.name + '|' + s.address] = s; });
  const keys = {};
  const next = stops.map(function (s) {
    const key = s.name + '|' + s.address;
    keys[key] = true;
    const d = done[key];
    return [newId_(), date, course, 0, s.run || '', s.name, s.address, s.note || '', '', d ? d.doneAt : '', d ? d.doneBy : ''];
  });
  old.forEach(function (s) {
    if (s.added && !keys[s.name + '|' + s.address]) next.push([s.id, date, course, 0, s.run, s.name, s.address, s.note, '追加', s.doneAt, s.doneBy]);
  });
  next.forEach(function (r, i) { r[3] = i + 1; });
  writeDay_(data.sheet, data.rows, date, next);
  return dayGet_(date);
}

/** その日に1件足す。after 番目の次に入れる（0 なら先頭、無ければ最後）。 */
function dayAdd_(date, course, stop, after) {
  const data = dayRows_();
  const day = data.rows.filter(function (r) { return r[0] && dateText_(r[1]) === date; })
    .sort(function (a, b) { return (Number(a[3]) || 0) - (Number(b[3]) || 0); });
  const pos = after === null || after === undefined || after === '' || isNaN(Number(after)) ? day.length : Math.max(0, Math.min(day.length, Number(after)));
  const useCourse = day.length ? String(day[0][2] || course) : course;
  // 同じ ID がもうあれば足さない（送り直しで2件にならないように）
  const id = /^[A-Za-z0-9_-]{6,40}$/.test(String(stop.id || '')) ? String(stop.id) : newId_();
  if (day.some(function (r) { return String(r[0]) === id; })) return dayGet_(date);
  day.splice(pos, 0, [id, date, useCourse, 0, stop.run || '', stop.name, stop.address, stop.note || '', '追加', '', '']);
  day.forEach(function (r, i) { r[1] = date; r[3] = i + 1; });
  writeDay_(data.sheet, data.rows, date, day);
  return dayGet_(date);
}

/** 完了にする・戻す。 */
function dayDone_(user, date, id, time) {
  const data = dayRows_();
  for (let i = 0; i < data.rows.length; i += 1) {
    const r = data.rows[i];
    if (String(r[0]) !== id || dateText_(r[1]) !== date) continue;
    data.sheet.getRange(i + 2, 10, 1, 2).setValues([time ? [time, user.name] : ['', '']]);
    return dayGet_(date);
  }
  return { ok: false, error: 'notfound' };
}

/* ---------- 日当 ---------- */

function payRows_() {
  const sheet = tab_(PAY_TAB, PAY_HEADER);
  const last = sheet.getLastRow();
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, PAY_HEADER.length).getValues();
  return { sheet: sheet, rows: rows };
}

function payOf_(r) {
  return {
    date: dateText_(r[1]), name: String(r[2] || ''), course: String(r[3] || ''),
    planned: Number(r[4]) || 0, done: Number(r[5]) || 0, start: timeText_(r[6]), end: timeText_(r[7]),
  };
}

/** 出発・終了を押したとき。件数はその日の配送タブから数える（自分が完了にした数）。 */
function payPress_(user, date, kind, time, course) {
  const stops = dayGet_(date).stops;
  const planned = stops.length;
  const done = stops.filter(function (s) { return s.doneAt && s.doneBy === user.name; }).length;
  const useCourse = stops.length ? stops[0].course : course;
  const data = payRows_();
  const id = date + '|' + user.name;
  for (let i = 0; i < data.rows.length; i += 1) {
    const r = data.rows[i];
    if (String(r[0]) !== id) continue;
    const row = r.slice();
    row[3] = useCourse; row[4] = planned; row[5] = done; row[8] = new Date();
    if (kind === 'start') row[6] = time;
    if (kind === 'end') row[7] = time;
    if (kind === 'cancelEnd') row[7] = '';
    row[6] = row[6] instanceof Date ? timeText_(row[6]) : row[6];
    row[7] = row[7] instanceof Date ? timeText_(row[7]) : row[7];
    data.sheet.getRange(i + 2, 1, 1, PAY_HEADER.length).setValues([row]);
    return { ok: true, pay: payOf_(row) };
  }
  if (kind !== 'start') return { ok: false, error: 'nostart' };
  const row = [id, date, user.name, useCourse, planned, done, time, '', new Date()];
  data.sheet.appendRow(row);
  return { ok: true, pay: payOf_(row) };
}

function payList_(user, all, month) {
  if (all && !user.admin) return { ok: false, error: 'admin' };
  const list = payRows_().rows.filter(function (r) { return r[0]; }).map(payOf_).filter(function (p) {
    return (all || p.name === user.name) && (!month || p.date.slice(0, 7) === month);
  });
  return { ok: true, pays: list };
}

/* ---------- 共通 ---------- */

/** タブを開く。無ければ見出しつきで作る（日付・時刻・コードが勝手に変換されないよう、書式なしテキストにする）。 */
function tab_(name, header) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, sheet.getMaxRows(), header.length).setNumberFormat('@');
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** シートの行数が足りなければ足す（足した行は上の行の書式を引き継ぐ）。 */
function ensureRows_(sheet, rows) {
  const max = sheet.getMaxRows();
  if (max < rows) sheet.insertRowsAfter(max, rows - max + 200);
}

/** シートが日付に変えてしまった値も YYYY-MM-DD に戻す。 */
function dateText_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value || '');
}

/** シートが時刻に変えてしまった値も HH:mm に戻す。 */
function timeText_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  return String(value || '');
}

function newId_() {
  return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
