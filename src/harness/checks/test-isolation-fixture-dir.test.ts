import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkInTreeTempFixture } from "./test-isolation-fixture-dir.js";

const TEST_FILE = "src/harness/__tests__/some-thing.test.ts";
const SRC_FILE = "src/harness/some-thing.ts";

describe("checkInTreeTempFixture — positive (must fire)", () => {
	it("P1: mkdtempSync with resolve(CLI_ROOT, ...) fires", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
const dir = mkdtempSync(resolve(CLI_ROOT, "_content_gate_fixtures-"));
`;
		const matches = checkInTreeTempFixture(code, TEST_FILE);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("in_tree_temp_fixture");
		expect(nonNull(matches[0]).text).toContain("CLI_ROOT");
	});

	it("P2: mkdtempSync with join(__dirname, ...) fires", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync(join(__dirname, "fixtures-"));
`;
		const matches = checkInTreeTempFixture(code, TEST_FILE);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("__dirname");
	});

	it("P3: mkdtempSync with a bare in-tree string literal fires", () => {
		const code = `
import { mkdtempSync } from "node:fs";
const dir = mkdtempSync("src/_x-");
`;
		const matches = checkInTreeTempFixture(code, TEST_FILE);
		expect(matches.length).toBe(1);
	});

	it("P4: mkdirSync with recursive:true on a non-tmpdir-rooted path fires", () => {
		const code = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
mkdirSync(join(process.cwd(), "scratch-dir"), { recursive: true });
`;
		const matches = checkInTreeTempFixture(code, TEST_FILE);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("process.cwd()");
	});

	it("P5: fs.promises.mkdtemp with join(REPO_ROOT, ...) fires", () => {
		const code = `
import * as fs from "node:fs";
import { join } from "node:path";
async function make() {
	const dir = await fs.promises.mkdtemp(join(REPO_ROOT, "fixture-"));
}
`;
		const matches = checkInTreeTempFixture(code, TEST_FILE);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("REPO_ROOT");
	});
});

describe("checkInTreeTempFixture — negative (must not fire)", () => {
	it("N1: mkdtempSync(join(tmpdir(), ...)) does not fire", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "x-"));
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N2: mkdtempSync(TMP_ROOT) where TMP_ROOT derives from os.tmpdir() in the same file does not fire", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
const TMP_ROOT = join(os.tmpdir(), "my-prefix-");
const dir = mkdtempSync(TMP_ROOT);
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N3: mkdirSync(join(tmp, 'sub'), {recursive:true}) where tmp came from mkdtemp does not fire", () => {
		const code = `
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const tmp = mkdtempSync(join(tmpdir(), "base-"));
mkdirSync(join(tmp, "sub"), { recursive: true });
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N4: mkdtempSync mentioned only inside a comment does not fire", () => {
		const code = `
// const dir = mkdtempSync(resolve(CLI_ROOT, "_content_gate_fixtures-"));
const x = 1;
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N5: non-test files never fire, even with an in-tree mkdtempSync", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
const dir = mkdtempSync(resolve(CLI_ROOT, "_content_gate_fixtures-"));
`;
		expect(checkInTreeTempFixture(code, SRC_FILE)).toEqual([]);
	});

	it("N6: mkdirSync(helperFn(), {recursive:true}) does not fire when helperFn() returns a tmp-rooted path", () => {
		const code = `
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let tmp: string;
tmp = mkdtempSync(join(tmpdir(), "plan-cli-"));
function plansDir(): string {
	return join(tmp, ".interlinked", "plans");
}
mkdirSync(plansDir(), { recursive: true });
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N7: mkdtempSync(\"/tmp/ildm-\") — a bare /tmp string literal — does not fire", () => {
		const code = `
import { mkdtempSync } from "node:fs";
const tmp = mkdtempSync("/tmp/ildm-");
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N8: parameter root — mkdirSync(join(cwd, ...)) inside a function whose param is named cwd does not fire", () => {
		const code = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
function writeCoverageSummary(cwd: string, name: string) {
	mkdirSync(join(cwd, "coverage"), { recursive: true });
}
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N9: tmpdir-bound const via realpathSync(mkdtempSync('/tmp/...')) reached through an alias does not fire", () => {
		const code = `
import { mkdirSync, realpathSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
const tmp = realpathSync(mkdtempSync("/tmp/ildm-"));
mkdirSync(join(tmp, "sub"), { recursive: true });
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N10: beforeEach-assigned tmp (mkdtempSync(join(tmpdir(), ...)) inside beforeEach) does not fire", () => {
		const code = `
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "x-"));
});
mkdirSync(join(tmp, "sub"), { recursive: true });
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N11: one-hop alias of a tmpdir-bound const does not fire", () => {
		const code = `
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const base = mkdtempSync(join(tmpdir(), "base-"));
const dataDir = base;
mkdirSync(join(dataDir, "data"), { recursive: true });
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("P6: an identifier bound to resolve(CLI_ROOT, ...) still fires", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(CLI_ROOT, "_fixtures-");
mkdtempSync(dir);
`;
		const matches = checkInTreeTempFixture(code, TEST_FILE);
		expect(matches.length).toBe(1);
	});

	it("P7: parameter-less mkdtempSync(join(process.cwd(), ...)) still fires", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
const dir = mkdtempSync(join(process.cwd(), "y-"));
`;
		const matches = checkInTreeTempFixture(code, TEST_FILE);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("process.cwd()");
	});

	it("N12: multi-hop — local = join(param, ...) then mkdirSync(local) reaches the parameter rule", () => {
		const code = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
function writeFixtures(root) {
	const dataDir = join(root, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
}
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N13: tmpdir RHS by content, not by name — a same-file helper chain resolves through a non-conventional name", () => {
		const code = `
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const sandboxRoot = realpathSync(tmpdir());
function makeTmp(prefix) {
	const dir = realpathSync(mkdtempSync(join(sandboxRoot, prefix)));
	return dir;
}
function makePair(root, name) {
	const leafDir = join(root, name);
	mkdirSync(leafDir, { recursive: true });
}
makePair(makeTmp("x-"), "leaf");
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N14: /tmp literal nested in join(...), no trailing slash, qualifies", () => {
		const code = `
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
const sandbox = mkdtempSync(join("/tmp", "imports-check-"));
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});

	it("N15: a same-file function shadowing mkdtempSync — the bare wrapper call is skipped, its own body is judged on its own line", () => {
		const code = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
function mkdtempSync() {
	return require("node:fs").mkdtempSync(join(tmpdir(), "heavy-jobs-w49-"));
}
const tmpCwd = mkdtempSync();
`;
		expect(checkInTreeTempFixture(code, TEST_FILE)).toEqual([]);
	});
});
