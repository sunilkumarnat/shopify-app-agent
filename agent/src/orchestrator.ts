import type { Phase } from "./phases/types.ts";
import type { GateName, RunState, RunStore } from "./state/run-store.ts";

export const MAX_ATTEMPTS = 3;

// Runs phases in order from the saved position. Stops when a phase needs an approval it
// doesn't have, when a phase keeps failing, or when every phase is done.
export async function advance(store: RunStore, phases: Phase[]): Promise<RunState> {
  let state = await store.load();
  if (state.status === "awaiting-approval") return state;
  state = { ...state, status: "running", lastError: undefined };

  while (state.phaseIndex < phases.length) {
    const phase = phases[state.phaseIndex]!;
    const missingGate = phase.gatesBefore?.find((gate) => !state.approvals.includes(gate));
    if (missingGate) {
      state = { ...state, status: "awaiting-approval", pendingGate: missingGate };
      await store.save(state);
      await store.log("gate.waiting", { phase: phase.name, gate: missingGate });
      return state;
    }

    const error = await runWithRetries(store, phase, state);
    if (error) {
      state = { ...state, status: "failed", lastError: `${phase.name}: ${error}` };
      await store.save(state);
      return state;
    }
    state = { ...state, phaseIndex: state.phaseIndex + 1 };
    await store.save(state);
  }

  state = { ...state, status: "done" };
  await store.save(state);
  await store.log("run.done");
  return state;
}

async function runWithRetries(store: RunStore, phase: Phase, state: RunState): Promise<string | undefined> {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await store.log("phase.start", { phase: phase.name, attempt });
    const result = await phase.run({ appDir: store.appDir, state, log: (e, d) => store.log(e, d) });
    if (result.ok) {
      await store.log("phase.done", { phase: phase.name, summary: result.summary });
      return undefined;
    }
    lastError = result.error;
    await store.log("phase.failed", { phase: phase.name, attempt, error: result.error });
  }
  return lastError;
}

export async function approve(store: RunStore, gate: GateName): Promise<RunState> {
  const state = await store.load();
  const approvals = state.approvals.includes(gate) ? state.approvals : [...state.approvals, gate];
  const next: RunState = {
    ...state,
    approvals,
    status: state.pendingGate === gate ? "running" : state.status,
    pendingGate: state.pendingGate === gate ? undefined : state.pendingGate,
  };
  await store.save(next);
  await store.log("gate.approved", { gate });
  return next;
}
