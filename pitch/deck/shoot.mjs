// Capture the real frontend for the deck: node pitch/deck/shoot.mjs [baseUrl]
// Needs Google Chrome and the frontend running (default http://localhost:5277).
// Start the gateway and pool first so the playground, network and ledger show live data.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://localhost:5277";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "shots");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const W = 1440, H = 900;

/* scroll: "top", a section id, or [id, fraction] to land part-way through a pinned scroll story */
const SHOTS = [
  { name: "landing-hero", path: "/", scroll: "top" },
  { name: "landing-crew", path: "/", scroll: ["the-pool", 0] },
  { name: "how-it-works", path: "/", scroll: ["how-it-works", 0.9] },
  { name: "playground", path: "/chat" },
  { name: "network", path: "/network" },
  { name: "provider", path: "/getting-started" },
  { name: "ledger", path: "/ledger" },
  { name: "payouts", path: "/payouts" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "deck-shoot-"))}`,
  "--hide-scrollbars", `--window-size=${W},${H}`, "--no-first-run", "about:blank",
], { stdio: "ignore" });

try {
  let version;
  for (let i = 0; i < 200 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); }
  }
  if (!version) throw new Error("Chrome did not start its debugging port");
  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  for (const s of SHOTS) {
    await send("Page.navigate", { url: BASE + s.path });
    await sleep(3500);
    if (s.scroll && s.scroll !== "top") {
      const [sec, frac] = s.scroll;
      await send("Runtime.evaluate", {
        expression: `(() => { const el = document.getElementById(${JSON.stringify(sec)}); if (!el) return;
          const top = el.getBoundingClientRect().top + scrollY;
          const run = Math.max(0, el.offsetHeight - innerHeight);
          scrollTo({ top: top + run * ${frac}, behavior: "instant" }); })()`,
      });
      await sleep(2500);
    }
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${s.name}.png`), Buffer.from(data, "base64"));
    console.log("saved", s.name);
  }
  ws.close();
} finally {
  chrome.kill();
}
