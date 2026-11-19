import { describe, expect, it } from "vitest";
import { currentProcessCaptureLimit, withProcessCaptureLimit } from "./process-capture-policy.js";

describe("scoped process capture limits", () => {
	it("retains complete capture only in the owning async scope", async () => {
		expect(currentProcessCaptureLimit()).toBeUndefined();
		await withProcessCaptureLimit(null, async () => {
			await Promise.resolve();
			expect(currentProcessCaptureLimit()).toBeNull();
		});
		expect(currentProcessCaptureLimit()).toBeUndefined();
	});

	it("keeps concurrent background scope independent of foreground capture", async () => {
		await Promise.all([
			withProcessCaptureLimit(null, async () => {
				await Promise.resolve();
				expect(currentProcessCaptureLimit()).toBeNull();
			}),
			withProcessCaptureLimit(32, async () => {
				await Promise.resolve();
				expect(currentProcessCaptureLimit()).toBe(32);
			}),
			Promise.resolve().then(() => expect(currentProcessCaptureLimit()).toBeUndefined()),
		]);
	});

	it("restores the outer capture policy after nested failure", async () => {
		await withProcessCaptureLimit(null, async () => {
			await expect(withProcessCaptureLimit(16, async () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
			expect(currentProcessCaptureLimit()).toBeNull();
		});
		expect(currentProcessCaptureLimit()).toBeUndefined();
	});
});
