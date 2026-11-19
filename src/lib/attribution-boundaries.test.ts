import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn() }));
vi.mock("node:child_process", () => effects);
import { readAttributionTrailer, snapshotPreRun } from "./attribution.js";

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("attribution literal Git argument and path boundaries", () => {
	it("includes untracked-only work and preserves unusual filenames as one argv value", () => {
		const path = ' leading\nname\twith "quotes" and $metadata.ts';
		effects.execFileSync.mockImplementation((_command: string, args: string[]) => {
			if (args[0] === "ls-files") return `${path}\0`;
			if (args.includes("--no-index")) throw Object.assign(new Error("files differ"), { status: 1, stdout: "patch\n".repeat(7) });
			return "";
		});
		expect(snapshotPreRun("/fixture").files).toEqual({ [path]: 7 });
		expect(effects.execFileSync).toHaveBeenCalledWith("git", expect.arrayContaining(["--no-index", "--", "/dev/null", path]), expect.any(Object));
		expect(effects.execSync).not.toHaveBeenCalled();
	});

	it("preserves NUL-delimited tracked names containing tabs and newlines", () => {
		const path = " leading\npath\twith-é.ts";
		effects.execFileSync.mockImplementation((_command: string, args: string[]) => args[0] === "diff" ? `3\t2\t${path}\0` : "");
		expect(snapshotPreRun("/fixture").files).toEqual({ [path]: 5 });
		expect(effects.execSync).not.toHaveBeenCalled();
	});

	it("passes revision text literally with option termination when reading a trailer", () => {
		const ref = "audit.invalid; metadata";
		effects.execFileSync.mockReturnValue("Interlinked-Attribution: 50% agent (2/4 lines)");
		expect(readAttributionTrailer(ref, "/fixture")).toMatchObject({ agent_lines: 2, total_lines: 4 });
		expect(effects.execFileSync).toHaveBeenCalledWith("git", ["log", "-1", "--format=%B", "--end-of-options", ref, "--"], expect.any(Object));
		expect(effects.execSync).not.toHaveBeenCalled();
	});
});
