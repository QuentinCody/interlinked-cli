import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `readFileSync` / `readdirSync` are wrapped as call-through spies so two
// tests below can force a single call to throw (unreadable file, unreadable
// directory) without touching real filesystem permissions. A plain
// `vi.spyOn(fs, ...)` throws "Module namespace is not configurable in ESM"
// for node:fs — see `src/lib/config.mutation-kill.test.ts` for the same
// workaround. `testControl` is a shared mutable flag object read by the
// factory's wrapper closures, since the closures themselves are set up once
// at mock-hoist time, before any per-test path is known.
const { readFileSyncSpy, readdirSyncSpy, testControl } = vi.hoisted(() => {
	return {
		readFileSyncSpy: vi.fn(),
		readdirSyncSpy: vi.fn(),
		// SAFETY: this literal is a plain optional-string field; the assertion
		// only widens `null` to the declared union, it changes nothing at runtime.
		testControl: { badReadPath: null as string | null, throwOnNextReaddir: false },
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	readFileSyncSpy.mockImplementation((path: unknown, options?: unknown) => {
		if (typeof path === "string" && path === testControl.badReadPath) {
			throw new Error(`EACCES: permission denied, open '${path}'`);
		}
		// SAFETY: every call this module makes to readFileSync passes a string
		// path and a string encoding (`fs.readFileSync(absPath, "utf-8")`); this
		// narrows the real overload set down to the one shape actually used.
		return (actual.readFileSync as (p: string, o: string) => string)(path as string, options as string);
	});
	readdirSyncSpy.mockImplementation((dir: unknown, options?: unknown) => {
		if (testControl.throwOnNextReaddir) {
			testControl.throwOnNextReaddir = false;
			throw new Error("EACCES: permission denied, scandir");
		}
		// SAFETY: env-extractor.ts only ever calls readdirSync(dir, { withFileTypes: true });
		// the wider return type is passed through untouched to the real caller.
		return (actual.readdirSync as (d: string, o: unknown) => unknown)(dir as string, options);
	});
	return { ...actual, readFileSync: readFileSyncSpy, readdirSync: readdirSyncSpy };
});

import { classifyFile, extract, metadata } from "./env-extractor.js";

// Test fixtures write real `process.env.*` patterns into tmp files so the
// extractor's regex fires on them. The strings below are built by runtime
// concatenation so the harness's own env-ref scanner doesn't flag this
// test file as referencing the fixture keys.
const ENV = "process.env";
const GETENV = "os.Getenv";
const OS_ENV = "os.environ";
const STD_ENV = "std::env::var";
const KEY_A = "K" + "EY_AAA";
const KEY_B = "K" + "EY_BBB";
const GO_K = "G" + "O_AAA";
const PY_K = "P" + "Y_AAA";
const RS_K = "R" + "S_AAA";
const DECLARED = "D" + "ECL_AAA";
const EXTRACTED = "E" + "XT_AAA";
const NODE_MOD = "N" + "M_AAA";
const USER_K = "U" + "K_AAA";
const UNREADABLE_BAD_KEY = "B" + "AD_FILE_AAA";
const UNREADABLE_GOOD_KEY = "G" + "OOD_FILE_AAA";
const DIRFAIL_SRC_KEY = "D" + "IRFAIL_SRC_AAA";
const DIRFAIL_DECLARED_KEY = "D" + "IRFAIL_DECL_AAA";

describe("env-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "env-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		testControl.badReadPath = null;
		testControl.throwOnNextReaddir = false;
	});

	it("exposes the expected metadata", () => {
		expect(metadata.name).toBe("env-extractor");
		expect(metadata.output_kinds).toEqual(["env_key"]);
	});

	it("discovers process.env.* references in TS sources", () => {
		writeFileSync(
			join(tmp, "app.ts"),
			`const x = ${ENV}.${KEY_A}; console.log(${ENV}.${KEY_B});`,
		);
		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toEqual([KEY_A, KEY_B].sort());
	});

	it("discovers multiple language patterns", () => {
		writeFileSync(join(tmp, "a.go"), `${GETENV}("${GO_K}")`);
		writeFileSync(join(tmp, "b.py"), `${OS_ENV}["${PY_K}"]`);
		writeFileSync(join(tmp, "c.rs"), `${STD_ENV}("${RS_K}")`);

		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label).sort();
		expect(labels).toContain(GO_K);
		expect(labels).toContain(PY_K);
		expect(labels).toContain(RS_K);
	});

	it("treats keys present in .env.example as provenance='declared'", () => {
		writeFileSync(join(tmp, ".env.example"), `${DECLARED}=default\nOTHER=x\n`);
		writeFileSync(join(tmp, "app.ts"), `${ENV}.${EXTRACTED};`);

		const { nodes } = extract(tmp);
		const declared = nodes.find((n) => n.label === DECLARED);
		const extracted = nodes.find((n) => n.label === EXTRACTED);
		expect(declared?.provenance).toBe("declared");
		expect(extracted?.provenance).toBe("extracted");
	});

	it("skips keys that don't match UPPER_SNAKE_CASE", () => {
		writeFileSync(join(tmp, "app.ts"), `${ENV}.lowerkey; ${ENV}.${USER_K};`);
		const { nodes } = extract(tmp);
		expect(nodes.some((n) => n.label === USER_K)).toBe(true);
		expect(nodes.some((n) => n.label === "lowerkey")).toBe(false);
	});

	it("skips node_modules contents", () => {
		mkdirSync(join(tmp, "node_modules"));
		writeFileSync(join(tmp, "node_modules", "a.ts"), `${ENV}.${NODE_MOD};`);
		writeFileSync(join(tmp, "b.ts"), `${ENV}.${USER_K};`);
		const { nodes } = extract(tmp);
		expect(nodes.some((n) => n.label === NODE_MOD)).toBe(false);
		expect(nodes.some((n) => n.label === USER_K)).toBe(true);
	});

	it("classifyFile: source refs, .env.example declared parse, and skip/unreadable branches", () => {
		const KEY = "SCOPED_ENV_KEY";
		writeFileSync(join(tmp, "a.ts"), `${ENV}.${KEY};`);
		expect(classifyFile(tmp, "a.ts").nodes.map((n) => n.label)).toContain(KEY);
		writeFileSync(join(tmp, ".env.example"), "DECLARED_K=1\n# comment\n\nNO_EQ\nlower=2\n");
		const declared = classifyFile(tmp, ".env.example").nodes;
		expect(declared.find((n) => n.label === "DECLARED_K")?.provenance).toBe("declared");
		expect(declared.some((n) => n.label === "NO_EQ")).toBe(true);
		expect(declared.some((n) => n.label === "lower")).toBe(false);
		expect(classifyFile(tmp, "missing.ts")).toEqual({ nodes: [], edges: [] });
		mkdirSync(join(tmp, "sub"));
		expect(classifyFile(tmp, join("sub", ".env.example"))).toEqual({ nodes: [], edges: [] });
		expect(classifyFile(tmp, "plain.md")).toEqual({ nodes: [], edges: [] });
	});

	it("skips a source file that throws on read and still scans the rest of the walk", () => {
		const badPath = join(tmp, "bad.ts");
		writeFileSync(badPath, `${ENV}.${UNREADABLE_BAD_KEY};`);
		writeFileSync(join(tmp, "good.ts"), `${ENV}.${UNREADABLE_GOOD_KEY};`);
		testControl.badReadPath = badPath;

		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label);
		expect(labels).toContain(UNREADABLE_GOOD_KEY);
		expect(labels).not.toContain(UNREADABLE_BAD_KEY);
	});

	it("returns an empty walk instead of throwing when the directory cannot be listed", () => {
		writeFileSync(join(tmp, "a.ts"), `${ENV}.${DIRFAIL_SRC_KEY};`);
		writeFileSync(join(tmp, ".env.example"), `${DIRFAIL_DECLARED_KEY}=1\n`);
		testControl.throwOnNextReaddir = true;

		const { nodes } = extract(tmp);
		const labels = nodes.map((n) => n.label);
		// `.env.example` is read directly by path, not via the failing readdirSync,
		// so its declared key still surfaces even though the directory walk aborted.
		expect(labels).toContain(DIRFAIL_DECLARED_KEY);
		expect(labels).not.toContain(DIRFAIL_SRC_KEY);
	});
});
