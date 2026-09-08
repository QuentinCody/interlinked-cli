import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	parseManifest,
	readMutantSnapshot,
	emptySnapshot,
	createMutantWatcher,
} from "./mutation-feed.js";

// node:fs's ESM namespace is non-configurable, so vi.spyOn on the raw import
// throws ("Cannot redefine property"). Route through vi.mock instead: keep
// every real implementation, just wrap readFileSync in a spy-able vi.fn().
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

afterEach(() => vi.unstubAllGlobals());

function manifestText(obj: unknown): string {
	return JSON.stringify(obj);
}

describe("parseManifest — asRecord boundary (kills 874938b3e677bc44 variants)", () => {
	// test-contract: boundary — parseManifest's public contract is "unparseable
	// shape -> emptySnapshot()"; a numeric `files` value is exactly such a shape.
	it("parses a valid manifest with a numeric files entry rejected — kills ba22848b/e2a8bf65/f78e372e/c66a851038/20c787dc", () => {
		const text = manifestText({ generation: 5, engine: "stryker", files: 42 });
		const result = parseManifest(text);
		// A non-object `files` value must be rejected wholesale -> emptySnapshot(),
		// which resets generation/engine to their empty defaults. If asRecord's
		// object/null/array guard is weakened, `files: 42` gets cast as a record
		// instead, and generation/engine survive from the (still-valid) root.
		expect(result).toEqual(emptySnapshot());
		expect(result.generation).toBe(0);
		expect(result.engine).toBe("");
	});

	// test-contract: public-api — control case proving the guard above isn't
	// vacuous: a genuinely valid `files` object must still parse through.
	it("still parses correctly when files is a genuine valid object", () => {
		const text = manifestText({
			generation: 7,
			engine: "stryker",
			files: {
				"src/a.ts": {
					sym1: {
						qualifiedName: "fn",
						mutants: { m1: { mutantId: "id1", mutator: "X", originalLexeme: "a", replacement: "b", status: "Survived" } },
					},
				},
			},
		});
		const result = parseManifest(text);
		expect(result.generation).toBe(7);
		expect(result.engine).toBe("stryker");
		expect(result.mutants).toHaveLength(1);
		expect(result.mutants[0]!.id).toBe("id1");
	});
});

describe("parseManifest — mapMutant default fallback (kills 4291b02446a0f367)", () => {
	// test-contract: public-api — MutantView.original must default to "" (the
	// documented empty-string convention for str()), never a literal sentinel.
	it("defaults `original` to empty string, not a sentinel, when originalLexeme is absent", () => {
		const text = manifestText({
			generation: 1,
			engine: "e",
			files: {
				"f.ts": {
					sym: {
						qualifiedName: "fn",
						mutants: { m1: { mutantId: "id1" /* no originalLexeme, no replacement */ } },
					},
				},
			},
		});
		const result = parseManifest(text);
		expect(result.mutants).toHaveLength(1);
		expect(result.mutants[0]!.original).toBe("");
		expect(result.mutants[0]!.replacement).toBe("");
	});
});

describe("parseManifest — mapMutant null-guard (kills 5e197a1e63e45ea7)", () => {
	// test-contract: bug — a non-record mutant entry must be silently skipped;
	// if the null-guard is disabled, str() dereferences a null record and
	// parseManifest crashes instead of degrading gracefully.
	it("skips a mutant entry that is not a record, without throwing", () => {
		const text = manifestText({
			generation: 1,
			engine: "e",
			files: {
				"f.ts": {
					sym: {
						qualifiedName: "fn",
						mutants: { bad: null, good: { mutantId: "ok", status: "Survived" } },
					},
				},
			},
		});
		let result: ReturnType<typeof parseManifest> | undefined;
		expect(() => {
			result = parseManifest(text);
		}).not.toThrow();
		expect(result!.mutants).toHaveLength(1);
		expect(result!.mutants[0]!.id).toBe("ok");
	});
});

