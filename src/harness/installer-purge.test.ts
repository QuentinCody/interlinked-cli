// installer-purge — the idempotent purge cluster extracted from installer.ts.
//
// The behavior under test beyond the pure extraction: `purgePriorEntries`
// walks the FRAGMENT's keys, so an event the installer USED to register and no
// longer does was never visited and its stale Interlinked entries survived
// every later install. `sweepUndeclaredKeys` closes that, using the SAME
// verdict so a user-scope install still spares another repo's hooks.
//
// `PostToolUseFailure` is the live instance: it was removed from the Claude
// Code adapter's registered events to stop the runner reporting "2 PostToolUse
// hooks ran", but the old registration stayed in `.claude/settings.json`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { parseWire, wireArray, wireObject, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { installHooks } from "./installer.js";
import {
	cleanProjectOwnedHooks,
	makePurgeVerdict,
	type PurgeReport,
	purgePriorEntries,
	SCOPE_USER,
} from "./installer-purge.js";

const PROJECT_ROOT = "/repo/proj";
const OWN_BINARY = `${PROJECT_ROOT}/dist/hook-entry.js`;
const FOREIGN_BINARY = "/other/repo/dist/hook-entry.js";

/** A Claude-Code-shaped hook-array entry. */
function entry(command: string): JsonObject {
	return { matcher: "", hooks: [{ type: "command", command }] };
}

function hookCommand(binary: string, event: string): string {
	return `if test -f '${binary}' ; then node '${binary}' --runner 'claude-code' --event '${event}' ; fi`;
}

/** A fragment that declares PreToolUse only — i.e. `PostToolUseFailure` is an
 *  event this installer no longer registers. */
function fragmentDeclaringPreToolUseOnly(): JsonObject {
	return { hooks: { PreToolUse: [entry(hookCommand(OWN_BINARY, "PreToolUse"))] } };
}

function freshReport(): PurgeReport {
	return { removed: 0, foreign: 0 };
}

function hooksOf(base: JsonObject): Record<string, unknown> {
	if (!isJsonObject(base.hooks)) throw new Error("expected hook settings object");
	return base.hooks;
}

describe("purgePriorEntries — undeclared-event sweep — positive (must fire)", () => {
	it.each(["PreToolUse", "PostToolUseFailure"])("preserves foreign siblings and matcher metadata while purging %s", event => {
		const owned = { type: "command", command: hookCommand(OWN_BINARY, event) };
		const foreign = { type: "command", command: hookCommand(FOREIGN_BINARY, event), timeout: 42 };
		const custom = { type: "mcp_tool", server: "user-server", tool: "record" };
		const group = { matcher: "Bash", description: "custom matcher group", hooks: [owned, foreign, custom] };
		const base: JsonObject = { hooks: { [event]: [group] } }, report = freshReport();
		purgePriorEntries(base, fragmentDeclaringPreToolUseOnly(), makePurgeVerdict(SCOPE_USER, PROJECT_ROOT), report);
		expect(hooksOf(base)[event]).toEqual([{ ...group, hooks: [foreign, custom] }]);
		expect(report).toEqual({ removed: 1, foreign: 1 });
	});

	it("P1: removes an Interlinked entry under an event the fragment no longer declares, and deletes the emptied key", () => {
		const base: JsonObject = {
			hooks: {
				PreToolUse: [],
				PostToolUseFailure: [entry(hookCommand(OWN_BINARY, "PostToolUseFailure"))],
			},
		};
		const report = freshReport();

		purgePriorEntries(
			base,
			fragmentDeclaringPreToolUseOnly(),
			makePurgeVerdict("project", PROJECT_ROOT),
			report,
		);

		// Pre-fix this key was never visited, so the stale entry survived and
		// `removed` stayed 0.
		expect(hooksOf(base)).not.toHaveProperty("PostToolUseFailure");
		expect(report.removed).toBe(1);
		expect(report.foreign).toBe(0);
	});

	it("P2: at user scope another project's Interlinked entry under an undeclared event is KEPT and counted foreign", () => {
		const foreign = entry(hookCommand(FOREIGN_BINARY, "PostToolUseFailure"));
		const base: JsonObject = { hooks: { PostToolUseFailure: [foreign] } };
		const report = freshReport();

		purgePriorEntries(
			base,
			fragmentDeclaringPreToolUseOnly(),
			makePurgeVerdict(SCOPE_USER, PROJECT_ROOT),
			report,
		);

		// The verdict is the SAME one the declared-key path uses, so user scope
		// still spares another repo's hooks instead of silently uninstalling them.
		expect(hooksOf(base).PostToolUseFailure).toEqual([foreign]);
		expect(report.foreign).toBe(1);
		expect(report.removed).toBe(0);
	});

	it("P3: keeps the key with the survivors when only some entries under an undeclared event are ours", () => {
		const thirdParty = entry("echo third-party-hook");
		const base: JsonObject = {
			hooks: {
				PostToolUseFailure: [entry(hookCommand(OWN_BINARY, "PostToolUseFailure")), thirdParty],
			},
		};
		const report = freshReport();

		purgePriorEntries(
			base,
			fragmentDeclaringPreToolUseOnly(),
			makePurgeVerdict("project", PROJECT_ROOT),
			report,
		);

		expect(hooksOf(base).PostToolUseFailure).toEqual([thirdParty]);
		expect(report.removed).toBe(1);
	});
});

