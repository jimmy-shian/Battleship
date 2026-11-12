/*!
 * 海戰棋 — 共用規則（純函式）
 * 前端與 Cloudflare Worker 共用同一份規則，確保「自動標註位置」與「結算」判定一致。
 * 禁止依賴 DOM / Worker API，兩邊都能安全 import。
 */

/* ---------- 海域模式 ---------- */

/** 欄位名稱 A–J（依海域大小取前 n 個） */
export const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

/**
 * 海域模式定義：
 *   s5  簡易 5×5（4 艘：3 格 ×1、2 格 ×2、1 格 ×1，共 8 格）
 *       自家簡易版規則：船不可相鄰（含斜角）→ 擊沉後周圍一圈可自動標落空。
 *   c10 正版 10×10（5 艘：5、4、3、3、2 格，共 17 格）— 照 Hasbro 官方規則：
 *       允許船艦緊鄰（可併排、可斜角相接）→ 周圍可能有其他船，
 *       因此擊沉後「不自動標註周圍」（標了會是錯的）。
 */
export const BOARDS = {
  s5: {
    id: "s5",
    label: "簡易 5×5",
    n: 5,
    adjacent: false, // false = 不可相鄰（含斜角）
    ships: { "3": 3, "2a": 2, "2b": 2, "1": 1 },
    names: null
  },
  c10: {
    id: "c10",
    label: "正版 10×10",
    n: 10,
    adjacent: true,  // true = 允許緊鄰（官方規則）
    ships: { "5": 5, "4": 4, "3a": 3, "3b": 3, "2": 2 },
    names: { "5": "航空母艦", "4": "戰艦", "3a": "巡洋艦", "3b": "潛水艦", "2": "驅逐艦" }
  }
};

export const BOARD_ORDER = ["s5", "c10"];
export const DEFAULT_BOARD = "s5";

/** 取得海域設定（未知 id 一律回簡易 5×5） */
export function boardConfig(id) {
  return BOARDS[id] || BOARDS[DEFAULT_BOARD];
}

/** 該海域的船艦 id 清單 */
export const shipIdsOf = (cfg) => Object.keys(cfg.ships);

/** 該海域的船艦總格數 */
export const totalShipCells = (cfg) => Object.values(cfg.ships).reduce((a, b) => a + b, 0);

/** 該海域的欄位名稱（A、B、C…） */
export const colsOf = (cfg) => COLS.slice(0, cfg.n);

/** 該海域的列號（1、2、3…） */
export const rowsOf = (cfg) => Array.from({ length: cfg.n }, (_, i) => i + 1);

/** 船艦顯示名稱：有定義用名稱（正版），否則用長度（簡易版「3 格」） */
export const shipNameOf = (cfg, id) =>
  (cfg.names && cfg.names[id]) || `${cfg.ships[id]} 格`;

/* ---------- 簡易 5×5 的相容匯出（舊程式碼 / 單機版語意） ---------- */
export const N = BOARDS.s5.n;
export const ROWS = rowsOf(BOARDS.s5);
export const SHIP_LEN = BOARDS.s5.ships;
export const SHIP_IDS = Object.keys(SHIP_LEN);
export const TOTAL_SHIP_CELLS = totalShipCells(BOARDS.s5);

/* ---------- 標記 ---------- */

/** 標記值：0 空白 / 1 落空 / 2 命中 / 3 擊沉 */
export const MARK = { NONE: 0, MISS: 1, HIT: 2, SUNK: 3 };

export const cellKey = (r, c) => `${r},${c}`;
export const parseCell = (k) => String(k).split(",").map(Number);

/** 座標是否在海海域內（n = 邊長，預設簡易 5×5） */
export const inBounds = (r, c, n = N) => r >= 0 && r < n && c >= 0 && c < n;

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

/** fleet: { shipId: { r, c, d } } → { "r,c": { id, i } }（cfg 決定船長，預設簡易 5×5） */
export function fleetCellMap(fleet, cfg = BOARDS[DEFAULT_BOARD]) {
  const m = {};
  for (const id in fleet) {
    cellsOf(fleet[id], cfg.ships[id] ?? 0).forEach(([r, c], i) => {
      m[cellKey(r, c)] = { id, i };
    });
  }
  return m;
}

