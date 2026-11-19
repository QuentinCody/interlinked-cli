import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkCircularImports } from "./agent-safety-advanced.js";
import { getProjectCheckEvidence, withProjectCheckEvidence } from "./project-check-evidence.js";
import { findStrongComponents } from "./circular-imports-project.js";
import { parseImports } from "../project-graph.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: vi.fn() }));
vi.mock("../project-graph.js", async original => {
	const actual = await original<typeof import("../project-graph.js")>();
	return { ...actual, parseImports: vi.fn(actual.parseImports) };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function project(sources: Record<string, string>) {
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
	const root = mkdtempSync(join(resolve("scratch"), "circular-project-"));
	roots.push(root);
	for (const [file, body] of Object.entries(sources)) writeFileSync(join(root, file), body);
	vi.mocked(readFileSync).mockClear();
	return { root, files: Object.keys(sources).map(file => join(root, file)) };
}

it("MUST-FIRE: selected full scans detect every member of a cycle beyond the live depth cap", async () => {
	const sources: Record<string, string> = {};
	for (let index = 0; index < 20; index++) sources[`module${index}.ts`] = `import './module${(index + 1) % 20}.js';\n`;
	const { root, files } = await project(sources);
	const matches = withProjectCheckEvidence(root, files, () => Object.entries(sources).flatMap(([file, body]) => checkCircularImports(body, join(root, file), root)));
	expect(matches).toHaveLength(20);
	expect(matches.every(match => match.text.includes("20 modules"))).toBe(true);
});

it("MUST-FIRE: a cycle after a broad acyclic prefix is not hidden by the live visit cap", async () => {
	const sources: Record<string, string> = { "cycle.ts": "import './entry';" };
	const leaves = Array.from({ length: 32 }, (_, index) => `leaf${index}`);
	const hubs = Array.from({ length: 32 }, (_, index) => `hub${index}`);
	for (const leaf of leaves) sources[`${leaf}.ts`] = "export const value = 1;";
	for (const hub of hubs) sources[`${hub}.ts`] = leaves.map(leaf => `import './${leaf}';`).join("\n");
	const body = [...hubs, "cycle"].map(name => `import './${name}';`).join("\n");
	sources["entry.ts"] = body;
	const { root, files } = await project(sources);
	expect(withProjectCheckEvidence(root, files, () => checkCircularImports(body, join(root, "entry.ts"), root))).toHaveLength(1);
});

it("MUST-FIRE: large selected siblings retain import edges at the end of their complete bodies", async () => {
	const body = "import './large';";
	const { root, files } = await project({ "entry.ts": body, "large.ts": `//${"x".repeat(300 * 1024)}\nimport './entry';` });
	expect(withProjectCheckEvidence(root, files, () => checkCircularImports(body, join(root, "entry.ts"), root))).toHaveLength(1);
});

it.each([
	{ first: "import type { Other } from './other';", other: "import './entry';" },
	{ first: "import './entry';", other: "export const other = 1;" },
	{ first: "import './other';", other: "export const other = 1;" },
	{ first: "import './other';", other: "/** @type {import('./entry').Settings} */\nexport const other = 1;" },
])("MUST-NOT-FIRE: preserves acyclic, self-only, erased-type and comment boundaries %j", async ({ first, other }) => {
	const { root, files } = await project({ "entry.ts": first, "other.ts": other });
	expect(withProjectCheckEvidence(root, files, () => checkCircularImports(first, join(root, "entry.ts"), root))).toEqual([]);
});

it("retains known cyclic membership alongside unreadable and unresolved reachable evidence", async () => {
	const body = "import './other';\nimport './missing';\nimport './unreadable';", onGap = vi.fn();
	const { root, files } = await project({ "entry.ts": body, "other.ts": "import './entry';" });
	const matches = withProjectCheckEvidence(root, [...files, join(root, "unreadable.ts")], () => checkCircularImports(body, join(root, "entry.ts"), root), onGap);
	expect(matches).toHaveLength(1);
	expect(onGap.mock.calls).toEqual(expect.arrayContaining([
		[expect.objectContaining({ check: "circular_imports", file: "unreadable.ts" })],
		[expect.objectContaining({ check: "circular_imports", file: "entry.ts", reason: expect.stringContaining("./missing") })],
	]));
});

it("MUST-NOT-FIRE: unrelated test fixtures do not add graph coverage gaps", async () => {
	const body = "import './other';", onGap = vi.fn();
	const { root, files } = await project({ "entry.ts": body, "other.ts": "import './entry';", "fixture.test.ts": "import './absent-test-fixture';" });
	expect(withProjectCheckEvidence(root, files, () => checkCircularImports(body, join(root, "entry.ts"), root), onGap)).toHaveLength(1);
	expect(onGap).not.toHaveBeenCalled();
});

it("retains gaps for test context actually imported by an eligible source", async () => {
	const body = "import './fixture.test';", onGap = vi.fn();
	const { root, files } = await project({ "entry.ts": body, "fixture.test.ts": "import './absent-test-fixture';" });
	withProjectCheckEvidence(root, files, () => checkCircularImports(body, join(root, "entry.ts"), root), onGap);
	expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ check: "circular_imports", file: "fixture.test.ts" }));
});

