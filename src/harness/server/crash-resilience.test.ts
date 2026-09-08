import { nonNull } from "../../lib/non-null.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCrashResilience, logFatalButSurvive } from "./crash-resilience.js";

// Capture the process-listener baseline so each test cleans up only the
// handlers IT registered — never another test's (or the runner's own).
let baseUncaught: unknown[] = [];
let baseRejection: unknown[] = [];

beforeEach(() => {
	baseUncaught = process.listeners("uncaughtException");
	baseRejection = process.listeners("unhandledRejection");
});

afterEach(() => {
	for (const l of process.listeners("uncaughtException")) {
		if (!baseUncaught.includes(l)) process.removeListener("uncaughtException", l);
	}
	for (const l of process.listeners("unhandledRejection")) {
		if (!baseRejection.includes(l)) process.removeListener("unhandledRejection", l);
	}
	vi.restoreAllMocks();
});

describe("logFatalButSurvive", () => {
	it("logs an Error's stack with the daemon-log prefix and never throws", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => logFatalButSurvive("uncaughtException", new Error("boom"))).not.toThrow();
		expect(spy).toHaveBeenCalledTimes(1);
		const msg = String(spy.mock.calls[0]?.[0]);
		expect(msg).toContain("[interlinked-harness]");
		expect(msg).toContain("kept the daemon alive");
		expect(msg).toContain("boom");
	});

	it("stringifies a non-Error reason (unhandledRejection with a plain value)", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		logFatalButSurvive("unhandledRejection", "string reason");
		expect(String(spy.mock.calls[0]?.[0])).toContain("string reason");
	});

	it("swallows a failure in the logger itself (last-resort catch) without throwing", () => {
		vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("stderr is gone");
		});
		// The catch branch must absorb the logging failure — re-throwing here would
		// exit the daemon the handler exists to keep alive.
		expect(() => logFatalButSurvive("uncaughtException", new Error("x"))).not.toThrow();
	});
});

describe("installCrashResilience", () => {
	it("registers exactly one uncaughtException and one unhandledRejection listener", () => {
		const ue = process.listenerCount("uncaughtException");
		const ur = process.listenerCount("unhandledRejection");
		installCrashResilience();
		expect(process.listenerCount("uncaughtException")).toBe(ue + 1);
		expect(process.listenerCount("unhandledRejection")).toBe(ur + 1);
	});

	it("the registered handler logs and does NOT re-throw (daemon stays alive)", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		installCrashResilience();
		const handler = nonNull(process.listeners("uncaughtException").at(-1));
		expect(() => handler(new Error("async-throw"), "uncaughtException")).not.toThrow();
		expect(String(spy.mock.calls[0]?.[0])).toContain("async-throw");
	});
});

// ---------------------------------------------------------------------------
// Pre-listen vs post-listen (audit F1). Surviving an error is right only for a
// daemon that is SERVING; before the bind it produces a pid-holding process
// that answers nothing.
// ---------------------------------------------------------------------------
describe("installCrashResilience — startup-phase routing", () => {
	// P1: an error BEFORE startup completes goes to the terminal handler.
	it("routes a pre-listen uncaughtException to onStartupFailure instead of surviving", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const onStartupFailure = vi.fn();
		installCrashResilience({ isStartupComplete: () => false, onStartupFailure });
		nonNull(process.listeners("uncaughtException").at(-1))(new Error("bind blew up"), "uncaughtException");
		expect(onStartupFailure).toHaveBeenCalledWith("uncaughtException", expect.any(Error));
		// The survive path must NOT also run — it is what kept the zombie alive.
		expect(spy).not.toHaveBeenCalled();
	});

	// P2: the same routing applies to an unhandled rejection (the shape a
	// rejected top-level await actually produces).
	it("routes a pre-listen unhandledRejection to onStartupFailure", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const onStartupFailure = vi.fn();
		installCrashResilience({ isStartupComplete: () => false, onStartupFailure });
		nonNull(process.listeners("unhandledRejection").at(-1))("rejected", Promise.resolve());
		expect(onStartupFailure).toHaveBeenCalledWith("unhandledRejection", "rejected");
	});

	// N1: once the daemon is serving, continuity wins again.
	it("survives a POST-listen error even with a startup handler installed", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const onStartupFailure = vi.fn();
		installCrashResilience({ isStartupComplete: () => true, onStartupFailure });
		expect(() => nonNull(process.listeners("uncaughtException").at(-1))(new Error("late boom"), "uncaughtException")).not.toThrow();
		expect(onStartupFailure).not.toHaveBeenCalled();
		expect(String(spy.mock.calls[0]?.[0])).toContain("kept the daemon alive");
	});

	// N2: a predicate with no handler (and a handler with no predicate) must
	// keep the historic behavior rather than half-arming the fail-fast path.
	it("survives when only one of the two options is supplied", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		installCrashResilience({ isStartupComplete: () => false });
		expect(() => nonNull(process.listeners("uncaughtException").at(-1))(new Error("no handler"), "uncaughtException")).not.toThrow();
		const onStartupFailure = vi.fn();
		installCrashResilience({ onStartupFailure });
		nonNull(process.listeners("uncaughtException").at(-1))(new Error("no predicate"), "uncaughtException");
		expect(onStartupFailure).not.toHaveBeenCalled();
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy).toHaveBeenNthCalledWith(1, expect.stringContaining("no handler"));
		expect(spy).toHaveBeenNthCalledWith(2, expect.stringContaining("no predicate"));
	});
});
