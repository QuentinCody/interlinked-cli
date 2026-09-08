// installer idempotency — the B refactor's contract.
//
// Re-running an install, or installing after the legacy `.mjs` path, must
// converge to exactly one canonical Interlinked hook per event per runner —
// never stacking duplicates (the ~3-4x over-registration bug). A user-scope
// install must leave other projects' hooks in the shared settings file alone.
// Covers: run-twice, legacy→adapter, adapter→enable, project + user scope.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isInterlinkedHookEntry } from "../../lib/hook-ownership.js";
import { installAllHooks } from "../../lib/hooks.js";
import { nonNull } from "../../lib/non-null.js";
import { parseWire, wireAbsentOptional, wireArray, wireObject, wireRecord, wireString, wireUnknown } from "../../lib/value-validation.js";
import { installHooks } from "../installer.js";
import type { RunnerId } from "../unified-event.js";

let base = "";
let projectDir = "";
let homeDir = "";
let originalHome: string | undefined;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "interlinked-idem-"));
	projectDir = join(base, "project");
	homeDir = join(base, "home");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	originalHome = process.env.HOME;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry run
	// for any file whose graph-selected test scope includes this one. Every
	// call site in this file passes `cwd`/`projectDir` explicitly rather than
	// relying on the real OS cwd, so the spy (harmless here) just keeps
	// `process.cwd()` itself from drifting for any other code that reads it.
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
	// User-scope installs resolve `~/` via os.homedir(), which honours $HOME on
	// POSIX — point it at a temp dir so a test never touches the real ~/.claude.
	process.env.HOME = homeDir;
});

afterEach(() => {
	cwdSpy.mockRestore();
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	rmSync(base, { recursive: true, force: true });
});

const CLAUDE: RunnerId[] = ["claude-code"];
/** Absolute hook binary path inside the project — so a baked command reads as
 *  project-owned. Recomputed per call since `projectDir` is set in beforeEach. */
const projectBinary = (): string => join(projectDir, "dist", "hook-entry.js");
const claudeSettings = (root: string): string => join(root, ".claude", "settings.json");

interface HookFile {
	hooks?: Record<string, unknown>;
}
interface NestedHookEntry {
	hooks?: Array<{ command?: string }>;
}

function readHookFile(settingsPath: string): HookFile {
	if (!existsSync(settingsPath)) return {};
	return parseWire(JSON.parse(readFileSync(settingsPath, "utf-8")), wireObject<HookFile>({ hooks: wireAbsentOptional(wireRecord(wireUnknown)) }), "installed hook settings");
}

/** Count of Interlinked hook entries across every event array in a file. */
function interlinkedEntryCount(settingsPath: string): number {
	let count = 0;
	for (const arr of Object.values(readHookFile(settingsPath).hooks ?? {})) {
		if (Array.isArray(arr)) count += arr.filter(isInterlinkedHookEntry).length;
	}
	return count;
}

/** Largest number of Interlinked entries in any single event array. Idempotency
 *  means this is never above 1. */
function maxInterlinkedPerEvent(settingsPath: string): number {
	let max = 0;
	for (const arr of Object.values(readHookFile(settingsPath).hooks ?? {})) {
		if (!Array.isArray(arr)) continue;
		const n = arr.filter(isInterlinkedHookEntry).length;
		if (n > max) max = n;
	}
	return max;
}

/** The PreToolUse event array, typed for command inspection. */
function preToolUseEntries(settingsPath: string): NestedHookEntry[] {
	const arr = readHookFile(settingsPath).hooks?.PreToolUse;
	return Array.isArray(arr) ? parseWire(arr, wireArray(wireObject<NestedHookEntry>({ hooks: wireAbsentOptional(wireArray(wireObject({ command: wireAbsentOptional(wireString) }))) })), "PreToolUse hooks") : [];
}

describe("installer idempotency — run twice", () => {
	it("a second install converges to one entry per event, no duplicates", () => {
		const opts = { cwd: projectDir, binaryPath: projectBinary(), runners: CLAUDE };

		const first = installHooks(opts);
		const afterFirst = interlinkedEntryCount(claudeSettings(projectDir));
		expect(afterFirst).toBeGreaterThan(0);
		expect(first.purged).toBe(0);

		const second = installHooks(opts);
		expect(interlinkedEntryCount(claudeSettings(projectDir))).toBe(afterFirst);
		expect(maxInterlinkedPerEvent(claudeSettings(projectDir))).toBe(1);
		// The second run found and purged exactly the first run's entries.
		expect(second.purged).toBe(afterFirst);
	});
});

