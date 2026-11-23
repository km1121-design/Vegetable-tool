/**
 * 記録の形を整える・集計する。お金や件数の計算は AI に任せず、必ずここ（決まった計算）で行う。
 * 画面とサーバーの両方から使えるよう、Node 専用の機能は使わない。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 画面から来た記録を、保存してよい形に直す。直せないときは {error}。 */
export function cleanRecord(input) {
  const date = String(input?.date ?? '').trim();
  if (!DATE_RE.test(date)) return { error: '日付は YYYY-MM-DD で入れてください。' };

  const title = String(input?.title ?? '').trim().slice(0, 100);
  if (!title) return { error: '件名を入れてください。' };

  const amount = toAmount(input?.amount);
  if (amount === null) return { error: '金額は数字で入れてください。' };

  const id = String(input?.id ?? '').trim();
  return {
    record: {
      // 同じ ID は上書きする（2回届いても行が増えない）
      id: /^[A-Za-z0-9_-]{6,40}$/.test(id) ? id : '',
      date,
      title,
      amount,
      note: String(input?.note ?? '').trim().slice(0, 500),
    },
  };
}

/** 「1,200円」「１２００」なども数として読む。読めなければ null。 */
export function toAmount(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const text = String(value)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[,，円\s]/g, '');
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

/** 月ごと・人ごとの合計。 */
export function summarize(records) {
  const byMonth = {};
  const byUser = {};
  let total = 0;
  for (const r of records ?? []) {
    const amount = Number(r?.amount) || 0;
    const month = String(r?.date ?? '').slice(0, 7);
    total += amount;
    byMonth[month] = (byMonth[month] ?? 0) + amount;
    if (r?.name) byUser[r.name] = (byUser[r.name] ?? 0) + amount;
  }
  return { count: (records ?? []).length, total, byMonth, byUser };
}
