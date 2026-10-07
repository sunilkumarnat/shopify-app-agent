import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeRunner } from "../claude.ts";
import { advance, answer, approve } from "../orchestrator.ts";
import { createPhases } from "../phases/index.ts";
import { RunStore, type RunState } from "../state/run-store.ts";
import { AppSpecSchema } from "../state/spec.ts";
import { findAppRoot } from "../tools/app-root.ts";
import type { CommandRunner } from "../tools/exec.ts";
import { checkPolarisOnly } from "../tools/polaris-check.ts";
import type { EvalApp } from "./eval-app.ts";
import { gradeCriteria, scoreAppConfig, scoreArchitecture, type CheckScore } from "./score.ts";

// "architecture" runs the questions and the architecture with real Claude and no Shopify
// account, so it is cheap enough for CI. "build" also scaffolds and builds the app, which needs
// a terminal logged in to Shopify.
export type EvalDepth = "architecture" | "build";

export interface EvalResult {
  app: string;
  depth: EvalDepth;
  score: number;
  passed: boolean;
  checks: CheckScore[];
  costUsd: number;
  appDir: string;
  error?: string;
}

export interface EvalDeps {
  claude: ClaudeRunner;
  runner: CommandRunner;
  interactive: boolean;
}

const PHASE_AFTER: Record<EvalDepth, string> = { architecture: "architecture", build: "build" };

async function runCost(appDir: string): Promise<number> {
  const file = join(appDir, ".agent", "run-log.jsonl");
  if (!existsSync(file)) return 0;
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { costUsd?: number })
    .reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
}

// Plays the user: answers every question from the eval app and gives every confirmation the
// depth needs, until the last phase of that depth is done or the run stops.
async function drive(store: RunStore, app: EvalApp, depth: EvalDepth, deps: EvalDeps): Promise<RunState> {
  const all = createPhases(deps);
  const phases = all.slice(0, all.findIndex((p) => p.name === PHASE_AFTER[depth]) + 1);
  let state = await advance(store, phases);
  for (;;) {
    if (state.status === "awaiting-input") {
      const id = state.pendingQuestion!.id;
      // Build evals install on a real store, so the store comes from the environment.
      const reply = id === "devStore" && process.env.EVAL_DEV_STORE ? process.env.EVAL_DEV_STORE : app.answers[id];
      if (!reply) throw new Error(`eval.json has no answer for question "${id}"`);
      await answer(store, reply);
    } else if (state.status === "awaiting-approval") {
      await approve(store, state.pendingGate!);
    } else {
      return state;
    }
    state = await advance(store, phases);
  }
}

export async function runEval(app: EvalApp, appDir: string, depth: EvalDepth, deps: EvalDeps): Promise<EvalResult> {
  const store = new RunStore(appDir);
  await store.init(app.id);
  const result = (checks: CheckScore[], extraCost: number, error?: string): Promise<EvalResult> =>
    runCost(appDir).then((cost) => {
      const score = checks.length ? checks.filter((c) => c.passed).length / checks.length : 0;
      return { app: app.id, depth, score, passed: !error && score >= app.minScore, checks, costUsd: cost + extraCost, appDir, error };
    });

  let state: RunState;
  try {
    state = await drive(store, app, depth, deps);
  } catch (err) {
    return result([], 0, (err as Error).message);
  }
  if (!existsSync(join(appDir, "architecture.md"))) return result([], 0, state.lastError ?? "no architecture was written");

  const spec = AppSpecSchema.parse(JSON.parse(await readFile(join(appDir, "spec.json"), "utf8")));
  const architecture = await readFile(join(appDir, "architecture.md"), "utf8");
  const checks = scoreArchitecture(app, spec, architecture);
  const graded = await gradeCriteria(deps.claude, app.expect.criteria, architecture, appDir);
  checks.push(...graded.scores);

  if (depth === "build") {
    checks.push({ name: "app builds with every check green", passed: state.status === "done", detail: state.lastError });
    const appRoot = await findAppRoot(appDir);
    if (appRoot) {
      checks.push(...scoreAppConfig(app, await readFile(join(appRoot, "shopify.app.toml"), "utf8")));
      const polaris = await checkPolarisOnly(appRoot);
      checks.push({ name: "admin UI uses only Polaris web components", passed: polaris.passed, detail: polaris.output });
    }
  }
  return result(checks, graded.costUsd, state.status === "failed" && depth === "architecture" ? state.lastError : undefined);
}

export function evalReport(results: EvalResult[]): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines = [
    "# Agent evals",
    "",
    "| App | Depth | Score | Checks | Cost | Result |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.app} | ${r.depth} | ${pct(r.score)} | ${r.checks.filter((c) => c.passed).length}/${r.checks.length} | $${r.costUsd.toFixed(2)} | ${r.passed ? "Pass" : "Fail"} |`,
    ),
    "",
  ];
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.passed);
    if (!r.error && failed.length === 0) continue;
    lines.push(`## ${r.app}`, "");
    if (r.error) lines.push(`Run failed: ${r.error}`, "");
    lines.push(...failed.map((c) => `- ${c.name}${c.detail ? `: ${c.detail}` : ""}`), "");
  }
  return lines.join("\n");
}