describe("purgePriorEntries — undeclared-event sweep — negative (must not fire)", () => {
	it("N1: leaves a FOREIGN (non-Interlinked) hook under an undeclared event untouched", () => {
		const thirdParty = entry("echo third-party-hook");
		const base: JsonObject = { hooks: { PostToolUseFailure: [thirdParty] } };
		const report = freshReport();

		purgePriorEntries(
			base,
			fragmentDeclaringPreToolUseOnly(),
			makePurgeVerdict("project", PROJECT_ROOT),
			report,
		);

		expect(hooksOf(base).PostToolUseFailure).toEqual([thirdParty]);
		expect(report.removed).toBe(0);
		expect(report.foreign).toBe(0);
	});

	it("N2: an event the fragment STILL declares behaves exactly as before the sweep landed", () => {
		const thirdParty = entry("echo third-party-hook");
		const base: JsonObject = {
			hooks: { PreToolUse: [entry(hookCommand(OWN_BINARY, "PreToolUse")), thirdParty] },
		};
		const report = freshReport();

		purgePriorEntries(
			base,
			fragmentDeclaringPreToolUseOnly(),
			makePurgeVerdict("project", PROJECT_ROOT),
			report,
		);

		// Declared key: ours dropped, third party kept, key retained (never
		// deleted, because the fragment is about to append into it).
		expect(hooksOf(base).PreToolUse).toEqual([thirdParty]);
		expect(report.removed).toBe(1);
	});

	it("N3: ignores an undeclared key whose value is not an array", () => {
		const base: JsonObject = { hooks: { SomeMalformedKey: "not-an-array" } };
		const report = freshReport();

		purgePriorEntries(
			base,
			fragmentDeclaringPreToolUseOnly(),
			makePurgeVerdict("project", PROJECT_ROOT),
			report,
		);

		expect(hooksOf(base)).toEqual({ SomeMalformedKey: "not-an-array" });
		expect(report.removed).toBe(0);
	});
});

describe("makePurgeVerdict — scope semantics", () => {
	it("uses exact recorded binary invocations without claiming other binaries or textual mentions", () => {
		const globalBinary = "/opt/interlinked/dist/hook-entry.js";
		const verdict = makePurgeVerdict(SCOPE_USER, PROJECT_ROOT, globalBinary);
		expect(verdict(entry(hookCommand(globalBinary, "PreToolUse")))).toBe("remove");
		expect(verdict(entry(hookCommand(FOREIGN_BINARY, "PreToolUse")))).toBe("foreign");
		expect(verdict(entry(`echo node '${globalBinary}' --runner codex --event Stop`))).toBe("keep");
		expect(makePurgeVerdict(SCOPE_USER, PROJECT_ROOT)(entry(hookCommand(globalBinary, "PreToolUse")))).toBe("foreign");
	});

	it("P4: project scope removes every Interlinked entry regardless of owning project", () => {
		const verdict = makePurgeVerdict("project", PROJECT_ROOT);
		expect(verdict(entry(hookCommand(FOREIGN_BINARY, "PreToolUse")))).toBe("remove");
	});

	it("N4: user scope keeps a non-Interlinked entry rather than calling it foreign", () => {
		const verdict = makePurgeVerdict(SCOPE_USER, PROJECT_ROOT);
		expect(verdict(entry("echo unrelated"))).toBe("keep");
	});
});

