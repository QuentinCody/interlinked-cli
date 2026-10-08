// lockfile_transitive_deps — the PostToolUse half of the supply-chain gate.
// Hegel trial 2026-10-03 (hegel-trial.md §1.1): `npm install koffi@3.3.2`
// also landed `@koromix/koffi-darwin-arm64` (native, optional) with no
// allowlist entry and no block. These cases drive the PreToolUse snapshot +
// PostToolUse diff through a real temp project.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToAllowlist, hashLockfile, loadAllowlist, saveAllowlist } from "../package-allowlist.js";
import { parseInstallCommands } from "../package-install-parser.js";
import type { HarnessEvent } from "../types.js";
import {
	__resetLockfileBaselineForTesting,
	collectLockfileInstallWarnings,
	consumeLockfileBaseline,
	recordLockfileBaseline,
} from "./lockfile-install-check.js";

const SESSION = "sess-1";
const INSTALL = "npm install --save-exact koffi@3.3.2";

let project: string;

beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), "lockfile-install-check-"));
	__resetLockfileBaselineForTesting();
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
	__resetLockfileBaselineForTesting();
});

function lock(packages: Record<string, Record<string, unknown>>): string {
	return JSON.stringify({ name: "p", lockfileVersion: 3, packages: { "": { name: "p" }, ...packages } });
}

const BEFORE = lock({ "node_modules/left-pad": { version: "1.3.0" } });
const AFTER = lock({
	"node_modules/left-pad": { version: "1.3.0" },
	"node_modules/koffi": { version: "3.3.2", hasInstallScript: true },
	"node_modules/@koromix/koffi-darwin-arm64": { version: "3.3.2", os: ["darwin"], cpu: ["arm64"], optional: true },
});

function bashEvent(command: string, hook: "PreToolUse" | "PostToolUse" = "PostToolUse"): HarnessEvent {
	return {
		hook_event: hook,
		session_id: SESSION,
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-10-04T00:00:00Z",
		cwd: project,
	};
}

/** The real sequence: PreToolUse snapshot, the install rewrites the lockfile,
 *  PostToolUse diffs. */
function runInstall(command: string, before: string | null, after: string): string[] {
	if (before !== null) writeFileSync(join(project, "package-lock.json"), before);
	recordLockfileBaseline(SESSION, project, parseInstallCommands(command));
	writeFileSync(join(project, "package-lock.json"), after);
	return collectLockfileInstallWarnings(bashEvent(command));
}

describe("lockfile_transitive_deps — positive (must warn)", () => {
	it("P1: REPRODUCTION — the transitive native dep is named, NATIVE and first, even though koffi itself is approved", () => {
		addToAllowlist(project, "npm", "koffi", { approved_by: "qcody" });
		const warnings = runInstall(INSTALL, BEFORE, AFTER);
		expect(warnings).toHaveLength(1);
		const line = warnings[0] ?? "";
		expect(line).toMatch(/^\[interlinked:supply-chain\] \[proven\] this install added 1 package\(s\) to package-lock\.json/);
		expect(line).toContain("1 NATIVE");
		expect(line).toContain("@koromix/koffi-darwin-arm64@3.3.2 [NATIVE: platform package (os darwin, cpu arm64); optionalDependency]");
		expect(line).not.toContain("koffi@3.3.2 [");
		expect(line).toContain("interlinked allowlist add npm <name>");
		expect(line).toContain("allowlist snapshot --lockfile package-lock.json");
	});

	it("P2: an unapproved command-line package is reported too, with on-disk evidence merged in", () => {
		const pkgDir = join(project, "node_modules", "koffi");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "binding.gyp"), "{}");
		const line = runInstall(INSTALL, BEFORE, AFTER)[0] ?? "";
		expect(line).toContain("added 2 package(s)");
		expect(line).toContain("2 NATIVE");
		expect(line).toContain("koffi@3.3.2 [NATIVE: install script; binding.gyp]");
	});

	it("P3: a fresh install that CREATES the lockfile diffs against the empty set", () => {
		const line = runInstall(INSTALL, null, AFTER)[0] ?? "";
		expect(line).toContain("added 3 package(s)");
		expect(line).toContain("left-pad@1.3.0");
	});

	it("P4: NOT MEASURED when PostToolUse arrives with no PreToolUse snapshot (daemon restart)", () => {
		writeFileSync(join(project, "package-lock.json"), AFTER);
		const warnings = collectLockfileInstallWarnings(bashEvent(INSTALL));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("NOT MEASURED (lockfile_transitive_deps)");
		expect(warnings[0]).toContain("no pre-install snapshot");
		expect(warnings[0]).not.toContain("[proven]");
	});

	it("P5: NOT MEASURED when the post-install lockfile does not parse", () => {
		const warnings = runInstall(INSTALL, BEFORE, "{ broken");
		expect(warnings[0]).toContain("NOT MEASURED");
		expect(warnings[0]).toContain("could not be parsed after the install");
	});

	it("P6: a `cd sub && npm install` diffs the lockfile in the sub dir", () => {
		const sub = join(project, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "package-lock.json"), BEFORE);
		const command = "cd sub && npm install koffi@3.3.2";
		recordLockfileBaseline(SESSION, project, parseInstallCommands(command));
		writeFileSync(join(sub, "package-lock.json"), AFTER);
		const line = collectLockfileInstallWarnings(bashEvent(command))[0] ?? "";
		expect(line).toContain("@koromix/koffi-darwin-arm64@3.3.2");
	});
});

