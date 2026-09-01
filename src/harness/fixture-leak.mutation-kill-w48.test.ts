import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execSync: vi.fn(actual.execSync) };
});

import { execSync } from "node:child_process";
import { detectFixtureLeaks, formatFixtureLeakWarning } from "./fixture-leak.js";

const mockedExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

const tmpDirs: string[] = [];

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-leak-w48-"));
	tmpDirs.push(dir);
	execSync("git init -q", { cwd: dir });
	execSync('git config user.email "t@t.com"', { cwd: dir });
	execSync('git config user.name "t"', { cwd: dir });
	return dir;
}

function writeFile(dir: string, relPath: string, content: string): void {
	const full = path.join(dir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf-8");
}

function track(dir: string, relPath: string): void {
	execSync(`git add -- "${relPath}"`, { cwd: dir });
}

afterEach(() => {
	mockedExecSync.mockClear();
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("detectFixtureLeaks — positive detection", () => {
	it("finds an orphaned fixture referenced by a .test.ts file", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leak_case.ts", "// orphan fixture\n");
		writeFile(
			dir,
			"src/mymodule.test.ts",
			'writeFixture("_leak_case.ts", "x");\n',
		);
		track(dir, "src/mymodule.test.ts");

		const leaks = detectFixtureLeaks(dir);
		expect(leaks).toEqual([
			{ file: "src/_leak_case.ts", referencedBy: "src/mymodule.test.ts" },
		]);
	});

	it("recognizes __tests__/ shaped test file paths (not just *.test.ts)", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leak5.ts", "orphan\n");
		writeFile(dir, "__tests__/helper.ts", 'setupFixture("_leak5.ts");\n');
		track(dir, "__tests__/helper.ts");

		const leaks = detectFixtureLeaks(dir);
		expect(leaks).toEqual([
			{ file: "src/_leak5.ts", referencedBy: "__tests__/helper.ts" },
		]);
	});

	it("matches a writer call with whitespace before the opening paren", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leak8.ts", "orphan\n");
		writeFile(
			dir,
			"src/spacedcall.test.ts",
			'writeFixture ("_leak8.ts");\n',
		);
		track(dir, "src/spacedcall.test.ts");

		const leaks = detectFixtureLeaks(dir);
		expect(leaks).toEqual([
			{ file: "src/_leak8.ts", referencedBy: "src/spacedcall.test.ts" },
		]);
	});
});

describe("detectFixtureLeaks — negative guards (must NOT flag)", () => {
	it("ignores a candidate file outside src/", () => {
		const dir = makeRepo();
		writeFile(dir, "other/_leak2.ts", "orphan\n");
		writeFile(
			dir,
			"other/mymodule2.test.ts",
			'writeFixture("_leak2.ts");\n',
		);
		track(dir, "other/mymodule2.test.ts");

		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("ignores a basename whose underscore is not at the very start", () => {
		const dir = makeRepo();
		writeFile(dir, "src/abc_leak3.ts", "orphan\n");
		writeFile(
			dir,
			"src/mymodule3.test.ts",
			'writeFixture("abc_leak3.ts");\n',
		);
		track(dir, "src/mymodule3.test.ts");

		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("ignores a basename with trailing characters after the extension", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leak4.ts.orig", "orphan\n");
		writeFile(
			dir,
			"src/mymodule4.test.ts",
			'writeFixture("_leak4.ts.orig");\n',
		);
		track(dir, "src/mymodule4.test.ts");

		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("does not treat a __tests__ path with a trailing suffix as a test file", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leak6.ts", "orphan\n");
		writeFile(
			dir,
			"__tests__/helper2.ts.bak",
			'writeFixture("_leak6.ts");\n',
		);
		track(dir, "__tests__/helper2.ts.bak");

		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("does not treat a *.test.ts path with a trailing suffix as a test file", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leak7.ts", "orphan\n");
		writeFile(dir, "weird.test.ts.bak", 'writeFixture("_leak7.ts");\n');
		track(dir, "weird.test.ts.bak");

		expect(detectFixtureLeaks(dir)).toEqual([]);
	});

	it("ignores fixture-writer content in a tracked file that is not test-shaped", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leak9.ts", "orphan\n");
		writeFile(dir, "src/random.ts", 'writeFixture("_leak9.ts");\n');
		track(dir, "src/random.ts");

		expect(detectFixtureLeaks(dir)).toEqual([]);
	});
});

describe("detectFixtureLeaks — git invocation shape", () => {
	it("calls the untracked and tracked git ls-files commands with exact args", () => {
		const dir = makeRepo();
		writeFile(dir, "src/_leakA.ts", "orphan\n");
		writeFile(dir, "src/moduleA.test.ts", 'writeFixture("_leakA.ts");\n');
		track(dir, "src/moduleA.test.ts");

		mockedExecSync.mockClear();
		detectFixtureLeaks(dir);

		const calls = mockedExecSync.mock.calls as unknown as [string, Record<string, unknown>][];
		const untrackedCall = calls.find(([cmd]) =>
			cmd.includes("--others"),
		);
		const trackedCall = calls.find(
			([cmd]) => cmd === "git ls-files",
		);

		expect(untrackedCall?.[0]).toBe("git ls-files --others --exclude-standard");
		expect(untrackedCall?.[1]).toMatchObject({
			cwd: dir,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		expect(trackedCall?.[1]).toMatchObject({
			cwd: dir,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("does not call the tracked-test-file git command when no candidates exist", () => {
		const dir = makeRepo();
		// untracked but not a fixture candidate (wrong extension, no underscore prefix)
		writeFile(dir, "src/notfixture.txt", "hello\n");

		mockedExecSync.mockClear();
		const leaks = detectFixtureLeaks(dir);

		expect(leaks).toEqual([]);
		expect(mockedExecSync).toHaveBeenCalledTimes(1);
	});
});

describe("formatFixtureLeakWarning", () => {
	it("returns null for an empty leaks list", () => {
		expect(formatFixtureLeakWarning({ leaks: [] })).toBeNull();
	});

	it("respects an explicit maxShown, slicing and reporting the remainder", () => {
		const leaks = [
			{ file: "src/_a.ts", referencedBy: "src/a.test.ts" },
			{ file: "src/_b.ts", referencedBy: "src/b.test.ts" },
			{ file: "src/_c.ts", referencedBy: "src/c.test.ts" },
			{ file: "src/_d.ts", referencedBy: "src/d.test.ts" },
		];
		const msg = formatFixtureLeakWarning({ leaks, maxShown: 3 });
		expect(msg).not.toBeNull();
		const bulletCount = (msg?.match(/^\s+- /gm) ?? []).length;
		expect(bulletCount).toBe(3);
		expect(msg).toContain("_a.ts");
		expect(msg).toContain("_b.ts");
		expect(msg).toContain("_c.ts");
		expect(msg).not.toContain("_d.ts");
		expect(msg).toContain("...and 1 more");
	});

	it("shows every leak and no remainder note when under the default max", () => {
		const leaks = [{ file: "src/_only.ts", referencedBy: "src/only.test.ts" }];
		const msg = formatFixtureLeakWarning({ leaks });
		expect(msg).toContain("_only.ts");
		expect(msg).not.toContain("more");
	});
});
