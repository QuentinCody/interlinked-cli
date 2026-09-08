import { describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { deriveSidecarScriptArgs, OpfLocalScanner, type SidecarLike } from "../opf-local.js";
import type { SidecarStatus } from "../sidecar-manager.js";
import type { ContentScannerConfig, ScannerStatus } from "../types.js";

function makeConfig(): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "local",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
			user_prompt: true,
		},
		local: {
			python_bin: "python3",
			sidecar_script: "/tmp/opf.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: { model: "x", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
	};
}

function makeFakeSidecar(): {
	sidecar: SidecarLike;
	send: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
} {
	const send = vi.fn();
	const shutdown = vi.fn().mockResolvedValue(undefined);
	return { sidecar: { send, shutdown }, send, shutdown };
}

/** A fake sidecar that ALSO exposes `getStatus()` so the scanner seeds its
 *  initial lifecycle snapshot from it (opf-local.ts line 106). */
function makeStatefulFakeSidecar(status: SidecarStatus): {
	sidecar: SidecarLike;
	send: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	getStatus: ReturnType<typeof vi.fn>;
} {
	const send = vi.fn();
	const shutdown = vi.fn().mockResolvedValue(undefined);
	const getStatus = vi.fn<() => SidecarStatus>(() => status);
	return { sidecar: { send, shutdown, getStatus }, send, shutdown, getStatus };
}

describe("OpfLocalScanner", () => {
	it("maps sidecar spans to ScanFindings and stamps the source field", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({
			ok: true,
			spans: [
				{ label: "private_email", start: 7, end: 24, text: "a@b.com" },
				{ label: "secret", start: 30, end: 42, text: "sk_live_abc" },
			],
			redacted_text: "...",
		});

		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const findings = await scanner.scan({ text: "hello a@b.com and sk_live_abc", source: "Write.content" });

		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({
			label: "private_email",
			start: 7,
			end: 24,
			source: "Write.content",
		});
		expect(nonNull(findings[1]).label).toBe("secret");
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: "scan", text: expect.any(String) }));
	});

	it("returns [] on ok:false (fail-open)", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: false, error: "timeout after 1500ms" });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const findings = await scanner.scan({ text: "x", source: "Write.content" });
		expect(findings).toEqual([]);
	});

	it("returns [] when the sidecar response has no spans", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: true });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const findings = await scanner.scan({ text: "x", source: "Bash.command" });
		expect(findings).toEqual([]);
	});

	it("ready() returns true on a successful ping", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: true });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		expect(await scanner.ready()).toBe(true);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ op: "ping", timeout_ms: 45_000 }),
		);
	});

	it("ready() returns false when the sidecar fails to respond", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: false, error: "spawn failed" });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		expect(await scanner.ready()).toBe(false);
	});

	it("forwards the AbortSignal to the sidecar", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: true, spans: [] });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const controller = new AbortController();
		await scanner.scan({ text: "x", source: "s", signal: controller.signal });
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it("shutdown() delegates to the sidecar", async () => {
		const { sidecar, shutdown } = makeFakeSidecar();
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		await scanner.shutdown();
		expect(shutdown).toHaveBeenCalledOnce();
	});

	it("writes a fail-open stderr line whose char count reflects the scanned text", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: false, error: "timeout after 1500ms" });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const writes: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array): boolean => {
				writes.push(String(chunk));
				return true;
			});
		try {
			const findings = await scanner.scan({
				text: "abcdef", // 6 chars
				source: "Bash.command",
			});
			expect(findings).toEqual([]);
		} finally {
			spy.mockRestore();
		}
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("[interlinked:opf-local]");
		expect(writes[0]).toContain("Bash.command");
		expect(writes[0]).toContain("(6 chars)");
		expect(writes[0]).toContain("timeout after 1500ms");
	});

	it("falls back to 'unknown' in the stderr line when the sidecar omits an error", async () => {
		// ok:false with no `error` field exercises the `r.error ?? "unknown"`
		// nullish-coalescing right arm — the sidecar failed but gave no reason.
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({ ok: false });
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const writes: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array): boolean => {
				writes.push(String(chunk));
				return true;
			});
		try {
			const findings = await scanner.scan({ text: "x", source: "Write.content" });
			expect(findings).toEqual([]);
		} finally {
			spy.mockRestore();
		}
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain(": unknown");
	});

	it("propagates the per-span score when the sidecar provides one", async () => {
		const { sidecar, send } = makeFakeSidecar();
		send.mockResolvedValue({
			ok: true,
			spans: [{ label: "private_phone", start: 0, end: 12, text: "555-000-1234", score: 0.91 }],
		});
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const findings = await scanner.scan({ text: "555-000-1234", source: "Bash.command" });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			label: "private_phone",
			score: 0.91,
			source: "Bash.command",
		});
	});
});

