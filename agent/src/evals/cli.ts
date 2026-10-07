import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runClaude } from "../claude.ts";
import { runCommand } from "../tools/exec.ts";
import { loadEvalApps } from "./eval-app.ts";
import { evalReport, runEval, type EvalDepth, type EvalResult } from "./run.ts";

const USAGE = `Usage: npm run evals -- [--app <id>]... [--depth architecture|build]

  --app     run only these eval apps (default: every app in evals/apps)
  --depth   architecture (default): questions and architecture, real Claude, no Shopify account
            build: also scaffold and build the app; needs a terminal logged in to Shopify`;

const repoRoot = resolve(import.meta.dirname, "../../..");
const invokedFrom = process.env.INIT_CWD ?? process.cwd();
const envFile = join(invokedFrom, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { app: { type: "string", multiple: true }, depth: { type: "string", default: "architecture" }, help: { type: "boolean" } },
  });
  if (values.help) return (console.log(USAGE), 0);
  const depth = values.depth as EvalDepth;
  if (depth !== "architecture" && depth !== "build") return (console.error(USAGE), 2);
  const interactive = Boolean(process.stdin.isTTY);
  if (depth === "build" && !interactive) return (console.error("--depth build needs a terminal for the Shopify login."), 2);

  const apps = await loadEvalApps(join(repoRoot, "evals", "apps"), values.app);
  if (apps.length === 0) return (console.error("No eval apps matched."), 2);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(repoRoot, "workspace", "evals", stamp);
  const deps = { claude: runClaude, runner: runCommand, interactive };
  console.log(`Running ${apps.length} eval app(s) at depth "${depth}"…`);

  // Architecture evals only talk to Claude, so they run in parallel; builds need the terminal.
  const results: EvalResult[] = [];
  if (depth === "architecture") {
    results.push(...(await Promise.all(apps.map((app) => runEval(app, join(runDir, app.id), depth, deps)))));
  } else {
    for (const app of apps) results.push(await runEval(app, join(runDir, app.id), depth, deps));
  }

  const report = evalReport(results);
  await mkdir(join(repoRoot, "evals", "results"), { recursive: true });
  const reportFile = join(repoRoot, "evals", "results", `${stamp}.md`);
  await writeFile(reportFile, report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  console.log(`\n${report}\nReport: ${reportFile}\nGenerated apps: ${runDir}`);
  return results.every((r) => r.passed) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
