/*!
 * 海戰棋 — 通訊協定定義
 * 前端 (public/js/*) 與 Cloudflare Worker (worker/*) 共用，純常數、無副作用。
 */
export const PROTOCOL_VERSION = 2;

/* ---------- Client → Server ---------- */
export const C2S = {
  HELLO: "hello",        // { key, name, clientId, userId, boardMode, v }
  READY: "ready",        // { fleet }
  UNREADY: "unready",    // {}
  FIRE: "fire",          // { cell }
  ANNOTATE: "annotate",  // { cell, value }  value: 0 清除 / 1 落空 / 2 命中 / 3 擊沉
  CLEAR_MARKS: "clearMarks", // {}
  CHAT: "chat",          // { text }
  SETTINGS: "settings",  // { boardMode }（回合規則固定為命中續打）
  REMATCH: "rematch",    // { keepFleet }
  RESET: "reset",        // {} 重開對局（任何階段皆可，保留船艦、需重新鎖定）
  PING: "ping"           // { at }
};

/* ---------- Server → Client ---------- */
export const S2C = {
  WELCOME: "welcome",    // { you, key, server, rules }
  STATE: "state",        // 完整戰局快照
  PLAYER: "player",      // { event: "join"|"leave"|"takeover"|"removed", player }
  FIRE: "fire",          // { by, byName, cell, result, sunk, over }
  ANNOTATE: "annotate",  // { by, cell, value }
  CHAT: "chat",          // { from, text, at }
  REMATCH: "rematch",    // { keepFleet }
  RESET: "reset",        // { by } 對局已重開（戰局重算，進入佈陣階段）
  RESET_REQ: "resetReq", // { by } 對手提議重開對局（等待我方同意）
  ERROR: "error",        // { code, message }
  PONG: "pong"           // { at }
};

/* ---------- 回合規則 ---------- */
export const TURN_RULES = {
  ALT: "alt",   // （已停用）輪流交替
  KEEP: "keep"  // 命中續打：命中或擊沉則繼續，未中才換人（本版固定採用）
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