describe("OpfLocalScanner — lifecycle / status surface", () => {
	it("starts in 'idle' when constructed with a fake sidecar that has no getStatus()", () => {
		// The bare fake (no getStatus) leaves the constructor's default lastStatus
		// in place; line 106's `sidecar?.getStatus` branch is NOT taken.
		const { sidecar } = makeFakeSidecar();
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const status = scanner.getStatus();
		expect(status.state).toBe("idle");
		expect(typeof status.sinceIso).toBe("string");
		expect(Number.isNaN(Date.parse(status.sinceIso))).toBe(false);
	});

	it("seeds its initial status from an injected sidecar's getStatus() (ready state passes through)", () => {
		const { sidecar } = makeStatefulFakeSidecar({
			state: "ready",
			pid: 4242,
			restartCount: 1,
			detail: "child up",
			sinceIso: "2026-01-01T00:00:00.000Z",
		});
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		expect(scanner.getStatus()).toEqual({
			state: "ready",
			pid: 4242,
			detail: "child up",
			sinceIso: "2026-01-01T00:00:00.000Z",
		});
	});

	it("projects the sidecar's 'spawning' state to the public 'starting' state", () => {
		// projectStatus maps the internal `spawning` enum to the public `starting`
		// (opf-local.ts line 43 cond-expr true arm).
		const { sidecar } = makeStatefulFakeSidecar({
			state: "spawning",
			pid: 9001,
			restartCount: 0,
			sinceIso: "2026-02-02T00:00:00.000Z",
		});
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const status = scanner.getStatus();
		expect(status.state).toBe("starting");
		expect(status.pid).toBe(9001);
		// `restartCount` is internal-only; the projected snapshot must not carry it.
		expect("restartCount" in status).toBe(false);
	});

	it("passes 'dormant' through unchanged (projectStatus else arm)", () => {
		const { sidecar } = makeStatefulFakeSidecar({
			state: "dormant",
			restartCount: 2,
			detail: "idle close",
			sinceIso: "2026-03-03T00:00:00.000Z",
		});
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		expect(scanner.getStatus().state).toBe("dormant");
	});

	it("onStatusChange fires the callback immediately with the current snapshot", () => {
		const { sidecar } = makeStatefulFakeSidecar({
			state: "ready",
			pid: 7,
			restartCount: 0,
			sinceIso: "2026-04-04T00:00:00.000Z",
		});
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const seen: ScannerStatus[] = [];
		scanner.onStatusChange((s) => seen.push(s));
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ state: "ready", pid: 7 });
	});

	it("swallows a throwing listener on the immediate onStatusChange fire", () => {
		const { sidecar } = makeFakeSidecar();
		const scanner = new OpfLocalScanner(makeConfig(), sidecar);
		const good = vi.fn();
		// The first listener throws on the immediate fire; the registration must
		// not propagate it (opf-local.ts line 113-117 catch).
		expect(() =>
			scanner.onStatusChange(() => {
				throw new Error("listener boom");
			}),
		).not.toThrow();
		// A subsequently-registered well-behaved listener still gets its snapshot.
		scanner.onStatusChange(good);
		expect(good).toHaveBeenCalledTimes(1);
		expect(good).toHaveBeenCalledWith(expect.objectContaining({ state: "idle" }));
	});

	it("notifies registered listeners on a real status transition and survives one that throws", async () => {
		// Drive a REAL SidecarManager (pool_size:1) so the constructor's
		// poolOpts.onStatusChange handler is wired to an actual sidecar. No
		// process is spawned: shutdown() flips status idle->disabled via
		// setStatus()/fireStatus() without ever launching the child.
		const cfg = makeConfig();
		cfg.local.pool_size = 1;
		const scanner = new OpfLocalScanner(cfg); // real SidecarManager, no inject

		// Initial snapshot from the manager's constructor fire is "idle".
		expect(scanner.getStatus().state).toBe("idle");

		const transitions: ScannerStatus[] = [];
		const order: string[] = [];
		// First listener throws — its catch (line 91-94) must not stop the second.
		scanner.onStatusChange(() => {
			order.push("thrower");
			throw new Error("transition boom");
		});
		scanner.onStatusChange((s) => {
			order.push("recorder");
			transitions.push(s);
		});

		await scanner.shutdown(); // idle -> disabled, fires poolOpts.onStatusChange

		// The recorder saw both the immediate-fire snapshot AND the disabled one.
		const states = transitions.map((t) => t.state);
		expect(states).toContain("disabled");
		expect(scanner.getStatus().state).toBe("disabled");
		// Both listeners ran on the transition despite the first throwing.
		expect(order.filter((o) => o === "thrower").length).toBeGreaterThanOrEqual(2);
		expect(order.filter((o) => o === "recorder").length).toBeGreaterThanOrEqual(2);
	});

	it("builds a real SidecarPool when pool_size > 1 without spawning a process", () => {
		// Default config omits pool_size -> defaults to 3 -> SidecarPool branch
		// (line 102 right arm, line 103). Pool construction fires an initial
		// aggregate 'idle' through the scanner's poolOpts handler.
		const scanner = new OpfLocalScanner(makeConfig()); // no injected sidecar
		expect(scanner.getStatus().state).toBe("idle");
	});

	it("uses the bare SidecarManager when pool_size is exactly 1", () => {
		// Degenerate pool — line 104 (SidecarManager branch).
		const cfg = makeConfig();
		cfg.local.pool_size = 1;
		const scanner = new OpfLocalScanner(cfg);
		expect(scanner.getStatus().state).toBe("idle");
	});

	it("forwards the viterbi calibration path into the real sidecar script args", async () => {
		// Exercises deriveSidecarScriptArgs from inside the constructor on the
		// real-pool path: a calibrated config must construct without throwing and
		// remain idle (lazy-spawn) until first use.
		const cfg = makeConfig();
		cfg.local.viterbi_calibration_path = "/abs/high-precision.json";
		const scanner = new OpfLocalScanner(cfg);
		expect(scanner.getStatus().state).toBe("idle");
		await scanner.shutdown();
	});
});

