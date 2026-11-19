import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeIndexSnapshot } from "./staged-snapshot.js";

let repo: string;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

function writeRepo(rel: string, content: string): void {
	const abs = join(repo, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "staged-snap-"));
	git("init", "-q");
	git("config", "user.email", "t@t.t");
	git("config", "user.name", "t");
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("materializeIndexSnapshot", () => {
	it("materializes the STAGED index content, not the dirty worktree (finding 3)", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");
		// Stage v2, then dirty the worktree to v3 (UNSTAGED). The commit would
		// capture v2; the worktree holds v3. The snapshot must reflect v2.
		writeRepo("src/m.ts", "export const v = 2;\n");
		git("add", "src/m.ts");
		writeRepo("src/m.ts", "export const v = 3;\n");

		const snap = materializeIndexSnapshot(repo);
		expect(snap).not.toBeNull();
		const materialized = readFileSync(join(snap?.root ?? "", "src/m.ts"), "utf-8");
		expect(materialized).toBe("export const v = 2;\n"); // the INDEX, not worktree v3
		snap?.cleanup();
		expect(existsSync(snap?.root ?? "")).toBe(false); // cleanup removes the tree
	});

	it("excludes an unstaged new file (not part of the commit)", () => {
		writeRepo("src/a.ts", "export const a = 1;\n");
		git("add", "src/a.ts");
		git("commit", "-qm", "init");
		// b.ts exists in the worktree but is NOT staged → not in the commit.
		writeRepo("src/b.ts", "export const b = 1;\n");

		const snap = materializeIndexSnapshot(repo);
		expect(snap).not.toBeNull();
		expect(existsSync(join(snap?.root ?? "", "src/a.ts"))).toBe(true);
		expect(existsSync(join(snap?.root ?? "", "src/b.ts"))).toBe(false); // untracked → absent
		snap?.cleanup();
	});

	it("symlinks node_modules so a suite can still resolve dependencies", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");

		const snap = materializeIndexSnapshot(repo);
		expect(snap).not.toBeNull();
		expect(existsSync(join(snap?.root ?? "", "node_modules", "dep", "index.js"))).toBe(true);
		snap?.cleanup();
	});

	it("symlinks each workspace package's own node_modules, not only the root one (pnpm monorepo)", () => {
		writeRepo("packages/a/src/m.ts", "export const v = 1;\n");
		writeRepo("packages/a/package.json", "{}\n");
		writeRepo(".gitignore", "node_modules/\n");
		mkdirSync(join(repo, "node_modules", "rootdep"), { recursive: true });
		mkdirSync(join(repo, "packages", "a", "node_modules", "pkgdep"), { recursive: true });
		writeFileSync(join(repo, "packages", "a", "node_modules", "pkgdep", "index.js"), "module.exports = 1;\n");
		git("add", ".gitignore", "packages");
		git("commit", "-qm", "init");

		const snap = materializeIndexSnapshot(repo);
		const root = snap?.root ?? "";
		expect(existsSync(join(root, "node_modules", "rootdep"))).toBe(true);
		expect(lstatSync(join(root, "packages", "a", "node_modules")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(root, "packages", "a", "node_modules", "pkgdep", "index.js"))).toBe(true);
		// A tracked directory with no real node_modules beside it gets no link.
		expect(existsSync(join(root, "packages", "a", "src", "node_modules"))).toBe(false);
		snap?.cleanup();
	});

	it("returns null outside a git repo (fail-open)", () => {
		const notRepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(materializeIndexSnapshot(notRepo)).toBeNull();
		} finally {
			rmSync(notRepo, { recursive: true, force: true });
		}
	});

	// UNTRACKED-EXCLUSION CONTRACT (finding 3). `git commit -a` stages tracked
	// modifications but NEVER untracked files, so the -a snapshot must include the
	// former and exclude the latter — otherwise an untracked test masks a tracked
	// source change and an uncovered/red commit slips through.
	it("the -a snapshot includes tracked worktree mods but EXCLUDES untracked files", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");
		writeRepo("src/m.ts", "export const v = 2;\n"); // tracked, unstaged — -a WILL stage this
		writeRepo("src/m.test.ts", "test('x', () => {});\n"); // untracked — -a will NOT stage this

		const snap = materializeIndexSnapshot(repo, true); // the -a mode
		expect(snap).not.toBeNull();
		expect(readFileSync(join(snap?.root ?? "", "src/m.ts"), "utf-8")).toBe("export const v = 2;\n");
		expect(existsSync(join(snap?.root ?? "", "src/m.test.ts"))).toBe(false); // untracked → absent
		snap?.cleanup();
	});

	it("a plain (non--a) snapshot ignores tracked worktree mods (the INDEX exactly)", () => {
		writeRepo("src/m.ts", "export const v = 1;\n");
		git("add", "src/m.ts");
		git("commit", "-qm", "init");
		writeRepo("src/m.ts", "export const v = 2;\n"); // unstaged — a plain commit ignores it
		const snap = materializeIndexSnapshot(repo);
		expect(readFileSync(join(snap?.root ?? "", "src/m.ts"), "utf-8")).toBe("export const v = 1;\n");
		snap?.cleanup();
	});
});

