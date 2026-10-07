import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SurfaceSchema } from "../state/spec.ts";

// One sample app the agent is scored on: the answers a user would give, and what a good
// architecture (and, in build mode, a good app) must contain.
export const EvalAppSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  answers: z.record(z.string(), z.string()),
  expect: z.object({
    surfaces: z.array(SurfaceSchema).min(1),
    scopes: z.object({ required: z.array(z.string()), forbidden: z.array(z.string()).default([]) }),
    // Case-insensitive patterns architecture.md must match, e.g. a webhook topic.
    mentions: z.array(z.object({ label: z.string(), pattern: z.string() })).default([]),
    // Acceptance checks that need judgement; a grader model scores each one.
    criteria: z.array(z.string()).default([]),
  }),
  minScore: z.number().min(0).max(1).default(0.8),
});
export type EvalApp = z.infer<typeof EvalAppSchema>;

export async function loadEvalApps(appsDir: string, only?: string[]): Promise<EvalApp[]> {
  const ids = (await readdir(appsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const apps: EvalApp[] = [];
  for (const id of ids) {
    if (only?.length && !only.includes(id)) continue;
    const file = join(appsDir, id, "eval.json");
    if (!existsSync(file)) continue;
    const app = EvalAppSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (app.id !== id) throw new Error(`${file}: id "${app.id}" must match its folder name`);
    apps.push(app);
  }
  return apps;
}
