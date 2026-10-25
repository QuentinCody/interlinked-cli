// Unit pins for write-targets.ts (red team 2026-10-21 round 3, write
// classification). Disk is injected; no real file is read or written.
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTargetPath, patchPayloadOf, resolveTargetPaths, toolWriteTargets } from "./write-targets.js";

const CAPS_REL = ".interlinked/metric-caps.json";
const CAPS = `/repo/${CAPS_REL}`;
const TIGHT = '{\n  "max_cyclomatic": 16\n}\n';
const isCaps = (p: string) => p.endsWith("/.interlinked/metric-caps.json");
const disk = (files: Record<string, string>) => (abs: string) => files[abs] ?? null;
const PATCH = ["*** Begin Patch", "*** Update File: .interlinked/metric-caps.json", "@@", '-  "max_cyclomatic": 16', '+  "max_cyclomatic": 99', "*** End Patch"].join("\n");

describe("resolveTargetPaths — positive (must fire)", () => {
	it("P1: a relative path resolves against the event cwd", () => {
		expect(resolveTargetPaths("metric-caps.json", "/repo/.interlinked")).toEqual([CAPS]);
	});
	it("P2: a home-relative path yields the expanded and the literal reading", () => {
		const out = resolveTargetPaths("~/x/.interlinked/metric-caps.json", "/repo");
		expect(out).toEqual([join(homedir(), "x/.interlinked/metric-caps.json"), "/repo/~/x/.interlinked/metric-caps.json"]);
	});
});

describe("resolveTargetPaths — negative (must not fire)", () => {
	it("N1: an absolute path is only normalized", () => {
		expect(resolveTargetPaths("/repo/./a/../.interlinked/metric-caps.json", "/elsewhere")).toEqual([CAPS]);
		expect(normalizeTargetPath("a\\b//c")).toBe("a/b/c");
	});
});

describe("patchPayloadOf — positive (must fire)", () => {
	it("P3: a shell heredoc apply_patch yields the body and the cd directory", () => {
		const command = `cd .interlinked && apply_patch <<'EOF'\n${PATCH.replace(".interlinked/", "")}\nEOF`;
		const payload = patchPayloadOf("Bash", { command }, "/repo");
		expect(payload?.cwd).toBe("/repo/.interlinked");
		expect(payload?.raw.startsWith("*** Begin Patch")).toBe(true);
		expect(payload?.raw).not.toContain("EOF");
	});
	it("P4: ApplyPatch in PascalCase is the apply_patch tool", () => {
		expect(patchPayloadOf("ApplyPatch", { command: PATCH }, "/repo")?.raw).toBe(PATCH);
	});
});

describe("patchPayloadOf — negative (must not fire)", () => {
	it("N2: a shell command without a patch carries none", () => {
		expect(patchPayloadOf("Bash", { command: "cat .interlinked/metric-caps.json" }, "/repo")).toBeNull();
	});
});

describe("toolWriteTargets — positive (must fire)", () => {
	it("reconstructs per-file replacements sequentially for VS Code multi-replace", () => {
		const input = { replacements: [
			{ filePath: ".interlinked/metric-caps.json", oldString: "16", newString: "20" },
			{ filePath: ".interlinked/metric-caps.json", oldString: "20", newString: "40" },
			{ filePath: "tsconfig.json", oldString: "true", newString: "false" },
		] };
		const targets = toolWriteTargets("multi_replace_string_in_file", input, "/repo", (path) => path.endsWith("tsconfig.json") ? '{"strict":true}' : '{"max_cyclomatic":16}', () => true);
		expect(targets).toEqual([
			{ filePath: "/repo/.interlinked/metric-caps.json", before: '{"max_cyclomatic":16}', proposed: { kind: "decided", contents: ['{"max_cyclomatic":40}'] } },
			{ filePath: "/repo/tsconfig.json", before: '{"strict":true}', proposed: { kind: "decided", contents: ['{"strict":false}'] } },
		]);
	});

	it("P5: OpenCode edit with camelCase fields reconstructs the replace_all result", () => {
		const t = toolWriteTargets("edit", { filePath: CAPS, oldString: "16", newString: "99", replaceAll: true }, "/repo", disk({ [CAPS]: TIGHT }), isCaps);
		expect(t).toEqual([{ filePath: CAPS, before: TIGHT, proposed: { kind: "decided", contents: ['{\n  "max_cyclomatic": 99\n}\n'] } }]);
	});
	it("P6: a shell heredoc patch is applied to the resolved water-line", () => {
		const t = toolWriteTargets("Bash", { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` }, "/repo", disk({ [CAPS]: TIGHT }), isCaps);
		expect(t[0]?.proposed).toEqual({ kind: "decided", contents: ['{\n  "max_cyclomatic": 99\n}\n'] });
	});
});

describe("toolWriteTargets — negative (must not fire)", () => {
	it("N3: a read-only tool naming a water-line yields nothing", () => {
		expect(toolWriteTargets("Read", { file_path: CAPS }, "/repo", disk({ [CAPS]: TIGHT }), isCaps)).toEqual([]);
	});
	it("N4: a writer of an unselected path yields nothing", () => {
		expect(toolWriteTargets("write", { filePath: "/repo/src/a.ts", content: "x" }, "/repo", disk({}), isCaps)).toEqual([]);
	});
});
