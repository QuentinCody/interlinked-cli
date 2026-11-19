import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localScanTarget } from "./local-scan-target.js";

// `interlinked verify --subdir scratch/probe` on a local project scanned the whole
// project: the option was read for a remote clone only and ignored otherwise.
describe("localScanTarget", () => {
	it("narrows a local run to the subdirectory when no target is given", () => {
		expect(localScanTarget({ subdir: "scratch/probe" })).toBe("scratch/probe");
	});

	it("narrows a local target to its subdirectory", () => {
		expect(localScanTarget({ target: "packages/app", subdir: "src" })).toBe(join("packages/app", "src"));
	});

	it("returns the target unchanged when no subdirectory is given", () => {
		expect(localScanTarget({ target: "packages/app" })).toBe("packages/app");
	});

	it("returns undefined for a plain project run", () => {
		expect(localScanTarget({})).toBeUndefined();
	});
});
