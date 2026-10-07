import { architecture } from "./architecture.ts";
import { askPhase, QUESTIONS } from "./questions.ts";
import type { Phase } from "./types.ts";

const stub = (name: string, gatesBefore?: Phase["gatesBefore"]): Phase => ({
  name,
  gatesBefore,
  async run() {
    return { kind: "done", summary: `${name}: not implemented yet (stub)` };
  },
});

// The development process from docs/design.md, section 5, in order.
export const PHASES: Phase[] = [
  askPhase("app-details", [QUESTIONS.name, QUESTIONS.description]),
  askPhase("functionalities", [QUESTIONS.functionalities]),
  askPhase("flow", [QUESTIONS.flow]),
  architecture,
  // Asked once the architecture is confirmed, just before the start-development confirmation.
  { ...askPhase("shopify-access", [QUESTIONS.partnerAccount, QUESTIONS.devStore]), gatesBefore: ["architecture"] },
  stub("scaffold", ["start-development"]),
  stub("build"),
  stub("shopify-checklist"),
  stub("test"),
  askPhase("hosting", [QUESTIONS.hosting]),
  stub("deploy", ["deploy"]),
  stub("listing-suggestions"),
];
