import { describe, expect, it } from "vitest";
import { localhostRegionExemptLines } from "./localhost-regions.js";

describe("localhostRegionExemptLines — positive (lines ARE exempt)", () => {
	it("P1: every line of a Rust #[cfg(test)] module", () => {
		const lines = ["pub fn a() {}", "", "#[cfg(test)]", "mod tests {", '  const U: &str = "http://localhost:1";', "}"];
		expect([...localhostRegionExemptLines(lines, "src/client.rs")]).toEqual([2, 3, 4, 5]);
	});

	it("P2: a Rust #[cfg(any(test, feature = \"x\"))] attribute scopes its item", () => {
		const lines = ["fn a() {}", '#[cfg(any(test, feature = "mock"))]', "mod tests {}"];
		expect([...localhostRegionExemptLines(lines, "src/a.rs")]).toEqual([1, 2]);
	});

	it("P3: a multi-line Python docstring in statement position, opener and closer included", () => {
		const lines = ["def f():", '    """Doc.', "", '    >>> f("http://localhost:1")', '    """', "    return 1"];
		expect([...localhostRegionExemptLines(lines, "pkg/a.py")]).toEqual([1, 2, 3, 4]);
	});

	it("P4: a one-line docstring and a raw-prefixed docstring", () => {
		const lines = ["def f():", '    """http://localhost:1"""', "    x = 1", "def g():", "    r'''raw http://localhost:2'''"];
		expect([...localhostRegionExemptLines(lines, "pkg/a.pyi")]).toEqual([1, 4]);
	});

	it("P5: a #if DEBUG region in Swift, but not its #else branch", () => {
		const lines = ["#if DEBUG", 'let u = "http://localhost:1"', "#else", 'let u = "https://x"', "#endif", 'let v = "http://localhost:2"'];
		expect([...localhostRegionExemptLines(lines, "App/Api.swift")]).toEqual([1]);
	});

	it("P6: a #ifndef NDEBUG region and a nested unrelated #if inside it", () => {
		const lines = ["#ifndef NDEBUG", "#if FEATURE_X", 'const char* u = "http://localhost:1";', "#endif", "#endif"];
		expect([...localhostRegionExemptLines(lines, "src/a.cc")]).toEqual([2]);
	});

	it("P7: the #else branch of a release-only region is dev", () => {
		const lines = ["#ifdef NDEBUG", 'const char* u = "https://x";', "#else", 'const char* u = "http://localhost:1";', "#endif"];
		expect([...localhostRegionExemptLines(lines, "src/a.h")]).toEqual([3]);
	});
});

describe("localhostRegionExemptLines — negative (lines are NOT exempt)", () => {
	it("resumes scanning production items after a Rust test module closes", () => {
		const lines = ["#[cfg(test)]", "mod tests {", "  fn test_client() {}", "}", 'const API: &str = "http://localhost:8080";'];
		expect([...localhostRegionExemptLines(lines, "src/client.rs")]).toEqual([0, 1, 2, 3]);
	});
	it("does not exempt items after an external Rust test module", () => {
		const lines = ["#[cfg(test)]", "mod tests;", 'const API: &str = "http://localhost:8080";'];
		expect([...localhostRegionExemptLines(lines, "src/client.rs")]).toEqual([0, 1]);
	});
	it("N1: a Python triple-quoted string assigned to a name is data, and the scan resumes after it", () => {
		const lines = ['SQL = """', "  http://localhost:1", '"""', 'url = "http://localhost:2"', "def f():", '    """doc"""'];
		expect([...localhostRegionExemptLines(lines, "pkg/a.py")]).toEqual([5]);
	});

	it("N2: a triple-quoted call argument is data", () => {
		const lines = ['run("""', "http://localhost:1", '""")'];
		expect([...localhostRegionExemptLines(lines, "pkg/a.py")]).toEqual([]);
	});

	it("N3: the #else branch of an unrelated #if is not dev", () => {
		const lines = ["#if FEATURE_X", "int a;", "#else", 'const char* u = "http://localhost:1";', "#endif"];
		expect([...localhostRegionExemptLines(lines, "src/a.c")]).toEqual([]);
	});

	it("N4: #ifndef DEBUG is the release branch", () => {
		const lines = ["#ifndef DEBUG", 'const char* u = "http://localhost:1";', "#endif"];
		expect([...localhostRegionExemptLines(lines, "src/a.cpp")]).toEqual([]);
	});

	it("N5: a Rust file without #[cfg(test)] has no tail", () => {
		expect([...localhostRegionExemptLines(['const U: &str = "http://localhost:1";'], "src/a.rs")]).toEqual([]);
	});

	it("N6: other languages get no region exemption", () => {
		const lines = ["#if DEBUG", '"""', "#[cfg(test)]"];
		expect([...localhostRegionExemptLines(lines, "src/a.ts")]).toEqual([]);
		expect([...localhostRegionExemptLines(lines, "src/a.go")]).toEqual([]);
	});
});
