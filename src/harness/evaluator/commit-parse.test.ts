import { describe, expect, it } from "vitest";
import { isGitPushCommand, parseGitCommit } from "./commit-parse.js";

describe("parseGitCommit", () => {
	it("detects `git commit -m x`", () => {
		expect(parseGitCommit('git commit -m "fix"')).toEqual({ isCommit: true, noVerify: false });
	});

	it("detects `git commit -am x` and `git commit --amend`", () => {
		expect(parseGitCommit('git commit -am "wip"')?.isCommit).toBe(true);
		expect(parseGitCommit("git commit --amend")?.isCommit).toBe(true);
	});

	it("detects `git commit` with no flags (bare staged commit)", () => {
		expect(parseGitCommit("git commit")?.isCommit).toBe(true);
	});

	it("detects a commit in a compound command (cd x && git commit -m y)", () => {
		expect(parseGitCommit('cd repo && git commit -m "x"')?.isCommit).toBe(true);
	});

	it("detects a commit piped/sequenced after another command", () => {
		expect(parseGitCommit('git add -A; git commit -m "x"')?.isCommit).toBe(true);
		expect(parseGitCommit('echo hi || git commit -m "x"')?.isCommit).toBe(true);
	});

	it("detects commit after a `git -C dir` / `-c key=val` global flag run", () => {
		expect(parseGitCommit("git -C /repo commit -m x")?.isCommit).toBe(true);
		expect(parseGitCommit("git -c user.name=x commit -m y")?.isCommit).toBe(true);
		expect(parseGitCommit("git --no-pager commit -m y")?.isCommit).toBe(true);
	});

	it("detects commit through a leading sudo / env / VAR= prefix", () => {
		expect(parseGitCommit("sudo git commit -m x")?.isCommit).toBe(true);
		expect(parseGitCommit("GIT_AUTHOR_NAME=x git commit -m y")?.isCommit).toBe(true);
		expect(parseGitCommit("env FOO=bar git commit -m z")?.isCommit).toBe(true);
	});

	it("detects commit via an absolute git path (/usr/bin/git)", () => {
		expect(parseGitCommit("/usr/bin/git commit -m x")?.isCommit).toBe(true);
	});

	it("flags --no-verify (and -n) as a bypass", () => {
		expect(parseGitCommit("git commit -m x --no-verify")).toEqual({
			isCommit: true,
			noVerify: true,
		});
		expect(parseGitCommit("git commit -n -m x")?.noVerify).toBe(true);
	});

	it("does NOT treat the message text as a bypass when it contains --no-verify", () => {
		// The `--no-verify` lives inside the quoted message, not as a flag.
		expect(parseGitCommit('git commit -m "mention --no-verify in msg"')?.noVerify).toBe(false);
	});

	it("does NOT split on a `&&` inside the quoted commit message", () => {
		// If the splitter naively broke on `&&`, the segment after it would be
		// `b"` (not a git commit) — but the whole `git commit -m "a && b"` is one.
		const parsed = parseGitCommit('git commit -m "feat: a && b"');
		expect(parsed?.isCommit).toBe(true);
		expect(parsed?.noVerify).toBe(false);
	});

	it("ignores non-commit git verbs (status / log / diff / show)", () => {
		expect(parseGitCommit("git status")).toBeNull();
		expect(parseGitCommit("git log --oneline")).toBeNull();
		expect(parseGitCommit("git diff HEAD")).toBeNull();
		expect(parseGitCommit("git show")).toBeNull();
	});

	it("ignores a `# git commit` comment and non-git binaries", () => {
		expect(parseGitCommit("# git commit -m x")).toBeNull();
		expect(parseGitCommit("echo git commit")).toBeNull();
	});

	it("does not false-positive on `git commit-graph` (exact subcommand match)", () => {
		expect(parseGitCommit("git commit-graph write")).toBeNull();
	});

	it("returns null for empty / non-string input", () => {
		expect(parseGitCommit("")).toBeNull();
		expect(parseGitCommit("   ")).toBeNull();
	});
});

