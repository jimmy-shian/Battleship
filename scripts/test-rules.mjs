import {
  BOARDS, boardConfig, shipIdsOf, validateFleet, autoMissCells, isShipSunk,
  allShipsSunk, fleetCellMap, inBounds, cellKey, MARK
} from "../public/js/rules.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.error("  ✗ " + msg); } };

const s5 = boardConfig("s5");
const c10 = boardConfig("c10");

console.log("[1] 海域設定");
ok(s5.n === 5 && s5.adjacent === false, "s5: 5×5、不可相鄰");
ok(c10.n === 10 && c10.adjacent === true, "c10: 10×10、允許緊鄰（官方）");
ok(JSON.stringify(c10.ships) === JSON.stringify({ "5": 5, "4": 4, "3a": 3, "3b": 3, "2": 2 }), "c10 船隊 = 5/4/3/3/2（官方）");
ok(Object.values(c10.ships).reduce((a, b) => a + b, 0) === 17, "c10 共 17 格（官方）");

console.log("[2] 正版 10×10 佈陣（官方：允許緊鄰）");
// 兩艘船緊貼（Carrier A1-A5、Battleship B1-B4 直向相鄰）
const touch = {
  "5":  { r: 0, c: 0, d: "H" },   // A1-E1
  "4":  { r: 1, c: 0, d: "V" },   // A2-A5（與上面相鄰）
  "3a": { r: 5, c: 0, d: "H" },   // A6-C6
  "3b": { r: 7, c: 9, d: "V" },   // J8-J10
  "2":  { r: 9, c: 0, d: "H" }    // A10-B10
};
ok(validateFleet(touch, c10).ok, "緊鄰船隊合法（官方規則）");

const overlap = JSON.parse(JSON.stringify(touch));
overlap["4"] = { r: 0, c: 1, d: "H" }; // 與 Carrier 重疊
ok(!validateFleet(overlap, c10).ok, "重疊仍然禁止");
ok(!validateFleet({ ...touch, "5": { r: 8, c: 8, d: "H" } }, c10).ok, "超出邊界禁止");

console.log("[3] 簡易 5×5 佈陣（自家規則：不可相鄰含斜角）");
const gap = { "3": { r: 0, c: 0, d: "H" }, "2a": { r: 2, c: 0, d: "H" }, "2b": { r: 4, c: 0, d: "H" }, "1": { r: 0, c: 4, d: "V" } };
ok(validateFleet(gap, s5).ok, "間隔船隊合法");
const near = { ...gap, "2a": { r: 1, c: 0, d: "V" } };
ok(!validateFleet(near, s5).ok, "相鄰禁止（s5 維持現狀）");
ok(validateFleet(near, c10).ok === false, "s5 船隊放在 c10 缺船 → 不合法");

console.log("[4] 擊沉自動標註");
const fleetC10 = { "2": { r: 0, c: 0, d: "H" }, "5": { r: 5, c: 5, d: "H" } };
ok(autoMissCells(fleetC10, { "0,0": MARK.SUNK, "0,1": MARK.SUNK }, c10).size === 0, "c10 允許緊鄰 → 不自動標註周圍");
const ring = autoMissCells(gap, { "0,0": MARK.SUNK, "0,1": MARK.SUNK, "0,2": MARK.SUNK }, s5);
ok(ring.has("1,1") && ring.has("0,3"), "s5 擊沉後周圍一圈自動標落空");
ok(isShipSunk(fleetC10, "2", { "0,0": MARK.HIT, "0,1": MARK.HIT }, c10), "c10 擊沉判定正確");
ok(allShipsSunk(fleetC10, { "0,0": MARK.HIT, "0,1": MARK.HIT, "5,5": MARK.HIT, "5,6": MARK.HIT, "5,7": MARK.HIT, "5,8": MARK.HIT, "5,9": MARK.HIT }, c10).all, "c10 全滅判定正確");

console.log("[5] 座標");
ok(inBounds(9, 9, 10) && !inBounds(10, 0, 10), "10×10 邊界");
ok(fleetCellMap(fleetC10, c10)[cellKey(0, 1)]?.id === "2", "c10 fleetCellMap");

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
