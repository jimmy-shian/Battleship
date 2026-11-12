/*!
 * E2E：座位釋出／對局重算／重開對局
 *   1. A、B 進 ROOM2（正版 10×10）→ 佈陣開戰
 *   2. B 關閉連線（模擬關分頁）→ 15 秒寬限後座位釋出，戰局重算回佈陣
 *   3. C 進房 → 新座位、phase=setup、A 船艦保留
 *   4. C 佈陣 → 開戰；A 送 reset → 回佈陣
 */
import { BattleComm } from "../public/js/comm.mjs";

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const ROOM = "ROOM2";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.error("  ✗ " + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function roomState() {
  const res = await fetch(base + "/api/room/" + ROOM, { cache: "no-store" });
  return res.json();
}

/** 正版 10×10 佈陣（合法：不重疊即可，官方允許緊鄰） */
function fleet10() {
  return {
    "5":  { r: 0, c: 0, d: "H" },
    "4":  { r: 2, c: 0, d: "H" },
    "3a": { r: 4, c: 0, d: "H" },
    "3b": { r: 6, c: 0, d: "H" },
    "2":  { r: 8, c: 0, d: "H" }
  };
}

function agent(name) {
  const a = { name, you: null, st: null, comm: null };
  a.comm = new BattleComm({
    url: base, key: ROOM, name,
    clientId: "e2e-" + name + "-" + Math.random().toString(36).slice(2, 8),
    userId: "e2e-user-" + name,
    boardMode: "c10",
    autoReconnect: false
  });
  a.comm.on("message", (e) => {
    const m = e.detail;
    if (m.t === "welcome") a.you = m.you;
    if (m.t === "state") a.st = m;
    if (m.t === "reset") a.resetSeen = true;
  });
  return a;
}

const join = async (a) => {
  await a.comm.join({ key: ROOM, name: a.name, userId: "e2e-user-" + a.name });
  await waitCond(() => a.st, 5000, a.name + " 收到第一份 state");
  return a;
};
const ready = (a) => a.comm.ready(fleet10());

async function waitCond(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch (e) {}
    await sleep(150);
  }
  throw new Error("等待逾時：" + what);
}

console.log("[1] A、B 進房並佈陣（正版 10×10）");
const A = await join(agent("A員"));
ok(A.st && A.st.boardMode === "c10", "A 進房，海域 = 正版 10×10");
await ready(A);
const B = await join(agent("B員"));
await ready(B);
await waitCond(() => A.st && A.st.phase === "battle", 5000, "開戰");
ok(A.st.phase === "battle" && A.st.players.length === 2, "雙方就緒，進入戰鬥（2 人）");

console.log("[2] B 關閉連線（模擬關分頁）→ 寬限後座位釋出");
B.comm.close();
await waitCond(() => A.st.players.every((p) => p.id === A.you || !p.online), 5000, "A 看到 B 離線");
ok(A.st.players.some((p) => !p.online), "B 標記離線（寬限期內）");
let st = await roomState();
ok(st.players.length === 2 && st.players.some((p) => !p.online), "寬限期內 /api/room 仍顯示 2 人（離線中）");
await waitCond(async () => (await roomState()).players.length === 1, 20000, "座位釋出");
st = await roomState();
ok(st.players.length === 1, "15 秒後座位釋出，房間只剩 A");
ok(A.st.phase === "setup" && A.st.mine.ready === true, "戰局重算回佈陣，A 的佈陣狀態保留");

console.log("[3] C 進房（新座位、不繼承 B 的船）");
const C = await join(agent("C員"));
await waitCond(() => A.st.players.length === 2, 5000, "A 看到 C 加入");
ok(C.st.phase === "setup", "C 進入佈陣階段（沒有被丟進殘留對局）");
ok(C.st.mine.fleet && Object.keys(C.st.mine.fleet).length === 0, "C 的座位是空的（可放船）");
ok(A.st.players.length === 2, "房間回到 2 人");

console.log("[4] C 佈陣 → 開戰 → A 重開對局");
await ready(C);
await waitCond(() => A.st.phase === "battle", 5000, "再次開戰");
ok(A.st.phase === "battle", "A、C 開戰");
A.comm.send("reset");
await waitCond(() => A.st.phase === "setup", 5000, "重開對局");
ok(A.st.phase === "setup" && A.st.mine.ready === false, "reset 後回佈陣、需重新鎖定");
ok(C.resetSeen === true, "C 也收到 reset 廣播");

console.log("[5] 收尾");
A.comm.close(); C.comm.close();
await waitCond(async () => (await roomState()).players.length === 0, 20000, "房間淨空");
st = await roomState();
ok(st.players.length === 0 && st.phase === "setup", "雙方離開後房間完全淨空");

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
