import { makeRouteMap as completeRouteMapFixture } from "./__tests__/fixtures/managers.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
	};
});

import { existsSync } from "node:fs";
import { collectEntryPoints } from "./entry-points.js";

const mockedExistsSync = vi.mocked(existsSync);

function mkTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("entry-points.ts mutation-kill (w50)", () => {
	let tmpDirs: string[] = [];

	afterEach(async () => {
		for (const d of tmpDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
		tmpDirs = [];
		// vi.fn(actual.fn) mocks (created inside the vi.mock factory) are not
		// spies, so vi.restoreAllMocks() alone won't revert a mockImplementation
		// set by a test back to the real fs call — reset explicitly.
		const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
		mockedExistsSync.mockImplementation(actualFs.existsSync);
		vi.restoreAllMocks();
	});

	function newTmp(prefix = "il-entry-pts-"): string {
		const d = mkTmp(prefix);
		tmpDirs.push(d);
		return d;
	}

	// --- ArrayDeclaration mutants: [] -> ["Stryker was here"] ---------------

	it("returns an exactly-empty array for a project with no package.json, no routeMap, no tests (kills [] init/return mutants)", () => {
		const dir = newTmp();
		const result = collectEntryPoints(dir, { includeTests: true });
		expect(result).toEqual([]);
	});

	it("returns no http_handler entries when routeMap.extractAllEndpoints() is empty (kills the alternate [] site in collectHttpHandlers)", () => {
		const dir = newTmp();
		const fakeRouteMap = completeRouteMapFixture({
			extractAllEndpoints: () => [],
		});
		const result = collectEntryPoints(dir, { routeMap: fakeRouteMap });
		expect(result).toEqual([]);
	});

	// --- StringLiteral: `:${ep.line}` -> `` ----------------------------------

	it("appends :<line> to the http_handler reason when a line number is present", () => {
		const dir = newTmp();
		const fakeRouteMap = completeRouteMapFixture({
			extractAllEndpoints: () => [
				{ framework: "express", method: "GET", path: "/foo", file: join(dir, "h.ts"), line: 42, auth_chain: [], declared_params: [] },
			],
		});
		const result = collectEntryPoints(dir, { routeMap: fakeRouteMap });
		const httpEntries = result.filter((e) => e.kind === "http_handler");
		expect(httpEntries).toHaveLength(1);
		expect(httpEntries[0]?.reason).toBe("express GET /foo:42");
	});

	// --- ConditionalExpression: value !== null -> true (isJsonObject) -------

	it("does not throw when package.json exports is JSON null (kills isJsonObject(null) always-true mutant)", () => {
		const dir = newTmp();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: null }));
		expect(() => collectEntryPoints(dir)).not.toThrow();
		const result = collectEntryPoints(dir);
		expect(result.some((e) => e.kind === "lib_export")).toBe(false);
	});

	// --- collectTestFiles: TEST_SKIP_DIRS membership (non-dot names) --------

	it.each(["dist", "build", "coverage", "out", "target", "venv"])(
		"skips descending into %s when scanning for test files",
		(skipDirName) => {
			const dir = newTmp();
			const skipDir = join(dir, skipDirName);
			mkdirSync(skipDir, { recursive: true });
			writeFileSync(join(skipDir, "hidden.test.ts"), "export {};");
			const normalDir = join(dir, "normal");
			mkdirSync(normalDir, { recursive: true });
			writeFileSync(join(normalDir, "present.test.ts"), "export {};");

			const result = collectEntryPoints(dir, { includeTests: true });
			const testFiles = result.filter((e) => e.kind === "test").map((e) => e.file);

			expect(testFiles.some((f) => f.includes(`${skipDirName}${sep}hidden.test.ts`))).toBe(false);
			expect(testFiles.some((f) => f.endsWith(join("normal", "present.test.ts")))).toBe(true);
		},
	);

	// --- collectTestFiles: reason template `test file: ${entry.name}` -------

	it("includes the file name in the test-file reason string", () => {
		const dir = newTmp();
		writeFileSync(join(dir, "found.test.ts"), "export {};");
		const result = collectEntryPoints(dir, { includeTests: true });
		const testEntry = result.find((e) => e.kind === "test");
		expect(testEntry).toBeDefined();
		expect(testEntry?.reason).toBe("test file: found.test.ts");
	});

	// --- readPackageJson: !existsSync(path) -> false --------------------------

	it("treats package.json as absent when existsSync says so, even if it is really on disk (kills !existsSync always-false mutant)", async () => {
		const dir = newTmp();
		writeFileSync(join(dir, "x.js"), "");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./x.js" }));

		const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
		mockedExistsSync.mockImplementation((p) => {
			if (typeof p === "string" && p.endsWith("package.json")) return false;
			return actualFs.existsSync(p);
		});

		const result = collectEntryPoints(dir);
		expect(result.some((e) => e.reason === "package.json:main")).toBe(false);
	});

	// --- readPackageJson: "utf-8" encoding + happy path -----------------------

	it("reads package.json:main correctly end to end (kills the utf-8 encoding mutant)", () => {
		const dir = newTmp();
		writeFileSync(join(dir, "x.js"), "");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./x.js" }));

		const result = collectEntryPoints(dir);
		const mainEntry = result.find((e) => e.reason === "package.json:main");
		expect(mainEntry).toBeDefined();
		expect(mainEntry?.file.endsWith("x.js")).toBe(true);
	});
});
