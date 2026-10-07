import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advance, answer, approve, requestChanges } from "../src/orchestrator.ts";
import { createPhases } from "../src/phases/index.ts";
import { FIX_ROUNDS } from "../src/phases/build.ts";
import { RunStore, type RunState } from "../src/state/run-store.ts";
import { ARCHITECTURE, fakeClaude, fakeRunner } from "./fakes.ts";

const REPLIES: Record<string, string> = {
  name: "Stock Signal",
  description: "Shows an 'Only N left' badge when stock is low.",
  functionalities: "- Pick products\n- Set a threshold; Show the badge on product pages",
  flow: "Merchant installs, picks products, sets thresholds; shoppers see the badge.",
  hasPlans: "yes",
  plans: "Basic: $9/month, 7-day trial, up to 50 products; Pro: $29/month, unlimited products, custom badge text",
  developerAccount: "yes",
  devStore: "stock-signal-dev.myshopify.com",
  hosting: "Fly.io",
};

async function setup(opts: { replies?: Record<string, string>; failingRounds?: number; interactive?: boolean } = {}) {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "agent-")));
  await store.init("stock-signal");
  const { claude, requests } = fakeClaude();
  const { runner, commands } = fakeRunner({ failingRounds: opts.failingRounds });
  const phases = createPhases({ claude, runner, interactive: opts.interactive ?? true });
  const replies = opts.replies ?? REPLIES;
  const asked: string[] = [];

  // Runs until the agent needs a confirmation (or finishes), answering every question.
  const answerAll = async (): Promise<RunState> => {
    let state = await advance(store, phases);
    while (state.status === "awaiting-input") {
      asked.push(state.pendingQuestion!.id);
      await answer(store, replies[state.pendingQuestion!.id]!);
      state = await advance(store, phases);
    }
    return state;
  };
  return { store, phases, requests, commands, asked, answerAll };
}

describe("the development process", () => {
  it("asks every question in order, then has Claude write the architecture", async () => {
    const { store, requests, asked, answerAll } = await setup();

    const state = await answerAll();
    expect(asked).toEqual(["name", "description", "functionalities", "flow", "hasPlans", "plans"]);
    expect(state).toMatchObject({ status: "awaiting-approval", pendingGate: "architecture" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: "architect", tools: [] });
    expect(requests[0]!.prompt).toContain("Pro: $29/month, unlimited products, custom badge text");

    expect(await readFile(join(store.appDir, "architecture.md"), "utf8")).toContain("## Overview");
    const spec = JSON.parse(await readFile(join(store.appDir, "spec.json"), "utf8"));
    expect(spec).toMatchObject({
      functionalities: ["Pick products", "Set a threshold", "Show the badge on product pages"],
      plans: ["Basic: $9/month, 7-day trial, up to 50 products", "Pro: $29/month, unlimited products, custom badge text"],
      scopes: ARCHITECTURE.scopes,
    });
  });

  it("skips the plan details for a free app", async () => {
    const { asked, answerAll } = await setup({ replies: { ...REPLIES, hasPlans: "no" } });
    await answerAll();
    expect(asked).not.toContain("plans");
  });

  it("revises the architecture with the user's feedback and the previous version", async () => {
    const { store, phases, requests, answerAll } = await setup();
    await answerAll();

    await requestChanges(store, phases, "Add a CSV export of low-stock products");
    expect((await advance(store, phases)).pendingGate).toBe("architecture");

    const revision = requests[1]!.prompt;
    expect(revision).toContain("Add a CSV export of low-stock products");
    expect(revision).toContain("## Overview");
  });

  it("scaffolds with Shopify CLI, builds, fixes failing checks, and runs to the end", async () => {
    const { store, phases, requests, commands, asked, answerAll } = await setup({ failingRounds: 1 });
    await answerAll();
    await approve(store, "architecture");

    expect((await answerAll()).pendingGate).toBe("start-development");
    expect(asked.slice(6)).toEqual(["developerAccount", "devStore"]);
    await approve(store, "start-development");

    const state = await answerAll();
    expect(state.pendingGate).toBe("deploy");
    expect(asked.slice(8)).toEqual(["hosting"]);

    expect(commands).toContain(
      `shopify app init --template reactRouter --flavor typescript --name Stock Signal --path ${store.appDir} --package-manager npm`,
    );
    expect(commands.some((c) => c.startsWith("shopify app generate extension --name theme-extension"))).toBe(true);

    const builds = requests.filter((r) => r.role === "builder");
    expect(builds).toHaveLength(2);
    expect(builds[0]!.cwd).toBe(join(store.appDir, "stock-signal"));
    expect(builds[1]).toMatchObject({ resumeSessionId: "build-1" });
    expect(builds[1]!.prompt).toContain("error TS2322");
    expect(builds[0]!.disallowedTools).toContain("Bash(shopify app deploy:*)");

    await approve(store, "deploy");
    expect((await advance(store, phases)).status).toBe("done");
  });

  it("stops the build when checks keep failing", async () => {
    const { store, answerAll } = await setup({ failingRounds: 99 });
    await answerAll();
    await approve(store, "architecture");
    await answerAll();
    await approve(store, "start-development");
    const state = await answerAll();
    expect(state).toMatchObject({ status: "failed" });
    expect(state.lastError).toContain(`after ${FIX_ROUNDS} fix rounds: typecheck`);
  });

  it("asks for a terminal when creating the app without one", async () => {
    const { store, answerAll } = await setup({ interactive: false });
    await answerAll();
    await approve(store, "architecture");
    await answerAll();
    await approve(store, "start-development");
    const state = await answerAll();
    expect(state).toMatchObject({ status: "failed" });
    expect(state.lastError).toContain("Run `resume` in a terminal");
  });
});
