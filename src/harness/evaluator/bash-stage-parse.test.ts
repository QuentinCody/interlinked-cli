import { describe, expect, it } from "vitest";
import {
	boundVariables,
	commandHead,
	expandArgv,
	hasUnresolvedVar,
	maskQuoted,
	splitPipelines,
	stripStageKeywords,
} from "./bash-stage-parse.js";

describe("splitPipelines — positive (must split / extract)", () => {
	it("P1: pipes join stages; ; && || and newlines end statements", () => {
		const ps = splitPipelines("curl -s u | rg x | tee o; cd a && cat f || true\nls");
		expect(ps.map((p) => p.stages.map((s) => s.argv[0]))).toEqual([["curl", "rg", "tee"], ["cd"], ["cat"], ["true"], ["ls"]]);
	});

	it("P2: redirect targets leave argv and land in outputs / inputs", () => {
		const s = splitPipelines("rg -o k < in.html > out.txt 2>/dev/null")[0]?.stages[0];
		expect(s).toMatchObject({ argv: ["rg", "-o", "k"], inputs: ["in.html"], outputs: ["out.txt", "/dev/null"], dynamic: false });
	});

	it("P3: quoted separators and operators are data", () => {
		const ps = splitPipelines(`rg -o '"a":"[^"]+" | x > y' f.html`);
		expect(ps).toHaveLength(1);
		expect(ps[0]?.stages[0]?.argv).toEqual(["rg", "-o", `"a":"[^"]+" | x > y`, "f.html"]);
	});

	it("P4: fd duplication (2>&1) and &> do not split the stage", () => {
		const s = splitPipelines("curl -s u 2>&1 &> log.txt")[0]?.stages;
		expect(s?.map((x) => x.argv)).toEqual([["curl", "-s", "u"]]);
		expect(s?.[0]?.outputs).toEqual(["log.txt"]);
	});

	it("P5: loop keywords are stripped from the stage head", () => {
		expect(stripStageKeywords(["do", "FOO=1", "rg", "x"])).toEqual(["rg", "x"]);
		expect(splitPipelines("for s in a b; do rg k f_$s; done").map((p) => p.stages[0]?.argv[0])).toEqual(["for", "rg", "done"]);
	});

	it("P6: substitution, grouping, braces and heredocs mark the stage dynamic", () => {
		for (const cmd of ["cat $(ls)", "cat `ls`", "(cd a && cat f)", "rg x <(cat f)", "cat <<EOF", "rg a{1,2}"]) {
			expect(splitPipelines(cmd).some((p) => p.stages.some((s) => s.dynamic))).toBe(true);
		}
	});
});

describe("splitPipelines — negative (must not split / flag)", () => {
	it("N1: `${name}` braces are not grouping", () => {
		expect(splitPipelines("rg k f_${s}.html")[0]?.stages[0]?.dynamic).toBe(false);
	});

	it("N2: `>|` is a clobber redirect, not a pipe", () => {
		const ps = splitPipelines("echo hi >| out.txt");
		expect(ps[0]?.stages).toHaveLength(1);
		expect(ps[0]?.stages[0]?.outputs).toEqual(["out.txt"]);
	});

	it("N3: blank statements produce no pipelines", () => {
		expect(splitPipelines(" ; ;\n")).toEqual([]);
	});
});

describe("maskQuoted / commandHead / hasUnresolvedVar", () => {
	it("P7: masks quoted content and escapes, keeping length", () => {
		expect(maskQuoted(`a 'b|c' "d;e" f\\|g`)).toBe(`a '___' "___" f__g`);
	});

	it("P8: commandHead takes the basename, lower-cased", () => {
		expect([commandHead("/usr/bin/CURL"), commandHead(undefined)]).toEqual(["curl", ""]);
	});

	it("P9/N4: unresolved expansions are detected; a trailing literal $ is not", () => {
		expect(["$HOME/x", "${a}", "$(x)", "a$1"].map(hasUnresolvedVar)).toEqual([true, true, true, true]);
		expect(["foo$", "plain", "a$ b"].map(hasUnresolvedVar)).toEqual([false, false, false]);
	});
});

describe("boundVariables / expandArgv", () => {
	it("P10: for-lists and literal assignments bind; expansions substitute jointly", () => {
		const vars = boundVariables(splitPipelines("D=out; for s in a b; do curl -o $D/y_$s.html u?v=${s}; done"));
		expect([...vars.entries()]).toEqual([["D", ["out"]], ["s", ["a", "b"]]]);
		expect(expandArgv(["curl", "-o", "$D/y_$s.html", "u?v=${s}"], vars)).toEqual([
			["curl", "-o", "out/y_a.html", "u?v=a"],
			["curl", "-o", "out/y_b.html", "u?v=b"],
		]);
	});

	it("N5: a value that itself expands is not bound; unbound names stay in place", () => {
		const vars = boundVariables(splitPipelines("K=$GCP_KEY; for f in $LIST; do echo $f; done"));
		expect(vars.size).toBe(0);
		expect(expandArgv(["echo", "$K"], vars)).toEqual([["echo", "$K"]]);
	});

	it("N6: too many joint expansions yield null", () => {
		const vars = new Map([["a", Array.from({ length: 9 }, (_, i) => `${i}`)], ["b", Array.from({ length: 9 }, (_, i) => `${i}`)]]);
		expect(expandArgv(["x", "$a$b"], vars)).toBeNull();
	});
});
