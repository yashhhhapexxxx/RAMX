/* Types for the Anatomy kit's 3D runtime (turn.mjs), only what the figures use. */
export interface TurnController {
  set(values: Record<string, unknown> | number, options?: { detail?: number }): { ms: number };
  angleAt(clientX: number, clientY: number, z: number, group?: string): number;
  anchor(group: string, restPoint: number[], restDir?: number[]): { world: number[]; screen: number[]; direction: number[] };
  cams(): { world: { k: number; V: number[] } };
  values: Record<string, unknown>;
  destroy(): void;
}
export const TURN: {
  mount(stage: Element, data: unknown, options?: { follow?: (values: Record<string, number>) => Record<string, number>; onHold?: () => void; onFrame?: (controller: TurnController) => void }): TurnController;
  poseUniforms(controller: TurnController, group: string, prefix?: string): Record<string, number[]>;
};
export const TURN_CSS: string;
