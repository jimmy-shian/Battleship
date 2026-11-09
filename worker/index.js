/*!
 * 海戰棋 — Cloudflare Worker 進入點
 * -----------------------------------------------------------------------------
 * 路由：
 *   GET  /ws?key=XXXX          → WebSocket 升級，轉發到對應房間的 Durable Object
 *   GET  /api/room/:key        → 房間概況（JSON，供大廳顯示房間人數）
 *   GET  /api/archive/:key     → 該房間的戰績摘要列表
 *   GET  /api/archive/:key/:id → 單局完整戰績（含開火紀錄）
 *   POST /api/archive/:key/clear → 清空該房間的戰績紀錄
 *   GET  /api/registry/rooms?userId=... → 使用者目前擁有的房間（最多 3 個）
 *   POST /api/registry/release → 釋出一個房間（並把玩家踢出該房間）
 *   GET  /api/health           → 健康檢查
 *   GET  /*                    → 靜態網站（public/）
 */
import { Room } from "./room.js";
import { Registry } from "./registry.js";

// Durable Object 類別必須從進入點匯出，wrangler 才能建立綁定
export { Room, Registry };

const normalizeKey = (k) =>
  String(k == null ? "" : k).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 48);

/** 全站固定三間房（房號固定）：ROOM1 / ROOM2 / ROOM3 */
const FIXED_ROOMS = ["ROOM1", "ROOM2", "ROOM3"];

/** 只接受固定三間房；其他一律回空字串 */
const canonicalRoom = (k) => {
  const key = normalizeKey(k);
  return FIXED_ROOMS.includes(key) ? key : "";
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/ws" || url.pathname === "/ws/") {
        const key = canonicalRoom(url.searchParams.get("key"));
        if (!key) {
          return new Response("invalid room (fixed rooms: Room1 / Room2 / Room3)", { status: 400 });
        }
        const id = env.ROOM.idFromName(key);
        const stub = env.ROOM.get(id);
        return stub.fetch(request);
      }

      if (url.pathname.startsWith("/api/room/")) {
        const key = canonicalRoom(url.pathname.slice("/api/room/".length));
        if (!key) return Response.json({ error: "invalid room (fixed rooms: Room1 / Room2 / Room3)" }, { status: 404 });
        const id = env.ROOM.idFromName(key);
        const stub = env.ROOM.get(id);
        return stub.fetch(new Request(url.origin + "/state?key=" + encodeURIComponent(key), request));
      }

      // 戰績存檔：/api/archive/:key 與 /api/archive/:key/:id
      if (url.pathname.startsWith("/api/archive/")) {
        const rest = url.pathname.slice("/api/archive/".length);
        const slash = rest.indexOf("/");
        const key = canonicalRoom(slash === -1 ? rest : rest.slice(0, slash));
        if (!key) return Response.json({ error: "invalid room (fixed rooms: Room1 / Room2 / Room3)" }, { status: 404 });
        const id = env.ROOM.idFromName(key);
        const stub = env.ROOM.get(id);
        const target =
          slash === -1
            ? "/archive?limit=" + encodeURIComponent(url.searchParams.get("limit") || "100")
            : "/archive/" + encodeURIComponent(rest.slice(slash + 1));
        return stub.fetch(new Request(url.origin + target, request));
      }

      // 房間數登記簿（每位使用者最多 3 個房間）
      if (url.pathname === "/api/registry/rooms") {
        const userId = String(url.searchParams.get("userId") || "").slice(0, 64);
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
        return reg.fetch(new Request(url.origin + "/rooms?userId=" + encodeURIComponent(userId), request));
      }

      if (url.pathname === "/api/registry/release" && request.method === "POST") {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const userId = String(body.userId || "").slice(0, 64);
        const room = normalizeKey(body.room);
        if (!userId || !room) return Response.json({ error: "missing userId or room" }, { status: 400 });

        const reg = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
        const res = await reg.fetch(
          new Request(url.origin + "/leave", {
            method: "POST",
            body: JSON.stringify({ userId, room })
          })
        );
        // 把玩家從被釋出的房間移除（釋出座位）
        try {
          const stub = env.ROOM.get(env.ROOM.idFromName(room));
          await stub.fetch(
            new Request(url.origin + "/release", {
              method: "POST",
              body: JSON.stringify({ userId })
            })
          );
        } catch (e) {
          console.error("[registry] 釋出房間失敗:", e && e.message);
        }
        return res;
      }

      if (url.pathname === "/api/health") {
        return Response.json({ ok: true, now: Date.now() });
      }
    } catch (e) {
      return new Response("worker error: " + (e && e.message), { status: 500 });
    }

    return env.ASSETS.fetch(request);
  }
};
