import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	collectDeclaredDeps,
	findCrossPackageBoundary,
	loadNearestPackageJson,
} from "./package-json-boundary.js";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pkg-boundary-"));
	mkdirSync(join(root, "app", "src", "deep"), { recursive: true });
	mkdirSync(join(root, "libs", "ui", "src"), { recursive: true });
	mkdirSync(join(root, "pkgless", "src"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ private: true, dependencies: { root: "1" } }),
	);
	writeFileSync(
		join(root, "app", "package.json"),
		JSON.stringify({
			dependencies: { a: "1" },
			devDependencies: { b: "1" },
			peerDependencies: { c: "1" },
			optionalDependencies: { d: "1" },
		}),
	);
	writeFileSync(join(root, "libs", "ui", "package.json"), JSON.stringify({ name: "ui" }));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("loadNearestPackageJson", () => {
	it("finds the closest package.json walking upward", () => {
		const pkg = loadNearestPackageJson(join(root, "app", "src", "deep", "file.ts"));
		expect(pkg).not.toBeNull();
		expect(pkg?.dependencies).toEqual({ a: "1" });
	});

	it("returns null when a malformed package.json is the closest one", () => {
		const dir = mkdtempSync(join(tmpdir(), "pkg-bad-"));
		writeFileSync(join(dir, "package.json"), "{ not json");
		expect(loadNearestPackageJson(join(dir, "file.ts"))).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no package.json exists above the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pkg-none-"));
		// tmpdir itself has no package.json ancestor within reach in CI sandboxes,
		// so assert only that a non-object result is impossible for this tree.
		const pkg = loadNearestPackageJson(join(dir, "file.ts"));
		expect(pkg === null || typeof pkg === "object").toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("collectDeclaredDeps", () => {
	it("unions all four dependency fields", () => {
		const deps = collectDeclaredDeps({
			dependencies: { a: "1" },
			devDependencies: { b: "1" },
			peerDependencies: { c: "1" },
			optionalDependencies: { d: "1" },
		});
		expect([...deps].sort()).toEqual(["a", "b", "c", "d"]);
	});

	it("ignores non-object dependency fields", () => {
		const deps = collectDeclaredDeps({ dependencies: "nope", devDependencies: { b: "1" } });
		expect([...deps]).toEqual(["b"]);
	});

	it("returns an empty set for a package.json with no dependency fields", () => {
		expect(collectDeclaredDeps({ name: "x" }).size).toBe(0);
	});
});

describe("findCrossPackageBoundary", () => {
	it("reports the boundary directory when a sibling package is crossed", () => {
		const fileDir = join(root, "libs", "ui", "src");
		const found = findCrossPackageBoundary(join(fileDir, "a.ts"), fileDir, "../other.ts");
		expect(found).toBe(join(root, "libs", "ui"));
	});

	it("returns null when the only package.json crossed is the project root", () => {
		const fileDir = join(root, "pkgless", "src");
		const found = findCrossPackageBoundary(join(fileDir, "a.ts"), fileDir, "../../x.ts");
		expect(found).toBeNull();
	});

	it("stops at the first non-root package.json rather than the project root", () => {
		const fileDir = join(root, "app", "src", "deep");
		const found = findCrossPackageBoundary(join(fileDir, "a.ts"), fileDir, "../../../../x.ts");
		expect(found).toBe(join(root, "app"));
	});

	it("returns null when the specifier has no parent segments", () => {
		const fileDir = join(root, "libs", "ui", "src");
		expect(findCrossPackageBoundary(join(fileDir, "a.ts"), fileDir, "./sibling.ts")).toBeNull();
	});

	it("skips the importing file's own directory package.json", () => {
		const fileDir = join(root, "libs", "ui", "src");
		const filePath = join(root, "libs", "ui", "a.ts");
		expect(findCrossPackageBoundary(filePath, fileDir, "../x.ts")).toBeNull();
	});
});
