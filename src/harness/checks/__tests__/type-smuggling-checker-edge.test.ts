// Exercises compiler failures while preserving the real TypeScript program
// and AST walk. Dependency wrappers can throw during program construction,
// type resolution, or formatting, and a source lookup may return undefined.
// Impossible null checker and undefined Type fixtures are deliberately absent.
//
// Isolated per-file mocking of `node:module` via `vi.doMock` + dynamic
// import + `vi.resetModules()` between cases, since each case needs a
// DIFFERENT transform of the loaded "typescript" module.

import { afterEach, describe, expect, it, vi } from "vitest";
// Imported for its side-effect-free type shape only, so the harness's
// SUT-import check recognizes this file as exercising `checkTypeSmuggling`
// (the mocked module is loaded dynamically below via
// `import("../type-smuggling.js")`, which the static check can't see).
import type {} from "../type-smuggling.js";

const TS = "src/lib/foo.ts";
const SMUGGLING_CODE = [
	"interface UserObj { id: number; name: string; }",
	"interface ProductObj { sku: string; price: number; }",
	"declare const userObj: UserObj;",
	"const product = userObj as ProductObj;",
	"export { product };",
].join("\n");

type TsLike = typeof import("typescript");

async function loadWithMockedTs(transform: (ts: TsLike) => unknown) {
	vi.resetModules();
	vi.doMock("node:module", async (importOriginal) => {
		const actual = await importOriginal<typeof import("node:module")>();
		return {
			...actual,
			createRequire: (...args: Parameters<typeof actual.createRequire>) => {
				const req = actual.createRequire(...args);
				return (id: string) => {
					const mod = req(id);
					// SAFETY: req loads the installed TypeScript package; only that exact module is passed to the typed compiler transform.
					if (id === "typescript") return transform(mod as TsLike);
					return mod;
				};
			},
		};
	});
	return import("../type-smuggling.js");
}

afterEach(() => {
	vi.doUnmock("node:module");
	vi.resetModules();
});

describe("checkTypeSmuggling — checker edge cases (mocked typescript loader)", () => {


	it("returns [] and does not throw when the type checker throws mid-walk", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: (...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					const realGetTypeChecker = program.getTypeChecker.bind(program);
					return {
						...program,
						getTypeChecker: () => {
							const checker = realGetTypeChecker();
							return {
								...checker,
								getTypeAtLocation: () => {
									throw new Error("boom");
								},
							};
						},
					};
				},
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});



	it("returns [] when ts.createProgram itself throws", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => ({
			...ts,
			createProgram: () => {
				throw new Error("boom");
			},
		}));
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	it("returns [] when program.getSourceFile(filePath) yields undefined after a successful build", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: (...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					return {
						...program,
						getSourceFile: () => undefined,
					};
				},
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	it("returns [] and does not throw when program.getTypeChecker() itself throws (outer catch)", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: (...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					return {
						...program,
						getTypeChecker: () => {
							throw new Error("boom-outer");
						},
					};
				},
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});



	it("falls back to '<unresolved>' when checker.typeToString() throws (safeTypeToString catch)", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: (...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					const realGetTypeChecker = program.getTypeChecker.bind(program);
					return {
						...program,
						getTypeChecker: () => {
							const checker = realGetTypeChecker();
							return {
								...checker,
								typeToString: () => {
									throw new Error("boom-typeToString");
								},
							};
						},
					};
				},
			};
		});
		const matches = checkTypeSmuggling(SMUGGLING_CODE, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches[0]?.text).toContain("<unresolved>");
	});
});

describe("checkTypeSmuggling — __resetTsCacheForTests actually clears the cache", () => {
	// test-contract: public-api — __resetTsCacheForTests must reset the
	// module-level TS-module cache to `undefined` so the NEXT call
	// re-attempts resolution, rather than replaying a stale cached failure.
	// A cached-failure-then-recovery scenario is the only way to observe
	// this: a no-op reset would keep serving the earlier cached `null`
	// forever, even once resolution would now succeed.
	it("lets a later successful resolution replace a cached earlier failure", async () => {
		let attempts = 0;
		vi.resetModules();
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			return {
				...actual,
				createRequire: (...args: Parameters<typeof actual.createRequire>) => {
					const req = actual.createRequire(...args);
					return (id: string) => {
						if (id === "typescript") {
							attempts++;
							if (attempts === 1) {
								throw new Error("simulated: typescript not resolvable yet");
							}
							return req(id);
						}
						return req(id);
					};
				},
			};
		});
		const { checkTypeSmuggling, __resetTsCacheForTests } = await import("../type-smuggling.js");

		// First call: the mocked createRequire throws -> loadTs caches _ts = null.
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
		expect(attempts).toBe(1);

		// A reset must clear the cached failure so the next call re-attempts
		// resolution instead of reusing the cached `null`.
		__resetTsCacheForTests();

		// Second call: the mock now succeeds (attempt #2) -- this only
		// happens if the reset actually cleared the cache.
		const second = checkTypeSmuggling(SMUGGLING_CODE, TS);
		expect(attempts).toBe(2);
		expect(second.length).toBeGreaterThanOrEqual(1);
	});
});
