// Tests for `ubs_deeply_nested_callback` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkDeeplyNestedCallback } from "../checks/ubs-language-specific.js";

describe("checkDeeplyNestedCallback", () => {
	it("flags 4+ levels of nested arrow callbacks", () => {
		const code =
			"a(() => {\n  b(() => {\n    c(() => {\n      d(() => {\n        e();\n      });\n    });\n  });\n});\n";
		const matches = checkDeeplyNestedCallback(code, "src/lib/foo.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag a 2-level nesting", () => {
		const code = "a(() => {\n  b(() => {\n    c();\n  });\n});\n";
		expect(checkDeeplyNestedCallback(code, "src/lib/foo.ts")).toEqual([]);
	});

	it("does NOT fire on Python files", () => {
		const code =
			"a(() => {\n  b(() => {\n    c(() => {\n      d(() => {});\n    });\n  });\n});";
		expect(checkDeeplyNestedCallback(code, "src/foo.py")).toEqual([]);
	});

	it("inspects computations inside test files", () => {
		const code =
			"a(() => {\n  b(() => {\n    c(() => {\n      d(() => {});\n    });\n  });\n});";
		expect(checkDeeplyNestedCallback(code, "src/foo.test.ts")).toHaveLength(1);
	});
});
