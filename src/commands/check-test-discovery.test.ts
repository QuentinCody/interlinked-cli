import { describe, expect, it } from "vitest";
import { discoveryIssue } from "./check-test-discovery.js";

const reader = (files: Record<string, string>) => ({ files: Object.keys(files), read: (path: string): string | null => files[path] ?? null });

describe("MUST-FIRE: test discovery the rule cannot judge", () => {
	it("P1: pytest python_files with a pattern outside the test-name family (ini and toml)", () => {
		const ini = reader({ "pytest.ini": "[pytest]\npython_files = check_*.py\n" });
		expect(discoveryIssue("python", ini.files, ini.read)).toBe("pytest.ini: python_files = check_*.py");
		const toml = reader({ "pyproject.toml": '[tool.pytest.ini_options]\npython_files = ["spec_*.py", "test_*.py"]\n' });
		expect(discoveryIssue("python", toml.files, toml.read)).toBe('pyproject.toml: python_files = ["spec_*.py", "test_*.py"]');
	});
	it("P2: jest testMatch and vitest include with a pattern that names no test or spec", () => {
		const jest = reader({ "jest.config.js": "module.exports = { testMatch: ['**/integration/**/*.ts'] };\n" });
		expect(discoveryIssue("javascript", jest.files, jest.read)).toBe("jest.config.js: testMatch = ['**/integration/**/*.ts']");
		const vitest = reader({ "vitest.config.ts": "export default { test: { include: ['src/**/*.check.ts'] } };\n" });
		expect(discoveryIssue("javascript", vitest.files, vitest.read)).toContain("vitest.config.ts: include");
	});
	it.each(["vite.config.ts", "vitest.config.ts"])("P3: %s reads test.include and reports an unresolved pattern", (file) => {
		const custom = reader({ [file]: "export default defineConfig({ test: { include: ['src/**/*.check.ts'] } });" });
		expect(discoveryIssue("javascript", custom.files, custom.read)).toContain(file + ": include");
		const dynamic = reader({ [file]: "export default { test: { include: [...patterns, '**/*.test.ts'] } };" });
		expect(discoveryIssue("javascript", dynamic.files, dynamic.read)).toContain(file + ": include");
	});
});

describe("MUST-NOT-FIRE: discovery the rule supports", () => {
	it("N1: no config, a default-family pattern or a test-named pattern is supported", () => {
		expect(discoveryIssue("python", [], () => null)).toBeNull();
		const ini = reader({ "pytest.ini": "[pytest]\npython_files = test_*.py *_test.py\n" });
		expect(discoveryIssue("python", ini.files, ini.read)).toBeNull();
		const jest = reader({ "jest.config.js": "module.exports = { testMatch: ['**/__tests__/**/*.ts', '**/*.spec.ts'] };\n" });
		expect(discoveryIssue("javascript", jest.files, jest.read)).toBeNull();
	});
	it("N2: a vite plugin include is not test discovery, and a config of the other language is not read", () => {
		const vite = reader({ "vite.config.ts": "export default { plugins: [svg({ include: ['**/*.svg'] })] };\n" });
		expect(discoveryIssue("javascript", vite.files, vite.read)).toBeNull();
		const ini = reader({ "pytest.ini": "[pytest]\npython_files = check_*.py\n" });
		expect(discoveryIssue("javascript", ini.files, ini.read)).toBeNull();
	});
	it("N3: Vitest coverage and plugin filters coexist with supported discovery", () => {
		const config = reader({ "vitest.config.mts": `export default defineConfig({
			plugins: [assets({ include: ['**/*.svg'], test: { include: ['**/*.asset'] } })],
			test: { "include": ['**/*.test.ts'], coverage: { include: ['src/**/*.ts'] } }
		});` });
		expect(discoveryIssue("javascript", config.files, config.read)).toBeNull();
	});
});
