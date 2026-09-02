// installer-reconcile — post-per-adapter reconciliation extracted from
// installHooks() in installer.ts (2026-09-02, cyclomatic-cap decompose:
// installHooks was CC 19, over the 16 cap). Pure mechanism; the "why" for
// each step lives on the exported functions and at installHooks' call site.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter, type InstallerManifestEntry, type RunnerAdapter } from "./adapters/index.js";
import { resolveSettingsPath } from "./installer-merge-engine.js";
import { makePurgeVerdict } from "./installer-purge.js";
import { managedProviderFileHash } from "./managed-provider-file.js";
import {
	buildManifestUpdate,
	cleanCrossScopeArtifacts,
	cleanPriorArtifact,
	cleanStaleInstalls,
	cleanUserScopeArtifact,
	collectPostInstallFailures,
	computeReplacementSets,
} from "./installer-reconcile.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-installer-reconcile-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function manifestEntry(overrides: Partial<InstallerManifestEntry> = {}): InstallerManifestEntry {
	return {
		runner: "claude-code",
		scope: "project",
		settings_path: join(dir, ".claude", "settings.json"),
		added_paths: ["hooks.PreToolUse"],
		binary_path: join(dir, "dist", "hook-entry.js"),
		installed_at: "2026-09-01T00:00:00.000Z",
		post_install: "ok",
		schema_version: "1",
		...overrides,
	};
}

/** The claude-code adapter is registered unconditionally by `buildAllAdapters`;
 *  a missing lookup here means the adapter registry itself is broken, which
 *  every other installer test would also fail on. */
function claudeCodeAdapter(): RunnerAdapter {
	const adapter = getAdapter("claude-code");
	return adapter ?? failMissingAdapter();
}

function failMissingAdapter(): never {
	throw new Error("claude-code adapter must be registered");
}

function writeHookOwnedSettings(target: string, binary: string): void {
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(
		target,
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "",
						hooks: [
							{
								type: "command",
								command: `if test -f '${binary}' ; then node '${binary}' --runner 'claude-code' --event 'PreToolUse' ; fi`,
							},
						],
					},
				],
			},
		}),
	);
}

describe("computeReplacementSets", () => {
	it("collects runner ids and settings paths only from successful (post_install ok) entries", () => {
		const entries = [
			manifestEntry({ runner: "claude-code", settings_path: join(dir, "a.json"), post_install: "ok" }),
			manifestEntry({ runner: "codex", settings_path: join(dir, "b.json"), post_install: "failed" }),
		];
		const { replacedIds, newFiles } = computeReplacementSets(entries);
		expect(replacedIds.has("claude-code")).toBe(true);
		expect(replacedIds.has("codex")).toBe(false);
		expect(newFiles.has(join(dir, "a.json"))).toBe(true);
		expect(newFiles.has(join(dir, "b.json"))).toBe(false);
	});

	it("returns empty sets when no entries were passed", () => {
		const { replacedIds, newFiles } = computeReplacementSets([]);
		expect(replacedIds.size).toBe(0);
		expect(newFiles.size).toBe(0);
	});
});

describe("cleanPriorArtifact", () => {
	it("removes an Interlinked-owned hook entry from a JSON settings file and returns the count", () => {
		const target = join(dir, "settings.json");
		const binary = join(dir, "dist", "hook-entry.js");
		writeHookOwnedSettings(target, binary);
		const entry = manifestEntry({ settings_path: target, binary_path: binary });

		const removed = cleanPriorArtifact(entry, dir, false);

		expect(removed).toBe(1);
		const after = JSON.parse(readFileSync(target, "utf-8"));
		expect(after.hooks).toBeUndefined();
	});

	it("dryRun leaves the file untouched", () => {
		const target = join(dir, "settings.json");
		const binary = join(dir, "dist", "hook-entry.js");
		writeHookOwnedSettings(target, binary);
		const original = readFileSync(target, "utf-8");
		const entry = manifestEntry({ settings_path: target, binary_path: binary });

		cleanPriorArtifact(entry, dir, true);

		expect(readFileSync(target, "utf-8")).toBe(original);
	});

	it("routes a managed-file entry through removeManagedProviderFile instead of hook-array purge", () => {
		const target = join(dir, "provider-bridge.js");
		const content = "// interlinked-provider-bridge:v1\nmodule.exports = {};\n";
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
		const entry = manifestEntry({
			settings_path: target,
			artifact_kind: "managed-file",
			artifact_sha256: managedProviderFileHash(content),
		});

		const removed = cleanPriorArtifact(entry, dir, false);

		expect(removed).toBe(1);
		expect(() => readFileSync(target, "utf-8")).toThrow();
	});
});

