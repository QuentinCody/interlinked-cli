import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("spec ledger repository scope", () => {
	it("keeps explicit fixture contents independent of the filesystem ignore rules", () => {
		const ledger = SpecLedger.fromContents(root, { "archives/fixture.md": broken });
		expect(ledger.fileList()).toEqual(["archives/fixture.md"]);
		expect(ledger.previewWithFile("archives/next.md", broken).fileList().sort()).toEqual([
			"archives/fixture.md", "archives/next.md",
		]);
	});
	it("uses the selected repository for initial and late ignore scope despite inherited Git selectors", () => {
		const foreign = mkdtempSync(join(tmpdir(), "spec-foreign-"));
		try {
			execFileSync("git", ["init", "--quiet", foreign]);
			writeFileSync(join(foreign, ".gitignore"), "README.md\nGUIDE.md\n");
			writeFileSync(join(foreign, "README.md"), broken);
			for (const name of ["GIT_DIR", "GIT_COMMON_DIR"]) vi.stubEnv(name, join(foreign, ".git"));
			vi.stubEnv("GIT_WORK_TREE", foreign);
			vi.stubEnv("GIT_INDEX_FILE", join(foreign, ".git/index"));
			const ledger = SpecLedger.build(root);
			expect(ledger.fileList()).toEqual(["README.md"]);
			writeFileSync(join(root, "GUIDE.md"), broken);
			ledger.refreshFile("GUIDE.md", broken);
			expect(ledger.fileList().sort()).toEqual(["GUIDE.md", "README.md"]);
			expect(process.env.GIT_WORK_TREE).toBe(foreign);
		} finally {
			rmSync(foreign, { recursive: true, force: true });
		}
	});
	it("omits ignored standalone snapshots, including non-ASCII paths", () => {
		writeFileSync(join(root, ".gitignore"), "archives/\ndraft ü.md\n");
		writeFileSync(join(root, "draft ü.md"), broken);
		const ledger = SpecLedger.build(root);
		ledger.refreshFile("draft ü.md", broken);
		expect(ledger.fileList()).toEqual(["README.md"]);
		expect(readFileSync(join(root, "draft ü.md"), "utf8")).toBe(broken);
	});

	it("retains a tracked standalone file even when an ignore pattern matches", () => {
		writeFileSync(join(root, ".gitignore"), "archives/\ndraft.md\n");
		writeFileSync(join(root, "draft.md"), broken);
		execFileSync("git", ["add", "-f", "draft.md"], { cwd: root });
		expect(SpecLedger.build(root).fileList().sort()).toEqual(["README.md", "draft.md"]);
	});

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

	it("keeps out a file created after the build in an ignored directory that has a carve-out", () => {
		// `scratch/*` + `!scratch/README.md`: git cannot collapse the directory, so the build's snapshot names
		// each ignored file one by one and cannot name a file that does not exist yet.
		writeFileSync(join(root, ".gitignore"), "archives/\nscratch/*\n!scratch/README.md\n");
		mkdirSync(join(root, "scratch"));
		writeFileSync(join(root, "scratch", "README.md"), "# Scratch\n");
		execFileSync("git", ["add", "scratch/README.md"], { cwd: root });
		writeFileSync(join(root, "scratch", "old-notes.md"), "# Old\n");
		const ledger = SpecLedger.build(root);
		expect(ledger.fileList().sort()).toEqual(["README.md", "scratch/README.md"]);
		writeFileSync(join(root, "scratch", "CAMPAIGN-new.md"), broken);
		expect(ledger.previewWithFile("scratch/CAMPAIGN-new.md", broken).fileList().sort()).toEqual(["README.md", "scratch/README.md"]);
		ledger.refreshFile("scratch/CAMPAIGN-new.md", broken);
		expect(ledger.fileList().sort()).toEqual(["README.md", "scratch/README.md"]);
	});

	it("admits a file created after the build when no ignore rule matches it", () => {
		const ledger = SpecLedger.build(root);
		writeFileSync(join(root, "GUIDE.md"), "# Guide\n");
		ledger.refreshFile("GUIDE.md", "# Guide\n");
		expect(ledger.fileList().sort()).toEqual(["GUIDE.md", "README.md"]);
	});
});
