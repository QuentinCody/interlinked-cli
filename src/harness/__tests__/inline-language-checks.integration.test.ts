import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { getProfileForFile } from "../language-profiles.js";
import {
	__test__,
	runInlineLanguageChecks,
} from "../quality-checks/inline-language-checks.js";
import type { InlineCheckDef, LanguageProfile } from "../types.js";

/** Build a profile with a hand-picked pattern absent from the shipped profiles. */
function buildProfile(id: LanguageProfile["id"], inline_checks: InlineCheckDef[]): LanguageProfile {
	return {
		id,
		display_name: id,
		file_extensions: [],
		project_root_markers: [],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks,
	};
}

// Helper: run inline checks against a synthetic file on-disk path. The
// filesystem never gets touched — runInlineLanguageChecks only reads
// content from its arguments.
function run(filePath: string, content: string) {
	const profile = getProfileForFile(filePath);
	if (!profile) throw new Error(`no profile for ${filePath}`);
	return runInlineLanguageChecks(filePath, content, profile);
}

describe("runInlineLanguageChecks — Python", () => {
	it("flags bare except", async () => {
		const src = `def f():\n    try:\n        pass\n    except:\n        pass\n`;
		const results = run("/repo/src/m.py", src);
		const bareExcepts = results.filter((r) => r.name === "python_bare_except");
		expect(bareExcepts).toHaveLength(1);
		expect(nonNull(bareExcepts[0]).message).toContain("m.py:4");
	});

	it("does not flag `except Exception:`", async () => {
		const src = `try:\n    pass\nexcept Exception:\n    pass\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});

	it("flags mutable default arguments", async () => {
		const src = `def foo(x=[]):\n    pass\ndef bar(y={}):\n    pass\n`;
		const results = run("/repo/src/m.py", src);
		const mutable = results.filter((r) => r.name === "python_mutable_default");
		expect(mutable).toHaveLength(2);
	});

	it("does not flag `=None` default", async () => {
		const src = `def foo(x=None):\n    pass\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_mutable_default")).toHaveLength(0);
	});

	it("does not fire on bare except inside a string literal", async () => {
		const src = `msg = "    except:\\n"\nprint(msg)\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});

	it("does not fire on commented-out bare except", async () => {
		const src = `# except:\nprint(1)\n`;
		const results = run("/repo/src/m.py", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});
});

describe("runInlineLanguageChecks — Rust", () => {
	it("flags `.unwrap()` in non-test code", async () => {
		const src = `fn f() { let x = opt.unwrap(); }\n`;
		const results = run("/repo/src/lib.rs", src);
		const unwraps = results.filter((r) => r.name === "rust_unwrap_usage");
		expect(unwraps).toHaveLength(1);
	});

	it("skips `.unwrap()` in a *_test.rs file", async () => {
		const src = `fn t() { foo.unwrap(); }\n`;
		const results = run("/repo/tests/lib_test.rs", src);
		expect(results.filter((r) => r.name === "rust_unwrap_usage")).toHaveLength(0);
	});

	it("flags unsafe blocks", async () => {
		const src = `unsafe {\n  *ptr = 42;\n}\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_unsafe_blocks")).toHaveLength(1);
	});

	it("exempts unsafe block documented with // SAFETY:", async () => {
		const src = `// SAFETY: ptr is guaranteed non-null by caller\nunsafe {\n  *ptr = 42;\n}\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_unsafe_blocks")).toHaveLength(0);
	});

	it("flags todo!() and unimplemented!()", async () => {
		const src = `fn f() { todo!(); }\nfn g() { unimplemented!(); }\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_todo_macro")).toHaveLength(2);
	});

	it("does not fire on .unwrap() inside a line comment", async () => {
		const src = `// old: foo.unwrap()\nfn f() {}\n`;
		const results = run("/repo/src/lib.rs", src);
		expect(results.filter((r) => r.name === "rust_unwrap_usage")).toHaveLength(0);
	});

	// --- New Rust checks (added with GPU/Rust quality batch) ---

	describe("rust_panic_in_lib", () => {
		it("flags bare panic!() in lib code", async () => {
			const src = `fn invariant() { panic!("unreachable"); }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_panic_in_lib")).toHaveLength(1);
		});

		it("flags panic!() with no args", async () => {
			const src = `fn boom() { panic!(); }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_panic_in_lib")).toHaveLength(1);
		});

		it("does not fire on panic!() in *_test.rs files", async () => {
			const src = `fn t() { panic!("expected"); }\n`;
			const results = run("/repo/tests/lib_test.rs", src);
			expect(results.filter((r) => r.name === "rust_panic_in_lib")).toHaveLength(0);
		});

		it("does not fire on panic!() inside a comment", async () => {
			const src = `// example: panic!() will crash\nfn f() {}\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_panic_in_lib")).toHaveLength(0);
		});

		it("does not fire on panic!() inside a string literal", async () => {
			const src = `fn f() -> &'static str { "panic!()" }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_panic_in_lib")).toHaveLength(0);
		});

		it("does not fire on identifiers that contain 'panic' as a substring", async () => {
			const src = `fn my_panic_handler() {}\nfn handle_panicking() {}\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_panic_in_lib")).toHaveLength(0);
		});
	});

	describe("rust_expect_empty_msg", () => {
		it("flags .expect(\"\")", async () => {
			const src = `fn f(o: Option<u32>) -> u32 { o.expect("") }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_expect_empty_msg")).toHaveLength(1);
		});

		it("flags .expect( \"\" ) with whitespace", async () => {
			const src = `fn f(o: Option<u32>) -> u32 { o.expect(  ""  ) }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_expect_empty_msg")).toHaveLength(1);
		});

		it("does not flag .expect(\"good reason\")", async () => {
			const src = `fn f(o: Option<u32>) -> u32 { o.expect("must be Some by invariant") }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_expect_empty_msg")).toHaveLength(0);
		});

		it("does not flag .expect with a non-empty single-char message", async () => {
			const src = `fn f(o: Option<u32>) -> u32 { o.expect("x") }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_expect_empty_msg")).toHaveLength(0);
		});
	});

	describe("rust_box_dyn_error_in_pub_return", () => {
		it("flags pub fn returning Result<_, Box<dyn Error>>", async () => {
			const src = `pub fn open() -> Result<File, Box<dyn Error>> { todo!() }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(
				results.filter((r) => r.name === "rust_box_dyn_error_in_pub_return"),
			).toHaveLength(1);
		});

		it("flags pub fn with arguments returning Box<dyn Error>", async () => {
			const src = `pub fn parse(s: &str) -> Result<u32, Box<dyn Error + Send + Sync>> { todo!() }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(
				results.filter((r) => r.name === "rust_box_dyn_error_in_pub_return"),
			).toHaveLength(1);
		});

		it("does not flag private fn returning Box<dyn Error>", async () => {
			const src = `fn open() -> Result<File, Box<dyn Error>> { todo!() }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(
				results.filter((r) => r.name === "rust_box_dyn_error_in_pub_return"),
			).toHaveLength(0);
		});

		it("does not flag pub fn returning a typed error", async () => {
			const src = `pub fn open() -> Result<File, MyError> { todo!() }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(
				results.filter((r) => r.name === "rust_box_dyn_error_in_pub_return"),
			).toHaveLength(0);
		});

		it("does not flag pub fn returning Box<ConcreteError> (no `dyn`)", async () => {
			const src = `pub fn open() -> Result<File, Box<MyError>> { todo!() }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(
				results.filter((r) => r.name === "rust_box_dyn_error_in_pub_return"),
			).toHaveLength(0);
		});
	});

	describe("rust_dbg_macro", () => {
		it("flags dbg!(x)", async () => {
			const src = `fn f(x: u32) { let _ = dbg!(x); }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_dbg_macro")).toHaveLength(1);
		});

		it("flags dbg!() with no args", async () => {
			const src = `fn f() { dbg!(); }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_dbg_macro")).toHaveLength(1);
		});

		it("does not fire on dbg!() in *_test.rs files", async () => {
			const src = `fn t() { dbg!(value); }\n`;
			const results = run("/repo/tests/lib_test.rs", src);
			expect(results.filter((r) => r.name === "rust_dbg_macro")).toHaveLength(0);
		});

		it("does not fire on dbg!() inside a comment", async () => {
			const src = `// note: use dbg!() during development only\nfn f() {}\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_dbg_macro")).toHaveLength(0);
		});

		it("does not fire on identifiers that start with 'dbg'", async () => {
			const src = `fn dbg_helper() {}\nfn dbg_format(s: &str) -> String { s.into() }\n`;
			const results = run("/repo/src/lib.rs", src);
			expect(results.filter((r) => r.name === "rust_dbg_macro")).toHaveLength(0);
		});
	});
});

describe("runInlineLanguageChecks — CUDA", () => {
	describe("cuda_kernel_launch_unchecked", () => {
		it("flags a bare kernel launch on a .cu file", async () => {
			const src = `void launch() {\n  add_kernel<<<grid, block>>>(d_a, d_b, d_c, n);\n}\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_kernel_launch_unchecked"),
			).toHaveLength(1);
		});

		it("flags multiple kernel launches", async () => {
			const src = `void launch() {\n  k1<<<g, b>>>(d);\n  k2<<<g, b>>>(d);\n}\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_kernel_launch_unchecked"),
			).toHaveLength(2);
		});

		it("does not fire on text inside a comment", async () => {
			const src = `// example: kernel<<<g, b>>>(d);\nvoid f() {}\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_kernel_launch_unchecked"),
			).toHaveLength(0);
		});

		it("does not fire on text inside a string literal", async () => {
			const src = `const char* msg = "use kernel<<<g, b>>>(d);";\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_kernel_launch_unchecked"),
			).toHaveLength(0);
		});
	});

	describe("cuda_device_synchronize_debug", () => {
		it("flags cudaDeviceSynchronize()", async () => {
			const src = `void wait() { cudaDeviceSynchronize(); }\n`;
			const results = run("/repo/src/host.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_device_synchronize_debug"),
			).toHaveLength(1);
		});

		it("flags cudaDeviceSynchronize ( ) with whitespace", async () => {
			const src = `void wait() { cudaDeviceSynchronize  (  ); }\n`;
			const results = run("/repo/src/host.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_device_synchronize_debug"),
			).toHaveLength(1);
		});

		it("does not flag cudaStreamSynchronize(stream)", async () => {
			const src = `void wait(cudaStream_t s) { cudaStreamSynchronize(s); }\n`;
			const results = run("/repo/src/host.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_device_synchronize_debug"),
			).toHaveLength(0);
		});

		it("does not fire on commented-out call", async () => {
			const src = `// removed: cudaDeviceSynchronize();\nvoid f() {}\n`;
			const results = run("/repo/src/host.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_device_synchronize_debug"),
			).toHaveLength(0);
		});
	});

	describe("cuda_printf_in_device_code", () => {
		it("flags printf() in a .cu file", async () => {
			const src = `__global__ void k() { printf("tid=%d\\n", threadIdx.x); }\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_printf_in_device_code"),
			).toHaveLength(1);
		});

		it("flags printf() in a .cuh file", async () => {
			const src = `static inline void log() { printf("ok"); }\n`;
			const results = run("/repo/src/util.cuh", src);
			expect(
				results.filter((r) => r.name === "cuda_printf_in_device_code"),
			).toHaveLength(1);
		});

		it("does not fire on commented printf", async () => {
			const src = `// debug: printf("..."); /* removed */\nvoid f() {}\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_printf_in_device_code"),
			).toHaveLength(0);
		});

		it("does not fire on printf inside a string literal", async () => {
			const src = `const char* tmpl = "use printf() carefully";\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_printf_in_device_code"),
			).toHaveLength(0);
		});

		it("file_types gate: does not run against a regular .c file", async () => {
			const src = `int main() { printf("hi"); }\n`;
			const results = run("/repo/src/m.c", src);
			expect(
				results.filter((r) => r.name === "cuda_printf_in_device_code"),
			).toHaveLength(0);
		});
	});

	describe("cuda_syncthreads_in_conditional", () => {
		it("flags __syncthreads() inside a single-line if", async () => {
			const src = `__global__ void k() { if (threadIdx.x < n) __syncthreads(); }\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_syncthreads_in_conditional"),
			).toHaveLength(1);
		});

		it("flags __syncthreads() inside a single-line while", async () => {
			const src = `__global__ void k() { while (cond()) __syncthreads(); }\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_syncthreads_in_conditional"),
			).toHaveLength(1);
		});

		it("does not flag bare __syncthreads() outside a conditional", async () => {
			const src = `__global__ void k() {\n  do_work();\n  __syncthreads();\n  more();\n}\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_syncthreads_in_conditional"),
			).toHaveLength(0);
		});

		it("does not fire on commented-out conditional sync", async () => {
			const src = `// example bug: if (x) __syncthreads();\n__global__ void k() {}\n`;
			const results = run("/repo/src/kernel.cu", src);
			expect(
				results.filter((r) => r.name === "cuda_syncthreads_in_conditional"),
			).toHaveLength(0);
		});
	});
});

