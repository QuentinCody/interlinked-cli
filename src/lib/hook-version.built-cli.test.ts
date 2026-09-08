import { isJsonObject } from "./json-types.js";
// ===========================================
// Hook version — resolved from the BUILT bundle, not the source tree
// ===========================================
// This is the test that would have caught the 2026-08-27 defect, and the
// reason it has to spawn the real `dist/` bundle rather than import a module.
//
// `hooks.ts` carried its own copy of the version lookup:
//   new URL("../../package.json", import.meta.url)
// From `src/lib/` that resolves to the repo's own package.json, so every
// source-tree test agreed with every source-tree run and the duplicate looked
// correct. From the BUNDLED `dist/index.js`, the same expression resolves one
// level ABOVE the repo — a user's home directory, or a containing monorepo.
// On the machine where this was found, `~/package.json` exists and declares
// version 1.0.0, so the built CLI reported "expected 1.0.0+mode-quality"
// against a 0.1.0 package and stamped that foreign version into generated
// hooks. `hook-version.ts` (which matches on `name === "interlinked-cli"`)
// existed precisely to prevent this; `hooks.ts` had simply never adopted it.
//
// The invariant under test is therefore about LOCATION, not arithmetic: the
// version the shipped CLI reports must equal this package's own version, from
// wherever the bundle happens to sit.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "index.js");

function ownVersion(): string {
	const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
	const version = isJsonObject(pkg) ? pkg.version : undefined;
	if (typeof version !== "string") throw new Error("package.json has no string version");
	return version;
}

