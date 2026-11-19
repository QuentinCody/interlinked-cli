import { describe, expect, it } from "vitest";
import { findProcessEnvOutsideConfig } from "./env-access-scope.js";

describe("findProcessEnvOutsideConfig — config boundary names", () => {
	// test-contract: public-api — a module named `environment` is a config boundary where env parsing lives.
	it("does not flag process.env reads inside an environment module", () => {
		expect(findProcessEnvOutsideConfig("const r = process.env.REGION;", "src/lib/environment.ts")).toEqual([]);
	});
});
