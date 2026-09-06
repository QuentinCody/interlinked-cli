// ===========================================
// install-hooks --refresh — snapshot/rollback/idempotency contract
// ===========================================
// Real filesystem (tmp cwd), real installHooks, real adapters: the refresh
// path exists to repair STALE installed hooks without touching enforcement
// mode, so these tests install real fragments, age them, and refresh. A
// second describe block exercises `reportRefresh` directly (json vs. human
// output, and the per-line branches for verifications/skipped/failures/
// rollback state) — its only other caller (install-hooks.ts) never drives
// those shapes, so this file is where they get proven.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHooks, manifestPath, readManifest } from "../harness/installer.js";
import { refreshInstalledHooks, reportRefresh } from "./install-hooks-refresh.js";

let cwd: string;
// The REAL bundled entry name: ownership is shape-parsed (2026-08-30), so a
// fixture binary must look like an actual Interlinked invocation target.
const BINARY = "/opt/interlinked/dist/hook-entry.js";
const NEW_BINARY = "/opt/interlinked/dist-v2/hook-entry.js";

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "il-refresh-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function installGemini(binary: string = BINARY): string {
	const result = installHooks({ cwd, binaryPath: binary, runners: ["gemini-cli"], scope: "project" });
	expect(result.ok).toBe(true);
	const settingsPath = result.entries[0]?.settings_path ?? "";
	expect(existsSync(settingsPath)).toBe(true);
	return settingsPath;
}

describe("refreshInstalledHooks — positive (must fire)", () => {
	// test-contract: public-api — the whole point of --refresh: an installed
	// entry rendered by an OLD binary path is re-rendered to the current one,
	// and the final-state verification proves it from the file on disk.
	it("P1: re-renders a stale install to the current binary and verifies it", () => {
		const settingsPath = installGemini(BINARY);
		expect(readFileSync(settingsPath, "utf-8")).toContain(BINARY);

		const outcome = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		expect(outcome.ok).toBe(true);
		expect(outcome.refreshed).toEqual(["gemini-cli"]);
		expect(outcome.unchanged).toBe(false);
		expect(outcome.verifications).toEqual([
			{ runner: "gemini-cli", settings_path: settingsPath, verified: true, problems: [] },
		]);
		const content = readFileSync(settingsPath, "utf-8");
		expect(content).toContain(NEW_BINARY);
		expect(content).not.toContain(`'${BINARY}'`);
	});

	// test-contract: security — review 2026-08-30 final pass: a user hook
	// prepended after installation (including one that merely PRINTS a node
	// invocation) must survive a refresh verbatim.
	it("P1b: a prepended user hook survives refresh", () => {
		const settingsPath = installGemini(BINARY);
		// SAFETY: written by installHooks moments ago; JSON by construction.
		const doc = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			hooks: Record<string, unknown[]>;
		};
		const userHooks = [
			{ command: `echo ${NEW_BINARY} # user note` },
			{ command: "node /home/user/hook-entry.js" },
			{
				command:
					"node /home/user/hook-entry.js --runner user-runner --event BeforeTool",
			},
			{ command: "node /home/user/hook-entry.js --runner gemini-cli" },
			{ command: "node /home/user/interlinked-activity.mjs" },
		];
		for (const key of Object.keys(doc.hooks)) {
			doc.hooks[key] = [...userHooks, ...(doc.hooks[key] ?? [])];
		}
		writeFileSync(settingsPath, JSON.stringify(doc, null, 2));

		const outcome = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		expect(outcome.ok).toBe(true);
		const after = readFileSync(settingsPath, "utf-8");
		expect(after).toContain(`echo ${NEW_BINARY} # user note`);
		expect(after).toContain("node /home/user/hook-entry.js");
		expect(after).toContain("--runner user-runner --event BeforeTool");
		expect(after).toContain("node /home/user/interlinked-activity.mjs");
		expect(after).toContain(NEW_BINARY);
		expect(after).not.toContain(`'${BINARY}'`);
	});

	// test-contract: invariant — idempotency: refreshing an already-current
	// install leaves every settings file byte-identical and says so.
	it("P2: a second refresh reports unchanged", () => {
		installGemini(BINARY);
		refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		const again = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		expect(again.ok).toBe(true);
		expect(again.unchanged).toBe(true);
	});

	// test-contract: invariant — a thrown install restores EVERY snapshot:
	// the settings file and the manifest are byte-identical afterwards.
	it("P3: rollback restores settings and manifest after a failing install", () => {
		const settingsPath = installGemini(BINARY);
		const settingsBefore = readFileSync(settingsPath, "utf-8");
		const manifestBefore = readFileSync(manifestPath(cwd), "utf-8");

		const outcome = refreshInstalledHooks(
			{ cwd, binaryPath: NEW_BINARY },
			{
				install: () => {
					// A worst-case failure: garbage already written before the throw.
					writeFileSync(settingsPath, "{ trashed");
					throw new Error("mid-write crash");
				},
			},
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.rolled_back).toBe(true);
		expect(outcome.post_install_failures.some((f) => f.reason.includes("mid-write crash"))).toBe(true);
		expect(readFileSync(settingsPath, "utf-8")).toBe(settingsBefore);
		expect(readFileSync(manifestPath(cwd), "utf-8")).toBe(manifestBefore);
	});
});

