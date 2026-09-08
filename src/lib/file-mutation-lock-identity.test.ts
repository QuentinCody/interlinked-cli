// Exercises the file-mutation lock identity reader. The first describe block
// calls it directly on THIS machine's real platform (darwin or linux). The
// second block simulates the OTHER kernel's code path (linux /proc/boot_id,
// /proc/stat btime, /proc/<pid>/stat ticks, and `getconf CLK_TCK`) by wrapping
// node:fs `readFileSync` and node:child_process `execFileSync` in spy-through
// mocks (vi.spyOn can't redefine a live ESM named export, so this is the
// established workaround — see cross-file-checks.mutation-kill-w38.test.ts)
// plus a temporary `process.platform` override, reloading the module fresh
// each time via `vi.resetModules()` so its internal boot/clock-ticks caches
// start empty. The third block tests the foreign-pid observation cache
// directly against the real module.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileMutationProcessIdentity } from "./file-mutation-lock-identity.js";

const fsOverride = vi.hoisted((): { impl: ((path: string) => string) | null } => ({
	impl: null,
}));
const execOverride = vi.hoisted((): { impl: ((file: string, args: readonly string[]) => string) | null } => ({
	impl: null,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			if (fsOverride.impl) return fsOverride.impl(String(args[0]));
			return actual.readFileSync(...args);
		},
	};
});

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	return {
		...actual,
		execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
			if (execOverride.impl) {
				const argv = args[1];
				if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
					throw new Error("Expected execFileSync argument vector");
				}
				return execOverride.impl(String(args[0]), argv);
			}
			return actual.execFileSync(...args);
		},
	};
});

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
	setPlatform(originalPlatform);
	fsOverride.impl = null;
	execOverride.impl = null;
});

/** A minimal /proc/<pid>/stat body: field 19 (0-indexed) after the comm
 * close-paren is the process start-tick count the code parses out. */
function fakeLinuxProcStat(startTicks: string): string {
	const fields = [
		"S", "1", "123", "123", "0", "-1", "4194304", "0", "0", "0", "0",
		"100", "200", "0", "0", "20", "0", "4", "0", startTicks,
	];
	return `1 (proc) ${fields.join(" ")}`;
}

describe("file-mutation lock process identity", () => {
	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"reads stable boot and process-start identity on supported platforms",
		() => {
			const first = readFileMutationProcessIdentity(process.pid, 10_000);
			const second = readFileMutationProcessIdentity(process.pid, 20_000);
			expect(first).toBe(second);
			expect(first.bootId).toMatch(new RegExp(`^${process.platform}:`));
			expect(first.processStartId).toMatch(new RegExp(`^${process.platform}:`));
			expect(first.bootStartedAtMs).toBeGreaterThan(0);
		},
	);

	it("fails conservatively when a foreign PID cannot be observed", () => {
		const identity = readFileMutationProcessIdentity(2_147_483_647, 30_000);
		expect(identity.processStartId).toBeNull();
		expect(identity.processStartedAtMs).toBeNull();
	});

	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"derives an epoch for rolling-upgrade PID reuse checks",
		() => {
			const identity = readFileMutationProcessIdentity(process.pid, 40_000);
			expect(identity.processStartedAtMs).toBeGreaterThan(0);
		},
	);
});

describe("simulated Linux /proc + CLK_TCK path", () => {
	it("derives a linux boot identity from boot_id and /proc/stat btime", async () => {
		setPlatform("linux");
		fsOverride.impl = (path) => {
			if (path === "/proc/sys/kernel/random/boot_id") return "abcd-1234-uuid\n";
			if (path === "/proc/stat") return "cpu  0 0 0 0\nbtime 1700000000\n";
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		};
		vi.resetModules();
		const fresh = await import("./file-mutation-lock-identity.js");
		const identity = fresh.readFileMutationProcessIdentity(999_999, 1_000);
		expect(identity.bootId).toBe("linux:abcd-1234-uuid");
		expect(identity.bootStartedAtMs).toBe(1_700_000_000_000);
	});

	it("derives a process-start id and timestamp from /proc ticks and CLK_TCK", async () => {
		setPlatform("linux");
		fsOverride.impl = (path) => {
			if (path === "/proc/sys/kernel/random/boot_id") return "abcd-1234-uuid\n";
			if (path === "/proc/stat") return "cpu  0 0 0 0\nbtime 1700000000\n";
			if (path === "/proc/999998/stat") return fakeLinuxProcStat("456789");
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		};
		execOverride.impl = () => "100\n";
		vi.resetModules();
		const fresh = await import("./file-mutation-lock-identity.js");
		const identity = fresh.readFileMutationProcessIdentity(999_998, 1_000);
		expect(identity.processStartId).toBe("linux:456789");
		expect(identity.processStartedAtMs).toBe(1_700_000_000_000 + (456789 / 100) * 1_000);
	});

	it("keeps a process-start id but leaves the timestamp null when CLK_TCK is unavailable", async () => {
		setPlatform("linux");
		fsOverride.impl = (path) => {
			if (path === "/proc/sys/kernel/random/boot_id") return "abcd-1234-uuid\n";
			if (path === "/proc/stat") return "cpu  0 0 0 0\nbtime 1700000000\n";
			if (path === "/proc/999997/stat") return fakeLinuxProcStat("456789");
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		};
		execOverride.impl = () => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		};
		vi.resetModules();
		const fresh = await import("./file-mutation-lock-identity.js");
		const identity = fresh.readFileMutationProcessIdentity(999_997, 1_000);
		expect(identity.processStartId).toBe("linux:456789");
		expect(identity.processStartedAtMs).toBeNull();
	});
});

describe("foreign-pid identity cache", () => {
	it("returns the same cached identity object for a foreign pid observed twice within the cache window", () => {
		const pid = 2_147_483_646;
		const first = readFileMutationProcessIdentity(pid, 100_000);
		const second = readFileMutationProcessIdentity(pid, 100_500);
		expect(second).toBe(first);
	});
});
