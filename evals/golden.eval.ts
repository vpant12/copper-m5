// Module 5: the golden-set eval. For each question in evals/golden-set.ts it
// asks Ask Copper, checks the tools it used (code), asks the AI judge to grade
// the answer, and sends the scores to Langfuse on the answer's trace. Each run
// is a Langfuse dataset run, so runs (and the two architectures) can be
// compared side by side in Langfuse: pass rate, cost and latency.
//
//   npm run eval            the two agents (what ships); fails under the bar
//   npm run eval:compare    the two agents and the single support agent
//
// In GitHub Actions the results also go to the job summary, so they show in
// the pull request's checks.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAiConfigured } from "@/lib/ai/call";
import {
  isLangfuseConfigured,
  langfuseApi,
  langfuseBaseUrl,
  scoreTrace,
  traceUrl,
} from "@/lib/ai/langfuse";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import {
  type Architecture,
  toolCallsOf,
} from "@/lib/copper/assistant/progress";
import { DEFAULT_DESK, GOLDEN_SET, type GoldenCase } from "./golden-set";
import { judge } from "./judge";

const DATASET = "copper-golden-set";
/** This case's multi-agent trace is shared publicly (a refund conversation). */
const SHARED_CASE = "refund-over-limit";
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 3000);
let sharedTraceUrl: string | null = null;
/** The two agents must pass at least this share of the golden set. */
const MIN_PASS_RATE = Number(process.env.EVAL_MIN_PASS_RATE ?? 0.8);

const architectures: Architecture[] = (
  process.env.EVAL_ARCHITECTURES ??
  (import.meta.env.MODE === "compare" ? "multi,single" : "multi")
)
  .split(",")
  .map((a) => (a.trim() === "single" ? "single" : "multi"));

const onlyCases = process.env.EVAL_CASES?.split(",").map((c) => c.trim());
const cases = onlyCases
  ? GOLDEN_SET.filter((c) => onlyCases.includes(c.id))
  : GOLDEN_SET;

const label =
  process.env.GITHUB_SHA?.slice(0, 7) ??
  new Date().toISOString().slice(0, 16).replace("T", " ");

const ARCH_NAMES: Record<Architecture, string> = {
  multi: "Multi-agent (Copper + Refund agent)",
  single: "Single agent (one support agent)",
};

type CaseResult = {
  id: string;
  topic: string;
  passed: boolean;
  judgeScore: number;
  toolsOk: boolean;
  reason: string;
  costUsd: number;
  latencyMs: number;
  tokens: number;
  traceId?: string;
};

type RunSummary = {
  architecture: Architecture;
  runName: string;
  passRate: number;
  passed: number;
  total: number;
  avgJudgeScore: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  avgTokens: number;
  results: CaseResult[];
};

const summaries: RunSummary[] = [];
let datasetUrl: string | null = null;

/** The plain-code checks: the right tools, and the right refund decision. */
function checkTools(
  testCase: GoldenCase,
  tools: { name: string; output?: unknown }[],
) {
  const names = tools.map((t) => t.name);
  const problems: string[] = [];
  for (const tool of testCase.mustUse ?? [])
    if (!names.includes(tool)) problems.push(`didn't use ${tool}`);
  for (const tool of testCase.mustNotUse ?? [])
    if (names.includes(tool)) problems.push(`used ${tool}`);
  if (testCase.refundStatus) {
    const statuses = tools
      .filter((t) => t.name === "request_refund")
      .map((t) => (t.output as { status?: string } | undefined)?.status);
    if (!statuses.includes(testCase.refundStatus))
      problems.push(
        `refund decision ${statuses.join("/") || "missing"}, expected ${testCase.refundStatus}`,
      );
  }
  return problems;
}

