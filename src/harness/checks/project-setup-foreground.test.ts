import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkProjectSetup } from "./project-setup.js";
import { checkProjectSetup as verifyProjectSetup } from "../../commands/verify/tool-results.js";
import { currentVerifyTimings, withVerifyTimings } from "../../commands/verify/check-timing.js";

vi.mock("node:fs", async original => ({
	...await original<typeof import("node:fs")>(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
}));

describe("foreground project setup source evidence", () => {
	let root: string;
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "project-setup-foreground-"));
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync);
		vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
	});
	afterEach(() => { vi.resetAllMocks(); rmSync(root, { recursive: true, force: true }); });

	it("P1: sees TypeScript after the runtime twenty-thousand-entry bound", () => {
		for (let index = 0; index < 20_001; index++) writeFileSync(join(root, `entry-${index}.txt`), "");
		writeFileSync(join(root, "zzz-late.ts"), "export const value = 1;\n");
		expect(checkProjectSetup(root)).toEqual([]);
		expect(checkProjectSetup(root, { foreground: true })).toContainEqual(expect.objectContaining({
			message: "TypeScript files found but no tsconfig.json exists",
		}));
	});

	it("P2: finds an ancestor tsconfig beyond the runtime lookup depth", () => {
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		const nested = join(root, "a/b/c/d/e/f");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "index.ts"), "export const value = 1;\n");
		expect(checkProjectSetup(nested)).toContainEqual(expect.objectContaining({ message: "TypeScript files found but no tsconfig.json exists" }));
		expect(checkProjectSetup(nested, { foreground: true })).toEqual([]);
	});

	it("P3: reports an unreadable source directory instead of claiming complete absence", () => {
		const onUnavailable = vi.fn();
		vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES: source directory"); });
		expect(checkProjectSetup(root, { foreground: true, onUnavailable })).toEqual([]);
		expect(onUnavailable).toHaveBeenCalledWith({ file: root, reason: "EACCES: source directory" });
	});

	it("P4: reports unavailable source bytes while retaining independent setup findings", () => {
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false } }));
		writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
		const read = fs.readFileSync;
		const implementation = vi.mocked(read).getMockImplementation()!;
		vi.mocked(read).mockImplementation((...args: Parameters<typeof read>) => {
			if (String(args[0]) === join(root, "index.ts")) throw new Error("EACCES: source bytes");
			return implementation(...args);
		});
		const onUnavailable = vi.fn();
		expect(checkProjectSetup(root, { foreground: true, onUnavailable })).toContainEqual(expect.objectContaining({ message: expect.stringContaining("strict mode") }));
		expect(onUnavailable).toHaveBeenCalledWith({ file: join(root, "index.ts"), reason: "EACCES: source bytes" });
	});

	it("N1: dependency-only TypeScript does not make a JavaScript project TypeScript", () => {
		mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(root, "node_modules/pkg/index.ts"), 'import fs from "node:fs";');
		writeFileSync(join(root, "index.js"), "export const value = 1;\n");
		const onUnavailable = vi.fn();
		expect(checkProjectSetup(root, { foreground: true, onUnavailable })).toEqual([]);
		expect(onUnavailable).not.toHaveBeenCalled();
	});

	it("P6: malformed dependency metadata stays unknown instead of asserting missing declarations", () => {
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: ["node"] } }));
		writeFileSync(join(root, "index.ts"), 'import { readFileSync } from "node:fs";\n');
		writeFileSync(join(root, "package.json"), "{ invalid");
		const onUnavailable = vi.fn();
		expect(checkProjectSetup(root, { foreground: true, onUnavailable })).toEqual([]);
		expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({ file: join(root, "package.json") }));
	});

	it.each(["tsx", "mts", "cts"])("P7: checks eligible TypeScript %s source in foreground", extension => {
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		writeFileSync(join(root, `index.${extension}`), 'import { readFileSync } from "node:fs";\n');
		expect(checkProjectSetup(root, { foreground: true })).toContainEqual(expect.objectContaining({
			file: "package.json", message: expect.stringContaining("node: protocol imports"),
		}));
	});

	it("P5: public verification records unavailable setup evidence and a partial exit", async () => {
		const previousExitCode = process.exitCode;
		vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES: source directory"); });
		try {
			await withVerifyTimings(root, () => {
				expect(verifyProjectSetup(root)).toEqual([]);
				expect(currentVerifyTimings()).toContainEqual(expect.objectContaining({
					check: "project_setup", unavailable_inputs: [{ file: root, reason: "EACCES: source directory" }],
				}));
			});
			expect(process.exitCode).toBe(75);
		} finally { process.exitCode = previousExitCode; }
	});
});
