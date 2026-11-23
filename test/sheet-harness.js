/**
 * 本物の apps-script/endpoint.gs を、模擬のスプレッドシートの上で動かす。
 * fetch を差し替えて、API（api/*.js）→ Apps Script の通しを Google なしで試せる。
 */

import fs from 'node:fs';
import vm from 'node:vm';

export const TOKEN = 'test-shared-secret-123';

export function makeSheet(name, initial = []) {
  const rows = initial.map((row) => [...row]);
  const cellAt = (r, c) => rows[r - 1]?.[c - 1] ?? '';
  const put = (r, c, value) => {
    while (rows.length < r) rows.push([]);
    rows[r - 1][c - 1] = value;
  };
  return {
    rows,
    getName: () => name,
    getLastRow: () => rows.length,
    appendRow: (row) => rows.push([...row]),
    setFrozenRows() {},
    getRange: (r, c = 1, numRows = 1, numCols = 1) => ({
      getValues: () => Array.from({ length: numRows }, (u, i) => Array.from({ length: numCols }, (v, j) => cellAt(r + i, c + j))),
      setValues: (values) => values.forEach((row, i) => row.forEach((value, j) => put(r + i, c + j, value))),
    }),
  };
}

/** users: [[名前, 利用コード, 有効, 区分], ...] */
export function loadAppsScript(users, { url = process.env.APPS_SCRIPT_URL } = {}) {
  const sheets = [makeSheet('利用者', [['名前', '利用コード', '有効', '区分', 'メモ'], ...users])];
  const book = {
    getSheetByName: (n) => sheets.find((sheet) => sheet.getName() === n) ?? null,
    insertSheet: (n) => { const sheet = makeSheet(n); sheets.push(sheet); return sheet; },
  };
  const context = {
    console,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: { getActiveSpreadsheet: () => book },
    Utilities: { formatDate: (date) => new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 10) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ setMimeType: () => text }) },
  };
  const source = fs.readFileSync(new URL('../apps-script/endpoint.gs', import.meta.url), 'utf8')
    .replace("const TOKEN = 'ここに合言葉を書く';", `const TOKEN = '${TOKEN}';`);
  vm.createContext(context);
  vm.runInContext(source, context);

  globalThis.fetch = async (target, options = {}) => {
    if (target !== url) throw new Error(`unexpected fetch: ${target}`);
    const text = options.method === 'POST' ? context.doPost({ postData: { contents: options.body } }) : context.doGet();
    return { status: 200, text: async () => text };
  };
  return { sheets, context, tab: (n) => book.getSheetByName(n) };
}

/** api/*.js を (request, response) の形で呼ぶ。 */
export async function call(handler, { body, token, url = '/', method = 'POST' } = {}) {
  const request = {
    method,
    url,
    body,
    query: Object.fromEntries(new URL(url, 'http://local').searchParams),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  let status = 200;
  let payload;
  const response = {
    setHeader() {},
    status(code) { status = code; return response; },
    json(data) { payload = data; return response; },
  };
  await handler(request, response);
  return { status, data: payload };
}
