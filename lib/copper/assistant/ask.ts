"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: on the Support page the chat also sends the Refund Console's
// "desk" (the auto-refund limit and the refunds so far) and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too.
// Module 5: every question is traced in Langfuse (lib/ai/langfuse.ts), and the
// same questions can run on one support agent with every tool and no handoff
// ("single"), to compare with the two agents ("multi", the default).
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { Trace } from "@/lib/ai/langfuse";
import { createLive, type Live } from "@/lib/ai/live";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  SUPPORT_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import type {
  Agent,
  Architecture,
  Progress,
  ToolStep,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundAgentTools,
  supportAgentTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and refunds (Support page only). */
  desk?: Desk;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
  /**
   * Two agents with a handoff ("multi", the default) or one support agent
   * ("single"). AGENT_ARCHITECTURE=single sets it for the whole app.
   */
  architecture?: Architecture;
  /** Extra Langfuse tags, such as the eval case. */
  tags?: string[];
  /** Make the Langfuse trace public (anyone with the link can view it). */
  share?: boolean;
};

/** The app's architecture unless a request names one. */
function defaultArchitecture(): Architecture {
  return process.env.AGENT_ARCHITECTURE === "single" ? "single" : "multi";
}

/** How each agent is named in Langfuse. */
const TRACE_NAMES = {
  copper: "Copper",
  refund: "Refund agent",
  single: "Support agent",
} as const;

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** One agent's call: its instructions and only its own tools. */
function agentCall(
  agent: Agent,
  messages: ChatMessage[],
  desk: Desk | undefined,
  architecture: Architecture,
  trace: Trace,
) {
  if (architecture === "single" && desk)
    return callStream(
      {
        module: 5,
        feature: "support-agent",
        trace,
        name: TRACE_NAMES.single,
      },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: SUPPORT_AGENT_INSTRUCTIONS,
        tools: supportAgentTools(desk),
        stopWhen: stepCountIs(MAX_STEPS),
      },
    );
  if (agent === "refund" && desk)
    return callStream(
      { module: 4, feature: "refund-agent", trace, name: TRACE_NAMES.refund },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: REFUND_AGENT_INSTRUCTIONS,
        tools: refundAgentTools(desk),
        stopWhen: STOP,
      },
    );
  return callStream(
    { module: 2, feature: "ask-copper", trace, name: TRACE_NAMES.copper },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: desk
        ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
        : COPPER_INSTRUCTIONS,
      tools: desk
        ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
        : copperTools,
      stopWhen: STOP,
    },
  );
}

export async function askCopper({
  messages,
  useTools,
  desk,
  agent = "copper",
  architecture = defaultArchitecture(),
  tags = [],
  share = false,
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  // The single agent never hands off, so it always answers first.
  const first: Agent =
    desk && useTools && architecture === "multi" ? agent : "copper";
  const started = performance.now();
  const trace = new Trace("ask-copper", {
    input: messages.at(-1)?.content,
    metadata: {
      architecture,
      useTools,
      firstAgent: architecture === "single" ? "single" : first,
      page: desk ? "support" : "home",
      turns: messages.length,
    },
    tags: [
      useTools ? `${architecture}-agent` : "no-tools",
      desk ? "support-page" : "home-page",
      ...tags,
    ],
  });
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
    traceId: trace.id,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /** Reads one agent's stream into progress. Returns who to hand off to. */
  async function follow(
    current: Agent,
    result: ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking" && last.agent === current)
            last.text += part.text;
          else
            progress.steps.push({
              type: "thinking",
              text: part.text,
              agent: current,
            });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: `${call}:${part.id}`,
            agent: current,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.toolCallId}`,
              agent: current,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName in HANDOFF_TOOLS)
            handoff = HANDOFF_TOOLS[part.toolName];
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    // Let the call finish recording itself (tokens, cost) on the trace.
    await Promise.resolve(result.steps).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    return handoff;
  }

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      if (!useTools) {
        // Without tools, send no instructions either: "always use your
        // tools" with no tools makes the model answer with nothing.
        await follow(
          "copper",
          callStream(
            {
              module: 2,
              feature: "ask-copper",
              trace,
              name: "Copper (no tools)",
            },
            { messages, providerOptions: THOUGHT_SUMMARIES },
          ),
        );
      } else {
        let current = first;
        for (let handoffs = 0; ; handoffs++) {
          const next = await follow(
            current,
            agentCall(current, messages, desk, architecture, trace),
          );
          if (!next || next === current || handoffs >= MAX_HANDOFFS) break;
          progress.steps.push({ type: "handoff", from: current, to: next });
          progress.agent = current = next;
          progress.reply = "";
          call++;
          update(snapshot());
        }
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch (error) {
      console.error(
        "[ask-copper] failed:",
        error instanceof Error ? error.message : String(error),
      );
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }

    // Module 5: close the Langfuse trace: who answered, with which tools,
    // and what it took.
    const tools = progress.steps.flatMap((s) =>
      s.type === "tool" ? [s.name] : [],
    );
    const answeredBy =
      architecture === "single" && desk && useTools
        ? TRACE_NAMES.single
        : TRACE_NAMES[progress.agent ?? "copper"];
    progress.usage = {
      ...trace.totals,
      latencyMs: Math.round(performance.now() - started),
    };
    trace.finish({
      output: progress.reply,
      metadata: {
        answeredBy,
        tools,
        handoffs: progress.steps.filter((s) => s.type === "handoff").length,
        status: progress.status,
        latencyMs: progress.usage.latencyMs,
      },
      tags: [`answered-by:${answeredBy}`],
      public: share,
    });
    await trace.flush();
    done(snapshot());
  })();

  return { progress: live };
}
