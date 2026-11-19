import { afterEach, expect, it, vi } from "vitest";
import { withPacketDeliveryTimeout } from "./packet-delivery-timeout.js";

afterEach(() => vi.useRealTimers());

it("returns the value or fallback and releases its timer after an early settlement", async () => {
	vi.useFakeTimers();
	expect(await withPacketDeliveryTimeout(Promise.resolve("ready"), 100, "fallback")).toBe("ready");
	expect(await withPacketDeliveryTimeout(Promise.reject(new Error("failed")), 100, "fallback")).toBe("fallback");
	expect(vi.getTimerCount()).toBe(0);
});

it("returns the fallback at the deadline and handles a later rejection", async () => {
	vi.useFakeTimers();
	let reject!: (reason: Error) => void;
	const slow = new Promise<string>((_, fail) => { reject = fail; });
	const result = withPacketDeliveryTimeout(slow, 100, "fallback");
	await vi.advanceTimersByTimeAsync(100);
	expect(await result).toBe("fallback");
	reject(new Error("late"));
	await Promise.resolve();
	expect(vi.getTimerCount()).toBe(0);
});
