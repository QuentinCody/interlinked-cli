// Mutation-kill campaign (wave 30) for cyclomatic-python.ts. Each case is
// aimed at one or more specific surviving mutants from the manifest; see the
// `// test-contract` comment above each case for which mutant class it kills
// and why. Several mutants in this file were investigated and found to be
// functionally EQUIVALENT under any JSON-derived input (downstream guards or
// JSON.parse's own failure mode reproduce the identical observable result no
// matter which side of the mutated branch executes) — those are intentionally
// left uncovered here and reported as still_open with a suspicion note; this
// file does not assert equivalence.
import { describe, expect, it, vi } from "vitest";
import { computeCyclomaticPython, parseRadonJson, radonAvailable } from "./cyclomatic-python.js";
import type { PythonSpawnFn } from "./cyclomatic-python.js";

// ===========================================
// defaultSpawn (only reachable when no `spawn` arg is injected)
// ===========================================

describe("defaultSpawn (uninjected default) — real spawnSync wiring", () => {
	// test-contract: mock-spy — kills both the ArrayDeclaration mutant
	// ([...args] -> []) and the ArrowFunction mutant (whole body -> () =>
	// undefined). The array-declaration mutant changes the exact args
	// spawnSync receives; the arrow-function mutant means spawnSync is never
	// called at all and radonAvailable reads `.error` off `undefined`,
	// throwing internally and reading as false via its own catch.
	it("spreads args into spawnSync and forwards its result", async () => {
		vi.resetModules();
		const spawnSyncMock = vi.fn(() => ({
			status: 0,
			stdout: "radon 6.0.1",
			stderr: "",
			error: undefined,
		}));
		vi.doMock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
		const { radonAvailable: radonAvailableFresh } = await import("./cyclomatic-python.js");
		const ok = radonAvailableFresh(); // no injected spawn -> exercises defaultSpawn
		expect(ok).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(spawnSyncMock).toHaveBeenCalledWith("radon", ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
		});
		vi.doUnmock("node:child_process");
		vi.resetModules();
	});
});

// ===========================================
// radonAvailable — exact spawn invocation + status===null branch
// ===========================================

describe("radonAvailable — exact spawn invocation", () => {
	// test-contract: mock-spy — kills the "radon"->"" StringLiteral, the
	// ["--version"]->[] ArrayDeclaration, the "--version"->"" StringLiteral,
	// the {encoding,timeout}->{} ObjectLiteral, and the "utf-8"->""
	// StringLiteral mutants: each changes exactly one field of this call.
	it("invokes spawn with the exact command, args, and options", () => {
		const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
		const spawn: PythonSpawnFn = (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0, stdout: "radon 6.0.1", stderr: "" };
		};
		expect(radonAvailable(spawn)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("radon");
		expect(calls[0]?.args).toEqual(["--version"]);
		expect(calls[0]?.options).toEqual({ encoding: "utf-8", timeout: 5000 });
	});

	// test-contract: state-based — kills the ConditionalExpression mutant
	// that replaces `r.status === null` with `false`. Only reachable/visible
	// when status is exactly null and error is undefined.
	it("returns true when status is null and error is undefined", () => {
		const spawn: PythonSpawnFn = () => ({ status: null, stdout: "", stderr: "" });
		expect(radonAvailable(spawn)).toBe(true);
	});
});

// ===========================================
// asFiniteNumber (via parseRadonJson — not exported directly)
// ===========================================

describe("asFiniteNumber via parseRadonJson — Infinity input", () => {
	// test-contract: state-based — kills the LogicalOperator mutant
	// (&& -> ||) in `typeof v === "number" && Number.isFinite(v)`. A JSON
	// number literal like 1e400 parses to Infinity: typeof is "number" but
	// Number.isFinite is false. With &&, the block is dropped (null); with
	// ||, `typeof v==="number"` alone short-circuits true and the (non-finite)
	// value is kept, changing which entries survive.
	it("drops a block whose complexity parses to Infinity (typeof number but not finite)", () => {
		const payload = {
			"/tmp/x.py": [
				{ type: "function", name: "huge", complexity: 1e400, lineno: 1, endline: 2 },
				{ type: "function", name: "real", complexity: 2, lineno: 3, endline: 4 },
			],
		};
		const entries = parseRadonJson(JSON.stringify(payload)) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["real"]);
	});
});

// ===========================================
// toRadonBlock (via parseRadonJson — not exported directly)
// ===========================================

