// ===========================================
// sync-transport — behavioral coverage
// ===========================================
// `sendOneBatch` is the public entry; everything else in this module is a
// private helper reached only through it. Network and disk are mocked:
//   - global fetch (the HTTP round-trip)
//   - `./sync-bounded.js` readBoundedResponseBody (kept real for its other
//     exports via importActual; only the body reader is stubbed so the test
//     can hand back an arbitrary receipt body without a real ReadableStream)
//   - `../lib/local-activity.js` appendSyncError (would otherwise write to
//     `.interlinked/sync-errors.jsonl` on disk)

import { afterEach, describe, expect, it, vi } from "vitest";

const mockAppendSyncError = vi.fn();
vi.mock("../lib/local-activity.js", () => ({
	appendSyncError: (entry: unknown) => mockAppendSyncError(entry),
}));

const mockReadBoundedResponseBody = vi.fn();
vi.mock("./sync-bounded.js", async (importActual) => {
	const actual = await importActual<typeof import("./sync-bounded.js")>();
	return {
		...actual,
		readBoundedResponseBody: (response: unknown) => mockReadBoundedResponseBody(response),
	};
});

import { sendOneBatch } from "./sync-transport.js";

describe("sendOneBatch", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		mockAppendSyncError.mockReset();
		mockReadBoundedResponseBody.mockReset();
	});

	it("records an invalid-receipt failure when the response body is not JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);
		// Deliberately malformed: valid HTTP 200, body text that JSON.parse
		// rejects — the ONLY path that produces the "was not JSON" reason.
		mockReadBoundedResponseBody.mockResolvedValue({ ok: true, text: "not-json{" });

		const outcome = await sendOneBatch({
			serverUrl: "https://example.test",
			headers: {},
			body: { events: [] },
			batchNum: 1,
			batchSize: 5,
			mode: "json",
		});

		expect(outcome).toEqual({
			kind: "done",
			accepted: 0,
			skipped: 0,
			errors: 5,
			batchesSent: 0,
			retriesUsed: 0,
		});
		expect(mockAppendSyncError).toHaveBeenCalledTimes(1);
		const [entry] = mockAppendSyncError.mock.calls[0] as [{ message: string }];
		expect(entry.message).toContain("response was not JSON:");
	});
});
