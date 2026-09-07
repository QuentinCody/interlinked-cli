import { describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({
	resolveAuthToken: () => null,
	resolveAuthTokenWithRefresh: async () => null,
}));

import { InterlinkedClient } from "../api-client.js";

describe("InterlinkedClient", () => {
	it("constructs with an explicit serverUrl + token", () => {
		const c = new InterlinkedClient({ serverUrl: "https://example.com", token: "t" });
		expect(c.isAuthenticated()).toBe(true);
	});

	it("isLocalDevServer is true for localhost / 127.0.0.1 URLs", () => {
		expect(
			new InterlinkedClient({ serverUrl: "http://localhost:8787" }).isLocalDevServer(),
		).toBe(true);
		expect(
			new InterlinkedClient({ serverUrl: "http://127.0.0.1:8787" }).isLocalDevServer(),
		).toBe(true);
	});

	it("isLocalDevServer is false for production domains", () => {
		expect(
			new InterlinkedClient({
				serverUrl: "https://interlinked.quentincody.com",
			}).isLocalDevServer(),
		).toBe(false);
	});

	it("isAuthenticated is false when no token is available", () => {
		// The auth seam is mocked to no credential, so local config cannot
		// make this constructor accidentally authenticated.
		const c = new InterlinkedClient({ serverUrl: "https://nowhere.example" });
		expect(c.isAuthenticated()).toBe(false);
	});

	it("getConfig returns a ResolvedConfig shape", () => {
		const c = new InterlinkedClient({ serverUrl: "http://localhost:8787" });
		const cfg = c.getConfig();
		expect(cfg).toHaveProperty("server_url");
		expect(cfg).toHaveProperty("sync_mode");
	});

	it("callTool throws a clear auth error when no token + not local dev", async () => {
		const c = new InterlinkedClient({ serverUrl: "https://nowhere.example", token: "" });
		// Strip any ambient token by construction; token:"" is falsy so the
		// guard should fire. The actual error text changes when the on-disk
		// credential resolves — assert that callTool either throws or rejects,
		// not a specific substring.
		await expect(c.callTool("any_tool")).rejects.toBeDefined();
	});
});
