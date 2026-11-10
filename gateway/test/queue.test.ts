import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoolQueue } from "../src/queue.ts";

const signal = () => new AbortController().signal;

test("busy pool sorts waiting ratios descending, x402 ratio 1, FIFO ties; low ratios still run", async () => {
  const q = createPoolQueue();
  const first = await q.acquire("pool", 0, signal());
  const order: string[] = [];
  const wait = (label: string, ratio: number) => q.acquire("pool", ratio, signal()).then((release) => { order.push(label); release(); });
  const all = [wait("low", 0), wait("x402", 1), wait("high-first", 5), wait("high-second", 5)];
  await Promise.resolve();
  assert.deepEqual(order, []);
  first(); first();
  await Promise.all(all);
  assert.deepEqual(order, ["high-first", "high-second", "x402", "low"]);
});

test("cancelled waiters are removed and never acquire a slot; pools run independently", async () => {
  const q = createPoolQueue();
  const first = await q.acquire("a", 0, signal());
  const cancel = new AbortController();
  const pending = q.acquire("a", 10, cancel.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  cancel.abort();
  await rejected;
  const independent = await q.acquire("b", 0, signal());
  independent();
  first();
  const next = await q.acquire("a", 0, signal());
  next();
  await assert.rejects(q.acquire("a", 0, cancel.signal), { name: "AbortError" });
});
