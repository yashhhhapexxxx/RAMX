/* Figure H1 truth: the card on the turntable is the pool's RTX 4060 node, as the live pool reports it.
   Qwen3-14B has 40 layers; this card serves [29, 40), the last stage. */
import config from "../../../../../shared/config/ramx.config.json";

const QWEN14 = config.models.find((m) => m.model_id === "Qwen/Qwen3-14B-FP8");
export const CARD = { name: "RTX 4060", memGb: 8, vram: "4 × 2 GB GDDR6", layers: [29, 40] as [number, number], totalLayers: QWEN14?.num_layers ?? 40 };

/* Motion: the turntable tours at 9°/s, the fans are drawn at 40 rpm (slowed: a real fan turns ~1,500 rpm). */
export const TOUR_DEG_PER_S = 9;
export const FAN_DEG_PER_S = 240;
export const REST_TURN = 24;
/* With the cooler lifted, the table eases to this angle (or 180° on) so the board lies across the view. */
export const SHOW_TURN = 120;

const wrap = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;
export function readoutOf(turn: number, lift: number) {
  const angle = `${wrap(turn)}°`;
  if (lift > 0.5) return `cooler up · ${CARD.vram} · ${angle}`;
  return `${CARD.name} · ${CARD.memGb} GB · layers ${CARD.layers[0]}–${CARD.layers[1] - 1} · ${angle}`;
}

/* The same mapping the build used for its poses: figure values → group values. */
export const LIFT_MM = 56;
export function follow(values: Record<string, number>) {
  return { ...values, table: values.table ?? 0, cooler: LIFT_MM * (values.lift ?? 0), fanA: values.spin ?? 0, fanB: -(values.spin ?? 0) };
}
