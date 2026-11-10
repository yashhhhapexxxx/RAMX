import { AgentRegistration } from "@ramx/shared";
import { getAddress, parseAbi } from "viem";
import type { Config } from "./config.ts";

// ERC-8004 reference interfaces: https://eips.ethereum.org/EIPS/eip-8004
export const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
]);
export const REPUTATION_ABI = parseAbi([
  "function giveFeedback(uint256 agentId,int128 value,uint8 valueDecimals,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
]);

export function agentRegistration(cfg: Config): AgentRegistration {
  if (!cfg.env.PUBLIC_URL) throw new Error("PUBLIC_URL is required for agent registration");
  const base = cfg.env.PUBLIC_URL.replace(/\/+$/, "");
  const registry = cfg.env.ERC8004_IDENTITY_REGISTRY;
  const id = cfg.env.ERC8004_AGENT_ID;
  return AgentRegistration.parse({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "RAMX Gateway", description: "Pooled-laptop model inference with x402 payments in USDC on NEAR testnet; live models are listed by the models API.",
    image: cfg.env.ERC8004_IMAGE_URL ?? "",
    services: [{ name: "OpenAI", endpoint: `${base}/v1`, version: "1" }, { name: "models", endpoint: `${base}/v1/models` }, { name: "web", endpoint: base }],
    x402Support: !!cfg.env.X402_PAY_TO, active: true, supportedTrust: [],
    registrations: registry && id ? [{ agentId: id, agentRegistry: `eip155:296:${getAddress(registry)}` }] : [],
  });
}
