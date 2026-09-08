// Covers loadTypeScript's fully-unavailable path: both `require.resolve` (the
// target project's own typescript) and plain `require("typescript")` (the
// CLI's bundled fallback) fail. This can only happen when the environment
// genuinely lacks the optional `typescript` dependency, so we mock at the
// `node:module` edge (createRequire) rather than uninstalling a real package
// — same technique already used in tsc.integration.test.ts for tsgo
// resolution. Every other module (`node:fs`, `node:path`) stays real.

import { afterEach, describe, expect, it, vi } from "vitest";

const requireResolveMock = vi.fn();
const requireCallMock = vi.fn();

vi.mock("node:module", () => ({
	createRequire: () => {
		const req = (id: string) => requireCallMock(id);
		req.resolve = (id: string, opts?: unknown) => requireResolveMock(id, opts);
		return req;
	},
}));

async function loadFreshOverlay(): Promise<typeof import("./tsc-overlay.js")> {
	vi.resetModules();
	const mod = await import("./tsc-overlay.js");
	// This suite exercises loadTypeScript's in-process fallback chain — pin
	// "in-process" mode so the call doesn't route through the sidecar
	// transport (which would spawn a real child process instead).
	mod._setTscOverlayModeOverrideForTest("in-process");
	return mod;
}

afterEach(() => {
	requireResolveMock.mockReset();
	requireCallMock.mockReset();
	vi.resetModules();
});

describe("runTscOverlay — typescript unresolvable anywhere", () => {
	it("returns [] when both require.resolve(\"typescript\") and require(\"typescript\") throw", async () => {
		requireResolveMock.mockImplementation(() => {
			throw new Error("Cannot find module 'typescript' (project-local)");
		});
		requireCallMock.mockImplementation(() => {
			throw new Error("Cannot find module 'typescript' (bundled)");
		});

		const { runTscOverlay } = await loadFreshOverlay();
		const out = runTscOverlay({
			projectRoot: "/nonexistent/project/root",
			filePath: "/nonexistent/project/root/a.ts",
			content: "export const x = 1;\n",
		});

		expect(out).toEqual([]);
		expect(requireResolveMock).toHaveBeenCalledTimes(1);
		expect(requireResolveMock).toHaveBeenCalledWith("typescript", {
			paths: ["/nonexistent/project/root"],
		});
		expect(requireCallMock).toHaveBeenCalledTimes(1);
		expect(requireCallMock).toHaveBeenCalledWith("typescript");
	});
});
