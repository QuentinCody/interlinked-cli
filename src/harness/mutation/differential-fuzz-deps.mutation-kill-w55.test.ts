import { afterEach, describe, expect, it, vi } from "vitest";

// Every test gets a FRESH module instance (vi.resetModules) so the
// module-level caches (tsCache / fastCheckCache / fastCheckPending) never
// leak between cases, and so per-test vi.doMock overrides of "fast-check" /
// "node:module" take effect on the very next dynamic import.

afterEach(() => {
	vi.restoreAllMocks();
	vi.doUnmock("fast-check");
	vi.doUnmock("node:module");
	vi.resetModules();
});

async function freshDeps() {
	vi.resetModules();
	return import("./differential-fuzz-deps.js");
}

describe("differentialFuzzAvailability — real environment", () => {
	it("resolves both typescript and fast-check when both are installed", async () => {
		// This repo has both as (optional)devDependencies — see package.json.
		// Kills the StringLiteral mutants that blank out the "typescript" /
		// "fast-check" specifier constants: canResolve("") throws and the
		// corresponding flag flips to false.
		const { differentialFuzzAvailability } = await freshDeps();
		const availability = differentialFuzzAvailability();
		expect(availability.ts).toBe(true);
		expect(availability.fastCheck).toBe(true);
	});
});

describe("missingDependencyNote", () => {
	it("joins multiple missing deps with '; ' in stable order", async () => {
		const { missingDependencyNote } = await freshDeps();
		const note = missingDependencyNote({ ts: false, fastCheck: false });
		expect(note).toBe("fuzz unavailable: typescript not installed; fast-check not installed");
	});

	it("returns empty string when nothing is missing", async () => {
		const { missingDependencyNote } = await freshDeps();
		expect(missingDependencyNote({ ts: true, fastCheck: true })).toBe("");
	});
});

describe("loadTsModule — caching", () => {
	it("only requires typescript once across repeated calls", async () => {
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			return {
				...actual,
				createRequire: vi.fn((url: string | URL) => actual.createRequire(url)),
			};
		});
		const { loadTsModule } = await freshDeps();
		const nodeModule = await import("node:module");
		const spy = vi.mocked(nodeModule.createRequire);

		const first = loadTsModule();
		const second = loadTsModule();

		expect(first).not.toBeNull();
		expect(second).toBe(first);
		// Kills `tsCache !== undefined -> false`: without the cache guard,
		// every call re-invokes createRequire.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("__resetDifferentialFuzzDepsCacheForTests forces a re-require", async () => {
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			return {
				...actual,
				createRequire: vi.fn((url: string | URL) => actual.createRequire(url)),
			};
		});
		const { loadTsModule, __resetDifferentialFuzzDepsCacheForTests } = await freshDeps();
		const nodeModule = await import("node:module");
		const spy = vi.mocked(nodeModule.createRequire);

		loadTsModule();
		expect(spy).toHaveBeenCalledTimes(1);
		__resetDifferentialFuzzDepsCacheForTests();
		loadTsModule();
		// Kills the BlockStatement mutant that empties the reset function body:
		// with an empty body the cache survives and this second call would not
		// re-invoke createRequire, holding the count at 1.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("returns null (not a throw) when typescript cannot be required", async () => {
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			return {
				...actual,
				createRequire: (url: string | URL) => {
					const req = actual.createRequire(url);
					const wrapped = Object.assign((id: string) => {
						if (id === "typescript") throw new Error("blocked for test");
						return req(id);
					}, req);
					return wrapped;
				},
			};
		});
		const { loadTsModule } = await freshDeps();
		expect(loadTsModule()).toBeNull();
	});
});

