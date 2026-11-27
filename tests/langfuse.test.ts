// Module 5: every chat is traced in Langfuse. The trace goes to Langfuse's
// OpenTelemetry endpoint as OTLP JSON (a span per agent call and per tool, with
// model, tokens and cost); scores go to /api/public/scores. Without keys,
// nothing is sent. No network: fetch is replaced.
import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreTrace, Trace } from "@/lib/ai/langfuse";

type Sent = { url: string; body: Record<string, unknown>; auth?: string };

function captureFetch() {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>).Authorization,
      });
      return new Response("{}", { status: 200 });
    }),
  );
  return sent;
}

function withKeys() {
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
  vi.stubEnv("LANGFUSE_BASE_URL", "https://langfuse.example");
}

type Attr = { key: string; value: Record<string, unknown> };
const attr = (span: { attributes: Attr[] }, key: string) =>
  Object.values(span.attributes.find((a) => a.key === key)?.value ?? {})[0];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Langfuse tracing", () => {
  it("sends nothing without keys", async () => {
    const sent = captureFetch();
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const trace = new Trace("ask-copper");
    trace.finish({ output: "hi" });
    await trace.flush();
    expect(sent).toEqual([]);
  });

  it("sends one trace: the agents' model calls with tokens and cost, and their tools", async () => {
    withKeys();
    const sent = captureFetch();
    const trace = new Trace("ask-copper", {
      input: "Refund order #1004",
      metadata: { architecture: "multi" },
      tags: ["multi-agent"],
    });
    const start = new Date("2026-11-27T10:00:00Z");
    const end = new Date("2026-11-27T10:00:02Z");
    const copper = trace.generation({
      name: "Copper",
      model: "gemini-3.5-flash-lite",
      startTime: start,
      endTime: end,
      inputTokens: 1000,
      outputTokens: 50,
      costUsd: 0.0004,
    });
    trace.tool({
      name: "tool: transfer_to_refund_agent",
      parentId: copper,
      startTime: start,
      endTime: end,
      input: { reason: "refund" },
    });
    trace.generation({
      name: "Refund agent",
      model: "gemini-3.5-flash-lite",
      startTime: end,
      endTime: end,
      inputTokens: 2000,
      outputTokens: 100,
      costUsd: 0.0008,
    });
    trace.finish({
      output: "A supervisor will review it.",
      metadata: { answeredBy: "Refund agent" },
      public: true,
    });
    await trace.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(
      "https://langfuse.example/api/public/otel/v1/traces",
    );
    expect(sent[0].auth).toBe(`Basic ${btoa("pk-lf-test:sk-lf-test")}`);
    const spans = (
      sent[0].body as {
        resourceSpans: {
          scopeSpans: {
            spans: {
              name: string;
              traceId: string;
              spanId: string;
              parentSpanId?: string;
              attributes: Attr[];
            }[];
          }[];
        }[];
      }
    ).resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s) => s.name)).toEqual([
      "ask-copper",
      "Copper",
      "tool: transfer_to_refund_agent",
      "Refund agent",
    ]);
    const [root, copperSpan, tool, refund] = spans;
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([trace.id]));
    expect(trace.id).toMatch(/^[0-9a-f]{32}$/);
    expect(copperSpan.parentSpanId).toBe(root.spanId);
    expect(tool.parentSpanId).toBe(copperSpan.spanId);
    expect(attr(root, "langfuse.trace.public")).toBe(true);
    expect(attr(root, "langfuse.trace.metadata.answeredBy")).toBe(
      "Refund agent",
    );
    expect(attr(copperSpan, "langfuse.observation.type")).toBe("generation");
    expect(attr(tool, "langfuse.observation.type")).toBe("tool");
    expect(attr(refund, "gen_ai.request.model")).toBe("gemini-3.5-flash-lite");
    expect(
      JSON.parse(String(attr(refund, "langfuse.observation.usage_details"))),
    ).toEqual({ input: 2000, output: 100, total: 2100 });
    expect(
      JSON.parse(String(attr(refund, "langfuse.observation.cost_details"))),
    ).toEqual({ total: 0.0008 });
    expect(trace.totals).toEqual({
      inputTokens: 3000,
      outputTokens: 150,
      costUsd: expect.closeTo(0.0012, 10),
    });
  });

  it("sends eval scores to /api/public/scores", async () => {
    withKeys();
    const sent = captureFetch();
    await scoreTrace("a".repeat(32), "judge", 0.9, "Good answer");
    expect(sent).toEqual([
      expect.objectContaining({
        url: "https://langfuse.example/api/public/scores",
        body: {
          traceId: "a".repeat(32),
          name: "judge",
          value: 0.9,
          dataType: "NUMERIC",
          comment: "Good answer",
        },
      }),
    ]);
  });
});