describe("parseGitCommit — effective working directory (finding 4)", () => {
	it("a plain `git commit` carries no cwd override", () => {
		expect(parseGitCommit("git commit -m x")?.cwd).toBeUndefined();
	});

	it("captures a `cd <dir> && git commit` redirect", () => {
		expect(parseGitCommit("cd packages/api && git commit -m x")?.cwd).toBe("packages/api");
	});

	it("captures a `git -C <dir> commit` redirect", () => {
		expect(parseGitCommit("git -C packages/api commit -m x")?.cwd).toBe("packages/api");
	});

	it("compounds a `cd` chain like the shell does", () => {
		expect(parseGitCommit("cd a && cd b && git commit -m x")?.cwd).toBe("a/b");
	});

	it("compounds `cd` with a relative `-C`", () => {
		expect(parseGitCommit("cd a && git -C b commit -m x")?.cwd).toBe("a/b");
	});

	it("compounds multiple `-C` flags (git semantics)", () => {
		expect(parseGitCommit("git -C a -C b commit -m x")?.cwd).toBe("a/b");
	});

	it("an absolute `-C` / `cd` replaces the accumulated prefix", () => {
		expect(parseGitCommit("cd a && git -C /srv/repo commit -m x")?.cwd).toBe("/srv/repo");
		expect(parseGitCommit("cd /srv/repo && git commit -m x")?.cwd).toBe("/srv/repo");
	});

	it("normalizes `..` in a `cd` redirect", () => {
		expect(parseGitCommit("cd a/b && cd ../c && git commit -m x")?.cwd).toBe("a/c");
	});

	it("leaves cwd undefined for an unresolvable redirect (variable / glob / `cd -` / `cd ~`)", () => {
		// Non-literal targets can't be resolved statically → fall back to the shell
		// cwd rather than treat `$SUBDIR` as a real directory.
		expect(parseGitCommit("cd $SUBDIR && git commit -m x")?.cwd).toBeUndefined();
		expect(parseGitCommit("git -C $SUBDIR commit -m x")?.cwd).toBeUndefined();
		expect(parseGitCommit("cd - && git commit -m x")?.cwd).toBeUndefined();
		expect(parseGitCommit("cd ~/repo && git commit -m x")?.cwd).toBeUndefined();
	});

	it("still recognizes the commit while capturing the redirect (isCommit unaffected)", () => {
		const parsed = parseGitCommit("cd sub && git commit --no-verify -m x");
		expect(parsed?.isCommit).toBe(true);
		expect(parsed?.noVerify).toBe(true);
		expect(parsed?.cwd).toBe("sub");
	});
});

describe("parseGitCommit — -a / --all detection (finding 3)", () => {
	it("a plain `git commit` is not `all`", () => {
		expect(parseGitCommit("git commit -m x")?.all).toBeUndefined();
	});

	it("detects `-a`, `--all`, and the `-am` short cluster", () => {
		expect(parseGitCommit("git commit -a -m x")?.all).toBe(true);
		expect(parseGitCommit("git commit --all -m x")?.all).toBe(true);
		expect(parseGitCommit('git commit -am "msg"')?.all).toBe(true);
	});

	it("does NOT treat `-m` or `--amend` as `all`", () => {
		expect(parseGitCommit("git commit -m x")?.all).toBeUndefined();
		expect(parseGitCommit("git commit --amend --no-edit")?.all).toBeUndefined();
	});
});

describe("parseGitCommit — constructsContent (finding 4: preceding add / pathspec)", () => {
	it("a plain or -a commit does NOT construct content", () => {
		expect(parseGitCommit("git commit -m x")?.constructsContent).toBeUndefined();
		expect(parseGitCommit("git commit -am x")?.constructsContent).toBeUndefined();
	});

	it("a preceding `git add` constructs content", () => {
		expect(parseGitCommit("git add -A && git commit -m x")?.constructsContent).toBe(true);
		expect(parseGitCommit("git add . && git commit")?.constructsContent).toBe(true);
		expect(parseGitCommit("git add src/x.ts && git commit -m x")?.constructsContent).toBe(true);
	});

	it("a pathspec commit constructs content", () => {
		expect(parseGitCommit("git commit src/x.ts -m x")?.constructsContent).toBe(true);
		expect(parseGitCommit("git commit -m x src/x.ts")?.constructsContent).toBe(true);
		expect(parseGitCommit("git commit -- src/x.ts")?.constructsContent).toBe(true);
	});

	it("does NOT mistake a -m / -am / -F message-or-file value for a pathspec", () => {
		expect(parseGitCommit('git commit -m "a message"')?.constructsContent).toBeUndefined();
		expect(parseGitCommit('git commit -am "a message"')?.constructsContent).toBeUndefined();
		expect(parseGitCommit("git commit -F msg.txt")?.constructsContent).toBeUndefined();
	});
});

