/*!
 * 實戰全流程測試（線上正式環境）
 * -----------------------------------------------------------------------------
 * 用正式 BattleComm 協定扮演真實玩家，在固定房間完整對戰：
 *
 *   局 1（簡易 5×5）
 *     1. P1 進房佈陣鎖定 → P2 進房佈陣鎖定 → 開戰 → 打完整局（over）
 *     2. 再戰一局（rematch，保留船隊直接開戰，先手輪替）
 *     3. 中途離開 → 15 秒寬限內「重新進局」（同 clientId 認回座位、戰況保留）→ 打完
 *     4. 使用者重啟局（reset）→ 重新佈陣（換一組船位再鎖定）→ 開戰
 *     5. 中途離開不回來 → 寬限內新玩家 P3「接管座位」（座位重置、對局重算）→ 打完
 *
 *   局 2（正版 10×10）
 *     6. reset → 切換海域模式 c10（雙方船隊作廢）→ 各自重新佈陣（官方 5/4/3/3/2）
 *     7. 10×10 規格驗證（100 格、無效座標、重複開火）→ 打完整局
 *     8. 雙方離開 → 房間淨空
 *
 *   每完成一局驗證戰績存檔（boardMode / 統計 / 船隊），結束後清掉測試戰績。
 *
 * 用法：node scripts/test-full-games.mjs https://battleship-online.jimmy910824.workers.dev [ROOM2]
 */
import { BattleComm } from "../public/js/comm.mjs";
import { boardConfig, MARK, NEIGHBORS8 } from "../public/js/rules.js";

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ROOM = (process.argv[3] || "ROOM2").toUpperCase();
const api = (p) => base + p;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.error("  ✗ " + msg); } };
const step = (msg) => console.log("\n── " + msg);

async function waitCond(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch (e) {}
    await sleep(150);
  }
  throw new Error("等待逾時：" + what);
}
const roomState = async () => (await fetch(api("/api/room/" + ROOM), { cache: "no-store" })).json();
const archive = async () => (await fetch(api("/api/archive/" + ROOM), { cache: "no-store" })).json();

/* ---------- 船隊 ---------- */
const FLEET_S5_A = { "3": { r: 0, c: 0, d: "H" }, "2a": { r: 2, c: 0, d: "H" }, "2b": { r: 4, c: 0, d: "H" }, "1": { r: 0, c: 4, d: "V" } };
const FLEET_S5_B = { "3": { r: 0, c: 0, d: "V" }, "2a": { r: 0, c: 2, d: "H" }, "2b": { r: 2, c: 2, d: "H" }, "1": { r: 4, c: 4, d: "V" } };
const FLEET_C10  = { "5": { r: 0, c: 0, d: "H" }, "4": { r: 2, c: 0, d: "H" }, "3a": { r: 4, c: 0, d: "H" }, "3b": { r: 6, c: 0, d: "H" }, "2": { r: 8, c: 0, d: "H" } };

/* ---------- 玩家 ---------- */
function attach(a) {
  a.comm.on("message", (e) => {
    const m = e.detail;
    if (m.t === "welcome") { a.you = m.you; a.rules = m.rules; }
    if (m.t === "state") {
      a.st = m;
      a.awaiting = false; // 已收到最新戰況，可再開火
      if (a.pendingKeep) { // 命中續打驗證：自己命中後，下一份 state 應仍是自己的回合
        if (m.phase === "battle") ok(m.canFire === true, "命中續打：命中後仍是自己的回合（" + a.name + "）");
        a.pendingKeep = false;
      }
      if (a.pendingSwap) { // 落空換人驗證
        if (m.phase === "battle") ok(m.canFire === false, "落空後換人（" + a.name + "）");
        a.pendingSwap = false;
      }
    }
    if (m.t === "fire") {
      a.fires++; a.firesAll.push({ by: m.by, result: m.result });
      a.awaiting = false;
      if (m.sunk) a.sunkNames.push(m.sunk.id);
      if (m.by === a.you && m.result >= MARK.HIT) a.pendingKeep = true;
      if (m.by === a.you && m.result === MARK.MISS) a.pendingSwap = true;
    }
    if (m.t === "reset") { a.resets++; a.awaiting = false; }
    if (m.t === "player") a.playerEvents.push(m.event + ":" + m.player.name + "#" + m.player.id.slice(0, 4));
    if (m.t === "error") { a.errors.push(m.message); a.awaiting = false; }
  });
}

