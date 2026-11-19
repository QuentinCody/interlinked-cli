import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoveryInputs } from "./discovery-inputs.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "e2e-inputs-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("applies the caller's byte budget including multibyte text and empty files", () => {
	const path = join(dir, "input");
	writeFileSync(path, "éé");
	expect(discoveryInputs(4).readText(path)).toBe("éé");
	expect(discoveryInputs(3).readText(path)).toBeNull();
	writeFileSync(path, "");
	expect(discoveryInputs(0).readText(path)).toBe("");
	expect(discoveryInputs(32).readText(dir)).toBeNull();
	expect(discoveryInputs(32).readText(join(dir, "missing"))).toBeNull();
});

it("accepts JSON object roots and declines malformed, array and primitive roots", () => {
	const { readJson } = discoveryInputs(64);
	const path = join(dir, "manifest");
	writeFileSync(path, '{"entries":[]}');
	expect(readJson(path)).toEqual({ entries: [] });
	for (const text of ["[]", "null", "12", "{"]) {
		writeFileSync(path, text);
		expect(readJson(path)).toBeNull();
	}
});

it.skipIf(process.platform === "win32")("declines a named pipe without waiting for a writer", () => {
	const path = join(dir, "pipe");
	execFileSync("mkfifo", [path]);
	// Wake a regressed blocking reader so this test fails without hanging the suite.
	const writer = spawn(process.execPath, ["-e", 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "pipe"), 100)', path], { stdio: "ignore" });
	try { expect(discoveryInputs(64).readText(path)).toBeNull(); }
	finally { writer.kill(); }
});
