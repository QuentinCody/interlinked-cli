// Mutation-kill hardening for src/harness/pre-checks-bash-write-detect.ts.
//
// WHY THIS FILE EXISTS (fleet-r3 diagnosis): bash-bypass.test.ts imports
// detectBashCodeFileWrite/resolveBashWriteTarget from "../pre-checks.js",
// which RE-EXPORTS them from this module via a named `export { ... } from
// "./pre-checks-bash-write-detect.js"` statement. The mutation runner
// selects per-file test scope by BFS over the reverse import graph
// (src/harness/mutation/test-scope.ts -> coverage-test-selector.ts), and
// that graph is built by project-graph/parser-imports.ts's parseImports(),
// which only recognizes lines starting with `import` (or containing
// require()/import()) — a bare `export { X } from "./y.js"` line never
// reaches that check (`trimmed.startsWith("import")` is false and it has
// no require()/import() substring), so it produces NO reverse-graph edge.
// Every test that reaches this module only through pre-checks.ts is
// therefore invisible to mutation test-scope selection, regardless of how
// thoroughly it exercises the real behavior — bash-bypass.test.ts's ~150
// assertions score against the wrong (or no) coverage. This file imports
// the SUT directly to close that edge. Cases below are the ones proven
// (via scratch/fleet-r3/src_harness_pre-checks-bash-write-detect.ts-shadow-verify.mts,
// a shadow-mutation differential) to distinguish specific surviving
// mutants; most mirror an existing bash-bypass.test.ts assertion, a
// handful are new (see the R3-NEW markers below).
//
// W5c-PORT markers (2026-08-12, fleet W5c RELOCATE job): this file's 75
// cases were a load-bearing SUBSET of a ~121-fixture shadow battery
// (scratch/fleet-r3/src_harness_pre-checks-bash-write-detect.ts-shadow-verify.mts).
// Cross-referencing scratch/fleet-r3/receipts/<this-file>.jsonl's
// killed_by_test rows against the registered 75 cases — by literally
// running THIS file (import rewritten) against a shadow-built copy of
// every recorded mutant via real `vitest run`, not by argument — found 3
// genuine content gaps (2 of the 6 initial suspects were occurrence-search
// artifacts hitting a comment / a type annotation that can never be
// killed by any test; 1 was an empirically-confirmed EQUIVALENT mutant —
// `collectShellAssignments`'s `if (v) vars.set(name, v)` seeding guard
// forced to `if (true)`: every consumer reads the map via `.get()` only,
// and `resolveVariableValue`'s own guard already treats an absent key and
// a present-but-""/undefined-valued key identically, so no observer can
// ever see the difference — verified with a 141-case zero-divergence
// sweep, see scratch/fleet-r3/relocate-w5c/equivalence-check-v-true.mts).

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { detectBashCodeFileWrite, resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";

const ROOT = "/Users/dev/project";
const REPO2 = "/repo";
const SCRATCHPAD = "/private/tmp/claude-501/-Users-dev-project/sess-1/scratchpad";

describe("redirection and heredoc targets", () => {
	it("P1: heredoc cat > file.ts << EOF", () => {
		const hit = detectBashCodeFileWrite("cat > src/foo.ts << 'EOF'\nconst x = 1;\nEOF");
		expect(hit?.target).toBe("src/foo.ts");
	});

	it("P2: echo > file.tsx", () => {
		expect(detectBashCodeFileWrite('echo "const x = 1;" > src/app.tsx')?.target).toBe("src/app.tsx");
	});

	it("P3: appending echo >> file.js", () => {
		expect(detectBashCodeFileWrite("echo 'const y = 2;' >> lib/util.js")?.target).toBe("lib/util.js");
	});

	it("P4: quoted target with an internal space", () => {
		const hit = detectBashCodeFileWrite("cat > 'src/my file.ts' << EOF\nx\nEOF");
		expect(hit?.target).toBe("src/my file.ts");
	});

	it("N1: dangling redirect with nothing after the operator is null, not a throw", () => {
		expect(() => detectBashCodeFileWrite("echo x >")).not.toThrow();
		expect(detectBashCodeFileWrite("echo x >")).toBeNull();
	});

	it("R3-NEW P5: redirect mechanism text is reported (not blanked)", () => {
		expect(detectBashCodeFileWrite("echo x > src/foo.ts")?.mechanism).toBe("shell redirect (>)");
	});

	it("R3-NEW P6: multi-line command — replaced target must not merge with the next word", () => {
		// Pins the space (not empty-string) replacement in the \r\n -> " "
		// normalize: a missing separator would fuse "src/foo.ts" with the
		// following line's first word, corrupting CODE_FILE_EXT_RE.test().
		const hit = detectBashCodeFileWrite("echo x > src/foo.ts\necho done");
		expect(hit?.target).toBe("src/foo.ts");
	});

	it("W5c-PORT P7: redirect mechanism text is reported for a QUOTED target too", () => {
		// parseRedirectTarget's `shell redirect (${operator})` mechanism
		// string literal is written out TWICE — once in the quoted-target
		// branch, once in the bare-target branch. R3-NEW P5 above only
		// exercises the bare branch (an unquoted target); this is its
		// missing sibling for the quoted branch, closing the other half.
		expect(detectBashCodeFileWrite("echo x > 'src/foo.ts'")?.mechanism).toBe("shell redirect (>)");
	});
});

describe("tee", () => {
	it("P1: tee file.ts", () => {
		expect(detectBashCodeFileWrite("echo 'x' | tee src/foo.ts")?.target).toBe("src/foo.ts");
	});

	it("P2: tee -a file.ts", () => {
		expect(detectBashCodeFileWrite("echo 'x' | tee -a src/foo.ts")?.target).toBe("src/foo.ts");
	});

	it("P3: tee two spaces before the target", () => {
		expect(detectBashCodeFileWrite("echo x | tee  src/t.ts")?.mechanism).toBe("tee");
	});

	it("P4: tee -a two spaces before the target", () => {
		expect(detectBashCodeFileWrite("echo x | tee -a  src/t.ts")?.mechanism).toBe("tee");
	});

	it("P5: tee --append two spaces before the target", () => {
		expect(detectBashCodeFileWrite("echo x | tee --append  src/t.ts")?.mechanism).toBe("tee");
	});

	it("P6: tee -- two spaces before the target", () => {
		expect(detectBashCodeFileWrite("echo x | tee --  src/t.ts")?.mechanism).toBe("tee");
	});
});

describe("sed -i (in-place)", () => {
	it("P1: sed -i on a ts file", () => {
		expect(detectBashCodeFileWrite("sed -i 's/foo/bar/' src/app.ts")?.target).toBe("src/app.ts");
	});

	it("P2: the mechanism identifies the in-place edit", () => {
		expect(detectBashCodeFileWrite("sed -i 's/foo/bar/' src/app.ts")?.mechanism).toBe(
			"sed -i (in-place)",
		);
	});

	it("N1: a sed-lookalike word (sedX) does not trigger sed -i detection", () => {
		expect(detectBashCodeFileWrite("sedX -i 's/a/b/' src/edit.ts")).toBeNull();
	});

	// Review 2026-08-28 (final round): the PUBLIC-path pins for the quoted-pipe
	// fix — the helper-level regression alone could stay green while this
	// wiring regressed. The naive split let `rg -i 'a|b'` donate its -i to a
	// downstream `sed -n`, false-blocking a read-only pipeline (a zero-FP
	// violation, reproduced live during review).
	// test-contract: bug — a quoted alternation must not split a read-only
	// pipeline into a false sed -i write (zero-FP contract for this pre_block).
	it("N-quoted-pipe: a read-only rg|sed -n pipeline with quoted alternation is NOT a write", () => {
		expect(detectBashCodeFileWrite(`rg -i 'a|b' src/app.ts | sed -n '1,200p'`)).toBeNull();
	});

	// test-contract: bug — the quote-aware split must not over-correct: a real
	// sed -i AFTER a quoted-alternation segment still blocks with its target.
	it("P-quoted-pipe: the same quoted regex followed by a REAL sed -i still blocks", () => {
		const hit = detectBashCodeFileWrite(`rg -i 'a|b' src/app.ts | sed -i 's/foo|bar/x/' src/app.ts`);
		expect(hit?.target).toBe("src/app.ts");
		expect(hit?.mechanism).toBe("sed -i (in-place)");
	});

	it("R3-NEW N2: grep -i is not sed -i (its -i is case-insensitive, not in-place)", () => {
		expect(detectBashCodeFileWrite("grep -i pattern src/app.ts")).toBeNull();
	});

	it("N3: sed without an in-place option remains a read", () => {
		expect(detectBashCodeFileWrite("sed 's/foo/bar/' src/app.ts")).toBeNull();
	});

	it("N4: a flag-shaped code filename is not treated as the input file", () => {
		expect(detectBashCodeFileWrite("sed -i --not-a-file.ts")).toBeNull();
	});

	it("N5: the sed script itself is not mistaken for a code-file target", () => {
		expect(detectBashCodeFileWrite("sed -i 's/foo/bar/'")).toBeNull();
	});

	it("P6: bundled -E and -i options are recognized", () => {
		expect(detectBashCodeFileWrite("sed -Ei 's/foo/bar/' src/app.ts")?.target).toBe("src/app.ts");
	});

	it("N7: an in-place-looking suffix inside an option token is not a sed option", () => {
		expect(detectBashCodeFileWrite("sed --foo-i 's/foo/bar/' src/app.ts")).toBeNull();
	});

	it("P8: a one-character non-letter suffix after -i is accepted", () => {
		expect(detectBashCodeFileWrite("sed -i= src/app.ts")?.target).toBe("src/app.ts");
	});

	it("N9: only arguments after sed are candidates for the in-place target", () => {
		expect(detectBashCodeFileWrite("wrapper.ts sed -i 's/foo/bar/'")).toBeNull();
	});

	it("P10: a code-file argument at sedArgs index zero is still scanned", () => {
		expect(detectBashCodeFileWrite("sed src/app.ts -i")?.target).toBe("src/app.ts");
	});
});

describe("inline interpreter writes", () => {
	it("P1: node -e fs.writeFileSync to .ts", () => {
		const hit = detectBashCodeFileWrite(
			`node -e "require('fs').writeFileSync('src/app.ts', 'const x = 1;')"`,
		);
		expect(hit?.target).toBe("src/app.ts");
	});

	it("P1b: the node -e mechanism includes the interpreter mode", () => {
		const hit = detectBashCodeFileWrite(`node -e "require('fs').writeFileSync('src/app.ts','x')"`);
		expect(hit?.mechanism).toBe("inline node -e script");
	});

	it("P1c: writeFile without the optional Sync suffix is recognized", () => {
		const hit = detectBashCodeFileWrite(`node -e "fs.writeFile('src/app.ts','x')"`);
		expect(hit?.target).toBe("src/app.ts");
	});

	it("P2: a bare python (no trailing 3) is recognized, not just python3", () => {
		expect(detectBashCodeFileWrite(`python -c "open('gen2.py','w').write('x')"`)?.target).toBe("gen2.py");
	});

	it("P2b: the python -c mechanism includes the interpreter mode", () => {
		const hit = detectBashCodeFileWrite(`python -c "open('gen2.py','w').write('x')"`);
		expect(hit?.mechanism).toBe("inline python -c script");
	});

	it("P2c: open accepts whitespace around its arguments", () => {
		const hit = detectBashCodeFileWrite(`python -c "open ( 'gen3.py' , 'w' ).write('x')"`);
		expect(hit?.target).toBe("gen3.py");
	});

	it("N6: an inline call without a write operation is ignored", () => {
		expect(() => detectBashCodeFileWrite(`node -e "console.log('src/app.ts')"`)).not.toThrow();
		expect(detectBashCodeFileWrite(`node -e "console.log('src/app.ts')"`)).toBeNull();
	});

	it("N7: an inline write to a non-code file is ignored", () => {
		expect(detectBashCodeFileWrite(`node -e "fs.writeFileSync('src/app.txt','x')"`)).toBeNull();
	});

	it("N8: an inline write outside the guarded root is allowed", () => {
		expect(
			detectBashCodeFileWrite(`node -e "fs.writeFileSync('/tmp/out.ts','x')"`, ROOT),
		).toBeNull();
	});

	it("P3: two spaces after a leading flag before -e is still recognized", () => {
		const hit = detectBashCodeFileWrite(
			`node --experimental-vm-modules  -e "require('fs').writeFileSync('flag97.ts','x')"`,
		);
		expect(hit?.target).toBe("flag97.ts");
	});

	it("P4: two spaces after the interpreter name is still recognized", () => {
		const hit = detectBashCodeFileWrite(`node  -e "require('fs').writeFileSync('dbl92.ts', 'x')"`);
		expect(hit?.target).toBe("dbl92.ts");
	});

	it("P5: two spaces after -e (before the quote) is still recognized", () => {
		const hit = detectBashCodeFileWrite(`node -e  "require('fs').writeFileSync('flag100.ts','x')"`);
		expect(hit?.target).toBe("flag100.ts");
	});

	it("P6: an unqualified writeFile call remains recognized with spaced arguments", () => {
		// Keep this out of the fs.writeFile fallback: the primary writeFile
		// matcher must accept both the optional Sync suffix and whitespace before
		// the opening parenthesis.
		const hit = detectBashCodeFileWrite(`node -e "writeFile   ('src/unqualified.ts', 'x')"`);
		expect(hit?.target).toBe("src/unqualified.ts");
	});

});

describe("cp / mv / ln / install / rsync / scp", () => {
	it("P1: cp /tmp/x.ts src/foo.ts", () => {
		expect(detectBashCodeFileWrite("cp /tmp/x.ts src/foo.ts")?.target).toBe("src/foo.ts");
	});

	it("P2: mv /tmp/y.js lib/util.js", () => {
		expect(detectBashCodeFileWrite("mv /tmp/y.js lib/util.js")?.target).toBe("lib/util.js");
	});

	it("P3: install -m 644 src dst", () => {
		expect(detectBashCodeFileWrite("install -m 644 /tmp/x.py src/foo.py")?.target).toBe("src/foo.py");
	});

	it("P4: ln (hard link)", () => {
		expect(detectBashCodeFileWrite("ln /tmp/x.ts src/foo.ts")?.target).toBe("src/foo.ts");
	});

	it("P5: rsync -a src dst", () => {
		expect(detectBashCodeFileWrite("rsync -a /tmp/y.js lib/util.js")?.target).toBe("lib/util.js");
	});

	it("P6: scp local-to-local", () => {
		expect(detectBashCodeFileWrite("scp /tmp/x.ts src/foo.ts")?.target).toBe("src/foo.ts");
	});

	it("P7: a verb invoked via an absolute path (/bin/cp) still resolves to its basename", () => {
		const hit = detectBashCodeFileWrite("/bin/cp /tmp/a.txt src/dst2.ts");
		expect(hit?.target).toBe("src/dst2.ts");
		expect(hit?.mechanism).toContain("cp");
	});

	it("N8: a copy with only one positional source is not a write", () => {
		expect(detectBashCodeFileWrite("cp src/only-source.ts")).toBeNull();
	});

	it("N9: ordinary flags are skipped without becoming a source", () => {
		expect(detectBashCodeFileWrite("cp --verbose src/only-source.ts")).toBeNull();
	});

	it("P10: a positional ending in a hyphen is not treated as a flag", () => {
		expect(detectBashCodeFileWrite("cp /tmp/x.ts src/ends-with-.ts")?.target).toBe("src/ends-with-.ts");
	});

	it.each([
		["-m", "644"],
		["--mode", "644"],
		["-t", "out"],
		["--target-directory", "out"],
		["-S", ".bak"],
		["--suffix", ".bak"],
	])("N11: %s consumes its following value", (flag, value) => {
		expect(detectBashCodeFileWrite(`cp ${flag} ${value} src/only-source.ts`)).toBeNull();
	});

	it("N12: a flag value ending in a hyphen is still consumed", () => {
		expect(detectBashCodeFileWrite("cp -m mode- src/only-source.ts")).toBeNull();
	});

	it("N13: a flag at the end has no value to consume", () => {
		expect(detectBashCodeFileWrite("cp -m")).toBeNull();
	});

	it("N14: a two-token flag value is skipped when a prior flag precedes it", () => {
		expect(detectBashCodeFileWrite("cp src/source.ts --verbose -m src/destination.ts")).toBeNull();
	});
});

describe("dd (block-level copy)", () => {
	it("P1: dd if= of=", () => {
		expect(detectBashCodeFileWrite("dd if=/tmp/x.ts of=src/foo.ts")?.target).toBe("src/foo.ts");
	});

	it("N1: a dd-lookalike word (ddx) does not trigger dd detection", () => {
		expect(detectBashCodeFileWrite("ddx if=/tmp/src of=out.ts")).toBeNull();
	});

	it("N1b: dd without an of= destination is not a write", () => {
		expect(detectBashCodeFileWrite("dd if=/tmp/src.ts")).toBeNull();
	});

	it("R3-NEW N2: an of= pattern with no dd keyword at all is not a dd write", () => {
		expect(detectBashCodeFileWrite("echo of=src/foo.ts")).toBeNull();
	});

	it("N3: dd to a non-code file is ignored", () => {
		expect(detectBashCodeFileWrite("dd if=/tmp/src.ts of=src/output.txt")).toBeNull();
	});

	it("P4: the dd mechanism identifies a block-level write", () => {
		expect(detectBashCodeFileWrite("dd if=/tmp/x.ts of=src/foo.ts")?.mechanism).toBe(
			"dd (block-level write)",
		);
	});
});

describe(".graph.* Supermodel shards", () => {
	it("N1: a bare .graph (no further extension segment) still matches", () => {
		expect(detectBashCodeFileWrite("cp /tmp/x src/bare.graph")?.target).toBe("src/bare.graph");
	});

	it("N2: a lookalike extension (.graphite) is not a shard", () => {
		expect(detectBashCodeFileWrite("cp /tmp/x src/foo.graphite")).toBeNull();
	});

	it("R3-NEW P3: a .graph.<non-code-ext> shard is protected via SHARD_FILE_RE alone", () => {
		// Every OTHER .graph.* fixture in bash-bypass.test.ts happens to use an
		// extension (ts/go/js/py) that CODE_FILE_EXT_RE ALSO recognizes, so
		// none of them isolate SHARD_FILE_RE from that OR-fallback. .json is
		// not in CODE_FILE_EXT_RE's list, so only SHARD_FILE_RE's own
		// mandatory-vs-optional / +-vs-single-char / negated-class shape
		// decides this one.
		const hit = detectBashCodeFileWrite("cp /tmp/x src/foo.graph.json");
		expect(hit?.target).toBe("src/foo.graph.json");
	});
});
describe("legitimate operations stay null", () => {

	it("N2: tee / cp / dd landing outside the project root are allowed", () => {
		expect(detectBashCodeFileWrite("make | tee /tmp/build-log.ts", ROOT)).toBeNull();
	});

	it("W5c-PORT N3: cp and dd landing outside the project root are ALSO allowed", () => {
		// N2's own label already claims "tee / cp / dd", but its body only
		// ever called tee — the cp and dd halves of that claim were never
		// actually exercised, leaving detectBashCodeFileWrite's own
		// `ddHit && inRoot(ddHit.target)` guard (and cp's equivalent
		// `fileMoveHit && inRoot(fileMoveHit.target)` guard) unproven.
		expect(detectBashCodeFileWrite("cp src/a.ts /tmp/elsewhere/a.ts", ROOT)).toBeNull();
		expect(detectBashCodeFileWrite("dd if=src/a.ts of=/tmp/out.ts", ROOT)).toBeNull();
	});

	it("N4: scp to a remote host is not a local tracked-file write", () => {
		expect(detectBashCodeFileWrite("scp /tmp/x.ts deploy.example:releases/app.ts")).toBeNull();
	});

	it("N5: a remote host with a slash after the colon is still remote", () => {
		expect(detectBashCodeFileWrite("rsync /tmp/x.ts deploy.example:/srv/app.ts")).toBeNull();
	});

	it("N5b: a remote host with no slash in its destination is still remote", () => {
		expect(detectBashCodeFileWrite("scp /tmp/x.ts deploy.example:app.ts")).toBeNull();
	});

	it("P6: a URL-like destination is not classified as an scp remote", () => {
		expect(detectBashCodeFileWrite("scp /tmp/x.ts https://deploy.example/app.ts")?.target).toBe(
			"https://deploy.example/app.ts",
		);
	});

	it("P7: a colon at the beginning is a local path, not a remote spec", () => {
		expect(detectBashCodeFileWrite("scp /tmp/x.ts :app.ts")?.target).toBe(":app.ts");
	});

	it("P8: a colon after a slash is a local path", () => {
		expect(detectBashCodeFileWrite("scp /tmp/x.ts dir/app:build.ts")?.target).toBe("dir/app:build.ts");
	});
});

describe("`interlinked write` self-gate", () => {
	it("N1: two spaces between 'interlinked' and 'write' still satisfies the \\s+ gate", () => {
		expect(
			detectBashCodeFileWrite(
				"interlinked  write src/foo.ts --from-file /tmp/new.ts && echo bad > src/other2.ts",
			),
		).toBeNull();
	});

	it("N2: the whole command is allowed, even with a real redirect tacked on after", () => {
		expect(
			detectBashCodeFileWrite(
				"interlinked write src/foo.ts --from-file /tmp/new.ts && echo bad > src/other.ts",
			),
		).toBeNull();
	});
});

describe("root confinement", () => {
	it("N1: ~ resolves to the real home directory, not a repo-relative path", () => {
		expect(detectBashCodeFileWrite("echo hi > ~/notes/snippet.ts", ROOT)).toBeNull();
	});

	it("N2: a relative target after cd out of the repo resolves out of root", () => {
		const cmd = `cd ${SCRATCHPAD} && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("P3: a bare tilde resolves to the actual home directory", () => {
		expect(resolveBashWriteTarget("", "~", ROOT)).toBe(homedir());
		expect(resolveBashWriteTarget("", "~/notes/snippet.ts", ROOT)).toBe(
			`${homedir()}/notes/snippet.ts`,
		);
	});
});

describe("variable + cd resolution", () => {
	it("N1: ${VAR} braces form expands the same as bare $VAR", () => {
		const cmd = `SCRATCH="${SCRATCHPAD}" && echo x > \${SCRATCH}/probe.mts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("N2: an unresolvable variable is not provably in-root (passes through)", () => {
		expect(detectBashCodeFileWrite("echo x > $UNKNOWN_DIR/probe.ts", ROOT)).toBeNull();
	});

	it("P3: $HOME expands from the process environment (resolveBashWriteTarget)", () => {
		const prevHome = process.env.HOME;
		process.env.HOME = "/synthetic/home/for/test";
		try {
			expect(resolveBashWriteTarget("", "$HOME/x.ts", ROOT)).toBe("/synthetic/home/for/test/x.ts");
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});

	it("P4: $TMPDIR seeded from the process environment", () => {
		const prevTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = "/synthetic/tmp/for/test";
		try {
			expect(resolveBashWriteTarget("", "$TMPDIR/y.ts", ROOT)).toBe("/synthetic/tmp/for/test/y.ts");
		} finally {
			if (prevTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = prevTmpdir;
		}
	});

	it("N5: cd $VAR into an out-of-repo dir", () => {
		const cmd = `SCRATCH=${SCRATCHPAD}\ncd $SCRATCH\necho x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});
});
describe("braced-variable-with-default cd targets", () => {
	it("N1: cd into an unset-var colon-dash default resolves OUT of root — no hit", () => {
		const cmd = 'cd "${ILK_UNSET_ABC:-/tmp}/fx" && printf x > probe.js';
		expect(detectBashCodeFileWrite(cmd, REPO2)).toBeNull();
	});

	it("P2: a same-command assignment beats an in-root default — hit", () => {
		const cmd = 'X=/repo/sub; cd "${X:-/tmp}" && echo q > p.ts';
		expect(detectBashCodeFileWrite(cmd, REPO2)?.target).toBe("p.ts");
	});

	it("N3: an unmodeled braced-operator form is unresolvable, not a literal — no hit", () => {
		const cmd = 'cd "${SOMEVAR%suffix}/x" && echo y > p.ts';
		expect(detectBashCodeFileWrite(cmd, REPO2)).toBeNull();
	});

	it("P4: resolveBashWriteTarget expands the colon-dash default end-to-end", () => {
		const cmd = 'cd "${ILK_UNSET_ZZZ:-/t}/a" && echo x > f.ts';
		expect(resolveBashWriteTarget(cmd, "f.ts", REPO2)).toBe("/t/a/f.ts");
	});
});

describe("withinGuardedRoot / resolveTargetForRootCheck boundary", () => {
	it("P1: a write target equal to the project root path IS in-root (abs === root)", () => {
		const hit = detectBashCodeFileWrite("echo x > /repo.ts", "/repo.ts");
		expect(hit?.target).toBe("/repo.ts");
	});

	it("N2: bare ~ (cd, no trailing content) escapes the root", () => {
		expect(detectBashCodeFileWrite("cd ~ && echo x > note.ts", ROOT)).toBeNull();
	});

	it("P3: X=\"\" with a colon-dash default uses the DEFAULT, not the empty assignment", () => {
		const hit = detectBashCodeFileWrite('X="" && echo bad > ${X:-fallback}/f.ts', ROOT);
		expect(hit?.target).toBe("${X:-fallback}/f.ts");
	});

	it("W5c-PORT P3b: an EMPTY colon-dash default is unresolvable, not a usable empty fallback", () => {
		// resolveVariableValue's own `fallback === ""` guard is a SEPARATE
		// AST node from P3's `value !== ""` guard above — P3 kills the
		// former, this kills the latter. Without this guard an unset var
		// with a bare `${VAR:-}` default would resolve to the literal
		// empty string and read as "resolved" (in-root) instead of
		// unresolvable.
		expect(resolveBashWriteTarget("", "${ILK_UNSET_EMPTY:-}/f.ts", ROOT)).toBeNull();
	});

	it("N4: a $VAR reference NOT at the start of the target is a literal, not expanded", () => {
		expect(resolveBashWriteTarget("", "prefix$SOMEVAR.ts", ROOT)).toBe(
			"/Users/dev/project/prefix$SOMEVAR.ts",
		);
	});

	it("N5: a literal ${...} appearing later (not at the start) is not 'unresolvable'", () => {
		expect(resolveBashWriteTarget("", "abc${x}/f.ts", ROOT)).toBe("/Users/dev/project/abc${x}/f.ts");
	});

	it("P6: ${VAR} with NO colon-dash default still resolves via the braced alternative", () => {
		expect(resolveBashWriteTarget("MYVAR=inside", "${MYVAR}/f.ts", ROOT)).toBe(
			"/Users/dev/project/inside/f.ts",
		);
	});

	it("R3-NEW P7: an absolute target is unaffected by a POISONED cd base", () => {
		// isAbsolute(expanded) must short-circuit BEFORE the base-resolution
		// fallback: path.resolve(base, expanded) happens to collapse to the
		// same string for ANY base once expanded is absolute, so this is the
		// only shape (a null/poisoned base) that exposes isAbsolute() being
		// skipped: resolve(null, expanded) would throw instead of returning
		// the absolute path outright.
		const cmd = `cd $UNKNOWN_CD_VAR && echo x > ${ROOT}/src/abs.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)?.target).toBe(`${ROOT}/src/abs.ts`);
	});
});

describe("collectShellAssignments boundary", () => {
	it("P1: an assignment preceded by a plain space (not string start) is recognized", () => {
		expect(resolveBashWriteTarget("pre X=val", "$X/f.ts", ROOT)).toBe("/Users/dev/project/val/f.ts");
	});

	it("P2: a multi-character double-quoted assignment value is captured in full", () => {
		expect(resolveBashWriteTarget('X="hello world"', "$X.ts", ROOT)).toBe(
			"/Users/dev/project/hello world.ts",
		);
	});

	it("P3: a multi-character single-quoted assignment value is captured in full", () => {
		expect(resolveBashWriteTarget("X='hello world'", "$X.ts", ROOT)).toBe(
			"/Users/dev/project/hello world.ts",
		);
	});
});

describe("resolveCdBase boundary", () => {
	it("N1: extra spaces between cd and its target don't break recognition", () => {
		const cmd = `cd  ${SCRATCHPAD} && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("N2: extra spaces after a -- separator don't break recognition", () => {
		const cmd = `cd --  ${SCRATCHPAD} && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("N3: a single-quoted multi-character cd target resolves fully", () => {
		const cmd = `cd '${SCRATCHPAD}' && echo x > probe.ts`;
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("P4: a later resolvable cd re-establishes the base after an unresolvable one", () => {
		const hit = detectBashCodeFileWrite(`cd $UNKNOWN_CD_VAR && cd ${ROOT}/src && echo x > p.ts`, ROOT);
		expect(hit?.target).toBe("p.ts");
	});

	it("N5: cd - preserves the prior base instead of creating a child directory", () => {
		expect(detectBashCodeFileWrite("cd - && echo x > ../outside.ts", REPO2)).toBeNull();
	});

	it("R3-NEW P5: resolveBashWriteTarget's own multi-line cd base must not merge words", () => {
		// The \r\n -> " " normalize regex appears TWICE in this module (once
		// in detectBashCodeFileWrite, once here) — a separate mutant site.
		expect(resolveBashWriteTarget("cd /tmp/x\necho y", "probe.ts", ROOT)).toBe("/tmp/x/probe.ts");
	});
});
describe("stripQuotedStrings boundary", () => {
	it("N1: a > inside a multi-char double-quoted string is hidden from redirect scanning", () => {
		expect(detectBashCodeFileWrite('echo "note > x.ts " > log.txt')).toBeNull();
	});

	it("N2: same, for a single-quoted string", () => {
		expect(detectBashCodeFileWrite("echo 'note > x.ts ' > log.txt")).toBeNull();
	});
});

describe("splitCommandSegments boundary", () => {
	it("R3-NEW P1: double spaces around && still split into two segments", () => {
		// Isolates the \S+ negation mutants on the separator regex: requiring
		// non-whitespace immediately adjacent to the operator would fail to
		// match at all here (there are 2 real spaces on each side), so the
		// WHOLE string would stay one segment and the verb would parse as
		// "echo", not "cp".
		const hit = detectBashCodeFileWrite("echo a  &&  cp /tmp/x.ts src/seg.ts");
		expect(hit?.target).toBe("src/seg.ts");
	});
});

describe("splitShellWordsLoose boundary", () => {
	it("P1: an escaped quote inside a double-quoted word, followed by a real space, parses as ONE token", () => {
		const hit = detectBashCodeFileWrite('cp /tmp/src.txt "a\\"b c.ts"');
		expect(hit?.target).toBe('a\\"b c.ts');
	});

	it("P2: an escaped SPACE inside a double-quoted word, followed by a real space, parses as ONE token", () => {
		const hit = detectBashCodeFileWrite('cp /tmp/src.txt "a\\ b.ts"');
		expect(hit?.target).toBe("a\\ b.ts");
	});

	it("P3: an escaped SPACE inside a single-quoted word, followed by a real space, parses as ONE token", () => {
		const hit = detectBashCodeFileWrite("cp /tmp/src.txt 'a\\ b.ts'");
		expect(hit?.target).toBe("a\\ b.ts");
	});

	it("P4: an escaped LETTER inside a single-quoted word, followed by a real space, parses as ONE token", () => {
		const hit = detectBashCodeFileWrite("cp /tmp/src.txt 'a\\xb c.ts'");
		expect(hit?.target).toBe("a\\xb c.ts");
	});
});

describe("stripOuterQuotes boundary — asymmetric stray-quote values", () => {
	it("P1: a value starting with a stray single-quote (no matching close) is NOT stripped", () => {
		// Pristine: startsWith("'") true, endsWith("'") false -> AND false ->
		// unchanged. A mutant that treats the two clauses as independent
		// (OR, or duplicated startsWith/endsWith) would strip this asymmetric
		// value and corrupt it.
		expect(resolveBashWriteTarget("X='foo", "$X.ts", ROOT)).toBe("/Users/dev/project/'foo.ts");
	});

	it("P2: a value ending with a stray single-quote (no matching open) is NOT stripped", () => {
		expect(resolveBashWriteTarget("X=foo'", "$X.ts", ROOT)).toBe("/Users/dev/project/foo'.ts");
	});

	it("P3: a value starting with a stray double-quote (no matching close) is NOT stripped", () => {
		expect(resolveBashWriteTarget('X="foo', "$X.ts", ROOT)).toBe('/Users/dev/project/"foo.ts');
	});

	it("P4: a value ending with a stray double-quote (no matching open) is NOT stripped", () => {
		expect(resolveBashWriteTarget('X=foo"', "$X.ts", ROOT)).toBe('/Users/dev/project/foo".ts');
	});
});
