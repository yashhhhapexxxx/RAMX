import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, plannerMessages } from "../src/planner.ts";

test("an ask plan carries the next question and the reason", () => {
  assert.deepEqual(parsePlan('{"action":"ask","question":"What is a KV cache?","why":"needed for memory math"}'), {
    action: "ask", question: "What is a KV cache?", why: "needed for memory math",
  });
});

test("a done plan ends the run with a summary; text around the JSON is ignored", () => {
  assert.deepEqual(parsePlan('<think>enough</think> {"action":"done","summary":"Pooling works."}'), { action: "done", summary: "Pooling works." });
});

test("anything else is not a plan", () => {
  for (const t of ["", "no json", '{"action":"ask"}', '{"action":"buy","question":"x"}', '{"action":"ask","question":"  "}', "{broken"]) assert.equal(parsePlan(t), null);
});

test("the planner sees the goal, what it already bought and its budget", () => {
  const [, user] = plannerMessages("Can 3 laptops run a 14B model?", [{ question: "How big is Qwen3-14B in FP8?", answer: "About 15 GB." }], "0.020", "0.002");
  assert.match(user!.content, /Can 3 laptops run a 14B model\?/);
  assert.match(user!.content, /About 15 GB/);
  assert.match(user!.content, /Budget left: 0\.020 USDC/);
});
