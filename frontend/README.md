# RAMX frontend

Vite + React web app for RAMX: playground chat, credits and earnings, API keys, network and ledger views, payouts, and the capacity market (`/swarm`). Runtime data always comes from the gateway (`VITE_GATEWAY_URL`) and NEAR RPC; fixtures are used only by the offline tests.

```bash
pnpm install                 # at the workspace root
pnpm --dir frontend dev      # http://localhost:5173
pnpm --dir frontend build
pnpm --dir frontend test
```

Public configuration is in `.env.example`. Never put a key in a `VITE_*` variable: everything here ships to the browser. NEAR wallet login uses `@near-wallet-selector` (Meteor, MyNearWallet) and a NEP-413 signed message; payout claims and USDC top-ups are NEAR transactions shown as `near-cli-rs` commands. Landing artwork is illustrative, not telemetry. Keep the LICENSE attribution.
