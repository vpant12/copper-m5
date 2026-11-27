// Module 5: the AI judge. A second Gemini call reads the customer's question,
// what a good answer does, the tools the agent used, and the agent's answer,
// and grades it. Like every AI call, it goes through lib/ai/call.ts.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type { GoldenCase } from "./golden-set";

export const verdictSchema = z.object({
  pass: z
    .boolean()
    .describe("True only if the answer does everything a good answer does."),
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("0 to 1: how well the answer meets the description."),
  reason: z.string().describe("One or two sentences explaining the grade."),
});

export type Verdict = z.infer<typeof verdictSchema>;

export const JUDGE_INSTRUCTIONS = `You grade a customer-support chatbot for Copper State Labs, a company that sells smart devices.
You get the customer's question, a description of what a good answer does, the tools the chatbot used (with what they returned), and the chatbot's answer.
Grade only against the description. An answer passes if it does everything the description says, and nothing it says not to do. Extra friendly wording is fine; wrong facts, invented features or promises the description rules out are not.
Be strict but fair: if the facts are right but worded differently, it passes.`;

export async function judge(
  testCase: GoldenCase,
  answer: string,
  tools: { name: string; output?: unknown }[],
): Promise<Verdict> {
  const toolLines = tools.length
    ? tools
        .map(
          (t) =>
            `- ${t.name}: ${JSON.stringify(t.output ?? null).slice(0, 400)}`,
        )
        .join("\n")
    : "- (none)";
  const { output } = await callObject(
    { module: 5, feature: "eval-judge" },
    {
      schema: verdictSchema,
      system: JUDGE_INSTRUCTIONS,
      prompt: `Customer's question:
${testCase.question}

What a good answer does:
${testCase.good}

Tools the chatbot used, and what they returned:
${toolLines}

The chatbot's answer:
${answer}`,
    },
  );
  return output;
}
