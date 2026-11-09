/*!
 * BattleComm — 海戰棋雲端通訊模組 v1
 * -----------------------------------------------------------------------------
 * 這是一支「獨立、可直接引用」的通訊端模組，零外部相依，只用瀏覽器原生 WebSocket。
 *
 * 用法 A：一般 script 載入（掛在 window.BattleComm）
 *   <script src="js/comm.js"></script>
 *   <script>
 *     const comm = new BattleComm({ url: "wss://battleship-online.example.workers.dev" });
 *     comm.on("state", e => console.log(e.detail));
 *     comm.join({ key: "ABC123", name: "小明" });
 *   </script>
 *
 * 用法 B：ES Module
 *   import { BattleComm } from "./js/comm.mjs";
 *
 * 特色：
 *   - 自動重連（指數退避 + 抖動）、心跳偵測、斷線重連後自動回房
 *   - join / ready / fire / annotate / chat / rematch 等高階 API 開箱即用
 *   - request() 具 Promise 的請求-回應模式
 *   - 所有伺服器事件以 CustomEvent 形式派發（'state' / 'fire' / 'chat' / ...）
 *
 * 伺服器端點需求：GET {url}/ws?key={房間金鑰} 升級為 WebSocket，
 * 連線後客戶端會送出 { t:"hello", key, name, clientId }。
 */
