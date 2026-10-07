import type { GateName, RunState } from "../state/run-store.ts";

export interface PhaseContext {
  appDir: string;
  state: Readonly<RunState>;
  log(event: string, data?: Record<string, unknown>): Promise<void>;
}

export type PhaseResult = { ok: true; summary: string } | { ok: false; error: string };

export interface Phase {
  name: string;
  // Approvals that must exist before this phase may start.
  gatesBefore?: GateName[];
  run(ctx: PhaseContext): Promise<PhaseResult>;
}
