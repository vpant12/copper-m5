// Module 5: observability with Langfuse. Every Ask Copper question becomes one
// Langfuse trace: a "generation" for each agent's model call (with its model,
// tokens, cost and time) and a "tool" for each tool it used. Evals add their
// scores to the same traces and group them into dataset runs to compare.
//
// Traces go to Langfuse's OpenTelemetry endpoint (/api/public/otel/v1/traces)
// as OTLP JSON: since November 2026 that's how Langfuse Cloud takes traces.
// Scores go to /api/public/scores. It uses plain fetch, so it works the same in
// the app, in tests and in GitHub Actions. Tracing must never break a chat:
// without LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY it does nothing, and a
// failed upload is logged and ignored.

export function isLangfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

export function langfuseBaseUrl(): string {
  return (
    process.env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com"
  ).replace(/\/+$/, "");
}

function authHeader(): string {
  const key = `${process.env.LANGFUSE_PUBLIC_KEY?.trim()}:${process.env.LANGFUSE_SECRET_KEY?.trim()}`;
  return `Basic ${btoa(key)}`;
}

/** Calls Langfuse's public API. Returns null (and logs) when it fails. */
export async function langfuseApi<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T | null> {
  if (!isLangfuseConfigured()) return null;
  try {
    const response = await fetch(`${langfuseBaseUrl()}/api/public/${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      console.warn(
        `[langfuse] ${path}: HTTP ${response.status}`,
        text.slice(0, 300),
      );
      return null;
    }
    return data as T;
  } catch (error) {
    console.warn(`[langfuse] ${path} failed:`, (error as Error).message);
    return null;
  }
}

// --- OpenTelemetry (OTLP JSON) -------------------------------------------

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };

type Attribute = { key: string; value: AnyValue };

type OtelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status?: { code: number; message?: string };
};

/** Random lowercase hex, `bytes` long: OpenTelemetry trace and span ids. */
function hexId(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const nanos = (date: Date) =>
  (BigInt(date.getTime()) * BigInt(1_000_000)).toString();

function toValue(value: unknown): AnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number")
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return { arrayValue: { values: value.map((v) => ({ stringValue: v })) } };
  return { stringValue: JSON.stringify(value) };
}

/** Attributes from an object, skipping empty values. */
function attributes(record: Record<string, unknown>): Attribute[] {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: toValue(value) }));
}

/** Metadata as one attribute per key, the way Langfuse shows it. */
function metadataAttributes(
  prefix: string,
  metadata: Record<string, unknown> = {},
) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      `${prefix}.${key}`,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}

export type GenerationRecord = {
  name: string;
  model: string;
  startTime: Date;
  endTime: Date;
  input?: unknown;
  output?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type SpanRecord = {
  name: string;
  startTime: Date;
  endTime: Date;
  parentId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

/**
 * One Langfuse trace. Record generations, tool calls and scores on it as they
 * happen, call finish() with the answer, then flush() once to send it all.
 */
export class Trace {
  /** Langfuse's trace id: the OpenTelemetry trace id (32 hex characters). */
  readonly id = hexId(16);
  private readonly rootSpanId = hexId(8);
  private readonly started = new Date();
  private spans: OtelSpan[] = [];
  private scores: { name: string; value: number; comment?: string }[] = [];
  private finished = false;
  /** Totals across the trace's generations, for the eval report. */
  readonly totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  constructor(
    readonly name: string,
    private readonly info: {
      input?: unknown;
      metadata?: Record<string, unknown>;
      tags?: string[];
      sessionId?: string;
    } = {},
  ) {}

  private span(
    name: string,
    parent: string | undefined,
    startTime: Date,
    endTime: Date,
    attrs: Record<string, unknown>,
    error?: string,
  ): string {
    const spanId = hexId(8);
    this.spans.push({
      traceId: this.id,
      spanId,
      parentSpanId: parent ?? this.rootSpanId,
      name,
      kind: 1,
      startTimeUnixNano: nanos(startTime),
      endTimeUnixNano: nanos(endTime),
      attributes: attributes(attrs),
      ...(error && { status: { code: 2, message: error } }),
    });
    return spanId;
  }

  /** One model call. Returns its id, so its tool calls can sit under it. */
  generation(record: GenerationRecord): string {
    this.totals.inputTokens += record.inputTokens ?? 0;
    this.totals.outputTokens += record.outputTokens ?? 0;
    this.totals.costUsd += record.costUsd ?? 0;
    const hasUsage =
      record.inputTokens !== undefined || record.outputTokens !== undefined;
    return this.span(
      record.name,
      undefined,
      record.startTime,
      record.endTime,
      {
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": record.model,
        "gen_ai.request.model": record.model,
        "gen_ai.usage.input_tokens": record.inputTokens,
        "gen_ai.usage.output_tokens": record.outputTokens,
        "langfuse.observation.usage_details": hasUsage
          ? JSON.stringify({
              input: record.inputTokens ?? 0,
              output: record.outputTokens ?? 0,
              total: (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
            })
          : undefined,
        "langfuse.observation.cost_details":
          record.costUsd !== undefined
            ? JSON.stringify({ total: record.costUsd })
            : undefined,
        "langfuse.observation.input":
          record.input === undefined ? undefined : JSON.stringify(record.input),
        "langfuse.observation.output":
          record.output === undefined
            ? undefined
            : JSON.stringify(record.output),
        "langfuse.observation.level": record.error ? "ERROR" : undefined,
        "langfuse.observation.status_message": record.error,
        ...metadataAttributes("langfuse.observation.metadata", record.metadata),
      },
      record.error,
    );
  }

  /** One tool call, under the model call that made it. */
  tool(record: SpanRecord): string {
    return this.span(
      record.name,
      record.parentId,
      record.startTime,
      record.endTime,
      {
        "langfuse.observation.type": "tool",
        "langfuse.observation.input":
          record.input === undefined ? undefined : JSON.stringify(record.input),
        "langfuse.observation.output":
          record.output === undefined
            ? undefined
            : JSON.stringify(record.output),
        ...metadataAttributes("langfuse.observation.metadata", record.metadata),
      },
    );
  }

  /** Sets the trace's answer, adds metadata and tags, and closes it. */
  finish(update: {
    output?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
    /** Anyone with the link can view it (Langfuse's "share" switch). */
    public?: boolean;
  }) {
    const metadata = { ...this.info.metadata, ...update.metadata };
    const tags = [...(this.info.tags ?? []), ...(update.tags ?? [])];
    this.spans.unshift({
      traceId: this.id,
      spanId: this.rootSpanId,
      name: this.name,
      kind: 1,
      startTimeUnixNano: nanos(this.started),
      endTimeUnixNano: nanos(new Date()),
      attributes: attributes({
        "langfuse.trace.name": this.name,
        "langfuse.trace.input":
          this.info.input === undefined
            ? undefined
            : JSON.stringify(this.info.input),
        "langfuse.trace.output":
          update.output === undefined
            ? undefined
            : JSON.stringify(update.output),
        "langfuse.trace.tags": tags,
        "langfuse.trace.public": update.public,
        "langfuse.session.id": this.info.sessionId,
        "langfuse.observation.input":
          this.info.input === undefined
            ? undefined
            : JSON.stringify(this.info.input),
        "langfuse.observation.output":
          update.output === undefined
            ? undefined
            : JSON.stringify(update.output),
        ...metadataAttributes("langfuse.trace.metadata", metadata),
      }),
    });
    this.finished = true;
  }

  /** A score on this trace, such as the AI judge's grade. */
  score(name: string, value: number, comment?: string) {
    this.scores.push({ name, value, comment });
  }

  /** Sends the trace (once finished) and any scores. */
  async flush(): Promise<void> {
    if (!isLangfuseConfigured()) return;
    if (this.finished && this.spans.length) {
      const spans = this.spans;
      this.spans = [];
      await langfuseApi("otel/v1/traces", {
        body: {
          resourceSpans: [
            {
              resource: {
                attributes: attributes({ "service.name": "copper-state-labs" }),
              },
              scopeSpans: [
                { scope: { name: "copper-state-labs", version: "5" }, spans },
              ],
            },
          ],
        },
      });
    }
    const scores = this.scores;
    this.scores = [];
    for (const s of scores)
      await scoreTrace(this.id, s.name, s.value, s.comment);
  }
}

/** Adds a score to a trace (used by the evals): POST /api/public/scores. */
export async function scoreTrace(
  traceId: string,
  name: string,
  value: number,
  comment?: string,
): Promise<void> {
  await langfuseApi("scores", {
    body: { traceId, name, value, dataType: "NUMERIC", comment },
  });
}

/** The link to a trace in the Langfuse web app. */
export async function traceUrl(traceId: string): Promise<string | null> {
  const projects = await langfuseApi<{ data: { id: string }[] }>("projects");
  const project = projects?.data?.[0]?.id;
  return project
    ? `${langfuseBaseUrl()}/project/${project}/traces/${traceId}`
    : null;
}
