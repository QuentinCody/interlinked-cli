// Tests for companion-test detection: the exact candidate list and the
// qualified-name presence predicate (`hasCompanionTest`).
//
// The 2026-08-17 defect this pins: `<base>.<qualifier>.test.ts` names
// (update.integration.test.ts, search.mutation-hardening.test.ts) were not
// recognized as companions, so `interlinked metrics` flagged 68 tested files
// as "missing a companion test".

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companionHintPath, companionTestCandidates, hasCompanionTest } from "./companion-test.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "companion-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function touch(rel: string): void {
	const abs = join(dir, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, "// test\n");
}

describe("companionTestCandidates", () => {
    it.each([
        "src/pkg/test_foo.py", "src/pkg/foo_test.py", "src/pkg/tests/test_foo.py",
        "src/tests/test_foo.py", "tests/src/pkg/test_foo.py", "tests/pkg/foo_test.py",
        "tests/test_foo.py", "test/test_foo.py",
    ])("finds a Python companion at %s", (testPath) => {
        touch(testPath);
        expect(hasCompanionTest(join(dir, "src/pkg/foo.py"), dir)).toBe(true);
    });

    it("keeps a parent/tests Python companion without a projectRoot", () => {
        touch("src/tests/test_foo.py");
        expect(hasCompanionTest(join(dir, "src/pkg/foo.py"))).toBe(true);
    });

    it("does not borrow a parent/tests companion outside the supplied root", () => {
        touch("tests/test_foo.py");
        mkdirSync(join(dir, "project"));
        const root = join(dir, "project");
        expect(hasCompanionTest(join(root, "foo.py"), root)).toBe(false);
    });

    it("uses Python naming in the user-facing hint", () => {
        expect(companionHintPath("pkg/service.py")).toBe("pkg/test_service.py");
    });

	it("P1: returns the four colocated candidates for a source file", () => {
		const got = companionTestCandidates(join(dir, "foo.ts"));
		expect(got).toEqual([
			join(dir, "foo.test.ts"),
			join(dir, "__tests__", "foo.test.ts"),
			join(dir, "foo.spec.ts"),
			join(dir, "__tests__", "foo.spec.ts"),
		]);
	});

	it("N1: does not emit separate-tree candidates without a projectRoot", () => {
		const got = companionTestCandidates(join(dir, "src", "foo.ts"));
		expect(got.every((c) => c.startsWith(join(dir, "src")))).toBe(true);
	});
});

describe("hasCompanionTest — positive (must find)", () => {
	it("P1: exact sibling <base>.test.ts", () => {
		touch("foo.ts");
		touch("foo.test.ts");
		expect(hasCompanionTest(join(dir, "foo.ts"))).toBe(true);
	});

	it("P2: qualified sibling <base>.integration.test.ts", () => {
		touch("update.ts");
		touch("update.integration.test.ts");
		expect(hasCompanionTest(join(dir, "update.ts"))).toBe(true);
	});

	it("P3: multi-qualifier sibling <base>.mutation-kill.test.ts", () => {
		touch("update.ts");
		touch("update.mutation-kill.test.ts");
		expect(hasCompanionTest(join(dir, "update.ts"))).toBe(true);
	});

	it("P4: qualified spec variant in __tests__/", () => {
		touch("bar.ts");
		touch(join("__tests__", "bar.hardening.spec.ts"));
		expect(hasCompanionTest(join(dir, "bar.ts"))).toBe(true);
	});

	it("P5: .tsx source with qualified .tsx companion", () => {
		touch("panel.tsx");
		touch("panel.render.test.tsx");
		expect(hasCompanionTest(join(dir, "panel.tsx"))).toBe(true);
	});
});

describe("hasCompanionTest — negative (must not find)", () => {
	it("N1: no test files at all", () => {
		touch("foo.ts");
		expect(hasCompanionTest(join(dir, "foo.ts"))).toBe(false);
	});

	it("N2: prefix-collision file (foobar.test.ts is not foo's companion)", () => {
		touch("foo.ts");
		touch("foobar.test.ts");
		expect(hasCompanionTest(join(dir, "foo.ts"))).toBe(false);
	});

	it("N3: non-test sibling sharing the base name (foo.helpers.ts)", () => {
		touch("foo.ts");
		touch("foo.helpers.ts");
		expect(hasCompanionTest(join(dir, "foo.ts"))).toBe(false);
	});

	it("N4: extension mismatch (foo.test.tsx is not foo.ts's companion)", () => {
		touch("foo.ts");
		touch("foo.test.tsx");
		expect(hasCompanionTest(join(dir, "foo.ts"))).toBe(false);
	});

	it("N5: another module's qualified test in the same dir", () => {
		touch("foo.ts");
		touch("other.integration.test.ts");
		expect(hasCompanionTest(join(dir, "foo.ts"))).toBe(false);
	});
});
