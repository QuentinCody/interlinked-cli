import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFindings } from "./finding-discovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("advisory typed finding discovery", () => {
	it("P2/N2: retrieves brand construction and non-boolean sink values without declaring them violations", () => {
		const root = mkdtempSync(join(tmpdir(), "finding-discovery-")); roots.push(root);
		writeFileSync(join(root, "source.ts"), 'type Id = string & {readonly __brand:"Id"};\nconst id = input as Id;\nconst tuple = [id] as const;\nconst strings = input as string[];\nconsole.log({access_token: !!input});\nconsole.log({password: input});');
		const found = discoverFindings(root, { files: ["source.ts"] });
		expect(found.cases.filter(row => row.family === "brand_ownership")).toHaveLength(1);
		expect(found.cases.filter(row => row.family === "secret_flow")).toHaveLength(1);
	});
	it("P1: finds a discarded typed failure through an alias but accepts returned outcomes and void calls", () => {
		const root = mkdtempSync(join(tmpdir(), "finding-discovery-")); roots.push(root);
		writeFileSync(join(root, "operations.ts"), 'export function save(): {ok:true}|{ok:false,error:string} { return {ok:false,error:"failure"}; }');
		writeFileSync(join(root, "application.ts"), 'import {save as persist} from "./operations";\nexport function ignored() { persist(); }\nexport function forwarded() { return persist(); }\nfunction log(): void {}\nlog();');
		const found = discoverFindings(root, { files: ["application.ts", "operations.ts"] });
		const outcomes = found.cases.filter(row => row.id.includes("discarded-outcome"));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.claim).toContain("persist");
		expect(outcomes[0]?.sources.some(row => row.file === "operations.ts")).toBe(true);
	});
	it("N1: refuses an escaped source list and exposes unavailable files", () => {
		const root = mkdtempSync(join(tmpdir(), "finding-discovery-")); roots.push(root);
		expect(() => discoverFindings(root, { files: ["../secret.ts"] })).toThrow("confined");
		expect(discoverFindings(root, { files: ["missing.ts"] }).notMeasured).toContain("missing.ts: unavailable source");
		expect(() => discoverFindings(root, { files: Array(10_001).fill("missing.ts") })).toThrow("at most 10000");
	});
	it("keeps default source bounds while foreground surveys discover typed outcomes after 1 MB", () => {
		const root = mkdtempSync(join(process.cwd(), "scratch", "finding-discovery-full-")); roots.push(root);
		const source = `/* ${"padding".repeat(150_000)} */\nfunction attempt(): {ok:true}|{ok:false,error:string} { return {ok:false,error:"failure"}; }\nattempt();`;
		writeFileSync(join(root, "source.ts"), source);
		expect(discoverFindings(root, { files: ["source.ts"] })).toMatchObject({ files: 0, cases: [], notMeasured: ["source.ts: unavailable source"] });
		const found = discoverFindings(root, { files: ["source.ts"] }, { resourcePolicy: "foreground-survey" });
		expect(found.files).toBe(1);
		expect(found.notMeasured).toEqual([]);
		expect(found.cases.filter(row => row.id.includes("discarded-outcome"))).toHaveLength(1);
	});
	it("retains every foreground boundary and resource candidate while default discovery stays bounded", () => {
		const root = mkdtempSync(join(process.cwd(), "scratch", "finding-discovery-matches-")); roots.push(root);
		const boundaries = Array.from({ length: 20 }, (_, i) => `const data${i} = JSON.parse(input${i});\nconsume(data${i}.field);`).join("\n");
		const resources = `import * as fs from "node:fs";\n${Array.from({ length: 20 }, (_, i) => `function f${i}(path) {\nconst fd${i} = fs.openSync(path, "r");\nuse(fd${i});\n}`).join("\n")}`;
		writeFileSync(join(root, "boundary.ts"), boundaries);
		writeFileSync(join(root, "resources.ts"), resources);
		const input = { files: ["boundary.ts", "resources.ts"] };
		const bounded = discoverFindings(root, input);
		expect(bounded.cases.filter(row => row.family === "parser_result")).toHaveLength(10);
		expect(bounded.cases.filter(row => row.family === "resource_ownership")).toHaveLength(10);
		const foreground = discoverFindings(root, input, { resourcePolicy: "foreground-survey" });
		expect(foreground.cases.filter(row => row.family === "parser_result")).toHaveLength(20);
		expect(foreground.cases.filter(row => row.family === "resource_ownership")).toHaveLength(20);
	});
});
