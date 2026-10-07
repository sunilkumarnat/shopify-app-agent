import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const GATES = ["spec", "partner-link", "preview", "deploy"] as const;
export const GateSchema = z.enum(GATES);
export type GateName = z.infer<typeof GateSchema>;

export const RunStateSchema = z.object({
  appName: z.string(),
  phaseIndex: z.number().int().min(0),
  status: z.enum(["running", "awaiting-approval", "failed", "done"]),
  approvals: z.array(GateSchema),
  pendingGate: GateSchema.optional(),
  lastError: z.string().optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

// Persists one app run under <appDir>/.agent so a run can stop at a gate and resume later.
export class RunStore {
  readonly appDir: string;
  private readonly agentDir: string;

  constructor(appDir: string) {
    this.appDir = appDir;
    this.agentDir = join(appDir, ".agent");
  }

  async init(appName: string): Promise<RunState> {
    await mkdir(this.agentDir, { recursive: true });
    const state: RunState = { appName, phaseIndex: 0, status: "running", approvals: [] };
    await this.save(state);
    return state;
  }

  async load(): Promise<RunState> {
    const raw = await readFile(join(this.agentDir, "state.json"), "utf8");
    return RunStateSchema.parse(JSON.parse(raw));
  }

  async save(state: RunState): Promise<void> {
    await writeFile(join(this.agentDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  }

  async log(event: string, data: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
    await appendFile(join(this.agentDir, "run-log.jsonl"), line + "\n");
  }
}
