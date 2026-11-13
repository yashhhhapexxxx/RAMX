// Render the cover: node pitch/cover/render.mjs  →  pitch/cover/cover.png (1920×1080)
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
execFileSync(CHROME, [
  "--headless=new", "--hide-scrollbars", "--allow-file-access-from-files",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "cover-"))}`,
  "--window-size=1920,1080", "--virtual-time-budget=3000",
  `--screenshot=${join(dir, "cover.png")}`, pathToFileURL(join(dir, "index.html")).href,
], { stdio: "ignore" });
console.log("saved", join(dir, "cover.png"));
