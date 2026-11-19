import { describe, expect, it } from "vitest";
import { detectOmittedPrivateParameter } from "./omitted-private-parameter.js";

const helper = "function format(text: string, width = 80) { return text.slice(0, width); }";
const scan = (body: string) => detectOmittedPrivateParameter(`export {};\n${helper}\n${body}`, "lib/format.ts");

describe("omitted_private_parameter MUST-FIRE", () => {
	it("reports the parameter and the number of calls that omit it", () => {
		expect(scan('format("a"); format("b");')).toEqual([
			{ line: 2, text: expect.stringMatching(/format.*width.*2 direct calls/) },
		]);
	});
	it("covers JavaScript defaults and TypeScript optional markers", () => {
		expect(detectOmittedPrivateParameter("function f(x = 1) { return x; } f();", "lib/use.mjs")).toHaveLength(1);
		expect(detectOmittedPrivateParameter("export {}; function f(this: void, x?: number) {} f();", "lib/use.ts")).toHaveLength(1);
	});
});

describe("omitted_private_parameter MUST-NOT-FIRE", () => {
	it.each(['format("a", 40)', 'format("a", undefined)', 'list.map(format)', 'export { format as publicFormat }',
		'const alias = format', 'format(...args)', 'const table = { format }', 'function g(format: Function) { format() }',
		'export default format', 'eval(code)'])("withholds advice when given %s", extra => {
		expect(scan('format("a"); ' + extra)).toEqual([]);
	});
	it("requires a direct call and excludes exports, scripts, overloads and tests", () => {
		expect(scan("")).toEqual([]);
		expect(detectOmittedPrivateParameter(`export ${helper}\nformat("a");`, "src/app.ts")).toEqual([]);
		expect(detectOmittedPrivateParameter(`${helper}\nformat("a");`, "legacy.js")).toEqual([]);
		expect(scan('function format(text: string): string; format("a");')).toEqual([]);
		expect(detectOmittedPrivateParameter(`export {};\n${helper}\nformat("a");`, "src/app.spec.ts")).toEqual([]);
	});
});
