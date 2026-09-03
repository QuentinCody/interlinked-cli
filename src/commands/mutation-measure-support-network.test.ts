import { describe, expect, it, vi } from "vitest";

const configuredRunnerEndpointsMock = vi.fn((..._args: any[]): any => ({ endpoints: [] }));
vi.mock("../harness/mutation/measure.js", () => ({
	configuredRunnerEndpoints: (...args: any[]) => configuredRunnerEndpointsMock(...args),
}));

import type { MeasureOneArgs } from "./mutation-measure-support-network.js";
import { networkMeasure, resolveEndpoints } from "./mutation-measure-support-network.js";

const BASE_ARGS: MeasureOneArgs = { file: "src/a.ts", cwd: "/repo", configDir: "/repo/.interlinked" };

describe("resolveEndpoints — positive (must fire)", () => {
	it("P1: prefers runnerUrls over runnerUrl and the configured endpoints", async () => {
		const readDisk = vi.fn((..._a: any[]): any => null);
		const result = await resolveEndpoints(
			{ ...BASE_ARGS, runnerUrls: ["https://a", "https://b"], runnerUrl: "https://c" },
			readDisk,
		);
		expect(result).toEqual({ endpoints: ["https://a", "https://b"] });
		expect(configuredRunnerEndpointsMock).not.toHaveBeenCalled();
	});

	it("P2: falls back to runnerUrl when runnerUrls is absent", async () => {
		const readDisk = vi.fn((..._a: any[]): any => null);
		const result = await resolveEndpoints({ ...BASE_ARGS, runnerUrl: "https://c" }, readDisk);
		expect(result).toEqual({ endpoints: ["https://c"] });
		expect(configuredRunnerEndpointsMock).not.toHaveBeenCalled();
	});

	it("P3: falls back to the repo's configured endpoints when no override is given", async () => {
		configuredRunnerEndpointsMock.mockReturnValueOnce({ endpoints: ["https://configured"], token: "tok" });
		const readDisk = vi.fn((..._a: any[]): any => null);
		const result = await resolveEndpoints(BASE_ARGS, readDisk);
		expect(result).toEqual({ endpoints: ["https://configured"], token: "tok" });
		expect(configuredRunnerEndpointsMock).toHaveBeenCalledWith(BASE_ARGS.cwd, readDisk);
	});
});

describe("resolveEndpoints — negative (must not fire)", () => {
	it("N1: an empty runnerUrls array does not short-circuit — falls through to configured", async () => {
		configuredRunnerEndpointsMock.mockReturnValueOnce({ endpoints: [] });
		const readDisk = vi.fn((..._a: any[]): any => null);
		const result = await resolveEndpoints({ ...BASE_ARGS, runnerUrls: [] }, readDisk);
		expect(result).toEqual({ endpoints: [] });
		expect(configuredRunnerEndpointsMock).toHaveBeenCalled();
	});
});

describe("networkMeasure — positive (must fire)", () => {
	it("P1: forwards required fields and omits optional ones when absent", async () => {
		const measureFile = vi.fn(async (..._a: any[]): Promise<any> => ({ status: "measured" }));
		// SAFETY: the mock only needs to match measureFile's call shape, not its full type.
		const measure = networkMeasure(measureFile as any);
		const outcome = await measure({
			file: "src/a.ts",
			content: "export const x = 1;",
			overlays: [],
			endpoints: ["https://runner"],
		});
		expect(outcome).toEqual({ status: "measured" });
		expect(measureFile).toHaveBeenCalledTimes(1);
		const call = measureFile.mock.calls[0]![0];
		expect(call.file).toBe("src/a.ts");
		expect(call.endpoints).toEqual(["https://runner"]);
		expect("token" in call).toBe(false);
		expect("deadlineMs" in call).toBe(false);
		expect("testScope" in call).toBe(false);
		expect(typeof call.fetchImpl).toBe("function");
	});

	it("P2: forwards token, deadlineMs, and testScope when present", async () => {
		const measureFile = vi.fn(async (..._a: any[]): Promise<any> => ({ status: "measured" }));
		const measure = networkMeasure(measureFile as any);
		await measure({
			file: "src/a.ts",
			content: "export const x = 1;",
			overlays: [],
			endpoints: ["https://runner"],
			token: "secret",
			deadlineMs: 5000,
			testScope: ["src/a.test.ts"],
		});
		const call = measureFile.mock.calls[0]![0];
		expect(call.token).toBe("secret");
		expect(call.deadlineMs).toBe(5000);
		expect(call.testScope).toEqual(["src/a.test.ts"]);
	});
});
