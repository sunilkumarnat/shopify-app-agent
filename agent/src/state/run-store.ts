import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// Points where the agent stops for the user's decision (docs/design.md, section 5).
export const GATES = ["architecture", "start-development", "deploy"] as const;
export const GateSchema = z.enum(GATES);
export type GateName = z.infer<typeof GateSchema>;

export const QuestionSchema = z.object({ id: z.string(), prompt: z.string() });
export type Question = z.infer<typeof QuestionSchema>;

export const RunStateSchema = z.object({
  appId: z.string(),
  phaseIndex: z.number().int().min(0),
  status: z.enum(["running", "awaiting-input", "awaiting-approval", "failed", "done"]),
  answers: z.record(z.string(), z.string()),
  approvals: z.array(GateSchema),
  pendingQuestion: QuestionSchema.optional(),
  pendingGate: GateSchema.optional(),
  feedback: z.array(z.object({ gate: GateSchema, text: z.string() })),
  lastError: z.string().optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

// Persists one app run under <appDir>/.agent so a run can stop for the user and resume later.
export class RunStore {
  readonly appDir: string;
  private readonly agentDir: string;

  constructor(appDir: string) {
    this.appDir = appDir;
    this.agentDir = join(appDir, ".agent");
  }

  async init(appId: string): Promise<RunState> {
    await mkdir(this.agentDir, { recursive: true });
    const state: RunState = {
      appId,
      phaseIndex: 0,
      status: "running",
      answers: {},
      approvals: [],
      feedback: [],
    };
    await this.save(state);
    return state;
  }

  async load(): Promise<RunState> {
    const raw = await readFile(join(this.agentDir, "state.json"), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new Error(`No app run found in ${this.appDir}. Start one with \`new\`.`);
      throw err;
    });
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
