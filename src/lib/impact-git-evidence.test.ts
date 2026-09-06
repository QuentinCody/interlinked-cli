// ===========================================
// impact-git-evidence.ts — shallow-tail coverage
// ===========================================
// Drives `readGitWorktreeEvidence` and `readDependencyDeltaEvidence` against
// real, throwaway git repos created under the OS temp dir (never this repo's
// own git state) so the actual `git`/`fs` failure surfaces get exercised
// rather than mocked: a binary file diff, a malformed committed manifest,
// and a manifest that vanishes from disk between the "before" git-show read
// and the "after" filesystem read.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDependencyDeltaEvidence, readGitWorktreeEvidence } from "./impact-git-evidence.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	return dir;
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("readGitWorktreeEvidence — binary file numstat", () => {
	it("counts a binary file as changed without adding its line delta", () => {
		const dir = initRepo("impact-git-binary-");
		tempDirs.push(dir);
		writeFileSync(join(dir, "asset.bin"), Buffer.from([0, 1, 2, 3]));
		git(dir, ["add", "asset.bin"]);
		git(dir, ["commit", "-q", "-m", "base"]);
		const base = git(dir, ["rev-parse", "HEAD"]);
		writeFileSync(join(dir, "asset.bin"), Buffer.from([0, 9, 9, 9, 9, 9]));

		const evidence = readGitWorktreeEvidence(dir, base);

		// git reports "-\t-\tasset.bin" for a binary numstat row; parseNumstat
		// must route that into binary_files rather than parsing "-" as a
		// line count (which would either be 0 lines added or NaN-poison the
		// totals — either way, not the observed 1/0 split below).
		expect(evidence.binary_files).toBe(1);
		expect(evidence.lines_added).toBe(0);
		expect(evidence.files_changed).toBe(1);
	});
});

describe("readDependencyDeltaEvidence — manifest parse failures", () => {
	it("reports unavailable when the committed package.json is malformed JSON", () => {
		const dir = initRepo("impact-git-malformed-");
		tempDirs.push(dir);
		writeFileSync(join(dir, "package.json"), "{ not valid json");
		git(dir, ["add", "package.json"]);
		git(dir, ["commit", "-q", "-m", "base"]);
		const base = git(dir, ["rev-parse", "HEAD"]);

		const result = readDependencyDeltaEvidence(dir, base);

		// parseManifest's JSON.parse throws on the malformed committed blob;
		// its own catch swallows that and returns null rather than letting
		// the exception escape, which is what routes here to the
		// missing-or-malformed reason instead of throwing out of the call.
		expect(result.availability).toBe("unavailable");
		expect(result.reason).toBe("package.json is missing or malformed");
	});

	it("reports unavailable with the underlying error when package.json is missing from disk", () => {
		const dir = initRepo("impact-git-missing-");
		tempDirs.push(dir);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "x", version: "1.0.0", dependencies: {} }),
		);
		git(dir, ["add", "package.json"]);
		git(dir, ["commit", "-q", "-m", "base"]);
		const base = git(dir, ["rev-parse", "HEAD"]);
		unlinkSync(join(dir, "package.json"));

		const result = readDependencyDeltaEvidence(dir, base);

		// git show still resolves the committed blob fine; readFileSync of
		// the now-deleted on-disk copy throws ENOENT, which only the outer
		// try/catch (not parseManifest's) can see — its reason carries the
		// real fs error message, not the generic malformed-manifest text.
		expect(result.availability).toBe("unavailable");
		expect(result.reason).toContain("ENOENT");
	});
});
