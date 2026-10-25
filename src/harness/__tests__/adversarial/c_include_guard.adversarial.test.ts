// Independent adversarial review of the c_include_guard pre_block check
// (2026-10-21). Every negative here was a header a reasonable reviewer accepts
// and the detector refused before the refinement in checks/c-cpp.ts.
// Probe: scratch/2026-10-21-adversarial/c_include_guard.probe.mts

import { describe, expect, it } from "vitest";
import { checkCIncludeGuard } from "../../checks/c-cpp.js";

describe("c_include_guard — negative (must not fire)", () => {
	it("N1: #if !defined(FOO_H) / #define FOO_H is a traditional guard", () => {
		const code = "#if !defined(FOO_H)\n#define FOO_H\nvoid foo(void);\n#endif /* FOO_H */\n";
		expect(checkCIncludeGuard(code, "foo.h")).toEqual([]);
	});

	it("N2: #if !defined FOO_H without parentheses is also a guard", () => {
		const code = "#if ! defined FOO_H\n#define FOO_H\nvoid foo(void);\n#endif\n";
		expect(checkCIncludeGuard(code, "foo.h")).toEqual([]);
	});

	it("N3: X-macro header with an #ifndef X / #error contract is included many times by design", () => {
		const code =
			'/* Intended to be included multiple times with X defined. */\n#ifndef X\n#error "define X(name) before including tokens.h"\n#endif\nX(IDENT)\nX(NUMBER)\nX(STRING)\n#undef X\n';
		expect(checkCIncludeGuard(code, "tokens.h")).toEqual([]);
	});

	it("N4: X-macro header with X(...) rows and a trailing #undef X, no #error contract", () => {
		const code = "OPCODE(ADD, 1)\nOPCODE(SUB, 2)\nOPCODE(MUL, 3)\n#undef OPCODE\n";
		expect(checkCIncludeGuard(code, "opcodes.h")).toEqual([]);
	});

	it("N5: Objective-C header from the Xcode template (#import, @interface)", () => {
		const code =
			"#import <UIKit/UIKit.h>\n\nNS_ASSUME_NONNULL_BEGIN\n\n@interface AppDelegate : UIResponder <UIApplicationDelegate>\n@property (strong, nonatomic) UIWindow *window;\n@end\n\nNS_ASSUME_NONNULL_END\n";
		expect(checkCIncludeGuard(code, "AppDelegate.h")).toEqual([]);
	});

	it("N6: Objective-C protocol header with @class forward declaration and no #import", () => {
		const code = "@class Foo;\n@protocol FooDelegate <NSObject>\n- (void)fooDidFinish:(Foo *)foo;\n@end\n";
		expect(checkCIncludeGuard(code, "Delegate.h")).toEqual([]);
	});

	it("N7: comment-only placeholder header has nothing to guard", () => {
		const code = "/* config.h — generated. Intentionally empty on this platform. */\n// see configure.ac\n";
		expect(checkCIncludeGuard(code, "config.h")).toEqual([]);
	});

	it("N8: pshpack1.h-style one-sided #pragma pack(push) wrapper", () => {
		const code =
			"#if !(defined(MIDL_PASS)) || defined(__midl)\n#pragma pack(push,1)\n#else\n#pragma pack(1)\n#endif\n";
		expect(checkCIncludeGuard(code, "pshpack1.h")).toEqual([]);
	});

	it("N9: poppack.h-style one-sided #pragma pack(pop) wrapper", () => {
		const code = "#pragma pack(pop)\n";
		expect(checkCIncludeGuard(code, "poppack.h")).toEqual([]);
	});

	it('N10: _Pragma("once") operator form is the same directive', () => {
		const code = '_Pragma("once")\nvoid foo(void);\n';
		expect(checkCIncludeGuard(code, "foo.h")).toEqual([]);
	});

	it("N11: BOM + CRLF #pragma once", () => {
		const code = "﻿#pragma once\r\nvoid foo(void);\r\n";
		expect(checkCIncludeGuard(code, "foo.h")).toEqual([]);
	});
});

describe("c_include_guard — positive (must fire)", () => {
	it("P1: unguarded header with a declaration still fires", () => {
		const code = "#include <stdio.h>\nvoid foo(void);\n";
		expect(checkCIncludeGuard(code, "foo.h")).toHaveLength(1);
	});

	it("P2: a comment that merely mentions #pragma once is not a guard", () => {
		const code = "// TODO: add #pragma once\nvoid foo(void);\n";
		expect(checkCIncludeGuard(code, "foo.h")).toHaveLength(1);
	});

	it("P3: @interface mentioned only inside a comment does not make a C header Objective-C", () => {
		const code = "/* mirrors the @interface in Foo.h */\nvoid foo(void);\n";
		expect(checkCIncludeGuard(code, "foo.h")).toHaveLength(1);
	});

	it("P4: #undef of a macro that is never invoked as X(...) rows is not an X-macro header", () => {
		const code = "#include <windows.h>\n#undef min\n#undef max\nint clamp(int v);\n";
		expect(checkCIncludeGuard(code, "util.h")).toHaveLength(1);
	});

	it("P5: a balanced #pragma pack(push)/pack(pop) around a struct still needs a guard", () => {
		const code = "#pragma pack(push, 1)\nstruct wire { int a; };\n#pragma pack(pop)\n";
		expect(checkCIncludeGuard(code, "wire.h")).toHaveLength(1);
	});

	it("P6: #ifndef without a matching #define is not a guard", () => {
		const code = "#ifndef NDEBUG\nvoid trace(void);\n#endif\n";
		expect(checkCIncludeGuard(code, "trace.h")).toHaveLength(1);
	});
});
