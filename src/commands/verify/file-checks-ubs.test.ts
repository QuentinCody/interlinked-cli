// ===========================================
// file-checks UBS group unit tests
// ===========================================

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { runUbsChecks } from "./file-checks-ubs.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

function ctx(content: string, file = "/tmp/sample.ts", relPath = "sample.ts"): FileCheckContext {
	return { file, content, relPath, cwd: "/tmp", r: emptyResults(), piiOpts: {} };
}

function orchestrate(content: string, file = "/tmp/sample.ts"): CodeQualityResults {
	const r = emptyResults();
	runPerFileChecks({
		file,
		content,
		cwd: "/tmp",
		r,
		moduleExportsCache: new Map(),
		allEnvRefs: new Map(),
		piiOpts: {},
	});
	return r;
}

describe("runUbsChecks", () => {
	it("flags JS loose equality (ubs_js_loose_equality)", () => {
		const c = ctx('if (x == 5) { doThing(); }\n');
		runUbsChecks(c);
		expect(c.r.jsLooseEquality.length).toBeGreaterThan(0);
		expect(nonNull(c.r.jsLooseEquality[0]).check).toBe("ubs_js_loose_equality");
	});

	it("flags Python None equality (ubs_py_none_equality)", () => {
		const c = ctx("if x == None:\n    pass\n", "/tmp/sample.py", "sample.py");
		runUbsChecks(c);
		expect(c.r.pyNoneEquality.length).toBeGreaterThan(0);
		expect(nonNull(c.r.pyNoneEquality[0]).check).toBe("ubs_py_none_equality");
	});

	it("flags Rust debug_assert side effects (ubs_rust_debug_assert_side_effect)", () => {
		const c = ctx(
			"fn f(queue: &mut Vec<u8>) { debug_assert_eq!(queue.pop(), Some(1)); }\n",
			"/tmp/sample.rs",
			"sample.rs",
		);
		runUbsChecks(c);
		expect(c.r.rustDebugAssertSideEffect.length).toBeGreaterThan(0);
		expect(nonNull(c.r.rustDebugAssertSideEffect[0]).check).toBe(
			"ubs_rust_debug_assert_side_effect",
		);
	});

	it("flags C assert side effects (ubs_c_assert_side_effect)", () => {
		const c = ctx(
			"static void refresh(map_t *m, key_t k) {\n  assert(insert_stale(m, k));\n}\n",
			"/tmp/sample.c",
			"sample.c",
		);
		runUbsChecks(c);
		expect(c.r.cAssertSideEffect.length).toBeGreaterThan(0);
		expect(nonNull(c.r.cAssertSideEffect[0]).check).toBe("ubs_c_assert_side_effect");
	});

	it("flags Python assert side effects (ubs_python_assert_side_effect)", () => {
		const c = ctx(
			"def refresh(cache, key):\n    assert cache.insert_stale(key)\n",
			"/tmp/sample.py",
			"sample.py",
		);
		runUbsChecks(c);
		expect(c.r.pythonAssertSideEffect.length).toBeGreaterThan(0);
		expect(nonNull(c.r.pythonAssertSideEffect[0]).check).toBe(
			"ubs_python_assert_side_effect",
		);
	});

	it("flags Java assert side effects (ubs_java_assert_side_effect)", () => {
		const c = ctx(
			"class Registry {\n  void track(List<String> list, String x) {\n    assert list.add(x);\n  }\n}\n",
			"/tmp/Registry.java",
			"Registry.java",
		);
		runUbsChecks(c);
		expect(c.r.javaAssertSideEffect.length).toBeGreaterThan(0);
		expect(nonNull(c.r.javaAssertSideEffect[0]).check).toBe("ubs_java_assert_side_effect");
	});

	it("flags unchecked bytemuck::cast_slice (ubs_rust_unchecked_cast_slice)", () => {
		const c = ctx(
			"fn decode(buf: &[u8]) -> &[u16] {\n    bytemuck::cast_slice(buf)\n}\n",
			"/tmp/decode.rs",
			"decode.rs",
		);
		runUbsChecks(c);
		expect(c.r.rustUncheckedCastSlice.length).toBeGreaterThan(0);
		expect(nonNull(c.r.rustUncheckedCastSlice[0]).check).toBe(
			"ubs_rust_unchecked_cast_slice",
		);
	});

	it("flags unguarded typed-array reinterpret (unaligned_reinterpret)", () => {
		const c = ctx(
			"export function decode(buf: Uint8Array): Uint16Array {\n\treturn new Uint16Array(buf.buffer);\n}\n",
			"/tmp/decode.ts",
			"decode.ts",
		);
		runUbsChecks(c);
		expect(c.r.unalignedReinterpret.length).toBeGreaterThan(0);
		expect(nonNull(c.r.unalignedReinterpret[0]).check).toBe("unaligned_reinterpret");
	});

	it("flags document.write (ubs_document_write)", () => {
		const c = ctx('document.write("<p>hi</p>");\n');
		runUbsChecks(c);
		expect(c.r.documentWrite.length).toBeGreaterThan(0);
		expect(nonNull(c.r.documentWrite[0]).check).toBe("ubs_document_write");
	});

	it("produces the same ubs_js_loose_equality findings as the orchestrator (delegation)", () => {
		const src = 'if (x == 5) { doThing(); }\n';
		const c = ctx(src);
		runUbsChecks(c);
		// The orchestrator binds each primary-file finding to the sha256 of the content it checked.
		const sourceHash = createHash("sha256").update(src).digest("hex");
		expect(c.r.jsLooseEquality.length).toBeGreaterThan(0);
		expect(orchestrate(src).jsLooseEquality).toEqual(c.r.jsLooseEquality.map(row => ({ ...row, sourceHash })));
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value: number = 1;\n');
		runUbsChecks(c);
		expect(c.r.jsLooseEquality).toHaveLength(0);
		expect(c.r.documentWrite).toHaveLength(0);
		expect(c.r.weakHash).toHaveLength(0);
	});
});
