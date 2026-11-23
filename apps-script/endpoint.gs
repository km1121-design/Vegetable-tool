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
 *   記録   … 記録ID / 日付 / 名前 / 件名 / 金額 / メモ / 登録日時
 *
 * 合言葉はこのスクリプトとホスティングの環境変数にだけ置く。GitHub やチャットには書かない。
 */

const TOKEN = 'ここに合言葉を書く';
const SCRIPT_VERSION = 1;

const USER_TAB = '利用者';
const USER_HEADER = ['名前', '利用コード', '有効', '区分', 'メモ'];
const RECORD_TAB = '記録';
const RECORD_HEADER = ['記録ID', '日付', '名前', '件名', '金額', 'メモ', '登録日時'];

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
    switch (body.action) {
      case 'login': return json_({ ok: true, user: user.name, admin: user.admin });
      case 'recordSave': return json_(recordSave_(user, body.record || {}));
      case 'recordList': return json_(recordList_(user, body.all === true));
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

/* ---------- 記録 ---------- */

function recordSave_(user, record) {
  const sheet = tab_(RECORD_TAB, RECORD_HEADER);
  const id = /^[A-Za-z0-9_-]{6,40}$/.test(String(record.id || '')) ? String(record.id) : newId_();
  const row = [id, String(record.date || ''), user.name, String(record.title || ''), Number(record.amount) || 0, String(record.note || ''), new Date()];
  const last = sheet.getLastRow();
  if (last >= 2) {
    const ids = sheet.getRange(2, 1, last - 1, 3).getValues();
    for (let i = 0; i < ids.length; i += 1) {
      if (String(ids[i][0]) !== id) continue;
      // 他人の記録は上書きさせない（管理者は可）
      if (String(ids[i][2]) !== user.name && !user.admin) return { ok: false, error: 'admin' };
      row[2] = String(ids[i][2]);
      sheet.getRange(i + 2, 1, 1, row.length).setValues([row]);
      return { ok: true, id: id };
    }
  }
  sheet.appendRow(row);
  return { ok: true, id: id };
}

function recordList_(user, all) {
  if (all && !user.admin) return { ok: false, error: 'admin' };
  const sheet = tab_(RECORD_TAB, RECORD_HEADER);
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, records: [] };
  const rows = sheet.getRange(2, 1, last - 1, RECORD_HEADER.length).getValues();
  const records = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r[0] || (!all && String(r[2]) !== user.name)) continue;
    records.push({ id: String(r[0]), date: dateText_(r[1]), name: String(r[2]), title: String(r[3]), amount: Number(r[4]) || 0, note: String(r[5] || '') });
  }
  return { ok: true, records: records };
}

/* ---------- 共通 ---------- */

/** タブを開く。無ければ見出しつきで作る。 */
function tab_(name, header) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** シートが日付に変えてしまった値も YYYY-MM-DD に戻す。 */
function dateText_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value || '');
}

function newId_() {
  return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
