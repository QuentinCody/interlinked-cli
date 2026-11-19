// Kill proof — degenerate killing tests (docs/reviews/kill-proof-gaming.md).
// P<n>: a shape that produced a real `killed` receipt in the gaming red-team without
// exercising the behaviour MUST be flagged. N<n>: a legitimate test shape MUST NOT be.
// Every P case here is the literal test that was run through `tests prove-kill`
// (attack ids in the doc's table) with the path forms it used.

import { describe, expect, it } from "vitest";
import { degenerateDetectorAvailable, detectDegenerateKillTest, formatDegenerateFindings } from "./degenerate-test.js";

const MUTATED = "src/math.ts";
const MATH = "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\nexport const LIMIT = 500;\nexport const render = (x: unknown): string => JSON.stringify(x);\n";
/** `mutatedContent: null` = the caller has no module source (an explicit `undefined` would take the default). */
const run = (content: string, testPath = "test/x.test.ts", mutatedFile = MUTATED, mutatedContent: string | null = MATH) => detectDegenerateKillTest({ content, testPath, mutatedFile, ...(mutatedContent === null ? {} : { mutatedContent }) });
const kinds = (content: string, testPath?: string, mutatedFile?: string) => run(content, testPath, mutatedFile).map(f => f.kind);

const IMPORTS = 'import { readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport { expect, it } from "vitest";\n';

it("is measured only with the typescript dependency present", () => {
	expect(degenerateDetectorAvailable()).toBe(true);
});