describe("loadFastCheck — shape validation", () => {
	it("rejects a module missing assert() (kills the assert-clause mutants)", async () => {
		vi.doMock("fast-check", () => ({
			assert: undefined,
			property: () => {},
			asyncProperty: () => {},
		}));
		const { loadFastCheck } = await freshDeps();
		expect(await loadFastCheck()).toBeNull();
	});

	it("rejects a module missing property() (kills the property-clause mutants)", async () => {
		vi.doMock("fast-check", () => ({
			assert: () => {},
			property: undefined,
			asyncProperty: () => {},
		}));
		const { loadFastCheck } = await freshDeps();
		expect(await loadFastCheck()).toBeNull();
	});

	it("rejects a module missing asyncProperty() (kills the asyncProperty-clause mutants)", async () => {
		vi.doMock("fast-check", () => ({
			assert: () => {},
			property: () => {},
			asyncProperty: undefined,
		}));
		const { loadFastCheck } = await freshDeps();
		expect(await loadFastCheck()).toBeNull();
	});

	it("accepts a module exposing all three functions", async () => {
		vi.doMock("fast-check", () => ({
			assert: () => {},
			property: () => {},
			asyncProperty: () => {},
		}));
		const { loadFastCheck } = await freshDeps();
		const mod = await loadFastCheck();
		expect(mod).not.toBeNull();
		expect(typeof mod?.assert).toBe("function");
	});

	it("resolves to null (not a throw) when the module cannot be imported", async () => {
		vi.doMock("fast-check", () => {
			throw new Error("cannot resolve fast-check for test");
		});
		const { loadFastCheck } = await freshDeps();
		// Kills the null-guard mutants in isFastCheckModule: with the guard
		// disabled, `candidate.assert` on a null candidate throws instead of
		// this promise resolving to null.
		await expect(loadFastCheck()).resolves.toBeNull();
	});

	it("caches the resolved module — a second call performs no extra shape check", async () => {
		let accessCount = 0;
		vi.doMock("fast-check", () => ({
			get assert() {
				accessCount++;
				return () => {};
			},
			get property() {
				accessCount++;
				return () => {};
			},
			get asyncProperty() {
				accessCount++;
				return () => {};
			},
		}));
		const { loadFastCheck } = await freshDeps();

		await loadFastCheck();
		const afterFirst = accessCount;
		expect(afterFirst).toBe(3);

		await loadFastCheck();
		// Kills `fastCheckCache !== undefined -> false`: without the cache
		// guard, the second call re-runs isFastCheckModule and accesses the
		// three getters again.
		expect(accessCount).toBe(afterFirst);
	});

	it("shares one in-flight resolution across concurrent callers", async () => {
		let accessCount = 0;
		vi.doMock("fast-check", () => ({
			get assert() {
				accessCount++;
				return () => {};
			},
			get property() {
				accessCount++;
				return () => {};
			},
			get asyncProperty() {
				accessCount++;
				return () => {};
			},
		}));
		const { loadFastCheck } = await freshDeps();

		const [a, b] = await Promise.all([loadFastCheck(), loadFastCheck()]);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		// Kills `fastCheckPending !== null -> false`: without sharing the
		// in-flight promise, two overlapping callers each run the shape check
		// independently, doubling the getter accesses to 6.
		expect(accessCount).toBe(3);
	});
});

describe("transpileMutantModule", () => {
	it("returns null when typescript is unavailable, rather than throwing", async () => {
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			return {
				...actual,
				createRequire: (url: string | URL) => {
					const req = actual.createRequire(url);
					const wrapped = Object.assign((id: string) => {
						if (id === "typescript") throw new Error("blocked for test");
						return req(id);
					}, req);
					return wrapped;
				},
			};
		});
		const { transpileMutantModule } = await freshDeps();
		expect(() => transpileMutantModule("export const x = 1;\n", "x.ts")).not.toThrow();
		expect(transpileMutantModule("export const x = 1;\n", "x.ts")).toBeNull();
	});

	it("emits ESM output, preserving 'export const' rather than lowering to CJS", async () => {
		const { transpileMutantModule } = await freshDeps();
		const result = transpileMutantModule("export const x = 1;\n", "x.ts");
		expect(result).not.toBeNull();
		// Kills the ObjectLiteral mutants that blank compilerOptions / the
		// whole options bag to {}: default options transpile to CommonJS
		// ("use strict" + exports.x = ...), not ESM.
		expect(result?.js).toContain("export const x = 1;");
		expect(result?.js).not.toContain("exports.x");
	});

	it("reports real syntactic diagnostics for invalid source, with actual message text", async () => {
		const { transpileMutantModule } = await freshDeps();
		const result = transpileMutantModule("const x: = ;\n", "bad.ts");
		expect(result).not.toBeNull();
		// Kills reportDiagnostics: true -> false, both ObjectLiteral mutants
		// (which also drop reportDiagnostics), and the ArrowFunction mutant
		// that replaces the formatter with `() => undefined`.
		expect(result?.diagnostics.length).toBeGreaterThan(0);
		for (const message of result?.diagnostics ?? []) {
			expect(typeof message).toBe("string");
			expect(message.length).toBeGreaterThan(0);
		}
	});

	it("keeps a type-only re-export as a value re-export under verbatimModuleSyntax:false", async () => {
		const { transpileMutantModule } = await freshDeps();
		const source = "interface Foo { a: number }\nexport { Foo };\n";
		const result = transpileMutantModule(source, "reexport.ts");
		expect(result).not.toBeNull();
		// Kills `verbatimModuleSyntax: false -> true`: with verbatimModuleSyntax
		// on, the transpiler keeps the (now-invalid) value re-export of a
		// type-only interface instead of erasing it to `export {};`.
		expect(result?.js.trim()).toBe("export {};");
	});
});
