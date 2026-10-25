// Mutation-hardening tests for the inline-interpreter write guard. Each case
// pins behavior stated in the module header or a doc comment of
// interpreter-write-guard.ts (line references are to that file).

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectInterpreterWrite, interpreterWriteTargets } from "./interpreter-write-guard.js";

const ROOT = "/Users/dev/project";
const detect = (cmd: string, root = ROOT) => detectInterpreterWrite(cmd, root);
const heredoc = (prefix: string, ...body: string[]): string =>
	[`${prefix} <<EOF`, ...body, "EOF"].join("\n");

describe("direct write patterns — positive (must fire)", () => {
	it("blocks python open() in exclusive-create mode 'x' (modes w|a|x, lines 116-117)", () => {
		expect(detect(`python3 -c "open('src/a.ts','x').write(b)"`)?.resolved).toBe(`${ROOT}/src/a.ts`);
	});

	it("blocks a sibling directory whose name merely starts with 'scratch' (only scratch/ is exempt, line 52)", () => {
		expect(detect(`python3 -c "open('scratchpad/a.ts','w').write(b)"`)?.resolved).toBe(
			`${ROOT}/scratchpad/a.ts`,
		);
	});

	it("blocks pathlib write_bytes as well as write_text (line 124)", () => {
		expect(detect(heredoc("python3", 'Path("src/g.py").write_bytes(b)'))).not.toBeNull();
	});

	it("blocks node createWriteStream on a repo file (line 126)", () => {
		expect(detect(`node -e 'fs.createWriteStream("src/a.ts")'`)?.interpreter).toBe("node");
	});

	it("blocks node appendFileSync on a repo file (line 126)", () => {
		expect(detect(`node -e 'fs.appendFileSync("src/a.ts", x)'`)?.interpreter).toBe("node");
	});

	it("blocks ruby File.binwrite on a repo file (line 131)", () => {
		expect(detect(`ruby -e 'File.binwrite("src/a.rb", x)'`)?.interpreter).toBe("ruby");
	});

	it("blocks ruby File.open for writing (line 131)", () => {
		expect(detect(`ruby -e 'File.open("src/a.rb", "w")'`)?.interpreter).toBe("ruby");
	});

	it("blocks perl three-argument append open (line 134)", () => {
		expect(detect(`perl -e 'open(my $fh, ">>", "src/tool.ts"); print $fh $b;'`)?.interpreter).toBe("perl");
	});

	it("blocks perl two-argument append open (line 134)", () => {
		expect(detect(`perl -e 'open(FH, ">>src/tool.ts"); print FH $b;'`)?.interpreter).toBe("perl");
	});
});

describe("direct write patterns — negative (must not fire)", () => {
	it("does not treat ruby File.open for READING as a write (lines 103-104)", () => {
		expect(detect(`ruby -e 'File.open("src/a.rb", "r")'`)).toBeNull();
	});

	it("allows a write to a sibling directory whose name starts with the repo root (outside the repo, line 52)", () => {
		expect(detect(`python3 -c "open('/Users/dev/project2/src/x.ts','w').write(b)"`)).toBeNull();
	});

	it("allows a repo-relative write when the repo itself lives under an ephemeral temp root (line 52, 148-151)", () => {
		const tmpRoot = join(tmpdir(), "interp-guard-mut-repo");
		expect(detect(`python3 -c "open('${tmpRoot}/src/a.ts','w').write(b)"`, tmpRoot)).toBeNull();
	});

	it("returns null when the project root is empty (line 299)", () => {
		expect(detect(`python3 -c "open('src/a.ts','w').write(b)"`, "")).toBeNull();
	});
});

describe("bound destination (indirect) — positive (must fire)", () => {
	it("blocks `with open(dest, 'w')` through a bound path (lines 218-220)", () => {
		const hit = detect(
			heredoc("python3 -", "p = 'src/a.py'", "with open(p, 'w') as f:", "    f.write(x)"),
		);
		expect(hit?.indirect).toBe(true);
		expect(hit?.resolved).toBe(`${ROOT}/src/a.py`);
	});
});

describe("bound destination (indirect) — negative (must not fire)", () => {
	it("abstains when the destination name is mentioned again before the write (reassignment, lines 223-225)", () => {
		expect(
			detect(heredoc("python3 -", "p = 'src/a.ts'", "p = other()", "open(p, 'w').write(x)")),
		).toBeNull();
	});

	it("abstains inside an unmodelled block scope such as match/case (lines 44-46)", () => {
		expect(
			detect(
				heredoc("python3 -", "p = 'src/a.ts'", "match v:", "    case 1:", "        open(p, 'w').write(x)"),
			),
		).toBeNull();
	});

	it("abstains after a working-directory change that moves relative paths (lines 44-46)", () => {
		expect(
			detect(heredoc("python3 -", "p = 'src/a.ts'", "os.chdir(elsewhere)", "open(p, 'w').write(x)")),
		).toBeNull();
	});

	it("does not bind a destination to an assignment that exists only inside a triple-quoted string (lines 245-253)", () => {
		expect(
			detect(
				heredoc(
					"python3 -",
					'doc = """',
					"p = 'src/a.ts'",
					'"""',
					"p = os.environ['OUT']",
					"open(p, 'w').write(x)",
				),
			),
		).toBeNull();
	});

	it("abstains on an unterminated triple-quoted string (lines 247-249)", () => {
		expect(
			detect(heredoc("python3 -", "p = 'src/a.ts'", 'x = """never closed', "open(p, 'w').write(x)")),
		).toBeNull();
	});

	it("ignores a write call that sits inside a comment (lines 224-225)", () => {
		expect(
			detect(heredoc("python3 -", "p = 'src/a.ts'", "# open(p, 'w').write(x)")),
		).toBeNull();
	});

	it("does not treat a method call on another object as a write through the local (line 274)", () => {
		expect(detect(heredoc("python3 -", "p = 'src/a.ts'", "client.open(p, 'w')"))).toBeNull();
	});

	it("rejects a ruby interpolated destination as a non-literal (line 239)", () => {
		expect(
			detect(`ruby -e 'dest = "src/#{name}.rb"; File.write(dest, body)'`),
		).toBeNull();
	});
});

describe("interpreterWriteTargets — every literal destination, unfiltered (lines 324-329)", () => {
	const CWD = "/Users/dev/project";

	it("returns an empty list for an empty command", () => {
		expect(interpreterWriteTargets("", CWD)).toEqual([]);
	});

	it("resolves literal targets without the gate's extension, repo or temp filters", () => {
		const targets = interpreterWriteTargets(
			`python3 -c "open('data/rows.json','w').write(j)"; python3 -c "open('/etc/other.txt','w').write(j)"`,
			CWD,
		);
		expect(targets).toContain(`${CWD}/data/rows.json`);
		expect(targets).toContain("/etc/other.txt");
	});

	it("omits a target the shell could not resolve (unset leading variable)", () => {
		expect(
			interpreterWriteTargets(`python3 -c "open('$UNSET_DEST_VAR_X','w').write(j)"`, CWD),
		).toEqual([]);
	});
});
