import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advance, answer, approve, MAX_ATTEMPTS, requestChanges } from "../src/orchestrator.ts";
import { PHASES } from "../src/phases/index.ts";
import type { Phase } from "../src/phases/types.ts";
import { RunStore } from "../src/state/run-store.ts";

const done = (name: string, gatesBefore?: Phase["gatesBefore"]): Phase => ({
  name,
  gatesBefore,
  run: async () => ({ kind: "done", summary: name }),
});

async function newStore(): Promise<RunStore> {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "agent-")));
  await store.init("test-app");
  return store;
}

describe("advance", () => {
  it("stops at a gate and continues once it is approved", async () => {
    const store = await newStore();
    const phases = [done("a"), done("b", ["deploy"]), done("c")];

    expect(await advance(store, phases)).toMatchObject({ status: "awaiting-approval", pendingGate: "deploy", phaseIndex: 1 });
    expect((await advance(store, phases)).status).toBe("awaiting-approval");

    await approve(store, "deploy");
    expect(await advance(store, phases)).toMatchObject({ status: "done", phaseIndex: 3 });
  });

  it("retries a failing phase, then stops with its error", async () => {
    const store = await newStore();
    let calls = 0;
    const flaky: Phase = { name: "build", run: async () => (calls++, { kind: "failed", error: "tsc failed" }) };

    const state = await advance(store, [flaky, done("review")]);
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(state).toMatchObject({ status: "failed", phaseIndex: 0, lastError: "build: tsc failed" });
  });

  it("rejects an answer when no question is pending", async () => {
    const store = await newStore();
    await expect(answer(store, "hello")).rejects.toThrow(/No question/);
  });
});

describe("the development process", () => {
  it("asks each question, waits for review and confirmation, then runs to the end", async () => {
    const store = await newStore();
    const replies: Record<string, string> = {
      name: "Stock Signal",
      description: "Shows an 'Only N left' badge when stock is low.",
      functionalities: "- Pick products\n- Set a threshold; Show the badge on product pages",
      flow: "Merchant installs, picks products, sets thresholds; shoppers see the badge.",
    };

    let state = await advance(store, PHASES);
    const asked: string[] = [];
    while (state.status === "awaiting-input") {
      asked.push(state.pendingQuestion!.id);
      await answer(store, replies[state.pendingQuestion!.id]!);
      state = await advance(store, PHASES);
    }
    expect(asked).toEqual(["name", "description", "functionalities", "flow"]);
    expect(state).toMatchObject({ status: "awaiting-approval", pendingGate: "architecture" });

    const spec = JSON.parse(await readFile(join(store.appDir, "spec.json"), "utf8"));
    expect(spec.functionalities).toEqual(["Pick products", "Set a threshold", "Show the badge on product pages"]);

    await requestChanges(store, PHASES, "Add a CSV export of low-stock products");
    state = await advance(store, PHASES);
    expect(state.pendingGate).toBe("architecture");
    expect(await readFile(join(store.appDir, "architecture.md"), "utf8")).toContain("Add a CSV export");

    await approve(store, "architecture");
    expect((await advance(store, PHASES)).pendingGate).toBe("start-development");
    await approve(store, "start-development");
    expect((await advance(store, PHASES)).pendingGate).toBe("deploy");
    await approve(store, "deploy");
    expect((await advance(store, PHASES)).status).toBe("done");
  });
});
