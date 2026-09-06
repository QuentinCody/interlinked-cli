import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureWorkspaceSnapshot,
	clearWorkspaceEffectSession,
	consumeWorkspaceResidue,
	consumeWorkspaceSnapshot,
	discardWorkspaceSnapshot,
	diffWorkspaceSnapshots,
	fingerprint,
	formatWorkspaceResidueWarning,
	isWorkspaceControlPath,
	rememberWorkspaceSnapshot,
	shouldObserveWorkspaceEffects,
} from "./workspace-effects.js";
import { resetReconciledEffectRegistry } from "./workspace-effect-attribution.js";

let root: string;

beforeEach(() => {
	resetReconciledEffectRegistry();
	root = mkdtempSync(join(tmpdir(), "interlinked-effects-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, "tracked.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "tracked.ts"], { cwd: root });
});

afterEach(() => {
	clearWorkspaceEffectSession("s1");
	rmSync(root, { recursive: true, force: true });
});

describe("workspace effect ChangeSet", () => {
	it("reports created, modified, and deleted Git-visible files from bytes, not tool names", () => {
		writeFileSync(join(root, "deleted.ts"), "old\n");
		execFileSync("git", ["add", "deleted.ts"], { cwd: root });
		const before = captureWorkspaceSnapshot(root);
		writeFileSync(join(root, "tracked.ts"), "export const value = 2;\n");
		writeFileSync(join(root, "created.ts"), "new\n");
		rmSync(join(root, "deleted.ts"));
		const found = diffWorkspaceSnapshots(before, captureWorkspaceSnapshot(root));
		expect(found.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
			{ path: "created.ts", kind: "created" },
			{ path: "deleted.ts", kind: "deleted" },
			{ path: "tracked.ts", kind: "modified" },
		]);
	});

	// test-contract: invariant — effect capture observes ignored local policy files and reports incomplete snapshots when bulk trees are collapsed
	it("includes Git-ignored local files while excluding known bulk directories", () => {
		writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\ndist/\n.interlinked/\n");
		for (const directory of ["node_modules", "dist", ".interlinked"]) {
			mkdirSync(join(root, directory), { recursive: true });
			writeFileSync(join(root, directory, "generated.js"), "generated\n");
		}
		const before = captureWorkspaceSnapshot(root);
		expect(before.complete).toBe(false);
		writeFileSync(join(root, ".env"), "TOKEN=local\n");
		chmodSync(join(root, ".env"), 0o644);

		const after = captureWorkspaceSnapshot(root);
		const found = diffWorkspaceSnapshots(before, after);

		expect(after.complete).toBe(false);
		expect(found.complete).toBe(false);
		expect(Object.keys(after.files)).toContain(".env");
		expect(found.files).toEqual([
			{
				path: ".env",
				kind: "created",
				before_sha256: null,
				after_sha256: expect.any(String),
				before_mode: null,
				after_mode: 0o644,
			},
		]);
	});

	// test-contract: boundary — a mode-only filesystem change is a modified effect even when file bytes are unchanged
	it("reports mode-only changes with normalized before and after modes", () => {
		const tracked = join(root, "tracked.ts");
		chmodSync(tracked, 0o644);
		const before = captureWorkspaceSnapshot(root);
		chmodSync(tracked, 0o755);

		const found = diffWorkspaceSnapshots(before, captureWorkspaceSnapshot(root));
		expect(found.files).toEqual([
			{
				path: "tracked.ts",
				kind: "modified",
				before_sha256: expect.any(String),
				after_sha256: expect.any(String),
				before_mode: 0o644,
				after_mode: 0o755,
			},
		]);
		expect(found.files[0]?.before_sha256).toBe(found.files[0]?.after_sha256);
	});

	// test-contract: invariant — snapshot discovery retains the explicit ignored control file while collapsing ordinary activity logs
	it("observes an ignored harness control file but excludes ordinary activity logs", () => {
		writeFileSync(join(root, ".gitignore"), ".interlinked/\n");
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, ".interlinked", "config.local.json"), '{"agent":"local"}\n');
		writeFileSync(join(root, ".interlinked", "activity.jsonl"), '{"event":"noise"}\n');

		const snapshot = captureWorkspaceSnapshot(root);

		expect(Object.keys(snapshot.files)).toContain(".interlinked/config.local.json");
		expect(Object.keys(snapshot.files)).not.toContain(".interlinked/activity.jsonl");
	});

	// test-contract: public-api — control-path classification accepts slash-normalized allowlist entries and rejects non-allowlisted activity files
	it("classifies only normalized harness control paths", () => {
		const controlPaths = [
			".interlinked/check-policy.json",
			".interlinked/check-policy.local.json",
			".interlinked/config.json",
			".interlinked/config.local.json",
			".interlinked/coverage-baseline.json",
			".interlinked/coverage-edit-baseline.json",
			".interlinked/distilled-rules.json",
			".interlinked/distilled-rules.overrides.json",
			".interlinked/guard-rules.json",
			".interlinked/guard-rules.local.json",
			".interlinked/large-files-baseline.json",
			".interlinked/metric-caps.json",
			".interlinked/mutation-baseline.json",
			".interlinked/package-allowlist.json",
			".interlinked/security-config.json",
			".interlinked/skipped-tests-baseline.json",
			".interlinked/suite-baseline.json",
			".interlinked/untested-files-baseline.json",
			".interlinked/verify-suppressions.json",
		];
		for (const path of controlPaths) expect(isWorkspaceControlPath(path)).toBe(true);
		expect(isWorkspaceControlPath(".interlinked\\config.local.json")).toBe(true);
		expect(isWorkspaceControlPath(".interlinked/activity.jsonl")).toBe(false);
		expect(isWorkspaceControlPath(".interlinked/config.local.json.bak")).toBe(false);
	});

	it("pairs Pre/Post by tool id and updates the reconciled state", () => {
		rememberWorkspaceSnapshot({ toolUseId: "tool-1", sessionId: "s1", root });
		writeFileSync(join(root, "tracked.ts"), "changed\n");
		const found = consumeWorkspaceSnapshot({ toolUseId: "tool-1", sessionId: "s1", root });
		expect(found?.files).toMatchObject([{ path: "tracked.ts", kind: "modified" }]);
		expect(consumeWorkspaceSnapshot({ toolUseId: "tool-1", sessionId: "s1", root })).toBeNull();
	});

	// test-contract: boundary — identical tool IDs from different sessions retain independent pre/post workspace snapshots
	it("scopes repeated tool IDs by session", () => {
		const otherRoot = mkdtempSync(join(tmpdir(), "interlinked-effects-other-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: otherRoot });
			writeFileSync(join(root, "session-a-before.ts"), "a\n");
			writeFileSync(join(otherRoot, "session-b-before.ts"), "b\n");
			execFileSync("git", ["add", "session-a-before.ts"], { cwd: root });
			execFileSync("git", ["add", "session-b-before.ts"], { cwd: otherRoot });

			rememberWorkspaceSnapshot({ toolUseId: "shared-tool", sessionId: "s1", root });
			rememberWorkspaceSnapshot({ toolUseId: "shared-tool", sessionId: "s2", root: otherRoot });
			writeFileSync(join(root, "session-a-after.ts"), "a-after\n");
			writeFileSync(join(otherRoot, "session-b-after.ts"), "b-after\n");

			expect(consumeWorkspaceSnapshot({ toolUseId: "shared-tool", sessionId: "s1", root })?.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
				{ path: "session-a-after.ts", kind: "created" },
			]);
			expect(consumeWorkspaceSnapshot({ toolUseId: "shared-tool", sessionId: "s2", root: otherRoot })?.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
				{ path: "session-b-after.ts", kind: "created" },
			]);
		} finally {
			clearWorkspaceEffectSession("s2");
			rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	it("uses a per-session stack when a runner supplies no tool id", () => {
		rememberWorkspaceSnapshot({ sessionId: "s1", root });
		writeFileSync(join(root, "tracked.ts"), "changed\n");
		expect(consumeWorkspaceSnapshot({ sessionId: "s1", root })?.files).toHaveLength(1);
	});

	it("discards the snapshot for a blocked call so Stop does not misattribute later writes", () => {
		rememberWorkspaceSnapshot({ toolUseId: "blocked", sessionId: "s1", root });
		discardWorkspaceSnapshot({ toolUseId: "blocked", sessionId: "s1" });
		writeFileSync(join(root, "later.ts"), "later\n");
		expect(consumeWorkspaceResidue("s1", root)).toBeNull();
	});

	it("excludes another session's reconciled write from this session's residue", () => {
		// Session s1 opens a snapshot, then session s2 writes a file and
		// reconciles it through its own PostToolUse. s1's Stop residue must not
		// charge s1 for s2's work.
		rememberWorkspaceSnapshot({ toolUseId: "s1-call", sessionId: "s1", root });
		rememberWorkspaceSnapshot({ toolUseId: "s2-call", sessionId: "s2", root });
		writeFileSync(join(root, "other-session.ts"), "export {};\n");
		expect(consumeWorkspaceSnapshot({ toolUseId: "s2-call", sessionId: "s2", root })?.files).toMatchObject([
			{ path: "other-session.ts", kind: "created" },
		]);
		const residue = consumeWorkspaceResidue("s1", root);
		expect(residue?.files).toEqual([]);
		expect(residue?.attributed_to_other_sessions).toBe(1);
		clearWorkspaceEffectSession("s2");
	});

	it("excludes a sibling subagent's reconciled write from root residue", () => {
		rememberWorkspaceSnapshot({ toolUseId: "root-call", sessionId: "shared", root });
		rememberWorkspaceSnapshot({ toolUseId: "child-call", sessionId: "shared", root });
		writeFileSync(join(root, "sibling-write.ts"), "export {};\n");
		expect(
			consumeWorkspaceSnapshot({
				toolUseId: "child-call",
				sessionId: "shared",
				subagentId: "child-a",
				root,
			})?.files,
		).toMatchObject([{ path: "sibling-write.ts", kind: "created" }]);
		const residue = consumeWorkspaceResidue("shared", root);
		expect(residue?.files).toEqual([]);
		expect(residue?.attributed_to_other_sessions).toBe(1);
		clearWorkspaceEffectSession("shared");
	});

	it("attributes a path another session reconciled even when the file changed again (2026-08-23 widening: the re-editing concurrent writer was the residual leak into innocent sessions' Stop rescans)", () => {
		rememberWorkspaceSnapshot({ toolUseId: "s1-call", sessionId: "s1", root });
		rememberWorkspaceSnapshot({ toolUseId: "s2-call", sessionId: "s2", root });
		writeFileSync(join(root, "contested.ts"), "theirs\n");
		consumeWorkspaceSnapshot({ toolUseId: "s2-call", sessionId: "s2", root });
		writeFileSync(join(root, "contested.ts"), "changed-again\n");
		const residue = consumeWorkspaceResidue("s1", root);
		expect(residue?.files).toEqual([]);
		expect(residue?.attributed_to_other_sessions).toBe(1);
		clearWorkspaceEffectSession("s2");
	});

	it("surfaces unconsumed effects at Stop and consumes the residue once", () => {
		rememberWorkspaceSnapshot({ toolUseId: "dropped-post", sessionId: "s1", root });
		writeFileSync(join(root, "via-bash.ts"), "export {};\n");
		const residue = consumeWorkspaceResidue("s1", root);
		expect(residue?.files).toMatchObject([{ path: "via-bash.ts", kind: "created" }]);
		expect(consumeWorkspaceResidue("s1", root)).toBeNull();
	});

	it("falls back to a bounded filesystem walk outside Git", () => {
		const plain = mkdtempSync(join(tmpdir(), "interlinked-effects-plain-"));
		try {
			mkdirSync(join(plain, "src"));
			writeFileSync(join(plain, "src", "a.ts"), "a\n");
			expect(Object.keys(captureWorkspaceSnapshot(plain).files)).toEqual(["src/a.ts"]);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	// test-contract: boundary — explicit harness controls remain observable in a workspace with no Git metadata while activity logs stay collapsed
	it("observes explicit control files in non-Git workspaces", () => {
		const plain = mkdtempSync(join(tmpdir(), "interlinked-effects-controls-"));
		try {
			mkdirSync(join(plain, ".interlinked"), { recursive: true });
			writeFileSync(join(plain, ".interlinked", "metric-caps.json"), '{"lines":1000}\n');
			writeFileSync(join(plain, ".interlinked", "activity.jsonl"), '{"event":"noise"}\n');

			const snapshot = captureWorkspaceSnapshot(plain);

			expect(Object.keys(snapshot.files)).toContain(".interlinked/metric-caps.json");
			expect(Object.keys(snapshot.files)).not.toContain(".interlinked/activity.jsonl");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("observes shell and unknown tools while exempting only known reads", () => {
		expect(shouldObserveWorkspaceEffects("Bash")).toBe(true);
		expect(shouldObserveWorkspaceEffects("new_mcp_writer")).toBe(true);
		expect(shouldObserveWorkspaceEffects("Read")).toBe(false);
	});

	it("renders Stop residue as bounded advisory evidence", () => {
		const before = captureWorkspaceSnapshot(root);
		writeFileSync(join(root, "created.ts"), "new\n");
		const warning = formatWorkspaceResidueWarning(
			diffWorkspaceSnapshots(before, captureWorkspaceSnapshot(root)),
		);
		expect(warning).toContain("created:created.ts");
		expect(warning).toContain("backstop, not rollback");
	});

	// test-contract: boundary — a symlink is fingerprinted by its link target text, never by dereferencing it
	it("fingerprints a symlink from its link target text without following it", () => {
		// The target must resolve (existsSync follows symlinks before
		// fingerprint() ever runs), but the hash still comes from the link
		// text itself, not from reading the target's bytes.
		const target = "tracked.ts";
		symlinkSync(target, join(root, "link.ts"));

		const snapshot = captureWorkspaceSnapshot(root);

		const expectedSha256 = createHash("sha256").update(`symlink:${target}`).digest("hex");
		expect(snapshot.files["link.ts"]?.sha256).toBe(expectedSha256);
		expect(snapshot.files["link.ts"]?.sha256).not.toBe(snapshot.files["tracked.ts"]?.sha256);
	});

	// test-contract: boundary — fingerprint() reports a stat failure as a missing fingerprint instead of throwing
	it("returns null from fingerprint() when lstat fails for a path that no longer exists", () => {
		expect(fingerprint(join(root, "vanished-before-stat.ts"), 1024)).toBeNull();
	});

	// test-contract: boundary — an oversized file marks the snapshot incomplete instead of hashing its full content
	it("marks the snapshot incomplete when a file exceeds the per-file hash budget", () => {
		const bigPath = join(root, "big.bin");
		writeFileSync(bigPath, Buffer.alloc(8 * 1024 * 1024 + 1));

		const snapshot = captureWorkspaceSnapshot(root);

		expect(snapshot.complete).toBe(false);
		expect(snapshot.files["big.bin"]?.size).toBe(8 * 1024 * 1024 + 1);
	});

	// test-contract: boundary — the pending-snapshot ceiling drops every earlier unconsumed call before accepting a new one
	it("drops earlier unconsumed snapshots once the pending ceiling is reached", () => {
		for (let i = 0; i < 128; i++) {
			rememberWorkspaceSnapshot({ toolUseId: `over-ceiling-${i}`, sessionId: "s1", root });
		}
		// The 129th push finds pendingSize() already at the 128 ceiling, so it
		// clears every prior entry before recording this one.
		rememberWorkspaceSnapshot({ toolUseId: "over-ceiling-128", sessionId: "s1", root });

		expect(
			consumeWorkspaceSnapshot({ toolUseId: "over-ceiling-0", sessionId: "s1", root }),
		).toBeNull();
		expect(
			consumeWorkspaceSnapshot({ toolUseId: "over-ceiling-128", sessionId: "s1", root }),
		).not.toBeNull();
	});
});
