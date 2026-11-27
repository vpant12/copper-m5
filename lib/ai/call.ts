import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany, generateText, Output, streamText } from "ai";
import type { z } from "zod";
import {
  defaultModel,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  MODELS,
  type ModelId,
} from "@/lib/ai/models";
import type { Trace } from "@/lib/ai/langfuse";
import { costUsd } from "@/lib/ai/pricing";

// Every model call in the app goes through this file, so each one is logged
// with its tokens, cost and how long it took. The log goes to the terminal
// running the app, as a line starting "[ai_calls]".

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "Set up AI to use this feature: add GOOGLE_GENERATIVE_AI_API_KEY to .env.local.",
    );
    this.name = "AiNotConfiguredError";
  }
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
}

/**
 * Which module and feature made the call, for the ai_calls log. Module 5: with
 * a `trace`, the call is also recorded in Langfuse, named `name` (the agent).
 */
export type CallInfo = {
  module: number;
  feature: string;
  model?: ModelId;
  trace?: Trace;
  name?: string;
};

/**
 * Google's free tier turns away bursts of requests. Each call is retried this
 * many times (waiting 2, 4, 8, then 16 seconds) before it gives up.
 */
const MAX_RETRIES = 4;

/** Google's own name for a model, as Langfuse shows it. */
function providerModelId(model: ModelId): string {
  const entry = MODELS.find((m) => m.id === model);
  return entry && "googleId" in entry
    ? entry.googleId
    : model.slice("google/".length);
}

type StepLike = {
  toolCalls?: { toolCallId: string; toolName: string; input?: unknown }[];
  toolResults?: { toolCallId: string; output?: unknown }[];
};

/** Records one model call, and each tool it used, on the trace. */
function recordGeneration(
  info: CallInfo,
  model: ModelId,
  startTime: Date,
  result: {
    input?: unknown;
    output?: unknown;
    usage?: Usage;
    steps?: StepLike[];
    error?: unknown;
  },
) {
  const { trace } = info;
  if (!trace) return;
  const endTime = new Date();
  const inputTokens = result.usage?.inputTokens;
  const outputTokens = result.usage?.outputTokens;
  const generationId = trace.generation({
    name: info.name ?? info.feature,
    model: providerModelId(model),
    startTime,
    endTime,
    input: result.input,
    output: result.output,
    inputTokens,
    outputTokens,
    costUsd:
      inputTokens !== undefined && outputTokens !== undefined
        ? costUsd(model, inputTokens, outputTokens)
        : undefined,
    metadata: { module: info.module, feature: info.feature },
    error:
      result.error === undefined
        ? undefined
        : result.error instanceof Error
          ? result.error.message
          : String(result.error),
  });
  for (const step of result.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      trace.tool({
        name: `tool: ${call.toolName}`,
        parentId: generationId,
        startTime,
        endTime,
        input: call.input,
        output: step.toolResults?.find((r) => r.toolCallId === call.toolCallId)
          ?.output,
        metadata: { agent: info.name, tool: call.toolName },
      });
    }
  }
}

// Omit that keeps generateText's "prompt or messages" union intact.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type TextOptions = DistributiveOmit<
  Parameters<typeof generateText>[0],
  "model" | "output"
>;

export type AiCallRow = {
  module: number;
  feature: string;
  model: ModelId | typeof EMBEDDING_MODEL;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  ok: boolean;
  created_at: string;
};

function google() {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!googleKey) throw new AiNotConfiguredError();
  return createGoogleGenerativeAI({ apiKey: googleKey });
}

function languageModel(model: ModelId) {
  const entry = MODELS.find((m) => m.id === model);
  const id =
    entry && "googleId" in entry
      ? entry.googleId
      : model.slice("google/".length);
  return google()(id);
}

/** Prints one line per model call, so the cost and time are visible. */
async function logCall(row: AiCallRow): Promise<void> {
  console.info("[ai_calls]", JSON.stringify(row));
}

type Usage = { inputTokens?: number; outputTokens?: number };

/** Builds the ai_calls row for a call that started at `started`. */
function rowFor(info: CallInfo, model: ModelId, started: number) {
  return (ok: boolean, usage?: Usage): AiCallRow => {
    const input = usage?.inputTokens ?? null;
    const output = usage?.outputTokens ?? null;
    return {
      module: info.module,
      feature: info.feature,
      model,
      input_tokens: input,
      output_tokens: output,
      cost_usd:
        input !== null && output !== null
          ? costUsd(model, input, output)
          : null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      created_at: new Date().toISOString(),
    };
  };
}

