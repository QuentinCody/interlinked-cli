import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckpoint, listCheckpoints, rewindToCheckpoint, type Checkpoint } from "./checkpoints.js";

const roots: string[] = [];

function git(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}

function repository(ignoreState = true, objectFormat: "sha1" | "sha256" = "sha1"): string {
	const root = mkdtempSync(join(tmpdir(), "checkpoint-restore-"));
	roots.push(root);
	git(root, ["init", "--quiet", `--object-format=${objectFormat}`]);
	writeFileSync(join(root, ".gitignore"), ignoreState ? ".interlinked/\n" : "");
	writeFileSync(join(root, "app.ts"), "base\n");
	git(root, ["add", ".gitignore", "app.ts"]);
	git(root, ["-c", "user.name=Checkpoint Test", "-c", "user.email=checkpoint@example.invalid", "commit", "--quiet", "-m", "Fixture base"]);
	return root;
}

function capture(root: string): Checkpoint {
	return createCheckpoint({ cwd: root, sessionId: "session", agent: "test-agent", message: "Snapshot", trigger: "manual" });
}

beforeEach(() => vi.stubEnv("INTERLINKED_DATA_DIR", ""));
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable checkpoint restoration in isolated Git repositories", () => {
	it("preserves leading whitespace, newline and Unicode paths through inventory and restoration", () => {
		const root = repository();
		const tracked = " tracked name.ts";
		writeFileSync(join(root, tracked), "tracked base\n");
		git(root, ["add", "--", tracked]);
		git(root, ["-c", "user.name=Checkpoint Test", "-c", "user.email=checkpoint@example.invalid", "commit", "--quiet", "-m", "Path-name fixture"]);
		const contents = new Map([
			[tracked, "tracked snapshot\n"],
			[" leading untracked.txt", "leading snapshot\n"],
			["line\nbreak.txt", "newline snapshot\n"],
			["évidence.ts", "Unicode snapshot\n"],
		]);
		for (const [path, content] of contents) writeFileSync(join(root, path), content);
		const checkpoint = capture(root);
		expect(new Set(checkpoint.files_changed)).toEqual(new Set(contents.keys()));
		for (const [path, content] of contents) expect(readFileSync(join(root, path), "utf8")).toBe(content);
		git(root, ["reset", "--hard"]);
		git(root, ["clean", "-fd"]);
		writeFileSync(join(root, "app.ts"), "later work\n");

		rewindToCheckpoint(checkpoint.id, { cwd: root, force: true });

		for (const [path, content] of contents) expect(readFileSync(join(root, path), "utf8")).toBe(content);
	});

	it("roundtrips renames, deletions, file modes and untracked symbolic links", () => {
		const root = repository();
		writeFileSync(join(root, "rename-from.ts"), "renamed content\n");
		writeFileSync(join(root, "obsolete.ts"), "deleted content\n");
		writeFileSync(join(root, "script.sh"), "fixture content\n");
		chmodSync(join(root, "script.sh"), 0o644);
		git(root, ["add", "rename-from.ts", "obsolete.ts", "script.sh"]);
		git(root, ["-c", "user.name=Checkpoint Test", "-c", "user.email=checkpoint@example.invalid", "commit", "--quiet", "-m", "File-kind fixture"]);
		renameSync(join(root, "rename-from.ts"), join(root, "rename-to.ts"));
		unlinkSync(join(root, "obsolete.ts"));
		chmodSync(join(root, "script.sh"), 0o755);
		symlinkSync("app.ts", join(root, "link.ts"));
		const checkpoint = capture(root);
		git(root, ["reset", "--hard"]);
		git(root, ["clean", "-fd"]);
		writeFileSync(join(root, "app.ts"), "later work\n");

		rewindToCheckpoint(checkpoint.id, { cwd: root, force: true });

		expect(existsSync(join(root, "rename-from.ts"))).toBe(false);
		expect(readFileSync(join(root, "rename-to.ts"), "utf8")).toBe("renamed content\n");
		expect(existsSync(join(root, "obsolete.ts"))).toBe(false);
		expect(statSync(join(root, "script.sh")).mode & 0o111).toBe(0o111);
		expect(lstatSync(join(root, "link.ts")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(root, "link.ts"))).toBe("app.ts");
	});

	it.each([undefined, "tracked state"])("preserves tracked state under %s while restoring an older base", (dataDirectory) => {
		const root = repository(false);
		const stateDirectory = dataDirectory === undefined ? join(root, ".interlinked") : join(root, dataDirectory);
		if (dataDirectory !== undefined) vi.stubEnv("INTERLINKED_DATA_DIR", stateDirectory);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		mkdirSync(stateDirectory, { recursive: true });
		const metadataPath = join(stateDirectory, "checkpoints.json");
		const policyPath = join(root, ".interlinked", "policy.json");
		writeFileSync(metadataPath, "[]\n");
		writeFileSync(policyPath, "original policy\n");
		git(root, ["add", "--", ".interlinked", ...(dataDirectory === undefined ? [] : [dataDirectory])]);
		git(root, ["-c", "user.name=Checkpoint Test", "-c", "user.email=checkpoint@example.invalid", "commit", "--quiet", "-m", "Tracked state fixture"]);
		const branch = git(root, ["symbolic-ref", "--short", "HEAD"]);
		writeFileSync(join(root, "app.ts"), "captured work\n");
		const checkpoint = capture(root);
		git(root, ["add", "app.ts"]);
		git(root, ["-c", "user.name=Checkpoint Test", "-c", "user.email=checkpoint@example.invalid", "commit", "--quiet", "-m", "Later fixture revision"]);
		const laterCommit = git(root, ["rev-parse", "HEAD"]);
		writeFileSync(policyPath, "current policy\n");
		git(root, ["add", "--", ".interlinked/policy.json"]);
		writeFileSync(policyPath, "current unstaged policy\n");
		writeFileSync(join(root, "app.ts"), "later work\n");
		const metadata = readFileSync(metadataPath, "utf8");

		rewindToCheckpoint(checkpoint.id, { cwd: root, force: true });

		expect(readFileSync(metadataPath, "utf8")).toBe(metadata);
		expect(readFileSync(policyPath, "utf8")).toBe("current unstaged policy\n");
		expect(git(root, ["show", ":.interlinked/policy.json"])).toBe("current policy");
		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("captured work\n");
		expect(git(root, ["rev-parse", "HEAD"])).toBe(checkpoint.base_commit);
		expect(git(root, ["rev-parse", `refs/heads/${branch}`])).toBe(laterCommit);
		expect(listCheckpoints({ cwd: root })).toEqual([checkpoint]);
	});

	it.each([undefined, "state with spaces", " state\né"])("preserves unignored checkpoint state under %s", (dataDirectory) => {
		const root = repository(false);
		if (dataDirectory !== undefined) vi.stubEnv("INTERLINKED_DATA_DIR", join(root, dataDirectory));
		writeFileSync(join(root, "app.ts"), "first snapshot\n");
		const first = capture(root);
		writeFileSync(join(root, "app.ts"), "second snapshot\n");
		const second = capture(root);
		writeFileSync(join(root, "app.ts"), "later work\n");

		rewindToCheckpoint(first.id, { cwd: root, force: true });

		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("first snapshot\n");
		expect(new Set(listCheckpoints({ cwd: root }).map((checkpoint) => checkpoint.id))).toEqual(new Set([first.id, second.id]));
	});

	it("discovers a legacy snapshot whose metadata has no stored object ID", () => {
		const root = repository();
		writeFileSync(join(root, "app.ts"), "legacy work\n");
		const legacy = capture(root);
		delete legacy.stash_ref;
		writeFileSync(join(root, ".interlinked", "checkpoints.json"), JSON.stringify([legacy]));
		writeFileSync(join(root, "app.ts"), "later work\n");

		rewindToCheckpoint(legacy.id, { cwd: root, force: true });

		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("legacy work\n");
		expect(listCheckpoints({ cwd: root })).toEqual([legacy]);
	});

	it("rejects a snapshot whose base differs from metadata before discarding work", () => {
		const root = repository();
		writeFileSync(join(root, "app.ts"), "snapshot work\n");
		const checkpoint = capture(root);
		git(root, ["add", "app.ts"]);
		git(root, ["-c", "user.name=Checkpoint Test", "-c", "user.email=checkpoint@example.invalid", "commit", "--quiet", "-m", "Later fixture revision"]);
		checkpoint.base_commit = git(root, ["rev-parse", "HEAD"]);
		writeFileSync(join(root, ".interlinked", "checkpoints.json"), JSON.stringify([checkpoint]));
		writeFileSync(join(root, "app.ts"), "work to preserve\n");

		expect(() => rewindToCheckpoint(checkpoint.id, { cwd: root, force: true })).toThrow("Checkpoint snapshot unavailable");
		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("work to preserve\n");
		expect(listCheckpoints({ cwd: root })).toEqual([checkpoint]);
	});

	it.each(["sha1", "sha256"] as const)("restores %s snapshots after clearing the ordinary stash list", (objectFormat) => {
		const root = repository(true, objectFormat);
		writeFileSync(join(root, "app.ts"), "staged snapshot\n");
		git(root, ["add", "app.ts"]);
		writeFileSync(join(root, "app.ts"), "unstaged snapshot\n");
		writeFileSync(join(root, "note.txt"), "untracked snapshot\n");
		const checkpoint = capture(root);

		expect(checkpoint.restorable).toBe(true);
		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("unstaged snapshot\n");
		expect(git(root, ["show", ":app.ts"])).toBe("staged snapshot");
		expect(git(root, ["rev-parse", `refs/interlinked/checkpoints/${checkpoint.id}`])).toBe(checkpoint.stash_ref);
		git(root, ["stash", "clear"]);
		writeFileSync(join(root, "app.ts"), "later work\n");
		writeFileSync(join(root, "note.txt"), "later note\n");
		writeFileSync(join(root, "later.txt"), "later untracked\n");

		const restored = rewindToCheckpoint(checkpoint.id, { cwd: root, force: true });

		expect(restored.warning).toBeUndefined();
		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("unstaged snapshot\n");
		expect(git(root, ["show", ":app.ts"])).toBe("staged snapshot");
		expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("untracked snapshot\n");
		expect(existsSync(join(root, "later.txt"))).toBe(false);
	});

	it("preserves an older user stash when there are no new changes to capture", () => {
		const root = repository();
		writeFileSync(join(root, "app.ts"), "older user work\n");
		git(root, ["stash", "push", "--quiet", "-m", "User snapshot"]);
		const before = git(root, ["stash", "list", "--format=%H:%s"]);

		const checkpoint = capture(root);

		expect(checkpoint.restorable).toBe(false);
		expect(checkpoint.stash_ref).toBeUndefined();
		expect(git(root, ["stash", "list", "--format=%H:%s"])).toBe(before);
		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("base\n");
	});

	it("refuses a missing snapshot before forced cleanup and preserves its legacy metadata", () => {
		const root = repository();
		const checkpoint: Checkpoint = {
			id: "legacy", session_id: "session", agent: "agent", message: "Old snapshot",
			timestamp: "2026-09-08T00:00:00Z", base_commit: git(root, ["rev-parse", "HEAD"]),
			trigger: "manual", restorable: true, stash_ref: "f".repeat(40), files_changed: ["app.ts"],
		};
		mkdirSync(join(root, ".interlinked"));
		const metadataPath = join(root, ".interlinked", "checkpoints.json");
		const metadata = JSON.stringify([checkpoint]);
		writeFileSync(metadataPath, metadata);
		writeFileSync(join(root, "app.ts"), "work to preserve\n");
		writeFileSync(join(root, "later.txt"), "untracked to preserve\n");

		expect(() => rewindToCheckpoint("legacy", { cwd: root, force: true })).toThrow("Checkpoint snapshot unavailable");
		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("work to preserve\n");
		expect(readFileSync(join(root, "later.txt"), "utf8")).toBe("untracked to preserve\n");
		expect(readFileSync(metadataPath, "utf8")).toBe(metadata);
		expect(listCheckpoints({ cwd: root })).toEqual([checkpoint]);
	});

	it("restores a legacy popped stash by its retained object ID", () => {
		const root = repository();
		writeFileSync(join(root, "app.ts"), "legacy captured work\n");
		git(root, ["stash", "push", "--quiet", "-m", "Old checkpoint"]);
		const snapshot = git(root, ["rev-parse", "refs/stash"]);
		git(root, ["stash", "pop", "--quiet"]);
		const checkpoint: Checkpoint = {
			id: "legacy", session_id: "session", agent: "agent", message: "Old snapshot",
			timestamp: "2026-09-08T00:00:00Z", base_commit: git(root, ["rev-parse", "HEAD"]),
			trigger: "manual", restorable: true, stash_ref: snapshot, files_changed: ["app.ts"],
		};
		mkdirSync(join(root, ".interlinked"));
		writeFileSync(join(root, ".interlinked", "checkpoints.json"), JSON.stringify([checkpoint]));
		writeFileSync(join(root, "app.ts"), "later work\n");

		expect(rewindToCheckpoint("legacy", { cwd: root, force: true }).warning).toBeUndefined();
		expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("legacy captured work\n");
		expect(listCheckpoints({ cwd: root })).toEqual([checkpoint]);
	});
});
