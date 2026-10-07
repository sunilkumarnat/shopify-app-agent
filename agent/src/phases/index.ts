import { runClaude, type ClaudeRunner } from "../claude.ts";
import { runCommand, type CommandRunner } from "../tools/exec.ts";
import { createArchitecturePhase } from "./architecture.ts";
import { createBuildPhase } from "./build.ts";
import { askPhase, plansPhase, QUESTIONS } from "./questions.ts";
import { createScaffoldPhase } from "./scaffold.ts";
import { createTestPhase } from "./test.ts";
import type { Phase } from "./types.ts";

export interface PhaseDeps {
  claude: ClaudeRunner;
  runner: CommandRunner;
  interactive: boolean;
}

const stub = (name: string, gatesBefore?: Phase["gatesBefore"]): Phase => ({
  name,
  gatesBefore,
  async run() {
    return { kind: "done", summary: `${name}: not implemented yet (stub)` };
  },
});

// The development process from docs/design.md, section 5, in order.
export const createPhases = ({ claude, runner, interactive }: PhaseDeps): Phase[] => [
  askPhase("app-details", [QUESTIONS.name, QUESTIONS.description]),
  askPhase("functionalities", [QUESTIONS.functionalities]),
  askPhase("flow", [QUESTIONS.flow]),
  plansPhase,
  createArchitecturePhase(claude),
  // Asked once the architecture is confirmed, just before the start-development confirmation.
  { ...askPhase("shopify-access", [QUESTIONS.developerAccount, QUESTIONS.devStore]), gatesBefore: ["architecture"] },
  createScaffoldPhase({ runner, interactive }),
  createBuildPhase({ claude, runner }),
  stub("shopify-checklist"),
  createTestPhase({ claude, runner }),
  askPhase("hosting", [QUESTIONS.hosting]),
  stub("deploy", ["deploy"]),
  stub("listing-suggestions"),
];

export const createDefaultPhases = (interactive: boolean): Phase[] =>
  createPhases({ claude: runClaude, runner: runCommand, interactive });
