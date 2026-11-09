/*!
 * 海戰棋 — 使用者識別碼（瀏覽器層級）
 * -----------------------------------------------------------------------------
 * 用途：「每位使用者最多 3 個房間」的限制。
 * 存於 localStorage，同一瀏覽器的所有分頁共用同一個 ID，
 * 因此換分頁開新房間也會被算進去。
 *
 * 與 sessionStorage 的 clientId（座位識別）分工：
 *   - clientId：分頁級，用來在斷線重連後認回自己的座位
 *   - browserId：瀏覽器級，用來計算房間數上限
 */
const KEY = "bs.user.id";

export function browserId() {
  let v = "";
  try { v = localStorage.getItem(KEY) || ""; } catch (e) {}
  if (!v) {
    const rnd = globalThis.crypto && globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    v = "u" + rnd;
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }
  return v;
}

export default browserId;
