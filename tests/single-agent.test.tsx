// Module 5: the single-agent version. One support agent has every tool (the
// shop's and the refunds') and no handoff; the refund rule is still code. The
// golden set the evals run is checked here too. Mock model, so no AI key.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SET } from "@/evals/golden-set";
import { finalValue } from "@/lib/ai/live";
import { toolCallsOf } from "@/lib/copper/assistant/progress";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: {
      total: 500,
      noCache: 500,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  },
});

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

const calls = (toolName: string, input: unknown): StreamPart[] => [
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function ask(
  request: Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0],
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue((await askCopper(request)).progress);
}

describe("single agent", () => {
  it("one support agent refunds by itself, with every tool and no handoff", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1001" }),
      says("Done: $7.99 is refunded."),
    );
    const result = await ask({
      messages: [{ role: "user", content: "Refund order #1001" }],
      useTools: true,
      desk: { limitUsd: 50, refunds: [] },
      architecture: "single",
    });
    expect(result.status).toBe("done");
    expect(result.steps.some((s) => s.type === "handoff")).toBe(false);
    expect(toolCallsOf(result)[0]).toMatchObject({
      name: "request_refund",
      output: { status: "refunded", amountUsd: 7.99 },
    });
    expect(model.doStreamCalls).toHaveLength(2);
    const tools = model.doStreamCalls[0].tools?.map((t) => t.name).sort();
    expect(tools).toEqual([
      "calculate_cost",
      "check_availability",
      "get_orders",
      "get_prices",
      "get_products",
      "request_refund",
      "search_docs",
    ]);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "You also handle refunds yourself",
    );
    // Its usage is totalled for the evals' cost report.
    expect(result.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("the default (multi) still starts with Copper and its handoff tool", async () => {
    model = modelStreaming(says("Hi!"));
    await ask({
      messages: [{ role: "user", content: "Hi" }],
      useTools: true,
      desk: { limitUsd: 50, refunds: [] },
    });
    const tools = model.doStreamCalls[0].tools?.map((t) => t.name);
    expect(tools).toContain("transfer_to_refund_agent");
    expect(tools).not.toContain("request_refund");
  });
});

describe("the golden set", () => {
  it("has at least 10 cases with unique ids, each saying what a good answer does", () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(10);
    expect(new Set(GOLDEN_SET.map((c) => c.id)).size).toBe(GOLDEN_SET.length);
    for (const c of GOLDEN_SET) {
      expect(c.question.length, c.id).toBeGreaterThan(5);
      expect(c.good.length, c.id).toBeGreaterThan(30);
    }
  });

  it("covers both agents' jobs: shopping, documents and refunds", () => {
    const tools = GOLDEN_SET.flatMap((c) => c.mustUse ?? []);
    for (const tool of [
      "calculate_cost",
      "check_availability",
      "search_docs",
      "request_refund",
    ])
      expect(tools).toContain(tool);
  });
});
