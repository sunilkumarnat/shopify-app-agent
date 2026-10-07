import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { outputSchemaOf, type ClaudeRunner } from "../claude.ts";
import { findAppRoot } from "../tools/app-root.ts";
import { runChecks } from "../tools/checks.ts";
import { runCommand, type CommandRunner } from "../tools/exec.ts";
import { shopifyCli } from "../tools/shopify-cli.ts";
import { BUILDER_ALLOWED, BUILDER_DENIED, BUILDER_TOOLS, FIX_ROUNDS } from "./build.ts";
import { POLARIS_RULE } from "../tools/polaris-check.ts";
import type { Phase } from "./types.ts";

// Shopify's own list of App Store requirements that can be checked against a local codebase.
// Shopify asks that it is always fetched fresh with `shopify doc fetch`, never from memory.
export const REQUIREMENTS_URL =
  "https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements";

export const ChecklistOutputSchema = z.object({
  requirements: z.array(
    z.object({
      id: z.string().describe("The requirement's number, e.g. 1.1.2"),
      name: z.string(),
      status: z.enum(["passing", "failing", "needs-review"]),
      fixed: z.boolean().describe("True if you changed the code in this session to make it pass"),
      note: z.string().describe("One or two sentences: what you found, with file paths"),
    }),
  ),
  skippedGroups: z.array(z.object({ group: z.string(), reason: z.string() })),
});
export type ChecklistOutput = z.infer<typeof ChecklistOutputSchema>;

const SYSTEM_PROMPT = `You review a Shopify app against Shopify's App Store requirements before it is submitted, and fix what fails.

For each requirement in the requirements file:
- Evaluate a group's applicability note first. "Applies if…": skip the group when the signal is absent. "Opt-in:": skip it. "Note:": use it as context.
- Search the codebase for the code, configuration and API calls the verification guidance describes.
- Status "passing" needs positive evidence. "failing" means the code clearly violates it. "needs-review" means you cannot confirm or deny it from the code alone. When in doubt, use "needs-review", never "passing".
- Fix every "failing" requirement that can be fixed in code, then evaluate it again. Keep the app's behavior and the architecture intact.

Rules:
- Make \`npm run typecheck\`, \`npm run lint\`, \`npm test\` and \`shopify app build\` keep passing.
- When you change admin UI: ${POLARIS_RULE}
- Never read, print or edit .env files or secrets. Never deploy, release or push.
- Keep each note short and specific.`;

const ICON = { passing: "✅", failing: "❌", "needs-review": "⚠️" } as const;

function checklistReport(output: ChecklistOutput, checksPassed: boolean): string {
  const count = (status: keyof typeof ICON) => output.requirements.filter((r) => r.status === status).length;
  const section = (status: "failing" | "needs-review", heading: string) => {
    const items = output.requirements.filter((r) => r.status === status);
    return items.length === 0
      ? []
      : [`## ${heading}`, "", ...items.flatMap((r) => [`${ICON[status]} **${r.id} ${r.name}**`, "", r.note, ""])];
  };
  const fixed = output.requirements.filter((r) => r.fixed);
  return [
    "# Shopify App Store checklist",
    "",
    `✅ Likely passing: ${count("passing")}`,
    `❌ Likely failing: ${count("failing")}`,
    `⚠️ Needs review: ${count("needs-review")}`,
    `⏭️ Groups skipped: ${output.skippedGroups.length}`,
    `Build checks: ${checksPassed ? "passing" : "failing"}`,
    "",
    "This covers the requirements Shopify lists as checkable from the codebase. Shopify reviews these and more when the app is submitted.",
    "",
    ...section("failing", "Likely failing"),
    ...section("needs-review", "Needs your review"),
    ...(fixed.length ? ["## Fixed by the agent", "", ...fixed.map((r) => `- ${r.id} ${r.name}: ${r.note}`), ""] : []),
    ...(output.skippedGroups.length
      ? ["## Skipped groups", "", ...output.skippedGroups.map((g) => `- **${g.group}**: ${g.reason}`), ""]
      : []),
    "## Resources",
    "",
    "- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)",
    "- [Best practices for apps](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices)",
    "- [About billing for your app](https://shopify.dev/docs/apps/launch/billing)",
    "- [Submitting your app for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)",
    "",
  ].join("\n");
}

export interface ChecklistDeps {
  claude: ClaudeRunner;
  runner?: CommandRunner;
}

// Step 8 of the process: fetch Shopify's requirements, have Claude evaluate and fix them, and
// stop if any requirement still fails. "Needs review" items are listed for the user.
export const createChecklistPhase = ({ claude, runner = runCommand }: ChecklistDeps): Phase => ({
  name: "shopify-checklist",
  maxAttempts: 1,
  async run({ appDir, state, log }) {
    const appRoot = await findAppRoot(appDir);
    if (!appRoot) return { kind: "failed", error: "No scaffolded app found; the scaffold step must run first" };

    const requirementsFile = join(appDir, ".agent", "app-store-requirements.md");
    const fetched = await shopifyCli(["doc", "fetch", "--url", REQUIREMENTS_URL, "--output", requirementsFile], {
      cwd: appRoot,
      approvals: state.approvals,
      runner,
    });
    await log("shopify.doc-fetch", { code: fetched.code });
    if (fetched.code !== 0) {
      return {
        kind: "failed",
        error: "Could not fetch Shopify's App Store requirements. Update Shopify CLI with `npm install -g @shopify/cli@latest`, then run `resume`.",
      };
    }

    const review = (prompt: string, resumeSessionId?: string) =>
      claude({
        role: "reviewer",
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        cwd: appRoot,
        tools: BUILDER_TOOLS,
        allowedTools: BUILDER_ALLOWED,
        disallowedTools: BUILDER_DENIED,
        outputSchema: outputSchemaOf(ChecklistOutputSchema),
        resumeSessionId,
      });

    let session = await review(
      `Review this app against every requirement in ${requirementsFile}. The app's architecture is in ${join(appDir, "architecture.md")}.`,
    );
    for (let round = 0; ; round++) {
      await log("claude.checklist", { round, ok: session.ok, costUsd: session.costUsd });
      if (!session.ok) return { kind: "failed", error: `Claude could not review the app: ${session.error}` };
      const parsed = ChecklistOutputSchema.safeParse(session.structured);
      if (!parsed.success) return { kind: "failed", error: "Claude's checklist did not match the expected format" };

      const checks = await runChecks(appRoot, undefined, runner);
      await writeFile(join(appDir, "checklist.md"), checklistReport(parsed.data, checks.passed));
      const failing = parsed.data.requirements.filter((r) => r.status === "failing");
      const toReview = parsed.data.requirements.filter((r) => r.status === "needs-review").length;
      if (failing.length === 0 && checks.passed) {
        return { kind: "done", summary: `no failing requirements; ${toReview} need your review in checklist.md` };
      }
      if (round >= FIX_ROUNDS) {
        const what = failing.length ? failing.map((r) => r.id).join(", ") : "build checks";
        return { kind: "failed", error: `${what} still failing after ${FIX_ROUNDS} fix rounds; see checklist.md` };
      }

      const failedChecks = checks.results
        .filter((r) => !r.passed)
        .map((r) => `### ${r.name}\n\`\`\`\n${r.output}\n\`\`\``)
        .join("\n\n");
      const failedRequirements = failing.map((r) => `- ${r.id} ${r.name}: ${r.note}`).join("\n");
      session = await review(
        `These still fail. Fix them, then evaluate every requirement again.\n\n${failedRequirements}\n\n${failedChecks}`.trim(),
        session.sessionId,
      );
    }
  },
});