describe("lockfile_transitive_deps — negative (must stay silent)", () => {
	it("N1: every new package approved per-package ⇒ no warning", () => {
		addToAllowlist(project, "npm", "koffi", { approved_by: "qcody" });
		addToAllowlist(project, "npm", "@koromix/koffi-darwin-arm64", { approved_by: "qcody" });
		expect(runInstall(INSTALL, BEFORE, AFTER)).toEqual([]);
	});

	it("N2: a lockfile snapshot grant covering the NEW lockfile approves the resolved set", () => {
		writeFileSync(join(project, "package-lock.json"), BEFORE);
		recordLockfileBaseline(SESSION, project, parseInstallCommands(INSTALL));
		writeFileSync(join(project, "package-lock.json"), AFTER);
		const al = loadAllowlist(project);
		al.lockfile_snapshots["package-lock.json"] = {
			sha256: hashLockfile(join(project, "package-lock.json")) ?? "",
			approved_at: "2026-10-04T00:00:00Z",
			approved_by: "qcody",
		};
		saveAllowlist(project, al);
		expect(collectLockfileInstallWarnings(bashEvent(INSTALL))).toEqual([]);
	});

	it("N3: an install that changes nothing (lockfile identical) ⇒ no warning", () => {
		expect(runInstall(INSTALL, AFTER, AFTER)).toEqual([]);
	});

	it("N4: a non-install Bash command and a non-npm install are ignored", () => {
		writeFileSync(join(project, "package-lock.json"), AFTER);
		expect(collectLockfileInstallWarnings(bashEvent("git status"))).toEqual([]);
		expect(collectLockfileInstallWarnings(bashEvent("pip install requests==2.32.0"))).toEqual([]);
	});

	it("N5: no lockfile before OR after ⇒ nothing to diff, no NOT MEASURED noise", () => {
		recordLockfileBaseline(SESSION, project, parseInstallCommands(INSTALL));
		expect(collectLockfileInstallWarnings(bashEvent(INSTALL))).toEqual([]);
	});

	it("N6: the snapshot is consumed once (delete-on-read) and is keyed per session", () => {
		writeFileSync(join(project, "package-lock.json"), BEFORE);
		recordLockfileBaseline(SESSION, project, parseInstallCommands(INSTALL));
		expect(consumeLockfileBaseline("other-session", project).found).toBe(false);
		expect(consumeLockfileBaseline(SESSION, project).found).toBe(true);
		expect(consumeLockfileBaseline(SESSION, project).found).toBe(false);
	});
});
