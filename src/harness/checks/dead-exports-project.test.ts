import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkDeadExports, checkDeadTypeExports, findDeadExports, findDeadTypeExports } from "./dead-exports-inline.js";
import { getProjectCheckEvidence, withProjectCheckEvidence } from "./project-check-evidence.js";
import { checkExportRipple } from "./export-ripple.js";
import { checkDuplicateTypeDeclaration } from "./type-redundancy.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function project(sources: Record<string, string>) {
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
	const root = mkdtempSync(join(resolve("scratch"), "dead-export-project-"));
	roots.push(root);
	for (const [file, body] of Object.entries(sources)) writeFileSync(join(root, file), body);
	vi.mocked(readFileSync).mockClear();
	return { root, files: Object.keys(sources).map(file => join(root, file)), repo: { listFiles: () => Object.keys(sources), readFile: (file: string) => sources[file] ?? null } };
}

it("MUST-FIRE: full scans retain more than ten value and type findings", async () => {
	const body = Array.from({ length: 24 }, (_, index) => `export const orphan${index} = ${index};\nexport type Type${index} = string;`).join("\n");
	const { root, files } = await project({ "target.ts": body });
	withProjectCheckEvidence(root, files, () => {
		expect(checkDeadExports(body, join(root, "target.ts"), root)).toHaveLength(24);
		expect(checkDeadTypeExports(body, join(root, "target.ts"), root)).toHaveLength(24);
	});
});

it.each([
	'import { used, type UsedType } from "./target.js";',
	'export * from "./target.js";',
	'const lazy = import("./target.js");',
	'import { used } from "@/target";',
])("MUST-NOT-FIRE: preserves existing consumption/evidence predicates %s", async importer => {
	const body = "export const used = 1;\nexport const orphan = 2;\nexport interface UsedType { value: string }\nexport interface OrphanType { field: number }\n";
	const { root, files, repo } = await project({ "target.ts": body, "consumer.ts": importer });
	const args = { content: body, filePath: "target.ts", cwd: root };
	const values = findDeadExports(args, repo), types = findDeadTypeExports(args, repo);
	withProjectCheckEvidence(root, files, () => {
		expect(checkDeadExports(body, join(root, "target.ts"), root)).toEqual(values);
		expect(checkDeadTypeExports(body, join(root, "target.ts"), root)).toEqual(types);
	});
});

it("MUST-NOT-FIRE: unreadable source cannot establish unused exports", async () => {
	const body = "export const orphan = 1;\n", onGap = vi.fn();
	const { root, files } = await project({ "target.ts": body });
	withProjectCheckEvidence(root, [...files, join(root, "missing.ts")], () => {
		expect(checkDeadExports(body, join(root, "target.ts"), root)).toEqual([]);
	}, onGap);
	expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ check: "dead_exports", file: "missing.ts" }));
});

it("shares complete source reads between the value/type lanes and every target", async () => {
	const sources: Record<string, string> = {};
	for (let index = 0; index < 28; index++) sources[`target${index}.ts`] = `export const orphan${index} = ${index};\nexport type Type${index} = string;`;
	const { root, files } = await project(sources);
	withProjectCheckEvidence(root, files, () => {
		for (const [file, body] of Object.entries(sources)) {
			expect(checkDeadExports(body, join(root, file), root)).toHaveLength(1);
			expect(checkDeadTypeExports(body, join(root, file), root)).toHaveLength(1);
		}
	});
	expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(root))).toHaveLength(files.length);
});

it("excluded generated sources remain usage context while their definitions and broken imports emit no findings", async () => {
	const body = "export const used = 1;\nexport const orphan = 2;\nexport interface Shared { value: string }";
	const generated = 'import { used, gone } from "./target.js";\nexport const synthetic = 3;\nexport interface Shared { value: number }';
	const { root, files } = await project({ "target.ts": body, "generated.ts": generated });
	withProjectCheckEvidence(root, files, () => {
		const evidence = getProjectCheckEvidence(root);
		evidence?.excludeFile("generated.ts", "generated");
		expect(evidence?.listFiles()).toContain("generated.ts");
		const unused = checkDeadExports(body, join(root, "target.ts"), root);
		expect(unused).toHaveLength(1);
		expect(unused[0]?.text).toContain("orphan");
		expect(checkDeadExports(generated, join(root, "generated.ts"), root)).toEqual([]);
		expect(checkDeadTypeExports(generated, join(root, "generated.ts"), root)).toEqual([]);
		expect(checkExportRipple(body, join(root, "target.ts"), root)).toEqual([]);
		expect(checkDuplicateTypeDeclaration(body, join(root, "target.ts"), root)).toEqual([]);
	});
});
