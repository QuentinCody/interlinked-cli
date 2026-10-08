import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCommittedTestFixture, isTestFixturePath } from "./committed-test-fixture.js";
import { DEFAULT_TAINT_CONFIG } from "./taint-tracker.js";

// Built at run time so this source file carries no literal key shape.
const AWS = ["AKIA", "IOSFODNN7EXAMPLQ"].join("");
const AWS2 = ["AKIA", "ZZZZODNN7EXAMPLQ"].join("");
const IDS = ["sig-secret-aws-key"];

let repo: string;
beforeEach(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "committed-fixture-")));
	git("init", "-q");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): void {
	execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
		stdio: "ignore",
	});
}

function put(rel: string, body: string): string {
	const p = join(repo, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, body);
	return p;
}

function commitAll(): void {
	git("add", "-A");
	git("commit", "-q", "-m", "fixture");
}

function query(path: string, text: string) {
	return { path, text, ruleIds: IDS, projectRoot: repo, taint: DEFAULT_TAINT_CONFIG };
}

describe("isTestFixturePath", () => {
	it("P: test files and fixture directories", () => {
		expect(["/r/src/__tests__/a.ts", "/r/a.test.ts", "/r/x/__fixtures__/k.json", "/r/fixtures/k", "/r/go/testdata/k"].map(isTestFixturePath)).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
	});
	it("N: product source and notes", () => {
		expect(["/r/src/a.ts", "/r/notes.md", "/r/fixture.json"].map(isTestFixturePath)).toEqual([false, false, false]);
	});
});

describe("committed test fixture — positive (Internal tier)", () => {
	it("P1: a tracked test file whose fake key is committed at HEAD", () => {
		const p = put("src/__tests__/sig.test.ts", `const k = "${AWS}";\n`);
		commitAll();
		expect(isCommittedTestFixture(query(p, `const k = "${AWS}";`))).toBe(true);
	});

	it("P2: a worktree edit that adds no new secret-shaped value keeps the tier", () => {
		const p = put("tests/fixtures/keys.json", `{"k":"${AWS}"}\n`);
		commitAll();
		writeFileSync(p, `{"k":"${AWS}","note":"edited"}\n`);
		expect(isCommittedTestFixture(query(p, `{"k":"${AWS}","note":"edited"}`))).toBe(true);
	});
});

describe("committed test fixture — negative (fail safe ⇒ Confidential)", () => {
	it("N1: an untracked test file", () => {
		const p = put("src/__tests__/new.test.ts", `"${AWS}"`);
		put("README.md", "x");
		commitAll();
		const q = put("src/__tests__/later.test.ts", `"${AWS}"`);
		expect([isCommittedTestFixture(query(q, `"${AWS}"`)), isCommittedTestFixture(query(p, `"${AWS}"`))]).toEqual([false, true]);
	});

	it("N2: a tracked test file with a NEW key not present at HEAD (laundered secret)", () => {
		const p = put("src/__tests__/sig.test.ts", `"${AWS}"`);
		commitAll();
		writeFileSync(p, `"${AWS}" "${AWS2}"`);
		expect(isCommittedTestFixture(query(p, `"${AWS}" "${AWS2}"`))).toBe(false);
	});

	it("N3: a tracked NON-test file", () => {
		const p = put("src/config.ts", `"${AWS}"`);
		commitAll();
		expect(isCommittedTestFixture(query(p, `"${AWS}"`))).toBe(false);
	});

	it("N4: a test path that matches a sensitive glob (.env.*)", () => {
		const p = put("tests/.env.test", `KEY=${AWS}`);
		commitAll();
		expect(isCommittedTestFixture(query(p, `KEY=${AWS}`))).toBe(false);
	});

	it("N5: a gitignored fixture", () => {
		put(".gitignore", "tests/fixtures/local.json\n");
		const p = put("tests/fixtures/local.json", `{"k":"${AWS}"}`);
		commitAll();
		expect(isCommittedTestFixture(query(p, `{"k":"${AWS}"}`))).toBe(false);
	});

	it("N6: a file outside the project root", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "committed-fixture-out-")));
		try {
			const p = join(outside, "a.test.ts");
			writeFileSync(p, `"${AWS}"`);
			expect(isCommittedTestFixture(query(p, `"${AWS}"`))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("N7: a project root that is not a git repository (git unavailable ⇒ untracked)", () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "committed-fixture-nogit-")));
		try {
			const p = join(plain, "a.test.ts");
			writeFileSync(p, `"${AWS}"`);
			expect(isCommittedTestFixture({ ...query(p, `"${AWS}"`), projectRoot: plain })).toBe(false);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("N8: no signature occurrence to verify (empty rule list)", () => {
		const p = put("src/__tests__/sig.test.ts", `"${AWS}"`);
		commitAll();
		expect(isCommittedTestFixture({ ...query(p, `"${AWS}"`), ruleIds: [] })).toBe(false);
	});
});
