import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Generated apps build their admin UI only with Polaris web components (<s-page>, <s-button>,
// …). This rule goes into every prompt that writes admin UI; checkPolarisOnly enforces it.
export const POLARIS_RULE = `Admin UI uses only Shopify Polaris web components (for example <s-page>, <s-section>, <s-stack>, <s-text>, <s-heading>, <s-button>, <s-text-field>, <s-number-field>, <s-select>, <s-checkbox>, <s-table>, <s-banner>, <s-badge>, <s-modal>, <s-spinner>, <s-empty-state>), loaded by the template through App Bridge. Never use Polaris React (@shopify/polaris), another UI kit or CSS framework, or raw HTML controls, tables, headings or lists in admin pages, and no custom styling of admin UI. The theme app extension (storefront) is not admin UI: it uses Liquid, HTML and CSS that match the merchant's theme.`;

// Packages that bring their own admin UI components or styling.
const FORBIDDEN_IMPORTS = [
  /^@shopify\/polaris$/,
  /^@shopify\/polaris\//,
  /^@mui\//,
  /^antd(\/|$)/,
  /^@chakra-ui\//,
  /^@mantine\//,
  /^react-bootstrap(\/|$)/,
  /^bootstrap(\/|$)/,
  /^@headlessui\//,
  /^@radix-ui\//,
  /^styled-components$/,
  /^@emotion\//,
  /^tailwindcss(\/|$)/,
];

// Raw HTML elements that have a Polaris web component counterpart.
const RAW_ELEMENTS = ["button", "input", "select", "textarea", "table", "dialog", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol"];
const RAW_ELEMENT = new RegExp(`<(${RAW_ELEMENTS.join("|")})(?=[\\s>/])`, "g");
const IMPORT_FROM = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const SOURCE = /\.(tsx|jsx|ts|js|css)$/;

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) yield* sourceFiles(path);
    else if (entry.isFile() && SOURCE.test(entry.name)) yield path;
  }
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

// The embedded admin: React Router's app.* routes (flat files or folders) and shared components.
// The template's public landing and login pages and extensions/ (the storefront) are not admin UI.
async function* adminFiles(appRoot: string): AsyncGenerator<string> {
  const routes = join(appRoot, "app", "routes");
  if (existsSync(routes)) {
    for (const entry of await readdir(routes, { withFileTypes: true })) {
      if (!/^app(\.|$)/.test(entry.name)) continue;
      const path = join(routes, entry.name);
      if (entry.isDirectory()) yield* sourceFiles(path);
      else if (SOURCE.test(entry.name)) yield path;
    }
  }
  const components = join(appRoot, "app", "components");
  if (existsSync(components)) yield* sourceFiles(components);
}

// Lists every forbidden UI import, stylesheet and raw HTML element in the admin code, with
// file and line.
export async function checkPolarisOnly(appRoot: string): Promise<{ passed: boolean; output: string }> {
  const problems: string[] = [];
  for await (const file of adminFiles(appRoot)) {
    const text = await readFile(file, "utf8");
    const where = (i: number) => `${relative(appRoot, file)}:${lineOf(text, i)}`;
    if (file.endsWith(".css")) {
      problems.push(`${relative(appRoot, file)}: custom stylesheet; style admin UI only through Polaris web components`);
      continue;
    }
    for (const m of text.matchAll(IMPORT_FROM)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? "";
      if (FORBIDDEN_IMPORTS.some((re) => re.test(spec))) problems.push(`${where(m.index)}: imports ${spec}; use Polaris web components`);
      if (spec.endsWith(".css")) problems.push(`${where(m.index)}: imports ${spec}; style admin UI only through Polaris web components`);
    }
    if (/\.(tsx|jsx)$/.test(file)) {
      for (const m of text.matchAll(RAW_ELEMENT)) problems.push(`${where(m.index)}: raw <${m[1]}>; use the Polaris web component instead`);
    }
  }
  return problems.length
    ? { passed: false, output: problems.join("\n") }
    : { passed: true, output: "admin UI uses only Polaris web components" };
}