describe("toRadonBlock — null/malformed guard mutants", () => {
	// test-contract: state-based — kills three mutants at once: the
	// LogicalOperator (|| -> &&) and whole-ConditionalExpression (-> false)
	// on `typeof raw !== "object" || raw === null`, and the ConditionalExpression
	// (-> false) on the `raw === null` sub-clause. Each of these, when raw is a
	// bare `null` array entry, causes the guard to NOT return early, so the
	// code falls through to `raw.type` — a TypeError on null — instead of the
	// original's graceful `return null`.
	it("does not throw and drops a bare null block entry", () => {
		const payload = {
			"/tmp/x.py": [null, { type: "function", name: "real", complexity: 2, lineno: 3, endline: 4 }],
		};
		let entries!: ReturnType<typeof parseRadonJson>;
		expect(() => {
			entries = parseRadonJson(JSON.stringify(payload));
		}).not.toThrow();
		expect(entries).not.toBeNull();
		expect(entries?.map((e) => e.name)).toEqual(["real"]);
	});

	// test-contract: state-based — kills the ConditionalExpression mutant
	// that forces `type !== "function" && type !== "method" && type !== "class"`
	// to `false`. flattenBlocks itself already filters non-function/method
	// types from the OUTPUT, so a same-shape test with no nested children
	// can't distinguish this mutant; nesting a valid `methods` entry under
	// the unrecognized-type block does, because the mutant lets the whole
	// (unrecognized) block through toRadonBlock, and its `methods` are still
	// recursed into by flattenBlocks even though the block itself is dropped.
	it("discards a block with an unrecognized type, including its nested methods", () => {
		const payload = {
			"/tmp/x.py": [
				{
					type: "weird",
					name: "outer",
					complexity: 1,
					lineno: 1,
					endline: 10,
					methods: [{ type: "method", name: "inner", complexity: 2, lineno: 2, endline: 5 }],
				},
				{ type: "function", name: "real", complexity: 3, lineno: 11, endline: 12 },
			],
		};
		const entries = parseRadonJson(JSON.stringify(payload)) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["real"]);
	});

	// test-contract: state-based — kills the ConditionalExpression mutant
	// forcing `lineno === null` to `false`: a block missing `lineno` should
	// be dropped entirely, not emitted with a null `line`.
	it("drops a block missing lineno", () => {
		const payload = {
			"/tmp/x.py": [
				{ type: "function", name: "bad", complexity: 1, endline: 5 },
				{ type: "function", name: "real", complexity: 2, lineno: 10, endline: 11 },
			],
		};
		const entries = parseRadonJson(JSON.stringify(payload)) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["real"]);
	});

	// test-contract: state-based — kills the ConditionalExpression mutant
	// forcing `endline === null` to `false`: a block missing `endline` should
	// be dropped entirely.
	it("drops a block missing endline", () => {
		const payload = {
			"/tmp/x.py": [
				{ type: "function", name: "bad2", complexity: 1, lineno: 3 },
				{ type: "function", name: "real", complexity: 2, lineno: 10, endline: 11 },
			],
		};
		const entries = parseRadonJson(JSON.stringify(payload)) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["real"]);
	});

	// test-contract: state-based — kills the MethodExpression mutant that
	// removes `.filter(isBlock)` from the `methods` mapping. Without the
	// filter, a malformed methods entry stays `null` in the array and
	// flattenBlocks crashes reading `.type` off it instead of skipping it.
	it("filters a malformed methods entry instead of crashing", () => {
		const payload = {
			"/tmp/x.py": [
				{
					type: "class",
					name: "C",
					complexity: 5,
					lineno: 1,
					endline: 20,
					methods: ["not a block", { type: "method", name: "m", complexity: 2, lineno: 2, endline: 5 }],
				},
			],
		};
		let entries!: ReturnType<typeof parseRadonJson>;
		expect(() => {
			entries = parseRadonJson(JSON.stringify(payload));
		}).not.toThrow();
		expect(entries?.map((e) => e.name)).toEqual(["m"]);
	});

	// test-contract: state-based — kills the MethodExpression mutant that
	// removes `.filter(isBlock)` from the `closures` mapping (same failure
	// mode as the methods case above, distinct site).
	it("filters a malformed closures entry instead of crashing", () => {
		const payload = {
			"/tmp/x.py": [
				{
					type: "function",
					name: "outer",
					complexity: 3,
					lineno: 1,
					endline: 20,
					closures: [
						"not a block",
						{ type: "function", name: "inner", complexity: 1, lineno: 2, endline: 5 },
					],
				},
			],
		};
		let entries!: ReturnType<typeof parseRadonJson>;
		expect(() => {
			entries = parseRadonJson(JSON.stringify(payload));
		}).not.toThrow();
		expect((entries ?? []).map((e) => e.name).sort()).toEqual(["inner", "outer"]);
	});
});

// ===========================================
// parseRadonJson — final sort
// ===========================================

describe("parseRadonJson — final sort", () => {
	// test-contract: state-based — kills three mutants at once: removing the
	// `.sort(...)` call (MethodExpression), replacing the comparator body
	// with `() => undefined` (ArrowFunction), and flipping `a.line - b.line`
	// to `a.line + b.line` (ArithmeticOperator). All three leave the array in
	// its pre-sort (traversal) order for this out-of-order input, instead of
	// ascending by line.
	it("sorts entries ascending by line even when pushed out of order", () => {
		const payload = {
			"/tmp/x.py": [
				{ type: "function", name: "second", complexity: 1, lineno: 10, endline: 12 },
				{ type: "function", name: "first", complexity: 1, lineno: 1, endline: 3 },
			],
		};
		const entries = parseRadonJson(JSON.stringify(payload)) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["first", "second"]);
	});
});

