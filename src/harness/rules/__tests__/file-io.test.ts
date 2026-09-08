import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readLocalGuardRules,
	readTeamGuardRules,
	writeLocalGuardRules,
	writeTeamGuardRules,
} from "../file-io.js";

const tempDirs: string[] = [];
function mkTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "interlinked-rules-io-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("file-io (guard-rules read/write)", () => {
	it.each(["[]", "null", "42", "true", '"text"'])("rejects a non-object JSON document: %s", (raw) => {
		const dir = mkTmp();
		writeLocalGuardRules({}, dir);
		writeFileSync(join(dir, ".interlinked", "guard-rules.local.json"), raw);
		writeFileSync(join(dir, ".interlinked", "guard-rules.json"), raw);
		expect(readLocalGuardRules(dir)).toBeNull();
		expect(readTeamGuardRules(dir)).toBeNull();
	});
	it("returns null when local file does not exist", () => {
		const dir = mkTmp();
		expect(readLocalGuardRules(dir)).toBeNull();
	});

	it("returns null when team file does not exist", () => {
		const dir = mkTmp();
		expect(readTeamGuardRules(dir)).toBeNull();
	});

	it("round-trips local rules through write/read", () => {
		const dir = mkTmp();
		const data = { version: 1, disabled_rules: ["builtin-foo"] };
		writeLocalGuardRules(data, dir);

		const localPath = join(dir, ".interlinked", "guard-rules.local.json");
		expect(existsSync(localPath)).toBe(true);
		const readBack = readLocalGuardRules(dir);
		expect(readBack).toEqual(data);
	});

	it("round-trips team rules through write/read", () => {
		const dir = mkTmp();
		const data = { version: 1, enabled: true, rules: [] };
		writeTeamGuardRules(data, dir);

		const teamPath = join(dir, ".interlinked", "guard-rules.json");
		expect(existsSync(teamPath)).toBe(true);
		expect(readTeamGuardRules(dir)).toEqual(data);
	});

	it("writes pretty JSON with trailing newline", () => {
		const dir = mkTmp();
		writeLocalGuardRules({ x: 1 }, dir);
		const content = readFileSync(join(dir, ".interlinked", "guard-rules.local.json"), "utf-8");
		expect(content).toMatch(/\n$/);
		expect(content).toContain('"x": 1');
	});

	it("returns null when file contains invalid JSON", () => {
		const dir = mkTmp();
		// Write a broken file to the local path
		writeLocalGuardRules({ ok: true }, dir);
		const localPath = join(dir, ".interlinked", "guard-rules.local.json");
		// Corrupt the file
		const fs = require("node:fs");
		fs.writeFileSync(localPath, "{not valid json");
		expect(readLocalGuardRules(dir)).toBeNull();
	});
});
