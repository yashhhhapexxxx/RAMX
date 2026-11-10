/* Types for the Anatomy kit's WebGL layer (gl.mjs), only what the figures use. */
export const GLSL_ISO: string;
export const GLSL_TURN: string;
export function glslPose(name: string, prefix?: string): string;
export interface GlLayer {
  gl: WebGLRenderingContext;
  draw(uniforms: Record<string, unknown>, time?: number): void;
  resize?(): void;
  destroy?(): void;
}
export function glLayer(options: { canvas: HTMLCanvasElement; fragment: string; view: number[]; camera: unknown; uniforms?: string[]; fixed?: Record<string, unknown>; maxRatio?: number; onError?: (message: string) => void }): GlLayer | null;
export function settle(state: { x: number; v: number }, target: number, dt: number, seconds: number, calm?: boolean): boolean;
