/*!
 * 戰況模擬器 — 讓 N 間房同時各自完成完整對戰（每房 2 位 agent，共 2N 個連線）。
 *
 * 用法：
 *   node scripts/sim-battles.mjs <base> [rooms=ROOM1,ROOM2,ROOM3] [rounds=1] [prefix=Agent]
 *
 * 例：
 *   node scripts/sim-battles.mjs http://127.0.0.1:8787
 *   node scripts/sim-battles.mjs https://battleship-online.jimmy910824.workers.dev
 *   node scripts/sim-battles.mjs http://127.0.0.1:8787 ROOM2 101 Stress   # 戰績 100 筆上限壓力測試
 *
 * 每個 agent 用 BattleComm（正式前端同一套通訊模組）連線：
 *   hello → ready(佈陣) → 依 canFire 輪流開火 → phase=over 記錄勝負 →（多局時）rematch 續打。
 * 結束後查 /api/archive/:key 驗證存檔筆數與玩家名稱。
 */
import { BattleComm } from "../public/js/comm.mjs";

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const rooms = (process.argv[3] || "ROOM1,ROOM2,ROOM3").split(",").map((s) => s.trim()).filter(Boolean);
const rounds = Math.max(1, Number(process.argv[4] || 1));
const prefix = process.argv[5] || "Agent";

/* 佈陣（合法：不重疊、不相鄰含斜角）：
 *   3 格橫放 (0,0)-(0,2)、2 格橫放 (2,0)-(2,1)、2 格橫放 (4,0)-(4,1)、1 格 (0,4) */
const FLEET = {
  "3":  { r: 0, c: 0, d: "H" },
  "2a": { r: 2, c: 0, d: "H" },
  "2b": { r: 4, c: 0, d: "H" },
  "1":  { r: 0, c: 4, d: "V" }
};

const ALL_CELLS = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) ALL_CELLS.push(r + "," + c);

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

class Agent {
  constructor(room, name) {
    this.room = room;
    this.name = name.slice(0, 16); // 伺服器暱稱上限 16 字
    this.you = null;
    this.st = null;
    this.wins = 0;
    this.comm = new BattleComm({
      url: base,
      key: room,
      name,
      clientId: "sim-" + Math.random().toString(36).slice(2, 10),
      userId: "sim-user-" + name,
      autoReconnect: false,
      debug: false
    });
    this.comm.on("message", (e) => this.onMsg(e.detail));
  }

  onMsg(m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "welcome") this.you = m.you;
    if (m.t === "state") { this.st = m; this.act(); }
  }

  /** 輪到自己就挑一個還沒打過的格子開火 */
  act() {
    const st = this.st;
    if (!st || st.phase !== "battle" || !st.canFire) return;
    const board = (st.enemy && st.enemy.board) || {};
    const next = ALL_CELLS.find((c) => board[c] === undefined);
    if (next) this.comm.fire(next);
  }

  shots() {
    return (this.st && this.st.mine && this.st.mine.stats && this.st.mine.stats.shots) || 0;
  }
}

function waitCond(fn, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      let v;
      try { v = fn(); } catch (e) { clearInterval(timer); reject(e); return; }
      if (v) { clearInterval(timer); resolve(v); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error("等待超時：" + what)); }
    }, 80);
  });
}

/** 兩位 agent 打一整局，回傳 { winnerName, loserName, id, at } */
async function playOne(a, b) {
  const st = await waitCond(() => {
    const s = a.st || b.st;
    return s && s.phase === "over" ? s.over : null;
  }, 120000, "本局結束（phase=over）");
  const aWon = st.winner === a.you;
  return {
    id: String(st.at),
    winner: aWon ? a.name : b.name,
    loser: aWon ? b.name : a.name,
    shotsA: a.shots(),
    shotsB: b.shots()
  };
}

async function waitPhase(a, b, phase) {
  await waitCond(() => ((a.st && a.st.phase) === phase || (b.st && b.st.phase) === phase), 30000, "phase=" + phase);
}

