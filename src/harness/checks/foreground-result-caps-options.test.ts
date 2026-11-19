import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLossyErrorRethrow } from "./error-handling-lossy-rethrow.js";
import { checkErrorDispatchByInstanceof } from "./error-handling.js";
import { checkDiscriminatedUnionExhaustiveness } from "./exhaustiveness.js";
import { checkImportFromOwnBarrel } from "./imports.js";
import { checkPublicApiLeaksInternalType } from "./api-surface.js";
import { detectJsdocParamDrift } from "./jsdoc-param-drift.js";
import { detectUnvalidatedInputBoundary } from "./unvalidated-input-boundary.js";
import { checkHybridClass, checkFuzzyResponsibilityName } from "../taste-checks.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";

let sandbox: string;
let file: string;
beforeEach(() => {
	sandbox = mkdtempSync(join(process.cwd(), "scratch", "mapped-caps-graph-"));
	file = join(sandbox, "service.ts");
	writeFileSync(file, "export const value = 1;");
	writeFileSync(join(sandbox, "index.ts"), 'export * from "./service.js";');
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));
const repeat = (source: (index: number) => string) => Array.from({ length: 20 }, (_, index) => source(index)).join("\n");
const cases = [
	{ id: "lossy_error_rethrow", detector: checkLossyErrorRethrow, cap: 10,
		source: repeat(index => `function f${index}() { try {} catch (err) { throw new Error("wrapped"); } }`),
		benign: 'try {} catch (err) { throw new Error("wrapped", { cause: err }); }' },
	{ id: "error_dispatch_by_instanceof", detector: checkErrorDispatchByInstanceof, cap: 10,
		source: repeat(index => `function f${index}() { try {} catch (err) { if (err instanceof TypeError) recover(); } }`),
		benign: "try {} catch (err) { if (err instanceof DomainFailure) recover(); }" },
	{ id: "discriminated_union_exhaustiveness", detector: checkDiscriminatedUnionExhaustiveness, cap: 10,
		source: repeat(index => `function f${index}(status: 'a' | 'b') { switch (status) { case 'a': return 1; default: return 0; } }`),
		benign: "function f(status: 'a' | 'b') { switch (status) { case 'a': return 1; case 'b': return 2; } }" },
	{ id: "import_from_own_barrel", detector: checkImportFromOwnBarrel, cap: 5,
		source: repeat(index => `import { value${index} } from "./index";`),
		benign: 'import type { Value } from "./index";' },
	{ id: "public_api_leaks_internal_type", detector: checkPublicApiLeaksInternalType, cap: 5,
		source: "interface Internal { value: number }\n" + repeat(index => `export function expose${index}(): Internal { return { value: 1 }; }`),
		benign: "export interface Internal { value: number }\nexport function expose(): Internal { return { value: 1 }; }" },
	{ id: "jsdoc_param_drift", detector: detectJsdocParamDrift, cap: 10,
		source: repeat(index => `/** @param stale${index} obsolete name */\nfunction f${index}(actual: number) { return actual; }`),
		benign: "/** @param actual current name */\nfunction f(actual: number) { return actual; }" },
	{ id: "unvalidated_input_boundary", detector: detectUnvalidatedInputBoundary, cap: 10,
		source: repeat(index => `const argument${index} = process.argv[2];`),
		benign: "async function f() { const parsed = MySchema.parse(await res.json()); return parsed; }" },
	{ id: "hybrid_class", detector: checkHybridClass, cap: 5,
		source: repeat(index => `class Entity${index} {\n value = 1;\n execute() { return this.value; }\n}`),
		benign: "class Entity extends DurableObject {\n value = 1;\n execute() { return this.value; }\n}" },
	{ id: "fuzzy_responsibility_name", detector: checkFuzzyResponsibilityName, cap: 5,
		source: repeat(index => `class Entity${index}Manager {}`), benign: "class Invoice {}" },
] as const;

describe.each(cases)("$id foreground result population", entry => {
	it("P1 retains every recognized result and its final occurrence while runtime stays bounded", () => {
		const runtime = entry.detector(entry.source, file);
		expect(runtime).toHaveLength(entry.cap);
		const foreground = withForegroundCheckScan(() => entry.detector(entry.source, file));
		expect(foreground).toHaveLength(20);
		expect(foreground.slice(0, entry.cap)).toEqual(runtime);
		expect(foreground.at(-1)?.line).toBeGreaterThan(runtime.at(-1)?.line ?? 0);
		expect(entry.detector(entry.source, file)).toEqual(runtime);
	});
	it("N1 preserves a legitimate exception in both contexts", () => {
		expect(entry.detector(entry.benign, file)).toEqual([]);
		expect(withForegroundCheckScan(() => entry.detector(entry.benign, file))).toEqual([]);
	});
});

it("retains twenty lossy throws within one catch as well as across catches", () => {
	const source = `try {} catch (err) {\n${repeat(index => `if (condition${index}) throw new Error("wrapped");`)}\n}`;
	expect(checkLossyErrorRethrow(source, file)).toHaveLength(10);
	expect(withForegroundCheckScan(() => checkLossyErrorRethrow(source, file))).toHaveLength(20);
});

it("retains twenty builtin dispatches within one catch as well as across catches", () => {
	const source = `try {} catch (err) {\n${repeat(() => "if (err instanceof TypeError) recover();")}\n}`;
	expect(checkErrorDispatchByInstanceof(source, file)).toHaveLength(10);
	expect(withForegroundCheckScan(() => checkErrorDispatchByInstanceof(source, file))).toHaveLength(20);
});

it("retains every stale parameter tag in one function", () => {
	const source = `/**\n${repeat(index => ` * @param stale${index} obsolete name`)}\n */\nfunction run(actual: number) { return actual; }`;
	expect(detectJsdocParamDrift(source, file)).toHaveLength(10);
	expect(withForegroundCheckScan(() => detectJsdocParamDrift(source, file))).toHaveLength(20);
});

it("retains JSON results and continues into the complete argv scanner after the runtime limit", () => {
	const json = repeat(index => `async function load${index}() { return await res.json(); }`);
	const argv = repeat(index => `const argument${index} = process.argv[2];`);
	const source = `${json}\n${argv}`;
	expect(detectUnvalidatedInputBoundary(source, file)).toHaveLength(10);
	const foreground = withForegroundCheckScan(() => detectUnvalidatedInputBoundary(source, file));
	expect(foreground).toHaveLength(40); expect(foreground.at(-1)?.line).toBe(40);
	expect(withForegroundCheckScan(() => detectUnvalidatedInputBoundary(argv, "/repo/bin/cli.ts"))).toEqual([]);
});
