# 海戰棋 · 雲端多人連線版

> 單機對戰／記分工具 **+** 免費雲端多人連線對戰
> 技術棧：原生 HTML/CSS/JS + Cloudflare Workers + Durable Objects（WebSocket）

線上版：**https://battleship-online.jimmy910824.workers.dev**

---

## 1. 三個主要部分

| # | 檔案 | 說明 |
|---|------|------|
| 1 | `public/index.html` | **大廳**（登入主頁）：從固定三間房選一間（Room1／Room2／Room3）、填暱稱、複製邀請連結、查看房間人數 |
| 2 | `public/board.html` | **新盤面**（連線對戰）：船艦佈陣、開火、自動標註、回合、通訊、結算。**刻意不含「紀錄」區塊** |
| 3 | `public/js/comm.js` | **通訊模組**：獨立、零相依、可直接引用到其他專案的 WebSocket 通訊端 |
| ＋ | `public/history.html` | **戰績存檔**：查詢房間過往對局、明細與逐步回放（獨立頁面，不影響新盤面版面） |

另外保留原本的 `battleship.html`（單人遊玩／本地紀錄，離線可用），內容完全未更動。

---

## 2. 目錄結構

```
Battleship/
├─ battleship.html          # 原單機版（未更動，單人遊玩 + 紀錄）
├─ index.html → public/     # 大廳
├─ board.html → public/     # 新盤面
├─ public/                  # 部署用的靜態網站根目錄
│  ├─ index.html            # 大廳
│  ├─ board.html            # 連線新盤面
│  ├─ history.html          # 戰績存檔（查詢 / 明細 / 回放）
│  ├─ battleship.html       # 單機版副本（由 scripts/sync-assets.mjs 同步）
│  ├─ css/{base,lobby,board,history}.css
│  └─ js/
│     ├─ comm.js            # ★ 通訊模組（可直接引用）
│     ├─ comm.mjs           # 通訊模組的 ES Module 包裝
│     ├─ protocol.js        # 訊息協定常數（前端 + Worker 共用）
│     ├─ rules.js           # 遊戲規則純函式（前端 + Worker 共用）
│     ├─ user.js            # 使用者識別碼（房間數上限用）
│     ├─ lobby.js           # 大廳邏輯
│     ├─ board.js           # 新盤面邏輯（含聚光燈導覽）
│     └─ history.js         # 戰績存檔頁邏輯（含回放）
├─ worker/
│  ├─ index.js              # Worker 進入點：/ws、/api/room/:key、/api/archive/:key、/api/registry/*、/api/health
│  ├─ room.js               # Durable Object：房間 / 回合 / 結算
│  ├─ archive.js            # 戰績存檔：R2 + Durable Object SQLite（雙後端合併）
│  └─ registry.js           # Registry Durable Object：房間數登記簿（每人最多 3 個房間）
├─ scripts/sync-assets.mjs  # 把 battleship.html 同步到 public/
├─ wrangler.toml            # Cloudflare 設定
└─ package.json
```

> `public/js/rules.js` 與 `public/js/protocol.js` 同時被瀏覽器與 Worker import，
> 確保「自動標註位置」「結算判定」前後端完全一致，不會各算各的。

---

## 3. 本機開發

```bash
npm install
npm run dev          # http://127.0.0.1:8787
```

開兩個分頁（不同分頁 = 不同玩家），選**同一間房**（Room1／Room2／Room3）即可開打。

| 指令 | 說明 |
|------|------|
| `npm run dev` | 本機啟動 Worker + Durable Objects + 靜態網站 |
| `npm run deploy` | 同步單機版後部署到 Cloudflare |
| `npm run tail` | 即時查看 Worker 日誌 |
| `npm run check` | 只做打包檢查，不實際部署 |

---

## 4. 部署

```bash
$env:CLOUDFLARE_API_TOKEN = "<你的 API Token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<你的 Account ID>"
npm run deploy
```

`wrangler.toml` 已設定好：

* 靜態網站 → `public/`（免費）
* 每個「房間金鑰」→ 一個 Durable Object（SQLite 儲存，免費方案可用）
* 使用 **WebSocket Hibernation API**，房間閒置時不佔用運算資源
* 房間閒置 6 小時自動清除

### 免費額度（Workers Free）

