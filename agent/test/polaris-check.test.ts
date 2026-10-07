import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPolarisOnly } from "../src/tools/polaris-check.ts";

async function app(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "polaris-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const GOOD = `import { useLoaderData } from "react-router";
export default function Index() {
  return (
    <s-page heading="Products">
      <s-section><s-button variant="primary">Save</s-button><s-table></s-table></s-section>
    </s-page>
  );
}`;

describe("the Polaris web components check", () => {
  it("passes admin routes built only from Polaris web components", async () => {
    const root = await app({
      "app/routes/app._index.tsx": GOOD,
      "app/routes/app.settings/route.tsx": GOOD,
      // Not admin UI: the template's public landing page and the storefront extension.
      "app/routes/_index/route.tsx": `import styles from "./styles.module.css";\nexport default () => <form><input /><button /></form>;`,
      "app/routes/_index/styles.module.css": ".index {}",
      "extensions/theme-extension/assets/badge.css": ".badge {}",
    });
    expect(await checkPolarisOnly(root)).toEqual({ passed: true, output: "admin UI uses only Polaris web components" });
  });

  it("lists Polaris React, other UI kits, stylesheets and raw HTML controls with file and line", async () => {
    const root = await app({
      "app/routes/app._index.tsx": `import { Page } from "@shopify/polaris";\nimport "./admin.css";\nexport default () => <Page><button>Go</button></Page>;`,
      "app/routes/app.settings.tsx": `import Button from "@mui/material/Button";\nexport default () => <div><h2>Settings</h2><table /></div>;`,
      "app/components/Picker.tsx": `export const Picker = () => <select><option /></select>;`,
      "app/components/theme.css": "body {}",
    });
    const result = await checkPolarisOnly(root);
    expect(result.passed).toBe(false);
    expect(result.output.split("\n").sort()).toEqual(
      [
        "app/routes/app._index.tsx:1: imports @shopify/polaris; use Polaris web components",
        "app/routes/app._index.tsx:2: imports ./admin.css; style admin UI only through Polaris web components",
        "app/routes/app._index.tsx:3: raw <button>; use the Polaris web component instead",
        "app/routes/app.settings.tsx:1: imports @mui/material/Button; use Polaris web components",
        "app/routes/app.settings.tsx:2: raw <h2>; use the Polaris web component instead",
        "app/routes/app.settings.tsx:2: raw <table>; use the Polaris web component instead",
        "app/components/Picker.tsx:1: raw <select>; use the Polaris web component instead",
        "app/components/theme.css: custom stylesheet; style admin UI only through Polaris web components",
      ].sort(),
    );
  });

  it("allows the Polaris web component types package", async () => {
    const root = await app({ "app/routes/app.tsx": `import type {} from "@shopify/polaris-types";\nexport default () => <s-app-nav />;` });
    expect((await checkPolarisOnly(root)).passed).toBe(true);
  });
});
