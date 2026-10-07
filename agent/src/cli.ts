#!/usr/bin/env -S npx tsx
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { advance, approve } from "./orchestrator.ts";
import { PHASES } from "./phases/index.ts";
import { GateSchema, RunStore, type RunState } from "./state/run-store.ts";
import type { AppSpec } from "./state/spec.ts";

const USAGE = `Usage:
  shopify-app-agent new <app-name> "<idea>"
  shopify-app-agent resume <app-name>
  shopify-app-agent approve <app-name> <${GateSchema.options.join("|")}>
  shopify-app-agent status <app-name>`;

const workspaceRoot = resolve(process.env.AGENT_WORKSPACE ?? "workspace");
const storeFor = (name: string) => new RunStore(join(workspaceRoot, name));

function report(state: RunState): void {
  const phase = PHASES[state.phaseIndex]?.name ?? "complete";
  console.log(`${state.appName}: ${state.status} at ${phase}`);
  if (state.pendingGate) console.log(`Waiting for approval: run \`approve ${state.appName} ${state.pendingGate}\``);
  if (state.lastError) console.log(`Last error: ${state.lastError}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, name, ...rest] = argv;
  if (!command || !name) {
    console.error(USAGE);
    return 2;
  }
  const store = storeFor(name);

  switch (command) {
    case "new": {
      const idea = rest.join(" ").trim();
      if (!idea) {
        console.error(USAGE);
        return 2;
      }
      await mkdir(store.appDir, { recursive: true });
      const spec: AppSpec = { name, idea, surfaces: ["embedded-admin", "theme-extension"], stories: [], scopes: [], outOfScope: [] };
      await writeFile(join(store.appDir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
      await store.init(name);
      report(await advance(store, PHASES));
      return 0;
    }
    case "resume":
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
    case "status":
      report(await store.load());
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
