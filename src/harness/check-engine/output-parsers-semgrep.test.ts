import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseSemgrepJson } from "./output-parsers-semgrep.js";

it.each(["src/file.ts", "./src/file.ts", resolve("scratch/foreign-semgrep/src/file.ts")])("anchors reported path %s to the scanned root, independently of process cwd", path => {
	const root = resolve("scratch/foreign-semgrep");
	const output = JSON.stringify({ results: [{ path, start: { line: 7 }, extra: { message: "Review" } }] });
	expect(parseSemgrepJson(output, root)).toEqual([expect.objectContaining({ file: join("src", "file.ts"), line: 7 })]);
});
