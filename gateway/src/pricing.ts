import type { ModelConfig, PriceQuote } from "@ramx/shared";

/** One quote per model per 30-second window. No timer or network work on the request path. */
export function createPricing(load: (model: string) => { active: number; queued: number }, now = Date.now) {
  const quotes = new Map<string, PriceQuote>();
  return {
    quote(model: ModelConfig): PriceQuote {
      const ts = now();
      const previous = quotes.get(model.model_id);
      if (previous && ts - previous.quoted_at < 30_000) return { ...previous };
      const demand = load(model.model_id);
      // Start at the agreed base price. Later windows discount idle capacity and price contention.
      const multiplier = previous ? Math.min(2, Math.max(0.5, 0.5 + 0.5 * (demand.active + demand.queued))) : 1;
      const quote = {
        credits_per_1k_in: model.model_factor * multiplier * 200,
        credits_per_1k_out: model.model_factor * multiplier * 1000,
        multiplier, quoted_at: ts,
      };
      quotes.set(model.model_id, quote);
      return { ...quote };
    },
  };
}
export type Pricing = ReturnType<typeof createPricing>;