function agent(name, clientId) {
  const a = { name, clientId, comm: null, you: null, rules: null, st: null,
    fires: 0, firesAll: [], sunkNames: [], resets: 0, playerEvents: [], errors: [],
    pendingKeep: false, pendingSwap: false, awaiting: false };
  a.comm = new BattleComm({
    url: base, key: ROOM, name, clientId, userId: "qa-" + clientId,
    boardMode: null, autoReconnect: false, debug: false
  });
  attach(a);
  return a;
}

const join = async (a, boardMode) => {
  a.comm = new BattleComm({
    url: base, key: ROOM, name: a.name, clientId: a.clientId, userId: "qa-" + a.clientId,
    boardMode: boardMode || null, autoReconnect: false, debug: false
  });
  attach(a);
  await a.comm.join({ key: ROOM, name: a.name, userId: "qa-" + a.clientId });
  await waitCond(() => a.st, 8000, a.name + " 收到 state");
  return a;
};

/* ---------- 開火策略：獵殺（命中格鄰居優先）＋ 棋盤間隔搜尋 ---------- */
function chooseCell(st) {
  const n = boardConfig(st.boardMode).n;
  const board = (st.enemy && st.enemy.board) || {};
  const unknown = [], hits = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const k = r + "," + c;
    if (board[k] === undefined) unknown.push([r, c]);
    else if (board[k] === MARK.HIT) hits.push([r, c]);
  }
  if (!unknown.length) return null;
  const around = [];
  for (const [r, c] of hits) for (const [a, b] of NEIGHBORS8) {
    const nr = r + a, nc = c + b;
    if (nr >= 0 && nr < n && nc >= 0 && nc < n && board[nr + "," + nc] === undefined) around.push([nr, nc]);
  }
  const pool = around.length ? around : unknown.filter(([r, c]) => (r + c) % 2 === 0).length ? unknown.filter(([r, c]) => (r + c) % 2 === 0) : unknown;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 輪到誰就開火，直到 phase=over；若對局被重算（setup）回傳 notCompleted */
async function playToEnd(agents, timeoutMs, label) {
  const t0 = Date.now();
  let shots = 0;
  while (Date.now() - t0 < timeoutMs) {
    const ref = agents.find((a) => a.st);
    if (!ref) { await sleep(200); continue; }
    if (ref.st.phase === "over") { console.log(`    （${label} 完結，共 ${shots} 次開火）`); return { completed: true, shots }; }
    if (ref.st.phase === "setup") return { completed: false, shots };
    for (const a of agents) {
      if (a.st && a.st.phase === "battle" && a.st.canFire && !a.awaiting) {
        const cell = chooseCell(a.st);
        if (cell) { a.comm.fire(cell[0] + "," + cell[1]); a.awaiting = true; shots++; await sleep(140); }
      }
    }
    await sleep(60);
  }
  throw new Error("playToEnd 逾時：" + label);
}

/** 打到條件成立為止（用於在中途停手做離開測試） */
async function playUntil(agents, cond, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ref = agents.find((a) => a.st);
    if (ref && ref.st.phase !== "battle") throw new Error("playUntil：對局已離開 battle（" + label + "）");
    if (cond()) return;
    for (const a of agents) {
      if (a.st && a.st.phase === "battle" && a.st.canFire && !a.awaiting) {
        const cell = chooseCell(a.st);
        if (cell) { a.comm.fire(cell[0] + "," + cell[1]); a.awaiting = true; await sleep(140); }
      }
    }
    await sleep(60);
  }
  throw new Error("playUntil 逾時：" + label);
}

const fleetCount = (f) => (f ? Object.keys(f).length : 0);
const stByName = (a, name) => (a.st.players || []).find((p) => p.name === name);

/* ==================== 開始 ==================== */

console.log(`測試環境：${base}（房間 ${ROOM}）`);

step("前置：清空測試戰績、等房間淨空（前次測試殘留的離線座位會自動釋出）");
const preArc = await archive();
if (preArc.count > 0) {
  const c = await (await fetch(api("/api/archive/" + ROOM + "/clear"), { method: "POST" })).json();
  console.log(`    預先清除 ${c.removed} 筆舊測試戰績`);
}
await waitCond(async () => (await roomState()).players.length === 0, 30000, "房間淨空");
ok((await roomState()).players.length === 0, "房間目前沒有玩家");

