/**
 * Goal mode for the agent (src/agent.ts --goal): the agent decides what to buy. Before each purchase it
 * asks the model (a paid x402 request like any other) for the next sub-question that moves it toward the
 * goal, or to stop. It sees the answers it already bought and the budget it has left, so it stops on its
 * own when the goal is met or the money would run out.
 */

export type Note = { question: string; answer: string };
export type Plan = { action: "ask"; question: string; why?: string } | { action: "done"; summary: string };

export function plannerMessages(goal: string, notes: Note[], budgetLeftUsdc: string, priceUsdc: string): { role: "system" | "user"; content: string }[] {
  const known = notes.length ? notes.map((n, i) => `${i + 1}. Q: ${n.question}\n   A: ${n.answer.slice(0, 400)}`).join("\n") : "nothing yet";
  return [
    {
      role: "system",
      content:
        "You are an autonomous research agent with a USDC wallet. Each answer you buy costs money, so buy only what moves you toward the goal. " +
        'Reply with JSON only, either {"action":"ask","question":"<one short question>","why":"<one short sentence>"} ' +
        'or {"action":"done","summary":"<two or three sentences answering the goal>"}.',
    },
    {
      role: "user",
      content: `Goal: ${goal}\nAnswers bought so far:\n${known}\nBudget left: ${budgetLeftUsdc} USDC. Each step costs about ${priceUsdc} USDC to decide plus ${priceUsdc} USDC per answer.\nNext step:`,
    },
  ];
}

/** First JSON object in the model's reply; null when it is not a valid plan. */
export function parsePlan(text: string): Plan | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: { action?: unknown; question?: unknown; why?: unknown; summary?: unknown };
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (j.action === "ask" && typeof j.question === "string" && j.question.trim()) {
    return { action: "ask", question: j.question.trim().slice(0, 300), ...(typeof j.why === "string" ? { why: j.why.slice(0, 200) } : {}) };
  }
  if (j.action === "done" && typeof j.summary === "string") return { action: "done", summary: j.summary.trim() };
  return null;
}
