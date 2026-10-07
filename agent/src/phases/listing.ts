import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { outputSchemaOf, type ClaudeRunner } from "../claude.ts";
import type { Phase } from "./types.ts";

// Field limits follow the App Store listing form; the Partner listing editor enforces them too.
export const ListingSchema = z.object({
  appName: z.string().max(30),
  subtitle: z.string().max(62).describe("App card subtitle shown in search results"),
  introduction: z.string().max(100).describe("One line on the value to merchants"),
  details: z.string().max(500).describe("What the app does and how merchants use it"),
  features: z.array(z.string().max(80)).min(1).max(8),
  pricing: z.array(
    z.object({ plan: z.string(), price: z.string(), trial: z.string(), features: z.array(z.string()) }),
  ),
  categories: z.array(z.string()).max(2).describe("Suggested App Store categories"),
  searchTerms: z.array(z.string()).max(5),
  screenshots: z.array(
    z.object({
      caption: z.string(),
      shows: z.string().describe("What the screenshot should show"),
      from: z.string().describe("An existing file in screenshots/ to start from, or 'new'"),
    }),
  ),
  reviewInstructions: z.string().describe("Steps Shopify's reviewers follow to test every feature"),
  todo: z.array(z.string()).describe("What the user must still provide, e.g. support email, privacy policy URL"),
});
export type Listing = z.infer<typeof ListingSchema>;

const SYSTEM_PROMPT = `You write Shopify App Store listing drafts. Be accurate and specific: describe only what the app actually does, as built and tested. No superlatives, no claims you cannot back up from the files, no mention of other platforms, no prices that differ from the plans.

Read the architecture, the test report, the checklist and the app's code as needed. Suggest screenshots at 1600x900 that show the app's key screens and the storefront block, starting from the test screenshots where they fit. Write review instructions a Shopify reviewer can follow on a fresh dev store.`;

const hasTrial = (trial: string) => !/^\s*(none|no|n\/a|-)?\s*$/i.test(trial);

function listingMarkdown(l: Listing): string {
  return [
    `# App Store listing draft: ${l.appName}`,
    "",
    "Review and edit before pasting into the listing editor in the Shopify Dev Dashboard.",
    "",
    `**App name:** ${l.appName}`,
    "",
    `**App card subtitle:** ${l.subtitle}`,
    "",
    `**Introduction:** ${l.introduction}`,
    "",
    "**Details:**",
    "",
    l.details,
    "",
    "**Features:**",
    "",
    ...l.features.map((f) => `- ${f}`),
    "",
    "## Pricing",
    "",
    ...(l.pricing.length
      ? l.pricing.map((p) => `- **${p.plan}**: ${p.price}${hasTrial(p.trial) ? `, ${p.trial}` : ""}. ${p.features.join(", ")}`)
      : ["Free."]),
    "",
    "## Categories and search terms",
    "",
    `Categories: ${l.categories.join(", ")}`,
    "",
    `Search terms: ${l.searchTerms.join(", ")}`,
    "",
    "## Screenshots (1600x900)",
    "",
    ...l.screenshots.map((s, i) => `${i + 1}. **${s.caption}**: ${s.shows} (${s.from === "new" ? "take a new one" : `start from screenshots/${s.from}`})`),
    "",
    "## Instructions for Shopify's reviewers",
    "",
    l.reviewInstructions,
    "",
    "## Still needed from you",
    "",
    ...l.todo.map((t) => `- ${t}`),
    "",
  ].join("\n");
}

// Step 11 of the process: Claude drafts the App Store listing from what was built and tested.
// It only reads files, so it cannot change the app.
export const createListingPhase = (claude: ClaudeRunner): Phase => ({
  name: "listing-suggestions",
  async run({ appDir, log }) {
    const shotsDir = join(appDir, "screenshots");
    const shots = existsSync(shotsDir) ? await readdir(shotsDir) : [];
    const files = ["spec.json", "architecture.md", "test-report.md", "checklist.md", "deploy-plan.md"].filter((f) =>
      existsSync(join(appDir, f)),
    );
    const result = await claude({
      role: "copywriter",
      prompt: `Draft the App Store listing for this app. Read ${files.join(", ")} in the current folder, and the app's code if you need to. Test screenshots available: ${shots.join(", ") || "none"}.`,
      systemPrompt: SYSTEM_PROMPT,
      cwd: appDir,
      tools: ["Read", "Glob", "Grep"],
      outputSchema: outputSchemaOf(ListingSchema),
    });
    await log("claude.listing", { ok: result.ok, costUsd: result.costUsd });
    if (!result.ok) return { kind: "failed", error: `Claude could not draft the listing: ${result.error}` };
    const listing = ListingSchema.safeParse(result.structured);
    if (!listing.success) return { kind: "failed", error: `The listing draft broke a field limit: ${listing.error.issues[0]?.path.join(".")}` };

    await writeFile(join(appDir, "listing.md"), listingMarkdown(listing.data));
    return { kind: "done", summary: "App Store listing draft written to listing.md" };
  },
});
