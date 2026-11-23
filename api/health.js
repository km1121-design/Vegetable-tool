/**
 * 設置の状態を画面へ伝える（鍵や合言葉そのものは返さない）。
 *   storage: シートの受け口が設定されているか
 *   scriptVersion: シートに貼ったスクリプトの版（latestScriptVersion より古ければ貼り直しを促す）
 */

import { appsScriptConfig } from '../src/storage/appsScript.js';
import { SCRIPT_VERSION } from '../src/scriptVersion.js';

async function readScriptInfo() {
  const config = appsScriptConfig();
  if (!config) return null;
  try {
    const upstream = await fetch(config.url, { redirect: 'follow' });
    const data = JSON.parse(await upstream.text());
    return { version: Number(data?.version) || 1, ready: data?.ready !== false };
  } catch {
    return null;
  }
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const script = await readScriptInfo();
  response.status(200).json({
    ok: true,
    storage: Boolean(appsScriptConfig()),
    scriptVersion: script?.version ?? null,
    scriptReady: script?.ready ?? null,
    latestScriptVersion: SCRIPT_VERSION,
  });
}
