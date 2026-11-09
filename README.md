# 海戰棋 Battleship

經典海戰棋（Battleship）的網頁版：**單機同機對戰**＋**免費雲端多人連線對戰**，
不需安裝、開瀏覽器就能玩。

> **線上版（連線對戰）**：<https://battleship-online.jimmy910824.workers.dev>

---

## 🎮 遊戲介紹

### 這是什麼遊戲？

海戰棋是兩人對戰的猜位置遊戲：雙方各自把船艦藏在 5×5 的海域裡，
輪流攻擊對方的座標，**先把對方全部船艦擊沉的人獲勝**。

* 海域 5×5，每人 4 艘船：3 格 ×1、2 格 ×2、1 格 ×1（共 8 格）
* 船可橫放或直放，不可重疊、不可相鄰（含斜角）
* 每次開火結果：**落空 / 命中 / 擊沉**；一艘船的每一格都被命中就是擊沉

### 圖示怎麼看？

**敵方海域**（你開火的地方）：

| 圖示 | 意義 |
|------|------|
| 灰色圓點 | 落空：這一格沒有船 |
| 藍色方框 | 命中：這一格有船（周圍不一定無船，只記這格） |
| 紅底白星 | 擊沉：整艘船都命中 |
| 灰框格子 | 自動標註：擊沉後，船周圍一圈**自動**變為落空 |

**我方海域**（對方攻擊的地方）：

| 圖示 | 意義 |
|------|------|
| 空心圓圈 | 對方開火落空 |
| 粉紅叉叉 | 我方船艦被命中的那一格 |

### 兩種遊玩方式

| | 單機版 | 連線版 |
|---|--------|--------|
| 進行方式 | 兩人共用一台裝置，輪流操作 | 各自的裝置，即時連線對戰 |
| 開火方式 | 點格子循環標記（空白 → 落空 → 命中 → 擊沉） | 點一下就直接開火，**結果自動標記** |
| 判定 | 兩人自行回報結果 | 伺服器權威判定，無法作弊 |
| 紀錄 | 存在本機 | 雲端戰績存檔，可逐步回放 |
| 離線 | ✅ 單一 HTML 檔可離線玩 | 需要網路 |

### 怎麼開一場連線對戰？

