// Independent adversarial FP review for the pre_block check `c_sprintf_usage`
// (checkCSprintfUsage). Each negative case is legitimate C/C++ that the
// detector flagged before the 2026-10-21 refinement; probe:
// scratch/2026-10-21-adversarial/c_sprintf_usage.probe.mts
import { describe, expect, it } from "vitest";
import { checkCSprintfUsage } from "../../checks/c-cpp.js";

describe("c_sprintf_usage — negative (must not fire)", () => {
	it("N1: fmt::sprintf — the {fmt} library overload returns std::string", () => {
		const code = 'std::string s = fmt::sprintf("%d items", count);';
		expect(checkCSprintfUsage(code, "util.cpp")).toEqual([]);
	});

	it("N2: tfm::sprintf — tinyformat's bounded overload", () => {
		const code = 'return tfm::sprintf("%s=%d", key, val);';
		expect(checkCSprintfUsage(code, "log.cpp")).toEqual([]);
	});

	it("N3: QString::sprintf member call is not the libc function", () => {
		const code = 'label.sprintf("%d%%", pct);';
		expect(checkCSprintfUsage(code, "ui.cpp")).toEqual([]);
	});

	it("N4: a ->sprintf method on a growable string builder", () => {
		const code = 'sb->sprintf("%s: %d", name, n);';
		expect(checkCSprintfUsage(code, "buf.cpp")).toEqual([]);
	});

	it("N5: the libc prototype in a minimal stdio.h", () => {
		const code = "extern int sprintf(char *restrict s, const char *restrict fmt, ...);";
		expect(checkCSprintfUsage(code, "include/stdio.h")).toEqual([]);
	});

	it("N6: the libc definition line in a minimal stdio.c", () => {
		const code = "int sprintf(char *s, const char *fmt, ...) {";
		expect(checkCSprintfUsage(code, "lib/stdio.c")).toEqual([]);
	});

	it("N7: a prototype carrying a format attribute", () => {
		const code = "int sprintf(char *, const char *, ...) __attribute__((format(printf, 2, 3)));";
		expect(checkCSprintfUsage(code, "stdio.h")).toEqual([]);
	});

	it("N8: any other namespace's sprintf is a different function", () => {
		const code = 'auto s = strf::sprintf("%d", 1);';
		expect(checkCSprintfUsage(code, "b.cpp")).toEqual([]);
	});
});

describe("c_sprintf_usage — positive (must fire)", () => {
	it("P1: std::sprintf is the unbounded libc function", () => {
		const code = 'std::sprintf(buf, "%d", x);';
		expect(checkCSprintfUsage(code, "fmt.cpp")).toHaveLength(1);
	});

	it("P2: global-qualified ::sprintf", () => {
		const code = '::sprintf(buf, "%d", x);';
		expect(checkCSprintfUsage(code, "fmt.cpp")).toHaveLength(1);
	});

	it("P3: return sprintf(...) is a call, not a declarator", () => {
		const code = 'return sprintf(buf, "%d", x);';
		expect(checkCSprintfUsage(code, "fmt.c")).toHaveLength(1);
	});

	it("P4: an assignment from sprintf", () => {
		const code = 'int n = sprintf(buf, "%d", 1);';
		expect(checkCSprintfUsage(code, "e.c")).toHaveLength(1);
	});

	it("P5: a (void)-cast call", () => {
		const code = '(void)sprintf(buf, "%d", v);';
		expect(checkCSprintfUsage(code, "x.c")).toHaveLength(1);
	});

	it("P6: else sprintf(...) after an if", () => {
		const code = 'else sprintf(buf, "%d", 1);';
		expect(checkCSprintfUsage(code, "e.c")).toHaveLength(1);
	});
});
