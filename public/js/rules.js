/*!
 * 海戰棋 — 共用規則（純函式）
 * 前端與 Cloudflare Worker 共用同一份規則，確保「自動標註位置」與「結算」判定一致。
 * 禁止依賴 DOM / Worker API，兩邊都能安全 import。
 */

export const N = 5;
export const COLS = ["A", "B", "C", "D", "E"];
export const ROWS = [1, 2, 3, 4, 5];

/** 船艦定義：3 格 ×1、2 格 ×2、1 格 ×1，共 8 格 */
export const SHIP_LEN = { "3": 3, "2a": 2, "2b": 2, "1": 1 };
export const SHIP_IDS = Object.keys(SHIP_LEN);
export const TOTAL_SHIP_CELLS = Object.values(SHIP_LEN).reduce((a, b) => a + b, 0);

/** 標記值：0 空白 / 1 落空 / 2 命中 / 3 擊沉 */
export const MARK = { NONE: 0, MISS: 1, HIT: 2, SUNK: 3 };

export const cellKey = (r, c) => `${r},${c}`;
export const parseCell = (k) => String(k).split(",").map(Number);
export const inBounds = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
export const cellLabel = (k) => {
  const [r, c] = parseCell(k);
  return `${COLS[c] ?? "?"}${r + 1}`;
};

/** 以 0 為基準的行列 → 文字座標 */
export const posLabel = (r, c) => `${COLS[c] ?? "?"}${r + 1}`;

/** 船艦佔用的格子：pos = { r, c, d }，d 為 "H" 水平 / "V" 直向 */
export function cellsOf(pos, len) {
  const out = [];
  if (!pos) return out;
  for (let i = 0; i < len; i++) {
    out.push([pos.r + (pos.d === "V" ? i : 0), pos.c + (pos.d === "H" ? i : 0)]);
  }
  return out;
}

/** 八方向鄰接（含斜角） */
export const NEIGHBORS8 = [-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b) => [a, b])).filter(([a, b]) => a || b);

/** 四方向鄰接 */
export const NEIGHBORS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** fleet: { shipId: { r, c, d } } → { "r,c": { id, i } } */
export function fleetCellMap(fleet) {
  const m = {};
  for (const id in fleet) {
    cellsOf(fleet[id], SHIP_LEN[id] ?? 0).forEach(([r, c], i) => {
      m[cellKey(r, c)] = { id, i };
    });
  }
  return m;
}

/** 取得某格上的船艦 id（無則 undefined） */
export function shipAtCell(fleet, r, c) {
  const m = fleetCellMap(fleet);
  return m[cellKey(r, c)]?.id;
}

/**
 * 驗證船隊是否合法：四艘齊全、不出界、不可重疊、不可相鄰（含斜角）。
 * 回傳 { ok, reason }
 */
export function validateFleet(fleet) {
  if (!fleet || typeof fleet !== "object") return { ok: false, reason: "缺少船隊資料" };
  for (const id of SHIP_IDS) {
    const p = fleet[id];
    if (!p) return { ok: false, reason: "船艦尚未全部擺放" };
    if (typeof p.r !== "number" || typeof p.c !== "number") return { ok: false, reason: "船艦位置格式錯誤" };
    if (p.d !== "H" && p.d !== "V") return { ok: false, reason: "船艦方向錯誤" };
    const cs = cellsOf(p, SHIP_LEN[id]);
    if (!cs.every(([r, c]) => inBounds(r, c))) return { ok: false, reason: "船艦超出海域範圍" };
  }
  for (const id of SHIP_IDS) {
    for (const other of SHIP_IDS) {
      if (other === id) continue;
      for (const [ar, ac] of cellsOf(fleet[id], SHIP_LEN[id])) {
        for (const [br, bc] of cellsOf(fleet[other], SHIP_LEN[other])) {
          if (Math.max(Math.abs(ar - br), Math.abs(ac - bc)) <= 1) {
            return { ok: false, reason: "船艦不可重疊或相鄰（含斜角）" };
          }
        }
      }
    }
  }
  return { ok: true, reason: "" };
}

/** 某艘船是否已被完全命中（fired: { cell: 1|2|3 }） */
export function isShipSunk(fleet, shipId, fired) {
  const p = fleet?.[shipId];
  if (!p) return false;
  return cellsOf(p, SHIP_LEN[shipId]).every(([r, c]) => (fired[cellKey(r, c)] || 0) >= MARK.HIT);
}

/** 對手所有船艦是否皆已擊沉 → 回傳 { all, sunkIds } */
export function allShipsSunk(fleet, fired) {
  const sunkIds = [];
  let all = true;
  for (const id of SHIP_IDS) {
    if (!fleet?.[id]) continue;
    if (isShipSunk(fleet, id, fired)) sunkIds.push(id);
    else all = false;
  }
  return { all, sunkIds };
}

/**
 * 擊沉自動標註：被擊沉的船，周圍一圈自動標為「落空」（可手動修改）。
 * 回傳 Set of cellKey
 */
export function autoMissCells(fleet, fired) {
  const out = new Set();
  for (const id of SHIP_IDS) {
    const p = fleet?.[id];
    if (!p) continue;
    if (!isShipSunk(fleet, id, fired)) continue;
    for (const [r, c] of cellsOf(p, SHIP_LEN[id])) {
      for (const [a, b] of NEIGHBORS8) {
        const nr = r + a, nc = c + b;
        if (inBounds(nr, nc)) out.add(cellKey(nr, nc));
      }
    }
  }
  return out;
}

/**
 * 產生某一方的「敵方海域」完整標記圖。
 * 優先序：實際開火結果 > 擊沉自動標註 > 手動標註
 * 回傳 { cell: 0|1|2|3 }
 */
export function buildEnemyBoard({ fired = {}, enemyFleet = {}, marks = {} } = {}) {
  const board = {};
  for (const k in fired) board[k] = fired[k];
  const auto = autoMissCells(enemyFleet, fired);
  for (const k of auto) if (board[k] === undefined) board[k] = MARK.MISS;
  for (const k in marks) if (board[k] === undefined) board[k] = marks[k];
  return board;
}

/** 統計：出擊 / 命中 / 命中率 */
export function summarize(board = {}) {
  const vals = Object.values(board);
  const shots = vals.filter((v) => v >= MARK.MISS).length;
  const hits = vals.filter((v) => v >= MARK.HIT).length;
  const sunk = vals.filter((v) => v === MARK.SUNK).length;
  const rate = shots ? Math.round((hits / shots) * 100) : null;
  return { shots, hits, sunk, rate };
}