describe("installer idempotency — legacy then adapter", () => {
	it("purges a pre-existing legacy .mjs registration and inserts one adapter entry", () => {
		// A registration the old self-contained `.mjs` installer would have written.
		const legacyCommand =
			`HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"; HOOK_DIR="$PWD"; ` +
			`while :; do if test -f "$HOOK_DIR/$HOOK_SCRIPT_REL"; then ` +
			`node "$HOOK_DIR/$HOOK_SCRIPT_REL"; break; fi; done`;
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(
			claudeSettings(projectDir),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: legacyCommand }] }],
				},
			}),
		);

		installHooks({ cwd: projectDir, binaryPath: projectBinary(), runners: CLAUDE });

		const pre = preToolUseEntries(claudeSettings(projectDir));
		expect(pre.length).toBe(1);
		const command = nonNull(pre[0]).hooks?.[0]?.command ?? "";
		// The legacy `.mjs` entry is gone; the survivor is the adapter entry.
		expect(command).toContain("hook-entry.js");
		expect(command).not.toContain("interlinked-activity");
		expect(maxInterlinkedPerEvent(claudeSettings(projectDir))).toBe(1);
	});
});

describe("installer idempotency — adapter then enable", () => {
	it("installAllHooks (the re-pointed enable path) does not stack on an adapter install", () => {
		installHooks({ cwd: projectDir, binaryPath: projectBinary(), runners: CLAUDE });
		const afterAdapter = interlinkedEntryCount(claudeSettings(projectDir));
		expect(afterAdapter).toBeGreaterThan(0);

		// `enable` now routes through the adapter installer — running it after
		// an adapter install must converge, not duplicate.
		installAllHooks(projectDir, ["claude"]);
		expect(maxInterlinkedPerEvent(claudeSettings(projectDir))).toBe(1);
		expect(interlinkedEntryCount(claudeSettings(projectDir))).toBe(afterAdapter);

		// A second enable stays idempotent too.
		installAllHooks(projectDir, ["claude"]);
		expect(maxInterlinkedPerEvent(claudeSettings(projectDir))).toBe(1);
		expect(interlinkedEntryCount(claudeSettings(projectDir))).toBe(afterAdapter);
	});
});

describe("installer idempotency — project + user scope", () => {
	it("a user-scope install keeps another project's hooks and converges its own", () => {
		// Another repo already registered Interlinked hooks in the shared
		// user-scope settings file. Its command points outside this project.
		const foreignCommand =
			`if test -f '/other/repo/dist/hook-entry.js' ; then ` +
			`node '/other/repo/dist/hook-entry.js' --runner 'claude-code' --event 'PreToolUse' ; fi`;
		mkdirSync(join(homeDir, ".claude"), { recursive: true });
		writeFileSync(
			claudeSettings(homeDir),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: foreignCommand }] }],
				},
			}),
		);

		const userOpts = {
			cwd: projectDir,
			binaryPath: projectBinary(),
			runners: CLAUDE,
			scope: "user" as const,
		};
		const first = installHooks(userOpts);
		// The other repo's entry was recognised as Interlinked but left alone.
		expect(first.foreign).toBeGreaterThan(0);

		const userPre = preToolUseEntries(claudeSettings(homeDir));
		// PreToolUse now holds the foreign entry plus this project's one entry.
		expect(userPre.length).toBe(2);
		expect(userPre.some((e) => e.hooks?.[0]?.command?.includes("/other/repo/"))).toBe(true);

		// Re-running stays idempotent for this project and never drops the foreign entry.
		const second = installHooks(userOpts);
		expect(second.foreign).toBeGreaterThan(0);
		const userPre2 = preToolUseEntries(claudeSettings(homeDir));
		expect(userPre2.length).toBe(2);
		expect(userPre2.some((e) => e.hooks?.[0]?.command?.includes("/other/repo/"))).toBe(true);
	});

	it("switching scope project→user clears the stale project install", () => {
		const projOpts = { cwd: projectDir, binaryPath: projectBinary(), runners: CLAUDE };
		installHooks(projOpts);
		expect(interlinkedEntryCount(claudeSettings(projectDir))).toBeGreaterThan(0);

		// A subsequent user-scope install of the same runner supersedes it —
		// the orphan cleanup clears the project file so the harness is not
		// registered in both scopes and fired twice per tool call.
		installHooks({ ...projOpts, scope: "user" });
		expect(interlinkedEntryCount(claudeSettings(projectDir))).toBe(0);
		expect(interlinkedEntryCount(claudeSettings(homeDir))).toBeGreaterThan(0);
	});

	it("project-scope install clears stale same-project user hooks not in the manifest", () => {
		const staleAdapterCommand =
			`if test -f '${projectBinary()}' ; then ` +
			`node '${projectBinary()}' --runner 'claude-code' --event 'UserPromptSubmit' ; fi`;
		const staleLegacyCommand =
			`if test -f '${join(projectDir, ".interlinked", "hooks", "interlinked-activity.mjs")}' ; then ` +
			`node '${join(projectDir, ".interlinked", "hooks", "interlinked-activity.mjs")}' --runner 'claude-code' --event 'UserPromptSubmit' ; fi`;
		mkdirSync(join(homeDir, ".claude"), { recursive: true });
		writeFileSync(
			claudeSettings(homeDir),
			JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{ matcher: "", hooks: [{ type: "command", command: staleAdapterCommand }] },
						{ matcher: "", hooks: [{ type: "command", command: staleLegacyCommand }] },
					],
				},
			}),
		);

		const result = installHooks({ cwd: projectDir, binaryPath: projectBinary(), runners: CLAUDE });

		expect(result.orphans_cleaned).toContain(claudeSettings(homeDir));
		expect(interlinkedEntryCount(claudeSettings(homeDir))).toBe(0);
		expect(interlinkedEntryCount(claudeSettings(projectDir))).toBeGreaterThan(0);
		expect(maxInterlinkedPerEvent(claudeSettings(projectDir))).toBe(1);
	});
});

