import { describe, expect, it } from "vitest";
import { extractRootIdentifier, isEnclosingParameter } from "./test-isolation-fixture-dir-roots.js";

describe("extractRootIdentifier — positive (must resolve)", () => {
	it("P1: a bare identifier resolves to itself", () => {
		expect(extractRootIdentifier("dir")).toBe("dir");
	});

	it("P2: join(cwd, ...) resolves to cwd", () => {
		expect(extractRootIdentifier('join(cwd, "x-")')).toBe("cwd");
	});

	it("P3: dirname(path) resolves to path", () => {
		expect(extractRootIdentifier("dirname(path)")).toBe("path");
	});

	it("P4: resolve(CLI_ROOT, ...) resolves to CLI_ROOT", () => {
		expect(extractRootIdentifier('resolve(CLI_ROOT, "_fixtures-")')).toBe("CLI_ROOT");
	});
});

describe("extractRootIdentifier — negative (must not resolve)", () => {
	it("N1: a bare string literal resolves to null", () => {
		expect(extractRootIdentifier('""')).toBeNull();
	});

	it("N2: join(process.cwd(), ...) resolves to null (member expression, not a bare identifier)", () => {
		expect(extractRootIdentifier('join(process.cwd(), "y-")')).toBeNull();
	});

	it("N3: a multi-level call whose first segment isn't a bare identifier resolves to null", () => {
		expect(extractRootIdentifier('realpathSync(mkdtempSync(join(tmpdir(), "x-")))')).toBeNull();
	});
});

describe("isEnclosingParameter — positive (must fire)", () => {
	it("P1: a function declaration's own parameter is recognized", () => {
		const code = `
function writeCoverageSummary(cwd, name) {
	doSomething(cwd);
}
`;
		const offset = code.indexOf("doSomething");
		expect(isEnclosingParameter(code, "cwd", offset)).toBe(true);
	});

	it("P2: an arrow function's parameter is recognized even when wrapped in an outer call (mockImplementation((cwd) => {...}))", () => {
		const code = `
writeHookScriptMock.mockImplementation((cwd) => {
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});
`;
		const offset = code.indexOf("mkdirSync");
		expect(isEnclosingParameter(code, "cwd", offset)).toBe(true);
	});

	it("P3: a typed arrow parameter (cwd: string) is recognized", () => {
		const code = `
writeHookScriptMock.mockImplementation((cwd: string) => {
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});
`;
		const offset = code.indexOf("mkdirSync");
		expect(isEnclosingParameter(code, "cwd", offset)).toBe(true);
	});
});

describe("isEnclosingParameter — negative (must not fire)", () => {
	it("N1: a local const (not a parameter) is not recognized", () => {
		const code = `
function writeFixtures(root) {
	const dataDir = join(root, ".interlinked");
	doSomething(dataDir);
}
`;
		const offset = code.indexOf("doSomething");
		expect(isEnclosingParameter(code, "dataDir", offset)).toBe(false);
	});

	it("N2: an identifier that names no parameter anywhere in the file is not recognized", () => {
		const code = `
function f(x) {
	doSomething(y);
}
`;
		const offset = code.indexOf("doSomething");
		expect(isEnclosingParameter(code, "y", offset)).toBe(false);
	});
});
