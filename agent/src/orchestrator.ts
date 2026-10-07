import type { Phase } from "./phases/types.ts";
import type { GateName, RunState, RunStore } from "./state/run-store.ts";

export const MAX_ATTEMPTS = 3;

// Runs phases in order from the saved position. Stops when a phase asks the user something,
// when a phase needs an approval it doesn't have, when a phase keeps failing, or when every
// phase is done.
export async function advance(store: RunStore, phases: Phase[]): Promise<RunState> {
  let state = await store.load();
  if (state.status === "awaiting-input" || state.status === "awaiting-approval") return state;
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

    const outcome = await runWithRetries(store, phase, state);
    if (outcome.kind === "needs-input") {
      state = { ...state, status: "awaiting-input", pendingQuestion: outcome.question };
      await store.save(state);
      await store.log("question.asked", { phase: phase.name, question: outcome.question.id });
      return state;
    }
    if (outcome.kind === "failed") {
      state = { ...state, status: "failed", lastError: `${phase.name}: ${outcome.error}` };
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

async function runWithRetries(store: RunStore, phase: Phase, state: RunState) {
  for (let attempt = 1; ; attempt++) {
    await store.log("phase.start", { phase: phase.name, attempt });
    const result = await phase.run({ appDir: store.appDir, state, log: (e, d) => store.log(e, d) });
    if (result.kind === "done") await store.log("phase.done", { phase: phase.name, summary: result.summary });
    if (result.kind !== "failed") return result;
    await store.log("phase.failed", { phase: phase.name, attempt, error: result.error });
    if (attempt >= (phase.maxAttempts ?? MAX_ATTEMPTS)) return result;
  }
}

export async function answer(store: RunStore, text: string): Promise<RunState> {
  const state = await store.load();
  const question = state.pendingQuestion;
  if (state.status !== "awaiting-input" || !question) throw new Error("No question is waiting for an answer");
  if (!text.trim()) throw new Error("The answer is empty");
  const next: RunState = {
    ...state,
    answers: { ...state.answers, [question.id]: text.trim() },
    status: "running",
    pendingQuestion: undefined,
  };
  await store.save(next);
  await store.log("question.answered", { question: question.id });
  return next;
}

export async function approve(store: RunStore, gate: GateName): Promise<RunState> {
  const state = await store.load();
  const approvals = state.approvals.includes(gate) ? state.approvals : [...state.approvals, gate];
  const isPending = state.pendingGate === gate;
  const next: RunState = {
    ...state,
    approvals,
    status: isPending ? "running" : state.status,
    pendingGate: isPending ? undefined : state.pendingGate,
  };
  await store.save(next);
  await store.log("gate.approved", { gate });
  return next;
}

// The user asked for changes to the architecture: record why and regenerate it.
export async function requestChanges(store: RunStore, phases: Phase[], feedback: string): Promise<RunState> {
  const state = await store.load();
  if (state.pendingGate !== "architecture") throw new Error("Changes can only be requested while the architecture is under review");
  const architectureIndex = phases.findIndex((p) => p.name === "architecture");
  if (architectureIndex < 0) throw new Error("No architecture phase to rerun");
  const next: RunState = {
    ...state,
    phaseIndex: architectureIndex,
    status: "running",
    pendingGate: undefined,
    feedback: [...state.feedback, { gate: "architecture", text: feedback.trim() }],
  };
  await store.save(next);
  await store.log("gate.changes-requested", { gate: "architecture" });
  return next;
}