describe("refreshInstalledHooks — negative (must not fire)", () => {
	// test-contract: boundary — refresh NEVER installs: a runner absent from
	// the manifest is skipped with a reason, not installed fresh.
	it("N1: a runner not in the manifest is skipped, never installed", () => {
		installGemini(BINARY);
		const outcome = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY, runners: ["codex"] });
		expect(outcome.refreshed).toEqual([]);
		expect(outcome.skipped).toEqual([
			{ runner: "codex", reason: expect.stringContaining("not in the installer manifest") },
		]);
		expect(existsSync(join(cwd, ".codex"))).toBe(false);
	});

	// test-contract: boundary — dry-run changes nothing on disk.
	it("N2: dry-run leaves the stale settings file untouched", () => {
		const settingsPath = installGemini(BINARY);
		const before = readFileSync(settingsPath, "utf-8");
		const outcome = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY, dryRun: true });
		expect(outcome.dry_run).toBe(true);
		expect(readFileSync(settingsPath, "utf-8")).toBe(before);
	});

	// test-contract: boundary — refresh is ownership-manifest scoped, so a
	// missing manifest cannot honestly report a successful no-op.
	it("N3: no manifest refuses because ownership cannot be inferred", () => {
		const outcome = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		expect(outcome).toMatchObject({ ok: false, refreshed: [], unchanged: true });
		expect(outcome.post_install_failures[0]?.reason).toContain("manifest is missing");
		expect(readManifest(manifestPath(cwd))).toEqual([]);
	});

	// test-contract: bug — the reviewer's repro: corrupted settings made the
	// installer SKIP the runner, and refresh reported ok:true while the
	// manifest entry was ERASED. It must fail, roll back, and keep the entry.
	it("N4: a malformed settings file fails the refresh and keeps the manifest entry", () => {
		const settingsPath = installGemini(BINARY);
		writeFileSync(settingsPath, "{ not valid json");
		const manifestBefore = readFileSync(manifestPath(cwd), "utf-8");
		const outcome = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		expect(outcome.ok).toBe(false);
		expect(outcome.rolled_back).toBe(true);
		expect(readFileSync(manifestPath(cwd), "utf-8")).toBe(manifestBefore);
		expect(readManifest(manifestPath(cwd)).map((e) => e.runner)).toEqual(["gemini-cli"]);
	});

	// test-contract: bug — the reviewer's repro: a corrupt MANIFEST reported
	// ok:true, unchanged:true. It must refuse with the bytes preserved.
	it("N5: a corrupt manifest refuses the refresh and preserves its bytes", () => {
		writeFileSync(manifestPath(cwd), "{ definitely not json");
		const outcome = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		expect(outcome.ok).toBe(false);
		expect(outcome.post_install_failures[0]?.reason).toContain("corrupt");
		expect(outcome.post_install_failures[0]?.reason).not.toContain("fix or remove");
		expect(readFileSync(manifestPath(cwd), "utf-8")).toBe("{ definitely not json");

		// Deleting the evidence cannot turn the same repair attempt into a
		// successful no-op: refresh has no authority to infer owned entries.
		rmSync(manifestPath(cwd));
		const afterDeletion = refreshInstalledHooks({ cwd, binaryPath: NEW_BINARY });
		expect(afterDeletion.ok).toBe(false);
		expect(afterDeletion.post_install_failures[0]?.reason).toContain("manifest is missing");
	});

	// test-contract: bug — the reviewer's repro: a rollback that skipped
	// Codex's config.toml left `hooks = true` behind after a failed refresh.
	it("N6: rollback restores .codex/config.toml touched by postInstall", () => {
		const result = installHooks({ cwd, binaryPath: BINARY, runners: ["codex"], scope: "project" });
		expect(result.ok).toBe(true);
		const tomlPath = join(cwd, ".codex", "config.toml");
		writeFileSync(tomlPath, "[features]\nhooks = false\n");
		const outcome = refreshInstalledHooks(
			{ cwd, binaryPath: NEW_BINARY },
			{
				install: (opts) => {
					// The real installer's postInstall side effect, then a failure.
					const real = installHooks(opts);
					void real;
					throw new Error("post-write crash");
				},
			},
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.rolled_back).toBe(true);
		expect(readFileSync(tomlPath, "utf-8")).toBe("[features]\nhooks = false\n");
	});

	// test-contract: bug — review 2026-08-30 repro: damage injected AFTER the
	// install returned ok:true / rolled_back:false / verified:false, leaving
	// the damage behind. Failed verification must now roll back and fail.
	it("N7: failed final-state verification rolls back and returns ok:false", () => {
		const settingsPath = installGemini(BINARY);
		const goodBefore = readFileSync(settingsPath, "utf-8");
		const outcome = refreshInstalledHooks(
			{ cwd, binaryPath: NEW_BINARY },
			{
				install: (opts) => {
					const real = installHooks(opts);
					// The reviewer's damage shape: binary mentioned, hooks gone.
					writeFileSync(settingsPath, JSON.stringify({ unrelated_note: NEW_BINARY }));
					return real;
				},
			},
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.rolled_back).toBe(true);
		expect(outcome.verifications[0]?.verified).toBe(false);
		expect(outcome.post_install_failures.some((f) => f.reason.includes("verification"))).toBe(true);
		expect(readFileSync(settingsPath, "utf-8")).toBe(goodBefore);
	});

	// test-contract: bug — review 2026-08-30 repro: the snapshot resolved
	// "~/.gemini/…" beneath cwd while the installer wrote beneath $HOME, so a
	// failed refresh erased the user's real file and still reported
	// rolled_back:true. With a temp HOME, the USER-scope file must be
	// restored byte-identical.
	it("N8: user-scope rollback restores the file under $HOME, not under cwd", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "il-refresh-home-"));
		const priorHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			const result = installHooks({ cwd, binaryPath: BINARY, runners: ["gemini-cli"], scope: "user" });
			expect(result.ok).toBe(true);
			const userSettings = result.entries[0]?.settings_path ?? "";
			expect(userSettings.startsWith(fakeHome)).toBe(true);
			const userBefore = readFileSync(userSettings, "utf-8");

			const outcome = refreshInstalledHooks(
				{ cwd, binaryPath: NEW_BINARY },
				{
					install: () => {
						writeFileSync(userSettings, "{ damaged");
						throw new Error("mid-write crash at user scope");
					},
				},
			);
			expect(outcome.ok).toBe(false);
			expect(outcome.rolled_back).toBe(true);
			expect(readFileSync(userSettings, "utf-8")).toBe(userBefore);
		} finally {
			process.env.HOME = priorHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	// test-contract: bug — if a rollback restore itself fails (e.g. the
	// settings directory vanished after the snapshot was taken), the run must
	// report the restore's own error rather than silently claiming success.
	it("N9: a failed rollback restore surfaces its error and reports rolled_back:false", () => {
		const settingsPath = installGemini(BINARY);
		const settingsDir = dirname(settingsPath);
		const outcome = refreshInstalledHooks(
			{ cwd, binaryPath: NEW_BINARY },
			{
				install: () => {
					// Removes the directory a snapshotted file lived in, so restoring
					// it (write a temp file alongside it, then rename) fails.
					rmSync(settingsDir, { recursive: true, force: true });
					throw new Error("mid-write crash before rollback");
				},
			},
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.rolled_back).toBe(false);
		expect(outcome.rollback_error).toEqual(expect.stringContaining("ENOENT"));
	});
});