describe("parseManifest — collectSymbol guards (kills 61247ee319c1c030 / 8e5d5e8fd53c204f)", () => {
	// test-contract: bug — an invalid symbol record must be skipped, not
	// dereferenced; disabling the guard reads `.mutants` off a null and throws.
	it("skips a symbol entry that is not a record, without throwing", () => {
		const text = manifestText({
			generation: 1,
			engine: "e",
			files: {
				"f.ts": {
					badSymbol: 5, // not an object -> asRecord(raw) is null
					goodSymbol: {
						qualifiedName: "fn",
						mutants: { m1: { mutantId: "ok", status: "Survived" } },
					},
				},
			},
		});
		let result: ReturnType<typeof parseManifest> | undefined;
		expect(() => {
			result = parseManifest(text);
		}).not.toThrow();
		expect(result!.mutants).toHaveLength(1);
		expect(result!.mutants[0]!.id).toBe("ok");
	});

	// test-contract: bug — a symbol with no valid `mutants` map must be skipped;
	// disabling the guard calls Object.values(null) and throws.
	it("skips a symbol whose `mutants` field is missing/invalid, without throwing", () => {
		const text = manifestText({
			generation: 1,
			engine: "e",
			files: {
				"f.ts": {
					noMutants: { qualifiedName: "fn" /* no mutants key */ },
					goodSymbol: {
						qualifiedName: "fn2",
						mutants: { m1: { mutantId: "ok2", status: "Survived" } },
					},
				},
			},
		});
		let result: ReturnType<typeof parseManifest> | undefined;
		expect(() => {
			result = parseManifest(text);
		}).not.toThrow();
		expect(result!.mutants).toHaveLength(1);
		expect(result!.mutants[0]!.id).toBe("ok2");
	});
});

describe("parseManifest — top-level shape (kills e61a6b6d / 1b5ae90e / 05e8db3d / 786b1a4f)", () => {
	// test-contract: public-api — the documented contract of parseManifest is
	// "never throws; unparseable text yields the exact empty snapshot".
	it("returns the exact empty snapshot on unparseable JSON (kills e61a6b6dff2d659e)", () => {
		const result = parseManifest("{not valid json");
		expect(result).toEqual(emptySnapshot());
	});

	// test-contract: public-api — MutantSnapshot.generation is documented as a
	// number; a non-number root.generation must fall back to 0, not pass through.
	it("defaults generation to 0 when root.generation is not a number (kills 1b5ae90e2b35be2f)", () => {
		const text = manifestText({ generation: "5", engine: "e", files: {} });
		const result = parseManifest(text);
		expect(result.generation).toBe(0);
	});

	// test-contract: bug — an invalid per-file symbol-map must be skipped via
	// `continue`, isolating the good entries from the corrupt one.
	it("skips a file entry whose symbol-map is not a record, without throwing (kills 05e8db3dad332bf7)", () => {
		const text = manifestText({
			generation: 1,
			engine: "e",
			files: {
				"badFile.ts": 42, // not an object
				"goodFile.ts": {
					sym: { qualifiedName: "fn", mutants: { m1: { mutantId: "ok3", status: "Survived" } } },
				},
			},
		});
		let result: ReturnType<typeof parseManifest> | undefined;
		expect(() => {
			result = parseManifest(text);
		}).not.toThrow();
		expect(result!.mutants).toHaveLength(1);
		expect(result!.mutants[0]!.id).toBe("ok3");
	});

	// test-contract: public-api — MutantSnapshot.mutants is documented as
	// capped at MUTANT_CAP (600) while `.total` reports the uncapped count.
	it("caps mutants at MUTANT_CAP (600) but reports the true total (kills 786b1a4f0f1a5c25)", () => {
		const entries: Record<string, unknown> = {};
		const COUNT = 601;
		for (let i = 0; i < COUNT; i++) {
			entries[`m${i}`] = { mutantId: `id${i}`, status: "Survived" };
		}
		const text = manifestText({
			generation: 1,
			engine: "e",
			files: {
				"f.ts": { sym: { qualifiedName: "fn", mutants: entries } },
			},
		});
		const result = parseManifest(text);
		expect(result.mutants).toHaveLength(600);
		expect(result.total).toBe(COUNT);
	});
});

describe("readMutantSnapshot (kills 164e095584a82c0e / 6403a37a9b4136d6)", () => {
	let dir: string;

	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — readMutantSnapshot must actually decode the
	// file's bytes as text (utf-8) and hand the result to parseManifest.
	it("reads and parses an existing manifest file with real content (kills 164e0955)", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-feed-test-"));
		const manifestPath = path.join(dir, "mutation-manifest.json");
		fs.writeFileSync(
			manifestPath,
			manifestText({
				generation: 3,
				engine: "stryker",
				files: { "f.ts": { sym: { qualifiedName: "fn", mutants: { m1: { mutantId: "id1", status: "Survived" } } } } },
			}),
			"utf-8",
		);
		const result = readMutantSnapshot(manifestPath);
		expect(result.generation).toBe(3);
		expect(result.engine).toBe("stryker");
		expect(result.mutants).toHaveLength(1);
	});

	// test-contract: invariant — the documented existsSync guard means a
	// missing path must never reach readFileSync; verified on the real fs
	// module, not just on the return value.
	it("does not attempt to read a file that does not exist (kills 6403a37a9b4136d6)", () => {
		const readSpy = vi.mocked(fs.readFileSync);
		readSpy.mockClear();
		const missingPath = path.join(os.tmpdir(), `mutation-feed-missing-${Date.now()}-${Math.random()}.json`);
		const result = readMutantSnapshot(missingPath);
		expect(result).toEqual(emptySnapshot());
		expect(readSpy).not.toHaveBeenCalled();
	});
});

