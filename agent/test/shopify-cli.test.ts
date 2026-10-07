import { describe, expect, it } from "vitest";
import { checkShopifyArgs, shopifyCli } from "../src/tools/shopify-cli.ts";

describe("checkShopifyArgs", () => {
  it("allows build and scaffold commands", () => {
    expect(() => checkShopifyArgs(["app", "build"], [])).not.toThrow();
    expect(() => checkShopifyArgs(["app", "generate", "extension", "--template", "theme_app_extension"], [])).not.toThrow();
  });

  it("requires the deploy approval for deploy and release", () => {
    expect(() => checkShopifyArgs(["app", "deploy"], [])).toThrow(/deploy/);
    expect(() => checkShopifyArgs(["app", "release", "--version", "v1"], ["architecture"])).toThrow(/deploy/);
    expect(() => checkShopifyArgs(["app", "deploy"], ["deploy"])).not.toThrow();
  });

  it("rejects anything not on the allowlist", () => {
    expect(() => checkShopifyArgs(["theme", "push"], ["deploy"])).toThrow(/allowlist/);
    expect(() => checkShopifyArgs([], [])).toThrow(/allowlist/);
  });
});

describe("shopifyCli", () => {
  it("never invokes the runner for a blocked command", async () => {
    let invoked = false;
    const runner = async () => ((invoked = true), { code: 0, stdout: "", stderr: "" });
    await expect(shopifyCli(["app", "deploy"], { cwd: ".", approvals: [], runner })).rejects.toThrow();
    expect(invoked).toBe(false);
  });
});
