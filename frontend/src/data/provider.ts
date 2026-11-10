import { ProviderOverview, ProviderPool, ProviderEnrollment } from "@ramx/shared";
import { env } from "../config/env";
import { SessionExpired } from "./api";

async function call(path: string, token: string, body?: unknown) {
  const response = await fetch(`${env.gatewayUrl.replace(/\/$/, "")}/provider/pools${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) throw new SessionExpired();
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message ?? `Provider setup returned HTTP ${response.status}`);
  if (!result) throw new Error("Provider setup returned an invalid response");
  return result;
}
export const providerApi = {
  overview: async (token: string) => ProviderOverview.parse(await call("", token)),
  create: async (token: string, body: { name: string; model: string; expected_members: number; payout_address: string }) => ProviderPool.parse(await call("", token, body)),
  join: async (token: string, body: { pool_id: string; payout_address: string }) => ProviderPool.parse(await call("/join", token, body)),
  enroll: async (token: string, pool: string) => ProviderEnrollment.parse(await call(`/${encodeURIComponent(pool)}/enroll`, token, {})),
  manage: async (token: string, pool: string, action: string) => ProviderPool.parse(await call(`/${encodeURIComponent(pool)}/${action}`, token, {})),
};
