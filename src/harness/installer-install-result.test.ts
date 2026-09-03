// Companion test for the install-path module split out of installer.ts
// (2026-09-02, line-cap decompose). installer.test.ts continues to exercise
// this behavior through installer.ts's re-export; this file pins the new
// module's own exports directly so it is not left untested at its own path.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { installHooks, manifestPath } from "./installer-install-result.js";
import { readManifest } from "./installer-manifest.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-ins-result-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("manifestPath", () => {
	it("resolves to .interlinked/installer-manifest.json under cwd", () => {
		expect(manifestPath(tmp)).toBe(join(tmp, ".interlinked", "installer-manifest.json"));
	});
});

describe("installHooks", () => {
	it("writes Claude Code hook settings + manifest, returning entries", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
			scope: "project",
		});
		expect(result.ok).toBe(true);
		expect(result.entries.length).toBe(1);
		expect(nonNull(result.entries[0]).runner).toBe("claude-code");
		expect(result.manifest_path).toBe(manifestPath(tmp));

		const claudeSettings = JSON.parse(
			readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"),
		) as { hooks: Record<string, unknown[]> };
		expect(Array.isArray(claudeSettings.hooks.PreToolUse)).toBe(true);

		const manifest = readManifest(manifestPath(tmp));
		expect(manifest.length).toBe(1);
		expect(nonNull(manifest[0]).added_paths.length).toBeGreaterThan(0);
	});

	it("supports dry-run (does not write files or the manifest)", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: ["claude-code"],
			dryRun: true,
		});
		expect(result.entries.length).toBe(1);
		expect(readManifest(manifestPath(tmp))).toEqual([]);
	});

	it("throws on a corrupt existing manifest rather than overwriting it", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(manifestPath(tmp), "not json", "utf-8");
		expect(() =>
			installHooks({
				cwd: tmp,
				binaryPath: "/usr/bin/interlinked-hook",
				runners: ["claude-code"],
			}),
		).toThrow(/corrupt/);
	});

	it("selects every known runner when `runners` is empty", () => {
		const result = installHooks({
			cwd: tmp,
			binaryPath: "/usr/bin/interlinked-hook",
			runners: [],
		});
		expect(result.entries.length + result.skipped.length).toBeGreaterThan(1);
	});
});
