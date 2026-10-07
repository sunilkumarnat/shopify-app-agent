import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// `shopify app init --path <appDir>` creates the project in a subfolder named after the app.
// The project is the folder holding shopify.app.toml.
export async function findAppRoot(appDir: string): Promise<string | undefined> {
  if (existsSync(join(appDir, "shopify.app.toml"))) return appDir;
  const entries = await readdir(appDir, { withFileTypes: true });
  const match = entries.find(
    (e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(appDir, e.name, "shopify.app.toml")),
  );
  return match ? join(appDir, match.name) : undefined;
}
