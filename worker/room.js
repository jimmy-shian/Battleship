/*!
 * 海戰棋 — Durable Object：單一房間
 * -----------------------------------------------------------------------------
 * 每個「房間金鑰」對應一個 Durable Object 實例，負責：
 *   - 座位管理（最多 2 人，支援斷線重連回座）
 *   - 船隊驗證 / 鎖定
 *   - 回合與開火判定、擊沉自動標註
 *   - 結算（勝負、命中率、下一局）
 *   - 房內通訊訊息轉發
 *
 * 使用 WebSocket Hibernation API，空閒時不計費，適合免費方案。
 */
import { C2S, S2C, ERR, TURN_RULES, PROTOCOL_VERSION } from "../public/js/protocol.js";
import { buildRecord, saveArchive, listArchive, getArchive, clearArchive } from "./archive.js";
import {
  N,
  SHIP_IDS,
  SHIP_LEN,
  MARK,
  cellKey,
  parseCell,
  inBounds,
  cellsOf,
  validateFleet,
  isShipSunk,
  allShipsSunk,
  autoMissCells,
  buildEnemyBoard,
  summarize
} from "../public/js/rules.js";

const MAX_PLAYERS = 2;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;  // 房間閒置 6 小時後自動清除
const LEFT_GRACE_MS = 15 * 1000;         // 離線寬限：超過仍未歸就釋出座位