| 項目 | 免費額度 |
|------|----------|
| Durable Object 請求 | 100,000 次／天 |
| Durable Object 運算時間 | 13,000 GB-秒／天 |
| Workers 請求 | 100,000 次／天 |
| R2 儲存量 | 10 GB |
| R2 Class A（寫入／列舉） | 100 萬次／月 |
| R2 Class B（讀取） | 1,000 萬次／月 |

兩個人一場遊戲的流量極低（每次開火只有幾個 WebSocket 訊息），
一般使用量遠低於免費額度。

---

## 5. 遊戲流程

1. **大廳**：從固定三間房選一間（Room1／Room2／Room3）、填暱稱 → 進入房間
2. **佈陣**：拖曳船艦到「我的海域」，四艘擺好後按「鎖定船艦」
3. **對戰**：輪到誰，誰就點「敵方海域」的格子開火
4. **自動標註**：擊沉一艘船後，該船周圍一圈自動標為落空
5. **結算**：擊沉對方全部船艦即結束，顯示雙方出擊／命中／命中率，可一鍵再戰
6. **存檔**：結算後自動寫入戰績存檔，可到「戰績存檔」頁查詢明細並逐步回放

### 固定三間房：Room1／Room2／Room3

* 全系統只有三間房，房號**固定**：`ROOM1`、`ROOM2`、`ROOM3`（大廳下拉選單選擇）。
* 每間房同時一場對戰（2 人），第三位進入會收到「房間已滿」。
* 兩人選同一間房就會對戰；點盤面右上角的**房號即可複製**，貼給朋友就能一起玩。
* 戰績每間房最多保留 **100 筆**：第 101 局完成時，後端自動刪除最舊的一筆（含完整紀錄）。

### 回合規則

* **輪流交替**（預設）：每次開火後換人，對應原單機版「輪流喊一個座標」
* **命中續打**：命中或擊沉則繼續開火，未中才換人

佈陣階段雙方皆可透過下拉選單更改規則。

### 手動標註

開啟「標註模式」後可自行在敵方海域記錄推測的落空／命中／擊沉，
僅供參考，**不影響伺服器的判定結果**。

---

## 6. 戰績存檔（R2）

每次結算後，伺服器會自動把整局資料寫進存檔，之後可在
**「戰績存檔」**頁（`/history.html`）輸入房間金鑰查詢、查看明細並逐步回放。

### 存檔內容

```jsonc
{
  "v": 1,
  "id": "1758000000000",       // 對局 ID（結算時間）
  "room": "BS-3F9K2A",
  "at": 1758000000000,
  "startedAt": 1757999000000,
  "durationMs": 1000000,       // 本局長度
  "turnRule": "alt",           // alt 輪流交替 / keep 命中續打
  "winner": { "id": "p0_xxx", "name": "小明" },
  "loser":  { "id": "p1_xxx", "name": "小華" },
  "players": [
    { "id": "p0_xxx", "name": "小明", "seat": 0,
      "fleet": { "3": { "r": 0, "c": 0, "d": "H" }, "...": {} },
      "stats": { "shots": 8, "hits": 8, "sunk": 8, "rate": 100 } }
  ],
  "shots": [ { "by": "p0_xxx", "cell": "2,3", "result": 2, "at": 1757999500000 } ]
}
```

### 雙後端設計（永遠有資料可讀）

| 後端 | 說明 |
|------|------|
| Durable Object SQLite | 每個房間金鑰的 DO 內建儲存，**永遠啟用**，作為永久備援 |
| Cloudflare R2 | `env.ARCHIVE` 綁定存在時同步寫入 `matches/<房間金鑰>/<對局ID>.json` |

讀取時兩邊合併（以對局 ID 去重、由新到舊排序），
因此 **R2 尚未啟用也能正常查詢與回放；日後啟用 R2 後既有紀錄不會遺失**。

### 啟用 R2（一次性）

R2 必須先在 Cloudflare Dashboard 啟用（API 無法開啟）：

1. 打開 <https://dash.cloudflare.com/a15d72eeeeb7e893984ffe95ad672267/r2/overview> → **Get started** → 啟用
2. 建立 bucket：

   ```bash
   npx wrangler r2 bucket create battleship-archive
   npx wrangler r2 bucket create battleship-archive-dev
   ```

3. 取消 `wrangler.toml` 中 `[[r2_buckets]]` 三行的註解
4. `npm run deploy`

啟用後新產生的對局會同時寫入 R2 與 DO，舊對局則由 DO 提供，
兩邊自動合併、不重複。

