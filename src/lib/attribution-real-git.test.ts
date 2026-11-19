import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAttributionTrailer, snapshotPreRun } from "./attribution.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("attribution with isolated Git repositories", () => {
	it("captures untracked-only and tracked unusual paths without shell interpretation", () => {
		const cwd = mkdtempSync(join(tmpdir(), "attribution-git-"));
		roots.push(cwd);
		const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
		git("init", "--quiet");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@example.invalid");
		const tracked = " leading\ntracked\té.txt";
		writeFileSync(join(cwd, tracked), "before\n");
		git("add", "--", tracked);
		git("commit", "--quiet", "-m", "fixture\n\nInterlinked-Attribution: 50% agent (2/4 lines)");
		const untracked = " leading\nquotes \" $metadata.txt";
		writeFileSync(join(cwd, untracked), "new\n");
		const first = snapshotPreRun(cwd);
		expect(Object.keys(first.files)).toEqual([untracked]);
		expect(first.files[untracked]).toBeGreaterThan(0);
		writeFileSync(join(cwd, tracked), "after\n");
		expect(snapshotPreRun(cwd).files[tracked]).toBe(2);
		expect(readAttributionTrailer("HEAD", cwd)).toMatchObject({ agent_lines: 2, total_lines: 4 });
	});
});
