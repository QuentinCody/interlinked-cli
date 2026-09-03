import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkMockingTheSutSelf,
	checkTestMissingSutImport,
	hasAnyProjectSourceImport,
} from "./test-hygiene-quality-sut.js";

const TEST = "src/lib/foo.test.ts";
const SRC = "src/lib/foo.ts";

describe("checkTestMissingSutImport", () => {
	it("flags a test file that imports no SUT and no other project source", () => {
		const code = `import { describe, it, expect } from "vitest";\nit("does a thing", () => { expect(1).toBe(1); });\n`;
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("does not import its SUT");
	});

	it("does not fire when the file imports its own SUT", () => {
		const code = `import { foo } from "./foo.js";\nit("works", () => { expect(foo()).toBe(1); });\n`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire on the index.test.ts / non-strict-test carve-outs", () => {
		expect(checkTestMissingSutImport(`it("x", () => {});`, SRC)).toEqual([]);
	});

	it("is exempt when the file spawns the SUT as a subprocess", () => {
		const code = `import { execSync } from "node:child_process";\nit("runs the script", () => { execSync("node foo.mjs"); });\n`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("is exempt for a regression-suite-named file with no companion module", () => {
		const code = `it("regressed once", () => { expect(1).toBe(1); });\n`;
		expect(checkTestMissingSutImport(code, "src/lib/bugs.test.ts")).toEqual([]);
	});

	it("is exempt for a multi-module suite importing 3+ cross-directory sources", () => {
		const code = `
import { a } from "../a.js";
import { b } from "../b.js";
import { c } from "../c.js";
it("covers three modules", () => { expect(1).toBe(1); });
`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});
});

// --- 2026-09 SUT resolution: 83 firings in this tree, 0 real orphans. ---
// The detector keyed on the FILENAME STEM; these cases pin what it now
// resolves instead (actual imports, out-of-process product runs, artifact
// pins) AND that the orphan it exists to catch still fires.

describe("checkTestMissingSutImport SUT resolution — negative (must not fire)", () => {
	it("N1: an integration test that runs `node dist/index.js` via execFileSync", () => {
		const code = `import { execFileSync } from "node:child_process";
import { join } from "node:path";
const CLI = join(process.cwd(), "dist", "index.js");
it("prints status", () => { execFileSync("node", [CLI, "status"]); });
`;
		expect(checkTestMissingSutImport(code, "src/lib/foo.integration.test.ts")).toEqual([]);
	});

	it("N1b: an integration test that runs the CLI entry point through `npx tsx`", () => {
		const code = `import { spawnSync } from "node:child_process";
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
it("prints status", () => { spawnSync("npx", ["tsx", ENTRY, "status"]); });
`;
		expect(checkTestMissingSutImport(code, "src/index.integration.test.ts")).toEqual([]);
	});

	it("N2: the SUT is imported under a shorter stem than the test's filename", () => {
		const code = `import { checkTaste } from "./taste.js";\nit("x", () => { checkTaste("a", "b.ts"); });\n`;
		expect(
			checkTestMissingSutImport(code, "src/harness/checks/taste-mutation-kill.test.ts"),
		).toEqual([]);
	});

	it("N3: the SUT is imported under a LONGER stem than the test's filename", () => {
		const code = `import { runCi } from "./simplification-agent-ci-experiment.js";\nit("x", () => { runCi(); });\n`;
		expect(checkTestMissingSutImport(code, "src/lib/simplification-agent-ci.test.ts")).toEqual(
			[],
		);
	});

	it("N4: the SUT is reached through a dynamic import() under a shorter stem", () => {
		const code = `it("x", async () => { const { gitContextCommand } = await import("../git.js"); gitContextCommand(); });\n`;
		expect(checkTestMissingSutImport(code, "src/commands/__tests__/git-commands.test.ts")).toEqual(
			[],
		);
	});

	it("N5: the test connects to the daemon over its Unix socket", () => {
		const code = `import { createConnection } from "node:net";
it("answers", () => { createConnection(".interlinked/harness.sock"); });
`;
		expect(checkTestMissingSutImport(code, "src/harness/socket-answer.test.ts")).toEqual([]);
	});

	it("N6: the test is an on-disk artifact pin reading committed source", () => {
		const code = `import { readFileSync } from "node:fs";
import { join } from "node:path";
const SRC = readFileSync(join(process.cwd(), "src", "harness", "server-event-loop.ts"), "utf-8");
it("keeps the ordering", () => { expect(SRC).toContain("recordEvent"); });
`;
		expect(checkTestMissingSutImport(code, "src/harness/__tests__/snapshot-ordering.test.ts")).toEqual(
			[],
		);
	});

	it("N7: a lineage sibling still resolves when other unrelated siblings are imported too", () => {
		const code = `
import { parse } from "./parse.js";
import { report } from "./protocol-report.js";
it("covers the protocol", () => { expect(parse(report)).toBeTruthy(); });
`;
		expect(
			checkTestMissingSutImport(code, "src/harness/mutation/protocol-v3/protocol-report-shape.test.ts"),
		).toEqual([]);
	});
});

describe("checkTestMissingSutImport SUT resolution — positive (must fire)", () => {
	it("P1: a test that imports nothing and exercises nothing is still an orphan", () => {
		const code = `import { describe, it, expect } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n`;
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("does not import its SUT");
	});

	it("P2: an unrelated same-directory sibling import is still the misnamed-test shape", () => {
		const code = `import { bar } from "./bar.js";\nit("x", () => { expect(bar()).toBe(1); });\n`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("P3: a same-stem PREFIX with no name boundary is a different module", () => {
		const code = `import { foobar } from "./foobar.js";\nit("x", () => { expect(foobar()).toBe(1); });\n`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("P4: a subprocess call with no product target string is not black-box driving", () => {
		const code = `import { execSync } from "node:child_process";\nit("x", () => { execSync("true"); });\n`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("P6: three unrelated same-directory siblings do not stand in for the SUT", () => {
		const code = `
import { a } from "./alpha.js";
import { b } from "./beta.js";
import { c } from "./gamma.js";
it("x", () => { expect(a && b && c).toBeTruthy(); });
`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("P5: an fs read with no repo-artifact path is not an artifact pin", () => {
		const code = `import { readFileSync } from "node:fs";\nit("x", () => { readFileSync(handle); });\n`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	// --- 2026-09-03 verifier repair: the black-box predicates were a pair of
	// INDEPENDENT booleans, so the most ordinary fixture load or unrelated
	// shell-out silenced the check. Evidence must now come from the SAME call.
	it("P7: loading JSON test DATA through readFileSync is not an artifact pin", () => {
		const code = `import { readFileSync } from "node:fs";
it("x", () => { const data = JSON.parse(readFileSync("./fixtures/sample.json", "utf-8")); expect(data).toBeTruthy(); });
`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("P8: an unrelated existsSync setup check is not an artifact pin", () => {
		const code = `import { existsSync } from "node:fs";
it("x", () => { expect(existsSync("package.json")).toBe(true); });
`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("P9: a product-looking string outside the spawn's arguments is not black-box driving", () => {
		const code = `import { execSync } from "node:child_process";
const UNUSED = "some/random/index.js";
it("x", () => { expect(execSync("echo hello").toString()).toContain("hello"); });
`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("P10: a socket path outside the connect call's arguments is not product driving", () => {
		const code = `import { createConnection } from "node:net";
const NOTE = "the daemon listens on harness.sock";
it("x", () => { createConnection(9999); });
`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});
});

describe("checkTestMissingSutImport call-site binding — negative (must not fire)", () => {
	it("N8: the read path reaches the call through a file-local const binding", () => {
		const code = `import { readFileSync } from "node:fs";
const DOC = "docs/generated/guard-rules.md";
const TEXT = readFileSync(DOC, "utf-8");
it("keeps the rule count", () => { expect(TEXT).toContain("builtin_rule_count"); });
`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("N9: a fixture read alongside a genuine product-artifact read still resolves", () => {
		const code = `import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync("./fixtures/sample.json", "utf-8"));
const SRC_TEXT = readFileSync("src/harness/server.ts", "utf-8");
it("pins the source", () => { expect(SRC_TEXT).toContain(data.symbol); });
`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});
});

describe("checkMockingTheSutSelf", () => {
	it("flags vi.mock of the same-directory SUT", () => {
		const code = `vi.mock("./foo");\nit("x", () => { expect(1).toBe(1); });\n`;
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("mocks the system under test");
	});

	it("does not fire when the mock target is a different module in another directory", () => {
		const code = `vi.mock("../commands/foo.js");\nit("x", () => { expect(1).toBe(1); });\n`;
		expect(checkMockingTheSutSelf(code, TEST)).toEqual([]);
	});

	it("does not fire when jest.mock targets an unrelated sibling", () => {
		const code = `jest.mock("./bar");\nit("x", () => { expect(1).toBe(1); });\n`;
		expect(checkMockingTheSutSelf(code, TEST)).toEqual([]);
	});
});

describe("hasAnyProjectSourceImport", () => {
	it("returns true for a parent-directory project source import", () => {
		expect(hasAnyProjectSourceImport(`import { x } from "../lib/x.js";`)).toBe(true);
	});

	it("returns false when the only parent-directory import is a test/mock/fixture/asset", () => {
		expect(hasAnyProjectSourceImport(`import { x } from "../lib/x.test.js";`)).toBe(false);
		expect(hasAnyProjectSourceImport(`import data from "../fixtures/data.json";`)).toBe(false);
	});

	it("returns false with no parent-directory import at all", () => {
		expect(hasAnyProjectSourceImport(`import { x } from "./x.js";`)).toBe(false);
	});
});
