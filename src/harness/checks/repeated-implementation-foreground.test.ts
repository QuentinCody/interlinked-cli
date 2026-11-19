import { afterEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { checkRepeatedImplementation, checkRepeatedImplementationAsync } from "./repeated-implementation.js";

vi.mock("../check-engine/spawn-async.js", async original => {
	const actual = await original<typeof import("../check-engine/spawn-async.js")>();
	return { ...actual, runProcessAsync: vi.fn(actual.runProcessAsync) };
});
afterEach(() => { vi.mocked(runProcessAsync).mockReset(); });

const python = (name: string) => `def ${name}(value):\n    a = load(value)\n    b = copy(a)\n    b.status = "done"\n    b.token = None\n    b.expiry = None\n    return b\n`;
const pair = python("first") + python("second");
const body = '(value) { const a = load(value); const b = copy(a); b.status = "done"; b.token = null; b.expiry = null; return b; }';

it.each(["py", "ts"])("MUST-FIRE: foreground %s retains functions beyond the hook input ceiling", async extension => {
	const content = extension === "py" ? `#${"x".repeat(300 * 1024)}\n${pair}` : `//${"x".repeat(300 * 1024)}\nfunction first${body}\nfunction second${body}`;
	expect(checkRepeatedImplementation(content, `queue.${extension}`)[0]?.text).toContain("256 KiB");
	const findings = await checkRepeatedImplementationAsync(content, `queue.${extension}`);
	expect(findings).toHaveLength(1);
	expect(findings[0]?.text).toContain("2 similar implementations");
});

it("uses complete managed Python capture and no implicit parser deadline", async () => {
	await checkRepeatedImplementationAsync(pair, "queue.py");
	expect(runProcessAsync).toHaveBeenCalledWith("python3", expect.arrayContaining(["-I", "-S", "-B", "-c"]), expect.objectContaining({ input: pair, timeout: 0, maxBufferBytes: null }));
});

it("allows a native parser to finish after the hook's one-second deadline", async () => {
	const native = await vi.importActual<typeof import("../check-engine/spawn-async.js")>("../check-engine/spawn-async.js");
	vi.mocked(runProcessAsync).mockImplementationOnce((command, args, options) => native.runProcessAsync(command, [...args.slice(0, -1), `import time; time.sleep(1.1)\n${args.at(-1)}`], options));
	expect((await checkRepeatedImplementationAsync(pair, "slow.py"))[0]?.text).toContain("2 similar implementations");
});

it("retains native Python parser output beyond the previous four-MiB capture ceiling", async () => {
	const native = await vi.importActual<typeof import("../check-engine/spawn-async.js")>("../check-engine/spawn-async.js");
	let capturedBytes = 0;
	vi.mocked(runProcessAsync).mockImplementationOnce(async (...args) => {
		const result = await native.runProcessAsync(...args);
		capturedBytes = Buffer.byteLength(result.stdout);
		return result;
	});
	const content = Array.from({ length: 5000 }, (_, index) => python(`handler${index}`)).join("\n");
	const findings = await checkRepeatedImplementationAsync(content, "large.py");
	expect(capturedBytes).toBeGreaterThan(4 * 1024 * 1024);
	expect(findings[0]?.text).toContain("5000 similar implementations");
}, 20_000);

it.each([
	{ code: null, stdout: "", stderr: "", killed: false, timedOut: false },
	{ code: 1, stdout: "[]", stderr: "SyntaxError", killed: false, timedOut: false },
	{ code: 0, stdout: "[]", stderr: "", killed: false, timedOut: false, stdoutTruncated: true },
	{ code: 0, stdout: "[]", stderr: "", killed: false, timedOut: false, inputError: "EPIPE" },
	{ code: 0, stdout: "not json", stderr: "", killed: false, timedOut: false },
	{ code: 0, stdout: "[{}]", stderr: "", killed: false, timedOut: false },
])("retains failed or incomplete parser evidence as unavailable %j", async result => {
	vi.mocked(runProcessAsync).mockResolvedValueOnce(result);
	const onUnavailable = vi.fn();
	expect((await checkRepeatedImplementationAsync(pair, "queue.py", { onUnavailable }))[0]?.text).toContain("NOT CHECKED");
	expect(onUnavailable).toHaveBeenCalledOnce();
});

it("MUST-NOT-FIRE: excluded tests and generated sources do not launch Python", async () => {
	expect(await checkRepeatedImplementationAsync(pair, "test_queue.py")).toEqual([]);
	expect(await checkRepeatedImplementationAsync(`# @generated\n${pair}`, "queue.py")).toEqual([]);
	expect(runProcessAsync).not.toHaveBeenCalled();
});

it("cancels the managed parser without accepting partial output as complete", async () => {
	const controller = new AbortController();
	controller.abort();
	const onUnavailable = vi.fn();
	expect((await checkRepeatedImplementationAsync(pair, "queue.py", { signal: controller.signal, onUnavailable }))[0]?.text).toContain("NOT CHECKED");
	expect(onUnavailable).toHaveBeenCalledOnce();
});

it("cancels an active isolated Python parser while its deadline remains unlimited", async () => {
	const native = await vi.importActual<typeof import("../check-engine/spawn-async.js")>("../check-engine/spawn-async.js");
	vi.mocked(runProcessAsync).mockImplementationOnce((command, args, options) => native.runProcessAsync(command, [...args.slice(0, -1), `import time; time.sleep(10)\n${args.at(-1)}`], options));
	const controller = new AbortController(), onUnavailable = vi.fn();
	const pending = checkRepeatedImplementationAsync(pair, "cancelled.py", { signal: controller.signal, onUnavailable });
	const timer = setTimeout(() => controller.abort(), 80);
	try {
		expect((await pending)[0]?.text).toContain("NOT CHECKED");
		expect(onUnavailable).toHaveBeenCalledOnce();
	} finally { clearTimeout(timer); }
});
