import { describe, expect, it } from "vitest";
import {
	collectFlagPrograms,
	collectHeredocPrograms,
	findHeredocs,
	interpreterName,
	interpreterOf,
} from "./interpreter-programs.js";

describe("interpreterName / interpreterOf — positive (must fire)", () => {
	it("P1: a path-qualified interpreter word resolves to its name", () => {
		expect(interpreterName("/usr/bin/python3.12")).toBe("python3.12");
	});
	it("P2: a segment that starts with a compound keyword still names its interpreter", () => {
		expect(interpreterOf("do python3 -c 'print(1)'")).toBe("python3");
		expect(interpreterOf("then node -e 'x'")).toBe("node");
	});
	it("P3: assignments and wrappers before the interpreter are skipped", () => {
		expect(interpreterOf("U=x sudo env ruby -e 'p 1'")).toBe("ruby");
	});
});

describe("interpreterName / interpreterOf — negative (must not fire)", () => {
	it("N1: a shell is not an inline-program interpreter", () => {
		expect(interpreterName("bash")).toBeNull();
	});
	it("N2: the first real word decides — an interpreter quoted after echo is data", () => {
		expect(interpreterOf("echo python3 -c x")).toBeNull();
	});
	it("N3: an empty segment has no interpreter", () => {
		expect(interpreterOf("   ")).toBeNull();
	});
});

describe("findHeredocs — positive (must fire)", () => {
	it("P1: returns the body and the span through the terminator line", () => {
		const cmd = "python3 - <<'PY'\nprint(1)\nPY\necho done";
		const [doc] = findHeredocs(cmd);
		expect(doc?.delimiter).toBe("PY");
		expect(doc?.body).toBe("print(1)");
		expect(cmd.slice(nonNullEnd(doc?.bodyEnd))).toBe("\necho done");
	});
	it("P2: a missing terminator yields the rest of the command as the body", () => {
		expect(findHeredocs("cat <<EOF\na\nb")[0]?.body).toBe("a\nb");
	});
	it("P3: two sequential heredocs are both found", () => {
		const docs = findHeredocs("cat <<A\n1\nA\ncat <<B\n2\nB");
		expect(docs.map((d) => d.body)).toEqual(["1", "2"]);
	});
});

describe("findHeredocs — negative (must not fire)", () => {
	it("N1: a here-string is not a heredoc", () => {
		expect(findHeredocs('read a b <<< "$x"\nwhile true; do :; done')).toEqual([]);
	});
	it("N2: a shift operator inside an earlier heredoc body is program text", () => {
		const docs = findHeredocs("python3 - <<EOF\ny = 1 << n\nn\nEOF");
		expect(docs).toHaveLength(1);
		expect(docs[0]?.body).toBe("y = 1 << n\nn");
	});
	it("N3: an operator with no following line has no body", () => {
		expect(findHeredocs("cat <<EOF")).toEqual([]);
	});
});

describe("collectHeredocPrograms / collectFlagPrograms — positive (must fire)", () => {
	it("P1: an interpreter heredoc is a program", () => {
		expect(collectHeredocPrograms("python3 - <<'PY'\nimport os\nPY")).toEqual([
			{ interpreter: "python3", form: "heredoc (<<PY)", body: "import os" },
		]);
	});
	it("P2: an inline -e program is a program", () => {
		expect(collectFlagPrograms("node -e 'fetch(u)'")[0]?.body).toBe("fetch(u)");
	});
	it("P3: an inline program inside a loop body is a program", () => {
		expect(collectFlagPrograms("for f in a; do python3 -c 'print(1)'; done")).toHaveLength(1);
	});
});

describe("collectHeredocPrograms / collectFlagPrograms — negative (must not fire)", () => {
	it("N1: a heredoc fed to cat is not a program", () => {
		expect(collectHeredocPrograms("cat <<EOF\nimport os\nEOF")).toEqual([]);
	});
	it("N2: an inline program quoted inside echo is data", () => {
		expect(collectFlagPrograms("echo \"python3 -c 'x'\"")).toEqual([]);
	});
	it("N3: an interpreter running a script file has no inline program", () => {
		expect(collectFlagPrograms("python3 tool.py --flag")).toEqual([]);
	});
});

function nonNullEnd(value: number | undefined): number {
	if (value === undefined) throw new Error("heredoc missing");
	return value;
}
