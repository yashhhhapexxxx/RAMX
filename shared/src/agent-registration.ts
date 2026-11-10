import { z } from "zod";

export const AgentRegistration = z.object({
  type: z.literal("https://eips.ethereum.org/EIPS/eip-8004#registration-v1"),
  name: z.string().min(1), description: z.string().min(1), image: z.string(),
  services: z.array(z.object({ name: z.string(), endpoint: z.url(), version: z.string().optional() })),
  x402Support: z.boolean(), active: z.boolean(),
  registrations: z.array(z.object({ agentId: z.string().regex(/^\d+$/), agentRegistry: z.string() })),
  supportedTrust: z.array(z.string()),
});
export type AgentRegistration = z.infer<typeof AgentRegistration>;
