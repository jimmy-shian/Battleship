/*!
 * 海戰棋 — 戰績存檔（Archive）
 * -----------------------------------------------------------------------------
 * 兩種後端，讀取時合併（以對局 ID 去重）：
 *   1. R2（env.ARCHIVE 綁定存在時）
 *        objects: matches/<房間金鑰>/<對局ID>.json
 *        customMetadata.sum 內含摘要，列表時不必讀取物件本體
 *   2. Durable Object 自身的 SQLite 儲存（永遠啟用）
 *        key: archive:index（摘要陣列）、archive:<對局ID>（完整紀錄）
 *
 * 因此：R2 尚未在 Cloudflare Dashboard 啟用時功能照常可用；
 *      日後啟用 R2 並加上綁定後，新舊資料會自動合併，不會遺失歷史。
 */
import { summarize } from "../public/js/rules.js";

export const ARCHIVE_VERSION = 1;

const R2_PREFIX = "matches/";
const DO_INDEX_KEY = "archive:index";
const DO_RECORD_PREFIX = "archive:";
const DO_MAX = 100;   // 每個房間最多保留的對局紀錄數；滿了之後由後端刪掉最舊的一筆

const enc = (o) => encodeURIComponent(JSON.stringify(o));
const dec = (s) => {
  try { return JSON.parse(decodeURIComponent(s)); } catch (e) { return null; }
};

/** R2 物件前綴 */
export const roomPrefix = (room) => `${R2_PREFIX}${room}/`;

/**
 * 由房間狀態組出完整對局紀錄。
 * s：房間狀態；over：結算資訊 { winner, loser, at }
 */
export function buildRecord(s, over) {
  const players = s.players.map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    fleet: p.fleet || {},
    stats: summarize(s.fired[p.id] || {})
  }));
  const winner = players.find((p) => p.id === over.winner) || null;
  const loser = players.find((p) => p.id === over.loser) || null;
  const startedAt = s.startedAt || over.at;
  return {
    v: ARCHIVE_VERSION,
    id: String(over.at),
    room: s.key,
    at: over.at,
    startedAt,
    durationMs: Math.max(0, over.at - startedAt),
    turnRule: s.turnRule,
    boardMode: s.boardMode || "s5",
    winner: winner ? { id: winner.id, name: winner.name } : null,
    loser: loser ? { id: loser.id, name: loser.name } : null,
    players,
    // 開火紀錄（供回放）
    shots: (s.shots || []).map((x) => ({ by: x.by, cell: x.cell, result: x.result, at: x.at }))
  };
}

/** 列表用摘要 */
export function summaryOf(rec) {
  return {
    id: rec.id,
    at: rec.at,
    room: rec.room,
    turnRule: rec.turnRule,
    boardMode: rec.boardMode || "s5",
    durationMs: rec.durationMs,
    winner: rec.winner,
    loser: rec.loser,
    players: (rec.players || []).map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      stats: p.stats
    }))
  };
}

/* ---------- R2 ---------- */

async function putR2(env, rec) {
  if (!env || !env.ARCHIVE) return false;
  const key = roomPrefix(rec.room) + rec.id + ".json";
  await env.ARCHIVE.put(key, JSON.stringify(rec), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { sum: enc(summaryOf(rec)) }
  });
  return true;
}

async function listR2(env, room, limit) {
  if (!env || !env.ARCHIVE) return [];
  const prefix = room ? roomPrefix(room) : R2_PREFIX;
  const out = [];
  let cursor;
  do {
    const page = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects || []) {
      const s = o.customMetadata && o.customMetadata.sum ? dec(o.customMetadata.sum) : null;
      if (s) {
        out.push(s);
      } else {
        // 相容舊物件：沒有 metadata 時才讀本體
        const obj = await env.ARCHIVE.get(o.key);
        if (obj) {
          try { out.push(summaryOf(JSON.parse(await obj.text()))); } catch (e) {}
        }
      }
      if (out.length >= limit) break;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && out.length < limit);
  return out;
}

async function getR2(env, room, id) {
  if (!env || !env.ARCHIVE) return null;
  const obj = await env.ARCHIVE.get(roomPrefix(room) + id + ".json");
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch (e) { return null; }
}

/* ---------- 對外（由 Durable Object 呼叫） ---------- */

/**
 * 存檔：先寫進 DO 的 SQLite（永久備援），若 R2 已綁定則同步一份到 R2。
 */
export async function saveArchive(state, env, rec) {
  const summary = summaryOf(rec);
  const index = (await state.storage.get(DO_INDEX_KEY)) || [];
  const merged = [summary, ...index.filter((x) => x.id !== summary.id)];
  const next = merged.slice(0, DO_MAX);
  // 超出上限的舊紀錄：連同完整紀錄一起由後端刪除
  const evicted = merged.slice(DO_MAX).map((x) => x.id);
  await state.storage.put(DO_INDEX_KEY, next);
  await state.storage.put(DO_RECORD_PREFIX + rec.id, rec);
  if (evicted.length) {
    await state.storage.delete(evicted.map((id) => DO_RECORD_PREFIX + id));
  }

  let r2 = false;
  try {
    r2 = await putR2(env, rec);
  } catch (e) {
    console.error("[archive] R2 寫入失敗（已保留於 DO 儲存）:", e && e.message);
  }
  return { do: true, r2 };
}

/** 列出對局摘要（R2 + DO 合併，由新到舊） */
export async function listArchive(state, env, room, limit) {
  const cap = Math.min(DO_MAX, Math.max(1, Number(limit) || 100));
  const doIndex = (await state.storage.get(DO_INDEX_KEY)) || [];

  let r2 = [];
  try {
    r2 = await listR2(env, room, cap);
  } catch (e) {
    console.error("[archive] R2 讀取失敗:", e && e.message);
  }

  const map = new Map();
  for (const x of r2) map.set(x.id, x);
  for (const x of doIndex) if (!map.has(x.id)) map.set(x.id, x);
  return [...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, cap);
}

/** 取得單局完整紀錄 */
export async function getArchive(state, env, room, id) {
  const rec = await state.storage.get(DO_RECORD_PREFIX + id);
  if (rec) return rec;
  try {
    return await getR2(env, room, id);
  } catch (e) {
    return null;
  }
}

/** 清空某房間的所有戰績紀錄（DO SQLite + R2） */
export async function clearArchive(state, env, room) {
  const index = (await state.storage.get(DO_INDEX_KEY)) || [];
  for (const it of index) {
    await state.storage.delete(DO_RECORD_PREFIX + it.id);
  }
  await state.storage.delete(DO_INDEX_KEY);

  let r2 = 0;
  try {
    if (env && env.ARCHIVE) {
      const prefix = roomPrefix(room);
      let cursor;
      do {
        const page = await env.ARCHIVE.list({ prefix, cursor });
        for (const o of page.objects || []) {
          await env.ARCHIVE.delete(o.key);
          r2++;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  } catch (e) {
    console.error("[archive] R2 清除失敗:", e && e.message);
  }
  return { do: index.length, r2 };
}
