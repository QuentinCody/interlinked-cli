// ===========================================
// doctor — drift-aware installed-hook verification (review 2026-08-30)
// ===========================================
// Doctor's old hook check only asked "does any Interlinked-looking command
// exist", so a stale or half-broken install passed. This check runs the SAME
// semantic verifier the refresh command uses over every manifest entry.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooks, manifestPath } from "../harness/installer.js";
import { clientHookResult, installedHookDriftChecks } from "./doctor-install-drift.js";

let cwd: string;
let binary: string;

function workingHookSource(): string {
	return "#!/usr/bin/env node\n" +
		"if (process.argv.includes('--runner=__interlinked_bootstrap_probe__')) {\n" +
		"  process.stderr.write('[interlinked] unknown runner id: __interlinked_bootstrap_probe__\\n');\n" +
		"}\n";
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "il-doctor-drift-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	binary = join(cwd, "hook-entry.js");
	writeFileSync(binary, workingHookSource());
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("installedHookDriftChecks", () => {
	// test-contract: public-api — a healthy manifest-tracked install passes.
	it("P1: a fresh install reports pass for its runner", () => {
		installHooks({ cwd, binaryPath: binary, runners: ["gemini-cli"], scope: "project" });
		const rows = installedHookDriftChecks(cwd, binary);
		expect(rows).toEqual([
			expect.objectContaining({ name: "gemini-cli install drift", status: "pass" }),
		]);
	});

	// test-contract: bug — a stale install (old binary in the settings) warns
	// and steers to the SAFE repair command.
	it("P2: a stale binary warns and names the refresh command", () => {
		const oldBinary = join(cwd, "old-hook.js");
		// interlinked: defer write_without_mkdir -- beforeEach creates cwd.
		writeFileSync(oldBinary, workingHookSource());
		installHooks({ cwd, binaryPath: oldBinary, runners: ["gemini-cli"], scope: "project" });
		const rows = installedHookDriftChecks(cwd, binary);
		expect(rows[0]?.status).toBe("warn");
		expect(rows[0]?.message).toContain("install-hooks --refresh --preserve-mode");
	});

	// test-contract: invariant — a corrupt manifest makes repair/uninstall
	// unsafe and therefore fails doctor rather than returning a successful exit.
	it("P3: a corrupt manifest reports a fail row", () => {
		writeFileSync(manifestPath(cwd), "{ nope");
		const rows = installedHookDriftChecks(cwd, binary);
		expect(rows).toEqual([
			expect.objectContaining({
				name: "Installer manifest",
				status: "fail",
				message: expect.stringContaining("restore a trusted installer-manifest.json backup"),
			}),
		]);
		expect(rows[0]?.message).not.toContain("remove");
	});

	// test-contract: boundary — no manifest, no rows: never-installed repos
	// must not see drift warnings.
	it("N1: a missing manifest yields no rows", () => {
		expect(installedHookDriftChecks(cwd, binary)).toEqual([]);
	});

	// test-contract: bug — settings and manifest presence are not a working
	// install when the command's executable artifact was deleted by a build.
	it("N2: a missing installed hook binary is a doctor failure", () => {
		installHooks({ cwd, binaryPath: binary, runners: ["gemini-cli"], scope: "project" });
		rmSync(binary);
		const rows = installedHookDriftChecks(cwd, binary);
		expect(rows).toEqual([
			expect.objectContaining({
				name: "gemini-cli install drift",
				status: "fail",
				message: expect.stringContaining("hook binary missing"),
			}),
		]);
	});

	// test-contract: bug — an empty JavaScript file makes `node file.js` exit
	// zero, but it executes no hook and therefore must never verify as healthy.
	it("N3: an empty installed hook binary is a doctor failure", () => {
		installHooks({ cwd, binaryPath: binary, runners: ["gemini-cli"], scope: "project" });
		writeFileSync(binary, "");
		const rows = installedHookDriftChecks(cwd, binary);
		expect(rows[0]).toEqual(
			expect.objectContaining({
				status: "fail",
				message: expect.stringContaining("hook binary is empty"),
			}),
		);
	});

	// test-contract: bug — a shebang-only file exits zero when Node runs it,
	// but initializes no hook runtime and must not pass doctor.
	it("N4: a shebang-only installed hook binary fails its runtime self-check", () => {
		installHooks({ cwd, binaryPath: binary, runners: ["gemini-cli"], scope: "project" });
		writeFileSync(binary, "#!/usr/bin/env node\n");
		const rows = installedHookDriftChecks(cwd, binary);
		expect(rows[0]).toEqual(
			expect.objectContaining({
				status: "fail",
				message: expect.stringContaining("hook binary self-check failed"),
			}),
		);
	});
});

describe("clientHookResult", () => {
	// test-contract: public-api — a real installed document passes via the
	// parsed ownership walk.
	it("P4: a settings document with an owned invocation reports pass", () => {
		const doc = JSON.stringify({
			hooks: { PreToolUse: [{ command: `node '${binary}' --runner 'claude-code' --event 'PreToolUse'` }] },
		});
		expect(clientHookResult("claude", doc).status).toBe("pass");
	});

	// test-contract: security — review 2026-08-30 final pass: a raw JSON blob
	// that merely MENTIONS the entry script is not an invocation, and
	// unparseable settings never pass.
	it("N2: mentions and unparseable content warn", () => {
		const mention = JSON.stringify({ hooks: { PreToolUse: [{ command: "echo node /repo/dist/hook-entry.js" }] } });
		expect(clientHookResult("claude", mention).status).toBe("warn");
		expect(clientHookResult("claude", "{ not json").status).toBe("warn");
	});

	// test-contract: public-api — a managed provider bridge file (marker-led
	// content, never JSON) short-circuits the settings parse entirely and
	// reports pass without even attempting `JSON.parse`.
	it("P5: a managed provider bridge file reports pass without parsing", () => {
		const doc = "// interlinked-provider-bridge:v1\nnot json at all {{{";
		expect(clientHookResult("gemini-cli", doc)).toEqual(
			expect.objectContaining({ name: "gemini-cli hooks", status: "pass", message: "Provider bridge installed" }),
		);
	});
});