(function (global) {
  "use strict";

  const VERSION = 1;

  /* Client → Server */
  const C2S = {
    HELLO: "hello",
    READY: "ready",
    UNREADY: "unready",
    FIRE: "fire",
    ANNOTATE: "annotate",
    CLEAR_MARKS: "clearMarks",
    CHAT: "chat",
    SETTINGS: "settings",
    REMATCH: "rematch",
    PING: "ping"
  };

  /* Server → Client */
  const S2C = {
    WELCOME: "welcome",
    STATE: "state",
    PLAYER: "player",
    FIRE: "fire",
    ANNOTATE: "annotate",
    CHAT: "chat",
    REMATCH: "rematch",
    ERROR: "error",
    PONG: "pong"
  };

  const DEFAULTS = {
    url: null,                 // 伺服器 base url，null = 同網域
    key: "",                   // 房間金鑰
    name: "",                  // 暱稱
    clientId: null,            // 穩定識別碼（重連後靠它認回座位）
    userId: null,              // 使用者層級識別碼（房間數上限用，選填）
    turnRule: null,            // 進房時希望採用的回合規則（alt / keep）
    autoReconnect: true,
    reconnectBaseDelay: 1000,
    reconnectMaxDelay: 15000,
    heartbeatInterval: 20000,
    heartbeatTimeout: 10000,
    requestTimeout: 10000,
    debug: false
  };

  /* ---------- 小工具 ---------- */

  function randomId(prefix) {
    const rnd = (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return prefix ? prefix + "-" + rnd : rnd;
  }

  /** 全站固定三間房：房號固定為 ROOM1 / ROOM2 / ROOM3（不分大小寫） */
  const FIXED_ROOMS = ["ROOM1", "ROOM2", "ROOM3"];

  /** 房間金鑰正規化：只接受固定三間房，其他一律回空字串 */
  function normalizeRoomKey(k) {
    const s = String(k == null ? "" : k)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, "");
    return FIXED_ROOMS.includes(s) ? s : "";
  }

  /** 產生一個好記的房間金鑰（固定房號制之下已不再使用，保留供外部引用） */
  function randomRoomKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const body = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return "BS-" + body;
  }

  /** 將伺服器位址轉成 WebSocket 端點 */
  function resolveWsUrl(server, path) {
    const p = path || "/ws";
    let s = String(server == null ? "" : server).trim();
    if (!s) {
      const loc = global.location;
      if (loc && (loc.protocol === "http:" || loc.protocol === "https:")) {
        return (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host + p;
      }
      return "ws://127.0.0.1:8787" + p;
    }
    if (/^wss?:\/\//i.test(s)) return s.replace(/\/+$/, "") + p;
    if (/^https:\/\//i.test(s)) return "wss://" + s.replace(/^https:\/\//i, "").replace(/\/+$/, "") + p;
    if (/^http:\/\//i.test(s)) return "ws://" + s.replace(/^http:\/\//i, "").replace(/\/+$/, "") + p;
    return "ws://" + s.replace(/\/+$/, "") + p;
  }

  function makeEvent(type, detail) {
    if (typeof global.CustomEvent === "function") return new global.CustomEvent(type, { detail });
    if (typeof global.Event === "function") {
      const e = new global.Event(type);
      e.detail = detail;
      return e;
    }
    return { type, detail };
  }

  /* ---------- BattleComm ---------- */

  class BattleComm extends EventTarget {
    constructor(options) {
      super();
      this.opt = Object.assign({}, DEFAULTS, options || {});
      this.status = "idle";          // idle | connecting | open | reconnecting | closed
      this.ws = null;
      this.you = null;               // 伺服器指派的玩家代號
      this.serverInfo = null;
      this.attempt = 0;
      this._timer = null;
      this._hbTimer = null;
      this._hbInterval = null;
      this._pending = new Map();
      this._queue = [];
      this._closedByUser = false;
      this._openPromise = null;
      this._resolveOpen = null;
      this._rejectOpen = null;
    }

    /** 是否已連線 */
    get connected() {
      return this.status === "open" && !!this.ws && this.ws.readyState === 1;
    }

    /** 訂閱事件，回傳取消訂閱的函式 */
    on(type, handler) {
      this.addEventListener(type, handler);
      const self = this;
      return function off() { self.removeEventListener(type, handler); };
    }

    /** 連線並加入房間 */
    join(opts) {
      const o = opts || {};
      if (o.key !== undefined) this.opt.key = normalizeRoomKey(o.key);
      if (o.name !== undefined) this.opt.name = String(o.name || "").slice(0, 24);
      if (o.clientId !== undefined) this.opt.clientId = o.clientId;
      if (o.userId !== undefined) this.opt.userId = o.userId;
      if (o.turnRule !== undefined) this.opt.turnRule = o.turnRule;
      return this.connect();
    }

    /** 建立連線（已連線時直接 resolve） */
    connect() {
      if (this._openPromise) return this._openPromise;
      if (!this.opt.key) return Promise.reject(new Error("缺少房間金鑰"));
      if (!this.opt.clientId) this.opt.clientId = randomId("c");
      this._closedByUser = false;
      this._openPromise = new Promise((resolve, reject) => {
        this._resolveOpen = resolve;
        this._rejectOpen = reject;
      });
      this._open();
      return this._openPromise;
    }

    _open() {
      const url = resolveWsUrl(this.opt.url) + "?key=" + encodeURIComponent(this.opt.key);
      this._setStatus(this.attempt > 0 ? "reconnecting" : "connecting");
      this._log("connecting", url);
      this.dispatchEvent(makeEvent("socket", { phase: "connecting", attempt: this.attempt }));

      let ws;
      try {
        ws = new global.WebSocket(url);
      } catch (e) {
        this._failOpen(e);
        this._scheduleReconnect();
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this._log("open");
        this.attempt = 0;
        this._setStatus("open");
        this.dispatchEvent(makeEvent("socket", { phase: "open" }));
        this._raw({
          t: C2S.HELLO,
          v: VERSION,
          key: this.opt.key,
          name: this.opt.name,
          clientId: this.opt.clientId,
          userId: this.opt.userId || null,
          turnRule: this.opt.turnRule || null
        });
        // 補送連線期間暫存的訊息
        if (this._queue.length) {
          const q = this._queue.splice(0);
          this._log("flush queue", q.length);
          q.forEach((m) => this._raw(m));
        }
        this._startHeartbeat();
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        this._handle(msg);
      };

      ws.onerror = () => { /* 錯誤細節由 onclose 收尾 */ };

      ws.onclose = (ev) => {
        this._log("close", ev && ev.code, ev && ev.reason);
        this._stopHeartbeat();
        this._queue.length = 0;
        if (this.ws === ws) this.ws = null;
        this._failOpen(new Error("連線已關閉"));
        this._setStatus("closed");
        this.dispatchEvent(makeEvent("socket", { phase: "close", code: ev && ev.code, reason: ev && ev.reason }));
        // 1013 = 伺服端拒絕（例：房間已滿），不再自動重連
        const fatal = ev && (ev.code === 1013 || ev.code === 1008);
        if (!this._closedByUser && this.opt.autoReconnect && !fatal) this._scheduleReconnect();
      };
    }

    _handle(msg) {
      if (!msg || typeof msg !== "object") return;

      if (msg.id && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.t === S2C.ERROR) p.reject(new Error(msg.message || "伺服器錯誤"));
        else p.resolve(msg);
      }

      if (msg.t === S2C.WELCOME) {
        this.you = msg.you;
        this.serverInfo = msg.server || null;
        const r = this._resolveOpen;
        this._resolveOpen = null;
        this._rejectOpen = null;
        if (r) r(msg);
      }
      if (msg.t === S2C.PONG && this._hbTimer) {
        clearTimeout(this._hbTimer);
        this._hbTimer = null;
      }

      this.dispatchEvent(makeEvent("message", msg));
      if (msg.t) this.dispatchEvent(makeEvent(msg.t, msg));
    }

    /**
     * 送出訊息。
     * @param {string} type
     * @param {object} [payload]
     * @param {{queue?:boolean}} [opts] queue=true 時，若正在連線會先暫存，
     *        連線成功後自動補送（適合「鎖定船艦」等不該遺失的訊息）
     * @returns {boolean} 是否已送出（或已排入佇列）
     */
    send(type, payload, opts) {
      const msg = Object.assign({ t: type }, payload || {});
      if (!this.ws || this.ws.readyState !== 1) {
        if (opts && opts.queue && this.status === "connecting") {
          this._queue.push(msg);
          this._log("queued", msg);
          return true;
        }
        return this._raw(msg);
      }
      return this._raw(msg);
    }

    /** Promise 化的請求-回應（伺服器需回傳相同 id） */
    request(type, payload, timeout) {
      const id = randomId("r");
      const msg = Object.assign({ t: type, id }, payload || {});
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new Error("請求逾時：" + type));
        }, timeout == null ? this.opt.requestTimeout : timeout);
        this._pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); }
        });
        if (!this._raw(msg)) {
          clearTimeout(timer);
          this._pending.delete(id);
          reject(new Error("尚未連線"));
        }
      });
    }

    /* ---------- 高階遊戲 API ---------- */

    /** 送出船隊並鎖定（準備完成） */
    ready(fleet) { return this.send(C2S.READY, { fleet }, { queue: true }); }
    /** 取消鎖定（僅在佈陣階段有效） */
    unready() { return this.send(C2S.UNREADY); }
    /** 對敵方海域開火，cell 為 "r,c" */
    fire(cell) { return this.send(C2S.FIRE, { cell }); }
    /** 手動標註敵方海域，value: 0 清除 / 1 落空 / 2 命中 / 3 擊沉 */
    annotate(cell, value) { return this.send(C2S.ANNOTATE, { cell, value }); }
    /** 清除自己的手動標註 */
    clearMarks() { return this.send(C2S.CLEAR_MARKS); }
    /** 送出通訊訊息 */
    chat(text) { return this.send(C2S.CHAT, { text: String(text || "").slice(0, 300) }); }
    /** 設定回合規則（僅佈陣階段有效） */
    setTurnRule(rule) { return this.send(C2S.SETTINGS, { turnRule: rule }); }
    /** 請求再戰一局 */
    rematch(keepFleet) { return this.send(C2S.REMATCH, { keepFleet: keepFleet !== false }); }

    /* ---------- 連線維運 ---------- */

    _raw(msg) {
      if (!this.ws || this.ws.readyState !== 1) {
        this._log("send failed", msg.t, this.ws ? this.ws.readyState : null, this.status);
        return false;
      }
      try {
        this.ws.send(JSON.stringify(msg));
        this._log("send", msg);
        return true;
      } catch (e) {
        return false;
      }
    }

    _startHeartbeat() {
      this._stopHeartbeat();
      this._hbInterval = setInterval(() => {
        this._raw({ t: C2S.PING, at: Date.now() });
        if (this._hbTimer) clearTimeout(this._hbTimer);
        this._hbTimer = setTimeout(() => {
          try { if (this.ws) this.ws.close(); } catch (e) {}
        }, this.opt.heartbeatTimeout);
      }, this.opt.heartbeatInterval);
    }

    _stopHeartbeat() {
      if (this._hbInterval) { clearInterval(this._hbInterval); this._hbInterval = null; }
      if (this._hbTimer) { clearTimeout(this._hbTimer); this._hbTimer = null; }
    }

    _scheduleReconnect() {
      if (this._timer || this._closedByUser) return;
      this.attempt++;
      const base = Math.min(this.opt.reconnectMaxDelay, this.opt.reconnectBaseDelay * Math.pow(2, this.attempt - 1));
      const delay = Math.round(base * (0.7 + Math.random() * 0.6));
      this._setStatus("reconnecting");
      this._log("reconnect in", delay, "ms");
      this._timer = setTimeout(() => {
        this._timer = null;
        this._open();
      }, delay);
    }

    _failOpen(err) {
      const r = this._rejectOpen;
      this._resolveOpen = null;
      this._rejectOpen = null;
      if (r) r(err);
    }

    _setStatus(s) {
      if (this.status === s) return;
      this.status = s;
      this.dispatchEvent(makeEvent("status", { status: s, attempt: this.attempt }));
    }

    /** 主動關閉（不再重連） */
    close(code, reason) {
      this._closedByUser = true;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this._stopHeartbeat();
      this._failOpen(new Error("已關閉"));
      if (this.ws) {
        try { this.ws.close(code || 1000, reason || ""); } catch (e) {}
      }
      this._setStatus("closed");
    }

    /** 關閉並清空所有 pending request */
    destroy() {
      this.close();
      this._pending.forEach((p) => p.reject(new Error("已關閉")));
      this._pending.clear();
      this._openPromise = null;
    }

    _log(...args) {
      if (this.opt.debug && global.console) console.log("[BattleComm]", ...args);
    }
  }

  const API = {
    BattleComm,
    C2S,
    S2C,
    VERSION,
    normalizeRoomKey,
    randomRoomKey,
    resolveWsUrl,
    randomId
  };

  global.BattleComm = BattleComm;
  global.BattleProtocol = { C2S, S2C, VERSION };
  global.BattleCommApi = API;

  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
