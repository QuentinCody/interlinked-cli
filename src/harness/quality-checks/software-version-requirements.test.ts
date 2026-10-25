import { describe, expect, it } from "vitest";
import { collectRequirementRef, isRequirementsFile } from "./software-version-requirements.js";

describe("isRequirementsFile — positive (must accept)", () => {
	it("P1: pip requirement and constraint files, a requirements/ directory, Pipfile and setup.cfg", () => {
		const accepted: [string, string][] = [
			["requirements.txt", "requirements.txt"],
			["requirements-dev.txt", "requirements-dev.txt"],
			["dev-requirements.in", "dev-requirements.in"],
			["constraints.txt", "constraints.txt"],
			["requirements/base.in", "base.in"],
			["Pipfile", "pipfile"],
			["setup.cfg", "setup.cfg"],
		];
		for (const [path, base] of accepted) expect(isRequirementsFile(path, base), path).toBe(true);
	});
});

describe("isRequirementsFile — negative (must reject)", () => {
	it("N1: code, prose and other config files are not pin manifests", () => {
		const rejected: [string, string][] = [
			["scratch/e66/timeline.py", "timeline.py"],
			["notes.md", "notes.md"],
			["config/app.ini", "app.ini"],
			["requirements.md", "requirements.md"],
			["src/requirements.ts", "requirements.ts"],
			["docs/notes.txt", "notes.txt"],
		];
		for (const [path, base] of rejected) expect(isRequirementsFile(path, base), path).toBe(false);
	});
});

describe("collectRequirementRef", () => {
	it("P2: a pin line becomes a package reference at that line", () => {
		expect(collectRequirementRef("requests==2.31.0  # http", 3)).toEqual({
			anchor: "package:requests",
			label: "Python package requests",
			kind: "package",
			version: "2.31.0",
			line: 3,
			text: "requests==2.31.0  # http",
		});
	});

	it("N2: a comment or an include line is not a reference", () => {
		expect(collectRequirementRef("# just a comment", 1)).toBeUndefined();
		expect(collectRequirementRef("-r base.txt", 2)).toBeUndefined();
	});
});
