// Adversarial cases for `ubs_mutex_lock_unwrap` (independent FP hunt, 2026-10-21).
// Probes: scratch/2026-10-21-adversarial/ubs_mutex_lock_unwrap*.probe.mts

import { describe, expect, it } from "vitest";
import { checkMutexLockUnwrap } from "../../checks/ubs-language-specific/rust-go-checks.js";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("ubs_mutex_lock_unwrap — negative (must not fire)", () => {
	it("N1: inline #[cfg(test)] mod tests unwraps a Mutex lock", () => {
		const code = lines(
			"use std::sync::Mutex;",
			"#[cfg(test)]",
			"mod tests {",
			"    #[test]",
			"    fn t() {",
			"        let m: Mutex<i32> = Mutex::new(0);",
			"        assert_eq!(*m.lock().unwrap(), 0);",
			"    }",
			"}",
		);
		expect(checkMutexLockUnwrap(code, "src/lib.rs")).toEqual([]);
	});

	it("N2: one-line #[test] fn outside a test module", () => {
		const code = lines(
			"use std::sync::Mutex;",
			"#[test] fn t() { let m: Mutex<i32> = Mutex::new(0); let _ = m.lock().unwrap(); }",
		);
		expect(checkMutexLockUnwrap(code, "src/lib.rs")).toEqual([]);
	});

	it("N3: integration test under a relative tests/ directory", () => {
		const code = lines("let m: Mutex<i32> = Mutex::new(0);", "let _ = m.lock().unwrap();");
		expect(checkMutexLockUnwrap(code, "tests/counter.rs")).toEqual([]);
	});

	it("N4: std::fs::File::lock().unwrap() on a File field next to a Mutex field", () => {
		const code = lines(
			"pub struct S {",
			"    state: Mutex<State>,",
			"    lockfile: File,",
			"}",
			"impl S { fn h(&self) { self.lockfile.lock().unwrap(); } }",
		);
		expect(checkMutexLockUnwrap(code, "src/server.rs")).toEqual([]);
	});

	it("N5: fslock LockFile parameter .lock().unwrap() near a static Mutex", () => {
		const code = lines(
			"static Q: Mutex<Vec<u8>> = Mutex::new(Vec::new());",
			"fn run(file: &mut LockFile) {",
			"    file.lock().unwrap();",
			"}",
		);
		expect(checkMutexLockUnwrap(code, "src/run.rs")).toEqual([]);
	});
});

describe("ubs_mutex_lock_unwrap — positive (must fire)", () => {
	it("P1: out-of-line `mod tests;` exempts nothing — the next prod fn fires", () => {
		const code = lines(
			"use std::sync::Mutex;",
			"#[cfg(test)]",
			"mod tests;",
			"pub fn prod(m: &Mutex<i32>) -> i32 {",
			"    *m.lock().unwrap()",
			"}",
		);
		expect(checkMutexLockUnwrap(code, "src/lib.rs").map((m) => m.line)).toEqual([5]);
	});

	it("P2: production unwrap after a test module still fires, the test one does not", () => {
		const code = lines(
			"use std::sync::Mutex;",
			"#[cfg(test)]",
			"mod tests {",
			"    #[test]",
			"    fn t() { let m: Mutex<i32> = Mutex::new(0); let _ = m.lock().unwrap(); }",
			"}",
			"pub fn prod(m: &Mutex<i32>) -> i32 {",
			"    *m.lock().unwrap()",
			"}",
		);
		expect(checkMutexLockUnwrap(code, "src/lib.rs").map((m) => m.line)).toEqual([8]);
	});

	it("P3: a field typed by a Mutex alias still fires", () => {
		const code = lines(
			"type Shared = Arc<Mutex<u32>>;",
			"struct A { state: Shared }",
			"impl A { fn f(&self) { let _ = self.state.lock().unwrap(); } }",
		);
		expect(checkMutexLockUnwrap(code, "src/lib.rs").map((m) => m.line)).toEqual([3]);
	});

	it("P4: an Arc<Mutex<T>> field fires", () => {
		const code = lines(
			"struct A { inner: Arc<Mutex<u32>> }",
			"impl A { fn f(&self) -> u32 { *self.inner.lock().unwrap() } }",
		);
		expect(checkMutexLockUnwrap(code, "src/lib.rs").map((m) => m.line)).toEqual([2]);
	});

	it("P5: #[cfg(test)] on a use statement does not exempt later production code", () => {
		const code = lines(
			"#[cfg(test)]",
			"use std::println;",
			"static M: Mutex<u8> = Mutex::new(0);",
			"pub fn f() -> u8 { *M.lock().unwrap() }",
		);
		expect(checkMutexLockUnwrap(code, "src/lib.rs").map((m) => m.line)).toEqual([4]);
	});
});
