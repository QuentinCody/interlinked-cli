import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkDuplicateTypeDeclaration } from "./type-redundancy.js";
import { withProjectCheckEvidence } from "./project-check-evidence.js";
import * as typeBodies from "../project-graph/interface-bodies.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function project(sources: Record<string, string>) {
	const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
	const root = mkdtempSync(join(resolve("scratch"), "types-project-"));
	roots.push(root);
	for (const [file, body] of Object.entries(sources)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), body);
	}
	vi.mocked(readFileSync).mockClear();
	return { root, files: Object.keys(sources).map(file => join(root, file)) };
}

it("MUST-FIRE: full scans retain more than fifteen distinct duplicate names", async () => {
	const body = Array.from({ length: 22 }, (_, index) => `export interface Shared${index} { value: string }`).join("\n");
	const peer = body.replaceAll("string", "number");
	const { root, files } = await project({ "self.ts": body, "peer.ts": peer });
	const matches = withProjectCheckEvidence(root, files, () => checkDuplicateTypeDeclaration(body, join(root, "self.ts"), root));
	expect(matches).toHaveLength(22);
	expect(matches.at(-1)?.text).toContain("Shared21");
});

it("MUST-NOT-FIRE: complete target scans share one source read and one peer body census", async () => {
	const sources: Record<string, string> = {};
	for (let index = 0; index < 30; index++) sources[`module${index}.ts`] = `export interface Shared { field${index}: string }`;
	const { root, files } = await project(sources);
	const parse = vi.spyOn(typeBodies, "extractInterfaceBodies");
	withProjectCheckEvidence(root, files, () => {
		for (const [file, body] of Object.entries(sources)) expect(checkDuplicateTypeDeclaration(body, join(root, file), root)).toHaveLength(1);
	});
	expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(root))).toHaveLength(files.length);
	expect(parse.mock.calls.length).toBeLessThanOrEqual(files.length * 2);
});

it("preserves first-peer selection and same-directory move grouping", async () => {
	const body = "export interface Shared { value: string }\nexport interface Other { enabled: boolean }";
	const { root, files } = await project({ "self.ts": body, "first.ts": body, "elsewhere/second.ts": body.replaceAll("string", "number") });
	const matches = withProjectCheckEvidence(root, files, () => checkDuplicateTypeDeclaration(body, join(root, "self.ts"), root));
	expect(matches).toHaveLength(1);
	expect(matches[0]?.text).toContain("move in progress: 2 type(s) identical to first.ts");
});

it("retains positive duplicate evidence alongside unreadable inputs", async () => {
	const body = "export interface Shared { value: string }", onGap = vi.fn();
	const { root, files } = await project({ "self.ts": body, "peer.ts": body.replace("string", "number") });
	const matches = withProjectCheckEvidence(root, [...files, join(root, "missing.ts")], () => checkDuplicateTypeDeclaration(body, join(root, "self.ts"), root), onGap);
	expect(matches).toHaveLength(1);
	expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ check: "duplicate_type_declaration", file: "missing.ts" }));
});