1. 開啟[線上版](https://battleship-online.jimmy910824.workers.dev)，填暱稱、從下拉選單選一間房（**Room1／Room2／Room3**）
2. 把盤面右上角的**房號複製**給朋友（或按「複製邀請連結」），對方選**同一間房**
3. 各自拖曳船艦佈陣、鎖定，就會自動開戰！

### 遊戲功能特色

* **自動標記**：連線版點格子直接開火，落空／命中／擊沉立即標記並同步雙方
* **自動標註**：擊沉一艘船後，周圍一圈自動標為落空，省去手動記憶
* **標註模式**：想記錄推測時可開啟，只是自己的筆記，不影響判定
* **回合規則可選**：輪流交替／命中續打（命中則續攻）
* **右下角通訊**：對戰中可以傳訊息給對手
* **戰績存檔**：每局結束自動存檔，可查詢明細、**逐步回放**每一炮
* **聚光燈導覽**：第一次進入盤面會逐步介紹每個區塊（含圖示示範）
* **斷線重連**：重新整理或短暫斷線會自動認回座位

---

## 🛠 專案說明

### 技術架構

原生 HTML/CSS/JS（無框架）＋ Cloudflare 免費方案：

* **Cloudflare Workers**：網站與 API
* **Durable Objects**：每間房一個實例（內建 SQLite），**WebSocket Hibernation API** 讓閒置房間不佔資源
* **伺服器權威判定**：船位、命中、勝負全部由後端判定廣播，兩端畫面必然一致
* `public/js/rules.js` 與 `public/js/protocol.js` 前後端共用，規則只寫一份

### 目錄結構

```
Battleship/
├─ battleship.html          # 單機版（單一檔案、離線可玩、本機紀錄）
├─ public/                  # 部署用靜態網站根目錄
│  ├─ index.html            # 大廳：選房、暱稱、邀請連結、房間狀態預覽
│  ├─ board.html            # 連線盤面：佈陣、開火、標註、通訊、結算
│  ├─ history.html          # 戰績存檔：查詢 / 明細 / 逐步回放
│  ├─ battleship.html       # 單機版副本（由 scripts/sync-assets.mjs 同步）
│  ├─ css/{base,lobby,board,history}.css
│  └─ js/
│     ├─ comm.js            # ★ 通訊模組（零相依，可獨立引用到其他專案）
│     ├─ comm.mjs           # 通訊模組 ES Module 包裝
│     ├─ protocol.js        # 訊息協定常數（前端 + Worker 共用）
│     ├─ rules.js           # 遊戲規則純函式（前端 + Worker 共用）
│     ├─ select.js          # 自訂下拉選單（動畫）
│     ├─ user.js            # 瀏覽器使用者識別碼
│     ├─ lobby.js           # 大廳邏輯
│     ├─ board.js           # 連線盤面邏輯（含聚光燈導覽）
│     └─ history.js         # 戰績存檔頁邏輯
├─ worker/
│  ├─ index.js              # Worker 進入點：/ws、房間狀態、戰績、登記簿、健康檢查
│  ├─ room.js               # Room Durable Object：房間 / 回合 / 結算 / 殘局重置
│  ├─ archive.js            # 戰績存檔：DO SQLite（＋R2 選用），每房上限 100 筆
│  └─ registry.js           # Registry Durable Object：使用者房間登記簿（內部保留）
├─ scripts/
│  ├─ sync-assets.mjs       # 把單機版同步到 public/
│  └─ sim-battles.mjs       # 對戰模擬器（多房多局自動測試）
├─ wrangler.toml            # Cloudflare 設定
└─ package.json
```

### 遊戲流程（連線版）

1. **大廳**：選房（Room1／Room2／Room3）、填暱稱 → 進入房間
2. **佈陣**：拖曳船艦到「我的海域」，四艘擺好後按「鎖定船艦」
3. **對戰**：輪到誰，誰就點「敵方海域」的格子開火，結果自動標記
4. **自動標註**：擊沉一艘船後，該船周圍一圈自動標為落空
5. **結算**：擊沉對方全部船艦即結束，顯示雙方出擊／命中／命中率，可一鍵再戰
6. **存檔**：結算後自動寫入戰績存檔，可查詢明細並逐步回放

### 固定三間房

* 全系統只有三間房，房號固定：`ROOM1`、`ROOM2`、`ROOM3`（大小寫不拘）
* 每間房同時一場對戰（2 人），第三位進入會收到「房間已滿」
* 新玩家接手或加入時，若上一局已結束，伺服器會自動重置回佈陣階段
* 房間閒置 6 小時自動清除（戰績存檔不受影響）

### 回合規則與手動標註

* **輪流交替**（預設）：每次開火後換人
* **命中續打**：命中或擊沉則繼續開火，未中才換人
* 佈陣階段雙方皆可透過下拉選單更改規則
* 「標註模式」可自行記錄推測，僅供參考，**不影響伺服器判定**

### 本機開發

```bash
npm install
npm run dev          # http://127.0.0.1:8787
```

開兩個分頁（不同分頁 = 不同玩家），選**同一間房**即可開打。

| 指令 | 說明 |
|------|------|
| `npm run dev` | 本機啟動 Worker + Durable Objects + 靜態網站 |
| `npm run deploy` | 同步單機版後部署到 Cloudflare |
| `npm run tail` | 即時查看 Worker 日誌 |
| `npm run check` | 只做打包檢查，不實際部署 |

### 部署

```bash
$env:CLOUDFLARE_API_TOKEN = "<你的 API Token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<你的 Account ID>"
npm run deploy
```

#### 免費額度（Workers Free）

| 項目 | 免費額度 |
|------|----------|
| Durable Object 請求 | 100,000 次／天 |
| Durable Object 運算時間 | 13,000 GB-秒／天 |
| Workers 請求 | 100,000 次／天 |
| R2 儲存量 | 10 GB |

兩個人一場遊戲的流量極低（每次開火只有幾個 WebSocket 訊息），一般使用遠低於免費額度。

### 戰績存檔

每次結算後自動存檔，「戰績存檔」頁可依房間查詢、查看明細並逐步回放。
**每間房最多保留 100 筆**：第 101 局完成時，後端自動刪除最舊的一筆（含完整紀錄）。

#### 存檔內容

```jsonc
{
  "v": 1,
  "id": "1758000000000",       // 對局 ID（結算時間）
  "room": "ROOM1",
  "at": 1758000000000,
  "durationMs": 1000000,       // 本局長度
  "turnRule": "alt",           // alt 輪流交替 / keep 命中續打
  "winner": { "id": "p0_xxx", "name": "小明" },
  "loser":  { "id": "p1_xxx", "name": "小華" },
  "players": [
    { "id": "p0_xxx", "name": "小明", "seat": 0,
      "fleet": { "3": { "r": 0, "c": 0, "d": "H" } },
      "stats": { "shots": 8, "hits": 8, "sunk": 8, "rate": 100 } }
  ],
  "shots": [ { "by": "p0_xxx", "cell": "2,3", "result": 2, "at": 1757999500000 } ]
}
```

#### 雙後端設計（永遠有資料可讀）

| 後端 | 說明 |
|------|------|
| Durable Object SQLite | 每間房的 DO 內建儲存，**永遠啟用**，作為永久備援 |
| Cloudflare R2 | `env.ARCHIVE` 綁定存在時同步寫入 `matches/<房間>/<對局ID>.json` |

讀取時兩邊合併（以對局 ID 去重、由新到舊排序），
因此 **R2 尚未啟用也能正常查詢與回放；日後啟用 R2 後既有紀錄不會遺失**。

#### 戰績 API

| 路徑 | 說明 |
|------|------|
| `GET /api/archive/:key` | 該房間的對局摘要列表（`{ ok, room, count, matches[] }`） |
| `GET /api/archive/:key/:id` | 單局完整紀錄（含船位與開火紀錄，供回放） |
| `POST /api/archive/:key/clear` | 清空該房間的所有戰績（回傳被刪除的筆數） |

### 房間登記簿 API（內部保留）

固定房號制之下，大廳已不再使用登記簿；端點保留供除錯／日後擴充：

| 路徑 | 說明 |
|------|------|
| `GET /api/registry/rooms?userId=...` | 查詢該使用者目前登記的房間 |
| `POST /api/registry/release` | 把該使用者移出某房間（釋出座位） |

### 對戰模擬器（測試）

`scripts/sim-battles.mjs` 用正式前端的 `BattleComm` 建立 agent，
兩兩一房完成整局對戰，可多房同時開打、多局連打，並驗證存檔與上限：

```bash
node scripts/sim-battles.mjs <網址> [房間=ROOM1,ROOM2,ROOM3] [局數=1] [名稱前綴=Agent]

# 例：線上三間房各打一局（6 個 agent）
node scripts/sim-battles.mjs https://battleship-online.jimmy910824.workers.dev
# 例：單房連打 101 局，驗證戰績 100 筆上限自動刪最舊
node scripts/sim-battles.mjs http://127.0.0.1:8787 ROOM2 101 Stress
```

### 通訊模組（`public/js/comm.js`）

零外部相依，只用瀏覽器原生 WebSocket，可直接複製到任何專案使用。

```html
<script src="js/comm.js"></script>
<script>
  const comm = new BattleComm({ url: "wss://your-worker.workers.dev" });
  comm.on("state", (e) => console.log(e.detail));
  comm.join({ key: "ROOM1", name: "小明" });
</script>
```

```js
// ES Module
import { BattleComm } from "./js/comm.mjs";
```

#### 遊戲高階 API

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

#### 事件

所有伺服器訊息都會派發 `message` 事件（`detail` 為完整訊息物件），
並額外依 `msg.t` 派發同名事件：

| 事件 | 觸發時機 |
|------|----------|
| `status` | 連線狀態變化：`detail.status` = `idle / connecting / open / reconnecting / closed` |
| `welcome` | 成功進房，`detail.you` = 你的玩家代號 |
| `state` | 任何戰局變化（完整快照） |
| `player` | 有人加入／離線／接管座位 |
| `fire` | 有人開火，`detail.result` = 1 落空 / 2 命中 / 3 擊沉 |
| `chat` | 有人送出通訊訊息 |
| `rematch` | 開始新的一局 |
| `error` | 伺服器錯誤，`detail.message` = 原因 |

#### 除錯

連線盤面在瀏覽器主控台提供 `window.__bs`：

```js
__bs.state          // 最近一次伺服器快照
__bs.comm.status    // 連線狀態
```

### 訊息協定

所有訊息皆為 JSON，`t` 為類型。

#### Client → Server

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

#### Server → Client

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
| `GET /ws?key=XXX` | WebSocket 升級（房間通訊，僅接受固定三房） |
| `GET /api/room/:key` | 房間概況 JSON（大廳顯示人數用） |
| `GET /api/archive/:key` | 房間的戰績摘要列表 |
| `GET /api/archive/:key/:id` | 單局完整戰績（回放用） |
| `POST /api/archive/:key/clear` | 清空房間戰績 |
| `GET /api/health` | 健康檢查 |

### 設計說明

* **伺服器權威**：船隊、命中／擊沉、勝負全部由 Worker 判定並廣播，雙方畫面必然一致，也無法作弊
* **自動標註**：擊沉的船周圍 8 方向自動標為落空；實際開火過的格子優先於自動標註
* **殘局重置**：新玩家進入已結束的房間時，伺服器自動重置回佈陣階段（舊結果已存檔）
* **結算視窗**：只在「自己參與的這局」由戰鬥轉為結束時彈出一次，不會卡住後續操作
* **斷線重連**：以相同 `clientId` 自動認回座位並重連
* **通訊氣泡**：縮在右下角，新訊息以懸浮提示通知（對話框開啟時不顯示）
* **聚光燈導覽**：第一次進入盤面自動播放，可隨時重看
* **單機版獨立**：`battleship.html` 單一檔案離線可玩，與連線版互不影響
