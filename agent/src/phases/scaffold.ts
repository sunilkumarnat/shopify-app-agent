import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppSpecSchema } from "../state/spec.ts";
import { findAppRoot } from "../tools/app-root.ts";
import type { CommandRunner } from "../tools/exec.ts";
import { shopifyCli } from "../tools/shopify-cli.ts";
import type { Phase } from "./types.ts";

export interface ScaffoldDeps {
  runner: CommandRunner;
  // Creating the app needs the user to log in and pick an organization in the Shopify CLI.
  interactive: boolean;
}

const THEME_EXTENSION_NAME = "theme-extension";

// Follows https://shopify.dev/docs/apps/build/scaffold-app: `shopify app init` with the React
// Router template creates the app in the Dev Dashboard and installs dependencies; then the
// theme app extension is generated when the architecture calls for one.
export const createScaffoldPhase = ({ runner, interactive }: ScaffoldDeps): Phase => ({
  name: "scaffold",
  gatesBefore: ["start-development"],
  maxAttempts: 1,
  async run({ appDir, state, log }) {
    const spec = AppSpecSchema.parse(JSON.parse(await readFile(join(appDir, "spec.json"), "utf8")));
    const shopify = (args: string[], cwd: string, asUser = true) =>
      shopifyCli(args, { cwd, approvals: state.approvals, interactive: asUser, runner });

    const version = await shopify(["version"], appDir, false);
    if (version.code !== 0) {
      return { kind: "failed", error: "Shopify CLI is not installed. Install it with `npm install -g @shopify/cli`, then run `resume`." };
    }

    let appRoot = await findAppRoot(appDir);
    if (!appRoot) {
      if (!interactive) {
        return { kind: "failed", error: "Creating the app needs you to log in to Shopify. Run `resume` in a terminal." };
      }
      console.log("\nCreating the app with Shopify CLI. Log in, choose your organization, and confirm creating the app.\n");
      const init = await shopify(
        ["app", "init", "--template", "reactRouter", "--flavor", "typescript", "--name", spec.name, "--path", appDir, "--package-manager", "npm"],
        appDir,
      );
      await log("shopify.app-init", { code: init.code });
      appRoot = await findAppRoot(appDir);
      if (init.code !== 0 || !appRoot) return { kind: "failed", error: "`shopify app init` did not create the app" };
    }

    if (spec.surfaces.includes("theme-extension") && !(await hasThemeExtension(appRoot))) {
      if (!interactive) {
        return { kind: "failed", error: "Generating the theme extension needs Shopify login. Run `resume` in a terminal." };
      }
      const base = ["app", "generate", "extension", "--name", THEME_EXTENSION_NAME, "--path", appRoot];
      let generated = await shopify([...base, "--template", "theme_app_extension"], appRoot);
      // If the CLI doesn't recognise the template name, let the user pick "Theme app extension".
      if (generated.code !== 0) {
        console.log('\nChoose "Theme app extension" when the Shopify CLI asks for the extension type.\n');
        generated = await shopify(base, appRoot);
      }
      await log("shopify.generate-theme-extension", { code: generated.code });
      if (generated.code !== 0 || !(await hasThemeExtension(appRoot))) {
        return { kind: "failed", error: "`shopify app generate extension` did not create the theme extension" };
      }
    }

    return { kind: "done", summary: `app scaffolded in ${appRoot}` };
  },
});

async function hasThemeExtension(appRoot: string): Promise<boolean> {
  const extensionsDir = join(appRoot, "extensions");
  if (!existsSync(extensionsDir)) return false;
  const entries = await readdir(extensionsDir, { withFileTypes: true });
  return entries.some((e) => e.isDirectory() && existsSync(join(extensionsDir, e.name, "blocks")));
}
