import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advance, answer, approve, MAX_ATTEMPTS } from "../src/orchestrator.ts";
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

  it("honours a phase's own attempt limit", async () => {
    const store = await newStore();
    let calls = 0;
    const once: Phase = { name: "scaffold", maxAttempts: 1, run: async () => (calls++, { kind: "failed", error: "no" }) };
    await advance(store, [once]);
    expect(calls).toBe(1);
  });

  it("rejects an answer when no question is pending", async () => {
    const store = await newStore();
    await expect(answer(store, "hello")).rejects.toThrow(/No question/);
  });
});
