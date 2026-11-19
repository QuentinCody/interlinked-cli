import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInstallCommands } from "../package-install-parser.js";
import type { HarnessEvent } from "../types.js";
import {
	__resetLockfileBaselineForTesting,
	collectLockfileInstallWarnings,
	recordLockfileBaseline,
} from "./lockfile-install-check.js";

const SESSION = "sess-kill-1";
const INSTALL = "npm install --save-exact koffi@3.3.2";

let project: string;

beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), "lockfile-install-kill-"));
	__resetLockfileBaselineForTesting();
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
	__resetLockfileBaselineForTesting();
});

const GOOD = JSON.stringify({
	name: "p",
	lockfileVersion: 3,
	packages: { "": { name: "p" }, "node_modules/left-pad": { version: "1.3.0" } },
});

const event: () => HarnessEvent = () => ({
	hook_event: "PostToolUse",
	session_id: SESSION,
	agent_source: "claude",
	tool_name: "Bash",
	tool_input: { command: INSTALL },
	timestamp: "2026-10-04T00:00:00Z",
	cwd: project,
});

describe("lockfile-install-check mutation-kill", () => {
	// test-contract: bug — a pre-install lockfile that does not parse yields NOT MEASURED, never a silent clean
	it("reports NOT MEASURED when the lockfile before the install was unparseable", () => {
		const lockPath = join(project, "package-lock.json");
		writeFileSync(lockPath, "{ broken");
		recordLockfileBaseline(SESSION, project, parseInstallCommands(INSTALL));
		writeFileSync(lockPath, GOOD);
		const warnings = collectLockfileInstallWarnings(event());
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("NOT MEASURED (lockfile_transitive_deps)");
		expect(warnings[0]).toContain("package-lock.json could not be parsed before the install");
	});
});
