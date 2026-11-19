import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkExportRipple } from "./export-ripple.js";
import { withProjectCheckEvidence } from "./project-check-evidence.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function project(sources: Record<string, string>) {
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
	const root = mkdtempSync(join(resolve("scratch"), "export-project-"));
	roots.push(root);
	for (const [file, body] of Object.entries(sources)) writeFileSync(join(root, file), body);
	vi.mocked(readFileSync).mockClear();
	return { root, files: Object.keys(sources).map(file => join(root, file)) };
}

it("MUST-FIRE: full scans detect ordinary relative imports without an unrelated bare basename", async () => {
	const body = "export const present = 1;\n";
	const { root, files } = await project({ "target.ts": body, "consumer.ts": 'import { present, removed } from "./target.js";\n' });
	const matches = withProjectCheckEvidence(root, files, () => checkExportRipple(body, join(root, "target.ts"), root));
	expect(matches).toEqual([{ line: 0, text: 'consumer.ts:1 imports "removed" which no longer exists in exports' }]);
});

it("MUST-FIRE: full scans retain more than 15 lines, importers and names on one line", async () => {
	const body = "export const present = 1;\n";
	const sources: Record<string, string> = { "target.ts": body };
	for (let index = 0; index < 24; index++) sources[`consumer-${index}.ts`] = `import { gone${index} } from "./target.js";\n`;
	sources["many.ts"] = `import { ${Array.from({ length: 23 }, (_, index) => `extra${index}`).join(", ")} } from "./target.js";\n`;
	sources["lines.ts"] = Array.from({ length: 21 }, (_, index) => `import { line${index} } from "./target.js";`).join("\n");
	const { root, files } = await project(sources);
	const matches = withProjectCheckEvidence(root, files, () => checkExportRipple(body, join(root, "target.ts"), root));
	expect(matches).toHaveLength(68);
	expect(matches.some(match => match.text.includes('imports "extra22"'))).toBe(true);
	expect(matches.some(match => match.text.includes("consumer-23.ts"))).toBe(true);
	expect(matches.at(-1)?.text).toBe('lines.ts:21 imports "line20" which no longer exists in exports');
});

it("MUST-NOT-FIRE: every source is read once across the complete target population", async () => {
	const sources: Record<string, string> = {};
	for (let index = 0; index < 32; index++) {
		sources[`target-${index}.ts`] = "export const present = 1;\n";
		sources[`consumer-${index}.ts`] = `import { gone${index} } from "./target-${index}.js";\n`;
	}
	const { root, files } = await project(sources);
	const matches = withProjectCheckEvidence(root, files, () => Object.entries(sources).flatMap(([file, body]) => checkExportRipple(body, join(root, file), root)));
	expect(matches).toHaveLength(32);
	const reads = vi.mocked(readFileSync).mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(root));
	expect(reads).toHaveLength(files.length);
	expect(new Set(reads.map(([path]) => path)).size).toBe(files.length);
});

it("MUST-NOT-FIRE: a fresh invocation observes changed importers and newly selected files", async () => {
	const body = "export const present = 1;\n";
	const { root, files } = await project({ "target.ts": body, "consumer.ts": 'import { gone } from "./target.js";\n' });
	expect(withProjectCheckEvidence(root, files, () => checkExportRipple(body, join(root, "target.ts"), root))).toHaveLength(1);
	writeFileSync(join(root, "consumer.ts"), 'import { present } from "./target.js";\n');
	writeFileSync(join(root, "added.ts"), 'import { newlyGone } from "./target.js";\n');
	const second = withProjectCheckEvidence(root, [...files, join(root, "added.ts")], () => checkExportRipple(body, join(root, "target.ts"), root));
	expect(second).toEqual([{ line: 0, text: 'added.ts:1 imports "newlyGone" which no longer exists in exports' }]);
});

it("retains readable findings alongside explicit unavailable project evidence", async () => {
	const body = "export const present = 1;\n", onGap = vi.fn();
	const { root, files } = await project({ "target.ts": body, "consumer.ts": 'import { gone } from "./target.js";\n' });
	const matches = withProjectCheckEvidence(root, [...files, join(root, "missing.ts")], () => checkExportRipple(body, join(root, "target.ts"), root), onGap);
	expect(matches).toHaveLength(1);
	expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ check: "export_ripple", file: "missing.ts" }));
});

it.each(["import", "import type"])("MUST-NOT-FIRE: %s of a JavaScript JSDoc typedef into TypeScript retains namespace uncertainty", async syntax => {
	const body = "/** @typedef Params\n * @property {boolean} enabled\n */\nexport const present = 1;\n", onGap = vi.fn();
	const { root, files } = await project({ "target.js": body, "consumer.ts": `${syntax} { Params } from "./target.js";\nexport type Settings = Params;` });
	const matches = withProjectCheckEvidence(root, files, () => checkExportRipple(body, join(root, "target.js"), root), onGap);
	expect(matches).toEqual([]);
	expect(onGap).toHaveBeenCalledWith({ check: "export_ripple", file: "consumer.ts", reason: 'Line 1 imports JSDoc name "Params" from target.js. Type/value namespace is unresolved' });
});

it("MUST-FIRE: a JSDoc typedef cannot supply a missing JavaScript runtime value", async () => {
	const body = "/** @typedef Params */\nexport const present = 1;\n";
	const { root, files } = await project({ "target.js": body, "consumer.js": 'import { Params } from "./target.js";\nconsole.log(Params);', "other.ts": 'import { missingValue } from "./target.js";\nconsole.log(missingValue);' });
	const matches = withProjectCheckEvidence(root, files, () => checkExportRipple(body, join(root, "target.js"), root));
	expect(matches).toEqual([
		{ line: 0, text: 'consumer.js:1 imports "Params" which no longer exists in exports' },
		{ line: 0, text: 'other.ts:1 imports "missingValue" which no longer exists in exports' },
	]);
});
