// Independent adversarial FP review for the pre_block check `c_unsafe_functions`
// (checkCUnsafeFunctions). Each negative case is legitimate C/C++ that the
// detector flagged before the 2026-10-21 refinement; probe:
// scratch/2026-10-21-adversarial/c_unsafe_functions.probe.mts
import { describe, expect, it } from "vitest";
import { checkCUnsafeFunctions } from "../../checks/c-cpp.js";

describe("c_unsafe_functions — negative (must not fire)", () => {
	it("N1: fmt::sprintf — the {fmt} library overload returns std::string", () => {
		const code = 'std::string s = fmt::sprintf("%d items", count);';
		expect(checkCUnsafeFunctions(code, "util.cpp")).toEqual([]);
	});

	it("N2: tfm::sprintf — tinyformat's bounded overload", () => {
		const code = 'return tfm::sprintf("%s=%d", key, val);';
		expect(checkCUnsafeFunctions(code, "log.cpp")).toEqual([]);
	});

	it("N3: QString::sprintf member call is not the libc function", () => {
		const code = 'QString label; label.sprintf("%d%%", pct);';
		expect(checkCUnsafeFunctions(code, "ui.cpp")).toEqual([]);
	});

	it("N4: a C vtable function-pointer field called through ->gets", () => {
		const code = "if (!fops->gets(buf, sizeof buf, fp)) return -1;";
		expect(checkCUnsafeFunctions(code, "vfs.c")).toEqual([]);
	});

	it("N5: an ops-table member .strcpy is a field, not libc", () => {
		const code = "ops.strcpy(dst, src);";
		expect(checkCUnsafeFunctions(code, "ops.c")).toEqual([]);
	});

	it("N6: the libc prototype in a minimal string.h", () => {
		const code = "extern char *strcpy(char *restrict dst, const char *restrict src);";
		expect(checkCUnsafeFunctions(code, "include/string.h")).toEqual([]);
	});

	it("N7: the libc definition line in a minimal string.c", () => {
		const code = "char *strcpy(char *d, const char *s) {";
		expect(checkCUnsafeFunctions(code, "lib/string.c")).toEqual([]);
	});

	it("N8: a prototype carrying __attribute__((deprecated))", () => {
		const code = "char *gets(char *s) __attribute__((deprecated));";
		expect(checkCUnsafeFunctions(code, "string.h")).toEqual([]);
	});

	it("N9: a custom namespace's bounded strcpy overload", () => {
		const code = "mystr::strcpy(dst, src, cap);";
		expect(checkCUnsafeFunctions(code, "s.cpp")).toEqual([]);
	});
});

describe("c_unsafe_functions — positive (must fire)", () => {
	it("P1: std::sprintf is the unbounded libc function", () => {
		const code = 'std::sprintf(buf, "%d", x);';
		expect(checkCUnsafeFunctions(code, "fmt.cpp")).toHaveLength(1);
	});

	it("P2: global-qualified ::gets", () => {
		const code = "::gets(buf);";
		expect(checkCUnsafeFunctions(code, "s.cpp")).toHaveLength(1);
	});

	it("P3: return strcpy(...) is a call, not a declarator", () => {
		const code = "return strcpy(dst, src);";
		expect(checkCUnsafeFunctions(code, "s.c")).toHaveLength(1);
	});

	it("P4: an assignment from strcpy", () => {
		const code = "char *p = strcpy(dst, src);";
		expect(checkCUnsafeFunctions(code, "s.c")).toHaveLength(1);
	});

	it("P5: a (void)-cast call", () => {
		const code = '(void)sprintf(buf, "%d", v);';
		expect(checkCUnsafeFunctions(code, "x.c")).toHaveLength(1);
	});

	it("P6: else strcat(...) after an if", () => {
		const code = "else strcat(buf, tail);";
		expect(checkCUnsafeFunctions(code, "x.c")).toHaveLength(1);
	});
});
