// Behavioral companion tests for determinism-replay-driver.ts.
//
// The driver is a thin stdin→pipeline→stdout filter whose `main()` runs at
// module-import time. To get real in-process coverage (a subprocess spawn
// would execute the code but earn zero v8 coverage), we drive it by:
//   1. mocking `./determinism-conformance.js` so the pipeline is deterministic
//      and call-counted (no dependency on the real detector registry),
//   2. replacing `process.stdin` with a synthetic async iterable that yields
//      the corpus bytes, and `process.stdout.write` with a capture,
//   3. importing the module fresh (`vi.resetModules()` + dynamic import) so
//      its top-level `main()` executes against our stubs, then
//   4. awaiting a microtask drain so the async `main()` settles before we
//      assert.
//
// Two import scenarios cover both arms of the top-level
// `main().catch(...)`: a well-formed corpus (success: readStdin loop →
// JSON.parse → map → stdout.write) and malformed JSON (failure:
// console.error → process.exitCode = 1).

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nonNull } from "../lib/non-null.js";

// ---- Mock the conformance pipeline the driver delegates to ---------------
vi.mock("./determinism-conformance.js", () => ({
	// The driver imports these two as values; the third (`CorpusItem`) is a
	// type-only import and needs no runtime export.
	canonicalizeFindings: vi.fn(),
	runInlinePipeline: vi.fn(),
}));

import {
	canonicalizeFindings,
	runInlinePipeline,
} from "./determinism-conformance.js";

const mCanonicalize = vi.mocked(canonicalizeFindings);
const mRunPipeline = vi.mocked(runInlinePipeline);

// ---- process.stdin / stdout / exit harness --------------------------------

function makeStdin(chunks: Array<Buffer | string>): Readable {
	return Readable.from(chunks);
}

const originalStdin = process.stdin;
const originalWrite = process.stdout.write.bind(process.stdout);
const originalExitCode = process.exitCode;
const originalError = console.error.bind(console);

let stdoutCapture: string[];
let exitCodes: number[];
let consoleErrArgs: unknown[][];

/** Install stdin + capture stdout/exit/console.error, run the module's
 *  top-level `main()` by importing it fresh, and drain microtasks so the
 *  async body settles before the caller asserts. */
async function runDriverWith(chunks: Array<Buffer | string>): Promise<void> {
	Object.defineProperty(process, "stdin", {
		value: makeStdin(chunks),
		configurable: true,
	});
	// Capture writes; report success like the real stream.
	process.stdout.write = ((s: string | Uint8Array): boolean => {
		stdoutCapture.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
		return true;
	});
	console.error = (...args: unknown[]): void => {
		consoleErrArgs.push(args);
	};

	vi.resetModules();
	await import("./determinism-replay-driver.js");
	// Let the dynamic import's top-level `main()` promise (and its `.catch`)
	// settle. A short real-timer tick is robust against the await chain in
	// readStdin → main.
	await new Promise((r) => setTimeout(r, 0));
	await Promise.resolve();
	if (process.exitCode !== undefined) exitCodes.push(Number(process.exitCode));
}

beforeEach(() => {
	stdoutCapture = [];
	exitCodes = [];
	process.exitCode = undefined;
	consoleErrArgs = [];
	vi.clearAllMocks();
});

afterEach(() => {
	Object.defineProperty(process, "stdin", {
		value: originalStdin,
		configurable: true,
	});
	process.stdout.write = originalWrite;
	process.exitCode = originalExitCode;
	console.error = originalError;
});

