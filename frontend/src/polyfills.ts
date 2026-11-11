/* NEAR wallet modules (Meteor and its crypto deps) expect Node's globals: Buffer, global, process.
   Browsers do not have them. Imported first in main.tsx, before the lazy wallet chunk loads. */
import { Buffer } from "buffer";

const g = globalThis as unknown as Record<string, unknown>;
g.Buffer ??= Buffer;
g.global ??= globalThis;
g.process ??= { env: {} };
