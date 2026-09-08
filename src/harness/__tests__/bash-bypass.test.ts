// Tests for detectBashCodeFileWrite — the shell-redirect bypass detector.
// Ensures agents can't route around the content-quality gate by using Bash.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBashCodeFileWrite, resolveBashWriteTarget } from "../pre-checks.js";

describe("detectBashCodeFileWrite", () => {
	describe("detects redirection to code files", () => {
		it("heredoc: cat > file.ts << EOF", () => {
			const cmd = "cat > src/foo.ts << 'EOF'\nconst x = 1;\nEOF";
			const hit = detectBashCodeFileWrite(cmd);
			expect(hit).not.toBeNull();
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("echo > file.ts", () => {
			const hit = detectBashCodeFileWrite('echo "const x = 1;" > src/app.tsx');
			expect(hit?.target).toBe("src/app.tsx");
		});

		it("appending: echo >> file.js", () => {
			const hit = detectBashCodeFileWrite("echo 'const y = 2;' >> lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});

		it("printf > file.py", () => {
			const hit = detectBashCodeFileWrite("printf 'print(1)' > foo.py");
			expect(hit?.target).toBe("foo.py");
		});

		it("quoted target: cat > 'src/has spaces.ts'", () => {
			const hit = detectBashCodeFileWrite("cat > 'src/my file.ts' << EOF\nx\nEOF");
			expect(hit?.target).toBe("src/my file.ts");
		});
	});

	describe("detects tee", () => {
		it("tee file.ts", () => {
			const hit = detectBashCodeFileWrite("echo 'x' | tee src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("tee -a file.ts", () => {
			const hit = detectBashCodeFileWrite("echo 'x' | tee -a src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});
	});

	describe("detects sed -i (in-place edit)", () => {
		it("sed -i on ts file", () => {
			const hit = detectBashCodeFileWrite("sed -i 's/foo/bar/' src/app.ts");
			expect(hit?.target).toBe("src/app.ts");
		});
	});

	describe("detects inline interpreter writes", () => {
		it("node -e fs.writeFileSync to .ts", () => {
			const hit = detectBashCodeFileWrite(
				`node -e "require('fs').writeFileSync('src/app.ts', 'const x = 1;')"`,
			);
			expect(hit?.target).toBe("src/app.ts");
		});

		it("python -c open+write to .py", () => {
			const hit = detectBashCodeFileWrite(
				`python3 -c "open('foo.py','w').write('print(1)')"`,
			);
			expect(hit?.target).toBe("foo.py");
		});
	});

	describe("detects cp / mv into tracked files", () => {
		it("cp /tmp/x.ts src/foo.ts", () => {
			const hit = detectBashCodeFileWrite("cp /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("mv /tmp/y.js lib/util.js", () => {
			const hit = detectBashCodeFileWrite("mv /tmp/y.js lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});

		// `-T` (--no-target-directory) is a boolean flag, NOT a flag that
		// consumes the next argument. Regression test for the bypass where
		// `cp -T /tmp/x src/foo.ts` was misparsed as `cp -T <value> src/foo.ts`
		// and the destination got eaten, leaving only one positional and
		// silently allowing the write.
		it("cp -T /tmp/x.ts src/foo.ts (boolean -T must not consume the source)", () => {
			const hit = detectBashCodeFileWrite("cp -T /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("mv -T /tmp/y.js lib/util.js (boolean -T)", () => {
			const hit = detectBashCodeFileWrite("mv -T /tmp/y.js lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});

		// `-t DIR` does take an arg — the destination is the LAST positional
		// only when there's no -t. Confirm the parser still flags when the
		// short-form `-t` is used.
		it("cp -t lib /tmp/a.js (lowercase -t takes an arg, lib is destination)", () => {
			const hit = detectBashCodeFileWrite("cp -t lib /tmp/a.js");
			// "lib" is consumed as the -t argument, "/tmp/a.js" is the source,
			// and there is no second positional — so the detector should return
			// null (no protected destination resolvable).
			expect(hit).toBe(null);
		});
	});

	describe("detects link / install / dd / rsync / scp into tracked files", () => {
		it("ln src dst (hard link)", () => {
			const hit = detectBashCodeFileWrite("ln /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("ln -s src dst (symlink)", () => {
			const hit = detectBashCodeFileWrite("ln -s /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("install src dst (install copies + sets mode)", () => {
			const hit = detectBashCodeFileWrite("install -m 644 /tmp/x.py src/foo.py");
			expect(hit?.target).toBe("src/foo.py");
		});

		it("dd if= of= (block-level copy)", () => {
			const hit = detectBashCodeFileWrite("dd if=/tmp/x.ts of=src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("rsync src dst", () => {
			const hit = detectBashCodeFileWrite("rsync -a /tmp/y.js lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});

		it("scp local local (local-to-local form)", () => {
			const hit = detectBashCodeFileWrite("scp /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});
	});

	describe("detects writes to `.graph.*` Supermodel shards (any verb)", () => {
		it("cp into a .graph.ts shard", () => {
			const hit = detectBashCodeFileWrite("cp /tmp/x.txt src/harness/foo.graph.ts");
			expect(hit?.target).toBe("src/harness/foo.graph.ts");
		});

		it("mv into a .graph.go shard", () => {
			const hit = detectBashCodeFileWrite("mv /tmp/x.txt internal/foo.graph.go");
			expect(hit?.target).toBe("internal/foo.graph.go");
		});

		it("ln into a .graph.js shard", () => {
			const hit = detectBashCodeFileWrite("ln /tmp/x src/foo.graph.js");
			expect(hit?.target).toBe("src/foo.graph.js");
		});

		it("rsync into a .graph.py shard", () => {
			const hit = detectBashCodeFileWrite("rsync -a /tmp/x src/foo.graph.py");
			expect(hit?.target).toBe("src/foo.graph.py");
		});

		it("dd if= of= a .graph.ts shard", () => {
			const hit = detectBashCodeFileWrite("dd if=/tmp/x of=src/foo.graph.ts");
			expect(hit?.target).toBe("src/foo.graph.ts");
		});

		it("compound: cp ... && touch — still catches the cp", () => {
			const hit = detectBashCodeFileWrite(
				"cp /tmp/x.txt src/harness/break-glass.graph.ts && touch -r src/harness/break-glass.ts src/harness/break-glass.graph.ts",
			);
			expect(hit?.target).toBe("src/harness/break-glass.graph.ts");
		});
	});

	describe("allows legitimate shell operations", () => {
		it("doesn't flag redirects to non-code files", () => {
			expect(detectBashCodeFileWrite("echo 'log entry' > /tmp/log.txt")).toBeNull();
			expect(detectBashCodeFileWrite("echo 'data' > output.csv")).toBeNull();
			expect(detectBashCodeFileWrite("cat > config.json << EOF\n{}\nEOF")).toBeNull();
		});

		it("doesn't flag stderr/stdout fd redirection", () => {
			expect(detectBashCodeFileWrite("npm test 2>&1")).toBeNull();
			expect(detectBashCodeFileWrite("npm test &> log.txt")).toBeNull();
		});

		it("doesn't flag reads from code files", () => {
			expect(detectBashCodeFileWrite("cat src/app.ts")).toBeNull();
			expect(detectBashCodeFileWrite("grep 'foo' src/*.ts")).toBeNull();
		});

		it("doesn't flag builds/tests that output to dist/", () => {
			expect(detectBashCodeFileWrite("tsc --outDir dist")).toBeNull();
			expect(detectBashCodeFileWrite("npm run build")).toBeNull();
		});

		it("doesn't flag sed WITHOUT -i (reads, prints to stdout)", () => {
			expect(detectBashCodeFileWrite("sed 's/foo/bar/' src/app.ts")).toBeNull();
		});

		it("doesn't mistake sed -n reads across multiple commands for sed -i", () => {
			expect(
				detectBashCodeFileWrite(
					"sed -n '200,250p' src/lib/__tests__/hook-installers.test.ts && sed -n '35,75p' src/lib/codex-feature-flag.test.ts",
				),
			).toBeNull();
		});

		it("returns null on empty command", () => {
			expect(detectBashCodeFileWrite("")).toBeNull();
		});
	});

	// Regression: `interlinked write` self-gates via its own content-quality
	// pipeline, so the bash redirect detector must let it through rather than
	// double-gating. See the design doc:
	// `docs/design/bash-writes-through-content-gates.md`.
	describe("allows `interlinked write` through", () => {
		it("single-file with --stdin", () => {
			expect(
				detectBashCodeFileWrite("cat newcontent.ts | interlinked write src/foo.ts --stdin"),
			).toBeNull();
		});

		it("single-file with --from-file", () => {
			expect(
				detectBashCodeFileWrite("interlinked write src/app.ts --from-file /tmp/new.ts"),
			).toBeNull();
		});

		it("batch mode", () => {
			expect(
				detectBashCodeFileWrite("interlinked write --batch /tmp/manifest.json"),
			).toBeNull();
		});

		it("still blocks naive node -e fs.writeFileSync on the same line (no allowlist)", () => {
			// A command that has `interlinked write` as a SUBSTRING inside an
			// unrelated inline write should NOT be allowed. The allowlist only
			// kicks in when the command actually starts or contains a real
			// `interlinked write` invocation. Here we make sure `node -e ...`
			// still fires by using a node one-liner with no `interlinked write`
			// present.
			const hit = detectBashCodeFileWrite(
				`node -e "require('fs').writeFileSync('src/app.ts', 'x')"`,
			);
			expect(hit).not.toBeNull();
		});
	});

	describe("root confinement (2026-07-06 dogfood FP: scratchpad probe blocked as 'tracked')", () => {
		const ROOT = "/Users/dev/project";

		it("allows a redirect to an out-of-repo scratchpad path when a root is provided", () => {
			const hit = detectBashCodeFileWrite(
				"printf 'x' > /private/tmp/claude-501/session/scratchpad/probe.mts",
				ROOT,
			);
			expect(hit).toBeNull();
		});

		it("allows tee / cp / dd landing outside the project root", () => {
			expect(detectBashCodeFileWrite("make | tee /tmp/build-log.ts", ROOT)).toBeNull();
			expect(detectBashCodeFileWrite("cp src/a.ts /tmp/elsewhere/a.ts", ROOT)).toBeNull();
			expect(detectBashCodeFileWrite("dd if=src/a.ts of=/tmp/out.ts", ROOT)).toBeNull();
		});

		it("treats ~ as the home directory, not a repo-relative path", () => {
			expect(detectBashCodeFileWrite("echo hi > ~/notes/snippet.ts", ROOT)).toBeNull();
		});

		it("still blocks in-repo targets — relative and absolute forms", () => {
			expect(detectBashCodeFileWrite("echo bad > src/foo.ts", ROOT)?.target).toBe("src/foo.ts");
			expect(detectBashCodeFileWrite(`echo bad > ${ROOT}/src/foo.ts`, ROOT)?.target).toBe(
				`${ROOT}/src/foo.ts`,
			);
		});

		it("still blocks the second segment when the first writes out-of-repo", () => {
			const hit = detectBashCodeFileWrite(
				"echo a > /tmp/scratch.ts && echo b > src/real.ts",
				ROOT,
			);
			expect(hit?.target).toBe("src/real.ts");
		});

		it("preserves the historical conservative reach when no root is available", () => {
			expect(detectBashCodeFileWrite("echo x > /tmp/anywhere.ts")).not.toBeNull();
		});

		it("does not let a path-traversal target dodge the guard", () => {
			// Resolves back INSIDE the root → still blocked.
			expect(
				detectBashCodeFileWrite(`echo x > ${ROOT}/../project/src/foo.ts`, ROOT),
			).not.toBeNull();
		});
	});

	describe("variable + cd resolution (2026-07-09 dogfood FP: `> $SCRATCH/x.ts` blocked as tracked)", () => {
		const ROOT = "/Users/dev/project";
		const SCRATCHPAD = "/private/tmp/claude-501/-Users-dev-project/sess-1/scratchpad";

		it("expands a same-command assignment pointing OUT of the repo (the real block)", () => {
			const cmd = `SCRATCH=${SCRATCHPAD}\nmkdir -p $SCRATCH\ncat > $SCRATCH/schema-draft.ts <<'EOF'\nexport {};\nEOF`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("expands the ${VAR} braces form the same way", () => {
			const cmd = `SCRATCH="${SCRATCHPAD}" && echo x > \${SCRATCH}/probe.mts`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("still blocks when the variable expands INTO the repo", () => {
			const hit = detectBashCodeFileWrite("SRC=src && echo bad > $SRC/index.ts", ROOT);
			expect(hit?.target).toBe("$SRC/index.ts");
		});

		it("treats an unresolvable variable as not provably in-root (passes through)", () => {
			expect(detectBashCodeFileWrite("echo x > $UNKNOWN_DIR/probe.ts", ROOT)).toBeNull();
		});

		it("keeps the no-root conservative reach for variable targets", () => {
			expect(detectBashCodeFileWrite("echo x > $ANYWHERE/a.ts")).not.toBeNull();
		});

		it("expands $HOME from the process environment", () => {
			// Out of the repo whether HOME resolves (real home) or not (unresolvable).
			expect(detectBashCodeFileWrite("echo hi > $HOME/notes/snippet.ts", ROOT)).toBeNull();
		});

		it("resolves relative targets against a same-command cd OUT of the repo", () => {
			const cmd = `cd ${SCRATCHPAD} && echo x > probe.ts`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("follows cd $VAR into an out-of-repo dir", () => {
			const cmd = `SCRATCH=${SCRATCHPAD}\ncd $SCRATCH\necho x > probe.ts`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("still blocks a relative write after cd to an in-repo subdirectory", () => {
			const hit = detectBashCodeFileWrite("cd src && echo bad > util.ts", ROOT);
			expect(hit?.target).toBe("util.ts");
		});
	});
});

describe("root confinement — braced-variable-with-default cd targets (2026-07-24 FP)", () => {
	const ROOT = "/repo";

	it("cd into an unset-var colon-dash default resolves OUT of root — no hit", () => {
		// Pre-fix, the braced-with-default form fell through both branches of the
		// leading-variable regex, was treated as a LITERAL path, and resolved to
		// <root>/…-with-default/… — "inside" the repo — blocking a tmp-fixture write.
		const cmd = 'cd "${ILK_UNSET_ABC:-/tmp}/fx" && printf x > probe.js';
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("a same-command assignment beats the default (out-of-root value) — no hit", () => {
		const cmd = 'D=/elsewhere; cd "${D:-/repo}" && echo x > p.ts';
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("a same-command assignment beats the default (in-root value) — hit", () => {
		const cmd = 'X=/repo/sub; cd "${X:-/tmp}" && echo q > p.ts';
		expect(detectBashCodeFileWrite(cmd, ROOT)?.target).toBe("p.ts");
	});

	it("an unmodeled braced-operator form is unresolvable, not a literal — no hit", () => {
		const cmd = 'cd "${SOMEVAR%suffix}/x" && echo y > p.ts';
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("resolveBashWriteTarget expands the colon-dash default end-to-end", () => {
		const cmd = 'cd "${ILK_UNSET_ZZZ:-/t}/a" && echo x > f.ts';
		expect(resolveBashWriteTarget(cmd, "f.ts", ROOT)).toBe("/t/a/f.ts");
	});
});

// ===========================================================================
// Mutation-kill hardening (fleet-r2 wave): exact-behavior boundary cases for
// pre-checks-bash-write-detect.ts, each proven against a shadow-mutated copy
// of the module (scratch/probes/r2-bwd-driver.mts + r2-bwd-equivalence-fuzz.mts).
// Grouped by which internal function's boundary they pin.
// ===========================================================================

describe("withinGuardedRoot boundary: target resolves to the root itself", () => {
	it("P: a write target equal to the project root path IS in-root (abs === root, not just startsWith)", () => {
		// Root's own name happens to carry a code extension so it can be a
		// write target in its own right — pins the `abs === root` disjunct
		// (as opposed to only `abs.startsWith(root + sep)`).
		const hit = detectBashCodeFileWrite("echo x > /repo.ts", "/repo.ts");
		expect(hit?.target).toBe("/repo.ts");
		expect(hit?.mechanism).toContain("shell redirect");
	});
});

describe("resolveTargetForRootCheck boundary: bare ~ resolves to the REAL home dir", () => {
	const ROOT = "/Users/dev/project";

	it("N: `cd ~` (bare tilde, no trailing content) escapes the root — not a literal '~' subdir", () => {
		// A bare "~" must take the `expanded === "~"` branch (home-dir
		// resolution), not fall through to being resolved as a literal
		// relative path segment under the previous base.
		expect(detectBashCodeFileWrite("cd ~ && echo x > note.ts", ROOT)).toBeNull();
	});
});

describe("resolveVariableValue boundary: a defined-but-empty value must not win over a fallback", () => {
	const ROOT = "/Users/dev/project";

	it("P: X=\"\" with a colon-dash default uses the DEFAULT, not the empty assignment", () => {
		const hit = detectBashCodeFileWrite('X="" && echo bad > ${X:-fallback}/f.ts', ROOT);
		expect(hit?.target).toBe("${X:-fallback}/f.ts");
	});

	it("N: an empty colon-dash default (${VAR:-}) is unresolvable, not a usable empty value", () => {
		expect(resolveBashWriteTarget("", "${ILK_UNSET_EMPTY:-}/f.ts", ROOT)).toBeNull();
	});
});

describe("expandLeadingVariable boundary: both regexes require the match at the START", () => {
	const ROOT = "/Users/dev/project";

	it("a $VAR reference NOT at the start of the target is a literal, not expanded", () => {
		// If the leading-variable regex loses its `^` anchor it would find
		// "$SOMEVAR" mid-string and slice(m[0].length) from the WRONG offset.
		expect(resolveBashWriteTarget("", "prefix$SOMEVAR.ts", ROOT)).toBe(
			"/Users/dev/project/prefix$SOMEVAR.ts",
		);
	});

	it("a literal ${...} appearing later in the target (not at the start) is not 'unresolvable'", () => {
		// Pins the fallback regex's `^` anchor: only a target that STARTS
		// with "${" is an unmodeled braced form; one that merely CONTAINS
		// "${" later is just a literal path.
		expect(resolveBashWriteTarget("", "abc${x}/f.ts", ROOT)).toBe(
			"/Users/dev/project/abc${x}/f.ts",
		);
	});

	it("${VAR} with NO colon-dash default still resolves via the braced alternative", () => {
		// The (?::-...)? group is OPTIONAL — a braced ref with no default must
		// still match, not require a default to be present.
		expect(resolveBashWriteTarget("MYVAR=inside", "${MYVAR}/f.ts", ROOT)).toBe(
			"/Users/dev/project/inside/f.ts",
		);
	});
});

describe("collectShellAssignments boundary: HOME/TMPDIR seeding + the assignment regex", () => {
	const ROOT = "/Users/dev/project";
	let prevHome: string | undefined;
	let prevTmpdir: string | undefined;

	beforeEach(() => {
		prevHome = process.env.HOME;
		prevTmpdir = process.env.TMPDIR;
	});

	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = prevTmpdir;
	});

	it("seeds $HOME from the process environment into the same-command variable map", () => {
		process.env.HOME = "/synthetic/home/for/test";
		expect(resolveBashWriteTarget("", "$HOME/x.ts", ROOT)).toBe(
			"/synthetic/home/for/test/x.ts",
		);
	});

	it("seeds $TMPDIR from the process environment into the same-command variable map", () => {
		process.env.TMPDIR = "/synthetic/tmp/for/test";
		expect(resolveBashWriteTarget("", "$TMPDIR/y.ts", ROOT)).toBe(
			"/synthetic/tmp/for/test/y.ts",
		);
	});

	it("an assignment preceded by a plain space (not at string start) is still recognized", () => {
		expect(resolveBashWriteTarget("pre X=val", "$X/f.ts", ROOT)).toBe(
			"/Users/dev/project/val/f.ts",
		);
	});

	it("a multi-character double-quoted assignment value is captured in full, not truncated to 1 char", () => {
		expect(resolveBashWriteTarget('X="hello world"', "$X.ts", ROOT)).toBe(
			"/Users/dev/project/hello world.ts",
		);
	});

	it("a multi-character single-quoted assignment value is captured in full, not truncated to 1 char", () => {
		expect(resolveBashWriteTarget("X='hello world'", "$X.ts", ROOT)).toBe(
			"/Users/dev/project/hello world.ts",
		);
	});
});

describe("resolveCdBase boundary: spacing and quoting around cd / --", () => {
	const ROOT = "/Users/dev/project";
	const SCRATCHPAD = "/private/tmp/claude-501/-Users-dev-project/sess-1/scratchpad";

	it("N: extra spaces between `cd` and its target don't break recognition", () => {
		const cmd = `cd  ${SCRATCHPAD} && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("N: extra spaces after a `--` separator don't break recognition", () => {
		const cmd = `cd --  ${SCRATCHPAD} && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("N: a single space after `--` (the standard form) is recognized", () => {
		const cmd = `cd -- ${SCRATCHPAD} && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("N: a single-quoted multi-character cd target resolves fully, not just its first char", () => {
		const cmd = `cd '${SCRATCHPAD}' && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("an unresolvable cd target poisons the base (relative writes after it are NOT in-root)", () => {
		expect(detectBashCodeFileWrite("cd $UNKNOWN_CD_VAR && echo x > p.ts", ROOT)).toBeNull();
	});

	it("a later resolvable cd re-establishes the base after an unresolvable one", () => {
		const hit = detectBashCodeFileWrite(
			`cd $UNKNOWN_CD_VAR && cd ${ROOT}/src && echo x > p.ts`,
			ROOT,
		);
		expect(hit?.target).toBe("p.ts");
	});
});

describe("stripQuotedStrings boundary: the whole quoted span must be blanked, not one char", () => {
	it("N: a `>` inside a real multi-character double-quoted string is still hidden from redirect scanning", () => {
		// If the quote-blanking regex only matched a single interior char, a
		// multi-char quoted string with a trailing space before the closing
		// quote would leave a bogus inner '>' visible, producing a phantom hit.
		expect(detectBashCodeFileWrite('echo "note > x.ts " > log.txt')).toBeNull();
	});

	it("N: same, for a single-quoted string", () => {
		expect(detectBashCodeFileWrite("echo 'note > x.ts ' > log.txt")).toBeNull();
	});
});

describe("tee / inline-interpreter boundary: \\s+ must absorb MULTIPLE spaces, not just one", () => {
	it("tee with two spaces before the target is still recognized", () => {
		expect(detectBashCodeFileWrite("echo x | tee  src/t.ts")?.mechanism).toBe("tee");
	});

	it("tee -a with two spaces before the target is still recognized", () => {
		expect(detectBashCodeFileWrite("echo x | tee -a  src/t.ts")?.mechanism).toBe("tee");
	});

	it("tee --append with two spaces before the target is still recognized", () => {
		expect(detectBashCodeFileWrite("echo x | tee --append  src/t.ts")?.mechanism).toBe("tee");
	});

	it("tee -- with two spaces before the target is still recognized", () => {
		expect(detectBashCodeFileWrite("echo x | tee --  src/t.ts")?.mechanism).toBe("tee");
	});

	it("tee -- with a single space (the standard form) is recognized", () => {
		expect(detectBashCodeFileWrite("echo x | tee -- src/t.ts")?.mechanism).toBe("tee");
	});

	it("inline interpreter: two spaces after the interpreter name is still recognized", () => {
		const hit = detectBashCodeFileWrite(
			`node  -e "require('fs').writeFileSync('dbl92.ts', 'x')"`,
		);
		expect(hit?.target).toBe("dbl92.ts");
	});

	it("inline interpreter: two spaces after a leading flag is still recognized", () => {
		const hit = detectBashCodeFileWrite(
			`node --experimental-vm-modules  -e "require('fs').writeFileSync('flag97.ts','x')"`,
		);
		expect(hit?.target).toBe("flag97.ts");
	});

	it("inline interpreter: two spaces after -e (before the quote) is still recognized", () => {
		const hit = detectBashCodeFileWrite(`node -e  "require('fs').writeFileSync('flag100.ts','x')"`);
		expect(hit?.target).toBe("flag100.ts");
	});

	it("a bare `python` (no trailing 3) is recognized, not just `python3`", () => {
		const hit = detectBashCodeFileWrite(`python -c "open('gen2.py','w').write('x')"`);
		expect(hit?.target).toBe("gen2.py");
	});

	it("N: a flag other than -e/-c does not trigger inline-interpreter detection", () => {
		expect(
			detectBashCodeFileWrite(`node -x "require('fs').writeFileSync('out.ts', 'x')"`),
		).toBeNull();
	});

	it("a leading flag before -e is skipped correctly (repeated-flag group matches)", () => {
		const hit = detectBashCodeFileWrite(
			`node --experimental-vm-modules -e "require('fs').writeFileSync('flagged.ts', 'x')"`,
		);
		expect(hit?.target).toBe("flagged.ts");
	});
});

describe("detectBashCodeFileWrite: content-gate must not leak", () => {

	it("N: once CONTENT_GATE_ROUTED_RE matches, the WHOLE command is allowed — even with a real redirect tacked on", () => {
		// `interlinked write` self-gates the ENTIRE command line; a later
		// `&& echo bad > src/other.ts` on the same line must NOT be scanned.
		expect(
			detectBashCodeFileWrite(
				"interlinked write src/foo.ts --from-file /tmp/new.ts && echo bad > src/other.ts",
			),
		).toBeNull();
	});

	it("N: two spaces between 'interlinked' and 'write' still satisfies the \\s+ gate", () => {
		expect(
			detectBashCodeFileWrite(
				"interlinked  write src/foo.ts --from-file /tmp/new.ts && echo bad > src/other2.ts",
			),
		).toBeNull();
	});

	it("a redirect target with NO space after `>` is still parsed as a bare target", () => {
		const hit = detectBashCodeFileWrite("echo x >a.ts");
		expect(hit?.target).toBe("a.ts");
	});
});

describe("detectFileMoveToProtected boundary: path-prefixed verb + bare .graph shard", () => {
	it("a verb invoked via an absolute path (/bin/cp) still resolves to its basename", () => {
		// Pins the `.split(\"/\").pop() ?? args[0]` fallback direction: pop()
		// on a non-empty split never returns null/undefined, so the ENTIRE
		// path must never leak through as the "verb".
		const hit = detectBashCodeFileWrite("/bin/cp /tmp/a.txt src/dst2.ts");
		expect(hit?.target).toBe("src/dst2.ts");
		expect(hit?.mechanism).toContain("cp");
	});

	it("N: a bare `.graph` with no extra extension segment does NOT match SHARD_FILE_RE's optional group turned mandatory", () => {
		// If `(\\.[a-zA-Z0-9]+)?` lost its `?`, a bare ".graph" (no further
		// ".ext") would stop matching entirely.
		const hit = detectBashCodeFileWrite("cp /tmp/x src/bare.graph");
		expect(hit?.target).toBe("src/bare.graph");
	});

	it("N: a lookalike extension (.graphite) is NOT a Supermodel shard", () => {
		expect(detectBashCodeFileWrite("cp /tmp/x src/foo.graphite")).toBeNull();
	});

	it("N: a `dd`-lookalike word (ddx) does not trigger dd detection", () => {
		expect(detectBashCodeFileWrite("ddx if=/tmp/src of=out.ts")).toBeNull();
	});

	it("N: a `sed`-lookalike word (sedX) does not trigger sed -i detection", () => {
		expect(detectBashCodeFileWrite("sedX -i 's/a/b/' src/edit.ts")).toBeNull();
	});

	it("a sed invoked via an absolute path is still recognized ($ anchor on the name check)", () => {
		const hit = detectBashCodeFileWrite("/usr/bin/sed -i 's/a/b/' src/edit.ts");
		expect(hit?.target).toBe("src/edit.ts");
	});

	it("N: `tee` with no target at all resolves to no hit", () => {
		expect(detectBashCodeFileWrite("echo x | tee")).toBeNull();
	});
});

describe("splitShellWordsLoose boundary: an escaped char inside quotes must not fragment the word at a space", () => {
	it("a double-quoted word with an escaped quote, followed by a real space, parses as ONE token", () => {
		// If the double-quote escape-alternative (\\[\\s\\S]) can't match the
		// escaped char, the parser falls back to a bare \\S+ token that stops
		// at the first internal space — fragmenting one destination into two
		// tokens and losing the trailing ".ts" from the reported target.
		const hit = detectBashCodeFileWrite('cp /tmp/src.txt "a\\"b c.ts"');
		expect(hit?.target).toBe('a\\"b c.ts');
	});

	it("a double-quoted word with an escaped SPACE, followed by a real space, parses as ONE token", () => {
		const hit = detectBashCodeFileWrite('cp /tmp/src.txt "a\\ b.ts"');
		expect(hit?.target).toBe("a\\ b.ts");
	});

	it("a single-quoted word with an escaped SPACE, followed by a real space, parses as ONE token", () => {
		const hit = detectBashCodeFileWrite("cp /tmp/src.txt 'a\\ b.ts'");
		expect(hit?.target).toBe("a\\ b.ts");
	});

	it("a single-quoted word with an escaped LETTER, followed by a real space, parses as ONE token", () => {
		const hit = detectBashCodeFileWrite("cp /tmp/src.txt 'a\\xb c.ts'");
		expect(hit?.target).toBe("a\\xb c.ts");
	});
});