/* ---------------- 局 1：簡易 5×5 ---------------- */
step("局 1（簡易 5×5）① P1 進房、佈陣、鎖定");
const P1 = agent("甲", "qa-p1-" + Date.now().toString(36));
await join(P1, "s5");
ok(P1.st.boardMode === "s5", "P1 進房，海域 = 簡易 5×5");
ok(P1.rules && P1.rules.shipLen && Object.keys(P1.rules.shipLen).length === 4, "welcome 船隊定義 = 4 艘（s5）");
P1.comm.ready(FLEET_S5_A);
await waitCond(() => P1.st.mine && P1.st.mine.ready, 5000, "P1 鎖定");
ok(P1.st.mine.ready === true, "P1 已鎖定佈陣");

step("局 1 ② P2 進房、佈陣 → 自動開戰");
const P2 = agent("乙", "qa-p2-" + Date.now().toString(36));
await join(P2);
ok(P2.you !== P1.you, "P2 取得不同座位");
P2.comm.ready(FLEET_S5_A);
await waitCond(() => P1.st.phase === "battle", 5000, "開戰");
ok(P1.st.phase === "battle" && P2.st.phase === "battle", "雙方就緒，進入戰鬥");
ok(P1.st.canFire === true, "先手 = P1（seat 0）");

step("局 1 ③ 完整打完第一場（命中續打實測）");
const r1 = await playToEnd([P1, P2], 120000, "局1-第1場");
ok(r1.completed && P1.st.phase === "over", "第一場完整打完（phase=over）");
ok(!!P1.st.over && !!P1.st.over.winner, "伺服器判定勝負");
const wName1 = (P1.st.players.find((p) => p.id === P1.st.over.winner) || {}).name;
const wStats1 = P1.st.over.winner === P1.you ? P1.st.mine.stats : P1.st.enemy.stats;
const lStats1 = P1.st.over.winner === P1.you ? P1.st.enemy.stats : P1.st.mine.stats;
console.log(`    勝者：${wName1}｜出擊 ${wStats1.shots}/${lStats1.shots}（勝方 ≥ 敗方，符合命中續打）`);
ok(wStats1.shots >= lStats1.shots, "勝方出擊數 ≥ 敗方（命中續打生效）");
ok(P1.sunkNames.length >= 4 && P1.sunkNames.length === P2.sunkNames.length, `擊沉事件雙方同步（共 ${P1.sunkNames.length} 次，含敗方戰果）`);
let arc = await archive();
ok(arc.count === 1 && arc.matches[0].boardMode === "s5", "戰績存檔 ×1（boardMode=s5）");

step("局 1 ④ 再戰一局（rematch：保留船隊、直接開戰、先手輪替）");
P1.comm.rematch(true);
await waitCond(() => P1.st.phase === "battle", 5000, "rematch 直接開戰");
ok(P1.st.phase === "battle", "再戰直接進入戰鬥（免重新佈陣）");
ok(P1.st.turn === P2.you, "先手輪替：本場由 P2 先攻");

step("局 1 ⑤ 打幾手 → P2 中途離開（關分頁）");
{
  const start = P1.fires + P2.fires;
  await playUntil([P1, P2], () => P1.fires + P2.fires >= start + 3, 60000, "打 3 手");
}
ok(P2.firesAll.filter((f) => f.by === P2.you).length >= 1, "P2 至少開過一炮（可供戰況保留驗證）");
const knownCell = Object.keys(P2.st.enemy.board || {})[0];
const knownVal = P2.st.enemy.board[knownCell];
P2.comm.close();
await waitCond(() => (P1.st.players || []).some((p) => p.id !== P1.you && !p.online), 8000, "P1 看到 P2 離線");
ok((P1.st.players || []).some((p) => !p.online), "P2 標記離線（寬限期內座位保留）");

step("局 1 ⑥ P2 於寬限期內重新進局（同 clientId 認回座位）");
await sleep(2000);
await join(P2);
ok(P2.st.phase === "battle", "重新進局後戰局還在（battle）");
ok(P2.st.enemy.board[knownCell] === knownVal, `開火紀錄完整保留（${knownCell} 標記仍在）`);
ok(stByName(P2, "乙") && stByName(P2, "乙").online === true, "座位恢復上線");

step("局 1 ⑦ 續打至結束");
const r2 = await playToEnd([P1, P2], 120000, "局1-第2場");
ok(r2.completed && P1.st.phase === "over", "第二場完整打完（含中途離開＋重進）");
arc = await archive();
ok(arc.count === 2, "戰績累計 2 筆");