describe("cleanProjectOwnedHooks — file-level cleanup", () => {
	let tmp = "";
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-purge-"));
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it("persists a partial matcher-group cleanup and leaves dry runs byte-identical", () => {
		const path = join(tmp, "settings.json");
		const foreign = { type: "command", command: "echo user-owned", timeout: 20 };
		const group = { matcher: "Bash", hooks: [{ type: "command", command: hookCommand(OWN_BINARY, "PreToolUse") }, foreign] };
		const before = JSON.stringify({ hooks: { PreToolUse: [group] } });
		writeFileSync(path, before);
		expect(cleanProjectOwnedHooks(path, makePurgeVerdict("project", PROJECT_ROOT), true)).toBe(1);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(cleanProjectOwnedHooks(path, makePurgeVerdict("project", PROJECT_ROOT), false)).toBe(1);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hooks: { PreToolUse: [{ ...group, hooks: [foreign] }] } });
		expect(cleanProjectOwnedHooks(path, makePurgeVerdict("project", PROJECT_ROOT), false)).toBe(0);
	});

	it("P5: removes this project's entries and deletes the emptied event key", () => {
		const settingsPath = join(tmp, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				hooks: {
					PreToolUse: [entry(hookCommand(OWN_BINARY, "PreToolUse"))],
					PostToolUseFailure: [entry("echo third-party-hook")],
				},
			}),
		);

		const removed = cleanProjectOwnedHooks(
			settingsPath,
			makePurgeVerdict(SCOPE_USER, PROJECT_ROOT),
			false,
		);

		expect(removed).toBe(1);
		const after = parseWire(JSON.parse(readFileSync(settingsPath, "utf-8")), wireObject({ hooks: wireRecord(wireUnknown) }), "purged hook settings");
		expect(after.hooks).not.toHaveProperty("PreToolUse");
		expect(after.hooks).toHaveProperty("PostToolUseFailure");
	});

	it("N5: returns 0 for a settings file that does not exist", () => {
		expect(
			cleanProjectOwnedHooks(
				join(tmp, "missing.json"),
				makePurgeVerdict("project", PROJECT_ROOT),
				false,
			),
		).toBe(0);
	});
});

describe("installHooks — the live PostToolUseFailure double-count", () => {
	let tmp = "";
	let homeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-purge-e2e-"));
		homeDir = mkdtempSync(join(tmpdir(), "interlinked-purge-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDir;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tmp, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("P6: an install drops a stale PostToolUseFailure registration the adapter no longer declares", () => {
		const binaryPath = join(tmp, "dist", "hook-entry.js");
		const settingsPath = join(tmp, ".claude", "settings.json");
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(
			settingsPath,
			JSON.stringify({
				hooks: {
					PostToolUseFailure: [entry(hookCommand(binaryPath, "PostToolUseFailure"))],
				},
			}),
		);

		const result = installHooks({ cwd: tmp, binaryPath, runners: ["claude-code"] });

		const after = parseWire(JSON.parse(readFileSync(settingsPath, "utf-8")), wireObject({ hooks: wireRecord(wireArray(wireUnknown)) }), "installed hook settings");
		// Pre-fix the stale key survived every install, so the runner kept
		// reporting "2 PostToolUse hooks ran".
		expect(after.hooks).not.toHaveProperty("PostToolUseFailure");
		expect(after.hooks.PostToolUse).toHaveLength(1);
		expect(result.purged).toBe(1);
	});
});