describe("runInlineLanguageChecks — Go", () => {
	it("flags `_, _ := foo()` and `_ = foo()`", async () => {
		const src = `package m\n\nfunc f() {\n  _, _ := doSomething()\n  _ = another()\n}\n`;
		const results = run("/repo/src/m.go", src);
		const ignored = results.filter((r) => r.name === "go_error_ignored");
		expect(ignored.length).toBeGreaterThanOrEqual(1);
	});

	it("does not flag normal tuple assignment with a non-underscore error", async () => {
		const src = `package m\nfunc f() {\n  v, err := doSomething()\n  _ = v\n  _ = err\n}\n`;
		const results = run("/repo/src/m.go", src);
		// `_ = v` and `_ = err` do match the pattern; `v, err :=` does not.
		// We only verify the v,err assignment doesn't falsely fire.
		const firstLineHits = results.filter(
			(r) => r.name === "go_error_ignored" && r.message.includes(":3"),
		);
		expect(firstLineHits).toHaveLength(0);
	});
});

describe("runInlineLanguageChecks — Swift", () => {
	it("flags force cast (as!)", async () => {
		const src = `let x = y as! Int\n`;
		const results = run("/repo/src/m.swift", src);
		expect(results.filter((r) => r.name === "swift_force_cast")).toHaveLength(1);
	});

	it("flags force try (try!)", async () => {
		const src = `let x = try! foo()\n`;
		const results = run("/repo/src/m.swift", src);
		expect(results.filter((r) => r.name === "swift_force_try")).toHaveLength(1);
	});

	it("flags legacy arc4random()", async () => {
		const src = `let n = arc4random()\n`;
		const results = run("/repo/src/m.swift", src);
		expect(results.filter((r) => r.name === "swift_legacy_random")).toHaveLength(1);
	});
});