// The unbounded-growth regression (2026-08-08). Every idempotency test above
// bakes a binary INSIDE the project, which is why they all passed while a real
// machine's ~/.claude/settings.json grew to 2.1MB / 8,092 hook entries and
// Claude Code refused to read it — taking every setting in the file down with
// it, in every repo, not just the one that caused it.
//
// A user-scope install with an OUT-OF-PROJECT binary defeats both purge layers:
//   - the command carries no `<projectRoot>/`, so `isProjectOwnedHookEntry`
//     cannot attribute it and the entry is spared as another repo's;
//   - if the binary name also carries no Interlinked marker, the entry is not
//     even recognised as ours, so the verdict never gets a chance to fire.
// Either way the append that follows adds an identical copy, forever.
//
// `withoutIncomingDuplicates` closes both because it is marker- AND
// ownership-agnostic: an entry identical to the one being written is dropped
// before any verdict is consulted.
function totalEntries(settingsPath: string): number {
	let count = 0;
	for (const arr of Object.values(readHookFile(settingsPath).hooks ?? {})) {
		if (Array.isArray(arr)) count += arr.length;
	}
	return count;
}

describe("installer idempotency — user scope with an out-of-project binary", () => {
	/** A globally-installed binary: outside the project, but still marked as
	 *  ours by the `hook-entry.js` filename. Ownership cannot attribute it. */
	const globalMarkedBinary = (): string => join(base, "global", "dist", "hook-entry.js");
	/** A globally-installed binary carrying NO Interlinked marker at all — the
	 *  literal shape observed in the wild (`/usr/bin/ih-scope`). */
	const globalUnmarkedBinary = (): string => join(base, "global", "bin", "ih-scope");

	it("does not stack duplicates across repeated user-scope installs (marked binary)", () => {
		const opts = { cwd: projectDir, binaryPath: globalMarkedBinary(), runners: CLAUDE, scope: "user" as const };
		installHooks(opts);
		const afterFirst = totalEntries(claudeSettings(homeDir));
		expect(afterFirst).toBeGreaterThan(0);

		installHooks(opts);
		installHooks(opts);
		expect(totalEntries(claudeSettings(homeDir))).toBe(afterFirst);
		expect(maxInterlinkedPerEvent(claudeSettings(homeDir))).toBe(1);
	});

	it("does not stack duplicates when the binary carries no Interlinked marker", () => {
		const opts = {
			cwd: projectDir,
			binaryPath: globalUnmarkedBinary(),
			runners: CLAUDE,
			scope: "user" as const,
		};
		installHooks(opts);
		const afterFirst = totalEntries(claudeSettings(homeDir));
		expect(afterFirst).toBeGreaterThan(0);

		for (let i = 0; i < 5; i++) installHooks(opts);
		// Five more installs, still the original count. Before the fix this was
		// afterFirst * 6 — the growth curve that reached 8,092.
		expect(totalEntries(claudeSettings(homeDir))).toBe(afterFirst);
	});

	it("still spares a genuinely different repo's user-scope hooks", () => {
		// Each project records its own installation in its own manifest, even
		// though both installations share the user-scope settings file.
		const siblingProject = join(base, "other-repo");
		mkdirSync(siblingProject);
		const sibling = join(siblingProject, "dist", "hook-entry.js");
		expect(installHooks({ cwd: siblingProject, binaryPath: sibling, runners: CLAUDE, scope: "user" as const }).ok).toBe(true);
		const withSibling = totalEntries(claudeSettings(homeDir));
		const siblingEntries = preToolUseEntries(claudeSettings(homeDir));
		expect(siblingEntries).toHaveLength(1);

		const opts = { cwd: projectDir, binaryPath: globalMarkedBinary(), runners: CLAUDE, scope: "user" as const };
		expect(installHooks(opts).ok).toBe(true);
		const withBothProjects = totalEntries(claudeSettings(homeDir));
		expect(withBothProjects).toBeGreaterThan(withSibling);
		expect(preToolUseEntries(claudeSettings(homeDir))).toEqual(expect.arrayContaining(siblingEntries));

		expect(installHooks(opts).ok).toBe(true);
		expect(totalEntries(claudeSettings(homeDir))).toBe(withBothProjects);
		const repeatedEntries = preToolUseEntries(claudeSettings(homeDir));
		expect(repeatedEntries).toHaveLength(2);
		expect(repeatedEntries).toEqual(expect.arrayContaining(siblingEntries));
	});
});
