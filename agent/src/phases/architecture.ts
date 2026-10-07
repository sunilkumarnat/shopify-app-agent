import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { outputSchemaOf, type ClaudeRunner } from "../claude.ts";
import type { RunState } from "../state/run-store.ts";
import { AppSpecSchema, SurfaceSchema, type AppSpec } from "../state/spec.ts";
import type { Phase } from "./types.ts";

export const splitList = (text: string): string[] =>
  text
    .split(/\n|;/)
    .map((item) => item.replace(/^\s*[-*•\d.)]+\s*/, "").trim())
    .filter(Boolean);

// Unvalidated spec built from the answers; callers validate it with AppSpecSchema.
export function specInput(state: Pick<RunState, "answers">): Record<keyof AppSpec, unknown> {
  const { name = "", description = "", functionalities = "", flow = "", hasPlans = "", plans = "" } = state.answers;
  return {
    name: name.trim(),
    description: description.trim(),
    functionalities: splitList(functionalities),
    flow: flow.trim(),
    plans: /^\s*y/i.test(hasPlans) ? splitList(plans) : [],
    surfaces: ["embedded-admin", "theme-extension"],
    scopes: [],
  };
}

export const ArchitectureOutputSchema = z.object({
  summary: z.string().describe("Two or three sentences on what will be built"),
  surfaces: z.array(SurfaceSchema).min(1).describe("Which Shopify surfaces the app needs"),
  scopes: z.array(z.string()).describe("Minimum Admin API access scopes, e.g. read_products"),
  architectureMarkdown: z.string().min(1).describe("The full architecture document in Markdown"),
});
export type ArchitectureOutput = z.infer<typeof ArchitectureOutputSchema>;

const ARCHITECTURE_JSON_SCHEMA = outputSchemaOf(ArchitectureOutputSchema);

const SYSTEM_PROMPT = `You are a senior Shopify app architect. You turn a merchant-facing app idea into an architecture a developer can build from without further questions.

The app will be built with Shopify CLI's React Router app template (TypeScript), embedded in the Shopify admin with App Bridge, using Polaris web components for the admin UI, Admin GraphQL only (never REST), Prisma for the app's own data, and theme app extensions (app blocks and app embeds) for anything shoppers see.

Rules:
- Map every functionality the user listed to at least one admin screen, theme extension block, webhook or background job. Say which.
- Request the minimum access scopes. Prefer app-owned metafields and metaobjects for data that belongs on the shop.
- Include the mandatory compliance webhooks (customers/data_request, customers/redact, shop/redact) and every other webhook the flow needs, declared in shopify.app.toml.
- For paid plans, use Shopify's managed App Pricing when the plans fit it, and say how each plan's features are enforced in the app (which screens or limits check the active plan). For a free app, say so and skip billing.
- Design loading, empty and error states for every admin screen.
- Do not invent requirements the user didn't give. List anything ambiguous under "Open questions" instead.

The architectureMarkdown must have these sections, in order: Overview; Functionalities (each mapped to where it is built); Plans and billing; Admin screens; Storefront (theme app extension); Data model; Admin GraphQL operations; Webhooks; Access scopes; Open questions.`;

export function architecturePrompt(spec: AppSpec, feedback: string[], previous?: string): string {
  const parts = [
    "Design the architecture for this Shopify app. The user's answers:",
    "```json",
    JSON.stringify(
      { name: spec.name, description: spec.description, functionalities: spec.functionalities, flow: spec.flow, plans: spec.plans },
      null,
      2,
    ),
    "```",
  ];
  if (previous && feedback.length) {
    parts.push(
      "",
      "The user reviewed your previous architecture and asked for changes. Revise it so every request below is handled, keeping everything else that still applies.",
      "Requested changes, oldest first:",
      ...feedback.map((f) => `- ${f}`),
      "",
      "Previous architecture:",
      previous,
    );
  }
  return parts.join("\n");
}

export const createArchitecturePhase = (claude: ClaudeRunner): Phase => ({
  name: "architecture",
  async run({ appDir, state, log }) {
    const parsed = AppSpecSchema.safeParse(specInput(state));
    if (!parsed.success) return { kind: "failed", error: parsed.error.message };

    const feedback = state.feedback.filter((f) => f.gate === "architecture").map((f) => f.text);
    const architecturePath = join(appDir, "architecture.md");
    const previous = existsSync(architecturePath) ? await readFile(architecturePath, "utf8") : undefined;

    const result = await claude({
      role: "architect",
      prompt: architecturePrompt(parsed.data, feedback, previous),
      systemPrompt: SYSTEM_PROMPT,
      cwd: appDir,
      tools: [],
      outputSchema: ARCHITECTURE_JSON_SCHEMA,
      maxTurns: 4,
    });
    await log("claude.architecture", { ok: result.ok, costUsd: result.costUsd });
    if (!result.ok) return { kind: "failed", error: `Claude could not write the architecture: ${result.error}` };

    const output = ArchitectureOutputSchema.safeParse(result.structured);
    if (!output.success) return { kind: "failed", error: `Claude returned an unexpected architecture: ${output.error.message}` };

    const spec: AppSpec = { ...parsed.data, surfaces: output.data.surfaces, scopes: output.data.scopes };
    await writeFile(join(appDir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
    await writeFile(architecturePath, output.data.architectureMarkdown.trimEnd() + "\n");
    return { kind: "done", summary: output.data.summary };
  },
});
