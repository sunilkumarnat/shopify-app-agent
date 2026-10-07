import { z } from "zod";
import { outputSchemaOf, type ClaudeRunner } from "../claude.ts";
import { ARCHITECTURE_SECTIONS } from "../phases/architecture.ts";
import type { AppSpec } from "../state/spec.ts";
import type { EvalApp } from "./eval-app.ts";

export interface CheckScore {
  name: string;
  passed: boolean;
  detail?: string;
}

const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"];

// write_x grants read_x, so a required read scope is also met by its write scope.
const grants = (scopes: string[], scope: string) =>
  scopes.includes(scope) || (scope.startsWith("read_") && scopes.includes(`write_${scope.slice(5)}`));

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// Section headings in order: each must appear as a Markdown heading after the previous one.
function sectionsInOrder(markdown: string): CheckScore {
  const headings = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
  let from = 0;
  for (const section of ARCHITECTURE_SECTIONS) {
    const at = headings.findIndex((h, i) => i >= from && h.startsWith(section.toLowerCase().replace(/\s*\(.*\)$/, "")));
    if (at < 0) return { name: "architecture has every section in order", passed: false, detail: `missing or out of order: ${section}` };
    from = at + 1;
  }
  return { name: "architecture has every section in order", passed: true };
}

// The plan names the user gave, e.g. "Pro" from "Pro: $9/month, ...".
const planNames = (answers: Record<string, string>) =>
  /^\s*y/i.test(answers.hasPlans ?? "")
    ? (answers.plans ?? "").split(";").map((p) => p.split(":")[0]!.trim()).filter(Boolean)
    : [];

// Checks that need no model: structure, surfaces, scopes, webhooks and named patterns.
export function scoreArchitecture(app: EvalApp, spec: AppSpec, architecture: string): CheckScore[] {
  const { surfaces, scopes, mentions } = app.expect;
  const lower = architecture.toLowerCase();
  const missingScopes = scopes.required.filter((s) => !grants(spec.scopes, s));
  const forbidden = scopes.forbidden.filter((s) => spec.scopes.includes(s));
  const missingTopics = COMPLIANCE_TOPICS.filter((t) => !lower.includes(t));
  const missingPlans = planNames(app.answers).filter((p) => !lower.includes(p.toLowerCase()));
  return [
    sectionsInOrder(architecture),
    {
      name: `surfaces are ${surfaces.join(" + ")}`,
      passed: sameSet(spec.surfaces, surfaces),
      detail: `got ${spec.surfaces.join(" + ")}`,
    },
    { name: "requests every required scope", passed: missingScopes.length === 0, detail: `missing ${missingScopes.join(", ")}` },
    { name: "requests no forbidden scope", passed: forbidden.length === 0, detail: `requested ${forbidden.join(", ")}` },
    { name: "includes the compliance webhooks", passed: missingTopics.length === 0, detail: `missing ${missingTopics.join(", ")}` },
    { name: "covers every plan the user named", passed: missingPlans.length === 0, detail: `missing ${missingPlans.join(", ")}` },
    {
      name: "designs admin screens with Polaris web components only",
      passed: /<s-[a-z]/.test(architecture) && !/@shopify\/polaris(?![-\w])/.test(architecture),
      detail: /<s-[a-z]/.test(architecture) ? "mentions Polaris React (@shopify/polaris)" : "names no Polaris web components (<s-…>)",
    },
    ...mentions.map((m) => ({
      name: `mentions ${m.label}`,
      passed: new RegExp(m.pattern, "i").test(architecture),
      detail: `no match for /${m.pattern}/i`,
    })),
  ].map((c) => (c.passed ? { name: c.name, passed: true } : c));
}

// Checks on the built app's shopify.app.toml (build mode).
export function scoreAppConfig(app: EvalApp, toml: string): CheckScore[] {
  const scopes = /^\s*scopes\s*=\s*"([^"]*)"/m.exec(toml)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const missing = app.expect.scopes.required.filter((s) => !grants(scopes, s));
  const forbidden = app.expect.scopes.forbidden.filter((s) => scopes.includes(s));
  const missingTopics = COMPLIANCE_TOPICS.filter((t) => !toml.includes(t));
  return [
    { name: "shopify.app.toml has the required scopes", passed: missing.length === 0, detail: `missing ${missing.join(", ")}` },
    { name: "shopify.app.toml has no forbidden scope", passed: forbidden.length === 0, detail: `has ${forbidden.join(", ")}` },
    { name: "shopify.app.toml subscribes to the compliance webhooks", passed: missingTopics.length === 0, detail: `missing ${missingTopics.join(", ")}` },
  ].map((c) => (c.passed ? { name: c.name, passed: true } : c));
}

const GradeSchema = z.object({
  results: z.array(z.object({ index: z.number().int(), met: z.boolean(), reason: z.string() })),
});

const GRADER_PROMPT = `You grade a Shopify app architecture against acceptance criteria. Be strict: a criterion is met only if the architecture clearly and specifically satisfies it, not if it is merely compatible with it. Give one short reason per criterion, quoting the architecture where you can.`;

// Asks a grader model whether the architecture meets each acceptance criterion.
export async function gradeCriteria(
  claude: ClaudeRunner,
  criteria: string[],
  architecture: string,
  cwd: string,
): Promise<{ scores: CheckScore[]; costUsd: number }> {
  if (criteria.length === 0) return { scores: [], costUsd: 0 };
  const result = await claude({
    role: "grader",
    prompt: `Criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nArchitecture:\n\n${architecture}`,
    systemPrompt: GRADER_PROMPT,
    cwd,
    tools: [],
    outputSchema: outputSchemaOf(GradeSchema),
    maxTurns: 3,
  });
  const grade = result.ok ? GradeSchema.safeParse(result.structured) : undefined;
  const scores = criteria.map((criterion, i): CheckScore => {
    if (!grade?.success) return { name: criterion, passed: false, detail: "the grader did not return a result" };
    const r = grade.data.results.find((x) => x.index === i + 1);
    return r?.met ? { name: criterion, passed: true } : { name: criterion, passed: false, detail: r?.reason ?? "not graded" };
  });
  return { scores, costUsd: result.costUsd };
}
