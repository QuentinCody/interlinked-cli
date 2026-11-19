// Tests for the independent adversarial dimension, read from the executed suites.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ADVERSARIAL_TEST_DIR,
	type AdversarialSuite,
	adversarialGap,
	adversarialSuiteCheckId,
	describeAdversarialGap,
	loadAdversarialSuites,
} from "./adversarial.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const FP_HUNT = `
import { checkThing } from "../../checks/thing.js";
describe("thing — negative (must not fire)", () => {
	it("N1: a guarded call", () => expect(checkThing("guarded")).toEqual([]));
});
describe("thing — positive (must fire)", () => {
	it("P1: the bug class", () => expect(checkThing("bad")).toHaveLength(1));
});
`;

function suite(source: string, file = `${ADVERSARIAL_TEST_DIR}/thing.adversarial.test.ts`): AdversarialSuite {
	return { file, source };
}

describe("adversarialGap — negative (obligation IS met, no gap)", () => {
	it("N1: a suite that names the detector and pins a false positive", () => {
		expect(adversarialGap([suite(FP_HUNT)], "checkThing")).toBeNull();
	});

	it("N2: one qualifying suite among several is enough", () => {
		const positivesOnly = suite('import { checkThing } from "x";\nit("P1: x", () => {});');
		expect(adversarialGap([positivesOnly, suite(FP_HUNT)], "checkThing")).toBeNull();
	});
});

describe("adversarialGap — positive (must report a gap)", () => {
	it("P1: no suite at all", () => {
		expect(adversarialGap(undefined, "checkThing")).toBe("missing");
		expect(adversarialGap([], "checkThing")).toBe("missing");
	});

	it("P2: a suite named for the check that exercises another detector", () => {
		expect(adversarialGap([suite(FP_HUNT)], "checkOther")).toBe("detector_not_named");
	});

	it("P3: a longer identifier is not the detector's name", () => {
		expect(adversarialGap([suite(FP_HUNT.replaceAll("checkThing", "checkThingStrict"))], "checkThing")).toBe(
			"detector_not_named",
		);
	});

	it("P4: a suite with no labeled MUST-NOT-FIRE case", () => {
		const positivesOnly = 'import { checkThing } from "x";\nit("P1: fires", () => expect(checkThing("b")).toHaveLength(1));';
		expect(adversarialGap([suite(positivesOnly)], "checkThing")).toBe("no_negative_cases");
	});
});

describe("adversarialSuiteCheckId", () => {
	it("P1: reads the check id of an adversarial and a foreign suite", () => {
		expect(adversarialSuiteCheckId("nan_comparison.adversarial.test.ts")).toBe("nan_comparison");
		expect(adversarialSuiteCheckId("floating_promises.foreign.test.ts")).toBe("floating_promises");
	});

	it("N1: an ordinary test file is not a suite", () => {
		expect(adversarialSuiteCheckId("nan_comparison.test.ts")).toBeNull();
		expect(adversarialSuiteCheckId("README.md")).toBeNull();
	});
});

describe("describeAdversarialGap", () => {
	it("explains every gap kind", () => {
		for (const gap of ["missing", "detector_not_named", "no_negative_cases"] as const) {
			expect(describeAdversarialGap(gap).length).toBeGreaterThan(10);
		}
	});

	it("names the suite directory in the missing message", () => {
		expect(describeAdversarialGap("missing")).toContain(ADVERSARIAL_TEST_DIR);
	});
});

describe("loadAdversarialSuites", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cec-adv-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("N1: a missing suite directory reads as no suites", () => {
		expect(loadAdversarialSuites(root)).toEqual({});
	});

	it("P1: keys suites by check id and skips files without the suite shape", () => {
		mkdirSync(join(root, ADVERSARIAL_TEST_DIR), { recursive: true });
		writeFileSync(join(root, ADVERSARIAL_TEST_DIR, "thing.adversarial.test.ts"), FP_HUNT);
		writeFileSync(join(root, ADVERSARIAL_TEST_DIR, "thing.foreign.test.ts"), FP_HUNT);
		writeFileSync(join(root, ADVERSARIAL_TEST_DIR, "helpers.ts"), "export const x = 1;");
		const suites = loadAdversarialSuites(root);
		expect(Object.keys(suites)).toEqual(["thing"]);
		expect(suites.thing?.map((s) => s.file)).toEqual([
			`${ADVERSARIAL_TEST_DIR}/thing.adversarial.test.ts`,
			`${ADVERSARIAL_TEST_DIR}/thing.foreign.test.ts`,
		]);
	});

	it("P2: the repository's own suites satisfy the dimension for nan_comparison", () => {
		const suites = loadAdversarialSuites(REPO_ROOT);
		expect(adversarialGap(suites.nan_comparison, "checkNanComparison")).toBeNull();
	});
});
