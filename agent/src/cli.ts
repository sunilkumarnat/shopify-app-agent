#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { advance, answer, approve, requestChanges } from "./orchestrator.ts";
import { createDefaultPhases } from "./phases/index.ts";
import { GateSchema, RunStore, type GateName, type RunState } from "./state/run-store.ts";

const USAGE = `Usage:
  shopify-app-agent new <app-id>                     start a new app and answer the agent's questions
  shopify-app-agent resume <app-id>                  continue where the run stopped
  shopify-app-agent answer <app-id> "<answer>"       answer the pending question
  shopify-app-agent approve <app-id> <${GateSchema.options.join("|")}>
  shopify-app-agent changes <app-id> "<feedback>"    ask for changes to the architecture
  shopify-app-agent status <app-id>

In a terminal, new and resume ask questions and approvals interactively.`;

const GATE_PROMPTS: Record<GateName, string> = {
  architecture: "Review architecture.md. Type 'yes' to confirm it, or describe the changes you want",
  "start-development": "Start development now? Type 'yes' to confirm",
  deploy: "The checklist and tests have passed. Review deploy-plan.md. Deploy the app as planned? Type 'yes' to confirm",
};

// npm runs workspace scripts from agent/, so resolve paths from where the user ran the command.
const invokedFrom = process.env.INIT_CWD ?? process.cwd();
const envFile = join(invokedFrom, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const workspaceRoot = resolve(invokedFrom, process.env.AGENT_WORKSPACE ?? "workspace");
const PHASES = createDefaultPhases(Boolean(process.stdin.isTTY));
const storeFor = (appId: string) => new RunStore(join(workspaceRoot, appId));

function report(state: RunState): void {
  const phase = PHASES[state.phaseIndex]?.name ?? "complete";
  console.log(`${state.appId}: ${state.status} at ${phase}`);
  if (state.pendingQuestion) console.log(`Question: ${state.pendingQuestion.prompt}`);
  if (state.pendingGate) console.log(`Waiting for you: ${GATE_PROMPTS[state.pendingGate]}`);
  if (state.lastError) console.log(`Last error: ${state.lastError}`);
}

// Keeps the run moving, asking each question and approval in the terminal.
async function interactive(store: RunStore): Promise<RunState> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let state = await advance(store, PHASES);
    while (state.status === "awaiting-input" || state.status === "awaiting-approval") {
      if (state.pendingQuestion) {
        const reply = await rl.question(`\n${state.pendingQuestion.prompt}\n> `);
        if (!reply.trim()) continue;
        await answer(store, reply);
      } else if (state.pendingGate) {
        const review = { architecture: "architecture.md", "start-development": undefined, deploy: "deploy-plan.md" }[state.pendingGate];
        console.log(review ? `\nReview: ${join(store.appDir, review)}` : "");
        const reply = (await rl.question(`${GATE_PROMPTS[state.pendingGate]}\n> `)).trim();
        if (/^y(es)?$/i.test(reply)) await approve(store, state.pendingGate);
        else if (state.pendingGate === "architecture" && reply) await requestChanges(store, PHASES, reply);
        else return state;
      }
      state = await advance(store, PHASES);
    }
    return state;
  } finally {
    rl.close();
  }
}

const run = (store: RunStore) => (process.stdin.isTTY ? interactive(store) : advance(store, PHASES));

async function main(argv: string[]): Promise<number> {
  const [command, appId, ...rest] = argv;
  if (!command || !appId) {
    console.error(USAGE);
    return 2;
  }
  const store = storeFor(appId);
  const text = rest.join(" ").trim();

  switch (command) {
    case "new":
      await mkdir(store.appDir, { recursive: true });
      await store.init(appId);
      report(await run(store));
      return 0;
    case "resume":
      report(await run(store));
      return 0;
    case "answer":
      await answer(store, text);
      report(await advance(store, PHASES));
      return 0;
    case "approve": {
      const gate = GateSchema.safeParse(rest[0]);
      if (!gate.success) {
        console.error(USAGE);
        return 2;
      }
      await approve(store, gate.data);
      report(await advance(store, PHASES));
      return 0;
    }
    case "changes":
      await requestChanges(store, PHASES, text);
      report(await advance(store, PHASES));
      return 0;
    case "status":
      report(await store.load());
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