describe("parseGitCommit — constructedPaths (finding 6: narrow vs broad) + pathspec-from-file (finding 7)", () => {
	it("a NARROW `git add <path>` restricts to that path", () => {
		expect(parseGitCommit("git add src/a.ts && git commit -m x")?.constructedPaths).toEqual(["src/a.ts"]);
		expect(parseGitCommit("git add src/a.ts src/b.ts && git commit")?.constructedPaths).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("a commit PATHSPEC restricts to that path", () => {
		expect(parseGitCommit("git commit src/a.ts -m x")?.constructedPaths).toEqual(["src/a.ts"]);
		expect(parseGitCommit("git commit -- src/a.ts src/b.ts")?.constructedPaths).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("a BROAD stage (bare -A/-u) carries NO constructedPaths (the whole worktree is committed)", () => {
		expect(parseGitCommit("git add -A && git commit -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git add -u && git commit -m x")?.constructedPaths).toBeUndefined();
	});

	// Round 4 (finding 2026-06): `-A`/`-u` WITH a pathspec stage only that scope,
	// and `.` is an ordinary cwd-relative pathspec — treating them as whole-worktree
	// made the gate evaluate the entire repository, so unrelated files could
	// false-block the commit or supply coverage the commit does not contain.
	it("-A/-u WITH a pathspec stay scoped to it", () => {
		expect(parseGitCommit("git add -A src/ && git commit -m x")?.constructedPaths).toEqual(["src/"]);
		expect(parseGitCommit("git add --all src && git commit -m x")?.constructedPaths).toEqual(["src"]);
		expect(parseGitCommit("git add -u src && git commit -m x")?.constructedPaths).toEqual(["src"]);
	});

	it("`git add .` surfaces the cwd-relative pathspec for the gate's rebase to scope", () => {
		// From the repo root the rebase resolves `.` to the root → broad (unchanged
		// behavior); from a subdirectory it scopes to that subtree (the fix).
		const parsed = parseGitCommit("git add . && git commit");
		expect(parsed?.constructedPaths).toEqual(["."]);
		expect(parsed?.includesIndex).toBe(true);
	});

	it("`-u` add paths and commit pathspecs are tracked-only; plain adds are not", () => {
		expect(parseGitCommit("git add -u src && git commit -m x")?.trackedOnlyPaths).toEqual(["src"]);
		expect(parseGitCommit("git commit src/a.ts -m x")?.trackedOnlyPaths).toEqual(["src/a.ts"]);
		expect(parseGitCommit("git commit -- src")?.trackedOnlyPaths).toEqual(["src"]);
		expect(parseGitCommit("git add src && git commit -m x")?.trackedOnlyPaths).toBeUndefined();
		expect(parseGitCommit("git add . && git commit")?.trackedOnlyPaths).toBeUndefined();
	});

	// Round 5: a plain add BENEATH a tracked-only scope must not widen the whole
	// scope to a raw copy — the dir stays tracked-only and the child path rides
	// in constructedPaths with its own full overlay, so unrelated untracked
	// files the command never stages cannot supply coverage.
	it("keeps the dir tracked-only when a plain add stages a CHILD beneath it", () => {
		const parsed = parseGitCommit("git add -u src && git add src/new.test.ts && git commit -m x");
		expect(parsed?.constructedPaths).toEqual(["src", "src/new.test.ts"]);
		expect(parsed?.trackedOnlyPaths).toEqual(["src"]);
	});

	it("surfaces a child add under a commit pathspec for its own full overlay", () => {
		const parsed = parseGitCommit("git add src/new.ts && git commit src -m x");
		expect(parsed?.constructedPaths).toEqual(["src", "src/new.ts"]);
		expect(parsed?.trackedOnlyPaths).toEqual(["src"]);
	});

	it("a glob add under the commit pathspec degrades to broad (unknowable content)", () => {
		const parsed = parseGitCommit("git add 'src/*.gen.ts' && git commit src -m x");
		expect(parsed?.constructsContent).toBe(true);
		expect(parsed?.constructedPaths).toBeUndefined();
	});

	it("a plain add overlapping the pathspec keeps the full overlay (it stages untracked content)", () => {
		// The add makes the file tracked before the commit runs, so the commit DOES
		// contain its worktree content — tracked-only would evaluate stale state.
		expect(
			parseGitCommit("git add src/new.ts && git commit src/new.ts -m x")?.trackedOnlyPaths,
		).toBeUndefined();
		expect(
			parseGitCommit("git add src && git commit src/a.ts -m x")?.trackedOnlyPaths,
		).toBeUndefined();
		expect(
			parseGitCommit("git add -A && git commit src/a.ts -m x")?.trackedOnlyPaths,
		).toBeUndefined();
		// …but an unrelated plain add does not unmark the commit pathspec.
		expect(
			parseGitCommit("git add docs/readme.md && git commit --include src/b.ts -m x")?.trackedOnlyPaths,
		).toEqual(["src/b.ts"]);
	});

	it("`--pathspec-from-file` is a (broad) constructed-content commit, not a stale-index commit", () => {
		expect(parseGitCommit("git commit --pathspec-from-file=specs.txt")?.constructsContent).toBe(true);
		expect(parseGitCommit("git commit --pathspec-from-file specs.txt")?.constructsContent).toBe(true);
		// Broad → no specific paths (its pathspecs live in a file we don't read) —
		// for the SEPARATE-value form too: the file argument is consumed, never
		// misread as a pathspec (finding 2026-06).
		expect(parseGitCommit("git commit --pathspec-from-file=specs.txt")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git commit --pathspec-from-file specs.txt")?.constructedPaths).toBeUndefined();
	});

	// `git add --pathspec-from-file …` reads the REAL staged paths from a file a
	// static parse cannot see — the same indirection class as pip's `-r reqs.txt`.
	// Pre-fix the LIST FILE itself was recorded as the sole staged path, so the
	// gate evaluated files.txt and every source named inside bypassed (finding
	// 2026-06).
	it("`git add --pathspec-from-file <file> && git commit` is BROAD — the list file is not the path set", () => {
		const parsed = parseGitCommit("git add --pathspec-from-file files.txt && git commit -m x");
		expect(parsed?.constructsContent).toBe(true);
		expect(parsed?.constructedPaths).toBeUndefined();
		// A no-pathspec commit after an add still captures the whole index.
		expect(parsed?.includesIndex).toBe(true);
	});

	it("the `=` and stdin (`-`) forms of the add flag are equally BROAD", () => {
		expect(
			parseGitCommit("git add --pathspec-from-file=files.txt && git commit -m x")?.constructedPaths,
		).toBeUndefined();
		expect(
			parseGitCommit("git add --pathspec-from-file=- && git commit -m x")?.constructedPaths,
		).toBeUndefined();
	});

	it("a file merely NAMED like the flag stays a narrow add path (no dash prefix)", () => {
		expect(
			parseGitCommit("git add pathspec-from-file.txt && git commit -m x")?.constructedPaths,
		).toEqual(["pathspec-from-file.txt"]);
	});

	// `--trailer <token>` consumes its value: without that, the trailer text read
	// as a pathspec, the gate narrowed the changed set to a nonexistent path, and
	// every staged file bypassed enforcement (finding 2026-06).
	it("`--trailer` consumes its value — the trailer text is never a pathspec", () => {
		const parsed = parseGitCommit('git add src/a.ts && git commit --trailer "Reviewed-by: x" -m fix');
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]);
		expect(parsed?.includesIndex).toBe(true); // still a no-pathspec commit after an add
		// On a pathspec commit the REAL pathspec survives next to the trailer.
		expect(
			parseGitCommit('git commit --trailer "Helped-by: y" src/b.ts -m fix')?.constructedPaths,
		).toEqual(["src/b.ts"]);
		// Repeatable — each occurrence consumes its own value.
		expect(
			parseGitCommit('git commit --trailer "A: a" --trailer "B: b" -m fix')?.constructedPaths,
		).toBeUndefined();
	});

	// NON-LITERAL pathspecs are expanded by git/the shell at run time — an exact-match
	// filter would match NOTHING and the gate would silently evaluate no source. They
	// must therefore stay BROAD (constructedPaths absent ⇒ evaluate everything).
	it("a glob / variable / pathspec-magic spec is BROAD, never a literal filter", () => {
		expect(parseGitCommit("git add 'src/*.ts' && git commit -m x")?.constructsContent).toBe(true);
		expect(parseGitCommit("git add 'src/*.ts' && git commit -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git commit 'src/**' -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git commit src/file-?.ts -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git add $FILES && git commit -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git commit ':(icase)readme' -m x")?.constructedPaths).toBeUndefined();
		expect(parseGitCommit("git add ~/repo/a.ts && git commit -m x")?.constructedPaths).toBeUndefined();
	});

	// `-a` stages EVERY tracked modification — a preceding narrow add must not shrink
	// the evaluated set to just the added paths.
	it("`git add <path> && git commit -am x` is BROAD (the -a stages everything tracked)", () => {
		const parsed = parseGitCommit("git add src/a.ts && git commit -am x");
		expect(parsed?.constructsContent).toBe(true);
		expect(parsed?.all).toBe(true);
		expect(parsed?.constructedPaths).toBeUndefined(); // NOT narrowed to src/a.ts
	});

	it("a mixed literal+glob spec list is BROAD (one non-literal poisons the filter)", () => {
		expect(parseGitCommit("git add src/a.ts 'src/*.spec.ts' && git commit -m x")?.constructedPaths).toBeUndefined();
	});
});

// STAGED-BYPASS / --only SEMANTICS (finding 2026-06). `git add p && git commit`
// commits the WHOLE index (pre-staged files included) → `includesIndex`. A
// pathspec commit WITHOUT --include commits ONLY the named paths (git's --only
// default) → no includesIndex AND a preceding add's paths are excluded.
describe("parseGitCommit — includesIndex (--include / whole-index commits)", () => {
	it("`git add <path> && git commit` (no pathspec) commits the whole index → includesIndex", () => {
		const parsed = parseGitCommit("git add src/a.ts && git commit -m x");
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]);
		expect(parsed?.includesIndex).toBe(true);
	});

	it("a pathspec commit WITHOUT --include is git's --only default → NO includesIndex", () => {
		expect(parseGitCommit("git commit src/a.ts -m x")?.includesIndex).toBeUndefined();
		expect(parseGitCommit("git commit -- src/a.ts src/b.ts")?.includesIndex).toBeUndefined();
	});

	it("`--include` / `-i` (incl. a short cluster) marks the index as committed", () => {
		expect(parseGitCommit("git commit --include src/a.ts -m x")?.includesIndex).toBe(true);
		expect(parseGitCommit("git commit -i src/a.ts -m x")?.includesIndex).toBe(true);
		expect(parseGitCommit("git commit -im x src/a.ts")?.includesIndex).toBe(true);
	});

	it("an --include pathspec commit still carries its narrow constructedPaths", () => {
		expect(parseGitCommit("git commit --include src/a.ts -m x")?.constructedPaths).toEqual(["src/a.ts"]);
	});

	it("`git add a && git commit b` (--only default) excludes the add's path from the commit", () => {
		const parsed = parseGitCommit("git add src/a.ts && git commit src/b.ts -m x");
		expect(parsed?.constructedPaths).toEqual(["src/b.ts"]); // a.ts is staged but NOT committed
		expect(parsed?.includesIndex).toBeUndefined();
	});

	it("`git add a && git commit --include b` captures BOTH the pathspec and the add's path", () => {
		const parsed = parseGitCommit("git add src/a.ts && git commit --include src/b.ts -m x");
		expect(parsed?.constructedPaths).toEqual(["src/b.ts", "src/a.ts"]);
		expect(parsed?.includesIndex).toBe(true);
	});

	it("a broad `git add -A` does not poison an --only pathspec commit's narrow filter", () => {
		const parsed = parseGitCommit("git add -A && git commit src/a.ts -m x");
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]); // -A changed the index, not this commit
		expect(parsed?.includesIndex).toBeUndefined();
	});

	it("plain / -a / pathspec-from-file commits carry no includesIndex (their modes already cover the index)", () => {
		expect(parseGitCommit("git commit -m x")?.includesIndex).toBeUndefined();
		expect(parseGitCommit("git commit -am x")?.includesIndex).toBeUndefined();
		expect(parseGitCommit("git add src/a.ts && git commit --pathspec-from-file=f.txt")?.includesIndex).toBeUndefined();
	});

	it("`--interactive` is NOT --include (long flag matched exactly)", () => {
		expect(parseGitCommit("git commit --interactive src/a.ts")?.includesIndex).toBeUndefined();
	});
});

