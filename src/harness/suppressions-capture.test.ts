import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureFileSuppressions, loadFileSuppressions } from "./suppressions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const entry = { reason: "selected fixture", by: "test", at: "2026-11-12" };

it("P1 captures the same exact/glob/partially-valid records as the existing live loader", () => {
	const root = mkdtempSync(join(process.cwd(), "scratch", "suppression-capture-")); roots.push(root);
	const directory = join(root, ".interlinked"); mkdirSync(directory);
	const text = JSON.stringify({ "src/a.ts": { exact: entry, malformed: false }, "src/**/*.ts": { deep: entry }, "src/?.ts": { single: entry }, "other.ts": 42 });
	writeFileSync(join(directory, "verify-suppressions.json"), text);
	const captured = captureFileSuppressions(text);
	for (const file of ["src/a.ts", "src/nested/worker.ts", "other.ts", "unmatched.ts"]) {
		expect(captured(file)).toEqual(loadFileSuppressions(directory, file));
	}
});

it("P2 binds the initial bytes while returning independently mutable sets", () => {
	const text = JSON.stringify({ "a.ts": { original: entry } });
	const captured = captureFileSuppressions(text);
	const first = captured("a.ts"); first.add("caller-mutation");
	expect(captured("a.ts")).toEqual(new Set(["original"]));
	expect(captureFileSuppressions(JSON.stringify({ "a.ts": { changed: entry } }))("a.ts")).toEqual(new Set(["changed"]));
	expect(captured("a.ts")).toEqual(new Set(["original"]));
});

it("N1 keeps an empty captured mapping empty", () => {
	expect(captureFileSuppressions("{}")("a.ts")).toEqual(new Set());
});

it("N2 surfaces invalid JSON to the capture owner", () => {
	expect(() => captureFileSuppressions("{ invalid")).toThrow();
});