describe("cleanStaleInstalls", () => {
	it("cleans a replaced runner's prior settings file only when it differs from the new one", () => {
		const staleTarget = join(dir, "stale-settings.json");
		const newTarget = join(dir, "new-settings.json");
		const binary = join(dir, "dist", "hook-entry.js");
		writeHookOwnedSettings(staleTarget, binary);
		const priorManifest = [manifestEntry({ runner: "claude-code", settings_path: staleTarget, binary_path: binary })];
		const replacedIds = new Set<InstallerManifestEntry["runner"]>(["claude-code"]);
		const newFiles = new Set<string>([newTarget]);

		const orphansCleaned = cleanStaleInstalls(priorManifest, replacedIds, newFiles, dir, false);

		expect(orphansCleaned).toEqual([staleTarget]);
	});

	it("skips a prior runner whose new file is the same as its old one", () => {
		const target = join(dir, "settings.json");
		const priorManifest = [manifestEntry({ runner: "claude-code", settings_path: target })];
		const replacedIds = new Set<InstallerManifestEntry["runner"]>(["claude-code"]);
		const newFiles = new Set<string>([target]);

		const orphansCleaned = cleanStaleInstalls(priorManifest, replacedIds, newFiles, dir, false);

		expect(orphansCleaned).toEqual([]);
	});

	it("skips a prior runner that was not replaced this run", () => {
		const target = join(dir, "settings.json");
		const priorManifest = [manifestEntry({ runner: "codex", settings_path: target })];
		const replacedIds = new Set<InstallerManifestEntry["runner"]>(["claude-code"]);
		const newFiles = new Set<string>([]);

		const orphansCleaned = cleanStaleInstalls(priorManifest, replacedIds, newFiles, dir, false);

		expect(orphansCleaned).toEqual([]);
	});
});

describe("cleanUserScopeArtifact", () => {
	it("falls back to hook-array purge when fileContent is undefined", () => {
		const target = join(dir, "settings.json");
		const binary = join(dir, "dist", "hook-entry.js");
		writeHookOwnedSettings(target, binary);
		const verdict = makePurgeVerdict("user", dir);

		const removed = cleanUserScopeArtifact(undefined, target, verdict, false);

		expect(removed).toBe(1);
	});

	it("removes an exact-match managed provider file when fileContent is given", () => {
		const target = join(dir, "provider-bridge.js");
		const content = "// interlinked-provider-bridge:v1\nmodule.exports = {};\n";
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
		const verdict = makePurgeVerdict("user", dir);

		const removed = cleanUserScopeArtifact(content, target, verdict, false);

		expect(removed).toBe(1);
	});

	it("preserves a managed provider file whose content differs from fileContent", () => {
		const target = join(dir, "provider-bridge.js");
		const onDisk = "// interlinked-provider-bridge:v1\nmodule.exports = { customized: true };\n";
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, onDisk);
		const verdict = makePurgeVerdict("user", dir);

		const removed = cleanUserScopeArtifact(
			"// interlinked-provider-bridge:v1\nmodule.exports = {};\n",
			target,
			verdict,
			false,
		);

		expect(removed).toBe(0);
		expect(readFileSync(target, "utf-8")).toBe(onDisk);
	});
});

