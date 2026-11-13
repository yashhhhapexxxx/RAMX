// Render every slide (all steps shown) and write one PDF: node pitch/deck/export.mjs [out.pdf]
// Needs Google Chrome. Output default: pitch/RAMX-Pitch.pdf
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? join(DIR, "..", "RAMX-Pitch.pdf"));
const PNG = join(DIR, "pdf-pages");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334, W = 1600, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slides = (readFileSync(join(DIR, "index.html"), "utf8").match(/<section class="slide"/g) || []).length;
mkdirSync(PNG, { recursive: true });

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "deck-pdf-"))}`,
  "--hide-scrollbars", "--allow-file-access-from-files", `--window-size=${W},${H}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  let version;
  for (let i = 0; i < 200 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
  if (!version) throw new Error("Chrome did not start its debugging port");
  console.log("chrome up");
  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const base = pathToFileURL(join(DIR, "index.html")).href;
  const files = [];
  for (let n = 1; n <= slides; n++) {
    await send("Page.navigate", { url: `${base}?all&n=${n}#slide-${n}` });
    await sleep(2600); // let entrance animations finish
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
    const f = join(PNG, `slide-${String(n).padStart(2, "0")}.jpg`);
    writeFileSync(f, Buffer.from(data, "base64")); files.push(f);
    console.log("slide", n);
  }
  const html = join(PNG, "book.html");
  writeFileSync(html, `<!doctype html><style>@page{size:${W}px ${H}px;margin:0}html,body{margin:0}img{display:block;width:${W}px;height:${H}px}img:not(:last-child){page-break-after:always}</style>` +
    files.map((f) => `<img src="${pathToFileURL(f).href}">`).join(""));
  ws.close();
} finally { chrome.kill(); }
// CDP printToPDF stalls in this headless setup; the command-line print does not.
execFileSync(CHROME, ["--headless=new", "--allow-file-access-from-files", `--user-data-dir=${mkdtempSync(join(tmpdir(), "deck-print-"))}`,
  "--no-pdf-header-footer", "--virtual-time-budget=5000", `--print-to-pdf=${OUT}`, pathToFileURL(join(PNG, "book.html")).href], { stdio: "ignore" });
console.log("saved", OUT);
