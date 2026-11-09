/*!
 * 海戰棋 — Registry Durable Object（房間數量登記簿）
 * -----------------------------------------------------------------------------
 * 全站只有一個實例（idFromName("registry")），負責記錄：
 *   「哪個使用者（userId）目前在哪些房間」
 *
 * 規則：每位使用者最多同時擁有 MAX_ROOMS（3）個房間。
 *   - 進入新房間前先登記，超過上限就回傳 too_many_rooms 並附上使用者的房間清單，
 *     讓前端讓使用者「選一個房間釋出」。
 *   - 離開房間或房間閒置過期時自動移除，不佔用額度。
 */
const MAX_ROOMS = 3;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 房間本身 6 小時後會被清除

const clean = (s, max) => String(s == null ? "" : s).trim().slice(0, max || 64);

export class Registry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/join" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json(await this.join(clean(body.userId, 64), clean(body.room, 48), clean(body.name, 24)));
      }
      if (url.pathname === "/leave" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json(await this.leave(clean(body.userId, 64), clean(body.room, 48)));
      }
      if (url.pathname === "/rooms") {
        const userId = clean(url.searchParams.get("userId"), 64);
        return Response.json({ ok: true, max: MAX_ROOMS, rooms: await this.list(userId) });
      }
    } catch (e) {
      return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500 });
    }
    return new Response("not found", { status: 404 });
  }

  /** 讀取並清理（過期房間自動移除） */
  async load(userId) {
    const raw = (await this.state.storage.get("u:" + userId)) || { rooms: [] };
    const now = Date.now();
    const rooms = (raw.rooms || []).filter((r) => now - (r.at || 0) < ROOM_TTL_MS);
    return { rooms, changed: rooms.length !== (raw.rooms || []).length };
  }

  async save(userId, data) {
    await this.state.storage.put("u:" + userId, data);
  }

  /** 登記房間；超過上限回傳 too_many_rooms */
  async join(userId, room, name) {
    if (!userId || !room) return { ok: false, code: "bad_request" };
    const s = await this.load(userId);
    const idx = s.rooms.findIndex((r) => r.room === room);
    if (idx >= 0) {
      s.rooms[idx].at = Date.now();
      if (name) s.rooms[idx].name = name;
    } else {
      if (s.rooms.length >= MAX_ROOMS) {
        return { ok: false, code: "too_many_rooms", max: MAX_ROOMS, rooms: s.rooms };
      }
      s.rooms.push({ room, name: name || "", at: Date.now() });
    }
    await this.save(userId, s);
    return { ok: true, max: MAX_ROOMS, rooms: s.rooms };
  }

  /** 離開房間（釋出額度） */
  async leave(userId, room) {
    if (!userId) return { ok: false, code: "bad_request" };
    const s = await this.load(userId);
    s.rooms = s.rooms.filter((r) => r.room !== room);
    await this.save(userId, s);
    return { ok: true, max: MAX_ROOMS, rooms: s.rooms };
  }

  /** 查詢使用者的房間清單 */
  async list(userId) {
    if (!userId) return [];
    const s = await this.load(userId);
    if (s.changed) await this.save(userId, s);
    return s.rooms;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}
