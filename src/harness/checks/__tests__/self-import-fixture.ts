import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * A throwaway project that CLAIMS every file under its root — the home of the
 * bare-name cases in the self-import suites (`checkSelfImport(src, at("widget.ts"))`).
 *
 * Session review r4, finding 3 (2026-09-05): the check no longer GUESSES a
 * project for a file no tsconfig claims — an orphan is NOT MEASURED (null /
 * false), never resolved under the nearest config's options. A bare
 * "widget.ts" resolves against the process cwd, where this repo's tsconfig
 * includes only `src`, so a bare-name case must run under a project whose
 * `include` claims the whole root. The importer itself is never written (the
 * check runs before the bytes land); only its directory must exist. Bundler
 * resolution is what `self-import-scan.resolution.test.ts` proves the verdict
 * table against. JS-family importers are members by pattern even without
 * `allowJs` (`self-import-project.ts`, `membershipExtensions`), so a `.js`
 * verdict here is measured, not an orphan's silence.
 *
 * Registers the root's removal with `afterAll`, so call it at a test file's
 * module scope. Returns the path builder for files at the root.
 */
export function claimingProjectRoot(): (name: string) => string {
	const root = mkdtempSync(join(tmpdir(), "self-import-claiming-"));
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { module: "ESNext", moduleResolution: "bundler" },
			include: ["**/*"],
		}),
	);
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	return (name) => join(root, name);
}
