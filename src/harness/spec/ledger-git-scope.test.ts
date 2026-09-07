import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecLedger } from "./ledger.js";

let root: string;
const broken = "# Snapshot\nSee [design](design/missing.md).\n";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "spec-git-scope-"));
	execFileSync("git", ["init", "--quiet", root]);
	writeFileSync(join(root, ".gitignore"), "archives/\n");
	mkdirSync(join(root, "archives"));
	writeFileSync(join(root, "archives", "snapshot.md"), broken);
	writeFileSync(join(root, "README.md"), broken);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("spec ledger repository scope", () => {
	it("omits ignored snapshot directories while retaining live broken links", () => {
		const findings = SpecLedger.build(root).computeDrift().filter(finding => finding.kind === "xref_missing_file");
		expect(findings.map(finding => finding.file)).toEqual(["README.md"]);
		expect(readFileSync(join(root, "archives", "snapshot.md"), "utf8")).toBe(broken);
	});

	it("keeps explicitly tracked documents inside an ignored directory", () => {
		execFileSync("git", ["add", "-f", "archives/snapshot.md"], { cwd: root });
		const findings = SpecLedger.build(root).computeDrift().filter(finding => finding.kind === "xref_missing_file");
		expect(findings.map(finding => finding.file).sort()).toEqual(["README.md", "archives/snapshot.md"]);
	});

	it("does not reintroduce ignored archives through an incremental refresh", () => {
		const ledger = SpecLedger.build(root);
		ledger.refreshFile("archives/snapshot.md", broken);
		expect(ledger.computeDrift().filter(finding => finding.file.startsWith("archives/"))).toEqual([]);
	});
});
