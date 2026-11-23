/**
 * ログイン → 保存 → 一覧 の通し試験と、決まった計算の試験。
 * 新しい機能を足したら、ここに同じ形で試験を足す（Google には接続しない）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOKEN, loadAppsScript, call } from './sheet-harness.js';

process.env.APPS_SCRIPT_URL = 'https://script.example/exec';
process.env.APPS_SCRIPT_TOKEN = TOKEN;
process.env.LOGIN_FAILURE_DELAY_MS = '0';

const { default: login } = await import('../api/login.js');
const { default: records } = await import('../api/records.js');
const { default: health } = await import('../api/health.js');
const { cleanRecord, toAmount, summarize } = await import('../src/domain/records.js');
const { issueSession, verifySession } = await import('../src/auth/session.js');
const { SCRIPT_VERSION } = await import('../src/scriptVersion.js');

const USERS = [['山田', '1111', true, ''], ['佐藤', '2222', '停止', ''], ['事務', '9999', '', '管理者']];

async function signIn(code) {
  const { status, data } = await call(login, { body: { code } });
  assert.equal(status, 200);
  return data.token;
}

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

test('記録は自分の分だけ見え、管理者は全員分を見られる', async () => {
  const { tab } = loadAppsScript(USERS);
  const yamada = await signIn('1111');
  const admin = await signIn('9999');

  const saved = await call(records, { token: yamada, body: { record: { date: '2026-10-01', title: '作業A', amount: '1,200円' } } });
  assert.equal(saved.status, 200);
  await call(records, { token: admin, body: { record: { date: '2026-10-02', title: '作業B', amount: 800 } } });

  const mine = await call(records, { token: yamada, method: 'GET', url: '/api/records' });
  assert.deepEqual(mine.data.records.map((r) => r.title), ['作業A']);
  assert.equal(mine.data.summary.total, 1200);

  assert.equal((await call(records, { token: yamada, method: 'GET', url: '/api/records?all=1' })).status, 403);
  const all = await call(records, { token: admin, method: 'GET', url: '/api/records?all=1' });
  assert.equal(all.data.summary.total, 2000);
  assert.deepEqual(all.data.summary.byUser, { 山田: 1200, 事務: 800 });

  // 同じ ID で送り直すと上書き（行は増えない）
  await call(records, { token: yamada, body: { record: { id: saved.data.id, date: '2026-10-01', title: '作業A', amount: 1500 } } });
  assert.equal(tab('記録').rows.length, 3);
  assert.equal((await call(records, { token: yamada, method: 'GET', url: '/api/records' })).data.summary.total, 1500);
});

test('他人の記録 ID では上書きできない', async () => {
  loadAppsScript([...USERS, ['鈴木', '3333', true, '']]);
  const yamada = await signIn('1111');
  const suzuki = await signIn('3333');
  const { data } = await call(records, { token: yamada, body: { record: { date: '2026-10-01', title: '山田の', amount: 1 } } });
  const res = await call(records, { token: suzuki, body: { record: { id: data.id, date: '2026-10-01', title: '乗っ取り', amount: 9 } } });
  assert.equal(res.status, 403);
});

test('通行証なし・改ざん・停止後は通らない', async () => {
  const { tab } = loadAppsScript(USERS);
  assert.equal((await call(records, { method: 'GET', url: '/api/records' })).status, 401);
  const token = await signIn('1111');
  assert.equal((await call(records, { token: `${token}x`, method: 'GET', url: '/api/records' })).status, 401);
  tab('利用者').rows[1][2] = '停止';
  assert.equal((await call(records, { token, method: 'GET', url: '/api/records' })).status, 401);
});

test('通行証は期限が切れると使えない', () => {
  const token = issueSession({ name: '山田', code: '1111' }, 0);
  assert.equal(verifySession(token, 1000)?.name, '山田');
  assert.equal(verifySession(token, 91 * 86_400_000), null);
});

test('記録の形を整える（決まった計算）', () => {
  assert.equal(toAmount('１,２００円'), 1200);
  assert.equal(toAmount('abc'), null);
  assert.ok(cleanRecord({ date: '10/1', title: 'x' }).error);
  assert.ok(cleanRecord({ date: '2026-10-01', title: '' }).error);
  assert.equal(cleanRecord({ date: '2026-10-01', title: 'x', amount: '5', id: 'bad id!' }).record.id, '');
  assert.deepEqual(summarize([{ date: '2026-10-01', amount: 1 }, { date: '2026-11-01', amount: 2 }]).byMonth, { '2026-10': 1, '2026-11': 2 });
});

test('スクリプトの版と画面側の最新版がそろっている', async () => {
  loadAppsScript(USERS);
  const gs = fs.readFileSync(new URL('../apps-script/endpoint.gs', import.meta.url), 'utf8');
  assert.equal(Number(gs.match(/const SCRIPT_VERSION = (\d+);/)[1]), SCRIPT_VERSION);
  const { data } = await call(health, { method: 'GET' });
  assert.equal(data.scriptVersion, SCRIPT_VERSION);
  assert.equal(data.scriptReady, true);
});
