/**
 * 縁 野菜配送の決まった計算（AI は使わない）。
 *   - 曜日ごとのコース
 *   - 配送リスト PDF の文字の位置から、配送先の行を組み立てる
 *   - ✔ があれば ✔ の行だけ、無ければ全部を配る
 *   - Google マップの道案内リンク
 * 画面とサーバーの両方から使えるよう、Node 専用の機能は使わない。
 */

/** 出発地点（毎回同じ）。 */
export const DEPARTURE = '〒175-0082 東京都板橋区高島平７丁目３５−３ メゾン新高島平';

/** コースと使う曜日（0=日 … 6=土）。 */
export const COURSES = [
  { name: 'コース表', days: [1, 2, 4, 5, 6] },
  { name: '水曜コース', days: [3] },
  { name: '日曜コース', days: [0] },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (value) => DATE_RE.test(String(value ?? '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** その日に使うコース名。 */
export function courseForDate(date) {
  if (!isDate(date)) return COURSES[0].name;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (COURSES.find((c) => c.days.includes(day)) ?? COURSES[0]).name;
}

export const isCourse = (name) => COURSES.some((c) => c.name === name);

/** 日本時間の今の日付と時刻。 */
export function jstNow(now = Date.now()) {
  const iso = new Date(now + 9 * 3600e3).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/* ---------- 配送リスト PDF の読み取り ---------- */

const CHECK_RE = /[✔✓☑✅]/;
const clean = (text) => String(text ?? '').replace(/[️​]/g, '').replace(/\s+/g, ' ').trim();

/** 同じ高さ（±tol）の文字をまとめて、左から並べた行にする。 */
function groupLines(items, tol = 2.5) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(item.y - line.y) <= tol) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** 左から並んだ文字のかけらを1つの文にする（離れていれば空白を入れる）。 */
function joinLine(items) {
  let text = '';
  let end = null;
  for (const item of items) {
    const gap = end === null ? 0 : item.x - end;
    if (text && gap > 0.8 && !text.endsWith(' ')) text += ' ';
    text += item.s;
    end = item.x + (Number(item.w) || 0);
  }
  return clean(text);
}

const joinLines = (items, sep) => groupLines(items).map((line) => joinLine(line.items)).filter(Boolean).join(sep);

/**
 * pdf.js で取り出した文字（{p: ページ, x, y: 上からの位置, w: 幅, s: 文字}）から配送先を組み立てる。
 * 見出しの「会社名・住所・備考」の位置を列の中心とし、会社名の列に文字がある高さを1件とする。
 * 返り値 {stops: [{order, run, name, address, note, checked}], checked: ✔の数, error?}
 */
export function parseListItems(rawItems) {
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map((i) => ({ p: Number(i?.p) || 1, x: Number(i?.x), y: Number(i?.y), w: Number(i?.w) || 0, s: clean(i?.s) }))
    .filter((i) => i.s && Number.isFinite(i.x) && Number.isFinite(i.y));

  const stops = [];
  let run = '';
  let found = false;
  const pages = [...new Set(items.map((i) => i.p))].sort((a, b) => a - b);

  for (const page of pages) {
    const onPage = items.filter((i) => i.p === page);
    const lines = groupLines(onPage);
    const headerLine = lines.find((line) => {
      const text = line.items.map((i) => i.s).join('');
      return text.includes('会社名') && text.includes('住所');
    });
    if (!headerLine) continue;
    found = true;

    const center = (i) => i.x + i.w / 2;
    const head = (word) => headerLine.items.find((i) => i.s.includes(word));
    const nameX = center(head('会社名'));
    const addrX = center(head('住所'));
    const noteX = head('備考') ? center(head('備考')) : addrX + (addrX - nameX);
    const nameLeft = nameX - (addrX - nameX) / 2;
    const nameAddr = (nameX + addrX) / 2;
    const addrNote = (addrX + noteX) / 2;
    const noteRight = noteX + (noteX - addrX);

    const body = onPage.filter((i) => i.y > headerLine.y + 2);

    // 「1便→…」「2便→…」の行は区切り。配送先には入れない
    const sectionYs = [];
    const sections = [];
    for (const line of groupLines(body)) {
      const text = joinLine(line.items);
      const m = text.match(/^(\d+)\s*便\s*[→:：]/);
      if (m) { sectionYs.push(line.y); sections.push({ y: line.y, run: `${m[1]}便` }); }
    }
    const rest = body.filter((i) => !sectionYs.some((y) => Math.abs(i.y - y) <= 2.5));

    const cols = { check: [], name: [], addr: [], note: [] };
    for (const item of rest) {
      const c = center(item);
      if (c < nameLeft) { if (CHECK_RE.test(item.s)) cols.check.push(item); }
      else if (c < nameAddr) cols.name.push(item);
      else if (c < addrNote) cols.addr.push(item);
      else if (c <= noteRight) cols.note.push(item);
    }

    // 会社名のある高さ＝1件。ほかの文字は高さがいちばん近い件に付ける（区切りはまたがない）
    const rows = groupLines(cols.name).map((line) => ({ y: line.y, name: joinLine(line.items), addr: [], note: [], checked: false }));
    if (!rows.length) continue;
    const boundaryBetween = (a, b) => sectionYs.some((y) => (y > Math.min(a, b) && y < Math.max(a, b)));
    const nearest = (y) => {
      let best = null;
      for (const row of rows) {
        if (boundaryBetween(row.y, y)) continue;
        if (!best || Math.abs(row.y - y) < Math.abs(best.y - y)) best = row;
      }
      return best;
    };
    for (const item of cols.addr) nearest(item.y)?.addr.push(item);
    for (const item of cols.note) nearest(item.y)?.note.push(item);
    for (const item of cols.check) { const row = nearest(item.y); if (row && Math.abs(row.y - item.y) <= 6) row.checked = true; }

    // 結合されたセル（2件で1つの住所欄など）：住所が空の件は、住所欄が自分の側へはみ出している隣の件と同じにする
    const midY = (list) => (list.length ? list.reduce((sum, i) => sum + i.y, 0) / list.length : null);
    rows.forEach((row) => { row.addrY = midY(row.addr); });
    rows.forEach((row, i) => {
      if (row.addr.length) return;
      const prev = rows[i - 1];
      const next = rows[i + 1];
      const fromPrev = prev?.addr.length && prev.addrY > prev.y && !boundaryBetween(prev.y, row.y) ? prev : null;
      const fromNext = next?.addr.length && next.addrY < next.y && !boundaryBetween(next.y, row.y) ? next : null;
      const source = fromPrev && fromNext
        ? (Math.abs(fromPrev.addrY - row.y) <= Math.abs(fromNext.addrY - row.y) ? fromPrev : fromNext)
        : (fromPrev ?? fromNext);
      if (!source) return;
      row.shared = source;
    });

    for (const row of rows) {
      const section = sections.filter((s) => s.y < row.y).at(-1);
      if (section) run = section.run;
      const src = row.shared ?? row;
      const note = row.note.length ? row.note : (row.shared ? row.shared.note : []);
      stops.push({ run, name: row.name, address: joinLines(src.addr, ' '), note: joinLines(note, '\n'), checked: row.checked });
    }
  }

  if (!found) return { stops: [], checked: 0, error: '配送リストの見出し（会社名・住所・備考）が見つかりませんでした。PDF を確かめてください。' };
  if (!stops.length) return { stops: [], checked: 0, error: '配送先を読み取れませんでした。PDF を確かめてください。' };

  stops.forEach((stop, i) => { stop.order = i + 1; });
  return { stops, checked: stops.filter((s) => s.checked).length };
}

/** ✔ が1つでもあれば ✔ の行だけ、無ければ全部。順番はリストのまま。 */
export function pickStops(stops) {
  const list = Array.isArray(stops) ? stops : [];
  const anyChecked = list.some((s) => s.checked);
  return (anyChecked ? list.filter((s) => s.checked) : list).map((s, i) => ({ ...s, order: i + 1 }));
}

/** 画面から来た配送先（追加分・保存分）を整える。 */
export function cleanStop(input) {
  const name = clean(input?.name).slice(0, 100);
  if (!name) return { error: '会社名を入れてください。' };
  const address = clean(input?.address).slice(0, 200);
  if (!address) return { error: '住所を入れてください。' };
  return {
    stop: {
      name,
      address,
      note: String(input?.note ?? '').replace(/\r/g, '').split('\n').map(clean).filter(Boolean).join('\n').slice(0, 500),
      run: clean(input?.run).slice(0, 10),
    },
  };
}

/* ---------- Google マップ ---------- */

/** 地図で探しやすいよう、〒番号を外す。 */
export const mapAddress = (address) => clean(address).replace(/^〒?\s*\d{3}-?\d{4}\s*/, '');

/** 今いる場所からその配送先までの道案内。 */
export function directionsLink(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapAddress(address))}&travelmode=driving`;
}

/**
 * 出発地点から順にまわる道案内。Google マップは経由地の数に限りがあるので、
 * 10 件ずつに分ける（前の区間の最後の配送先から次の区間を始める）。from を '' にすると今いる場所から。
 */
export function routeLinks(addresses, { from = DEPARTURE, size = 10 } = {}) {
  const list = (addresses ?? []).map(mapAddress).filter(Boolean);
  const links = [];
  let origin = mapAddress(from);
  for (let i = 0; i < list.length; i += size) {
    const part = list.slice(i, i + size);
    const destination = part.at(-1);
    const waypoints = part.slice(0, -1);
    // origin が空なら Google マップは今いる場所から案内する
    const params = new URLSearchParams({ api: '1', ...(origin ? { origin } : {}), destination, travelmode: 'driving' });
    if (waypoints.length) params.set('waypoints', waypoints.join('|'));
    links.push({ from: i + 1, to: i + part.length, url: `https://www.google.com/maps/dir/?${params}` });
    origin = destination;
  }
  return links;
}