describe("degenerate kill tests — positive (must fire)", () => {
	it("P1: attack 1 — reads the mutated file through import.meta.url and asserts on the lexeme", () => {
		const findings = run(`${IMPORTS}it("source still adds", () => {
	const src = readFileSync(fileURLToPath(new URL("../src/math.ts", import.meta.url)), "utf8");
	expect(src).toContain("return a + b;");
});
`);
		expect(findings.map(f => [f.kind, f.line])).toEqual([["source-read", 5], ["source-read", 6]]);
		expect(findings[1]?.detail).toContain("toContain");
	});

	it("P2: attack 2 — pins the sha256 of the mutated file", () => {
		const findings = run(`import { createHash } from "node:crypto";\n${IMPORTS}it("hash", () => {
	const bytes = readFileSync(fileURLToPath(new URL("../src/math.ts", import.meta.url)));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe("20242c64");
});
`);
		expect(findings.map(f => f.kind)).toEqual(["source-read", "source-hash"]);
	});

	it("P3: attack 3 — inline and file snapshots of the source text", () => {
		const inline = kinds(`${IMPORTS}it("snap", () => {
	const src = readFileSync(fileURLToPath(new URL("../src/math.ts", import.meta.url)), "utf8");
	expect(src).toMatchInlineSnapshot(\`"x"\`);
});
`);
		expect(inline).toEqual(["source-read", "source-snapshot"]);
		const file = kinds(`${IMPORTS}it("snap", async () => {
	const src = readFileSync(fileURLToPath(new URL("../src/math.ts", import.meta.url)), "utf8");
	await expect(src).toMatchFileSnapshot("./__snapshots__/math-source.txt");
});
`);
		expect(file).toEqual(["source-read", "source-snapshot"]);
	});

	it("P4: attack 5 — asserts on fn.toString() of an import from the mutated module", () => {
		const text = `import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("body", () => {\n\texpect(add.toString()).toContain("a + b");\n});\n`;
		expect(run(text)).toEqual([{ line: 4, kind: "function-source", detail: expect.stringContaining("add.toString()") }]);
		const ns = `import { expect, it } from "vitest";\nimport * as m from "../src/math.js";\nit("body", () => {\n\texpect(String(m.add)).toContain("a + b");\n\texpect(\`\${m.add}\`).toContain("a + b");\n});\n`;
		expect(kinds(ns)).toEqual(["function-source", "function-source"]);
		// Without the module's source the binding is a function only by the test's own evidence: a call.
		expect(run(text, "test/x.test.ts", MUTATED, null)).toEqual([]);
		expect(run(`${text}it("calls", () => {\n\texpect(add(1, 1)).toBe(2);\n});\n`, "test/x.test.ts", MUTATED, null).map(f => f.kind)).toEqual(["function-source"]);
		expect(kinds(`import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("proto", () => {\n\texpect(Function.prototype.toString.call(add)).toContain("+");\n});\n`)).toEqual(["function-source"]);
	});

	it("P5: attack 8 — process.cwd() concatenation and a path.join over __dirname", () => {
		expect(kinds(`${IMPORTS}it("cwd", () => {\n\texpect(readFileSync(process.cwd() + "/src/math.ts", "utf8")).toContain("a + b");\n});\n`)).toEqual(["source-read"]);
		expect(kinds(`import { join } from "node:path";\n${IMPORTS}it("dir", () => {\n\tconst p = join(__dirname, "..", "src", "math.ts");\n\texpect(readFileSync(p, "utf8")).toContain("a + b");\n});\n`)).toEqual(["source-read"]);
		expect(kinds(`${IMPORTS}it("tpl", () => {\n\tconst s = readFileSync(\`\${process.cwd()}/src/math.ts\`, "utf8");\n\texpect(s).toMatch(/a \\+ b/);\n});\n`)).toEqual(["source-read", "source-read"]);
	});

	it("P6: attack 7b — reads the LIVE twin through realpathSync(node_modules)/..", () => {
		const text = `import { readFileSync, realpathSync } from "node:fs";\nimport { join } from "node:path";\nimport { fileURLToPath } from "node:url";\nimport { expect, it } from "vitest";
it("copy matches live", () => {
	const live = join(realpathSync(join(process.cwd(), "node_modules")), "..", "src", "math.ts");
	const here = fileURLToPath(new URL("../src/math.ts", import.meta.url));
	expect(readFileSync(here, "utf8")).toBe(readFileSync(live, "utf8"));
});
`;
		const found = run(text);
		expect(found.map(f => f.kind)).toContain("live-tree-read");
		expect(found.map(f => f.kind)).toContain("source-read");
	});

	it("P7: attack 9 — a TODO guard that expect.fail()s when the lexeme is gone, plus require.resolve", () => {
		expect(kinds(`${IMPORTS}import { add } from "../src/math";\nit("todo", () => {
	const src = readFileSync(fileURLToPath(new URL("../src/math.ts", import.meta.url)), "utf8");
	if (!src.includes("a + b")) expect.fail("TODO");
	add(1, 1);
});
`)).toEqual(["source-read"]);
		expect(kinds(`${IMPORTS}it("resolve", () => {\n\texpect(readFileSync(require.resolve("../src/math"), "utf8")).toContain("a + b");\n});\n`)).toEqual(["source-read"]);
	});

	it("P8: a git status probe of the project's own tree, and fs.promises.readFile through a bound path", () => {
		expect(kinds(`import { execFileSync } from "node:child_process";\nimport { expect, it } from "vitest";\nit("clean", () => {\n\texpect(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()).toBe("");\n});\n`)).toEqual(["vcs-probe"]);
		expect(kinds(`import fs from "node:fs";\nimport { expect, it } from "vitest";\nconst SRC = new URL("../src/math.ts", import.meta.url);\nit("p", async () => {\n\texpect(await fs.promises.readFile(SRC, "utf8")).toContain("+");\n});\n`)).toEqual(["source-read"]);
	});
});