function runBuiltContext(): unknown {
	const fixture = mkdtempSync(join(tmpdir(), "hook-version-built-"));
	const configDir = join(fixture, ".interlinked");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			version: 1,
			server_url: "http://127.0.0.1:8787",
			default_workspace_key: "main",
			default_project: "main",
			mode: "quality",
		}),
	);
	try {
		const raw = execFileSync(process.execPath, [DIST_CLI, "context", "--json"], {
			cwd: fixture,
			encoding: "utf-8",
			timeout: 60_000,
			env: {
				...process.env,
				HOME: fixture,
				USERPROFILE: fixture,
				XDG_CONFIG_HOME: join(fixture, ".config"),
				INTERLINKED_HOME: configDir,
				INTERLINKED_DATA_DIR: configDir,
				INTERLINKED_ACCESS_TOKEN: "",
				INTERLINKED_TOKEN: "",
			},
		});
		return JSON.parse(raw);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

/** The built bundle is a prerequisite, not something to silently skip past:
 *  a skipped test here is exactly how the original defect survived. When
 *  `dist/` is absent (a fresh clone that has not run `npm run build`) the
 *  suite says so out loud rather than reporting a pass. */
const built = existsSync(DIST_CLI);

describe("hook version resolved from the built bundle", () => {
	it.skipIf(!built)(
		"P: `context --json` from dist reports THIS package's version, not an ancestor's",
		() => {
			const parsed = runBuiltContext();
			const hooks = isJsonObject(parsed) ? parsed.hooks : undefined;
			const current = isJsonObject(hooks) ? hooks.current_version : undefined;
			expect(typeof current).toBe("string");
			// The version may carry a `+mode-<preset>` suffix; the base must be ours.
			expect(String(current).split("+")[0]).toBe(ownVersion());
		},
	);

	it.skipIf(!built)(
		"N: the reported version does not come from an ancestor package.json",
		() => {
			// The defect's signature: `../../package.json` from dist/index.js.
			// If such a file exists and declares a DIFFERENT version, the built
			// CLI must not be reporting it.
			const ancestorPkg = join(REPO_ROOT, "..", "package.json");
			if (!existsSync(ancestorPkg)) return; // nothing to be confused by here
			const ancestor: unknown = JSON.parse(readFileSync(ancestorPkg, "utf-8"));
			const ancestorVersion = isJsonObject(ancestor) ? ancestor.version : undefined;
			if (typeof ancestorVersion !== "string" || ancestorVersion === ownVersion()) return;
			const parsed = runBuiltContext();
			const hooks = isJsonObject(parsed) ? parsed.hooks : undefined;
			const current = String(isJsonObject(hooks) ? hooks.current_version ?? "" : "");
			expect(current.split("+")[0]).not.toBe(ancestorVersion);
		},
	);

	// The adjacent defect the version fix exposed: `context` compared the FULL
	// installed sentinel against the BARE package version, so every correct
	// install reported stale:true while doctor called the same install current.
	it("P: a sentinel splits into version and mode", async () => {
		const { parseHookSentinel } = await import("./hook-version.js");
		expect(parseHookSentinel("0.1.0+mode-quality")).toEqual({ version: "0.1.0", mode: "quality" });
	});

	it("N: a bare sentinel has no mode, and its version still compares equal", async () => {
		const { parseHookSentinel } = await import("./hook-version.js");
		expect(parseHookSentinel("0.1.0")).toEqual({ version: "0.1.0", mode: null });
	});

	it("P: composing then parsing round-trips the mode", async () => {
		const { composeHookSentinel, parseHookSentinel, HOOK_SCRIPT_VERSION } = await import(
			"./hook-version.js"
		);
		const parsed = parseHookSentinel(composeHookSentinel("budget"));
		expect(parsed).toEqual({ version: HOOK_SCRIPT_VERSION, mode: "budget" });
	});

	// THESE run everywhere, build or no build. The two `skipIf(!built)` cases
	// above are the end-to-end proof, but `dist/` is gitignored and CI's unit
	// and integration jobs never build — so on CI they SKIP, and the pin that
	// exists to catch this defect would silently not run. The location rule is
	// checkable against a synthetic layout instead, which is what actually
	// guards the regression.
	describe("the location rule, against a synthetic bundle layout", () => {
		let root: string;

		beforeEach(() => {
			// <root>/package.json      → the ANCESTOR trap (a different package)
			// <root>/pkg/package.json  → the real interlinked-cli
			// <root>/pkg/dist/index.js → where the bundle sits at runtime
			root = mkdtempSync(join(tmpdir(), "hv-"));
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ name: "some-parent", version: "1.0.0" }),
			);
			mkdirSync(join(root, "pkg", "dist"), { recursive: true });
			writeFileSync(
				join(root, "pkg", "package.json"),
				JSON.stringify({ name: "interlinked-cli", version: "0.1.0" }),
			);
		});

		afterEach(() => rmSync(root, { recursive: true, force: true }));

		it("P: from the bundled dist/, resolves the PACKAGE version, not the ancestor's", async () => {
			const { resolveOwnVersionFrom } = await import("./hook-version.js");
			const bundleUrl = pathToFileURL(join(root, "pkg", "dist", "index.js")).href;
			expect(resolveOwnVersionFrom(bundleUrl)).toBe("0.1.0");
		});

		it("N: an ancestor package.json with a different name is never accepted", async () => {
			// The exact defect: `../../package.json` from `<pkg>/dist/index.js`
			// IS `<root>/package.json`, which declares 1.0.0.
			const { resolveOwnVersionFrom } = await import("./hook-version.js");
			const bundleUrl = pathToFileURL(join(root, "pkg", "dist", "index.js")).href;
			expect(resolveOwnVersionFrom(bundleUrl)).not.toBe("1.0.0");
		});

		it("P: from a source-tree layout (src/lib/), resolves the same version", async () => {
			const { resolveOwnVersionFrom } = await import("./hook-version.js");
			mkdirSync(join(root, "pkg", "src", "lib"), { recursive: true });
			const srcUrl = pathToFileURL(join(root, "pkg", "src", "lib", "hooks.ts")).href;
			expect(resolveOwnVersionFrom(srcUrl)).toBe("0.1.0");
		});

		it("N: with no interlinked-cli package.json anywhere, reports unknown", async () => {
			const { resolveOwnVersionFrom } = await import("./hook-version.js");
			const orphan = mkdtempSync(join(tmpdir(), "hv-orphan-"));
			try {
				const url = pathToFileURL(join(orphan, "dist", "index.js")).href;
				expect(resolveOwnVersionFrom(url)).toBe("0.0.0");
			} finally {
				rmSync(orphan, { recursive: true, force: true });
			}
		});
	});

	it("the source tree keeps ONE version implementation", () => {
		// The duplicate is what allowed dev and shipped behavior to disagree.
		// Comment lines are excluded deliberately: the module documents the old
		// expression so the next reader knows why it must not come back, and a
		// naive whole-file match would flag that explanation as the defect.
		const code = readFileSync(join(REPO_ROOT, "src", "lib", "hooks.ts"), "utf-8")
			.split("\n")
			.filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
			.join("\n");
		expect(code).not.toMatch(/new URL\(\s*["']\.\.\/\.\.\/package\.json["']/);
	});
});
