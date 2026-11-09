/**
 * BattleComm 的 ES Module 包裝。
 *   import { BattleComm } from "./js/comm.mjs";
 * 底層 comm.js 同時支援 <script src> 傳統載入（window.BattleComm）。
 */
import "./comm.js";

const g = globalThis;

export const BattleComm = g.BattleComm;
export const C2S = g.BattleProtocol.C2S;
export const S2C = g.BattleProtocol.S2C;
export const VERSION = g.BattleProtocol.VERSION;
export const normalizeRoomKey = g.BattleCommApi.normalizeRoomKey;
export const randomRoomKey = g.BattleCommApi.randomRoomKey;
export const resolveWsUrl = g.BattleCommApi.resolveWsUrl;
export const randomId = g.BattleCommApi.randomId;

export default BattleComm;
