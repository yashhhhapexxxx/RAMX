import { randomBytes } from "node:crypto";
import type { ProviderJob } from "@ramx/shared";
import type { z } from "zod";

type Job = { wire: z.infer<typeof ProviderJob>; pool: string; delivered: boolean; resolve: (response: Response) => void;
  reject: (error: Error) => void; cleanup: () => void; accepted: boolean; cancelStream?: () => void;
  controller?: ReadableStreamDefaultController<Uint8Array>; nextSeq: number; bytes: number; closed: boolean };

/** Upper bound for one relayed response. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
type Poll = { resolve: (job: z.infer<typeof ProviderJob> | null) => void; cleanup: () => void };

/** Outbound-only coordinator connection. All payment/auth/settlement stays in chat.ts. */
export class ProviderRelay {
  private jobs = new Map<string, Job>();
  private polls = new Map<string, Poll>();

  forward(pool: string, path: "/v1/chat/completions" | "/cluster/status_json", body: unknown, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) return Promise.reject(new Error("request cancelled"));
    if ([...this.jobs.values()].filter(j => j.pool === pool).length >= 8) return Promise.reject(new Error("provider relay is busy"));
    return new Promise((resolve, reject) => {
      const id = randomBytes(16).toString("hex");
      const cancel = () => { this.jobs.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { this.jobs.get(id)?.cancelStream?.(); cancel(); reject(new Error("provider relay cancelled")); };
      const timer = setTimeout(() => { this.jobs.get(id)?.cancelStream?.(); cancel(); reject(new Error("provider relay timed out")); }, 600_000);
      timer.unref();
      const job: Job = { wire: { id, path, body: body ?? null }, pool, delivered: false, accepted: false,
        resolve, reject, cleanup: cancel, nextSeq: 0, bytes: 0, closed: false };
      this.jobs.set(id, job);
      signal?.addEventListener("abort", abort, { once: true });
      const poll = this.polls.get(pool);
      if (poll) { poll.cleanup(); job.delivered = true; poll.resolve(job.wire); }
    });
  }

  poll(pool: string, signal?: AbortSignal): Promise<z.infer<typeof ProviderJob> | null> {
    const queued = [...this.jobs.values()].find(j => j.pool === pool && !j.delivered);
    if (queued) { queued.delivered = true; return Promise.resolve(queued.wire); }
    const previous = this.polls.get(pool);
    if (previous) { previous.cleanup(); previous.resolve(null); }
    return new Promise(resolve => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.polls.delete(pool); };
      const abort = () => { cleanup(); resolve(null); };
      const timer = setTimeout(abort, 20_000);
      timer.unref();
      this.polls.set(pool, { resolve, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /**
   * One part of a relayed response, in order (seq 0, 1, 2…). The helper sends many small POSTs instead of one
   * chunked upload: proxies in front of the gateway (Render/Cloudflare) buffer a request body until it ends,
   * which held every token back until the answer was complete. Part 0 carries the upstream status and type and
   * starts the client's response; `final` closes it. Throws for an unknown, foreign, cancelled or out-of-order part.
   */
  part(pool: string, id: string, seq: number, status: number, contentType: string, data: Uint8Array, final: boolean): void {
    const job = this.jobs.get(id);
    if (!job || job.pool !== pool || !job.delivered || job.closed || seq !== job.nextSeq) throw new Error("unknown or completed relay job");
    job.nextSeq++;
    if (seq === 0) {
      job.accepted = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { job.controller = controller; },
        cancel: () => { job.closed = true; job.cleanup(); },
      });
      job.cancelStream = () => { if (!job.closed) { job.closed = true; job.controller?.error(new Error("Provider relay disconnected")); } job.cleanup(); };
      job.resolve(new Response(stream, { status, headers: { "content-type": contentType } }));
    }
    job.bytes += data.byteLength;
    if (job.bytes > MAX_RESPONSE_BYTES) { job.cancelStream?.(); throw new Error("provider response exceeds limit"); }
    if (data.byteLength) job.controller!.enqueue(data);
    if (final) { job.closed = true; job.controller!.close(); job.cleanup(); }
  }

  closePool(pool: string) {
    for (const job of this.jobs.values()) if (job.pool === pool) { job.cancelStream?.(); job.cleanup(); job.reject(new Error("provider disconnected")); }
    const poll = this.polls.get(pool);
    if (poll) { poll.cleanup(); poll.resolve(null); }
  }
}