describe("reportRefresh — human and JSON output", () => {
	function captureStdout(): { writes: string[]; restore: () => void } {
		const writes: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		});
		return { writes, restore: () => spy.mockRestore() };
	}

	// test-contract: public-api — --json must print the FULL outcome object
	// verbatim, not the human-readable summary lines below it.
	it("prints the full outcome as JSON and returns before the human summary", () => {
		const outcome = {
			ok: true,
			dry_run: false,
			refreshed: ["gemini-cli"],
			skipped: [],
			post_install_failures: [],
			rolled_back: false,
			unchanged: false,
			verifications: [],
		};
		const { writes, restore } = captureStdout();
		try {
			reportRefresh(outcome, true);
		} finally {
			restore();
		}
		expect(writes).toEqual([`${JSON.stringify(outcome, null, 2)}\n`]);
	});

	// test-contract: invariant — the human report lists every verification's
	// runner, settings path, and pass/fail word (not just the count).
	it("lists each verification's runner and pass/fail state", () => {
		const outcome = {
			ok: false,
			dry_run: false,
			refreshed: [],
			skipped: [],
			post_install_failures: [],
			rolled_back: false,
			unchanged: false,
			verifications: [
				{ runner: "gemini-cli", settings_path: "/tmp/a/settings.json", verified: true, problems: [] },
				{ runner: "codex", settings_path: "/tmp/b/config.toml", verified: false, problems: ["missing hook"] },
			],
		};
		const { writes, restore } = captureStdout();
		try {
			reportRefresh(outcome, false);
		} finally {
			restore();
		}
		const out = writes.join("");
		expect(out).toContain("gemini-cli     → /tmp/a/settings.json verified");
		expect(out).toContain("codex          → /tmp/b/config.toml NOT VERIFIED");
	});

	// test-contract: invariant — a skipped runner's reason reaches the human
	// report, not just the JSON shape.
	it("lists each skipped runner with its reason", () => {
		const outcome = {
			ok: true,
			dry_run: false,
			refreshed: [],
			skipped: [{ runner: "codex", reason: "not in the installer manifest" }],
			post_install_failures: [],
			rolled_back: false,
			unchanged: false,
			verifications: [],
		};
		const { writes, restore } = captureStdout();
		try {
			reportRefresh(outcome, false);
		} finally {
			restore();
		}
		expect(writes.join("")).toContain("codex          skipped: not in the installer manifest");
	});

	// test-contract: invariant — a completed rollback and a rollback that
	// left behind an unrestored file both get their own explicit line.
	it("reports a completed rollback and a rollback that could not finish", () => {
		const outcome = {
			ok: false,
			dry_run: false,
			refreshed: [],
			skipped: [],
			post_install_failures: [],
			rolled_back: true,
			rollback_error: "EACCES: permission denied, open '/tmp/x.tmp'",
			unchanged: true,
			verifications: [],
		};
		const { writes, restore } = captureStdout();
		try {
			reportRefresh(outcome, false);
		} finally {
			restore();
		}
		const out = writes.join("");
		expect(out).toContain("all settings files and the manifest were rolled back");
		expect(out).toContain("ROLLBACK INCOMPLETE: EACCES: permission denied, open '/tmp/x.tmp'");
	});
});
