import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverTools } from "./discovery.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ pid: 1, status: 0, signal: null, output: [], stdout: "1.2.3", stderr: "" })) }));
afterEach(() => vi.clearAllMocks());

describe("selected tool discovery", () => {
	it("does not start skipped security tools, including their version commands", () => {
		const tools = discoverTools(process.cwd(), 0, { skipTools: ["semgrep", "gitleaks"] });
		expect(vi.mocked(spawnSync).mock.calls.map(call => call[0])).not.toContain("semgrep");
		expect(vi.mocked(spawnSync).mock.calls.map(call => call[0])).not.toContain("gitleaks");
		expect(tools.filter(tool => ["semgrep", "gitleaks"].includes(tool.id))).toEqual([
			{ id: "semgrep", available: false, reason: "not selected; availability not probed" },
			{ id: "gitleaks", available: false, reason: "not selected; availability not probed" },
		]);
	});
	it("only starts the requested tool and gives skip precedence", () => {
		discoverTools(process.cwd(), 0, { tools: ["gitleaks"] });
		expect(spawnSync).toHaveBeenCalledTimes(1);
		expect(spawnSync).toHaveBeenCalledWith("gitleaks", ["version"], expect.any(Object));
		vi.clearAllMocks();
		discoverTools(process.cwd(), 0, { tools: ["gitleaks"], skipTools: ["gitleaks"] });
		expect(spawnSync).not.toHaveBeenCalled();
	});
});
