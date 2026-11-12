/*!
 * 海戰棋 — 戰績存檔頁
 * -----------------------------------------------------------------------------
 *  1. 以「房間金鑰」查詢過往對局（GET /api/archive/:key）
 *  2. 點開單局查看明細（GET /api/archive/:key/:id）
 *  3. 依開火紀錄逐步回放雙方海域
 */
import {
  COLS,
  MARK,
  boardConfig,
  shipIdsOf,
  colsOf,
  cellKey,
  fleetCellMap,
  isShipSunk
} from "./rules.js";

const $ = (s) => document.querySelector(s);

const SVG = {
  back: '<svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#d2707b" stroke-width="2.6" stroke-linecap="round"/></svg>',
  miss: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="none" stroke="#94a3b8" stroke-width="2.2"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 5.6L20 6l-2 5.8L22 14l-5.8.6L15 21l-3-4.2L9 21l-1.2-6.4L2 14l4-2.2L4 6l5.6 1.6z" fill="#fff"/></svg>'
};

const ESC_MAP = { "&": "\u0026amp;", "<": "\u003clt;", ">": "\u003egt;", "\"": "\u0022quot;", "'": "\u0027#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

const params = new URLSearchParams(location.search);
const server = (params.get("server") || readLS("bs.server.url", "") || "").replace(/\/+$/, "");
const api = (p) => server + p;

function readLS(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }

const ruleName = (r) => (r === "keep" ? "命中續打" : r === "alt" ? "輪流交替（舊制）" : "命中續打");
const modeName = (m) => boardConfig(m).label;
const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

let currentRoom = "";
let currentMatch = null;
let step = 0;
let timer = null;

/* ---------- 提示 ---------- */

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- 初始化 ---------- */

$("#backBtn").innerHTML = SVG.back;
$("#dClose").innerHTML = SVG.close;
const FIXED_ROOMS = ["ROOM1", "ROOM2", "ROOM3"];
{
  const want = (params.get("room") || readLS("bs.room.key", "") || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const sel = $("#roomInput");
  sel.value = FIXED_ROOMS.includes(want) ? want : sel.options[0].value;
}

$("#qBtn").onclick = () => loadList();
$("#roomInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadList(); });
$("#dClose").onclick = () => { stop(); $("#detailPanel").hidden = true; $("#detail").innerHTML = ""; };

/* 清空此房間的所有戰績 */
$("#clearBtn").onclick = async () => {
  if (!currentRoom) return;
  if (!confirm(`確定要清空房間 ${currentRoom} 的全部戰績紀錄嗎？\n此動作無法復原。`)) return;
  const btn = $("#clearBtn");
  btn.disabled = true;
  try {
    const res = await fetch(api("/api/archive/" + encodeURIComponent(currentRoom) + "/clear"), { method: "POST" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "HTTP " + res.status);
    toast(`已清空 ${data.removed} 筆紀錄`);
    stop();
    $("#detailPanel").hidden = true;
    $("#detail").innerHTML = "";
    await loadList();
  } catch (e) {
    toast("清空失敗：" + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
  }
};

if ($("#roomInput").value) loadList();

/* ---------- 查詢 ---------- */

async function loadList() {
  const key = $("#roomInput").value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!["ROOM1", "ROOM2", "ROOM3"].includes(key)) {
    toast("房間只有 Room1／Room2／Room3 三間");
    return;
  }
  if (!key) { $("#status").textContent = "請輸入房間金鑰。"; return; }
  currentRoom = key;
  readLS("bs.room.key", key);
  try { localStorage.setItem("bs.room.key", key); } catch (e) {}

  $("#status").textContent = "查詢中…";
  $("#listPanel").hidden = true;
  $("#detailPanel").hidden = true;

  let data;
  try {
    const res = await fetch(api("/api/archive/" + encodeURIComponent(key)));
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    $("#status").textContent = "查詢失敗：" + (e && e.message ? e.message : e);
    return;
  }

  const matches = (data && data.matches) || [];
  $("#status").textContent = matches.length
    ? `房間 ${key} 共找到 ${matches.length} 筆對局紀錄。`
    : `房間 ${key} 目前還沒有對局紀錄（完成一局後就會自動存檔）。`;
  $("#listPanel").hidden = false;
  $("#count").textContent = matches.length + " 局";
  renderList(matches);
}

function renderList(matches) {
  const box = $("#list");
  box.innerHTML = "";
  if (!matches.length) {
    box.innerHTML = '<div class="empty">尚無紀錄</div>';
    return;
  }
  for (const m of matches) {
    const card = document.createElement("div");
    card.className = "mcard";
    const w = m.winner ? m.winner.name : "—";
    const l = m.loser ? m.loser.name : "—";
    const pstats = (m.players || []).map((p) => {
      const st = p.stats || {};
      return `${esc(p.name)} ${st.shots || 0}/${st.hits || 0}${st.rate == null ? "" : " (" + st.rate + "%)"}`;
    }).join("　");
    card.innerHTML =
      `<div class="top"><span class="win">${esc(w)}</span> 勝 <span class="lose">${esc(l)}</span><span class="time">${fmtTime(m.at)}</span></div>` +
      `<div class="meta"><span>${esc(modeName(m.boardMode))}</span><span>${ruleName(m.turnRule)}</span><span>長度 ${fmtDur(m.durationMs)}</span><span>${pstats}</span></div>`;
    card.onclick = () => openMatch(m.id);
    box.appendChild(card);
  }
}

/* ---------- 明細 + 回放 ---------- */

async function openMatch(id) {
  $("#status").textContent = "載入中…";
  let data;
  try {
    const res = await fetch(api("/api/archive/" + encodeURIComponent(currentRoom) + "/" + encodeURIComponent(id)));
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    $("#status").textContent = "載入失敗：" + (e && e.message ? e.message : e);
    return;
  }
  $("#status").textContent = `房間 ${currentRoom} 共找到 ${$("#count").textContent.replace(/\D/g, "") || 0} 筆對局紀錄。`;
  currentMatch = data.match;
  step = 0;
  stop();
  renderDetail(currentMatch);
  $("#detailPanel").hidden = false;
  $("#detailPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDetail(rec) {
  const box = $("#detail");
  box.innerHTML = "";
  $("#dTitle").textContent = "對局明細 · " + (rec.room || currentRoom);

  const kv = document.createElement("div");
  kv.className = "kv";
  kv.innerHTML =
    `<span>時間：${fmtTime(rec.at)}</span><span>海域：${esc(modeName(rec.boardMode))}</span><span>規則：${ruleName(rec.turnRule)}</span>` +
    `<span>長度：${fmtDur(rec.durationMs)}</span><span>開火 ${(rec.shots || []).length} 次</span>`;
  box.appendChild(kv);

  const table = document.createElement("table");
  const rows = (rec.players || []).map((p) => {
    const win = rec.winner && rec.winner.id === p.id;
    const st = p.stats || {};
    return `<tr><td>${esc(p.name)}</td><td class="${win ? "win" : "lose"}">${win ? "勝" : "敗"}</td>` +
      `<td>${st.shots || 0}</td><td>${st.hits || 0}</td><td>${st.rate == null ? "–" : st.rate + "%"}</td></tr>`;
  }).join("");
  table.innerHTML = "<tr><th>玩家</th><th>結果</th><th>出擊</th><th>命中</th><th>命中率</th></tr>" + rows;
  box.appendChild(table);

  const h2 = document.createElement("div");
  h2.className = "head";
  h2.innerHTML = "<h2>回放</h2>";
  box.appendChild(h2);

  const rp = document.createElement("div");
  rp.className = "replay";
  rp.id = "rpBoards";
  box.appendChild(rp);

  const ctrl = document.createElement("div");
  ctrl.className = "ctrl";
  ctrl.innerHTML =
    '<button class="cb" id="rpFirst">⟲</button>' +
    '<button class="cb" id="rpPrev">上一步</button>' +
    '<button class="cb primary" id="rpPlay">播放</button>' +
    '<button class="cb" id="rpNext">下一步</button>' +
    '<span class="step" id="rpStep">0 / 0 步</span>';
  box.appendChild(ctrl);

  const log = document.createElement("div");
  log.className = "shotlog";
  log.id = "rpLog";
  box.appendChild(log);

  $("#rpFirst").onclick = () => { stop(); step = 0; update(); };
  $("#rpPrev").onclick = () => { stop(); step = Math.max(0, step - 1); update(); };
  $("#rpNext").onclick = () => { stop(); step = Math.min(total(), step + 1); update(); };
  $("#rpPlay").onclick = () => (timer ? stop() : play());

  update();
}

function total() {
  return currentMatch ? (currentMatch.shots || []).length : 0;
}

function play() {
  if (!currentMatch) return;
  if (step >= total()) step = 0;
  $("#rpPlay").textContent = "暫停";
  timer = setInterval(() => {
    if (step >= total()) { stop(); return; }
    step++;
    update();
  }, 700);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  const b = $("#rpPlay");
  if (b) b.textContent = "播放";
}

function update() {
  const rec = currentMatch;
  if (!rec) return;
  const boards = $("#rpBoards");
  boards.innerHTML = "";
  for (const p of rec.players || []) {
    const wrap = document.createElement("div");
    wrap.className = "rp";
    const win = rec.winner && rec.winner.id === p.id;
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.innerHTML = `<b>${esc(p.name)}</b>${win ? ' <span class="win">勝</span>' : ""}`;
    wrap.appendChild(cap);
    wrap.appendChild(buildBoard(p, rec, step));
    boards.appendChild(wrap);
  }

  $("#rpStep").textContent = `${step} / ${total()} 步`;

  const log = $("#rpLog");
  log.innerHTML = "";
  const nameOf = (id) => {
    const p = (rec.players || []).find((x) => x.id === id);
    return p ? p.name : "？";
  };
  (rec.shots || []).forEach((sh, i) => {
    const line = document.createElement("div");
    line.className = "s" + (i < step ? (sh.result >= MARK.HIT ? " hit" : " miss") : "");
    const [r, c] = sh.cell.split(",").map(Number);
    const label = (COLS[c] || "?") + (r + 1);
    line.innerHTML = `<b>${esc(nameOf(sh.by))}</b><span>${label} → ${sh.result >= MARK.HIT ? "命中" : "落空"}</span>`;
    log.appendChild(line);
  });
  const cur = log.children[step - 1];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

/** 產生某位玩家的海域（含前 step 次的Incoming 炮擊）；海域大小依該局紀錄的模式 */
function buildBoard(p, rec, step) {
  const cfg = boardConfig(rec.boardMode);
  const grid = document.createElement("div");
  grid.className = "hboard";
  grid.style.gridTemplateColumns = `16px repeat(${cfg.n}, minmax(0, 1fr))`;
  if (cfg.n > 5) grid.style.width = "340px";
  grid.appendChild(document.createElement("div"));
  for (const c of colsOf(cfg)) {
    const e = document.createElement("div");
    e.className = "co";
    e.textContent = c;
    grid.appendChild(e);
  }

  const fleetMap = fleetCellMap(p.fleet || {}, cfg);
  const fired = {};
  (rec.shots || []).slice(0, step).forEach((sh) => {
    if (sh.by === p.id) return;
    const ship = fleetMap[sh.cell];
    fired[sh.cell] = ship ? MARK.HIT : MARK.MISS;
  });

  const sunk = new Set();
  for (const id of shipIdsOf(cfg)) {
    if (!p.fleet || !p.fleet[id]) continue;
    if (!isShipSunk(p.fleet, id, fired, cfg)) continue;
    const pos = p.fleet[id];
    const len = cfg.ships[id] || 1;
    for (let i = 0; i < len; i++) {
      sunk.add(cellKey(pos.d === "V" ? pos.r + i : pos.r, pos.d === "H" ? pos.c + i : pos.c));
    }
  }

  for (let r = 0; r < cfg.n; r++) {
    const lab = document.createElement("div");
    lab.className = "co";
    lab.textContent = r + 1;
    grid.appendChild(lab);
    for (let c = 0; c < cfg.n; c++) {
      const k = cellKey(r, c);
      const d = document.createElement("div");
      d.className = "hc";
      if (fleetMap[k]) d.classList.add("ship");
      if (sunk.has(k)) {
        d.classList.add("sunk");
        d.innerHTML = SVG.star;
      } else if (fired[k] === MARK.HIT) {
        d.classList.add("hit");
        d.innerHTML = SVG.x;
      } else if (fired[k] === MARK.MISS) {
        d.classList.add("miss");
        d.innerHTML = SVG.miss;
      }
      grid.appendChild(d);
    }
  }
  return grid;
}