describe("runInlineLanguageChecks — Java", () => {
	it("flags wildcard imports", async () => {
		const src = `import java.util.*;\n\nclass X {}\n`;
		const results = run("/repo/src/X.java", src);
		expect(results.filter((r) => r.name === "java_wildcard_import")).toHaveLength(1);
	});

	it("flags System.exit()", async () => {
		const src = `class X { void f() { System.exit(1); } }\n`;
		const results = run("/repo/src/X.java", src);
		expect(results.filter((r) => r.name === "java_system_exit")).toHaveLength(1);
	});

	it("does not flag explicit imports", async () => {
		const src = `import java.util.List;\nimport java.util.Map;\n`;
		const results = run("/repo/src/X.java", src);
		expect(results.filter((r) => r.name === "java_wildcard_import")).toHaveLength(0);
	});
});

describe("runInlineLanguageChecks — C/C++", () => {
	it("flags strcpy, sprintf, gets", async () => {
		const src = `void f(char* d, const char* s) {\n  strcpy(d, s);\n  sprintf(d, "%s", s);\n  gets(d);\n}\n`;
		const results = run("/repo/src/m.c", src);
		expect(results.filter((r) => r.name === "c_unsafe_functions")).toHaveLength(3);
	});

	it("fires c_include_guard on a header without guard", async () => {
		const src = `int add(int a, int b);\n`;
		const results = run("/repo/src/math.h", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(1);
	});

	it("does not fire c_include_guard when #pragma once present", async () => {
		const src = `#pragma once\nint add(int a, int b);\n`;
		const results = run("/repo/src/math.h", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(0);
	});

	it("does not fire c_include_guard when #ifndef present", async () => {
		const src = `#ifndef MATH_H\n#define MATH_H\nint add(int a, int b);\n#endif\n`;
		const results = run("/repo/src/math.h", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(0);
	});

	it("does not fire c_include_guard on .c files (file_types gate)", async () => {
		const src = `void f() {}\n`;
		const results = run("/repo/src/m.c", src);
		expect(results.filter((r) => r.name === "c_include_guard")).toHaveLength(0);
	});
});

describe("per-language comment/string stripping", () => {
	const { stripPython, stripCStyle } = __test__;

	it("stripPython blanks interiors of single-quote, double-quote, and triple-quoted strings", async () => {
		const src = `s = "unwrap()"\ndoc = """unwrap()"""\nx = 'bad()'\n`;
		const stripped = stripPython(src);
		expect(stripped).not.toContain("unwrap()");
		expect(stripped).not.toContain("bad()");
	});

	it("stripPython blanks # line comments", async () => {
		const src = `# except:\nprint(1)\n`;
		const stripped = stripPython(src);
		expect(stripped).not.toContain("except:");
	});

	it("stripCStyle blanks // line and /* block */ comments", async () => {
		const src = `// unwrap()\n/* unwrap() */\nlet x = 1;\n`;
		const stripped = stripCStyle(src);
		expect(stripped).not.toContain("unwrap()");
	});

	it("stripCStyle blanks string contents", async () => {
		const src = `let x = "unwrap()";\n`;
		const stripped = stripCStyle(src);
		expect(stripped).not.toContain("unwrap()");
	});

	it("stripCStyle blanks single-quoted string contents", async () => {
		const src = `let x = 'unwrap()';\n`;
		const stripped = stripCStyle(src);
		expect(stripped).not.toContain("unwrap()");
	});

	it("stripCStyle blanks backtick template-string contents", async () => {
		const src = "let x = `unwrap()`;\n";
		const stripped = stripCStyle(src);
		expect(stripped).not.toContain("unwrap()");
	});

	it("stripCStyle treats an escaped quote inside a string as not closing it", async () => {
		const src = `let x = "a\\"unwrap()";\n`;
		const stripped = stripCStyle(src);
		expect(stripped).not.toContain("unwrap()");
		// Opening + closing quotes of the (still single, unterminated-early)
		// string literal survive; only the escaped interior quote is blanked.
		expect(stripped).toContain('"');
	});

	it("stripCStyle keeps a multi-line block comment's newlines as real newlines", async () => {
		const src = "/* unwrap()\nstill a comment\n*/\nlet x = 1;\n";
		const stripped = stripCStyle(src);
		expect(stripped.split("\n").length).toBe(src.split("\n").length);
		expect(stripped).not.toContain("unwrap()");
	});

	it("stripCStyle: offset preservation across mixed comments/strings/code", async () => {
		const src = '// unwrap()\nlet x = 1; // trail\n/* block\nspans */\nlet y = "z";\n';
		expect(stripCStyle(src).split("\n").length).toBe(src.split("\n").length);
	});

	it("offset preservation: stripped line count equals original", async () => {
		const src = `# comment\nprint(1)\n# another\n`;
		expect(stripPython(src).split("\n").length).toBe(src.split("\n").length);
	});
});

describe("runInlineLanguageChecks — safeCompile and stripForLanguage edge cases", () => {
	it("skips a malformed regex pattern instead of throwing (safeCompile catch)", () => {
		const def: InlineCheckDef = {
			name: "malformed_pattern_check",
			description: "deliberately malformed for the safeCompile catch path",
			file_types: [".ts"],
			severity: "warning",
			fix_instruction: "n/a",
			pattern: "(", // unbalanced group — `new RegExp` throws a SyntaxError
		};
		const profile = buildProfile("typescript", [def]);
		const results = runInlineLanguageChecks("/repo/src/m.ts", "const x = 1;\n", profile);
		expect(results).toEqual([]);
	});

	it("returns typescript content unstripped (stripForLanguage typescript branch)", () => {
		const def: InlineCheckDef = {
			name: "ts_probe_check",
			description: "probes the typescript no-op stripper branch",
			file_types: [".ts"],
			severity: "warning",
			fix_instruction: "n/a",
			pattern: "TODO_MARKER",
		};
		const profile = buildProfile("typescript", [def]);
		// The typescript branch of stripForLanguage returns content as-is (no
		// comment/string stripping), so a pattern still matches text sitting
		// inside a `//` comment — unlike every other language's stripper.
		const src = "// TODO_MARKER: still present after the no-op strip\n";
		const results = runInlineLanguageChecks("/repo/src/m.ts", src, profile);
		expect(results.filter((r) => r.name === "ts_probe_check")).toHaveLength(1);
	});
});

describe("InlineCheckDef file_types gating", () => {
	it("Python inline checks do not run against .rs files", async () => {
		const src = `except:\n  pass\n`;
		// Deliberately pass a .rs path — the .py patterns should not match
		// because their file_types is [".py"].
		const results = run("/repo/src/m.rs", src);
		expect(results.filter((r) => r.name === "python_bare_except")).toHaveLength(0);
	});
});

// ===========================================
// End-to-end integration through runQualityChecks dispatch loop
// ===========================================
// Confirms that the new "inline_language_checks" branch (A4) dispatches
// through runInlineLanguageChecks and the findings appear in the normal
// quality-checks pipeline.

describe("runQualityChecks: inline_language_checks branch", () => {
	it("surfaces Python bare-except finding for an edited .py file", async () => {
		// Mock fs so the dispatch branch reads our in-memory source without
		// touching the disk.
		const { vi } = await import("vitest");
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => true),
				readFileSync: vi.fn(() => "try:\n    pass\nexcept:\n    pass\n"),
			};
		});
		vi.doMock("node:child_process", () => ({
			spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", error: null })),
			execSync: vi.fn(() => ""),
		}));
		vi.doMock("../check-engine/index.js", () => ({
			configNameToToolId: vi.fn(() => null),
			getOrCreateEngine: vi.fn(() => ({
				runChecks: () => ({
					results: [],
					elapsedMs: 0,
					toolsRun: [],
					toolsSkipped: [],
					metrics: [],
					deduplicatedCount: 0,
				}),
			})),
		}));

		const { runQualityChecks } = await import("../quality-checks.js");

		const results = await runQualityChecks(
			{
				hook_event: "PostToolUse",
				session_id: "t",
				agent_source: "claude",
				timestamp: "2026-04-24T00:00:00.000Z",
				tool_name: "Edit",
				tool_input: { file_path: "/project/src/m.py" },
			},
			{
				inline_language_checks: {
					enabled: true,
					file_types: [".py"],
					timeout_ms: 2000,
					severity: "warning",
				},
			},
			"/project",
		);

		const bareExcepts = results.filter((r) => r.name === "python_bare_except");
		expect(bareExcepts.length).toBeGreaterThanOrEqual(1);
	});
});