### 戰績 API

| 路徑 | 說明 |
|------|------|
| `GET /api/archive/:key` | 該房間的對局摘要列表（`{ ok, room, count, matches[] }`） |
| `GET /api/archive/:key/:id` | 單局完整紀錄（含船位與開火紀錄，供回放） |
| `POST /api/archive/:key/clear` | 清空該房間的所有戰績（回傳被刪除的筆數） |

> 存取權限以「房間金鑰」為準：知道金鑰的人就能查看該房間的戰績。
> 清空可在「戰績存檔」頁點右上角的「清空」按鈕。

---

## 7. 房間數登記簿 API（內部保留）

固定房號制之下，大廳已不再使用登記簿；端點保留供除錯／日後擴充：

| 路徑 | 說明 |
|------|------|
| `GET /api/registry/rooms?userId=...` | 查詢該使用者目前登記的房間（`{ ok, max, rooms[] }`） |
| `POST /api/registry/release` | 把該使用者移出某房間（釋出座位） |

---

## 8. ★ 通訊模組（`public/js/comm.js`）

零外部相依，只用瀏覽器原生 WebSocket。可直接複製到任何專案使用。

### 載入方式

```html
<!-- 方式 A：傳統 script（掛在 window.BattleComm） -->
<script src="js/comm.js"></script>
<script>
  const comm = new BattleComm({ url: "wss://your-worker.workers.dev" });
  comm.on("state", (e) => console.log(e.detail));
  comm.join({ key: "ROOM1", name: "小明" });
</script>
```

```js
// 方式 B：ES Module
import { BattleComm } from "./js/comm.mjs";
```

### 建構參數

| 參數 | 預設 | 說明 |
|------|------|------|
| `url` | `null` | 伺服器 base url；`null` = 使用目前頁面同網域 |
| `key` | `""` | 房間金鑰 |
| `name` | `""` | 暱稱 |
| `clientId` | 自動產生 | 穩定識別碼，斷線重連後靠它認回座位 |
| `userId` | `null` | 使用者層級識別碼（選填），房間數上限用 |
| `turnRule` | `null` | `"alt"` / `"keep"`，進房時一併送出 |
| `autoReconnect` | `true` | 斷線自動重連（指數退避 + 抖動） |
| `reconnectBaseDelay` | `1000` | 重連初始延遲（ms） |
| `reconnectMaxDelay` | `15000` | 重連最大延遲（ms） |
| `heartbeatInterval` | `20000` | 心跳間隔（ms） |
| `heartbeatTimeout` | `10000` | 心跳逾時（ms），逾時即重連 |
| `requestTimeout` | `10000` | `request()` 逾時（ms） |

### 方法

| 方法 | 說明 |
|------|------|
| `join({ key, name, clientId })` | 設定參數並連線，回傳 `Promise`（收到 `welcome` 後 resolve） |
| `connect()` | 建立 WebSocket 連線 |
| `send(type, payload)` | 送出任意訊息，回傳是否成功送出 |
| `send(type, payload, { queue: true })` | 連線中時先暫存，連線成功後自動補送（不該遺失的訊息用） |
| `request(type, payload, timeout)` | Promise 化的請求／回應（伺服器需回傳相同 `id`） |
| `on(type, handler)` | 訂閱事件，回傳取消訂閱函式 |
| `close(code, reason)` | 主動關閉（不再重連） |
| `destroy()` | 關閉並清空 pending request |

### 遊戲高階 API

```js
comm.ready(fleet);        // 送出船隊並鎖定
comm.unready();           // 取消鎖定
comm.fire("2,3");         // 對敵方海域開火
comm.annotate("2,3", 2);  // 手動標註（0 清除 / 1 落空 / 2 命中 / 3 擊沉）
comm.clearMarks();        // 清除自己的標註
comm.chat("打到最後一艘了！");
comm.setTurnRule("keep");
comm.rematch(true);       // 再戰一局
```

### 事件

所有伺服器訊息都會派發 `message` 事件（`detail` 為完整訊息物件），
並額外依 `msg.t` 派發同名事件：

