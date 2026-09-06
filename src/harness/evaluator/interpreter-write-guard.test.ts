// Tests for the inline-interpreter write guard (`builtin-interpreter-write`).
//
// The positive cases are modelled on the live incident this guard exists for
// (scratch/fleet-r3/repair-followups.txt finding #18, 2026-08-15): with the
// daemon crash-looping, a build agent ran `python - <<EOF … open(p,"w").write(…)
// … EOF` for 4 of its 7 repo files, so the line cap, the pre_block registry and
// the coverage ratchet never saw them — one file landed at exactly the 500-line
// cap with zero headroom.
//
// MANUAL PROBE (needs a live daemon; from the repo root):
//
//   interlinked harness test $'python3 - <<EOF\nopen("src/harness/probe.ts","w").write("x")\nEOF'
//     → block, rule_id builtin-interpreter-write
//   interlinked harness test 'python3 -c "print(open(\'src/harness/server.ts\').read())"'
//     → allow (read-only program)
//   interlinked harness test $'python3 - <<EOF\nopen("scratch/probe.ts","w").write("x")\nEOF'
//     → allow (scratch/ is the sanctioned probe dir)
//   INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD=1 interlinked harness test '<the first one>'
//     → allow, with an [interlinked:interpreter-write] bypass warning

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	buildInterpreterWriteReason,
	detectComputedInterpreterWrite,
	detectInterpreterWrite,
	evaluateInterpreterWriteGuard,
	isInterpreterWriteGuardDisabled,
} from "./interpreter-write-guard.js";

const ROOT = "/Users/dev/project";