async function tracked<T extends { usage: Usage; text?: string }>(
  info: CallInfo,
  input: unknown,
  run: (model: ModelId) => Promise<T>,
): Promise<T> {
  const model = info.model ?? defaultModel();
  const row = rowFor(info, model, performance.now());
  const startTime = new Date();
  try {
    const result = await run(model);
    await logCall(row(true, result.usage));
    recordGeneration(info, model, startTime, {
      input,
      output: result.text,
      usage: result.usage,
    });
    return result;
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError)) {
      await logCall(row(false));
      recordGeneration(info, model, startTime, { input, error });
    }
    throw error;
  }
}

/** Generates text. Example: callText({ module: 3, feature: "support-answer" }, { prompt }) */
export async function callText(info: CallInfo, options: TextOptions) {
  return tracked(info, options.prompt ?? options.messages, (model) =>
    generateText({
      maxRetries: MAX_RETRIES,
      ...options,
      model: languageModel(model),
    }),
  );
}

/** Generates an object that matches a zod schema; read it from `result.output`. */
export async function callObject<Schema extends z.ZodType>(
  info: CallInfo,
  options: TextOptions & { schema: Schema },
) {
  const { schema, ...rest } = options;
  const result = await tracked(info, rest.prompt ?? rest.messages, (model) =>
    generateText({
      maxRetries: MAX_RETRIES,
      ...rest,
      model: languageModel(model),
      output: Output.object({ schema }),
    }),
  );
  // Spreading `rest` loses generateText's output type; Output.object has
  // already validated it against `schema`, so restore the type here.
  return result as typeof result & { output: z.infer<Schema> };
}

/**
 * Embeds many texts in one go; read `result.embeddings` (same order as `values`).
 * Example: callEmbedMany({ module: 3, feature: "embed-docs" }, passages)
 */
export async function callEmbedMany(
  info: Omit<CallInfo, "model">,
  values: string[],
) {
  const started = performance.now();
  // Google doesn't report tokens for embeddings, so tokens and cost are null.
  const log = (ok: boolean) =>
    logCall({
      module: info.module,
      feature: info.feature,
      model: EMBEDDING_MODEL,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      created_at: new Date().toISOString(),
    });
  try {
    const result = await embedMany({
      model: google().embedding(EMBEDDING_MODEL.slice("google/".length)),
      values,
      providerOptions: {
        google: { outputDimensionality: EMBEDDING_DIMENSIONS },
      },
    });
    await log(true);
    return result;
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError)) await log(false);
    throw error;
  }
}

type StreamOptions = DistributiveOmit<
  Parameters<typeof streamText>[0],
  "model" | "output" | "onFinish" | "onError"
>;

/**
 * Streams a reply: read `result.fullStream` to see each step as it happens
 * (thinking, tool calls, tool results, text). Logged to ai_calls when it ends.
 * Example: callStream({ module: 2, feature: "ask-copper" }, { messages })
 */
export function callStream(info: CallInfo, options: StreamOptions) {
  const model = info.model ?? defaultModel();
  const row = rowFor(info, model, performance.now());
  const startTime = new Date();
  // The conversation so far, as Langfuse shows it: the latest message is enough.
  const input = options.messages?.at(-1) ?? options.prompt;
  return streamText({
    maxRetries: MAX_RETRIES,
    ...options,
    model: languageModel(model),
    onFinish: ({ totalUsage, text, steps }) => {
      recordGeneration(info, model, startTime, {
        input,
        output: text,
        usage: totalUsage,
        steps,
      });
      return logCall(row(true, totalUsage));
    },
    onError: ({ error }) => {
      recordGeneration(info, model, startTime, { input, error });
      return logCall(row(false));
    },
  });
}

// Asking for some thinking (rather than letting the model decide) is what
// makes Gemini write a summary even for an easy question.
const THINKING = { includeThoughts: true, thinkingBudget: 1024 };

/**
 * Asks Gemini to include a summary of its thinking in the stream (as
 * reasoning parts). Other models ignore it. Pass as `providerOptions`.
 */
export const THOUGHT_SUMMARIES = {
  google: { thinkingConfig: THINKING },
};