step("局 1 ⑧ 使用者重啟局（reset：需雙方同意、船艦保留、需重新鎖定）");
P1.comm.send("reset"); // P1 提議
await sleep(700);
ok(P1.st.phase === "battle", "僅一方提議：對局仍在進行（未重算）");
P2.comm.send("reset"); // P2 同意
await waitCond(() => P1.st.phase === "setup", 5000, "reset 回佈陣");
await waitCond(() => P2.st.phase === "setup", 5000, "P2 同步到 reset");
ok(P1.st.phase === "setup" && P2.st.phase === "setup", "雙方都回到佈陣階段");
ok(P1.resets > 0 && P2.resets > 0, "雙方都收到 reset 廣播");
ok(P1.st.mine.ready === false && P2.st.mine.ready === false, "鎖定狀態已清除（需重新鎖定）");
ok(fleetCount(P1.st.mine.fleet) === 4, "P1 船艦保留（4 艘還在，可調整後重鎖）");

step("局 1 ⑨ 重新佈陣（P2 換一組全新船位）");
P2.comm.ready(FLEET_S5_B);
await waitCond(() => P2.st.mine.ready, 5000, "P2 重新鎖定");
const f2 = P2.st.mine.fleet;
ok(JSON.stringify(f2) === JSON.stringify(FLEET_S5_B), "P2 新佈陣已生效（與舊佈局不同）");
P1.comm.ready(FLEET_S5_A);
await waitCond(() => P1.st.phase === "battle", 5000, "重新開戰");
ok(P1.st.phase === "battle", "重新佈陣後開戰");

step("局 1 ⑩ 打幾手 → P2 中途離開「不回來」→ 新玩家 P3 接管座位");
{
  const start = P1.fires + P2.fires;
  await playUntil([P1, P2], () => P1.fires + P2.fires >= start + 3, 60000, "再打 3 手");
}
const p2You = P2.you;
P2.comm.close(); // 永久離開
await sleep(2500);
const P3 = agent("丙", "qa-p3-" + Date.now().toString(36));
await join(P3);
await waitCond(() => P1.st.phase === "setup", 5000, "P1 同步到對局重算");
ok(P3.you === p2You, "P3 接管 P2 的座位（同一座位 ID）");
ok(P3.st.mine.fleet && fleetCount(P3.st.mine.fleet) === 0, "接管的是空座位（不繼承船隊，可重新放船）");
ok(P3.st.phase === "setup", "殘留對局已重算 → 回佈陣階段");
ok(P1.st.phase === "setup" && P1.resets > 1, "P1 同步收到對局重算");
ok(P1.playerEvents.some((e) => e.startsWith("takeover:丙")), "P1 收到 takeover 事件");

step("局 1 ⑪ P3 佈陣 → 開戰 → 打完第三場");
P1.comm.ready(FLEET_S5_A); // P1 重新鎖定
P3.comm.ready(FLEET_S5_A);
await waitCond(() => P1.st.phase === "battle", 5000, "重新開戰");
ok(P1.st.phase === "battle", "P1 vs P3 開戰");
const r3 = await playToEnd([P1, P3], 120000, "局1-第3場");
ok(r3.completed && P1.st.phase === "over", "第三場完整打完（新玩家接手完成對局）");
arc = await archive();
ok(arc.count === 3, "戰績累計 3 筆");

/* ---------------- 局 2：正版 10×10 ---------------- */
step("局 2（正版 10×10）① reset 後切換海域模式");
P1.comm.send("reset"); // P1 提議
await sleep(700);
P3.comm.send("reset"); // P3 同意
await waitCond(() => P1.st.phase === "setup", 5000, "reset");
P1.comm.setBoardMode("c10");
await waitCond(() => P1.st.boardMode === "c10" && P3.st.boardMode === "c10", 5000, "雙方切換到 10×10");
ok(P1.st.boardMode === "c10" && P3.st.boardMode === "c10", "雙方海域同步切換為正版 10×10");
ok(fleetCount(P1.st.mine.fleet) === 0 && fleetCount(P3.st.mine.fleet) === 0, "切換模式後雙方船隊作廢（重新佈陣）");
ok(P1.st.mine.ready === false && P3.st.mine.ready === false, "鎖定狀態清除");
const sunkP1_0 = P1.sunkNames.length, sunkP3_0 = P3.sunkNames.length; // 場次起點（計數器跨場累計）

step("局 2 ② 各自重新佈陣（官方 5 艘：5/4/3/3/2）→ 開戰");
P1.comm.ready(FLEET_C10);
P3.comm.ready(FLEET_C10);
await waitCond(() => P1.st.phase === "battle", 5000, "10×10 開戰");
ok(P1.st.phase === "battle", "正版 10×10 開戰");