// ATTACHED OPTION VALUES (finding 2026-06). `git commit -mfix src/a.ts` is valid
// git: `-mfix` is `-m` with the value `fix` ATTACHED — not a flag cluster
// containing `i`. Mis-reading attached values as boolean letters set
// includesIndex/all spuriously and made the default-on commit gate evaluate (and
// block on) unrelated staged files.
describe("parseGitCommit — attached short-option values are not flag clusters", () => {
	it("`-mfix` does not set includesIndex (the i is part of the message)", () => {
		const parsed = parseGitCommit("git commit -mfix src/a.ts");
		expect(parsed?.isCommit).toBe(true);
		expect(parsed?.includesIndex).toBeUndefined();
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]);
	});

	it("`-mfair` does not set all (the a is part of the message)", () => {
		const parsed = parseGitCommit("git commit -mfair src/a.ts");
		expect(parsed?.all).toBeUndefined();
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]);
	});

	it("`-amfix` IS -a -m fix: all set, message attached, no next-token consumption", () => {
		const parsed = parseGitCommit("git commit -amfix");
		expect(parsed?.all).toBe(true);
		expect(parsed?.includesIndex).toBeUndefined();
	});

	it("boolean letters BEFORE the value-taker still count: `-im x` sets include", () => {
		const parsed = parseGitCommit("git commit -im x src/a.ts");
		expect(parsed?.includesIndex).toBe(true);
	});

	it("`-anm wip` consumes wip as the message and detects noVerify in the cluster", () => {
		const parsed = parseGitCommit("git commit -anm wip");
		expect(parsed?.all).toBe(true);
		expect(parsed?.noVerify).toBe(true);
	});

	it("`-S` (optional attached keyid) does NOT consume the next token as a value", () => {
		// `git commit -S file.ts` signs with the default key and commits file.ts.
		const parsed = parseGitCommit("git commit -S src/a.ts");
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]);
	});

	it("`-Skeyid` terminates the cluster: the keyid's letters are not flags", () => {
		// keyid "abc" contains 'a' — must not read as --all.
		const parsed = parseGitCommit("git commit -Sabc -m x");
		expect(parsed?.all).toBeUndefined();
		expect(parsed?.constructsContent).toBeUndefined();
	});

	it("`-uno` (optional attached untracked-mode) contributes no flags", () => {
		const parsed = parseGitCommit("git commit -uno -m x");
		expect(parsed?.all).toBeUndefined();
		expect(parsed?.includesIndex).toBeUndefined();
	});

	it("`--gpg-sign` does not swallow a pathspec", () => {
		const parsed = parseGitCommit("git commit --gpg-sign src/a.ts");
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]);
	});

	it("`-m fix` (separate value) still consumes exactly the message token", () => {
		const parsed = parseGitCommit("git commit -m fix src/a.ts");
		expect(parsed?.constructedPaths).toEqual(["src/a.ts"]);
		expect(parsed?.includesIndex).toBeUndefined();
	});
});

