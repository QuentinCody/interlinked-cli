import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitPipelines } from "./bash-stage-parse.js";
import { filterInputs } from "./stage-operands.js";

let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "stage-ops-")));
	writeFileSync(join(dir, "a.html"), "a");
	writeFileSync(join(dir, "b.html"), "b");
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "c.txt"), "c");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function inputs(command: string): string[] | null {
	const stages = splitPipelines(command).flatMap((p) => p.stages);
	const stage = stages[stages.length - 1];
	if (!stage) throw new Error("no stage");
	return filterInputs({ command, cwd: dir }, stage, stage.argv);
}

describe("filterInputs — positive (files resolved)", () => {
	it("P1: plain operands, `<` inputs, flag values and globs resolve to existing files", () => {
		expect(inputs(`rg -o '"k":"[^"]+"' a.html`)).toEqual([join(dir, "a.html")]);
		expect(inputs("cat < b.html")).toEqual([join(dir, "b.html")]);
		expect(inputs("rg --file=a.html x")).toEqual([join(dir, "a.html")]);
		expect(inputs("cat *.html")).toEqual([join(dir, "a.html"), join(dir, "b.html")]);
	});

	it("P2: a same-command cd moves the base; patterns that name no file are ignored", () => {
		expect(inputs("cd sub && head -n 5 c.txt")).toEqual([join(dir, "sub", "c.txt")]);
		expect(inputs("rg -o 'AIza.*' a.html")).toEqual([join(dir, "a.html")]);
	});

	it("P3: a filter reading stdin has no input files; tee arguments are outputs", () => {
		expect(inputs("cat a.html | grep x")).toEqual([]);
		expect(inputs("cat a.html | tee a.html")).toEqual([]);
	});
});

describe("filterInputs — negative (null = not modeled)", () => {
	it("N1: directory operands, unresolved variables, and non-filter heads", () => {
		expect(inputs("grep -r x sub")).toBeNull();
		expect(inputs("cat $SECRET_FILE")).toBeNull();
		expect(inputs("python3 x.py a.html")).toBeNull();
	});

	it("N2: filter flags that run commands or read the environment", () => {
		expect(inputs("rg --pre 'cat ~/.creds' x a.html")).toBeNull();
		expect(inputs("jq -n env")).toBeNull();
		expect(inputs("jq '$ENV.KEY' a.html")).toBeNull();
	});

	it("N3: a wildcard directory segment that matches something is not modeled", () => {
		expect(inputs("cat s*/c.txt")).toBeNull();
	});
});
