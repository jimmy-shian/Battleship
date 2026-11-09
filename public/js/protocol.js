/*!
 * 海戰棋 — 通訊協定定義
 * 前端 (public/js/*) 與 Cloudflare Worker (worker/*) 共用，純常數、無副作用。
 */
export const PROTOCOL_VERSION = 1;

/* ---------- Client → Server ---------- */
export const C2S = {
  HELLO: "hello",        // { key, name, clientId, userId, v }
  READY: "ready",        // { fleet }
  UNREADY: "unready",    // {}
  FIRE: "fire",          // { cell }
  ANNOTATE: "annotate",  // { cell, value }  value: 0 清除 / 1 落空 / 2 命中 / 3 擊沉
  CLEAR_MARKS: "clearMarks", // {}
  CHAT: "chat",          // { text }
  SETTINGS: "settings",  // { turnRule }
  REMATCH: "rematch",    // { keepFleet }
  PING: "ping"           // { at }
};

/* ---------- Server → Client ---------- */
export const S2C = {
  WELCOME: "welcome",    // { you, key, server, rules }
  STATE: "state",        // 完整戰局快照
  PLAYER: "player",      // { event: "join"|"leave"|"takeover", player }
  FIRE: "fire",          // { by, byName, cell, result, sunk, over }
  ANNOTATE: "annotate",  // { by, cell, value }
  CHAT: "chat",          // { from, text, at }
  REMATCH: "rematch",    // { keepFleet }
  ERROR: "error",        // { code, message }
  PONG: "pong"           // { at }
};

/* ---------- 回合規則 ---------- */
export const TURN_RULES = {
  ALT: "alt",   // 輪流交替：每次開火後換人
  KEEP: "keep"  // 命中續打：命中或擊沉則繼續，未中才換人
};

/* ---------- 錯誤碼 ---------- */
export const ERR = {
  NO_KEY: "no_key",
  ROOM_FULL: "room_full",
  TOO_MANY_ROOMS: "too_many_rooms",
  NOT_JOINED: "not_joined",
  BAD_PHASE: "bad_phase",
  NOT_YOUR_TURN: "not_your_turn",
  INVALID_CELL: "invalid_cell",
  ALREADY_FIRED: "already_fired",
  INVALID_FLEET: "invalid_fleet",
  OPPONENT_NOT_READY: "opponent_not_ready",
  BAD_REQUEST: "bad_request"
};