/** A heredoc command: `<prefix> <<DELIM` + body lines + terminator. */
const heredoc = (prefix: string, delimiter: string, ...body: string[]): string =>
	[`${prefix} <<${delimiter}`, ...body, delimiter.replace(/['"]/g, "")].join("\n");

const detect = (cmd: string) => detectInterpreterWrite(cmd, ROOT);

const makeEvent = (overrides: Partial<HarnessEvent> = {}): HarnessEvent =>
	// SAFETY: the guard reads only tool_name / tool_input.command / cwd; a full
	// HarnessEvent fixture would restate every unrelated optional field.
	({
		hook_event: "PreToolUse",
		session_id: "s-interp-1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: {},
		timestamp: "2026-08-15T00:00:00Z",
		cwd: ROOT,
		...overrides,
		// SAFETY: guard reads only the fields set above.
	}) as HarnessEvent;

const run = (cmd: string, overrides: Partial<HarnessEvent> = {}) => {
	const warnings: string[] = [];
	const event = makeEvent({ tool_input: { command: cmd }, ...overrides });
	const decision = evaluateInterpreterWriteGuard(
		event,
		event.tool_name ?? "Bash",
		event.tool_input ?? {},
		warnings,
	);
	return { decision, warnings };
};

afterEach(() => {
	delete process.env.INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD;
});

describe("detectInterpreterWrite — positive (must fire)", () => {
	it("P1: python heredoc writing a repo source file (the 2026-08-15 incident shape)", () => {
		const hit = detect(
			heredoc(
				"python3 -",
				"EOF",
				"p = 'src/harness/server/lifecycle-stop-warnings.ts'",
				"open('src/harness/server/lifecycle-stop-warnings.ts','w').write(BODY)",
			),
		);
		expect(hit).not.toBeNull();
		expect(hit?.interpreter).toBe("python3");
		expect(hit?.form).toContain("heredoc");
		expect(hit?.resolved).toBe(`${ROOT}/src/harness/server/lifecycle-stop-warnings.ts`);
	});

	it("P2: python -c one-liner opening a repo file for append", () => {
		const hit = detect(`python3 -c "open('src/lib/config.ts','a').writelines(rows)"`);
		expect(hit).not.toBeNull();
		expect(hit?.form).toBe("-c");
		expect(hit?.target).toBe("src/lib/config.ts");
	});

	it("P3: node -e calling fs.writeFileSync on a repo file", () => {
		const hit = detect(
			`node -e 'require("fs").writeFileSync("src/harness/x.ts", "export {};")'`,
		);
		expect(hit).not.toBeNull();
		expect(hit?.interpreter).toBe("node");
		expect(hit?.writeCall).toContain("writeFileSync");
	});

	it("P4: VAR= indirection — the path arrives through a same-command assignment", () => {
		const hit = detect(
			`DEST=src/harness/generated.ts python3 - <<EOF\nopen("$DEST","w").write(payload)\nEOF`,
		);
		expect(hit).not.toBeNull();
		expect(hit?.resolved).toBe(`${ROOT}/src/harness/generated.ts`);
	});

	it("P5: cd hop — a bare filename resolves against the cd destination", () => {
		const hit = detect(
			`cd src/harness && python3 - <<'PY'\nopen("landed.ts","w").write(body)\nPY`,
		);
		expect(hit).not.toBeNull();
		expect(hit?.resolved).toBe(`${ROOT}/src/harness/landed.ts`);
	});

	it("P6: node heredoc using fs.promises.writeFile", () => {
		const hit = detect(
			heredoc("node -", "JS", 'await fs.promises.writeFile("src/a.ts", body);'),
		);
		expect(hit).not.toBeNull();
		expect(hit?.interpreter).toBe("node");
	});

	it("P7: ruby File.write into repo source", () => {
		const hit = detect(`ruby -e 'File.write("src/app.rb", body)'`);
		expect(hit).not.toBeNull();
		expect(hit?.interpreter).toBe("ruby");
	});

	it("P8: perl three-argument open for write", () => {
		const hit = detect(`perl -e 'open(my $fh, ">", "src/tool.ts"); print $fh $body;'`);
		expect(hit).not.toBeNull();
		expect(hit?.interpreter).toBe("perl");
	});

	it("P9: pathlib write_text on a repo file", () => {
		const hit = detect(heredoc("python3", "PY", 'Path("src/gen.py").write_text(body)'));
		expect(hit).not.toBeNull();
	});

	// P10–P12 are followup #26: one line of indirection between the repo-path
	// literal and the write call. Both P10 and P11 are the exact shapes that
	// evaded this guard twice on 2026-08-16.
	it("P10: heredoc assigns the repo path to a variable, then writes through it", () => {
		const hit = detect(
			heredoc(
				"python3 -",
				"EOF",
				"p1 = 'src/harness/evaluator/landed.ts'",
				"body = 'export const x = 1;'",
				"open(p1, 'w').write(body)",
			),
		);
		expect(hit).not.toBeNull();
		expect(hit?.indirect).toBe(true);
		expect(hit?.resolved).toBe(`${ROOT}/src/harness/evaluator/landed.ts`);
		expect(hit?.writeCall).toContain("open(p1");
	});

	it("P11: the python -c equivalent of the same indirection", () => {
		const hit = detect(`python3 -c "p1='src/lib/config.ts'; open(p1,'w').write(payload)"`);
		expect(hit).not.toBeNull();
		expect(hit?.indirect).toBe(true);
		expect(hit?.target).toBe("src/lib/config.ts");
	});

	it("P12: node indirection — fs.writeFileSync(dest, …) with dest assigned above", () => {
		const hit = detect(
			heredoc("node -", "JS", 'const dest = "src/harness/gen.ts";', "fs.writeFileSync(dest, body);"),
		);
		expect(hit).not.toBeNull();
		expect(hit?.indirect).toBe(true);
		expect(hit?.resolved).toBe(`${ROOT}/src/harness/gen.ts`);
	});
});

describe("detectInterpreterWrite — negative (must not fire)", () => {
	it("N1: read-only / print-only interpreter program", () => {
		expect(
			detect(heredoc("python3 -", "EOF", "print(open('src/harness/server.ts').read())")),
		).toBeNull();
	});

	it("N2: explicit read mode is not a write", () => {
		expect(detect(`python3 -c "data = open('src/a.ts','r').read()"`)).toBeNull();
	});

	it("N3: write targeting an ephemeral temp path", () => {
		const target = join(tmpdir(), "probe", "draft.ts");
		expect(detect(`python3 -c "open('${target}','w').write(x)"`)).toBeNull();
	});

	it("N4: write targeting <repo>/scratch/ — the sanctioned probe dir", () => {
		expect(
			detect(heredoc("python3 -", "EOF", "open('scratch/probe.ts','w').write(x)")),
		).toBeNull();
	});

	it("N5: shell redirect only — the existing bash-write gate owns this", () => {
		expect(detect(`echo "export const x = 1;" > src/harness/x.ts`)).toBeNull();
	});

	it("N6: heredoc fed to cat with a redirect — still the existing redirect path", () => {
		expect(detect(heredoc("cat", "EOF", "export const x = 1;").concat(" > src/x.ts"))).toBeNull();
	});

	it("N7: interpreter write outside the guarded repo", () => {
		expect(detect(`python3 -c "open('/Users/dev/other/src/x.ts','w').write(b)"`)).toBeNull();
	});

	it("N8: in-repo target with a non-code extension", () => {
		expect(detect(heredoc("python3 -", "EOF", "open('data/rows.json','w').write(j)"))).toBeNull();
	});

	it("N9: an interpreter write QUOTED as data inside another command", () => {
		expect(
			detect(`echo "python3 -c \\"open('src/x.ts','w')\\"" >> docs/notes.md`),
		).toBeNull();
	});

	it("N10: unresolvable target variable is not provably in-repo", () => {
		expect(
			detect(heredoc("python3 -", "EOF", 'open("$UNSET_DEST_VAR","w").write(x)')),
		).toBeNull();
	});

	it("N11: empty command", () => {
		expect(detect("")).toBeNull();
	});

	// N12–N14 bound the program-scope pass (followup #26): a repo literal alone
	// is not a write, and a write whose own literal destination is provably
	// outside the gate stays outside it.
	it("N12: repo path assigned to a variable but only READ through it", () => {
		expect(
			detect(heredoc("python3 -", "EOF", "p = 'src/harness/server.ts'", "print(open(p).read())")),
		).toBeNull();
	});

	it("N13: reads a repo source literal, writes through a literal /tmp path", () => {
		const target = join(tmpdir(), "probe", "out.ts");
		expect(
			detect(
				heredoc(
					"python3 -",
					"EOF",
					"src = open('src/harness/server.ts').read()",
					`open('${target}', 'w').write(src)`,
				),
			),
		).toBeNull();
	});

	it("N14: indirect write with no repo-source literal anywhere in the program", () => {
		expect(
			detect(heredoc("python3 -", "EOF", "p = os.environ['OUT']", "open(p, 'w').write(body)")),
		).toBeNull();
	});

	// `VAR=value<<EOF` is real shell: bash sets the variable with stdin redirected
	// from the heredoc and runs NO command at all. The command-word scan therefore
	// walks assignment after assignment and reaches the end of the segment without
	// ever meeting a verb — a heredoc with no interpreter is not a program, even
	// though its body carries the incident's own write call. The long `divider=`
	// assignment keeps the scan inside assignments for the whole bounded
	// look-ahead window, which is what makes the segment run out rather than stop
	// on the first non-assignment word.
	it("N15: a heredoc attached to a segment of pure VAR= assignments has no interpreter", () => {
		const body = [
			`divider="${"=".repeat(100)}"`,
			`open("src/harness/landed.ts","w").write(body)`,
		];
		expect(detect(["PYBODY=x<<EOF", ...body, "EOF"].join("\n"))).toBeNull();
		// Control: the very same body IS a block once the segment has a real
		// command word, so the null above is the missing interpreter and nothing
		// else about the payload.
		expect(detect(["python3 -<<EOF", ...body, "EOF"].join("\n"))?.resolved).toBe(
			`${ROOT}/src/harness/landed.ts`,
		);
	});
});

describe("evaluateInterpreterWriteGuard", () => {
	const INCIDENT = heredoc("python3 -", "EOF", "open('src/harness/x.ts','w').write(body)");

	it("blocks with the builtin-interpreter-write rule id and names the target", () => {
		const { decision } = run(INCIDENT);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-interpreter-write");
		expect(decision?.category).toBe("harness-integrity");
		expect(decision?.reason).toContain(`${ROOT}/src/harness/x.ts`);
	});

	it("allows a read-only interpreter program", () => {
		const { decision } = run(heredoc("python3 -", "EOF", "print(open('src/a.ts').read())"));
		expect(decision).toBeNull();
	});

	it("ignores non-Bash tools", () => {
		const { decision } = run(INCIDENT, { tool_name: "Write" });
		expect(decision).toBeNull();
	});

	it("ignores events with no project root", () => {
		const { cwd: _cwd, ...rootless } = makeEvent({ tool_input: { command: INCIDENT } });
		const decision = evaluateInterpreterWriteGuard(rootless, "Bash", { command: INCIDENT }, []);
		expect(decision).toBeNull();
	});

	it("downgrades to a logged warning under the bypass env var", () => {
		process.env.INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD = "1";
		const { decision, warnings } = run(INCIDENT);
		expect(decision).toBeNull();
		expect(warnings.join("\n")).toContain("[interlinked:interpreter-write]");
	});

	// Gap 4's soft path at the EVENT level: the block passes both come back empty
	// (nothing in the program resolves to a repo-source literal), so the guard
	// allows the command and the only trace it leaves is the warning.
	it("warns without blocking when the inline program's write destination is computed", () => {
		const { decision, warnings } = run(`node -e 'require("fs").writeFileSync(dest, body)'`);
		expect(decision).toBeNull();
		expect(warnings).toEqual([
			expect.stringContaining(
				"Inline node program calls writeFileSync( with a COMPUTED destination",
			),
		]);
	});

	it("stays silent on an inline program with no write call at all", () => {
		const { decision, warnings } = run(`node -e 'console.log(fs.readFileSync(p,"utf8"))'`);
		expect(decision).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("persists nothing, so a dry run behaves exactly like a live one", () => {
		const live = run(INCIDENT).decision;
		const dry = run(INCIDENT, { dry_run: true }).decision;
		expect(dry?.decision).toBe(live?.decision);
	});
});

describe("isInterpreterWriteGuardDisabled", () => {
	it("is off by default and on only for the exact opt-out value", () => {
		expect(isInterpreterWriteGuardDisabled()).toBe(false);
		process.env.INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD = "true";
		expect(isInterpreterWriteGuardDisabled()).toBe(false);
		process.env.INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD = "1";
		expect(isInterpreterWriteGuardDisabled()).toBe(true);
	});
});

describe("buildInterpreterWriteReason", () => {
	it("names the interpreter, the write call, the target and the bypass", () => {
		const reason = buildInterpreterWriteReason({
			interpreter: "python3",
			form: "heredoc (<<EOF)",
			writeCall: "open('src/a.ts','w')",
			target: "src/a.ts",
			resolved: `${ROOT}/src/a.ts`,
		});
		expect(reason).toContain("python3");
		expect(reason).toContain("open('src/a.ts','w')");
		expect(reason).toContain(`${ROOT}/src/a.ts`);
		expect(reason).toContain("INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD=1");
	});
});

describe("detectComputedInterpreterWrite — gap 4 soft warn (2026-08-25)", () => {
	it("P1: node -e with a computed writeFileSync destination is flagged", () => {
		const soft = detectComputedInterpreterWrite(
			`node -e 'const fs=require("fs");fs.writeFileSync(path.join(dir,"x.ts"), body)'`,
		);
		expect(soft?.call).toBe("writeFileSync");
	});

	it("N1: a literal destination is NOT the soft path (the block passes own it)", () => {
		expect(
			detectComputedInterpreterWrite(`node -e 'fs.writeFileSync("/tmp/x.ts", body)'`),
		).toBeNull();
	});

	it("N2: a read-only inline program is not flagged", () => {
		expect(
			detectComputedInterpreterWrite(`node -e 'console.log(fs.readFileSync(p,"utf8"))'`),
		).toBeNull();
	});
});
