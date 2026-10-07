import { intake } from "./intake.ts";
import type { Phase } from "./types.ts";

const stub = (name: string, gatesBefore?: Phase["gatesBefore"]): Phase => ({
  name,
  gatesBefore,
  async run() {
    return { ok: true, summary: `${name}: not implemented yet (stub)` };
  },
});

// Phase order and human gates from docs/design.md, section 5.
export const PHASES: Phase[] = [
  intake,
  stub("design", ["spec"]),
  stub("scaffold", ["partner-link"]),
  stub("build"),
  stub("review"),
  stub("preview"),
  stub("release", ["preview", "deploy"]),
  stub("handoff"),
];
