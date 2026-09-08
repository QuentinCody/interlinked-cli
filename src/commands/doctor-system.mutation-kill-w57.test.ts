import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn<(cmd: string, opts?: unknown) => string>();
vi.mock("node:child_process", () => ({
	execSync: (...args: [string, unknown?]) => execSyncMock(...args),
}));

const existsSyncMock = vi.fn<(p: string) => boolean>();
const realpathNativeMock = vi.fn<(p: string) => string>();
vi.mock("node:fs", () => ({
	existsSync: (...args: [string]) => existsSyncMock(...args),
	realpathSync: { native: (...args: [string]) => realpathNativeMock(...args) },
}));

import { checkCliResolvable, observeCliResolution, runSystemChecks } from "./doctor-system.js";

function defaultExecSync(cmd: string): string {
	if (cmd.startsWith("ps ")) return "";
	throw new Error("not found");
}

beforeEach(() => {
	execSyncMock.mockReset();
	existsSyncMock.mockReset();
	realpathNativeMock.mockReset();
	execSyncMock.mockImplementation(defaultExecSync);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("checkCliResolvable — message content (kills 682dbad2, a9f98deea9142a14)", () => {
	it("includes the dangling-link message and repair hint when target is missing", () => {
		const res = checkCliResolvable({ resolvedPath: "/usr/local/bin/interlinked", linkTargetExists: false });
		expect(res.status).toBe("fail");
		expect(res.message).toContain("resolves to /usr/local/bin/interlinked but its target is missing");
		expect(res.message).toContain("dangling link");
		expect(res.message).toContain("ln -sf <interlinked-cli>/dist/index.js ~/.local/bin/interlinked");
	});

	it("includes the repair hint's exact relink command when unresolved on PATH", () => {
		const res = checkCliResolvable({ resolvedPath: null, linkTargetExists: false });
		expect(res.status).toBe("fail");
		expect(res.message).toBe(
			"'interlinked' does not resolve on PATH — shell-outs to the CLI will fail. Repair: (cd <interlinked-cli> && npm run build) then re-link, e.g. ln -sf <interlinked-cli>/dist/index.js ~/.local/bin/interlinked",
		);
	});
});

describe("observeCliResolution — execSync invocation (kills d1c8502, b56381e6, 54684e0c, a2dbfe3b, c5577c93, c420cf69, 506d182f, 5d8582c2, 7730862, 1baa3928, 36f6f843)", () => {
	it("assigns the trimmed resolved path on success and calls exact command/options", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "command -v interlinked") return "/usr/local/bin/interlinked\n";
			throw new Error("unexpected command: " + cmd);
		});
		existsSyncMock.mockReturnValue(true);
		realpathNativeMock.mockReturnValue("/usr/local/bin/interlinked-real");

		const result = observeCliResolution();

		expect(result.resolvedPath).toBe("/usr/local/bin/interlinked");
		expect(result.linkTargetExists).toBe(true);

		expect(execSyncMock).toHaveBeenCalledWith("command -v interlinked", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	});

	it("returns null resolvedPath when execSync throws (command not found)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "command -v interlinked") throw new Error("not found");
			throw new Error("unexpected command: " + cmd);
		});

		const result = observeCliResolution();
		expect(result).toStrictEqual({ resolvedPath: null, linkTargetExists: false });
		expect(existsSyncMock).not.toHaveBeenCalled();
		expect(realpathNativeMock).not.toHaveBeenCalled();
	});

	it("returns null resolvedPath when execSync yields an empty/whitespace-only string", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "command -v interlinked") return "   \n";
			throw new Error("unexpected command: " + cmd);
		});
		const result = observeCliResolution();
		expect(result.resolvedPath).toBeNull();
	});
});

describe("observeCliResolution — fs resolution shape (kills d75a37bb, 8c28b333, 8591296, 55e11235, 62c4026a)", () => {
	it("returns full shape with linkTargetExists=true when target exists", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "command -v interlinked") return "/opt/bin/interlinked";
			throw new Error("unexpected");
		});
		existsSyncMock.mockReturnValue(true);
		realpathNativeMock.mockReturnValue("/opt/real/interlinked");

		const result = observeCliResolution();
		expect(result).toStrictEqual({ resolvedPath: "/opt/bin/interlinked", linkTargetExists: true });
	});

	it("returns full shape with linkTargetExists=false when existsSync says missing", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "command -v interlinked") return "/opt/bin/interlinked";
			throw new Error("unexpected");
		});
		existsSyncMock.mockReturnValue(false);
		realpathNativeMock.mockReturnValue("/opt/real/interlinked");

		const result = observeCliResolution();
		expect(result).toStrictEqual({ resolvedPath: "/opt/bin/interlinked", linkTargetExists: false });
	});

	it("returns full shape with linkTargetExists=false when realpathSync.native throws (dangling link)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd === "command -v interlinked") return "/opt/bin/interlinked";
			throw new Error("unexpected");
		});
		realpathNativeMock.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const result = observeCliResolution();
		expect(result).toStrictEqual({ resolvedPath: "/opt/bin/interlinked", linkTargetExists: false });
	});
});

// The `ps`-parsing cases these replaced drove doctor's PRIVATE orphan scanner,
// which is deleted: it counted every daemon (re-parented to pid 1 by
// definition) and disagreed with `harness status`. The count now arrives from
// the canonical protection-aware sweep, so the surviving contract is how
// runSystemChecks RENDERS what it is given — including "unavailable".
describe("runSystemChecks — orphan row rendering", () => {
	it("renders the supplied count without consulting ps", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not found");
		});

		const results = runSystemChecks(2);
		const orphanResult = results.find((r) => r.name === "Orphan harness daemons");
		expect(orphanResult).toBeDefined();
		expect(orphanResult?.status).toBe("warn");
		expect(orphanResult?.message).toContain("2 orphan daemons found");
	});

	it("reports zero orphans and pass status for a count of 0", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not found");
		});
		const results = runSystemChecks(0);
		const orphanResult = results.find((r) => r.name === "Orphan harness daemons");
		expect(orphanResult?.status).toBe("pass");
		expect(orphanResult?.message).toBe("0 orphans — auto-reaper working as expected");
	});

	it("does not turn an unavailable probe into a clean zero", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not found");
		});
		const orphanResult = runSystemChecks(null).find((r) => r.name === "Orphan harness daemons");
		expect(orphanResult?.status).toBe("warn");
		expect(orphanResult?.message).toContain("could not determine orphan count");
	});
});
