import { describe, expect, it } from "vitest";
import { detectBashCodeFileWrite } from "./pre-checks-bash-write-detect.js";
import {
	detectInPlaceEditorVerbs,
	detectPatchApplyVerb,
	detectSedInPlaceEdit,
	scanInPlaceAndPatchVerbs,
	withUnwrappedCommands,
} from "./pre-checks-bash-write-verbs.js";

const inRootAlways = (): boolean => true;
const inRootNever = (): boolean => false;

describe("detectInPlaceEditorVerbs — positive (must fire)", () => {
	it("P1: perl -pi -e targeting a code file", () => {
		const hit = detectInPlaceEditorVerbs("perl -pi -e 's/foo/bar/' src/a.ts");
		expect(hit?.target).toBe("src/a.ts");
		expect(hit?.mechanism).toContain("perl");
	});

	it("P2: gawk -i inplace targeting a code file", () => {
		const hit = detectInPlaceEditorVerbs("gawk -i inplace '{print}' src/b.py");
		expect(hit?.target).toBe("src/b.py");
	});

	it("P3: ex batch edit targeting a code file", () => {
		const hit = detectInPlaceEditorVerbs("ex -s src/c.go");
		expect(hit?.target).toBe("src/c.go");
	});
});

describe("detectInPlaceEditorVerbs — negative (must not fire)", () => {
	it("N1: perl WITHOUT -i (stdout filter) does not fire", () => {
		expect(detectInPlaceEditorVerbs("perl -pe 's/foo/bar/' src/a.ts")).toBeNull();
	});

	it("N2: awk without the inplace extension does not fire", () => {
		expect(detectInPlaceEditorVerbs("awk '{print $1}' src/a.ts")).toBeNull();
	});

	it("N3: perl -pi on a non-code file does not fire", () => {
		expect(detectInPlaceEditorVerbs("perl -pi -e 's/x/y/' notes.md")).toBeNull();
	});
});

describe("detectPatchApplyVerb — positive (must fire)", () => {
	it("P1: patch with a redirected diff", () => {
		const hit = detectPatchApplyVerb("patch -p1 < change.diff");
		expect(hit?.mechanism).toContain("patch");
	});

	it("P2: git apply", () => {
		const hit = detectPatchApplyVerb("git apply fix.patch");
		expect(hit?.mechanism).toContain("git apply");
	});
});

describe("detectPatchApplyVerb — negative (must not fire)", () => {
	it.each([
		"git apply --cached staged.patch",
		"git apply --reverse --cached staged.patch",
		"git apply staged.patch --cached",
		"git apply --cached --index staged.patch",
	])("permits index-only staging: %s", (command) => {
		expect(detectPatchApplyVerb(command)).toBeNull();
		expect(detectBashCodeFileWrite(command, process.cwd())).toBeNull();
	});

	it.each([
		"git apply --index staged.patch",
		"git apply --stat --apply staged.patch",
		"git apply -- --cached",
		"git apply --directory --cached staged.patch",
		"git apply staged--check.patch",
		"git apply --cached staged.patch; git apply working.patch",
		"git apply --cached staged.patch\ngit apply working.patch",
		"git apply working.patch\ngit apply --cached staged.patch",
	])("retains the worktree gate: %s", (command) => {
		expect(detectPatchApplyVerb(command)?.mechanism).toBe("git apply (diff applier)");
		expect(detectBashCodeFileWrite(command, process.cwd())?.mechanism).toBe("git apply (diff applier)");
	});

	it("N1: git apply --check (read-only) does not fire", () => {
		expect(detectPatchApplyVerb("git apply --check fix.patch")).toBeNull();
	});

	it("N2: git apply --stat (read-only) does not fire", () => {
		expect(detectPatchApplyVerb("git apply --stat fix.patch")).toBeNull();
	});

	it("N3: unrelated git verbs do not fire", () => {
		expect(detectPatchApplyVerb("git status")).toBeNull();
		expect(detectPatchApplyVerb("git log --oneline")).toBeNull();
	});

	it("N4: the word patch inside an argument does not fire", () => {
		expect(detectPatchApplyVerb("rg -n patch src/harness")).toBeNull();
	});
});

describe("detectSedInPlaceEdit — direct surface", () => {
	it("P1: sed -i with a code-file target fires", () => {
		const hit = detectSedInPlaceEdit("sed -i '' 's/a/b/' src/a.ts");
		expect(hit?.target).toBe("src/a.ts");
		expect(hit?.mechanism).toContain("sed -i");
	});

	it("N1: sed without -i (stdout filter) does not fire", () => {
		expect(detectSedInPlaceEdit("sed 's/a/b/' src/a.ts")).toBeNull();
	});
});

describe("withUnwrappedCommands — positive (wrapped verbs become visible)", () => {
	it("P1: xargs sed -i is exposed as a scannable segment", () => {
		const out = withUnwrappedCommands("ls src | xargs sed -i 's/a/b/'");
		expect(out).toContain("; sed -i");
	});

	it("P2: find -exec sed -i {} is exposed", () => {
		const out = withUnwrappedCommands("find src -name '*.ts' -exec sed -i 's/a/b/' {} \\;");
		expect(out).toContain("sed -i 's/a/b/' {}");
	});

	it("P3: timeout-wrapped perl -pi is exposed", () => {
		const out = withUnwrappedCommands("timeout 60 perl -pi -e 's/a/b/' src/a.ts");
		expect(out).toContain("; perl -pi");
	});
});

describe("withUnwrappedCommands — negative (no wrapper → unchanged)", () => {
	it("N1: a plain command is returned unchanged", () => {
		expect(withUnwrappedCommands("npm run build")).toBe("npm run build");
	});
});

describe("detectBashCodeFileWrite end-to-end (orchestrator wiring)", () => {
	const root = process.cwd();

	it("P1: xargs-wrapped sed -i into repo source is detected", () => {
		const hit = detectBashCodeFileWrite("ls src | xargs sed -i 's/a/b/' src/harness/server.ts", root);
		expect(hit?.mechanism).toContain("sed -i");
	});

	it("P2: git apply in the repo is detected", () => {
		const hit = detectBashCodeFileWrite("git apply fix.patch", root);
		expect(hit?.mechanism).toContain("git apply");
	});

	it("P3: plain sed -i into repo source still detected (no regression from the module split)", () => {
		const hit = detectBashCodeFileWrite("sed -i '' 's/a/b/' src/harness/server.ts", root);
		expect(hit?.mechanism).toContain("sed -i");
	});

	it("N1: git apply --check is allowed", () => {
		expect(detectBashCodeFileWrite("git apply --check fix.patch", root)).toBeNull();
	});

	it("N2: sed without -i (stdout) is allowed", () => {
		expect(detectBashCodeFileWrite("sed 's/a/b/' src/harness/server.ts", root)).toBeNull();
	});
});

describe("scanInPlaceAndPatchVerbs — root containment", () => {
	it("P1: in-place hit inside the root is returned", () => {
		const hit = scanInPlaceAndPatchVerbs("perl -pi -e s/a/b/ src/a.ts", inRootAlways, "/repo");
		expect(hit?.target).toBe("src/a.ts");
	});

	it("N1: in-place hit outside the root is suppressed", () => {
		expect(scanInPlaceAndPatchVerbs("perl -pi -e s/a/b/ /tmp/x.ts", inRootNever, "/repo")).toBeNull();
	});

	it("N2: patch verb without a known project root is suppressed", () => {
		expect(scanInPlaceAndPatchVerbs("git apply fix.patch", inRootAlways, undefined)).toBeNull();
	});
});
