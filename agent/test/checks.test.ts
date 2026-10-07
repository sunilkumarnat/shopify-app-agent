import { describe, expect, it } from "vitest";
import { runChecks } from "../src/tools/checks.ts";

describe("runChecks", () => {
  it("reports each check and fails overall if any check fails", async () => {
    const runner = async (cmd: string) =>
      cmd === "bad" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "fine", stderr: "" };

    const { passed, results } = await runChecks(".", [
      { name: "a", cmd: "good", args: [] },
      { name: "b", cmd: "bad", args: [] },
    ], runner);

    expect(passed).toBe(false);
    expect(results).toEqual([
      { name: "a", passed: true, output: "fine" },
      { name: "b", passed: false, output: "boom" },
    ]);
  });
});