const clean = (s, max) => String(s == null ? "" : s).trim().slice(0, max || 24);
const normalizeKey = (k) => String(k == null ? "" : k).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 48);

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._loading = null;
  }

  /* ---------- 狀態存取 ---------- */

  async load() {
    if (!this._loading) {
      this._loading = (async () => {
        const s = await this.state.storage.get("room");
        if (s) {
          // 舊版資料相容：已離線但沒有 leftAt 的玩家，以房間最後更新時間回填，讓 sweep 能準時釋出其座位
          for (const p of s.players || []) {
            if (!p.online && !p.leftAt) p.leftAt = s.updatedAt || Date.now();
          }
          return s;
        }
        const fresh = {
          v: 1,
          key: "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          phase: "setup", // setup | battle | over
          turnRule: TURN_RULES.ALT,
          turn: null,
          firstSeat: 0,
          players: [],
          fired: {},
          marks: {},
          shots: [],        // 開火紀錄（回放／存檔用）
          startedAt: 0,     // 本局開戰時間
          archivedId: "",   // 已成功存檔的對局 ID
          over: null
        };
        await this.state.storage.put("room", fresh);
        return fresh;
      })();
    }
    return this._loading;
  }

  async save(s) {
    s.updatedAt = Date.now();
    this._loading = Promise.resolve(s);
    await this.state.storage.put("room", s);
    // 有人離線待清理 → 縮短 alarm，準時跑 sweep；否則維持 TTL 清理
    const anyOffline = (s.players || []).some((x) => !x.online);
    await this.state.storage.setAlarm(Date.now() + (anyOffline ? LEFT_GRACE_MS + 1000 : ROOM_TTL_MS));
  }

  async alarm() {
    const s = await this.load();
    if (Date.now() - (s.updatedAt || 0) > ROOM_TTL_MS) {
      await this.state.storage.deleteAll();
      this._loading = null;
      return;
    }
    const changed = await this.sweep(s);
    if (!changed) {
      const anyOffline = (s.players || []).some((x) => !x.online);
      await this.state.storage.setAlarm(Date.now() + (anyOffline ? LEFT_GRACE_MS + 1000 : ROOM_TTL_MS));
    }
  }

  /* ---------- HTTP / WebSocket 進入點 ---------- */

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleUpgrade(request, url);
    }
    if (url.pathname === "/state") {
      return this.handleState(url);
    }
    if (url.pathname === "/archive") {
      return this.handleArchiveList(url);
    }
    if (url.pathname === "/archive/clear" && request.method === "POST") {
      return this.handleArchiveClear();
    }
    if (url.pathname.startsWith("/archive/")) {
      return this.handleArchiveOne(url);
    }
    if (url.pathname === "/release" && request.method === "POST") {
      return this.handleRelease(request);
    }
    return new Response("not found", { status: 404 });
  }

  /* ---------- 釋出房間（房間數上限時由使用者選擇） ---------- */

  async handleRelease(request) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const userId = String(body.userId || "");
    const s = await this.load();
    const p = s.players.find((x) => x.userId === userId || x.clientId === userId);
    if (!p) return Response.json({ ok: true, removed: false });

    // 關閉該玩家的所有連線
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.playerId === p.id) {
        try { ws.close(1000, "released"); } catch (e) {}
      }
    }

    s.players = s.players.filter((x) => x.id !== p.id);
    delete s.fired[p.id];
    delete s.marks[p.id];
    if (s.players.length < MAX_PLAYERS && s.phase !== "setup") this.resetMatch(s, false);
    if (!s.players.length) this.resetRoom(s);
    await this.save(s);
    this.broadcast({ t: S2C.PLAYER, event: "leave", player: publicPlayer(p) });
    await this.broadcastState();
    return Response.json({ ok: true, removed: true, room: s.key });
  }

  /* ---------- 清空戰績 ---------- */

  async handleArchiveClear() {
    const s = await this.load();
    const res = await clearArchive(this.state, this.env, s.key);
    return Response.json({ ok: true, room: s.key, removed: res.do + res.r2 });
  }

  /* ---------- 戰績存檔 API（由 Worker 轉發） ---------- */

  async handleArchiveList(url) {
    const s = await this.load();
    const limit = url.searchParams.get("limit");
    const matches = await listArchive(this.state, this.env, s.key, limit);
    return Response.json({ ok: true, room: s.key, count: matches.length, matches });
  }

  async handleArchiveOne(url) {
    const s = await this.load();
    const id = decodeURIComponent(url.pathname.slice("/archive/".length)).replace(/[^0-9a-zA-Z_-]/g, "");
    if (!id) return Response.json({ error: "missing id" }, { status: 400 });
    const match = await getArchive(this.state, this.env, s.key, id);
    if (!match) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true, match });
  }

  async handleState(url) {
    const s = await this.load();
    const key = normalizeKey(url.searchParams.get("key"));
    if (key && !s.key) {
      s.key = key;
      await this.save(s);
    }
    // 大廳輪詢房間概況時，順便清掉逾時未歸的玩家（房間顯示即時淨空）
    await this.sweep(s);
    return Response.json({
      key: s.key,
      phase: s.phase,
      turnRule: s.turnRule,
      turn: s.turn,
      full: s.players.length >= MAX_PLAYERS && s.players.every((p) => p.online),
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        ready: p.ready,
        online: p.online
      }))
    });
  }

  async handleUpgrade(request, url) {
    const key = normalizeKey(url.searchParams.get("key"));
    if (!key) return new Response("missing key", { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const s = await this.load();
    if (!s.key) {
      s.key = key;
      await this.save(s);
    }

    const connId = crypto.randomUUID();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ connId, key, playerId: null });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- Hibernation 事件 ---------- */

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg.t !== "string") return;
    try {
      await this.onMessage(ws, att, msg);
    } catch (err) {
      this.sendTo(ws, { t: S2C.ERROR, code: ERR.BAD_REQUEST, message: "伺服器錯誤：" + (err && err.message) });
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    await this.onDisconnect(ws, att);
  }

  async webSocketError(ws) {
    const att = ws.deserializeAttachment() || {};
    await this.onDisconnect(ws, att);
  }

  /* ---------- 訊息處理 ---------- */

  async onMessage(ws, att, msg) {
    switch (msg.t) {
      case C2S.HELLO: return this.onHello(ws, att, msg);
      case C2S.READY: return this.onReady(ws, att, msg);
      case C2S.UNREADY: return this.onUnready(ws, att);
      case C2S.FIRE: return this.onFire(ws, att, msg);
      case C2S.ANNOTATE: return this.onAnnotate(ws, att, msg);
      case C2S.CLEAR_MARKS: return this.onClearMarks(ws, att);
      case C2S.CHAT: return this.onChat(ws, att, msg);
      case C2S.SETTINGS: return this.onSettings(ws, att, msg);
      case C2S.REMATCH: return this.onRematch(ws, att, msg);
      case C2S.RESET: return this.onReset(ws, att);
      case C2S.PING:
        return this.sendTo(ws, { t: S2C.PONG, at: msg.at || Date.now() });
      default:
        return this.sendTo(ws, { t: S2C.ERROR, code: ERR.BAD_REQUEST, message: "未知的訊息類型" });
    }
  }

  async onHello(ws, att, msg) {
    const s = await this.load();
    const key = normalizeKey(msg.key || att.key);
    if (key && s.key && key !== s.key) {
      this.sendTo(ws, { t: S2C.ERROR, code: ERR.NO_KEY, message: "房間金鑰不符" });
      return;
    }
    const name = clean(msg.name || "玩家", 16) || "玩家";
    const clientId = clean(msg.clientId, 64);
    const userId = clean(msg.userId, 64);
    console.log("[room]", s.key, "| hello:", name, "players=", s.players.length, "phase=", s.phase);

    // 房間內已經沒有任何玩家 → 重置為全新房間（保留金鑰與戰績存檔）
    if (!s.players.length) this.resetRoom(s);

    // 進房時可一併指定回合規則（僅佈陣階段有效）
    if (s.phase === "setup" && msg.turnRule) {
      s.turnRule = msg.turnRule === TURN_RULES.KEEP ? TURN_RULES.KEEP : TURN_RULES.ALT;
    }

    let player = s.players.find((p) => clientId && p.clientId === clientId);
    let event = "join";
    let matchReset = false;

    if (player) {
      // 重連：認回原座位（船隊、佈陣狀態、進行中的戰局全部保留）
      player.name = name;
      player.online = true;
      player.leftAt = 0;
      if (userId) player.userId = userId;
    } else {
      // 房間數上限：每位使用者最多 3 個房間，超過就請使用者選一個釋出
      const gate = await this.checkRoomQuota(userId, s.key, name);
      if (!gate.ok) {
        this.sendTo(ws, {
          t: S2C.ERROR,
          code: ERR.TOO_MANY_ROOMS,
          message: gate.message || "房間數已達上限（最多 3 個）",
          rooms: gate.rooms || []
        });
        ws.close(1013, "too many rooms");
        return;
      }

      const offline = s.players.find((p) => !p.online);
      if (offline) {
        // 接管離線者的座位：座位整個重置，不繼承前一位的船隊與佈陣狀態
        player = offline;
        player.name = name;
        player.clientId = clientId;
        player.userId = userId;
        player.online = true;
        player.leftAt = 0;
        player.fleet = {};
        player.ready = false;
        event = "takeover";
      } else if (s.players.length < MAX_PLAYERS) {
        player = {
          id: "p" + s.players.length + "_" + crypto.randomUUID().slice(0, 8),
          name,
          clientId,
          userId,
          seat: s.players.length,
          fleet: {},
          ready: false,
          online: true,
          leftAt: 0
        };
        s.players.push(player);
      } else {
        this.sendTo(ws, { t: S2C.ERROR, code: ERR.ROOM_FULL, message: "房間人數已滿（最多 2 人）" });
        ws.close(1013, "room full");
        return;
      }

      // 新座位／接管座位：若上一場對局還掛著（前一位離開後殘留），整場重算
      if (s.phase !== "setup") {
        this.resetMatch(s, false);
        matchReset = true;
      }
    }

    att.playerId = player.id;
    ws.serializeAttachment(att);

    s.fired[player.id] = s.fired[player.id] || {};
    s.marks[player.id] = s.marks[player.id] || {};
    if (s.phase === "battle" && !s.turn) s.turn = s.players[0].id;

    await this.save(s);

    this.sendTo(ws, {
      t: S2C.WELCOME,
      you: player.id,
      key: s.key,
      v: PROTOCOL_VERSION,
      server: { now: Date.now(), maxPlayers: MAX_PLAYERS },
      rules: {
        turnRule: s.turnRule,
        phase: s.phase,
        shipLen: SHIP_LEN
      }
    });

    if (matchReset) {
      this.broadcast({ t: S2C.RESET, reason: "player_change" });
    }

    this.broadcast({ t: S2C.PLAYER, event, player: publicPlayer(player) }, ws);
    await this.broadcastState();
  }

  async onReady(ws, att, msg) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    console.log("[room]", s.key, "| ready:", p ? p.name : att.playerId, "phase=", s.phase, "players=", JSON.stringify(s.players.map((x) => x.name + ":" + x.ready)));
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    if (s.phase !== "setup") return this.err(ws, ERR.BAD_PHASE, "現在不能重新佈陣");
    const v = validateFleet(msg.fleet);
    if (!v.ok) return this.err(ws, ERR.INVALID_FLEET, v.reason);

    p.fleet = sanitizeFleet(msg.fleet);
    p.ready = true;
    await this.save(s);

    if (s.players.length === MAX_PLAYERS && s.players.every((x) => x.ready && x.fleet && Object.keys(x.fleet).length === SHIP_IDS.length)) {
      s.phase = "battle";
      s.startedAt = Date.now();
      s.shots = [];
      s.archivedId = "";
      const first = s.players[s.firstSeat % s.players.length];
      s.turn = first ? first.id : null;
    }
    await this.save(s);
    await this.broadcastState();
  }

  async onUnready(ws, att) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    if (s.phase !== "setup") return this.err(ws, ERR.BAD_PHASE, "遊戲已經開始");
    p.ready = false;
    await this.save(s);
    await this.broadcastState();
  }

  async onFire(ws, att, msg) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    if (s.phase !== "battle") return this.err(ws, ERR.BAD_PHASE, "戰局尚未開始");
    if (s.turn !== p.id) return this.err(ws, ERR.NOT_YOUR_TURN, "還不是你的回合");

    const cell = String(msg.cell || "");
    const [r, c] = parseCell(cell);
    if (!cell || !inBounds(r, c)) return this.err(ws, ERR.INVALID_CELL, "座標無效");

    s.fired[p.id] = s.fired[p.id] || {};
    if (s.fired[p.id][cell] !== undefined) return this.err(ws, ERR.ALREADY_FIRED, "這個位置已經打過了");

    const opp = this.opponentOf(s, p.id);
    if (!opp) return this.err(ws, ERR.BAD_PHASE, "等待對手加入");
    if (!opp.online) return this.err(ws, ERR.OPPONENT_NOT_READY, "對手已離線，這局無法繼續，稍候會自動重開");
    if (!opp.ready || !opp.fleet || !Object.keys(opp.fleet).length) {
      return this.err(ws, ERR.OPPONENT_NOT_READY, "對手尚未完成佈陣");
    }

    // 判定命中
    const shipId = this.shipAt(opp.fleet, r, c);
    let result = MARK.MISS;
    let sunk = null;

    if (shipId) {
      result = MARK.HIT;
      s.fired[p.id][cell] = MARK.HIT;
      if (isShipSunk(opp.fleet, shipId, s.fired[p.id])) {
        sunk = { id: shipId, r: opp.fleet[shipId].r, c: opp.fleet[shipId].c, d: opp.fleet[shipId].d, len: SHIP_LEN[shipId] };
        for (const [rr, cc] of cellsOf(opp.fleet[shipId], SHIP_LEN[shipId])) {
          s.fired[p.id][cellKey(rr, cc)] = MARK.SUNK;
        }
      }
    } else {
      s.fired[p.id][cell] = MARK.MISS;
    }

    // 開火紀錄（存檔／回放用）
    s.shots = s.shots || [];
    s.shots.push({ by: p.id, cell, result, at: Date.now() });

    // 結算
    const sink = allShipsSunk(opp.fleet, s.fired[p.id]);
    let over = null;
    if (sink.all) {
      over = { winner: p.id, loser: opp.id, at: Date.now(), reason: "all_sunk" };
      s.over = over;
      s.phase = "over";
    } else if (s.turnRule === TURN_RULES.KEEP && result >= MARK.HIT) {
      // 命中續打：維持回合
    } else {
      s.turn = opp.id;
    }

    await this.save(s);

    this.broadcast({
      t: S2C.FIRE,
      by: p.id,
      byName: p.name,
      cell,
      result,
      sunk,
      over
    });
    await this.broadcastState();

    if (over) await this.archive(s, over);
  }

  /* ---------- 戰績存檔 ---------- */

  /** 結算後把本局寫進存檔（R2 + DO SQLite） */
  async archive(s, over) {
    const id = String(over.at);
    if (s.archivedId === id) return;
    try {
      const rec = buildRecord(s, over);
      const res = await saveArchive(this.state, this.env, rec);
      s.archivedId = id;
      await this.save(s);
      console.log("[archive]", s.key, "| 已存檔", id, res.r2 ? "(R2 + DO)" : "(DO)");
    } catch (e) {
      console.error("[archive] 存檔失敗:", e && e.message);
    }
  }

  async onAnnotate(ws, att, msg) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    const cell = String(msg.cell || "");
    const [r, c] = parseCell(cell);
    if (!cell || !inBounds(r, c)) return this.err(ws, ERR.INVALID_CELL, "座標無效");
    const value = Math.max(0, Math.min(3, Number(msg.value) || 0));

    s.marks[p.id] = s.marks[p.id] || {};
    if (value === 0) delete s.marks[p.id][cell];
    else s.marks[p.id][cell] = value;

    await this.save(s);
    this.broadcast({ t: S2C.ANNOTATE, by: p.id, cell, value });
    await this.broadcastState();
  }

  async onClearMarks(ws, att) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    s.marks[p.id] = {};
    await this.save(s);
    await this.broadcastState();
  }

  async onChat(ws, att, msg) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    const text = clean(msg.text, 300);
    if (!text) return;
    this.broadcast({ t: S2C.CHAT, from: p.name, fromId: p.id, text, at: Date.now() });
  }

  async onSettings(ws, att, msg) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    if (s.phase !== "setup") return this.err(ws, ERR.BAD_PHASE, "遊戲開始後不能更換規則");
    const rule = msg.turnRule === TURN_RULES.KEEP ? TURN_RULES.KEEP : TURN_RULES.ALT;
    s.turnRule = rule;
    await this.save(s);
    await this.broadcastState();
  }

  async onRematch(ws, att, msg) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    if (s.phase !== "over") return this.err(ws, ERR.BAD_PHASE, "這一局還沒結束");

    // 若上一局尚未存檔成功（例如 R2 暫時故障），先補存
    if (s.over && s.archivedId !== String(s.over.at)) {
      await this.archive(s, s.over);
    }

    const keepFleet = msg.keepFleet !== false;
    s.fired = {};
    s.marks = {};
    s.shots = [];
    s.startedAt = 0;
    s.archivedId = "";
    s.over = null;
    for (const x of s.players) {
      s.fired[x.id] = {};
      s.marks[x.id] = {};
      if (!keepFleet) {
        x.fleet = {};
        x.ready = false;
      }
    }
    const allReady = s.players.length === MAX_PLAYERS && s.players.every((x) => x.ready && Object.keys(x.fleet || {}).length === SHIP_IDS.length);
    s.phase = allReady ? "battle" : "setup";
    s.firstSeat = (s.firstSeat + 1) % Math.max(1, s.players.length);
    const first = s.players[s.firstSeat % Math.max(1, s.players.length)];
    s.turn = s.phase === "battle" && first ? first.id : null;
    if (s.phase === "battle") s.startedAt = Date.now();

    await this.save(s);
    this.broadcast({ t: S2C.REMATCH, keepFleet });
    await this.broadcastState();
  }

  /** 重開對局：任何階段皆可，保留雙方船艦，但需重新鎖定 */
  async onReset(ws, att) {
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return this.err(ws, ERR.NOT_JOINED, "你還沒加入房間");
    if (s.over && s.archivedId !== String(s.over.at)) {
      await this.archive(s, s.over); // 先把打完的這局補進存檔
    }
    this.resetMatch(s, true);
    await this.save(s);
    this.broadcast({ t: S2C.RESET, by: p.name });
    await this.broadcastState();
  }

  /* ---------- 對局／房間重置 ---------- */

  /** 重置本場對局：清掉炮擊、標註、回合與結算；fleets 與 ready 依 clearReady 決定 */
  resetMatch(s, clearReady) {
    s.fired = {};
    s.marks = {};
    s.shots = [];
    s.startedAt = 0;
    s.archivedId = "";
    s.over = null;
    s.phase = "setup";
    s.turn = null;
    for (const x of s.players) {
      s.fired[x.id] = {};
      s.marks[x.id] = {};
      if (clearReady) x.ready = false;
    }
  }

  /** 房間淨空 → 回到全新狀態（保留金鑰、海域模式與戰績存檔） */
  resetRoom(s) {
    s.phase = "setup";
    s.turn = null;
    s.firstSeat = 0;
    s.players = [];
    s.fired = {};
    s.marks = {};
    s.shots = [];
    s.startedAt = 0;
    s.archivedId = "";
    s.over = null;
  }

  /* ---------- 離線清理 ---------- */

  /**
   * 把「離線超過寬限期」的玩家移出房間並釋出座位：
   *   - 對局無法繼續（少於 2 人）→ 重置為佈陣階段（留下來的人船艦與佈陣狀態保留）。
   *   - 房間完全淨空 → 整間房重置。
   * 回傳是否有清理（有清理時已廣播狀態）。
   */
  async sweep(s) {
    const now = Date.now();
    const gone = s.players.filter((x) => !x.online && x.leftAt && now - (x.leftAt || 0) > LEFT_GRACE_MS);
    if (!gone.length) return false;

    const ids = new Set(gone.map((x) => x.id));
    s.players = s.players.filter((x) => !ids.has(x.id));
    for (const x of gone) {
      delete s.fired[x.id];
      delete s.marks[x.id];
    }
    if (s.players.length < MAX_PLAYERS && s.phase !== "setup") this.resetMatch(s, false);
    if (!s.players.length) this.resetRoom(s);
    await this.save(s);

    for (const x of gone) {
      this.broadcast({ t: S2C.PLAYER, event: "removed", player: publicPlayer(x) });
    }
    await this.broadcastState();
    console.log("[room]", s.key, "| sweep 移出離線玩家:", gone.map((x) => x.name).join("、"));
    return true;
  }

  /* ---------- 斷線 ---------- */

  async onDisconnect(ws, att) {
    if (!att || !att.playerId) return;
    const s = await this.load();
    const p = this.playerOf(s, att.playerId);
    if (!p) return;
    // 若同一玩家還有其他連線（例如重連時舊連線較晚關閉），不算離線
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      const a = other.deserializeAttachment() || {};
      if (a.playerId === p.id) return;
    }
    p.online = false;
    p.leftAt = Date.now();
    await this.save(s);
    this.broadcast({ t: S2C.PLAYER, event: "leave", player: publicPlayer(p) });
    await this.broadcastState();
  }

  /* ---------- 房間數上限（每位使用者最多 3 個房間） ---------- */

  async checkRoomQuota(userId, room, name) {
    if (!this.env.REGISTRY || !userId) return { ok: true };
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
      const res = await reg.fetch(
        new Request("https://registry/join", {
          method: "POST",
          body: JSON.stringify({ userId, room, name })
        })
      );
      const data = await res.json();
      if (data && data.ok) return { ok: true };
      return {
        ok: false,
        message: `房間數已達上限（最多 ${data.max || 3} 個），請選一個房間釋出`,
        rooms: data.rooms || []
      };
    } catch (e) {
      console.error("[registry] 查詢失敗（放行）:", e && e.message);
      return { ok: true };
    }
  }

  /* ---------- 檢視（每位玩家看到的內容） ---------- */

  viewFor(s, playerId) {
    const me = this.playerOf(s, playerId);
    const opp = this.opponentOf(s, playerId);
    const myFired = s.fired[playerId] || {};
    const oppFired = opp ? (s.fired[opp.id] || {}) : {};
    const enemyFleet = opp ? opp.fleet || {} : {};
    const myFleet = me ? me.fleet || {} : {};

    const enemyBoard = buildEnemyBoard({
      fired: myFired,
      enemyFleet,
      marks: s.marks[playerId] || {}
    });

    // 自己海域收到的炮擊（對手的 fired 記錄）
    const incoming = {};
    for (const k in oppFired) incoming[k] = oppFired[k];

    // 擊沉的船（自動標註）
    const sunkShips = [];
    if (opp) {
      for (const id of SHIP_IDS) {
        if (!enemyFleet[id]) continue;
        if (isShipSunk(enemyFleet, id, myFired)) {
          sunkShips.push({ id, r: enemyFleet[id].r, c: enemyFleet[id].c, d: enemyFleet[id].d, len: SHIP_LEN[id] });
        }
      }
    }

    // 自動標註（擊沉船周圍一圈落空），排除已經實際開火過的格子
    const autoMarks = [];
    for (const k of autoMissCells(enemyFleet, myFired)) {
      if (myFired[k] === undefined) autoMarks.push(k);
    }

    const myStats = summarize(myFired);
    const oppStats = summarize(oppFired);

    return {
      t: S2C.STATE,
      v: PROTOCOL_VERSION,
      key: s.key,
      phase: s.phase,
      turnRule: s.turnRule,
      turn: s.turn,
      over: s.over,
      you: playerId,
      players: s.players.map((x) => Object.assign(publicPlayer(x), { isYou: x.id === playerId })),
      mine: {
        fleet: myFleet,
        ready: !!(me && me.ready),
        incoming,
        stats: myStats
      },
      enemy: {
        board: enemyBoard,
        autoMarks,
        sunkShips,
        ready: !!(opp && opp.ready),
        fleet: s.phase === "over" && opp ? opp.fleet || {} : null,
        stats: oppStats
      },
      marks: s.marks[playerId] || {},
      canFire: s.phase === "battle" && s.turn === playerId
    };
  }

  async broadcastState() {
    const s = await this.load();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (!att.playerId) continue;
      this.sendTo(ws, this.viewFor(s, att.playerId));
    }
  }

  /* ---------- 工具 ---------- */

  playerOf(s, id) {
    if (!id) return null;
    return s.players.find((p) => p.id === id) || null;
  }

  opponentOf(s, id) {
    return s.players.find((p) => p.id !== id) || null;
  }

  shipAt(fleet, r, c) {
    for (const id of SHIP_IDS) {
      const p = fleet[id];
      if (!p) continue;
      for (const [rr, cc] of cellsOf(p, SHIP_LEN[id])) {
        if (rr === r && cc === c) return id;
      }
    }
    return null;
  }

  err(ws, code, message) {
    this.sendTo(ws, { t: S2C.ERROR, code, message });
  }

  sendTo(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch (e) {}
  }

  broadcast(msg, exceptWs) {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (exceptWs && ws === exceptWs) continue;
      try { ws.send(data); } catch (e) {}
    }
  }
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, seat: p.seat, ready: p.ready, online: p.online };
}

function sanitizeFleet(fleet) {
  const out = {};
  for (const id of SHIP_IDS) {
    const p = fleet[id];
    if (!p) continue;
    out[id] = { r: p.r | 0, c: p.c | 0, d: p.d === "V" ? "V" : "H" };
  }
  return out;
}