/** Makes sure the dataset and its items exist in Langfuse (safe to repeat). */
async function syncDataset() {
  if (!isLangfuseConfigured()) return;
  await langfuseApi("v2/datasets", {
    body: {
      name: DATASET,
      description:
        "Ask Copper's golden set: real customer questions and what a good answer does (evals/golden-set.ts).",
    },
  });
  for (const testCase of GOLDEN_SET) {
    await langfuseApi("dataset-items", {
      body: {
        datasetName: DATASET,
        id: `golden-${testCase.id}`,
        input: {
          question: testCase.question,
          desk: testCase.desk ?? DEFAULT_DESK,
        },
        expectedOutput: testCase.good,
        metadata: {
          topic: testCase.topic,
          mustUse: testCase.mustUse,
          mustNotUse: testCase.mustNotUse,
          refundStatus: testCase.refundStatus,
        },
      },
    });
  }
  const dataset = await langfuseApi<{ id: string }>(`v2/datasets/${DATASET}`);
  const projects = await langfuseApi<{ data: { id: string }[] }>("projects");
  const project = projects?.data?.[0]?.id;
  if (dataset?.id && project)
    datasetUrl = `${langfuseBaseUrl()}/project/${project}/datasets/${dataset.id}`;
}

async function runCase(
  testCase: GoldenCase,
  architecture: Architecture,
  runName: string,
): Promise<CaseResult> {
  const { progress } = await askCopper({
    messages: [{ role: "user", content: testCase.question }],
    useTools: true,
    desk: testCase.desk ?? DEFAULT_DESK,
    architecture,
    tags: ["eval", `case:${testCase.id}`],
    // One refund conversation (Copper hands off to the Refund agent) is made
    // public, so its trace can be shared.
    share: testCase.id === SHARED_CASE && architecture === "multi",
  });
  const answer = await finalValue(progress);
  const tools = toolCallsOf(answer);
  const problems = checkTools(testCase, tools);
  if (answer.status !== "done") problems.push("the answer failed");

  let verdict = { pass: false, score: 0, reason: "" };
  try {
    verdict = await judge(testCase, answer.reply, tools);
  } catch (error) {
    verdict.reason = `The judge failed: ${(error as Error).message}`;
  }
  const toolsOk = problems.length === 0;
  const passed = verdict.pass && toolsOk;
  const reason = [verdict.reason, ...problems.map((p) => `Tool check: ${p}.`)]
    .filter(Boolean)
    .join(" ");

  const traceId = answer.traceId;
  if (traceId && testCase.id === SHARED_CASE && architecture === "multi")
    sharedTraceUrl = await traceUrl(traceId);
  if (traceId && isLangfuseConfigured()) {
    await scoreTrace(traceId, "judge", verdict.score, verdict.reason);
    await scoreTrace(
      traceId,
      "tools_ok",
      toolsOk ? 1 : 0,
      problems.join("; ") || "ok",
    );
    await scoreTrace(traceId, "passed", passed ? 1 : 0, reason);
    await langfuseApi("dataset-run-items", {
      body: {
        runName,
        runDescription: `${ARCH_NAMES[architecture]}, ${label}`,
        datasetItemId: `golden-${testCase.id}`,
        traceId,
        metadata: { architecture },
      },
    });
  }

  return {
    id: testCase.id,
    topic: testCase.topic,
    passed,
    judgeScore: verdict.score,
    toolsOk,
    reason,
    costUsd: answer.usage?.costUsd ?? 0,
    latencyMs: answer.usage?.latencyMs ?? 0,
    tokens:
      (answer.usage?.inputTokens ?? 0) + (answer.usage?.outputTokens ?? 0),
    traceId,
  };
}

const usd = (n: number) => `$${n.toFixed(5)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const avg = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function report(summary: RunSummary): string {
  const rows = summary.results
    .map(
      (r) =>
        `| ${r.passed ? "✅" : "❌"} | ${r.topic} | ${r.judgeScore.toFixed(2)} | ${r.toolsOk ? "ok" : "no"} | ${usd(r.costUsd)} | ${secs(r.latencyMs)} | ${r.reason.replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 220)} |`,
    )
    .join("\n");
  return `### ${ARCH_NAMES[summary.architecture]}: ${summary.passed}/${summary.total} passed (${Math.round(summary.passRate * 100)}%)