step("局 2 ③ 10×10 規格與防呆驗證（100 格、無效座標、重複開火）");
{
  // 先手可能是 P3（先手輪替）→ 由「目前有開火權的人」執行邊界測試
  await waitCond(() => !!((P1.st && P1.st.canFire) || (P3.st && P3.st.canFire)), 90000, "有人取得開火權");
  const actor = P1.st && P1.st.canFire ? P1 : P3;
  const other = actor === P1 ? P3 : P1;
  const corners = [[9, 9], [9, 0], [0, 9], [0, 0]];
  const board = actor.st.enemy.board || {};
  const corner = corners.find(([r, c]) => board[r + "," + c] === undefined);
  ok(!!corner, "找到未開火的角落格（" + (corner ? corner.join(",") : "") + "）");
  if (!corner) throw new Error("四個角落都已被開火（罕見），請重跑");

  const errBase = P1.errors.length + P3.errors.length;
  const fired0 = actor.firesAll.length;
  actor.comm.fire(corner.join(","));
  await waitCond(() => actor.firesAll.length > fired0, 5000, "角落格開火事件");
  ok(P1.errors.length + P3.errors.length === errBase, "10×10 角落（J10/A10/J1/A1 級距）可正常開火");

  await playUntil([P1, P3], () => actor.st.canFire, 90000, "輪回 " + actor.name);
  const err0 = actor.errors.length;
  actor.comm.fire(corner.join(",")); // 同一格再打
  await waitCond(() => actor.errors.length > err0, 5000, "重複開火錯誤");
  ok(actor.errors[actor.errors.length - 1].includes("已經打過"), "重複開火被拒（這個位置已經打過了）");
  const err1 = actor.errors.length;
  actor.comm.fire("10,0"); // 越界（第 11 列）
  await waitCond(() => actor.errors.length > err1, 5000, "越界錯誤");
  ok(actor.errors[actor.errors.length - 1].includes("座標無效"), "越界座標被拒（K11 不存在）");
  void other;
}

step("局 2 ④ 完整打完 10×10（官方船隊、允許緊鄰）");
const r4 = await playToEnd([P1, P3], 240000, "局2-10×10");
ok(r4.completed && P1.st.phase === "over", "10×10 完整打完（phase=over）");
{
  const s1 = P1.sunkNames.length - sunkP1_0, s3 = P3.sunkNames.length - sunkP3_0;
  ok(s1 >= 5 && s1 === s3, `本場擊沉事件雙方同步（共 ${s1} 次，含敗方戰果，≥5 艘沉沒）`);
}
const s5len = [5, 4, 3, 3, 2];
arc = await archive();
ok(arc.count === 4, "戰績累計 4 筆（s5×3 + c10×1）");
ok(arc.matches[0].boardMode === "c10", "最新戰績 boardMode=c10");
// 抓完整明細驗證船隊（列表摘要不含 fleet）
const detail = (await (await fetch(api("/api/archive/" + ROOM + "/" + arc.matches[0].id))).json()).match;
const cells = (pos, len) => Array.from({ length: len }, (_, i) => (pos.d === "V" ? [pos.r + i, pos.c] : [pos.r, pos.c + i]));
const fleetCells = Object.entries(detail.players[0].fleet).flatMap(([id, p]) => cells(p, { "5": 5, "4": 4, "3a": 3, "3b": 3, "2": 2 }[id]));
ok(Object.keys(detail.players[0].fleet).length === 5, "存檔船隊 = 5 艘（官方）");
ok(new Set(fleetCells.map((x) => x.join(","))).size === 17, "存檔船隊共 17 格（官方）");
ok(detail.boardMode === "c10" && (detail.shots || []).length > 0, "明細含 boardMode 與逐步開火紀錄");

/* ---------------- 收尾 ---------------- */
step("收尾：雙方離開 → 房間淨空；清除測試戰績");
P1.comm.close(); P3.comm.close();
await waitCond(async () => (await roomState()).players.length === 0, 25000, "房間淨空");
ok((await roomState()).players.length === 0, "雙方離開後房間淨空（座位自動釋出）");
const c = await (await fetch(api("/api/archive/" + ROOM + "/clear"), { method: "POST" })).json();
console.log(`    清除測試戰績 ${c.removed} 筆`);
ok(c.removed === 4, "測試戰績已全數清除（還原房間）");

console.log(`\n═══ 總結果：${pass} 通過 / ${fail} 失敗 ═══`);
process.exit(fail ? 1 : 0);
