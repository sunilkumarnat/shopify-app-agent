import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppSpecSchema, type AppSpec } from "../state/spec.ts";
import type { RunState } from "../state/run-store.ts";
import type { Phase } from "./types.ts";

export const splitList = (text: string): string[] =>
  text
    .split(/\n|;/)
    .map((item) => item.replace(/^\s*[-*•\d.)]+\s*/, "").trim())
    .filter(Boolean);

// Unvalidated spec built from the answers; callers validate it with AppSpecSchema.
export function specInput(state: Pick<RunState, "answers">): Record<keyof AppSpec, unknown> {
  const { name = "", description = "", functionalities = "", flow = "" } = state.answers;
  return {
    name: name.trim(),
    description: description.trim(),
    functionalities: splitList(functionalities),
    flow: flow.trim(),
    surfaces: ["embedded-admin", "theme-extension"],
  };
}

// M0 renders a fixed outline from the answers. M1 replaces the body with the Product/UX
// agent's analysis (screens, data model, scopes, webhooks, extensions), keeping this file
// as the document the user reviews at the architecture gate.
export function renderArchitecture(spec: AppSpec, feedback: string[]): string {
  const lines = [
    `# ${spec.name}: architecture`,
    "",
    spec.description,
    "",
    "## Functionalities",
    ...spec.functionalities.map((f, i) => `${i + 1}. ${f}`),
    "",
    "## Basic flow",
    spec.flow,
    "",
    "## Surfaces",
    ...spec.surfaces.map((s) => `- ${s}`),
    "",
    "## To be detailed by the architecture agent",
    "- Admin screens (Polaris) with empty, loading and error states",
    "- Data model: app database tables, metafields and metaobjects",
    "- Admin GraphQL operations and the minimum access scopes",
    "- Webhooks, including compliance webhooks",
    "- Theme app extension blocks and embeds",
  ];
  if (feedback.length) lines.push("", "## Feedback from earlier reviews", ...feedback.map((f) => `- ${f}`));
  return lines.join("\n") + "\n";
}

export const architecture: Phase = {
  name: "architecture",
  async run({ appDir, state }) {
    const parsed = AppSpecSchema.safeParse(specInput(state));
    if (!parsed.success) return { kind: "failed", error: parsed.error.message };
    const feedback = state.feedback.filter((f) => f.gate === "architecture").map((f) => f.text);
    await writeFile(join(appDir, "spec.json"), JSON.stringify(parsed.data, null, 2) + "\n");
    await writeFile(join(appDir, "architecture.md"), renderArchitecture(parsed.data, feedback));
    return { kind: "done", summary: "architecture.md written for review" };
  },
};
