/**
 * Cloudflare Pages の関数の入口。
 *
 * 処理本体は api/*.js（Vercel と同じ (request, response) の書き方）にあり、ここは
 * Cloudflare の Request を {method, url, query, headers, body} に詰め替えて呼ぶだけ。
 * 処理を二重に持たないため。新しい API は api/ に置いて ROUTES に足す。
 */

import health from '../../api/health.js';
import login from '../../api/login.js';
import records from '../../api/records.js';

const ROUTES = { health, login, records };

const json = (status, data, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});

export async function onRequest({ request, env, params }) {
  // ダッシュボードで設定した環境変数を process.env へ映す（処理本体は process.env を読む）
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') process.env[key] = value;
  }

  const name = Array.isArray(params?.route) ? params.route[0] : params?.route;
  const handler = ROUTES[name];
  if (!handler) return json(404, { code: 'not_found', error: '見つかりません。' });

  const url = new URL(request.url);
  let body = {};
  if (request.method === 'POST') {
    const text = await request.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(400, { code: 'server', error: '送られた内容を解釈できませんでした。' });
    }
  }

  const headers = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

  let status = 200;
  let payload = null;
  const extraHeaders = {};
  const shimResponse = {
    setHeader(key, value) { extraHeaders[key] = String(value); return shimResponse; },
    status(code) { status = code; return shimResponse; },
    json(data) { payload = data; return shimResponse; },
  };

  try {
    await handler({ method: request.method, url: url.pathname + url.search, query: Object.fromEntries(url.searchParams), headers, body }, shimResponse);
  } catch (error) {
    console.error(`[${name}]`, error);
    return json(500, { code: 'server', error: '処理に失敗しました。' });
  }
  return json(status, payload ?? {}, extraHeaders);
}
