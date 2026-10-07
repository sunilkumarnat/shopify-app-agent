// Reads Playwright's JSON report (`--reporter=json`) and groups the results by functionality.
// The tester tags every test title with the functionality it covers, e.g. "[F2] shows the badge".

interface PwAttachment {
  name?: string;
  contentType?: string;
  path?: string;
}

interface PwResult {
  status?: string;
  error?: { message?: string };
  attachments?: PwAttachment[];
}

interface PwSpec {
  title: string;
  ok?: boolean;
  tests?: { status?: string; results?: PwResult[] }[];
}

interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

export interface PwReport {
  suites?: PwSuite[];
  errors?: { message?: string }[];
}

export interface TestCase {
  title: string;
  passed: boolean;
  error?: string;
  screenshots: string[];
}

export interface FunctionalityResult {
  index: number;
  functionality: string;
  tests: TestCase[];
  // Covered by at least one test, and every one of its tests passed.
  passed: boolean;
}

const TAG = /\[F(\d+)\]/g;
// Playwright colours its error messages for the terminal.
const ANSI = /\u001b\[[0-9;]*m/g;

function* specsOf(suites: PwSuite[] = []): Generator<PwSpec> {
  for (const suite of suites) {
    yield* suite.specs ?? [];
    yield* specsOf(suite.suites);
  }
}

const toTestCase = (spec: PwSpec): TestCase => {
  const results = (spec.tests ?? []).flatMap((t) => t.results ?? []);
  // A skipped test proves nothing, so it never counts as a pass.
  const skipped = (spec.tests ?? []).some((t) => t.status === "skipped");
  const failure = results.find((r) => r.status !== "passed" && r.error?.message);
  return {
    title: spec.title,
    passed: spec.ok === true && !skipped && results.length > 0,
    error: skipped ? "skipped" : failure?.error?.message?.replace(ANSI, ""),
    screenshots: results.flatMap((r) =>
      (r.attachments ?? []).filter((a) => a.contentType === "image/png" && a.path).map((a) => a.path!),
    ),
  };
};

export function resultsByFunctionality(report: PwReport, functionalities: string[]): FunctionalityResult[] {
  const byIndex = new Map<number, TestCase[]>();
  for (const spec of specsOf(report.suites)) {
    const testCase = toTestCase(spec);
    for (const [, n] of spec.title.matchAll(TAG)) {
      const list = byIndex.get(Number(n)) ?? [];
      list.push(testCase);
      byIndex.set(Number(n), list);
    }
  }
  return functionalities.map((functionality, i) => {
    const tests = byIndex.get(i + 1) ?? [];
    return { index: i + 1, functionality, tests, passed: tests.length > 0 && tests.every((t) => t.passed) };
  });
}