/** 一間房：兩位 agent 打 rounds 局 */
async function playPair(room) {
  const a = new Agent(room, prefix + "-" + room + "-A");
  const b = new Agent(room, prefix + "-" + room + "-B");
  await Promise.all([a.comm.join({ key: room }), b.comm.join({ key: room })]);

  // 房間若殘留上一場的結束狀態，先 rematch 重置再開打
  await waitCond(() => a.st, 15000, "初始 state");
  if ((a.st.phase || "") === "over") {
    a.comm.rematch(true);
    b.comm.rematch(true);
    await waitPhase(a, b, "battle").catch(() => {});
  }

  const results = [];
  for (let i = 0; i < rounds; i++) {
    if (i === 0) {
      a.comm.ready(FLEET);
      b.comm.ready(FLEET);
    }
    const r = await playOne(a, b);
    if (r.winner === a.name) a.wins++; else b.wins++;
    results.push(r);
    if (i < rounds - 1) {
      a.comm.rematch(true);
      b.comm.rematch(true);
      await waitPhase(a, b, "battle");
    }
  }

  a.comm.close();
  b.comm.close();
  return { room, results, winsA: a.wins, winsB: b.wins };
}

async function archiveOf(room) {
  const res = await fetch(base + "/api/archive/" + room, { cache: "no-store" });
  if (!res.ok) throw new Error("archive HTTP " + res.status + "（" + room + "）");
  return res.json();
}

/* ---------- 主流程 ---------- */

const t0 = Date.now();
let failed = false;

// 0) 固定房間制：非固定房號應被拒絕
try {
  const bad = await fetch(base + "/api/room/BS-3F9K2A", { cache: "no-store" });
  console.log("[gate] /api/room/BS-3F9K2A → HTTP", bad.status, bad.status === 404 ? "（正確拒絕）" : "（!! 應為 404）");
  if (bad.status !== 404) failed = true;
} catch (e) {
  console.log("[gate] 檢查失敗:", e.message); failed = true;
}

// 1) 各房同時開打
const pairResults = await Promise.all(rooms.map((room) =>
  playPair(room).then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, room, error: e.message })
  )
));

for (const pr of pairResults) {
  if (!pr.ok) {
    failed = true;
    console.log("[FAIL]", pr.room, "→", pr.error);
    continue;
  }
  const { room, results } = pr.r;
  const last = results[results.length - 1];
  console.log("[game]", room, "×" + results.length + " 局 | 最後一局勝者:", last.winner, "（輸家:", last.loser + "）",
    "| 出擊數 A/B:", last.shotsA + "/" + last.shotsB);
}

// 2) 戰績存檔驗證：每間房都應有紀錄，且最新一筆含玩家名稱
for (const pr of pairResults) {
  if (!pr.ok) continue;
  const room = pr.r.room;
  const last = pr.r.results[pr.r.results.length - 1];
  try {
    const data = await archiveOf(room);
    const matches = data.matches || [];
    const top = matches[0] || null;
    const names = top ? (top.players || []).map((p) => p.name).join("/") : "";
    const okCount = matches.length >= Math.min(pr.r.results.length, 100);
    const okNames = top && names.includes(prefix + "-" + room + "-A") && names.includes(prefix + "-" + room + "-B");
    console.log("[archive]", room, "→", matches.length + " 筆 | 最新一局玩家:", names || "（無）",
      "| 存檔:", okCount && okNames ? "OK" : "FAIL");
    if (!okCount || !okNames) failed = true;
  } catch (e) {
    console.log("[archive]", room, "→ 查詢失敗:", e.message); failed = true;
  }
}

// 3) 多局壓力（rounds > 1）時驗證 100 筆上限與最舊刪除
if (rounds > 1) {
  for (const pr of pairResults) {
    if (!pr.ok) continue;
    const room = pr.r.room;
    const ids = pr.r.results.map((r) => r.id);
    const data = await archiveOf(room);
    const matches = data.matches || [];
    const have = new Set(matches.map((m) => m.id));
    const oldestKept = have.has(ids[0]);
    const newestKept = have.has(ids[ids.length - 1]);
    console.log("[cap]", room, "→", matches.length + " 筆（上限 100）| 最舊一筆仍在清單:", oldestKept,
      "| 最新一筆在清單:", newestKept);
    if (matches.length > 100 || matches.length < Math.min(rounds, 100)) failed = true;
    if (rounds >= 100 && oldestKept) failed = true;  // 滿 100 局後最舊的必須被刪
    if (!newestKept) failed = true;
  }
}

console.log("[done]", failed ? "有失敗項目" : "全部通過", "| 耗時", ((Date.now() - t0) / 1000).toFixed(1) + "s");
process.exit(failed ? 1 : 0);
