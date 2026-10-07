import type { GateName, Question, RunState } from "../state/run-store.ts";

export interface PhaseContext {
  appDir: string;
  state: Readonly<RunState>;
  log(event: string, data?: Record<string, unknown>): Promise<void>;
}

export type PhaseResult =
  | { kind: "done"; summary: string }
  | { kind: "needs-input"; question: Question }
  | { kind: "failed"; error: string };

export interface Phase {
  name: string;
  // Approvals that must exist before this phase may start.
  gatesBefore?: GateName[];
  // How many times the orchestrator runs a failing phase before stopping (default 3).
  maxAttempts?: number;
  run(ctx: PhaseContext): Promise<PhaseResult>;
}
