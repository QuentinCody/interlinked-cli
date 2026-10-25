import { describe, expect, it } from "vitest";
import { isLiteralContext, literalContextRegions } from "./literal-context.js";

/** True when the FIRST occurrence of `needle` in `cmd` lies in a data-only region. */
function exempt(cmd: string, needle: string): boolean {
	const start = cmd.indexOf(needle);
	expect(start, `fixture must contain ${needle}`).toBeGreaterThanOrEqual(0);
	return isLiteralContext(cmd, start, start + needle.length);
}

/** The source text of every region, in order. */
function regionTexts(cmd: string): string[] {
	return literalContextRegions(cmd).map((r) => cmd.slice(r.start, r.end));
}

const DATA = "rm -rf /";

// Basis for the wrapper / launcher tests: module header (a) "an argument of
// `interlinked harness test`" and the harnessTestArgs doc comment "and its
// dev-mode spellings" (literal-context.ts:132); skipWrapper doc comment (:92).
describe("literal-context mutation hardening — wrappers and launchers (positive: data)", () => {
	it("an `env VAR=x` wrapper before `interlinked harness test` still leaves the argument as data", () => {
		expect(exempt(`env FOO=1 interlinked harness test '${DATA}'`, DATA)).toBe(true);
	});

	it("`timeout -k N DURATION` skips the kill-after value and the duration", () => {
		expect(exempt(`timeout -k 5 30 interlinked harness test '${DATA}'`, DATA)).toBe(true);
	});

	it("`timeout --long-flag DURATION` skips a dash flag that takes no value", () => {
		expect(exempt(`timeout --preserve-status 30 interlinked harness test '${DATA}'`, DATA)).toBe(true);
	});

	it("a leading VAR=value assignment is skipped when finding the command name", () => {
		expect(exempt(`FOO=1 interlinked harness test '${DATA}'`, DATA)).toBe(true);
	});

	it("the `test-command` spelling of the harness subcommand is data too", () => {
		expect(exempt(`interlinked harness test-command '${DATA}'`, DATA)).toBe(true);
	});

	it("`npx interlinked harness test` is a recognised launcher", () => {
		expect(exempt(`npx interlinked harness test '${DATA}'`, DATA)).toBe(true);
	});

	it("`node <path>/index.js harness test` is a recognised dev-mode launcher", () => {
		expect(exempt(`node dist/index.js harness test '${DATA}'`, DATA)).toBe(true);
	});

	it("`tsx <path>/index.ts harness test` is a recognised dev-mode launcher", () => {
		expect(exempt(`tsx src/index.ts harness test '${DATA}'`, DATA)).toBe(true);
	});

	it("the region of a harness-test argument ends exactly at the closing quote's content", () => {
		const cmd = `interlinked harness test 'abc'`;
		const [region] = literalContextRegions(cmd);
		expect(region).toBeDefined();
		expect(cmd.slice(region?.start, region?.end)).toBe("abc");
		// one byte past the end of the argument is not inside the region
		const start = cmd.indexOf("abc");
		expect(isLiteralContext(cmd, start, start + 4)).toBe(false);
	});
});

describe("literal-context mutation hardening — interpreter programs", () => {
	it("a node -p program's string literal is data", () => {
		expect(exempt(`node -p "'${DATA}'"`, DATA)).toBe(true);
	});

	it("a perl clustered -ne flag selects the inline program", () => {
		expect(exempt(`perl -ne 'print "alpha beta"'`, "alpha beta")).toBe(true);
	});

	it("a ruby clustered -ne flag selects the inline program", () => {
		expect(exempt(`ruby -ne 'puts "alpha beta"'`, "alpha beta")).toBe(true);
	});

	it("an unquoted-delimiter heredoc without expansions is data", () => {
		expect(exempt(`python3 - <<PY\nprint('${DATA}')\nPY`, DATA)).toBe(true);
	});

	it("a `<<-` heredoc operator takes no redirect target, so a following `>&2` still parses as the redirect", () => {
		expect(exempt(`python3 - <<-'PY'\n\tprint('${DATA}')\nPY`, DATA)).toBe(true);
		expect(exempt(`python3 - <<-'PY' >&2\n\tprint('${DATA}')\nPY`, DATA)).toBe(true);
	});
});