describe("cleanCrossScopeArtifacts", () => {
	it("is a no-op at user scope", () => {
		const orphansCleaned: string[] = [];

		cleanCrossScopeArtifacts(
			"user",
			[claudeCodeAdapter()],
			new Set(["claude-code"]),
			new Set<string>(),
			join(dir, "dist", "hook-entry.js"),
			dir,
			false,
			orphansCleaned,
		);

		expect(orphansCleaned).toEqual([]);
	});

	it("removes a matching user-scope hook fragment for a replaced runner at project scope", () => {
		const adapter = claudeCodeAdapter();
		const binaryAbs = join(dir, "dist", "hook-entry.js");
		const userFragment = adapter.renderSettingsFragment(binaryAbs, "user");
		const userTarget = resolveSettingsPath(dir, userFragment.path);
		mkdirSync(dirname(userTarget), { recursive: true });
		writeFileSync(userTarget, JSON.stringify(userFragment.fragment));
		const orphansCleaned: string[] = [];

		cleanCrossScopeArtifacts(
			"project",
			[adapter],
			new Set(["claude-code"]),
			new Set<string>(),
			binaryAbs,
			dir,
			false,
			orphansCleaned,
		);

		expect(orphansCleaned).toEqual([userTarget]);
	});

	it("skips a selected adapter that was not replaced this run", () => {
		const orphansCleaned: string[] = [];

		cleanCrossScopeArtifacts(
			"project",
			[claudeCodeAdapter()],
			new Set<InstallerManifestEntry["runner"]>(),
			new Set<string>(),
			join(dir, "dist", "hook-entry.js"),
			dir,
			false,
			orphansCleaned,
		);

		expect(orphansCleaned).toEqual([]);
	});

	it("does not duplicate a target already present in orphansCleaned", () => {
		const adapter = claudeCodeAdapter();
		const binaryAbs = join(dir, "dist", "hook-entry.js");
		const userFragment = adapter.renderSettingsFragment(binaryAbs, "user");
		const userTarget = resolveSettingsPath(dir, userFragment.path);
		const orphansCleaned: string[] = [userTarget];

		cleanCrossScopeArtifacts(
			"project",
			[adapter],
			new Set(["claude-code"]),
			new Set<string>(),
			binaryAbs,
			dir,
			false,
			orphansCleaned,
		);

		expect(orphansCleaned).toEqual([userTarget]);
	});
});

describe("buildManifestUpdate", () => {
	it("retains prior entries for runners not replaced, and records ok entries", () => {
		const priorManifest = [
			manifestEntry({ runner: "claude-code" }),
			manifestEntry({ runner: "codex" }),
		];
		const entries = [manifestEntry({ runner: "codex", post_install: "ok" })];
		const replacedIds = new Set<InstallerManifestEntry["runner"]>(["codex"]);

		const { retained, recordableEntries } = buildManifestUpdate(priorManifest, entries, replacedIds);

		expect(retained.map((e) => e.runner)).toEqual(["claude-code"]);
		expect(recordableEntries.map((e) => e.runner)).toEqual(["codex"]);
	});

	it("records a first-time postInstall failure (no prior row) but drops a failed replacement of an existing row", () => {
		const priorManifest = [manifestEntry({ runner: "codex" })];
		const entries = [
			manifestEntry({ runner: "codex", post_install: "failed" }),
			manifestEntry({ runner: "opencode", post_install: "failed" }),
		];
		const replacedIds = new Set<InstallerManifestEntry["runner"]>();

		const { recordableEntries } = buildManifestUpdate(priorManifest, entries, replacedIds);

		expect(recordableEntries.map((e) => e.runner)).toEqual(["opencode"]);
	});
});

describe("collectPostInstallFailures", () => {
	it("maps failed entries to {runner, reason}, using the recorded error", () => {
		const entries = [
			manifestEntry({ runner: "codex", post_install: "failed", post_install_error: "boom" }),
			manifestEntry({ runner: "claude-code", post_install: "ok" }),
		];

		expect(collectPostInstallFailures(entries)).toEqual([{ runner: "codex", reason: "boom" }]);
	});

	it("falls back to a default reason when post_install_error is absent", () => {
		const entries = [manifestEntry({ runner: "codex", post_install: "failed" })];

		expect(collectPostInstallFailures(entries)).toEqual([{ runner: "codex", reason: "postInstall failed" }]);
	});

	it("returns an empty array when nothing failed", () => {
		expect(collectPostInstallFailures([manifestEntry({ post_install: "ok" })])).toEqual([]);
	});
});