describe("deriveSidecarScriptArgs", () => {
	function makeLocal(
		overrides: Partial<ContentScannerConfig["local"]> = {},
	): ContentScannerConfig["local"] {
		return {
			python_bin: "python3",
			sidecar_script: "/tmp/opf.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
			...overrides,
		};
	}

	it("returns undefined when viterbi_calibration_path is unset", () => {
		expect(deriveSidecarScriptArgs(makeLocal())).toBeUndefined();
	});

	it("returns the --viterbi-calibration-path flag pair when path is set", () => {
		const args = deriveSidecarScriptArgs(
			makeLocal({ viterbi_calibration_path: "/abs/preset.json" }),
		);
		expect(args).toEqual(["--viterbi-calibration-path", "/abs/preset.json"]);
	});

	it("returns undefined for an empty-string calibration path (no flag, not an empty arg)", () => {
		// Defensive: an empty string is falsy in TS but would be a valid argv
		// value to OPF and would parse as "load calibration from ''", which
		// would crash the sidecar with a confusing error. The helper must
		// treat empty as 'unset', matching how YAML/JSON merging produces
		// blank fields when a user partially configures the block.
		expect(deriveSidecarScriptArgs(makeLocal({ viterbi_calibration_path: "" }))).toBeUndefined();
	});
});
