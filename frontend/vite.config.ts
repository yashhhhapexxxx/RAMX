import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_GATEWAY_URL || "http://127.0.0.1:8080";
  // Gateway paths (spec v0.1 §5.2), for same-origin use (VITE_GATEWAY_URL empty in the browser
  // config). /network, /ledger and /payouts are also app pages, so a browser page load
  // (Accept: text/html) is served the app instead of being proxied.
  const page = (req: { headers: { accept?: string } }) => (req.headers.accept?.includes("text/html") ? "/index.html" : undefined);
  const gateway = { target, changeOrigin: true, bypass: page };
  const proxy = { "^/(v1|auth|me|nodes|requests|network|ledger|payouts|provider|pools)(/|\\?|$)": gateway };
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      },
    },
    server: { proxy, fs: { allow: [".."] } },
    preview: { proxy },
  };
});
