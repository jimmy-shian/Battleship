/*!
 * 海戰棋 — 連線新盤面
 * -----------------------------------------------------------------------------
 * 職責：
 *   1. 建立／維護 WebSocket 通訊（BattleComm 模組）
 *   2. 船艦擺放（沿用單機版的拖放互動）
 *   3. 開火、回合提示、自動標註與結算（結果由系統判定，無需手動標記）
 *   4. 房內通訊（文字）
 *
 * 注意：本頁刻意不含「紀錄」區塊，連線版不需要歷史戰績。
 */
import { BattleComm, normalizeRoomKey } from "./comm.mjs";
import { browserId } from "./user.js";
import { S2C, C2S } from "./protocol.js";
import { enhanceSelect } from "./select.js";
import {
  BOARDS,
  DEFAULT_BOARD,
  boardConfig,
  shipIdsOf,
  shipNameOf,
  colsOf,
  cellLabel,
  MARK,
  cellKey,
  parseCell,
  inBounds,
  cellsOf,
  validateFleet,
  fleetCellMap
} from "./rules.js";

const $ = (s) => document.querySelector(s);

/* ---------- 圖示 ---------- */
const I = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const ICON = {
  rot: I('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  reset: I('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/>'),
  undo: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: I('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  lock: I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  unlock: I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>'),
  trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  help: I('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>'),
  min: I('<path d="M6 15l6-6 6 6"/>'),
  close: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: I('<path d="M5 12l5 5L20 7"/>'),
  exit: I('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h9"/>'),
  chat: I('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-2.9-.4L4 21l1.6-4.2A8.2 8.2 0 0 1 3.6 11 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/>'),
  archive: I('<path d="M3 7h18v3H3z"/><path d="M5 10v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9"/><path d="M10 14h4"/>')
};

const CELL_ICON = {
  1: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="#7c8ba1"/></svg>',
  2: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3" fill="none" stroke="#2563eb" stroke-width="2.4"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#d2707b" stroke-width="2.6" stroke-linecap="round"/></svg>',
  3: '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 5.6L20 6l-2 5.8L22 14l-5.8.6L15 21l-3-4.2L9 21l-1.2-6.4L2 14l4-2.2L4 6l5.6 1.6z" fill="#fff"/></svg>',
  miss: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="none" stroke="#94a3b8" stroke-width="2.2"/></svg>'
};

/* ---------- 狀態 ---------- */
let S = { fleet: {}, incoming: {} };          // 我的船隊 + 收到的炮擊
let fleet = {};                              // 本地編輯中的船隊
let locked = false;                          // 是否已鎖定佈陣
let pendingLock = false;                     // 鎖定訊息已送出、等待伺服器確認
let sel = "3";
let state = null;                            // 伺服器快照
let wasDisconnected = false;
let roomFull = false;
let resetDismissedKey = null;                // 已忽略的重開提議（避免重複打擾）
let D = null, press = null;
let comm = null;
let lastFired = null;

/* ---------- 海域模式（s5 簡易 5×5 / c10 正版 10×10） ---------- */
let cfg = null;                              // 目前海域設定
let LEN = {};                                // cfg.ships
let IDS = [];                                // 船艦 id 清單

const own = $("#own"), en = $("#enemy");
const ownEls = {}, enEls = {};

/* ---------- 工具 ---------- */

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function readLS(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

/** 複製文字到剪貼簿 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ---------- 參數 ---------- */

const params = new URLSearchParams(location.search);
const roomKey = normalizeRoomKey(params.get("key") || readLS("bs.room.key", ""));
const playerName = (params.get("name") || readLS("bs.room.name", "") || "").slice(0, 16);
const serverUrl = params.get("server") || readLS("bs.server.url", "") || "";
/** 海域模式：網址帶的 mode > 上次使用 > 簡易 5×5 */
const wantMode = BOARDS[params.get("mode")] ? params.get("mode")
  : BOARDS[readLS("bs.room.mode", "")] ? readLS("bs.room.mode", "")
  : DEFAULT_BOARD;

// 網址不帶暱稱；若這台電腦還沒有暱稱，先回大廳請對方填寫
if (!playerName) {
  const q = new URLSearchParams();
  if (roomKey) q.set("key", roomKey);
  if (serverUrl) q.set("server", serverUrl);
  q.set("mode", wantMode);
  location.replace("index.html" + (q.toString() ? "?" + q.toString() : ""));
  await new Promise(() => {}); // 停止本模組後續執行，等待跳轉
}

$("#roomChip").textContent = roomKey || "未指定房間";
const modeCtl = enhanceSelect($("#modeSel"), { compact: true });
$("#helpBtn").innerHTML = ICON.help;
$("#closeBtn").innerHTML = ICON.close;
$("#mn").innerHTML = ICON.close;
$("#rotBtn").innerHTML = ICON.rot;
$("#lockShip").innerHTML = ICON.unlock;
$("#clrOwn").innerHTML = ICON.trash;
$("#leaveBtn").innerHTML = ICON.exit;
$("#chatFabIco").innerHTML = ICON.chat;
$("#chatClose").innerHTML = ICON.close;
$("#archBtn").innerHTML = ICON.archive;
$("#archBtn").href = "history.html?room=" + encodeURIComponent(roomKey);
$("#archLink").href = "history.html?room=" + encodeURIComponent(roomKey);

/* 點擊房號即可複製，方便分享給朋友 */
$("#roomChip").onclick = async () => {
  if (!roomKey) return;
  const ok = await copyText(roomKey);
  if (!ok) { toast("複製失敗，請手動選取房號"); return; }
  const chip = $("#roomChip");
  chip.classList.add("copied");
  setTimeout(() => chip.classList.remove("copied"), 1200);
  toast("已複製房號 " + roomKey + "，貼給朋友即可一起玩");
};

/* ---------- 棋盤建立 ---------- */

function frame(b, els, mk) {
  b.append(document.createElement("div"));
  colsOf(cfg).forEach((c) => {
    const e = document.createElement("div");
    e.className = "co";
    e.textContent = c;
    b.append(e);
  });
  for (let r = 0; r < cfg.n; r++) {
    const l = document.createElement("div");
    l.className = "co";
    l.textContent = r + 1;
    b.append(l);
    for (let c = 0; c < cfg.n; c++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cell";
      btn.dataset.r = r;
      btn.dataset.c = c;
      els[cellKey(r, c)] = btn;
      mk(btn, r, c);
      b.append(btn);
    }
  }
}

/** 依目前海域模式重建兩塊棋盤（切換模式時呼叫） */
function buildBoards() {
  own.innerHTML = "";
  en.innerHTML = "";
  for (const k in ownEls) delete ownEls[k];
  for (const k in enEls) delete enEls[k];
  D = null;
  press = null;
  for (const b of [own, en]) {
    b.style.gridTemplateColumns = `26px repeat(${cfg.n}, minmax(0, 1fr))`;
    b.classList.toggle("big", cfg.n > 5);
  }
  frame(own, ownEls, (b, r, c) => {
    b.addEventListener("pointerdown", (e) => {
      if (locked) return;
      const s = shipAt()[cellKey(r, c)];
      press = { k: cellKey(r, c), x: e.clientX, y: e.clientY, id: !s ? undefined : s.id, grab: s ? s.i : 0, from: "board" };
      if (s) { sel = s.id; updOwn(); }
    });
  });
  frame(en, enEls, (b, r, c) => {
    const k = cellKey(r, c);
    b.addEventListener("click", () => {
      if (!state) return;
      if (state.phase !== "battle") { toast("戰局尚未開始"); return; }
      if (!state.canFire) { toast("還不是你的回合"); return; }
      const v = (state.enemy.board && state.enemy.board[k]) || 0;
      if (v !== 0) { toast("這個位置已經打過了"); return; }
      if (!comm.fire(k)) toast("尚未連線，請稍候再試");
    });
  });
}

/* ---------- 海域模式切換 ---------- */

const fleetKey = () => "bs.local.fleet." + roomKey + "." + cfg.id;

/** 讀取這台電腦在「目前海域模式」下編輯中的船隊（並過濾掉不合用的位置） */
function loadLocalFleet() {
  try {
    const saved = JSON.parse(localStorage.getItem(fleetKey()) || "null");
    if (saved && typeof saved === "object") {
      const out = {};
      for (const id of IDS) {
        const p = saved[id];
        if (!p) continue;
        const pos = { r: p.r | 0, c: p.c | 0, d: p.d === "V" ? "V" : "H" };
        if (cellsOf(pos, LEN[id]).every(([r, c]) => inBounds(r, c, cfg.n))) out[id] = pos;
      }
      return out;
    }
  } catch (e) {}
  return {};
}

/** 套用新的海域模式：重建棋盤與船艦區、載入該模式的本地船隊 */
function applyMode(id) {
  const next = boardConfig(id);
  if (cfg && next.id === cfg.id) return;
  cfg = next;
  LEN = cfg.ships;
  IDS = shipIdsOf(cfg);
  sel = IDS[0];
  fleet = loadLocalFleet();
  locked = false;
  pendingLock = false;
  buildPicker();
  buildBoards();
  updOwn();
  updEn();
}

/* ---------- 船隊擺放（沿用單機版互動） ---------- */

const shipAt = () => fleetCellMap(fleet, cfg);

function validPlace(id, p) {
  const cs = cellsOf(p, LEN[id]);
  if (!cs.every(([r, c]) => inBounds(r, c, cfg.n))) return false;
  // 簡易 5×5：不可相鄰（含斜角）；正版 10×10：照官方規則允許緊鄰，只禁重疊
  const minDist = cfg.adjacent ? 0 : 1;
  for (const o in fleet) {
    if (o === id) continue;
    for (const [a, b] of cellsOf(fleet[o], LEN[o])) {
      for (const [r, c] of cs) {
        if (Math.max(Math.abs(a - r), Math.abs(b - c)) <= minDist) return false;
      }
    }
  }
  return true;
}

function updOwn() {
  const m = shipAt();
  const incoming = S.incoming || {};
  for (const k in ownEls) {
    const el = ownEls[k];
    const [r, c] = parseCell(k);
    const s = m[k];
    const same = (a, b) => m[cellKey(a, b)] && s && m[cellKey(a, b)].id === s.id;
    el.classList.toggle("ship", !!s);
    el.classList.toggle("sel", !!s && s.id === sel && !locked);
    el.classList.toggle("dim", !!(D && D.from === "board" && s && s.id === D.id));
    el.classList.toggle("dead", locked);
    el.classList.remove("hit", "miss");

    // 船艦上色＋船頭／船尾標記
    if (s) {
      const col = cfg.colors[s.id] || "#93c5fd";
      el.style.setProperty("--sc", col);
      el.style.setProperty("--sc-soft", col + "4d");
      const len = LEN[s.id] || 1;
      const d = fleet[s.id] ? fleet[s.id].d : "H";
      el.classList.toggle("bow", s.i === len - 1);
      el.classList.toggle("stern", s.i === 0 && len > 1);
      el.classList.toggle("dH", d === "H");
      el.classList.toggle("dV", d === "V");
    } else {
      el.classList.remove("bow", "stern", "dH", "dV");
      el.style.removeProperty("--sc");
      el.style.removeProperty("--sc-soft");
    }

    const R = (a, b) => (!same(r + a, c) && !same(r, c + b) ? "11px" : "4px");
    el.style.borderRadius = s ? `${R(-1, -1)} ${R(-1, 1)} ${R(1, 1)} ${R(1, -1)}` : "";

    // 對方炮擊結果
    let h = "";
    if (incoming[k] !== undefined) {
      if (incoming[k] >= MARK.HIT) {
        el.classList.add("hit");
        h = CELL_ICON.x;
      } else {
        el.classList.add("miss");
        h = CELL_ICON.miss;
      }
    }
    if (el._h !== h) { el.innerHTML = h; el._h = h; }
  }

  document.querySelectorAll(".po").forEach((p) => {
    p.classList.toggle("sel", p.dataset.id === sel);
    p.classList.toggle("placed", !!fleet[p.dataset.id]);
  });

  $("#rotBtn").disabled = locked || !(fleet[sel] && LEN[sel] > 1);
  const lb = $("#lockShip");
  lb.innerHTML = locked ? ICON.lock : ICON.unlock;
  lb.classList.toggle("on", locked);
  lb.classList.toggle("canlock", !locked && IDS.every((id) => fleet[id]));
  lb.disabled = state ? state.phase !== "setup" : false;
  $("#picker").classList.toggle("off", locked);
  own.classList.toggle("locked", locked);
}

/** 船艦剪影 SVG：每艘專屬顏色、船頭尖角、艦橋，含格線 */
const shipSvg = (id, len) => {
  const c = cfg.colors[id] || "#93c5fd";
  const cw = 17, bow = 6, w = len * cw + bow + 4, hh = 20;
  let seps = "";
  for (let i = 1; i < len; i++) seps += `<path d="M${3 + i * cw} 6v8" stroke="#0f172a" stroke-opacity=".3"/>`;
  const bridgeX = Math.round(3 + len * cw * 0.42);
  return `<svg width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}"><path d="M4 5 L${2 + len * cw} 5 L${2 + len * cw + bow} 10 L${2 + len * cw} 15 L4 15 Q2 15 2 12.5 L2 7.5 Q2 5 4 5 Z" fill="${c}" stroke="#0f172a" stroke-opacity=".45" stroke-width="1.4"/><rect x="${bridgeX}" y="7" width="5" height="6" rx="1" fill="#0f172a" fill-opacity=".45"/>${seps}</svg>`;
};

/** 依目前海域模式重建船艦區（含船名標籤與專屬配色） */
function buildPicker() {
  $("#picker").innerHTML = IDS.map((id) => {
    const name = shipNameOf(cfg, id);
    return `<div class="po" data-id="${id}" title="${name}（${LEN[id]} 格）">${shipSvg(id, LEN[id])}<span class="pn">${name}</span></div>`;
  }).join("");
}

/* 從船艦區拖出（事件委派，模式切換後仍有效） */
$("#picker").addEventListener("pointerdown", (e) => {
  const p = e.target.closest(".po");
  if (!p || locked) return;
  e.preventDefault();
  sel = p.dataset.id;
  press = { x: e.clientX, y: e.clientY, id: sel, grab: LEN[sel] >> 1, from: "picker" };
  updOwn();
});

const ghost = $("#ghost");

function startDrag(e) {
  const id = press.id;
  const p = fleet[id];
  D = { id, grab: press.grab, d: p ? p.d : "H", d0: p ? p.d : "H", from: press.from, t: null, pv: [] };
  const cs = own.querySelector(".cell").offsetWidth;
  const len = LEN[id];
  ghost.style.cssText = `display:flex;flex-direction:${D.d === "V" ? "column" : "row"}`;
  ghost.innerHTML = Array.from({ length: len }, () => `<i style="width:${cs}px;height:${cs}px"></i>`).join("");
  D.cs = cs;
  document.body.classList.add("dragging");
  moveDrag(e);
  updOwn();
}

function moveDrag(e) {
  const { cs, grab, id } = D;
  const len = LEN[id];
  D.pv.forEach((k) => ownEls[k].classList.remove("pv", "bad"));
  D.pv = [];
  D.t = null;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const cell = el && el.closest && el.closest("#own .cell");
  if (cell) {
    const r = +cell.dataset.r, c = +cell.dataset.c;
    const o = D.d0;
    const dirs = len > 1 ? [o, o === "H" ? "V" : "H"] : [o];
    let best = null, bd = 99;
    const tryP = (p, q) => { if (q < bd && validPlace(id, p)) { best = p; bd = q; } };
    dirs.forEach((d, oi) => {
      for (let gi = 0; gi < len; gi++) {
        tryP({ r: d === "V" ? r - gi : r, c: d === "H" ? c - gi : c, d }, (gi === grab ? 0 : 2 + Math.abs(gi - grab)) + oi * 1.2);
      }
      const rw = { r: d === "V" ? r - grab : r, c: d === "H" ? c - grab : c };
      for (const [a, b] of [[-1, 0], [0, -1], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        tryP({ r: rw.r + a, c: rw.c + b, d }, 10 + a * a + b * b + oi * 1.2);
      }
    });
    D.t = best;
    const sh = best || { r: o === "V" ? r - grab : r, c: o === "H" ? c - grab : c, d: o };
    if (best && best.d !== D.d) { D.d = best.d; ghost.style.flexDirection = D.d === "V" ? "column" : "row"; }
    const cl = cellsOf(sh, len).filter(([a, b]) => inBounds(a, b, cfg.n)).map(([a, b]) => cellKey(a, b));
    cl.forEach((k) => ownEls[k].classList.add(best ? "pv" : "bad"));
    D.pv = cl;
  }
  const d = D.d;
  ghost.style.left = e.clientX - (d === "H" ? (grab + 0.5) * cs + grab * 4 : cs / 2) + "px";
  ghost.style.top = e.clientY - (d === "V" ? (grab + 0.5) * cs + grab * 4 : cs / 2) + "px";
}

function endDrag(ok) {
  if (!D) return;
  D.pv.forEach((k) => ownEls[k].classList.remove("pv", "bad"));
  if (ok && D.t) {
    const o = fleet[D.id];
    if (!o || o.r !== D.t.r || o.c !== D.t.c || o.d !== D.t.d) {
      fleet[D.id] = D.t;
      localFleet();
    }
    sel = D.id;
  }
  ghost.style.display = "none";
  document.body.classList.remove("dragging");
  D = null;
  updOwn();
}

window.addEventListener("pointermove", (e) => {
  if (D) { e.preventDefault(); moveDrag(e); return; }
  if (press && press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) startDrag(e);
}, { passive: false });

window.addEventListener("pointerup", (e) => {
  if (D) { endDrag(true); press = null; return; }
  press = null;
});

window.addEventListener("pointercancel", () => { endDrag(false); press = null; });

function rotate() {
  if (locked) return;
  const p = fleet[sel], len = LEN[sel];
  if (!p || len < 2) return;
  const toV = p.d === "H";
  // 以船身中心為軸旋轉，並在原位附近微調（0 / ±1 格）找出合法位置
  const half = (len - 1) >> 1;
  const cr = p.r + (p.d === "V" ? half : 0);
  const cc = p.c + (p.d === "H" ? half : 0);
  const cands = [];
  for (const dr of [0, -1, 1]) {
    for (const dc of [0, -1, 1]) {
      cands.push(toV
        ? { r: cr - half + dr, c: cc + dc, d: "V" }
        : { r: cr + dr, c: cc - half + dc, d: "H" });
    }
  }
  const ok = cands.find((x) => validPlace(sel, x));
  if (!ok) {
    cellsOf(p, len).forEach(([r, cc]) => {
      const e = ownEls[cellKey(r, cc)];
      e.classList.remove("shake");
      void e.offsetWidth;
      e.classList.add("shake");
    });
    return;
  }
  fleet[sel] = ok;
  localFleet();
  updOwn();
}

$("#rotBtn").onclick = rotate;

function localFleet() {
  writeLS(fleetKey(), JSON.stringify(fleet));
  updOwn();
}

/* ---------- 敵方海域 ---------- */

function updEn() {
  const board = (state && state.enemy && state.enemy.board) || {};
  const auto = new Set((state && state.enemy && state.enemy.autoMarks) || []);
  const canFire = !!(state && state.canFire);
  const phase = state ? state.phase : "setup";
  const over = !!(state && state.phase === "over");
  // 結算時公開對方船位
  const reveal = over && state.enemy && state.enemy.fleet ? fleetCellMap(state.enemy.fleet, cfg) : {};

  for (const k in enEls) {
    const el = enEls[k];
    if (el === demoTarget) continue; // 導覽示範中，暫時不重繪
    const v = board[k] || 0;
    el.dataset.v = v;
    el.classList.toggle("auto", auto.has(k));
    el.classList.toggle("fired", v !== 0);
    el.classList.toggle("aim", canFire && v === 0);
    el.classList.toggle("ship", !!reveal[k]);
    if (reveal[k]) {
      const col = cfg.colors[reveal[k].id] || "#93c5fd";
      el.style.setProperty("--sc", col);
      el.style.setProperty("--sc-soft", col + "4d");
      const len = LEN[reveal[k].id] || 1;
      const fd = state.enemy.fleet[reveal[k].id];
      const d = fd ? fd.d : "H";
      el.classList.toggle("bow", reveal[k].i === len - 1);
      el.classList.toggle("stern", reveal[k].i === 0 && len > 1);
      el.classList.toggle("dH", d === "H");
      el.classList.toggle("dV", d === "V");
    } else {
      el.classList.remove("bow", "stern", "dH", "dV");
      el.style.removeProperty("--sc");
      el.style.removeProperty("--sc-soft");
    }
    const h = CELL_ICON[v] || "";
    if (el._h !== h) { el.innerHTML = h; el._h = h; }
  }
  // 輪到開火時：敵方面板整體外框微亮（不再讓每個格子閃爍）
  $("#enPanel").classList.toggle("yourturn", canFire);
  $("#enemyHint").textContent = over ? "本局結束" : canFire ? "點擊格子開火" : "等待回合";
}

/* ---------- 重開對局（雙方同意；單人房間直接重開） ---------- */

$("#resetBtn").innerHTML = ICON.reset;
$("#resetDismiss").innerHTML = ICON.close;
$("#resetBtn").onclick = () => {
  if (!comm || !comm.connected) { toast("尚未連線"); return; }
  if (!state) return;
  const votes = state.resetVotes || [];
  const onlineCount = (state.players || []).filter((p) => p.online).length;
  if (votes.includes(state.you)) {
    if (!confirm("撤回重開對局的請求？")) return;
    comm.reset();
    toast("已撤回重開請求");
    return;
  }
  if (onlineCount <= 1) {
    if (!confirm("重新開始對局？（房間內目前只有你）")) return;
    comm.reset();
    return;
  }
  if (!confirm("向對手提出重開對局？\n對手同意後才會重開（船艦保留、需重新鎖定）。")) return;
  comm.reset();
  toast("已送出重開請求，等待對手同意");
};

$("#resetAgree").onclick = () => {
  if (!comm || !comm.connected) { toast("尚未連線"); return; }
  if (state) state.resetVotes = [];
  syncResetBanner();
  comm.reset();
};

$("#resetDismiss").onclick = () => {
  resetDismissedKey = ((state && state.resetVotes) || []).join(",");
  syncResetBanner();
};

/** 依伺服器狀態同步重開提議的按鈕樣式與同意橫幅 */
function syncResetBanner() {
  const votes = (state && state.resetVotes) || [];
  const you = state ? state.you : null;
  const iVoted = you != null && votes.includes(you);
  $("#resetBtn").classList.toggle("pending", iVoted);
  const oppVoted = votes.some((id) => id !== you);
  const key = votes.join(",");
  const show = oppVoted && resetDismissedKey !== key;
  $("#resetBanner").hidden = !show;
  if (show) {
    const voter = (state.players || []).find((p) => votes.includes(p.id));
    $("#resetBannerText").textContent = (voter ? voter.name : "對手") + " 提議重開對局";
  }
}

/* ---------- 海域模式選擇 ---------- */

$("#modeSel").addEventListener("change", (e) => {
  if (!comm || !comm.connected) { toast("尚未連線"); return; }
  comm.setBoardMode(e.target.value);
  toast("海域模式已更新：" + boardConfig(e.target.value).label);
});

/* ---------- 鎖定 / 清空 ---------- */

$("#lockShip").onclick = () => {
  if (locked) {
    comm.unready();
    locked = false;
    pendingLock = false;
    updOwn();
    return;
  }
  const v = validateFleet(fleet, cfg);
  if (!v.ok) { toast(v.reason); return; }
  // 連線中會先暫存，連線成功後自動補送；完全無法送出時才提示
  if (!comm.ready(fleet)) {
    toast("尚未連線，請稍候再試");
    return;
  }
  locked = true;
  pendingLock = true;
  updOwn();
  toast("已鎖定船艦，等待對手");
};

$("#clrOwn").onclick = () => {
  if (locked) { toast("已鎖定，請先解鎖"); return; }
  fleet = {};
  localFleet();
  updOwn();
};

/* ---------- 通訊（右下角氣泡） ---------- */

let chatOpen = false;
let unread = 0;
let noteTimer = null;

/** 展開／收合通訊氣泡 */
function setChatOpen(open) {
  chatOpen = !!open;
  $("#chatPop").hidden = !chatOpen;
  $("#chatFab").setAttribute("aria-expanded", chatOpen ? "true" : "false");
  if (chatOpen) {
    unread = 0;
    updateBadge();
    if (window.matchMedia("(min-width: 640px)").matches) $("#chatInput").focus();
  }
}

/** 未讀數量徽章 */
function updateBadge() {
  const b = $("#chatBadge");
  if (unread > 0 && !chatOpen) {
    b.textContent = unread > 99 ? "99+" : String(unread);
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

/** 新訊息小提示（右下角浮出，數秒後自動消失）；對話框開啟時不顯示，避免擋住對話框 */
function notifyChat(who, text) {
  if (chatOpen) return; // 對話框開著：使用者看得到訊息，不需要懸浮通知
  unread++;
  updateBadge();
  const fab = $("#chatFab");
  fab.classList.remove("ping");
  void fab.offsetWidth;
  fab.classList.add("ping");
  const n = $("#chatNote");
  n.textContent = "";
  const w = document.createElement("span");
  w.className = "who";
  w.textContent = who || "新訊息";
  const t = document.createElement("span");
  t.textContent = text;
  n.appendChild(w);
  n.appendChild(t);
  n.classList.add("show");
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => n.classList.remove("show"), 4500);
}

function addChat(text, who, mine, sys, note) {
  const log = $("#chatLog");
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " me" : "") + (sys ? " sys" : "");
  if (who) {
    const b = document.createElement("span");
    b.className = "who";
    b.textContent = who + "：";
    div.appendChild(b);
  }
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  $("#chatCount").textContent = log.children.length + " 則";
  if (note) notifyChat(who, text);
}

$("#chatFab").onclick = () => setChatOpen(!chatOpen);
$("#chatClose").onclick = () => setChatOpen(false);
$("#chatNote").onclick = () => setChatOpen(true);

// 本局結束時，點狀態列的「本局結束 · 點此再看結果」可重新打開結算視窗
$("#turnText").onclick = () => { if (state && state.phase === "over") showResult(); };

$("#chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chatInput").value.trim();
  if (!text) return;
  if (!comm || !comm.connected) { toast("尚未連線"); return; }
  comm.chat(text);
  $("#chatInput").value = "";
  $("#chatInput").focus();
});

/* ---------- 狀態渲染 ---------- */

function renderPlayers() {
  const box = $("#players");
  box.innerHTML = "";
  (state.players || []).forEach((p) => {
    const row = document.createElement("div");
    row.className = "pl";
    const isTurn = state.turn && state.turn === p.id && state.phase === "battle";
    row.innerHTML =
      '<span class="dot ' + (p.online ? "on" : "") + '"></span>' +
      '<span class="nm ' + (p.isYou ? "me" : "") + '"></span>' +
      '<span class="st ' + (p.ready ? "ready" : "") + (isTurn ? " turn" : "") + '"></span>';
    row.querySelector(".nm").textContent = p.name + (p.isYou ? "（你）" : "");
    row.querySelector(".st").textContent = isTurn ? "回合中" : p.ready ? "已佈陣" : "佈陣中";
    box.appendChild(row);
  });
  if (!(state.players || []).length) {
    box.innerHTML = '<span class="wait">等待玩家加入…</span>';
  }
  // 海域模式（僅佈陣階段可更改）
  const modeSel = $("#modeSel");
  if (state.boardMode && modeSel.value !== state.boardMode) {
    modeSel.value = state.boardMode;
    modeCtl.refresh(); // 同步自訂下拉顯示
  }
  $("#modeBox").style.display = state.phase === "setup" ? "" : "none";
}

function renderStatus() {
  const dot = $("#connDot");
  const text = $("#connText");
  const turn = $("#turnText");

  if (!comm) return;
  if (comm.connected) {
    dot.className = "dot on";
    text.textContent = "已連線";
  } else if (comm.status === "reconnecting") {
    dot.className = "dot warn";
    text.textContent = "重新連線中…";
  } else {
    dot.className = "dot off";
    text.textContent = "未連線";
  }

  if (!state) { turn.textContent = "—"; turn.style.cursor = ""; return; }

  if (state.phase === "over") {
    turn.className = "turn";
    turn.textContent = "本局結束 · 點此再看結果";
    turn.style.cursor = "pointer";
  } else if (state.phase === "setup") {
    turn.style.cursor = "";
    turn.className = "turn wait";
    const opp = (state.players || []).find((p) => !p.isYou);
    turn.textContent = locked ? (opp && opp.ready ? "準備完成，開始！" : "等待對手佈陣") : "請擺好船艦並鎖定";
  } else if (state.canFire) {
    turn.className = "turn mine";
    turn.textContent = "你的回合";
  } else {
    turn.className = "turn wait";
    turn.textContent = "等待對手";
  }
}

function updAll() {
  if (state) {
    S.incoming = state.mine ? state.mine.incoming : {};
    if (state.mine) {
      if (state.mine.ready) {
        locked = true;
        pendingLock = false;
      } else if (!pendingLock) {
        // 伺服器尚未認可（或已解除）鎖定 → 與伺服器保持一致
        locked = false;
      }
    }
  }
  updOwn();
  updEn();
  renderPlayers();
  renderStatus();
  syncResetBanner();
}

/* ---------- 結果視窗 ---------- */

function showResult() {
  const m = $("#modal");
  const over = state.over;
  const me = state.players.find((p) => p.isYou);
  const opp = state.players.find((p) => !p.isYou);
  const iWon = over && over.winner === state.you;

  $("#mt").innerHTML = over
    ? '<span class="' + (iWon ? "win" : "lose") + '">' + (iWon ? "你贏了！" : "你輸了…") + "</span>"
    : "本局結束";

  const mine = state.mine.stats || { shots: 0, hits: 0, rate: null };
  const theirs = state.enemy.stats || { shots: 0, hits: 0, rate: null };
  const rt = (r) => (r === null || r === undefined ? "–" : r + "%");

  $("#resultBody").innerHTML =
    "<table><tr><th>玩家</th><th>出擊</th><th>命中</th><th>命中率</th></tr>" +
    "<tr><td class='" + (me ? "me" : "") + "'>" + (me ? me.name : "你") + "</td><td>" + mine.shots + "</td><td>" + mine.hits + "</td><td>" + rt(mine.rate) + "</td></tr>" +
    "<tr><td>" + (opp ? opp.name : "對手") + "</td><td>" + theirs.shots + "</td><td>" + theirs.hits + "</td><td>" + rt(theirs.rate) + "</td></tr>" +
    "</table>";

  m.classList.add("show");
}

$("#mn").onclick = () => $("#modal").classList.remove("show");
$("#rematchBtn").onclick = () => {
  $("#modal").classList.remove("show");
  comm.rematch(true);
  toast("已送出再戰邀請");
};

/* ---------- 通訊連線 ---------- */

function setConn(cls, txt) {
  $("#connDot").className = "dot " + cls;
  $("#connText").textContent = txt;
}

function connect() {
  if (!roomKey) {
    setConn("off", "缺少房間金鑰");
    addChat("缺少房間金鑰，請回到大廳重新進入。", "", false, true);
    return;
  }

  let prevPhase = null; // 上一份 state 的階段（結算視窗只在 battle→over 時彈出）

  comm = new BattleComm({
    url: serverUrl || null,
    key: roomKey,
    name: playerName,
    clientId: sessionId(),
    userId: browserId(),
    boardMode: cfg.id,   // 進房時帶上希望的海域模式（僅佈陣階段有效）
    autoReconnect: true,
    debug: false
  });

  comm.on("status", (e) => {
    const s = e.detail.status;
    if (s === "open") setConn("on", "已連線");
    else if (s === "reconnecting") setConn("warn", "重新連線中…");
    else if (s === "closed") setConn("off", "連線中斷");
    else setConn("warn", "連線中…");
    renderStatus();
  });

  comm.on("socket", (e) => {
    const phase = e.detail.phase;
    if (phase === "close") {
      wasDisconnected = true;
      addChat("連線中斷，正在重新連線…", "", false, true);
    } else if (phase === "open" && wasDisconnected) {
      wasDisconnected = false;
      addChat("已重新連線", "", false, true);
    }
  });

  comm.on(S2C.WELCOME, () => {
    addChat("已進入房間 " + roomKey, "", false, true);
    // 重連後補送鎖定狀態，確保與伺服器一致
    if (locked) comm.ready(fleet);
  });

  comm.on(S2C.STATE, (e) => {
    state = e.detail;
    window.__bs = { state, comm }; // 除錯用：可在主控台檢視最新狀態
    // 海域模式與伺服器不一致（例如對手更換）→ 重建棋盤與船艦區
    if (state.boardMode && (!cfg || state.boardMode !== cfg.id)) applyMode(state.boardMode);
    updAll();
    // 結算視窗只在「自己參與的這局」由戰鬥轉為結束時彈出一次；
    // 進入已結束的殘局（state 一來就是 over）不彈，避免蓋住佈陣畫面
    if (state.phase === "over" && prevPhase === "battle" && !$("#modal").classList.contains("show")) showResult();
    prevPhase = state.phase;
    if (state.phase === "battle" && lastFired) { lastFired = null; }
  });

  comm.on(S2C.PLAYER, (e) => {
    const p = e.detail.player;
    if (e.detail.event === "leave") addChat(p.name + " 離線了（座位稍後自動釋出）", "", false, true, true);
    else if (e.detail.event === "takeover") addChat(p.name + " 接上了離線的座位", "", false, true, true);
    else if (e.detail.event === "removed") addChat(p.name + " 已離開，座位釋出", "", false, true, true);
    else addChat(p.name + " 加入了房間", "", false, true, true);
  });

  comm.on(S2C.FIRE, (e) => {
    const d = e.detail;
    const mine = d.by === (state && state.you);
    const label = cellLabel(d.cell);
    const sunkName = d.sunk ? "（" + shipNameOf(cfg, d.sunk.id) + "）" : "";
    const word = d.result === 1 ? "落空" : d.result === 2 ? "命中" : "擊沉" + sunkName;
    addChat((mine ? "你" : d.byName) + " 攻擊 " + label + " → " + word, "", mine, false);
    if (d.sunk) flashSunk(d.sunk);
  });

  comm.on(S2C.CHAT, (e) => {
    const d = e.detail;
    addChat(d.text, d.from, d.fromId === (state && state.you), false, true);
  });

  comm.on(S2C.REMATCH, () => {
    locked = false;
    $("#modal").classList.remove("show"); // 伺服器重置（再戰／新玩家接手）時關閉結算視窗
    addChat("新的一局開始了！", "", false, true);
  });

  comm.on(S2C.RESET, (e) => {
    // 對局被重開（雙方同意或單人房間）→ 回到佈陣階段
    locked = false;
    pendingLock = false;
    const by = e.detail && e.detail.by;
    addChat(by ? by + " 重開了對局，請重新鎖定船艦" : "對局已重算，請重新佈陣", "", false, true, true);
    if (state) state.resetVotes = [];
    resetDismissedKey = null;
    $("#modal").classList.remove("show");
    updOwn();
    updEn();
    syncResetBanner();
  });

  comm.on(S2C.RESET_REQ, (e) => {
    toast((e.detail.by || "對手") + " 提議重開對局");
  });

  comm.on(S2C.ERROR, (e) => {
    toast(e.detail.message || "伺服器錯誤");
    if (e.detail.code === "invalid_fleet") { locked = false; updOwn(); }
    if (e.detail.code === "room_full") {
      setConn("off", "房間已滿");
      addChat("這間房間已經有 2 人對戰中。請改選其他房間（Room1／Room2／Room3）或稍後再進。", "", false, true);
      roomFull = true;
      comm.close(); // 停止自動重連
    }
    if (e.detail.code === "too_many_rooms") {
      setConn("off", "房間數已滿");
      const list = (e.detail.rooms || []).map((r) => r.room).join("、");
      addChat("房間數已達上限（最多 3 個）。目前持有：" + (list || "無") + "。請回到大廳釋出一個房間後再進入。", "", false, true);
      roomFull = true;
      comm.close();
    }
  });

  comm.join({ key: roomKey, name: playerName, userId: browserId() }).catch((e) => {
    if (roomFull) return; // 房間已滿的訊息已經顯示過
    setConn("off", "連線失敗");
    addChat("連線失敗：" + (e && e.message ? e.message : e), "", false, true);
  });
}

function flashSunk(ship) {
  const len = ship.len || LEN[ship.id] || 1;
  cellsOf({ r: ship.r, c: ship.c, d: ship.d }, len).forEach(([r, c]) => {
    const el = enEls[cellKey(r, c)];
    if (el) {
      el.classList.remove("sunkflash");
      void el.offsetWidth;
      el.classList.add("sunkflash");
    }
  });
}

function sessionId() {
  const k = "bs.client.id";
  let v = sessionStorage.getItem(k);
  if (!v) {
    v = "c" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(k, v);
  }
  return v;
}

/* ---------- 其他互動 ---------- */

$("#helpBtn").onclick = () => {
  $("#tut").classList.toggle("open");
};
$("#closeBtn").onclick = () => { $("#tut").classList.remove("open"); };
document.addEventListener("pointerdown", (e) => {
  const t = $("#tut");
  if (!t.classList.contains("open")) return;
  if (!e.target.closest("#tut, #helpBtn")) t.classList.remove("open");
});

$("#leaveBtn").onclick = () => {
  // 房號固定（全系統三間），離開只是回到大廳；座位會自動釋出
  if (!confirm("確定要離開房間嗎？\n離開後座位會釋出，進行中的對局將無法繼續。")) return;
  if (comm) comm.close();
  location.href = "index.html";
};

window.addEventListener("beforeunload", () => { if (comm) comm.close(); });

/* ---------- 聚光燈式介面導覽 ---------- */

const TOUR = [
  { t: "歡迎來到雲端海戰棋", d: "兩個人只要輸入相同的房號就能連線對戰，開火結果由伺服器自動判定，不必自己報數。跟著導覽認識每個區塊，隨時可跳過。" },
  { el: "#roomChip", t: "房號：點一下就能複製", d: "全系統固定三間房（Room1／Room2／Room3）。點房號即可複製，貼給朋友，兩人選同一間就會對戰；每間同時一場（2 人）。" },
  { el: "#own", t: "我的海域", d: "把船艦拖進格子擺放，橫放直放皆可，不可重疊或相鄰（含斜角）。對方的炮擊結果會即時顯示在這裡。" },
  { el: "#picker", t: "船艦區", d: "簡易 5×5 有 4 艘（3、2、2、1 格）；正版 10×10 有 5 艘（5、4、3、3、2 格）。點選後拖到海域擺放，已擺放的會變淡。" },
  { el: "#lockShip", t: "鎖定船艦", d: "四艘全部擺好後按這裡鎖定，鎖定後無法移動；等對手也準備好就會自動開戰。" },
  { el: "#enemy", t: "敵方海域：點擊開火", d: "輪到你就點格子開火，點下去就會自動標記落空、命中或擊沉（不用自己切換標記），並同步給雙方畫面。" },
  { el: "#enemy", t: "圖示怎麼看", d: "看示範：落空、命中、擊沉三種圖示會輪流顯示，結果由系統自動判定並同步。擊沉後周圍一圈自動標為落空（簡易 5×5 適用；正版 10×10 允許緊鄰，不自動標註周圍）。", demo: true },
  { el: "#resetBtn", t: "重開對局", d: "任何階段都能重置戰局：船艦保留，但需重新鎖定。新玩家進房時，殘留的對局也會自動重算。" },
  { el: "#chatFab", t: "右下角通訊", d: "點開氣泡可以和對手傳話；有新訊息時會跳出小提示，點一下就會展開。" },
  { el: "#archBtn", t: "戰績存檔", d: "每局結束會自動存檔。點這裡（或結果視窗的「戰績存檔」）可以查詢歷史對局並回放。" },
  { el: "#helpBtn", t: "教學面板", d: "隨時點這裡查看完整規則，也可以重新播放這個介面導覽。" }
];

let ti = 0;
let tourTut = null;
let scrollT = null;
let demoTimer = null;
let demoStep = 0;
let demoFor = null;
let demoTarget = null;
const DEMO_V = [1, 2, 3, 0];

const demoCell = () => enEls[cellKey(2, 2)];

function stopDemo() {
  clearInterval(demoTimer);
  demoTimer = null;
  const c = demoTarget || demoCell();
  demoTarget = null;
  if (c) c.classList.remove("demo");
}

function startDemo() {
  stopDemo();
  demoStep = 0;
  const c = demoCell();
  if (!c) return;
  demoTarget = c;
  c.classList.add("demo");
  const paint = () => {
    const v = DEMO_V[demoStep % DEMO_V.length];
    c.dataset.v = v;
    const h = CELL_ICON[v] || "";
    c.innerHTML = h;
    c._h = h;
    demoStep++;
  };
  paint();
  demoTimer = setInterval(paint, 900);
}

function tourPos() {
  const st = TOUR[ti];
  const tg = st.el ? document.querySelector(st.el) : null;
  const card = $("#tourCard");
  const spot = $("#tourSpot");

  $("#tourT").textContent = st.t;
  $("#tourD").textContent = st.d;
  $("#tourN").textContent = (ti + 1) + " / " + TOUR.length;
  $("#tourPrev").style.visibility = ti ? "visible" : "hidden";
  $("#tourNext").textContent = ti === TOUR.length - 1 ? "完成" : "下一步";

  if (st.demo) {
    if (demoFor !== ti) { demoFor = ti; startDemo(); }
  } else {
    demoFor = null;
    stopDemo();
  }

  const cw = card.offsetWidth || 280;
  const ch = card.offsetHeight || 170;
  let x, y;

  if (!tg) {
    spot.style.opacity = 0;
    x = innerWidth / 2 - cw / 2;
    y = innerHeight / 2 - ch / 2;
  } else {
    const r = tg.getBoundingClientRect();
    if (r.height < innerHeight - 24 && (r.top < 0 || r.bottom > innerHeight)) {
      spot.style.opacity = 0;
      tg.scrollIntoView({ block: "center", behavior: "smooth" });
      clearTimeout(scrollT);
      scrollT = setTimeout(tourPos, 420);
      return;
    }
    const p = 6;
    spot.style.opacity = 1;
    spot.style.left = r.left - p + "px";
    spot.style.top = r.top - p + "px";
    spot.style.width = r.width + p * 2 + "px";
    spot.style.height = r.height + p * 2 + "px";
    x = Math.max(12, Math.min(innerWidth - cw - 12, r.left + r.width / 2 - cw / 2));
    y = r.bottom + p + 12;
    if (y + ch > innerHeight - 12) y = Math.max(12, r.top - p - 12 - ch);
  }

  card.style.left = x + "px";
  card.style.top = y + "px";
}

function startTour() {
  ti = 0;
  tourTut = $("#tut").classList.contains("open");
  $("#tut").classList.remove("open");
  $("#tour").classList.add("show");
  tourPos();
}

function endTour() {
  clearTimeout(scrollT);
  demoFor = null;
  stopDemo();
  $("#tour").classList.remove("show");
  if (tourTut !== null) {
    $("#tut").classList.toggle("open", tourTut);
    tourTut = null;
  }
  writeLS("bs.tour.seen", "1");
}

$("#tourNext").onclick = () => { ti < TOUR.length - 1 ? (ti++, tourPos()) : endTour(); };
$("#tourPrev").onclick = () => { if (ti) { ti--; tourPos(); } };
$("#tourSkip").onclick = endTour;
$("#replayTour").onclick = (e) => { e.preventDefault(); startTour(); };
window.addEventListener("resize", () => { if ($("#tour").classList.contains("show")) tourPos(); });

/* ---------- 啟動 ---------- */

// 依網址／上次使用的海域模式初始化棋盤，並還原該模式下編輯中的船隊（僅自己可見）
cfg = boardConfig(wantMode);
LEN = cfg.ships;
IDS = shipIdsOf(cfg);
sel = IDS[0];
fleet = loadLocalFleet();
buildPicker();
buildBoards();
updOwn();
updEn();
connect();

// 第一次進入自動播放聚光燈導覽（看過就不再自動出現）
if (!readLS("bs.tour.seen", "")) setTimeout(startTour, 700);
