import { runClaude, type ClaudeRunner } from "../claude.ts";
import { runCommand, type CommandRunner } from "../tools/exec.ts";
import { createArchitecturePhase } from "./architecture.ts";
import { createBuildPhase } from "./build.ts";
import { createChecklistPhase } from "./checklist.ts";
import { createDeployPhase, createDeployPlanPhase, type HttpStatus } from "./deploy.ts";
import { createListingPhase } from "./listing.ts";
import { askPhase, plansPhase, QUESTIONS } from "./questions.ts";
import { createScaffoldPhase } from "./scaffold.ts";
import { createTestPhase } from "./test.ts";
import type { Phase } from "./types.ts";

export interface PhaseDeps {
  claude: ClaudeRunner;
  runner: CommandRunner;
  interactive: boolean;
  // Health check used after deploying; tests replace it.
  status?: HttpStatus;
}

// The development process from docs/design.md, section 5, in order.
export const createPhases = ({ claude, runner, interactive, status }: PhaseDeps): Phase[] => [
  askPhase("app-details", [QUESTIONS.name, QUESTIONS.description]),
  askPhase("functionalities", [QUESTIONS.functionalities]),
  askPhase("flow", [QUESTIONS.flow]),
  plansPhase,
  createArchitecturePhase(claude),
  // Asked once the architecture is confirmed, just before the start-development confirmation.
  { ...askPhase("shopify-access", [QUESTIONS.developerAccount, QUESTIONS.devStore]), gatesBefore: ["architecture"] },
  createScaffoldPhase({ runner, interactive }),
  createBuildPhase({ claude, runner }),
  createChecklistPhase({ claude, runner }),
  createTestPhase({ claude, runner }),
  askPhase("hosting", [QUESTIONS.hosting]),
  createDeployPlanPhase(claude),
  createDeployPhase({ runner, interactive, status }),
  createListingPhase(claude),
];

export const createDefaultPhases = (interactive: boolean): Phase[] =>
  createPhases({ claude: runClaude, runner: runCommand, interactive });
