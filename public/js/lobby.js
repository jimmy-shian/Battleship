/*!
 * 海戰棋 — 大廳（登入主頁）邏輯
 * 負責：伺服器設定、固定房間選擇（Room1／Room2／Room3）、房間狀態預覽、進入房間。
 */
import { BattleComm, normalizeRoomKey } from "./comm.mjs";
import { boardConfig } from "./rules.js";
import { enhanceSelect } from "./select.js";

const $ = (s) => document.querySelector(s);
const LS = {
  key: "bs.room.key",
  name: "bs.room.name",
  server: "bs.server.url",
  mode: "bs.room.mode"
};

const ICON = {
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  min: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>'
};

/* ---------- 工具 ---------- */

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function readLS(k, def) {
  try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; }
}
function writeLS(k, v) {
  try { localStorage.setItem(k, v); } catch (e) {}
}

/** 目前設定的伺服器 base url（空字串 = 同網域） */
function serverBase() {
  return readLS(LS.server, "").trim();
}

/** 伺服器 API base（http/https），供房間狀態查詢 */
function serverApiBase() {
  const s = serverBase();
  if (!s) return location.origin;
  if (/^wss?:\/\//i.test(s)) return s.replace(/^ws/i, "http");
  return s.replace(/\/+$/, "");
}

/* ---------- 初始化 ---------- */

const params = new URLSearchParams(location.search);
$("#helpBtn").innerHTML = ICON.help;
$("#closeHelp").innerHTML = ICON.close;
$("#advToggle").innerHTML = ICON.min;

$("#serverInput").value = serverBase();
$("#modeInput").value = boardConfig(readLS(LS.mode, "s5")).id;
enhanceSelect($("#modeInput"), { block: true });
const keyCtl = enhanceSelect($("#keySel"), { block: true });
$("#nameInput").value = params.get("name") || readLS(LS.name, "") || "";

if (params.get("server")) {
  $("#serverInput").value = params.get("server");
  writeLS(LS.server, params.get("server"));
}
if (!location.protocol.startsWith("http")) {
  $("#statusLine").textContent = "目前以檔案方式開啟，無法連線。請改用 npm run dev 或部署後的網址開啟。";
  $("#statusLine").className = "hint err";
}

/* ---------- 展開/收合 ---------- */

$("#advPanel").addEventListener("click", (e) => {
  if (e.target.closest("input")) return;
  toggleAdv();
});
function toggleAdv() {
  const p = $("#advPanel");
  const open = p.classList.toggle("open");
  $("#advBody").hidden = !open;
}

$("#helpBtn").onclick = () => { $("#help").classList.toggle("open"); };
$("#closeHelp").onclick = () => { $("#help").classList.remove("open"); };
document.addEventListener("pointerdown", (e) => {
  if (!$("#help").classList.contains("open")) return;
  if (!e.target.closest("#help, #helpBtn")) $("#help").classList.remove("open");
});

/* ---------- 房間（全系統固定三間：Room1／Room2／Room3） ---------- */

$("#keySel").addEventListener("change", () => {
  writeLS(LS.key, $("#keySel").value);
  checkRoom();
});

/** 目前選擇的房間 */
function currentKey() {
  return normalizeRoomKey($("#keySel").value);
}

// 預設選擇：網址帶的房間（邀請連結）> 上次使用 > Room1
{
  const urlKey = normalizeRoomKey(params.get("key") || "");
  const lsKey = normalizeRoomKey(readLS(LS.key, ""));
  const sel = $("#keySel");
  const pick = urlKey || lsKey || sel.options[0] && sel.options[0].value || "ROOM1";
  if ([...sel.options].some((o) => o.value === pick)) {
    sel.value = pick;
    keyCtl.refresh();
  }
}

/* ---------- 伺服器設定 ---------- */

$("#serverInput").addEventListener("change", () => {
  writeLS(LS.server, $("#serverInput").value.trim());
  checkServer();
  checkRoom();
});

/* ---------- 伺服器連線檢查 ---------- */

async function checkServer() {
  const line = $("#statusLine");
  line.className = "hint busy";
  line.textContent = "正在確認伺服器…";
  try {
    const base = serverApiBase();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(base.replace(/\/+$/, "") + "/api/health", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    line.className = "hint ok";
    line.textContent = "伺服器連線正常。";
  } catch (e) {
    line.className = "hint err";
    line.textContent = "無法連線到伺服器：" + (e && e.message ? e.message : e) +
      "。請確認網址，或執行 npm run dev 後使用 http://127.0.0.1:8787。";
  }
}

/* ---------- 房間狀態預覽 ---------- */

let roomTimer = null;
async function checkRoom() {
  clearTimeout(roomTimer);
  const key = currentKey();
  const panel = $("#roomPanel");
  if (!key) {
    panel.hidden = true;
    return;
  }
  try {
    const base = serverApiBase().replace(/\/+$/, "");
    const res = await fetch(base + "/api/room/" + encodeURIComponent(key), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    panel.hidden = false;
    renderRoom(data);
  } catch (e) {
    panel.hidden = true;
  }
}

function renderRoom(data) {
  const box = $("#roomInfo");
  box.innerHTML = "";
  if (!data.players || !data.players.length) {
    box.innerHTML = '<p class="hint" style="margin:0">這間房間目前沒有人，進去等對手吧。</p>';
    return;
  }
  data.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "rp";
    row.innerHTML =
      '<span class="dot ' + (p.online ? "on" : "off") + '"></span>' +
      '<span class="seat"></span>' +
      '<span class="tag ' + (p.ready ? "ready" : "") + '">' + (p.ready ? "已佈陣" : "佈陣中") + (p.online ? "" : " · 離線") + "</span>";
    row.querySelector(".seat").textContent = p.name;
    box.appendChild(row);
  });
  const phaseText = { setup: "佈陣階段", battle: "戰鬥中", over: "本局結束" }[data.phase] || data.phase;
  const modeText = boardConfig(data.boardMode).label;
  const info = document.createElement("p");
  info.className = "hint";
  info.style.margin = "8px 0 0";
  info.textContent = "房間狀態：" + phaseText + "（" + data.players.length + "/2 人）｜海域：" + modeText;
  box.appendChild(info);
}

/* ---------- 進入房間 ---------- */

$("#enterBtn").onclick = async () => {
  const key = currentKey();
  const name = ($("#nameInput").value || "").trim() || "玩家" + Math.floor(Math.random() * 90 + 10);

  if (!key) {
    toast("請先選擇房間（Room1／Room2／Room3）");
    return;
  }

  writeLS(LS.key, key);
  writeLS(LS.name, name);
  writeLS(LS.mode, $("#modeInput").value);
  writeLS(LS.server, $("#serverInput").value.trim());

  goRoom(key, name);
};

function goRoom(key, name) {
  // 網址不帶暱稱（避免個人資訊外流），暱稱只存在自己的瀏覽器
  const q = new URLSearchParams({ key });
  if ($("#serverInput").value.trim()) q.set("server", $("#serverInput").value.trim());
  q.set("mode", $("#modeInput").value);
  location.href = "board.html?" + q.toString();
}

/* ---------- 複製 ---------- */

$("#copyKey").onclick = async () => {
  const key = currentKey();
  if (!key) { toast("請先選擇房間"); return; }
  writeLS(LS.key, key);
  await copy(key, "已複製房間金鑰 " + key);
  checkRoom();
};

$("#copyLink").onclick = async () => {
  const key = currentKey();
  if (!key) { toast("請先選擇房間"); return; }
  writeLS(LS.key, key);
  const link = location.origin + location.pathname.replace(/[^/]*$/, "") + "board.html?key=" + encodeURIComponent(key);
  await copy(link, "已複製邀請連結（" + key + "）");
  checkRoom();
};

async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast(okMsg); }
    catch (e2) { toast("複製失敗，請手動選取"); }
    ta.remove();
  }
}

/* ---------- 啟動 ---------- */

checkServer();
checkRoom();
setInterval(() => { if (!$("#roomPanel").hidden) checkRoom(); }, 8000);

// 讓 BattleComm 也可直接在主控台引用驗證
window.BattleComm = BattleComm;
