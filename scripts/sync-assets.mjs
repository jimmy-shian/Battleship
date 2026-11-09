/**
 * 把根目錄的單機版 battleship.html 同步到 public/，
 * 讓部署後的網站同時提供「單機版 / 連線版」。
 * 根目錄檔案才是原始碼，public/ 只是部署用副本。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "battleship.html");
const outDir = join(root, "public");
const dest = join(outDir, "battleship.html");

await mkdir(outDir, { recursive: true });

const buf = await readFile(src);
let same = false;
try {
  const cur = await readFile(dest);
  same = cur.equals(buf);
} catch {
  same = false;
}

if (!same) {
  await writeFile(dest, buf);
  console.log("[sync] battleship.html -> public/ (已更新)");
} else {
  console.log("[sync] public/battleship.html 已是最新");
}