describe("literal-context mutation hardening — interpreter programs (negative: not data)", () => {
	it("a script run with a heredoc on stdin is not an inline program", () => {
		expect(exempt(`python3 run.py <<'PY'\nprint('${DATA}')\nPY`, DATA)).toBe(false);
	});

	it("an unquoted heredoc body with a parameter expansion is not data", () => {
		expect(exempt(`python3 - <<PY\nprint("hello $HOME ${DATA}")\nPY`, DATA)).toBe(false);
	});

	it("an fs method outside the known callee list still makes its string argument an operand", () => {
		const cmd = `node -e "fs.truncateSync('/etc/passwd')"`;
		expect(exempt(cmd, "/etc/passwd")).toBe(false);
	});

	it("a later (non-first) argument of a file-access call whose earlier argument is a nested call is an operand", () => {
		expect(exempt(`python3 -c "x=open(str(1), '${DATA}')"`, DATA)).toBe(false);
	});

	it("a bracket inside an earlier string literal does not unbalance the walk to the call", () => {
		expect(exempt(`python3 -c "open('a)', '${DATA}')"`, DATA)).toBe(false);
	});

	it("a literal far from the program start with no enclosing call is not data (walk limit gives up conservatively)", () => {
		// literal-context.ts:76 — characters walked back before giving up
		const far = `python3 -c "${"x=1;".repeat(120)}y='${DATA}'"`;
		expect(exempt(far, DATA)).toBe(false);
		const near = `python3 -c "${"x=1;".repeat(10)}y='${DATA}'"`;
		expect(exempt(near, DATA)).toBe(true);
	});
});

describe("literal-context mutation hardening — file operand detection (positive: data)", () => {
	it("a string used as a subscript on an fs-prefixed name is not a call argument", () => {
		expect(exempt(`node -e "fs.cache['${DATA}']"`, DATA)).toBe(true);
	});
});

// literal-context.ts:21 — "the segment's pipeline must end only in plain data sinks".
describe("literal-context mutation hardening — pipelines and redirects", () => {
	it("a `|&` pipe into sh is an executing sink", () => {
		expect(exempt(`echo '${DATA}' |& sh`, DATA)).toBe(false);
	});

	it("a data sink with an unsafe file redirect downstream makes the upstream text non-data", () => {
		const cmd = `echo '${DATA}' | cat > scratch/x.sh; bash scratch/x.sh`;
		expect(exempt(cmd, DATA)).toBe(false);
	});

	it("echo whose stderr/stdout is duplicated onto fd 2 stays data", () => {
		expect(exempt(`echo '${DATA}' >&2`, DATA)).toBe(true);
	});

	it("echo whose output fd is closed with >&- stays data", () => {
		expect(exempt(`echo '${DATA}' >&-`, DATA)).toBe(true);
	});

	// redirectIsData doc comment, literal-context.ts:297-298: only stdout/stderr duplication is data.
	it("an input-side duplication from a non-stdio descriptor (zsh coprocess) is not data", () => {
		expect(exempt(`echo '${DATA}' <&p`, DATA)).toBe(false);
	});
});

// literal-context.ts:18 — "the PATTERN argument of grep/rg/ugrep/ag".
describe("literal-context mutation hardening — grep / sed / awk patterns", () => {
	it("a long option that takes a value does not become the positional pattern", () => {
		const cmd = `grep --max-count 5 '${DATA}' notes`;
		expect(regionTexts(cmd)).toEqual([DATA]);
	});

	it("rg --exec disables the pattern context like --pre", () => {
		expect(exempt(`rg --exec '${DATA}' foo`, DATA)).toBe(false);
	});

	it("after `--` the first positional is still the pattern and later words are files", () => {
		const cmd = `grep a -- '${DATA}'`;
		expect(exempt(cmd, DATA)).toBe(false);
		expect(regionTexts(cmd)).toEqual(["a"]);
	});

	it("`--` followed by the pattern makes that word the pattern", () => {
		expect(regionTexts(`grep -- '${DATA}' notes`)).toEqual([DATA]);
	});

	it("a sed /re/p script without -n is not exempt (it also prints every line)", () => {
		expect(exempt(`sed '/${DATA.replace(/\//g, "\\/")}/p' f`, DATA.replace(/\//g, "\\/"))).toBe(false);
		expect(exempt(`sed '/ALPHA/p' f`, "ALPHA")).toBe(false);
	});

	it("awk -f means the program is in a file: no word is a program", () => {
		expect(exempt(`awk -f '${DATA}' data`, DATA)).toBe(false);
	});

	it("an awk program that reads with getline is not exempt", () => {
		expect(exempt(`awk 'BEGIN{getline x < "${DATA}"}'`, DATA)).toBe(false);
	});

	it("an awk -v assignment value is not the program; the next word is", () => {
		expect(regionTexts(`awk -v 'x=${DATA}' '{print}' f`)).toEqual(["{print}"]);
	});

	it("an awk -F separator value is not the program; the next word is", () => {
		const cmd = `awk -F ':' '{print "${DATA}"}' f`;
		expect(regionTexts(cmd)).toEqual([`{print "${DATA}"}`]);
		expect(exempt(cmd, DATA)).toBe(true);
	});
});