// NARROW constructed commits (finding 2026-06): `git add src/a.ts && git commit`
// produces "the existing index + only the named paths". Evaluating the raw
// worktree instead let an unrelated UNTRACKED test cover the staged source and
// approve a commit whose actual tree stays uncovered.
describe("materializeIndexSnapshot — narrow constructed paths", () => {
	beforeEach(() => {
		writeRepo("src/a.ts", "export const a = 'OLD';\n");
		git("add", "src/a.ts");
		git("commit", "-qm", "baseline");
	});

	it("overlays ONLY the named worktree path; an untracked sibling test stays OUT", () => {
		writeRepo("src/a.ts", "export const a = 'NEW';\n"); // modified, NAMED by the add
		writeRepo("src/sneaky.test.ts", "it('covers a', () => {});\n"); // untracked, NOT named
		const snap = materializeIndexSnapshot(repo, false, ["src/a.ts"]);
		expect(snap).not.toBeNull();
		try {
			expect(readFileSync(join(snap?.root ?? "", "src/a.ts"), "utf-8")).toContain("NEW");
			// The raw worktree would have included this — the actual commit snapshot
			// does not, so neither does the materialized tree.
			expect(existsSync(join(snap?.root ?? "", "src/sneaky.test.ts"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});

	it("a named path ABSENT from the worktree is removed (the add stages the deletion)", () => {
		rmSync(join(repo, "src/a.ts"));
		const snap = materializeIndexSnapshot(repo, false, ["src/a.ts"]);
		expect(snap).not.toBeNull();
		try {
			expect(existsSync(join(snap?.root ?? "", "src/a.ts"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});

	it("a named DIRECTORY brings its current state, including untracked files inside it", () => {
		writeRepo("src/a.ts", "export const a = 'NEW';\n");
		writeRepo("src/extra.ts", "export const e = 1;\n"); // untracked but INSIDE the named dir
		const snap = materializeIndexSnapshot(repo, false, ["src"]);
		expect(snap).not.toBeNull();
		try {
			// `git add src/` stages untracked files under src/ — the snapshot has them.
			expect(readFileSync(join(snap?.root ?? "", "src/a.ts"), "utf-8")).toContain("NEW");
			expect(existsSync(join(snap?.root ?? "", "src/extra.ts"))).toBe(true);
		} finally {
			snap?.cleanup();
		}
	});

	it("unrelated UNSTAGED edits to tracked files stay at their INDEX content", () => {
		writeRepo("src/b.ts", "export const b = 'STAGED';\n");
		git("add", "src/b.ts");
		git("commit", "-qm", "add b");
		writeRepo("src/b.ts", "export const b = 'UNSTAGED-EDIT';\n"); // dirty, NOT named
		writeRepo("src/a.ts", "export const a = 'NEW';\n"); // named
		const snap = materializeIndexSnapshot(repo, false, ["src/a.ts"]);
		expect(snap).not.toBeNull();
		try {
			expect(readFileSync(join(snap?.root ?? "", "src/a.ts"), "utf-8")).toContain("NEW");
			expect(readFileSync(join(snap?.root ?? "", "src/b.ts"), "utf-8")).toContain("STAGED");
		} finally {
			snap?.cleanup();
		}
	});

	it("skips .interlinked paths — the snapshot must never recurse into its own tree", () => {
		writeRepo(".interlinked/state.json", "{}\n");
		const snap = materializeIndexSnapshot(repo, false, [".interlinked", "src/a.ts"]);
		expect(snap).not.toBeNull();
		try {
			expect(existsSync(join(snap?.root ?? "", ".interlinked", "state.json"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});
});

// Round 4 (finding 2026-06): `git commit -- src` commits TRACKED paths only.
// Copying the raw worktree directory also included untracked files, so an
// untracked test beneath the pathspec could supply coverage and approve a
// source commit even though that test is absent from the resulting commit.
describe("materializeIndexSnapshot — tracked-only pathspec scopes (`git commit -- <path>`, `git add -u <path>`)", () => {
	beforeEach(() => {
		writeRepo("src/a.ts", "export const a = 'OLD';\n");
		git("add", "src/a.ts");
		git("commit", "-qm", "baseline");
	});

	it("excludes untracked files under a tracked-only dir — they are not in the commit", () => {
		writeRepo("src/a.ts", "export const a = 'NEW';\n"); // tracked, modified
		writeRepo("src/sneaky.test.ts", "it('covers a', () => {});\n"); // untracked
		const snap = materializeIndexSnapshot(repo, false, ["src"], ["src"]);
		expect(snap).not.toBeNull();
		try {
			expect(readFileSync(join(snap?.root ?? "", "src/a.ts"), "utf-8")).toContain("NEW");
			expect(existsSync(join(snap?.root ?? "", "src/sneaky.test.ts"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});

	it("a tracked file deleted in the worktree is removed (the pathspec commits the deletion)", () => {
		rmSync(join(repo, "src/a.ts"));
		const snap = materializeIndexSnapshot(repo, false, ["src"], ["src"]);
		expect(snap).not.toBeNull();
		try {
			expect(existsSync(join(snap?.root ?? "", "src/a.ts"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});

	it("an untracked FILE pathspec overlays nothing (git would refuse to commit it)", () => {
		writeRepo("src/new.ts", "export const n = 1;\n"); // untracked
		const snap = materializeIndexSnapshot(repo, false, ["src/new.ts"], ["src/new.ts"]);
		expect(snap).not.toBeNull();
		try {
			expect(existsSync(join(snap?.root ?? "", "src/new.ts"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});

	// Round 5: `git commit src/a.ts` (--only) builds the commit from HEAD plus
	// the named paths — unrelated STAGED index changes are NOT in it. Basing the
	// snapshot on the index let a separately staged failing test false-block,
	// and a staged test supply coverage the commit will not contain.
	it("HEAD base: an unrelated STAGED file stays OUT of the snapshot", () => {
		writeRepo("src/a.ts", "export const a = 'NEW';\n"); // the named path
		writeRepo("other.test.ts", "it('fails', () => { boom(); });\n");
		git("add", "other.test.ts"); // staged, but `git commit src/a.ts` won't commit it
		const snap = materializeIndexSnapshot(repo, false, ["src/a.ts"], ["src/a.ts"], "head");
		expect(snap).not.toBeNull();
		try {
			expect(readFileSync(join(snap?.root ?? "", "src/a.ts"), "utf-8")).toContain("NEW");
			expect(existsSync(join(snap?.root ?? "", "other.test.ts"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});

	it("HEAD base: unrelated tracked files show HEAD content, not staged edits", () => {
		writeRepo("src/b.ts", "export const b = 'HEAD';\n");
		git("add", "src/b.ts");
		git("commit", "-qm", "add b");
		writeRepo("src/b.ts", "export const b = 'STAGED-ONLY';\n");
		git("add", "src/b.ts"); // staged change git commit src/a.ts will NOT pick up
		writeRepo("src/a.ts", "export const a = 'NEW';\n");
		const snap = materializeIndexSnapshot(repo, false, ["src/a.ts"], ["src/a.ts"], "head");
		expect(snap).not.toBeNull();
		try {
			expect(readFileSync(join(snap?.root ?? "", "src/a.ts"), "utf-8")).toContain("NEW");
			expect(readFileSync(join(snap?.root ?? "", "src/b.ts"), "utf-8")).toContain("HEAD");
		} finally {
			snap?.cleanup();
		}
	});

	it("HEAD base: returns null when the repo has no HEAD (caller falls back to the worktree)", () => {
		const fresh = mkdtempSync(join(tmpdir(), "staged-snap-nohead-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: fresh });
			writeFileSync(join(fresh, "a.ts"), "export const a = 1;\n");
			execFileSync("git", ["add", "a.ts"], { cwd: fresh });
			expect(materializeIndexSnapshot(fresh, false, ["a.ts"], undefined, "head")).toBeNull();
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("mixed scopes: an add-staged dir keeps untracked files, a tracked-only dir does not", () => {
		writeRepo("lib/b.ts", "export const b = 1;\n");
		git("add", "lib/b.ts");
		git("commit", "-qm", "add lib");
		writeRepo("src/sneaky.test.ts", "it('x', () => {});\n"); // untracked under tracked-only scope
		writeRepo("lib/new.ts", "export const n = 1;\n"); // untracked under add-staged scope
		const snap = materializeIndexSnapshot(repo, false, ["src", "lib"], ["src"]);
		expect(snap).not.toBeNull();
		try {
			expect(existsSync(join(snap?.root ?? "", "src/sneaky.test.ts"))).toBe(false);
			expect(existsSync(join(snap?.root ?? "", "lib/new.ts"))).toBe(true);
		} finally {
			snap?.cleanup();
		}
	});
});

// A malformed git pathspec magic makes the underlying `git ls-files` call
// fail (exit 128). gitLines() must swallow that and return [] rather than
// propagating — overlayTrackedScope then simply overlays nothing, and the
// snapshot as a whole still succeeds (fail-safe, not fail-closed).
describe("materializeIndexSnapshot — gitLines failure fail-safe", () => {
	it("a malformed tracked-only pathspec fails the underlying git call without aborting the snapshot", () => {
		writeRepo("src/a.ts", "export const a = 1;\n");
		git("add", "src/a.ts");
		git("commit", "-qm", "baseline");
		const badPathspec = ":(icase,malformed";
		const snap = materializeIndexSnapshot(repo, false, [badPathspec], [badPathspec]);
		expect(snap).not.toBeNull();
		snap?.cleanup();
	});
});

// Symlink re-materialization (finding 2026-06): a copy-through of a TRACKED
// symlink would follow both the source and destination link and corrupt the
// old external target's content, so each overlay path must re-create the
// symlink itself via readlink + symlink rather than copying bytes.
describe("materializeIndexSnapshot — tracked symlink re-pointing", () => {
	beforeEach(() => {
		mkdirSync(join(repo, "src"), { recursive: true });
		symlinkSync("target-a", join(repo, "src/link.ts"));
		git("add", "src/link.ts");
		git("commit", "-qm", "add tracked symlink");
	});

	it("-a mode: a repointed tracked symlink is re-created with the NEW target", () => {
		rmSync(join(repo, "src/link.ts"));
		symlinkSync("target-b", join(repo, "src/link.ts")); // tracked, unstaged repoint

		const snap = materializeIndexSnapshot(repo, true);
		expect(snap).not.toBeNull();
		try {
			const snapLink = join(snap?.root ?? "", "src/link.ts");
			const st = lstatSync(snapLink);
			expect(st.isSymbolicLink()).toBe(true);
			expect(readlinkSync(snapLink)).toBe("target-b");
		} finally {
			snap?.cleanup();
		}
	});

	it("narrow constructed path: a repointed tracked symlink is re-created with the NEW target", () => {
		rmSync(join(repo, "src/link.ts"));
		symlinkSync("target-c", join(repo, "src/link.ts"));

		const snap = materializeIndexSnapshot(repo, false, ["src/link.ts"]);
		expect(snap).not.toBeNull();
		try {
			const snapLink = join(snap?.root ?? "", "src/link.ts");
			const st = lstatSync(snapLink);
			expect(st.isSymbolicLink()).toBe(true);
			expect(readlinkSync(snapLink)).toBe("target-c");
		} finally {
			snap?.cleanup();
		}
	});

	it("tracked-only pathspec scope: a repointed tracked symlink is re-created with the NEW target", () => {
		rmSync(join(repo, "src/link.ts"));
		symlinkSync("target-d", join(repo, "src/link.ts"));

		const snap = materializeIndexSnapshot(repo, false, ["src"], ["src"]);
		expect(snap).not.toBeNull();
		try {
			const snapLink = join(snap?.root ?? "", "src/link.ts");
			const st = lstatSync(snapLink);
			expect(st.isSymbolicLink()).toBe(true);
			expect(readlinkSync(snapLink)).toBe("target-d");
		} finally {
			snap?.cleanup();
		}
	});
});

// -a mode must also stage TRACKED FILE DELETIONS, not just modifications.
describe("materializeIndexSnapshot — -a mode tracked deletion", () => {
	it("a tracked file deleted in the worktree (unstaged) is removed from the -a snapshot", () => {
		writeRepo("src/gone.ts", "export const g = 1;\n");
		git("add", "src/gone.ts");
		git("commit", "-qm", "add gone.ts");
		rmSync(join(repo, "src/gone.ts")); // tracked deletion, unstaged — -a WILL stage it

		const snap = materializeIndexSnapshot(repo, true);
		expect(snap).not.toBeNull();
		try {
			expect(existsSync(join(snap?.root ?? "", "src/gone.ts"))).toBe(false);
		} finally {
			snap?.cleanup();
		}
	});
});