| 事件 | 觸發時機 |
|------|----------|
| `status` | 連線狀態變化：`detail.status` = `idle / connecting / open / reconnecting / closed` |
| `socket` | Socket 生命週期：`detail.phase` = `connecting / open / close` |
| `welcome` | 成功進房，`detail.you` = 你的玩家代號 |
| `state` | 任何戰局變化（完整快照） |
| `player` | 有人加入／離線／接管座位 |
| `fire` | 有人開火，`detail.result` = 1 落空 / 2 命中 / 3 擊沉 |
| `annotate` | 有人手動標註 |
| `chat` | 有人送出通訊訊息 |
| `rematch` | 開始新的一局 |
| `error` | 伺服器錯誤，`detail.message` = 原因 |
| `pong` | 心跳回應 |

### 其他工具

```js
import { normalizeRoomKey, resolveWsUrl } from "./js/comm.mjs";

normalizeRoomKey("room2");       // "ROOM2"（只接受固定三房）
normalizeRoomKey("BS-3F9K2A");   // ""（不再使用隨機房號）
resolveWsUrl("https://x.workers.dev"); // "wss://x.workers.dev/ws"
```

### 除錯

連線新盤面在瀏覽器主控台提供 `window.__bs`：

```js
__bs.state          // 最近一次伺服器快照
__bs.comm.status    // 連線狀態
__bs.comm.ws        // 原始 WebSocket 物件
```

---

## 9. 訊息協定

所有訊息皆為 JSON，`t` 為類型。

### Client → Server

| `t` | 內容 |
|-----|------|
| `hello` | `{ key, name, clientId, turnRule, v }` |
| `ready` | `{ fleet }` |
| `unready` | `{}` |
| `fire` | `{ cell }`（`"r,c"`，0 為基準） |
| `annotate` | `{ cell, value }` |
| `clearMarks` | `{}` |
| `chat` | `{ text }` |
| `settings` | `{ turnRule }` |
| `rematch` | `{ keepFleet }` |
| `ping` | `{ at }` |

### Server → Client

| `t` | 內容 |
|-----|------|
| `welcome` | `{ you, key, server, rules }` |
| `state` | 完整戰局快照（每位玩家看到的內容不同） |
| `player` | `{ event, player }` |
| `fire` | `{ by, byName, cell, result, sunk, over }` |
| `annotate` | `{ by, cell, value }` |
| `chat` | `{ from, fromId, text, at }` |
| `rematch` | `{ keepFleet }` |
| `error` | `{ code, message }` |
| `pong` | `{ at }` |

### 伺服器端點

| 路徑 | 說明 |
|------|------|
| `GET /ws?key=XXX` | WebSocket 升級（房間通訊） |
| `GET /api/room/:key` | 房間概況 JSON（大廳顯示人數用） |
| `GET /api/archive/:key` | 房間的戰績摘要列表 |
| `GET /api/archive/:key/:id` | 單局完整戰績（回放用） |
| `POST /api/archive/:key/clear` | 清空房間戰績 |
| `GET /api/registry/rooms?userId=X` | 使用者持有的房間清單 |
| `POST /api/registry/release` | 釋出一個房間 |
| `GET /api/health` | 健康檢查 |

---

## 10. 設計說明

* **伺服器權威**：船隊、命中／擊沉、勝負全部由 Worker 判定並廣播，雙方畫面必然一致，也無法作弊。
* **自動標註**：擊沉的船周圍 8 方向自動標為落空；實際開火過的格子優先於自動標註。
* **結算**：擊沉對方全部船艦即判定勝負，並公開雙方船位與命中率。
* **斷線重連**：同一分頁重新整理或斷線後，會以相同 `clientId` 自動認回座位並重連。
* **房間清理**：房間閒置 6 小時後由 Durable Object alarm 自動刪除（戰績存檔不受影響）。
* **戰績存檔**：結算即寫檔（R2 + DO SQLite），支援明細查詢與逐步回放。
* **通訊氣泡**：連線版通訊縮在右下角氣泡，新訊息以小提示通知（數秒自動消失）。
* **聚光燈導覽**：連線版也有與單機版相同的逐步介面導覽（含圖示示範），第一次進入自動播放。
* **房間數上限**：Registry Durable Object 強制每人最多 3 個房間，超額時由使用者選擇釋出哪一個。
* **單機版不動**：`battleship.html` 完全未修改，離線可玩、保留本機紀錄。

---

## 11. Git 紀錄

```bash
git log --oneline
git checkout 17655d2      # 回到原始單機版快照
git diff 17655d2 HEAD -- battleship.html   # 確認單機版未被更動
```
