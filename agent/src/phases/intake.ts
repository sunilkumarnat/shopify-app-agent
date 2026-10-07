import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppSpecSchema } from "../state/spec.ts";
import type { Phase } from "./types.ts";

// M0: validates the seed spec written by `new`. M1 adds the Product/UX agent that fills in
// stories, screens, scopes and out-of-scope items before the spec gate.
export const intake: Phase = {
  name: "intake",
  async run({ appDir }) {
    const path = join(appDir, "spec.json");
    const parsed = AppSpecSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    await writeFile(path, JSON.stringify(parsed.data, null, 2) + "\n");
    return { ok: true, summary: `spec for ${parsed.data.name} is valid` };
  },
};
