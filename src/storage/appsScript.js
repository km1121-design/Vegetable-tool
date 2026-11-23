/**
 * シートに置いた Apps Script（apps-script/endpoint.gs）を呼ぶ。
 *
 * 合言葉（APPS_SCRIPT_TOKEN）はサーバー側にのみ置き、ブラウザへは渡さない。
 * 失敗は {status, code, message, detail?} で throw する。
 */

export function appsScriptConfig() {
  const url = process.env.APPS_SCRIPT_URL?.trim();
  const token = process.env.APPS_SCRIPT_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

/** 応答を待つ上限（ミリ秒）。 */
const TIMEOUT_MS = 45000;

/** Google から HTML のエラー画面が返ったとき、もう一度呼ぶまでの待ち時間（ミリ秒）。 */
const RETRY_MS = 1500;

export async function callAppsScript(body) {
  try {
    return await callOnce(body);
  } catch (error) {
    // Google 側の一時的なエラー画面（JSON でない応答）は1回だけ呼び直す。
    // 書き込みは ID ごとの上書きにしておくこと（2回届いても行が増えないように）
    if (error?.code !== 'script_unavailable') throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    return callOnce(body);
  }
}

async function callOnce(body) {
  const config = appsScriptConfig();
  if (!config) throw { status: 501, code: 'not_configured', message: '保存先が設定されていません。' };

  let upstream;
  try {
    upstream = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow', // Apps Script のウェブアプリはリダイレクトを挟む
      body: JSON.stringify({ ...body, token: config.token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw {
      status: 502,
      code: 'network',
      message: 'シートの受け口に接続できませんでした。',
      detail: timedOut ? `シートのスクリプトが ${TIMEOUT_MS / 1000} 秒以内に応答しませんでした` : String(error?.message ?? error).slice(0, 120),
    };
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // ログイン画面やエラー画面の HTML（一時的なエラー・公開設定が「全員」でない など）
    const title = (text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);
    throw {
      status: 502,
      code: 'script_unavailable',
      message: 'シートのスクリプトから正しい応答が返りませんでした。',
      detail: `HTTP ${upstream.status} ${title}`.replace(/[A-Za-z0-9_-]{24,}/g, '***'),
    };
  }

  if (!data?.ok) {
    if (data?.error === 'token') throw { status: 500, code: 'not_configured', message: '合言葉が一致しません。APPS_SCRIPT_TOKEN を確認してください。' };
    if (data?.error === 'user') throw { status: 401, code: 'unauthorized', message: 'このコードは使えません。' };
    if (data?.error === 'notfound') throw { status: 404, code: 'not_found', message: 'その配送先が見つかりません。画面を読み込み直してください。' };
    if (data?.error === 'nostart') throw { status: 409, code: 'no_start', message: '先に「出発」を押してください。' };
    if (data?.error === 'date') throw { status: 400, code: 'invalid', message: '日付が正しくありません。' };
    if (data?.error === 'admin') throw { status: 403, code: 'forbidden', message: '管理者だけが使えます。' };
    // シート側で起きたエラーの文（長い英数字は伏せる）
    const detail = String(data?.error ?? '').replace(/[A-Za-z0-9_-]{24,}/g, '***').slice(0, 200);
    throw { status: 502, code: 'server', message: 'シートでの処理に失敗しました。', detail };
  }
  return data;
}