describe("degenerate kill tests — negative (must not fire)", () => {
	it("N1: reads a FIXTURE file next to the test", () => {
		expect(run(`${IMPORTS}it("fixture", () => {\n\tconst text = readFileSync(fileURLToPath(new URL("./fixtures/sample.ts", import.meta.url)), "utf8");\n\texpect(text).toContain("export");\n});\n`)).toEqual([]);
		expect(run(`import { join } from "node:path";\n${IMPORTS}it("fixture", () => {\n\texpect(readFileSync(join(__dirname, "fixtures", "input.json"), "utf8")).toContain("{");\n});\n`)).toEqual([]);
	});

	it("N2: reads its own snapshot file", () => {
		expect(run(`${IMPORTS}it("snap", () => {\n\tconst snap = readFileSync(new URL("./__snapshots__/x.test.ts.snap", import.meta.url), "utf8");\n\texpect(snap).toContain("exports[");\n});\n`)).toEqual([]);
	});

	it("N3: a legitimate snapshot of a function RESULT, and a hash of a result", () => {
		expect(run(`import { createHash } from "node:crypto";\nimport { expect, it } from "vitest";\nimport { render } from "../src/math";\nit("renders", () => {\n\texpect(render({ a: 1 })).toMatchInlineSnapshot(\`"x"\`);\n\texpect(createHash("sha256").update(render({ a: 2 })).digest("hex")).toBe("abc");\n});\n`)).toEqual([]);
	});

	it("N4: spawns the CLI under test, and git with -C <fixture> / cwd", () => {
		expect(run(`import { execFileSync } from "node:child_process";\nimport { expect, it } from "vitest";\nit("cli", () => {\n\tconst out = execFileSync("node", ["dist/index.js", "status", "--json"], { encoding: "utf8" });\n\texpect(JSON.parse(out).ok).toBe(true);\n});\n`)).toEqual([]);
		expect(run(`import { execFileSync } from "node:child_process";\nimport { expect, it } from "vitest";\nit("fixture repo", () => {\n\texecFileSync("git", ["-C", root, "init", "-q"]);\n\texpect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe("");\n\texpect(execFileSync("git", ["diff", "--stat"], { cwd: root, encoding: "utf8" })).toBe("");\n});\n`)).toEqual([]);
	});

	it("N5: imports the mutated module and asserts on what it RETURNS (the behavioural test)", () => {
		expect(run(`import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => {\n\texpect(add(2, 3)).toBe(5);\n\texpect(add.name).toBe("add");\n\texpect(add.length).toBe(2);\n\texpect(\`\${add(1, 1)}\`).toBe("2");\n});\n`)).toEqual([]);
	});

	it("N6: the same read is not degenerate for a mutant in ANOTHER module", () => {
		const text = `${IMPORTS}it("reads math", () => {\n\texpect(readFileSync(fileURLToPath(new URL("../src/math.ts", import.meta.url)), "utf8")).toContain("+");\n});\n`;
		expect(run(text, "test/x.test.ts", "src/other.ts")).toEqual([]);
		expect(run(text, "test/x.test.ts", "src/math.ts")).toHaveLength(1);
	});

	it("N8: interpolating or String()-ing an imported CONSTANT is a value, not source text (the 92-hit census class)", () => {
		const text = `import { expect, it } from "vitest";\nimport { LIMIT } from "../src/math";\nimport * as m from "../src/math.js";\nit("limit", () => {\n\texpect(\`cap ${"${LIMIT}"}\`).toBe("cap 500");\n\texpect(String(m.LIMIT)).toBe("500");\n\texpect(LIMIT + "").toBe("500");\n});\n`;
		expect(run(text)).toEqual([]);
		expect(run(text, "test/x.test.ts", MUTATED, null)).toEqual([]);
	});

	it("N7: a dynamic path the AST cannot resolve stays silent (UNCERTAIN, not a finding)", () => {
		expect(run(`import { readdirSync, readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nit("walk", () => {\n\tfor (const f of readdirSync("src")) expect(readFileSync(\`src/\${f}\`, "utf8")).toBeTypeOf("string");\n});\n`)).toEqual([]);
	});
});

describe("nudge line", () => {
	it("names the file, line, kinds and the lexeme-not-behaviour reason; null when clean", () => {
		expect(formatDegenerateFindings("test/x.test.ts", [])).toBeNull();
		const line = formatDegenerateFindings("test/x.test.ts", [{ line: 5, kind: "source-read", detail: "readFileSync of the mutated file src/math.ts" }, { line: 6, kind: "source-hash", detail: "d" }]);
		expect(line).toBe("[interlinked:kill-proof] test/x.test.ts: this killing test reads the mutated SOURCE rather than exercising it (source-read, source-hash; test/x.test.ts:5 readFileSync of the mutated file src/math.ts) — a kill by lexeme, not by behaviour");
	});
});