describe("isGitPushCommand", () => {
	it("detects a plain `git push`", () => {
		expect(isGitPushCommand("git push")).toBe(true);
	});

	it("detects `git push` with args and a remote/branch", () => {
		expect(isGitPushCommand("git push origin main")).toBe(true);
		expect(isGitPushCommand("git push --force-with-lease")).toBe(true);
	});

	it("detects `git -C repo push` (global flag before subcommand)", () => {
		expect(isGitPushCommand("git -C repo push")).toBe(true);
	});

	it("detects a push in a later `&&` segment", () => {
		expect(isGitPushCommand('git commit -m "x" && git push')).toBe(true);
		expect(isGitPushCommand("cd repo && git push origin main")).toBe(true);
	});

	it("does NOT match a push inside a comment", () => {
		expect(isGitPushCommand("# git push")).toBe(false);
		expect(isGitPushCommand("echo done  # then git push")).toBe(false);
	});

	it("does NOT match a quoted `git push` string", () => {
		expect(isGitPushCommand('echo "git push"')).toBe(false);
	});

	it("does NOT match near-misses (`git pushd`, plain `commit`, non-git binaries)", () => {
		expect(isGitPushCommand("git pushd")).toBe(false);
		expect(isGitPushCommand("git commit -m x")).toBe(false);
		expect(isGitPushCommand("npm push")).toBe(false);
	});

	it("rejects empty / non-string input", () => {
		expect(isGitPushCommand("")).toBe(false);
		expect(isGitPushCommand(undefined)).toBe(false);
	});
});
