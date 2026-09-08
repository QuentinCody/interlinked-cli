import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_SCRIPT_VERSION, resolveOwnVersionFrom } from "../hook-version.js";

describe("HOOK_SCRIPT_VERSION", () => {
	it("resolves to a non-empty semver-ish string", () => {
		expect(typeof HOOK_SCRIPT_VERSION).toBe("string");
		expect(HOOK_SCRIPT_VERSION.length).toBeGreaterThan(0);
	});

	it("matches the version in cli/package.json (not a parent monorepo's)", async () => {
		// Regression test for the old `new URL("../../package.json", ...)`
		// approach, which resolved to the monorepo's package.json when the
		// CLI ran from `dist/`. The walk-up-and-match-by-name logic must
		// pick up *this* package specifically.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const { dirname, join } = await import("node:path");
		const here = dirname(fileURLToPath(import.meta.url));
		// Walk from the test file up to the cli/ package root.
		const pkgPath = join(here, "..", "..", "..", "package.json");
		const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		expect(pkg).toMatchObject({ name: "interlinked-cli", version: HOOK_SCRIPT_VERSION });
	});

	it("is a valid-ish semver (major.minor.patch prefix)", () => {
		// Not a strict semver validator — just guards against the fallback
		// "0.0.0" sneaking in silently. A real CLI build should never be 0.0.0.
		expect(HOOK_SCRIPT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("does not resolve to the fallback on a healthy dev tree", () => {
		// Lives as its own test so a regression (fallback triggering) fails
		// obviously rather than silently passing the shape checks above.
		expect(HOOK_SCRIPT_VERSION).not.toBe("0.0.0");
	});
});

// An unusable package.json on the way up must not abort the walk. Both cases
// put the REAL interlinked-cli package.json one level above the broken one, so
// the assertion distinguishes "skipped this candidate and kept walking" from
// "gave up and reported unknown" — the two outcomes are 9.9.9/8.8.8 vs 0.0.0.
describe("resolveOwnVersionFrom — an unusable package.json on the walk", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hook-version-walk-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps walking past a package.json that cannot be read", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "interlinked-cli", version: "9.9.9" }),
		);
		// A DIRECTORY named package.json exists but cannot be read as a file.
		mkdirSync(join(root, "pkg", "package.json"), { recursive: true });

		const from = pathToFileURL(join(root, "pkg", "index.js")).href;

		expect(resolveOwnVersionFrom(from)).toBe("9.9.9");
	});

	it("keeps walking past a package.json holding malformed JSON", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "interlinked-cli", version: "8.8.8" }),
		);
		mkdirSync(join(root, "pkg"), { recursive: true });
		writeFileSync(join(root, "pkg", "package.json"), '{ "name": "interlinked-cli",');

		const from = pathToFileURL(join(root, "pkg", "index.js")).href;

		expect(resolveOwnVersionFrom(from)).toBe("8.8.8");
	});
});