it("does not read source outside the explicit selected population", async () => {
	const body = "import './hidden';", onGap = vi.fn();
	const { root, files } = await project({ "entry.ts": body });
	const hidden = join(root, "hidden.ts");
	writeFileSync(hidden, "import './entry';");
	const matches = withProjectCheckEvidence(root, files, () => checkCircularImports(body, join(root, "entry.ts"), root), onGap);
	expect(matches).toEqual([]);
	expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ check: "circular_imports", file: "entry.ts", reason: expect.stringContaining("outside selected") }));
	expect(vi.mocked(readFileSync).mock.calls.filter(([file]) => file === hidden)).toEqual([]);
});

it("retains an explicit parse failure once while other readable components remain available", async () => {
	const body = "import './other';", onGap = vi.fn();
	const { root, files } = await project({ "broken.ts": "controlled input", "entry.ts": body, "other.ts": "import './entry';" });
	vi.mocked(parseImports).mockClear();
	vi.mocked(parseImports).mockImplementationOnce(() => { throw new Error("controlled import-parser failure"); });
	withProjectCheckEvidence(root, files, () => {
		expect(checkCircularImports(body, join(root, "entry.ts"), root)).toHaveLength(1);
		expect(checkCircularImports("import './entry';", join(root, "other.ts"), root)).toHaveLength(1);
	}, onGap);
	expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ check: "circular_imports", file: "broken.ts", reason: expect.stringContaining("controlled import-parser failure") }));
	expect(parseImports).toHaveBeenCalledTimes(files.length);
});

it("shares one graph across targets, keeps excluded context and refreshes a later invocation", async () => {
	const body = "import './generated';", peer = "import './entry';";
	const { root, files } = await project({ "entry.ts": body, "generated.ts": peer });
	withProjectCheckEvidence(root, files, () => {
		getProjectCheckEvidence(root)?.excludeFile("generated.ts", "generated");
		expect(checkCircularImports(body, join(root, "entry.ts"), root)).toHaveLength(1);
		expect(checkCircularImports(peer, join(root, "generated.ts"), root)).toEqual([]);
		expect(checkCircularImports(body, join(root, "entry.ts"), root)).toHaveLength(1);
	});
	expect(vi.mocked(readFileSync).mock.calls.filter(([file]) => typeof file === "string" && file.startsWith(root))).toHaveLength(files.length);
	writeFileSync(join(root, "generated.ts"), "export const generated = true;");
	expect(withProjectCheckEvidence(root, files, () => checkCircularImports(body, join(root, "entry.ts"), root))).toEqual([]);
});

it("represents dense cyclic components without enumerating their simple cycles", () => {
	const nodes = Array.from({ length: 18 }, (_, index) => `node${index}`);
	const graph = new Map(nodes.map(node => [node, nodes.filter(other => other !== node)]));
	const components = findStrongComponents(graph);
	expect(components).toHaveLength(1);
	expect(new Set(components[0])).toEqual(new Set(nodes));
});

it("handles deep graphs iteratively without a call-stack depth limit", () => {
	const count = 20_000;
	const graph = new Map(Array.from({ length: count }, (_, index) => [`node${index}`, [`node${(index + 1) % count}`]]));
	const components = findStrongComponents(graph);
	expect(components).toHaveLength(1);
	expect(components[0]).toHaveLength(count);
});

it("MUST-NOT-FIRE: a loop that needs a lazy dynamic import() edge is not a load-time cycle", async () => {
	const sources: Record<string, string> = {
		"a.ts": "import { b } from './b';\nexport const a = b;\n",
		"b.ts": "export async function b() { return import('./a'); }\n",
	};
	const { root, files } = await project(sources);
	const matches = withProjectCheckEvidence(root, files, () => Object.entries(sources).flatMap(([file, body]) => checkCircularImports(body, join(root, file), root)));
	expect(matches).toHaveLength(0);
});

it("MUST-FIRE: the same two files with a static back edge are still a cycle", async () => {
	const sources: Record<string, string> = {
		"a.ts": "import { b } from './b';\nexport const a = b;\n",
		"b.ts": "import { a } from './a';\nexport const b = a;\n",
	};
	const { root, files } = await project(sources);
	const matches = withProjectCheckEvidence(root, files, () => Object.entries(sources).flatMap(([file, body]) => checkCircularImports(body, join(root, file), root)));
	expect(matches).toHaveLength(2);
});