describe("createMutantWatcher — timer unref (kills fca999cf/fedbe378/e006f9ae/cddaa0f1)", () => {
	// test-contract: invariant — the watcher must call unref() on any interval
	// handle that exposes one, so the poller never keeps the process alive on
	// its own; observed both via the call and via the exact handle it fires on.
	it("calls unref() exactly once, on the handle setInterval returned", () => {
		const fakeUnref = vi.fn();
		const fakeTimer = { unref: fakeUnref };
		vi.stubGlobal("setInterval", vi.fn(() => fakeTimer));
		const { stop } = createMutantWatcher(path.join(os.tmpdir(), "does-not-exist.json"), () => {});
		expect(fakeUnref).toHaveBeenCalledTimes(1);
		// state check beyond call presence: unref must be invoked as a method on
		// the same handle object the watcher is tracking (`this` binding), and
		// the watcher must still hand back a usable stop function.
		expect(fakeUnref.mock.instances[0]).toBe(fakeTimer);
		expect(typeof stop).toBe("function");
		vi.unstubAllGlobals();
		stop();
	});

	// test-contract: boundary — a handle lacking `unref` (e.g. a browser-shaped
	// timer) must be tolerated, not called into, and the watcher must still
	// come back fully constructed.
	it("does not throw and still returns a working stop() when the handle lacks unref()", () => {
		const fakeTimer = {};
		vi.stubGlobal("setInterval", vi.fn(() => fakeTimer));
		let watcher: { stop: () => void } | undefined;
		expect(() => {
			watcher = createMutantWatcher(path.join(os.tmpdir(), "does-not-exist2.json"), () => {});
		}).not.toThrow();
		expect(typeof watcher!.stop).toBe("function");
		vi.unstubAllGlobals();
		watcher!.stop();
	});
});

describe("createMutantWatcher — stop() (kills 44d30f079d337547)", () => {
	// test-contract: public-api — stop() must clear the exact interval handle
	// the watcher created, not merely call clearInterval on something.
	it("stop() clears the underlying interval with the handle setInterval returned", () => {
		const fakeTimer = { unref: vi.fn() };
		vi.stubGlobal("setInterval", vi.fn(() => fakeTimer));
		const clearSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => undefined);
		const { stop } = createMutantWatcher(path.join(os.tmpdir(), "does-not-exist3.json"), () => {}, 10_000);
		stop();
		expect(clearSpy).toHaveBeenCalledTimes(1);
		expect(clearSpy.mock.calls[0]?.[0]).toBe(fakeTimer);
		vi.unstubAllGlobals();
		clearSpy.mockRestore();
	});
});

describe("createMutantWatcher — mtime short-circuit (kills 1743c7f0362b7aac)", () => {
	let dir: string;
	let manifestPath: string;

	afterEach(() => {
		vi.useRealTimers();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — the poll loop's documented cost model is "one
	// stat per tick, one read only when mtime moves"; an always-true mtime
	// comparison would re-read on every tick regardless of file state.
	it("does not re-read the manifest on ticks where mtime is unchanged", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-feed-watch-"));
		manifestPath = path.join(dir, "mutation-manifest.json");
		fs.writeFileSync(manifestPath, manifestText({ generation: 1, engine: "e", files: {} }), "utf-8");

		vi.useFakeTimers();
		const readSpy = vi.mocked(fs.readFileSync);
		readSpy.mockClear();

		const { stop } = createMutantWatcher(manifestPath, () => {}, 10);
		// initial synchronous read happens inside createMutantWatcher, outside the interval
		const callsAfterInit = readSpy.mock.calls.length;
		expect(callsAfterInit).toBe(1);

		// advance several ticks without touching the file — mtime never moves
		vi.advanceTimersByTime(100);

		expect(readSpy.mock.calls.length).toBe(callsAfterInit);

		stop();
	});
	// (no separate "re-reads on mtime change" case: verifying the short-circuit
	// count above already distinguishes the mutated always-changed branch.)
});