Langfuse dataset run: \`${summary.runName}\` · average judge score ${summary.avgJudgeScore.toFixed(2)} · average cost ${usd(summary.avgCostUsd)} per question · average time ${secs(summary.avgLatencyMs)} · average ${Math.round(summary.avgTokens)} tokens

| | Case | Judge | Tools | Cost | Time | Why |
|---|---|---|---|---|---|---|
${rows}
`;
}

function comparison(): string {
  if (summaries.length < 2) return "";
  const rows = summaries
    .map(
      (s) =>
        `| ${ARCH_NAMES[s.architecture]} | ${Math.round(s.passRate * 100)}% (${s.passed}/${s.total}) | ${s.avgJudgeScore.toFixed(2)} | ${usd(s.avgCostUsd)} | ${usd(s.totalCostUsd)} | ${secs(s.avgLatencyMs)} | ${Math.round(s.avgTokens)} |`,
    )
    .join("\n");
  return `## Single agent vs multi agent

| Architecture | Pass rate | Avg judge score | Avg cost / question | Total cost | Avg time / question | Avg tokens |
|---|---|---|---|---|---|---|
${rows}
`;
}

function writeOutputs() {
  const markdown = `## Golden-set eval (${label})

${summaries.map(report).join("\n")}
${comparison()}
${datasetUrl ? `Compare the runs in Langfuse: ${datasetUrl}\n` : ""}
${sharedTraceUrl ? `A refund conversation (public trace): ${sharedTraceUrl}\n` : ""}`;
  mkdirSync("eval-results", { recursive: true });
  writeFileSync("eval-results/summary.md", markdown);
  writeFileSync(
    "eval-results/summary.json",
    JSON.stringify({ label, datasetUrl, summaries }, null, 2),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

describe.skipIf(!isAiConfigured())("golden-set eval", () => {
  for (const architecture of architectures) {
    it(
      `${ARCH_NAMES[architecture]} passes the golden set`,
      { timeout: 30 * 60_000 },
      async () => {
        if (!summaries.length) await syncDataset();
        const runName = `${architecture}-agent ${label}`;
        const results: CaseResult[] = [];
        for (const [i, testCase] of cases.entries()) {
          // A short pause between questions: Google's free tier allows only a
          // few requests a minute. (The time per answer doesn't include it.)
          if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
          const result = await runCase(testCase, architecture, runName);
          results.push(result);
          console.log(
            `${result.passed ? "PASS" : "FAIL"} [${architecture}] ${testCase.id}: ${result.reason}`,
          );
        }
        const passed = results.filter((r) => r.passed).length;
        const summary: RunSummary = {
          architecture,
          runName,
          passRate: passed / results.length,
          passed,
          total: results.length,
          avgJudgeScore: avg(results.map((r) => r.judgeScore)),
          avgCostUsd: avg(results.map((r) => r.costUsd)),
          totalCostUsd: results.reduce((a, r) => a + r.costUsd, 0),
          avgLatencyMs: avg(results.map((r) => r.latencyMs)),
          avgTokens: avg(results.map((r) => r.tokens)),
          results,
        };
        summaries.push(summary);
        writeOutputs();
        // GitHub shows this line on the pull request's checks.
        console.log(
          `::notice title=Golden-set eval, ${architecture}-agent::${passed}/${results.length} passed (${Math.round(summary.passRate * 100)}%), avg judge ${summary.avgJudgeScore.toFixed(2)}, avg cost ${usd(summary.avgCostUsd)}, avg time ${secs(summary.avgLatencyMs)}`,
        );
        // Only the architecture that ships (the two agents) has to pass.
        if (architecture === "multi")
          expect(
            summary.passRate,
            `${passed}/${results.length} passed; at least ${MIN_PASS_RATE * 100}% must`,
          ).toBeGreaterThanOrEqual(MIN_PASS_RATE);
      },
    );
  }
});