/** 取得某格上的船艦 id（無則 undefined） */
export function shipAtCell(fleet, r, c, cfg = BOARDS[DEFAULT_BOARD]) {
  return fleetCellMap(fleet, cfg)[cellKey(r, c)]?.id;
}

/**
 * 驗證船隊是否合法：該海域的船齊全、不出界、不可重疊；
 * 「不可相鄰（含斜角）」僅適用於簡易 5×5（正版 10×10 照官方規則允許緊鄰）。
 * 回傳 { ok, reason }
 */
export function validateFleet(fleet, cfg = BOARDS[DEFAULT_BOARD]) {
  if (!fleet || typeof fleet !== "object") return { ok: false, reason: "缺少船隊資料" };
  const ids = shipIdsOf(cfg);
  for (const id of ids) {
    const p = fleet[id];
    if (!p) return { ok: false, reason: "船艦尚未全部擺放" };
    if (typeof p.r !== "number" || typeof p.c !== "number") return { ok: false, reason: "船艦位置格式錯誤" };
    if (p.d !== "H" && p.d !== "V") return { ok: false, reason: "船艦方向錯誤" };
    const cs = cellsOf(p, cfg.ships[id]);
    if (!cs.every(([r, c]) => inBounds(r, c, cfg.n))) return { ok: false, reason: "船艦超出海域範圍" };
  }
  // 重疊一律禁止；相鄰只有「不可相鄰」的海域（s5）才禁止
  const minDist = cfg.adjacent ? 0 : 1;
  for (const id of ids) {
    for (const other of ids) {
      if (other === id) continue;
      for (const [ar, ac] of cellsOf(fleet[id], cfg.ships[id])) {
        for (const [br, bc] of cellsOf(fleet[other], cfg.ships[other])) {
          if (Math.max(Math.abs(ar - br), Math.abs(ac - bc)) <= minDist) {
            return { ok: false, reason: cfg.adjacent ? "船艦不可重疊" : "船艦不可重疊或相鄰（含斜角）" };
          }
        }
      }
    }
  }
  return { ok: true, reason: "" };
}

/** 某艘船是否已被完全命中（fired: { cell: 1|2|3 }） */
export function isShipSunk(fleet, shipId, fired, cfg = BOARDS[DEFAULT_BOARD]) {
  const p = fleet?.[shipId];
  if (!p) return false;
  return cellsOf(p, cfg.ships[shipId] ?? 0).every(([r, c]) => (fired[cellKey(r, c)] || 0) >= MARK.HIT);
}

/** 對手所有船艦是否皆已擊沉 → 回傳 { all, sunkIds } */
export function allShipsSunk(fleet, fired, cfg = BOARDS[DEFAULT_BOARD]) {
  const sunkIds = [];
  let all = true;
  for (const id of shipIdsOf(cfg)) {
    if (!fleet?.[id]) continue;
    if (isShipSunk(fleet, id, fired, cfg)) sunkIds.push(id);
    else all = false;
  }
  return { all, sunkIds };
}

/**
 * 擊沉自動標註：被擊沉的船，周圍一圈自動標為「落空」（可手動修改）。
 * 僅適用於「不可相鄰」的海域（簡易 5×5）——正因為船不能緊鄰，
 * 擊沉船的周圍才必然是空的。正版 10×10 允許緊鄰，周圍可能有其他船，
 * 無法推論，故不自動標註。回傳 Set of cellKey
 */
export function autoMissCells(fleet, fired, cfg = BOARDS[DEFAULT_BOARD]) {
  const out = new Set();
  if (cfg.adjacent) return out; // 允許緊鄰的海域：不自動標註周圍
  for (const id of shipIdsOf(cfg)) {
    const p = fleet?.[id];
    if (!p) continue;
    if (!isShipSunk(fleet, id, fired, cfg)) continue;
    for (const [r, c] of cellsOf(p, cfg.ships[id])) {
      for (const [a, b] of NEIGHBORS8) {
        const nr = r + a, nc = c + b;
        if (inBounds(nr, nc, cfg.n)) out.add(cellKey(nr, nc));
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
export function buildEnemyBoard({ fired = {}, enemyFleet = {}, marks = {}, cfg = BOARDS[DEFAULT_BOARD] } = {}) {
  const board = {};
  for (const k in fired) board[k] = fired[k];
  const auto = autoMissCells(enemyFleet, fired, cfg);
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