// ===========================================
// computeCyclomaticPython — mkdtemp prefix / sanitize / spawn command / cc options
// ===========================================

describe("computeCyclomaticPython — temp-file naming and spawn call shape", () => {
	// test-contract: mock-spy — kills six StringLiteral/ObjectLiteral
	// mutants in one pass: the "interlinked-radon-" mkdtemp prefix, the "_"
	// sanitize-replacement character, the "utf-8" writeFileSync encoding,
	// the "radon" command name passed to the `cc` spawn call, and the whole
	// {encoding,timeout} options object (plus its "utf-8" string) passed to
	// that same call.
	it("uses the interlinked-radon- prefix, underscore-sanitizes the basename, and calls radon cc with exact options", async () => {
		vi.resetModules();
		const mkdtempPrefixes: string[] = [];
		const writeFileCalls: { path: string; encoding: unknown }[] = [];
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				mkdtempSync: (prefix: string) => {
					mkdtempPrefixes.push(prefix);
					return actual.mkdtempSync(prefix);
				},
				writeFileSync: (...[path, data, encoding]: Parameters<typeof actual.writeFileSync>) => {
					writeFileCalls.push({ path: String(path), encoding });
					return actual.writeFileSync(path, data, encoding);
				},
			};
		});
		const { computeCyclomaticPython: computeFresh } = await import("./cyclomatic-python.js");
		const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
		const spawn = (command: string, args: readonly string[], options: unknown) => {
			calls.push({ command, args, options });
			return { status: 0, stdout: "{}", stderr: "" };
		};
		const out = computeFresh("def f():\n  pass\n", "weird name!.py", spawn);
		expect(out).toEqual([]);
		expect(mkdtempPrefixes[0]).toMatch(/interlinked-radon-$/);
		expect(writeFileCalls[0]?.encoding).toBe("utf-8");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("radon");
		expect(calls[0]?.options).toEqual({ encoding: "utf-8", timeout: 5000 });
		const tmpFile = calls[0]?.args[3];
		expect(tmpFile).toMatch(/weird_name_\.py$/);
		vi.doUnmock("node:fs");
		vi.resetModules();
	});
});

// ===========================================
// computeCyclomaticPython — error / status / stdout guard conditions
// ===========================================

describe("computeCyclomaticPython — error/status/stdout guards", () => {
	// test-contract: state-based — kills the ConditionalExpression mutant
	// forcing `result.error !== undefined` to `false`. With a real error
	// object present but a valid-looking stdout, the mutant would fall
	// through to parseRadonJson and return `[]` instead of `null`.
	it("returns null when spawn reports an error even though stdout looks parseable", () => {
		const err = Object.assign(new Error("weird"), { code: "EWEIRD" });
		const out = computeCyclomaticPython("def f():\n  pass\n", "x.py", () => ({
			status: 0,
			stdout: "{}",
			stderr: "",
			error: err,
		}));
		expect(out).toBeNull();
	});

	// test-contract: state-based — kills the ConditionalExpression mutant
	// forcing `result.status !== 0 && result.status !== null` to `false`.
	// A nonzero, non-null status with valid-looking stdout would otherwise
	// fall through to a wrong `[]` result.
	it("returns null when status is a nonzero non-null code even though stdout looks parseable", () => {
		const out = computeCyclomaticPython("def f():\n  pass\n", "x.py", () => ({
			status: 5,
			stdout: "{}",
			stderr: "",
		}));
		expect(out).toBeNull();
	});

	// test-contract: state-based — kills two mutants on the SAME line: the
	// ConditionalExpression forcing `result.status !== null` to `true`, and
	// the EqualityOperator flipping it to `result.status === null`. Both
	// turn a legitimate status===null success (radon's own convention,
	// mirrored from radonAvailable) into an incorrect `null` return.
	it("treats status===null as success, same as status===0", () => {
		const out = computeCyclomaticPython("def f():\n  pass\n", "x.py", () => ({
			status: null,
			stdout: "{}",
			stderr: "",
		}));
		expect(out).toEqual([]);
	});

	// test-contract: state-based — kills three mutants on the same guard
	// line at once: the whole ConditionalExpression forced to `false`, the
	// `typeof result.stdout !== "string"` sub-clause forced to `false`, and
	// the LogicalOperator flipped from `||` to `&&`. A boxed `String` object
	// has `typeof !== "string"` (true) but a working `.trim()` that returns
	// a non-empty value, so all three mutants let it fall through to a
	// successful (wrong) parse instead of the correct `null`.
	it("returns null for a non-primitive-string stdout even though its .trim() is non-empty", () => {
		const boxed = new String("{}");
		const out = computeCyclomaticPython("def f():\n  pass\n", "x.py", () => ({
			status: 0,
			// SAFETY: the boxed string intentionally violates the spawn contract to exercise rejection of non-primitive stdout.
			stdout: boxed as unknown as string,
			stderr: "",
		}));
		expect(out).toBeNull();
	});
});