describe("determinism-replay-driver main()", () => {
	it("reads a corpus, canonicalizes each item's pipeline output, and writes JSON to stdout", async () => {
		// One canonical blob per corpus item.
		mRunPipeline.mockImplementation((content) => [
			{ check_id: "c", severity: "warning", line: 1, text: `f:${content}` },
		]);
		mCanonicalize.mockImplementation((findings) => `CANON(${findings.length})`);

		const corpus = [
			{ path: "a.ts", content: "AAA" },
			{ path: "b.ts", content: "BBB" },
		];
		// Split the JSON across two Buffer chunks to exercise the multi-chunk
		// concat in readStdin.
		const json = JSON.stringify(corpus);
		const mid = Math.floor(json.length / 2);
		await runDriverWith([
			Buffer.from(json.slice(0, mid), "utf-8"),
			Buffer.from(json.slice(mid), "utf-8"),
		]);

		// Pipeline ran once per item, with (content, path) in order.
		expect(mRunPipeline).toHaveBeenCalledTimes(2);
		expect(mRunPipeline).toHaveBeenNthCalledWith(1, "AAA", "a.ts");
		expect(mRunPipeline).toHaveBeenNthCalledWith(2, "BBB", "b.ts");
		// canonicalizeFindings wraps each pipeline result.
		expect(mCanonicalize).toHaveBeenCalledTimes(2);

		// stdout received exactly one JSON array of the canonical blobs.
		expect(stdoutCapture).toHaveLength(1);
		expect(JSON.parse(nonNull(stdoutCapture[0]))).toEqual(["CANON(1)", "CANON(1)"]);
		// Success path: no error, no non-zero exit.
		expect(consoleErrArgs).toHaveLength(0);
		expect(exitCodes).toHaveLength(0);
	});

	it("handles a string stdin chunk via the non-Buffer arm of the chunk ternary", async () => {
		mRunPipeline.mockReturnValue([]);
		mCanonicalize.mockReturnValue("EMPTY");

		// A single string chunk forces `Buffer.from(chunk as string)`.
		await runDriverWith([JSON.stringify([{ path: "x.ts", content: "X" }])]);

		expect(mRunPipeline).toHaveBeenCalledExactlyOnceWith("X", "x.ts");
		expect(JSON.parse(nonNull(stdoutCapture[0]))).toEqual(["EMPTY"]);
		expect(exitCodes).toHaveLength(0);
	});

	it("writes an empty array for an empty corpus (map over [] → [])", async () => {
		await runDriverWith([Buffer.from("[]", "utf-8")]);

		expect(mRunPipeline).not.toHaveBeenCalled();
		expect(mCanonicalize).not.toHaveBeenCalled();
		expect(JSON.parse(nonNull(stdoutCapture[0]))).toEqual([]);
		expect(exitCodes).toHaveLength(0);
	});

	it("logs the error and exits non-zero when stdin is not valid JSON (catch arm)", async () => {
		// Malformed JSON makes JSON.parse throw inside main(); the top-level
		// `.catch` should report the error and set a failure exit status.
		await runDriverWith([Buffer.from("{ not json", "utf-8")]);

		expect(consoleErrArgs).toHaveLength(1);
		expect(nonNull(consoleErrArgs[0])[0]).toBeInstanceOf(Error);
		expect(exitCodes).toEqual([1]);
		// Nothing was written to stdout on the failure path.
		expect(stdoutCapture).toHaveLength(0);
	});

	it("N1: logs and exits non-zero when the corpus is valid JSON but not an array (parseCorpus rejects)", async () => {
		// Well-formed JSON, wrong top-level shape: an object instead of an array.
		await runDriverWith([Buffer.from(JSON.stringify({ path: "x.ts", content: "X" }), "utf-8")]);

		expect(mRunPipeline).not.toHaveBeenCalled();
		expect(consoleErrArgs).toHaveLength(1);
		expect(nonNull(consoleErrArgs[0])[0]).toBeInstanceOf(Error);
		expect(exitCodes).toEqual([1]);
		expect(stdoutCapture).toHaveLength(0);
	});

	it("N2: logs and exits non-zero when a corpus item is missing a required field (parseCorpus rejects)", async () => {
		// Array shape is right, but the item lacks `content` (typeof check fails).
		await runDriverWith([Buffer.from(JSON.stringify([{ path: "x.ts" }]), "utf-8")]);

		expect(mRunPipeline).not.toHaveBeenCalled();
		expect(consoleErrArgs).toHaveLength(1);
		expect(nonNull(consoleErrArgs[0])[0]).toBeInstanceOf(Error);
		expect(exitCodes).toEqual([1]);
		expect(stdoutCapture).toHaveLength(0);
	});
});
