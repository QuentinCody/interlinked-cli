import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkImportFromOwnBarrel } from "./imports.js";
import { inspectOwnBarrelReach } from "./imports-barrel-reach.js";
import { buildAgentSafetyChecks } from "../check-registry/index.js";
import { withCheckRoot } from "./check-root.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";
import { getProjectCheckEvidence, withProjectCheckEvidence } from "./project-check-evidence.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(process.cwd(), "scratch", "own-barrel-certainty-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function put(name: string, content: string): string {
	const file = join(root, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}
function scan(foreground = false, name = "foo.ts") {
	const file = join(root, name);
	const run = () => withCheckRoot(root, () => checkImportFromOwnBarrel(readFileSync(file, "utf8"), file));
	return foreground ? withForegroundCheckScan(run) : run();
}
function graph(reaches: boolean): void {
	put("foo.ts", 'import { leaf } from "./index.js";\nexport const foo = leaf;');
	put("index.ts", 'export * from "./node-0.js";');
	for (let index = 0; index < 70; index++) {
		put(`node-${index}.ts`, index < 69 ? `export * from "./node-${index + 1}.js";` : `${reaches ? 'export * from "./foo.js";\n' : ""}export const leaf = 1;`);
	}
}

describe("own-barrel value-edge certainty", () => {
	it("N1 completes the foreground graph beyond sixty-four files without inventing reachability", () => {
		graph(false);
		expect(scan(true)).toEqual({ result: [], notMeasured: [] });
	});

	it("P1 finds the actual foreground tail edge after the runtime budget", () => {
		graph(true);
		const run = scan(true);
		expect(run.result).toHaveLength(1);
		const witness = withForegroundCheckScan(() => withCheckRoot(root, () => inspectOwnBarrelReach(join(root, "foo.ts")))).result;
		expect(witness.witness.at(-2)).toBe(join(root, "node-69.ts"));
		expect(run.notMeasured).toEqual([]);
	});

	it.each([false, true])("N2 retains runtime exhaustion as unknown for reaches=%s", reaches => {
		graph(reaches);
		const run = scan();
		expect(run.result).toEqual([]);
		expect(run.notMeasured.join("\n")).toMatch(/64|budget/i);
	});

	it.each([
		'// export * from "./foo.js";\nexport const leaf = 1;',
		'export const example = `export * from "./foo.js"`;\nexport const leaf = 1;',
		'export type { Foo } from "./foo.js";\nexport const leaf = 1;',
		'export { type Foo } from "./foo.js";\nexport const leaf = 1;',
	])("N3 ignores non-value edges in a real index source %s", content => {
		put("index.ts", content);
		put("foo.ts", 'import { leaf } from "./index.js";\nexport interface Foo { value: number }');
		expect(scan(true)).toEqual({ result: [], notMeasured: [] });
	});

	it("N4 resolves an identically named alias to the configured unrelated module", () => {
		put("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@dep/foo": ["./unrelated.ts"] } } }));
		put("index.ts", 'export * from "@dep/foo";');
		put("unrelated.ts", "export const leaf = 1;");
		put("foo.ts", 'import { leaf } from "./index.js";');
		expect(scan(true)).toEqual({ result: [], notMeasured: [] });
	});

	it("P2 resolves an alias to the actual importer", () => {
		put("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@dep/current": ["./foo.ts"] } } }));
		put("index.ts", 'export * from "@dep/current";');
		put("foo.ts", 'import { value } from "./index.js";\nexport const value = 1;');
		const run = scan(true);
		expect(run.result).toHaveLength(1);
		expect(run.notMeasured).toEqual([]);
	});

	it.each(["missing", "unresolved-alias", "malformed-config", "dynamic-target"])("N5 retains %s as unknown", mode => {
		put("foo.ts", 'import { leaf } from "./index.js";');
		if (mode === "unresolved-alias") put("index.ts", 'export * from "@dep/foo";');
		if (mode === "malformed-config") { put("tsconfig.json", "{ malformed"); put("index.ts", 'export * from "@dep/foo";'); }
		if (mode === "dynamic-target") put("index.ts", "export const leaf = 1;\nimport(target);");
		const run = scan(true);
		expect(run.result).toEqual([]);
		expect(run.notMeasured.length).toBeGreaterThan(0);
	});

	it("P3 retains a valid value-edge witness alongside an unresolved branch", () => {
		put("index.ts", 'export * from "./missing.js";\nexport * from "./foo.js";');
		put("foo.ts", 'import { value } from "./index.js";\nexport const value = 1;');
		const run = scan(true);
		expect(run.result).toHaveLength(1);
		expect(run.notMeasured.length).toBeGreaterThan(0);
	});

	it("N6 consumes the selected invocation snapshot instead of rereading a changed dependency", () => {
		const index = put("index.ts", "export const leaf = 1;");
		const file = put("foo.ts", 'import { leaf } from "./index.js";');
		const run = withProjectCheckEvidence(root, [file, index], () => {
			getProjectCheckEvidence()?.readFile(index);
			writeFileSync(index, 'export * from "./foo.js";');
			return scan(true);
		});
		expect(run).toEqual({ result: [], notMeasured: [] });
	});

	it("N8 keeps shadowed require calls unknown without inventing an actual dependency", () => {
		put("index.ts", 'export const leaf = 1;\nfunction example(require: (text: string) => void) { require("./foo.js"); }');
		put("foo.ts", 'import { leaf } from "./index.js";');
		const run = scan(true);
		expect(run.result).toEqual([]);
		expect(run.notMeasured.join("\n")).toMatch(/require|binding/);
	});

	it("N9 keeps declaration-only resolutions unknown", () => {
		put("index.ts", 'export * from "./declaration.js";');
		put("declaration.d.ts", 'export * from "./foo.js";');
		put("foo.ts", 'import { leaf } from "./index.js";');
		const run = scan(true);
		expect(run.result).toEqual([]);
		expect(run.notMeasured.join("\n")).toMatch(/declaration/i);
	});

	it.each(['import { leaf /* from "./index.js" */ } from "./other.js";', 'export const example = \'from "./index.js"\';'])("N10 reads only actual consumer declarations %s", content => {
		put("index.ts", 'export * from "./foo.js";');
		put("other.ts", "export const leaf = 1;");
		put("foo.ts", content);
		expect(scan(true)).toEqual({ result: [], notMeasured: [] });
	});

	it("P4 recognizes the actual multiline consumer at its starting line", () => {
		put("index.ts", 'export * from "./foo.js";\nexport const leaf = 1;');
		put("foo.ts", 'import {\n leaf\n} from "./index.js";');
		expect(scan(true).result).toContainEqual(expect.objectContaining({ line: 1 }));
	});

	it("P5 anchors relative consumer paths to the selected root", () => {
		put("src/lib/index.ts", 'export * from "./foo.js";\nexport const leaf = 1;');
		const content = 'import { leaf } from "./index.js";';
		put("src/lib/foo.ts", content);
		const run = withForegroundCheckScan(() => withCheckRoot(root, () => checkImportFromOwnBarrel(content, "src/lib/foo.ts")));
		expect(run.result).toHaveLength(1);
		expect(run.notMeasured).toEqual([]);
	});

	it("N11 avoids unrelated package lookup for deep relative-only imports", () => {
		put("deep/a/b/c/d/e/f/g/foo.ts", 'import { leaf } from "./helper.js";');
		expect(scan(false, "deep/a/b/c/d/e/f/g/foo.ts")).toEqual({ result: [], notMeasured: [] });
	});

	it("N12 starts from the declared .mjs target when a different .js index reaches the importer", () => {
		put("index.ts", 'export * from "./foo.js";');
		put("index.mts", "export const leaf = 1;");
		put("foo.ts", 'import { leaf } from "./index.mjs";');
		expect(scan(true)).toEqual({ result: [], notMeasured: [] });
		put("foo.ts", 'import { leaf } from "./index.js";');
		expect(scan(true).result).toHaveLength(1);
	});

	it("N13 honors configured module suffixes for the actual forward edge", () => {
		put("tsconfig.json", JSON.stringify({ compilerOptions: { moduleSuffixes: [".native", ""] } }));
		put("index.ts", 'export * from "./foo.js";');
		put("index.native.ts", "export const leaf = 1;");
		put("foo.ts", 'import { leaf } from "./index.js";');
		expect(scan(true)).toEqual({ result: [], notMeasured: [] });
		put("index.native.ts", 'export * from "./foo.js";');
		expect(scan(true).result).toHaveLength(1);
	});

	it("N14 rejects recovered apparent module edges after a syntax error", () => {
		put("index.ts", 'export * from "./foo.js";\nfunction broken(');
		put("foo.ts", 'import { leaf } from "./index.js";');
		const run = scan(true);
		expect(run.result).toEqual([]);
		expect(run.notMeasured.join("\n")).toMatch(/syntax/i);
	});

	it("P6 retains a separate parseable witness alongside a malformed branch", () => {
		put("index.ts", 'export * from "./broken.js";\nexport * from "./valid.js";');
		put("broken.ts", 'export * from "./foo.js";\nfunction broken(');
		put("valid.ts", 'export * from "./foo.js";');
		put("foo.ts", 'import { leaf } from "./index.js";');
		const run = scan(true);
		expect(run.result).toHaveLength(1);
		expect(run.notMeasured.join("\n")).toMatch(/syntax/i);
	});

	it("P7 selects a side-effect value consumer through the real pre-warn registry", () => {
		put("index.ts", 'export * from "./foo.js";');
		const content = 'import "./index.js";\nexport const foo = 1;';
		const file = put("foo.ts", content);
		const selected = buildAgentSafetyChecks(content, file, "pre_warn").find(check => check.name === "import_from_own_barrel");
		expect(selected).toBeDefined();
		expect(withCheckRoot(root, () => selected?.fn()).result).toHaveLength(1);
	});

	it("N7 reports dependencies outside selected evidence instead of claiming complete absence", () => {
		put("index.ts", 'export * from "./unselected.js";');
		put("unselected.ts", "export const leaf = 1;");
		const file = put("foo.ts", 'import { leaf } from "./index.js";');
		const run = withProjectCheckEvidence(root, [file], () => scan(true));
		expect(run.result).toEqual([]);
		expect(run.notMeasured.length).toBeGreaterThan(0);
	});
});
