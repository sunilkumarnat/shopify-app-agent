import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advance, approve, MAX_ATTEMPTS } from "../src/orchestrator.ts";
import type { Phase } from "../src/phases/types.ts";
import { RunStore } from "../src/state/run-store.ts";

const ok = (name: string, gatesBefore?: Phase["gatesBefore"]): Phase => ({
  name,
  gatesBefore,
  run: async () => ({ ok: true, summary: name }),
});

async function newStore(): Promise<RunStore> {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "agent-")));
  await store.init("test-app");
  return store;
}

describe("advance", () => {
  it("stops at a gate and continues once it is approved", async () => {
    const store = await newStore();
    const phases = [ok("intake"), ok("design", ["spec"]), ok("handoff")];

    const waiting = await advance(store, phases);
    expect(waiting).toMatchObject({ status: "awaiting-approval", pendingGate: "spec", phaseIndex: 1 });

    await approve(store, "spec");
    const done = await advance(store, phases);
    expect(done).toMatchObject({ status: "done", phaseIndex: 3 });
  });

  it("does not move past a gate while it is still pending", async () => {
    const store = await newStore();
    const phases = [ok("design", ["spec"])];
    await advance(store, phases);
    expect((await advance(store, phases)).status).toBe("awaiting-approval");
  });

  it("retries a failing phase, then stops with its error", async () => {
    const store = await newStore();
    let calls = 0;
    const flaky: Phase = { name: "build", run: async () => (calls++, { ok: false, error: "tsc failed" }) };

    const state = await advance(store, [flaky, ok("review")]);
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(state).toMatchObject({ status: "failed", phaseIndex: 0, lastError: "build: tsc failed" });
  });
});
