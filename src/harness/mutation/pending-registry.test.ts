import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	commitPendingRegistry,
	initPendingRegistryStore,
	overlayHash,
	parseRunnerUrl,
	pendingRegistry,
	resetPendingRegistry,
} from "./pending-registry.js";
import { PENDING_TTL_MS, recordPending, takePending } from "./pending-runs.js";

const NOW = 1_800_000_000_000;

beforeEach(() => {
	resetPendingRegistry();
});

describe("durable pending registry — survives a daemon restart (assume instability)", () => {
	const run = {
		file: "src/f.ts",
		overlayHash: "a".repeat(16),
		jobId: "job-1",
		runnerUrl: "https://runner.example",
		startedAt: NOW,
	};

	it("P1: a committed handle is claimable after a simulated daemon restart", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			// Daemon dies: all in-memory state gone; a fresh daemon re-inits.
			resetPendingRegistry();
			initPendingRegistryStore(root);
			const claimed = takePending(pendingRegistry(NOW + 1000), "src/f.ts", "a".repeat(16), NOW + 1000);
			expect(claimed.map((r) => r.jobId)).toEqual(["job-1"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N1: an EXPIRED handle does not resurrect across the restart", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			resetPendingRegistry();
			initPendingRegistryStore(root);
			const later = NOW + PENDING_TTL_MS + 1;
			const claimed = takePending(pendingRegistry(later), "src/f.ts", "a".repeat(16), later);
			expect(claimed).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N2: without a store root, restart loses the handle (old in-memory semantics)", () => {
		recordPending(pendingRegistry(NOW), run);
		commitPendingRegistry();
		resetPendingRegistry();
		const claimed = takePending(pendingRegistry(NOW + 1000), "src/f.ts", "a".repeat(16), NOW + 1000);
		expect(claimed).toEqual([]);
	});

	it("P2: a corrupt store file degrades to empty, never throws", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			// Corrupt the file, then restart.
			writeFileSync(join(root, ".interlinked", "pending-mutation-runs.json"), "{nope", "utf-8");
			resetPendingRegistry();
			initPendingRegistryStore(root);
			expect(pendingRegistry(NOW + 1).runs).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("P3: publishes private state atomically with mode 0600", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			const directory = join(root, ".interlinked");
			const file = join(directory, "pending-mutation-runs.json");
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("N3: refuses a symlinked registry without overwriting its target", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		const outside = mkdtempSync(join(tmpdir(), "pending-store-target-"));
		const external = join(outside, "external.json");
		try {
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(external, "outside stays unchanged");
			symlinkSync(external, join(root, ".interlinked", "pending-mutation-runs.json"));
			initPendingRegistryStore(root);
			recordPending(pendingRegistry(NOW), run);
			commitPendingRegistry();
			expect(readFileSync(external, "utf8")).toBe("outside stays unchanged");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("N4: rehydrates only exact bounded HTTP(S) rows", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(
				join(root, ".interlinked", "pending-mutation-runs.json"),
				JSON.stringify([
					run,
					{ ...run, runnerUrl: "file:///etc/passwd" },
					{ ...run, overlayHash: "short" },
					{ ...run, startedAt: 1.5 },
					{ ...run, unexpected: true },
				]),
			);
			initPendingRegistryStore(root);
			expect(pendingRegistry(NOW).runs).toEqual([run]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// test-contract: a runnerUrl that fails URL parsing (no scheme, not a URL
	// at all — distinct from N4's protocol-mismatch case) must be skipped
	// WITHOUT aborting the rest of the rehydration pass: the bad row is FIRST
	// so a broken try/catch around `new URL()` would throw out of the whole
	// loop and lose the valid row that follows it too.
	it("N5: skips a row whose runnerUrl fails URL parsing, without losing rows after it", () => {
		const root = mkdtempSync(join(tmpdir(), "pending-store-"));
		try {
			mkdirSync(join(root, ".interlinked"));
			writeFileSync(
				join(root, ".interlinked", "pending-mutation-runs.json"),
				JSON.stringify([{ ...run, runnerUrl: "not a valid url" }, run]),
			);
			initPendingRegistryStore(root);
			expect(pendingRegistry(NOW).runs).toEqual([run]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("initializes against a not-yet-existing root without throwing, and stays put across a repeat init at the same path", () => {
		const missingRoot = join(tmpdir(), `il-missing-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		expect(() => initPendingRegistryStore(missingRoot)).not.toThrow();
		recordPending(pendingRegistry(NOW), run);
		// Re-init at the SAME not-yet-existing path (realpathSync throws ENOENT
		// both times, falling back to resolve()) must not drop the in-memory
		// store — only switching to a DIFFERENT root should do that.
		initPendingRegistryStore(missingRoot);
		expect(takePending(pendingRegistry(NOW), run.file, run.overlayHash, NOW).map((r) => r.jobId)).toEqual([
			run.jobId,
		]);
	});
});

describe("parseRunnerUrl — the length/scheme/credential guard", () => {
	it("rejects a syntactically valid URL that exceeds the max length before ever parsing it", () => {
		// Long enough to exceed MAX_RUNNER_URL_LENGTH while remaining a
		// perfectly valid https URL — if the length guard were removed, `new
		// URL()` would happily accept this and return a non-null URL.
		const tooLong = `https://example.com/${"a".repeat(3000)}`;
		expect(parseRunnerUrl(tooLong)).toBeNull();
	});
});

describe("overlayHash — correlating the two windows by content", () => {
	it("is stable for the same content", () => {
		expect(overlayHash("const a = 1;")).toBe(overlayHash("const a = 1;"));
	});

	it("differs for content that differs by one byte", () => {
		// This is the whole safety property: a later window must not claim results
		// measured against different bytes than the ones that landed.
		expect(overlayHash("const a = 1;")).not.toBe(overlayHash("const a = 2;"));
	});

	it("handles empty content without throwing", () => {
		expect(overlayHash("")).toMatch(/^[0-9a-f]+$/);
	});
});

describe("pendingRegistry — the daemon-scoped store", () => {
	it("returns the same store across calls, so the second window finds the first's work", () => {
		const a = pendingRegistry(NOW);
		recordPending(a, {
			file: "src/a.ts",
			overlayHash: "h",
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		expect(takePending(pendingRegistry(NOW), "src/a.ts", "h", NOW)).toHaveLength(1);
	});

	it("reaps runs older than the TTL rather than growing forever", () => {
		const store = pendingRegistry(NOW);
		recordPending(store, {
			file: "src/a.ts",
			overlayHash: "h",
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		// A daemon runs for days; an abandoned handle must not outlive its usefulness.
		const later = pendingRegistry(NOW + PENDING_TTL_MS + 1);
		expect(takePending(later, "src/a.ts", "h", NOW + PENDING_TTL_MS + 1)).toHaveLength(0);
	});

	it("is emptied by reset, so tests cannot leak state into each other", () => {
		recordPending(pendingRegistry(NOW), {
			file: "src/a.ts",
			overlayHash: "h",
			jobId: "j1",
			runnerUrl: "http://runner/",
			startedAt: NOW,
		});
		resetPendingRegistry();
		expect(takePending(pendingRegistry(NOW), "src/a.ts", "h", NOW)).toHaveLength(0);
	});
});


describe("registry malformed persisted boundaries", () => {
    it.each([null, {}, Array.from({ length: 257 }, () => ({}))])("rejects non-array or oversized store envelopes", contents => {
        const root = mkdtempSync(join(tmpdir(), "pending-shape-"));
        try {
            mkdirSync(join(root, ".interlinked"));
            writeFileSync(join(root, ".interlinked", "pending-mutation-runs.json"), JSON.stringify(contents));
            initPendingRegistryStore(root);
            expect(pendingRegistry(NOW).runs).toEqual([]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("keeps the in-flight handle when reinitialized with the same canonical existing root", () => {
        const root = mkdtempSync(join(tmpdir(), "pending-same-root-"));
        try {
            initPendingRegistryStore(root);
            const store = pendingRegistry(NOW);
            const run = { file: "src/f.ts", overlayHash: overlayHash("code"), jobId: "job", runnerUrl: "https://runner.example", startedAt: NOW };
            recordPending(store, run);
            initPendingRegistryStore(join(root, "."));
            expect(takePending(pendingRegistry(NOW), run.file, run.overlayHash, NOW)).toEqual([run]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it.each([false, "", "https://runner.example/" + "x".repeat(2048)])("rejects non-string, empty or over-budget runner URL inputs", value => {
        expect(parseRunnerUrl(value)).toBeNull();
    });

    it("skips malformed identity strings without dropping the following valid job", () => {
        const root = mkdtempSync(join(tmpdir(), "pending-identities-"));
        const run = { file: "src/f.ts", overlayHash: overlayHash("code"), jobId: "job", runnerUrl: "https://runner.example", startedAt: NOW };
        try {
            mkdirSync(join(root, ".interlinked"));
            writeFileSync(join(root, ".interlinked", "pending-mutation-runs.json"), JSON.stringify([
                { ...run, file: "" }, { ...run, file: "x".repeat(4097) }, { ...run, jobId: false }, { ...run, runnerUrl: "" }, run,
            ]));
            initPendingRegistryStore(root);
            expect(pendingRegistry(NOW).runs).toEqual([run]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});


it("does not carry one repository's in-flight handles into another repository", () => {
    const first = mkdtempSync(join(tmpdir(), "pending-repo-first-"));
    const second = mkdtempSync(join(tmpdir(), "pending-repo-second-"));
    try {
        initPendingRegistryStore(first);
        recordPending(pendingRegistry(NOW), { file: "src/f.ts", overlayHash: overlayHash("code"), jobId: "first-only", runnerUrl: "https://runner.example", startedAt: NOW });
        initPendingRegistryStore(second);
        expect(pendingRegistry(NOW).runs).toEqual([]);
    } finally { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); }
});

it.each(["https://user@runner.example", "https://:password@runner.example"])("rejects runner URLs carrying credentials: %s", url => {
    expect(parseRunnerUrl(url)).toBeNull();
});
