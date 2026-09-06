// Identity tests for the daemon PID verifier. The argv predicates are pure and
// run against literal command strings; `readHarnessProcessIdentity` shells out
// to `ps`, so `node:child_process.execFileSync` is mocked and replayed field by
// field through `stubPs` (never the module under test).
import { describe, expect, it, vi } from "vitest";
import {
	isHarnessDaemonCommandForCwd,
	readHarnessProcessIdentity,
	sameProcessIdentity,
	verifiedProcessIdentities,
} from "./daemon-process-identity.js";

const { execFileSyncMock } = vi.hoisted(() => ({
	execFileSyncMock: vi.fn<(file: string, args: string[]) => string>(),
}));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

type PsField = "comm" | "lstart" | "command";

/** Replay a `ps -p <pid> -o <field>=` transcript; an unstubbed field fails loudly. */
function stubPs(fields: Partial<Record<PsField, string>>): void {
	execFileSyncMock.mockReset();
	execFileSyncMock.mockImplementation((_file, args) => {
		const flag = String(args[3]);
		for (const [field, value] of Object.entries(fields)) {
			if (flag === `${field}=` && value !== undefined) return value;
		}
		throw new Error(`ps: unexpected field ${flag}`);
	});
}

const CWD = "/repo with spaces";
const DAEMON =
	"/opt/node --max-old-space-size=1536 --expose-gc " +
	`/opt/interlinked-cli/dist/harness/server.js --cwd ${CWD} --protocol dual`;

describe("isHarnessDaemonCommandForCwd", () => {
	it("accepts a generated daemon for the exact project, including spaces", () => {
		expect(isHarnessDaemonCommandForCwd({ command: DAEMON, cwd: CWD })).toBe(true);
		expect(
			isHarnessDaemonCommandForCwd({
				command:
					"/opt/node --max-old-space-size=1536 --expose-gc " +
					"/work/renamed-checkout/dist/harness/server.js --cwd /repo --protocol dual",
				cwd: "/repo",
			}),
		).toBe(true);
		expect(
			isHarnessDaemonCommandForCwd({
				command: "/usr/bin/bun /work/dist/harness/server.js --cwd=/repo --protocol=raw",
				cwd: "/repo",
			}),
		).toBe(true);
	});

	it.each([
		["wrong project", DAEMON, "/other"],
		["look-alike entry", DAEMON.replace("server.js", "server.js.bak"), CWD],
		["ordinary node process", `/opt/node /app.js --cwd ${CWD}`, CWD],
		[
			"daemon path mentioned by another script",
			"/usr/bin/node /app/user.js --note /opt/interlinked-cli/dist/harness/server.js --cwd /repo",
			"/repo",
		],
		[
			"eval payload mentioning the daemon",
			"/usr/bin/node -e console.log('/opt/interlinked-cli/dist/harness/server.js') --cwd /repo",
			"/repo",
		],
		[
			"daemon path passed as a second operand to another script",
			"/usr/bin/node /tmp/other.js /repo/dist/harness/server.js --cwd /repo",
			"/repo",
		],
		[
			"daemon argv with an unrecognized trailing option",
			"/usr/bin/node /repo/dist/harness/server.js --cwd /repo --execute-unrelated",
			"/repo",
		],
	])("rejects %s", (_name, command, cwd) => {
		expect(isHarnessDaemonCommandForCwd({ command, cwd })).toBe(false);
	});
});

describe("verified process identity", () => {
	it("keeps only candidates authenticated as this project's daemon", () => {
		const found = verifiedProcessIdentities(CWD, [11, 22], (_cwd, pid) =>
			pid === 11 ? "start-a\nargv" : null,
		);
		expect([...found]).toEqual([[11, "start-a\nargv"]]);
	});

	it("rejects a reused PID when its start identity changes", () => {
		expect(
			sameProcessIdentity({
				cwd: CWD,
				pid: 11,
				expectedIdentity: "start-a\nargv",
				isAlive: () => true,
				identify: () => "start-b\nargv",
			}),
		).toBe(false);
	});
});

describe("readHarnessProcessIdentity", () => {
	it("binds the identity to the process start time and its full argv", () => {
		stubPs({
			comm: "/opt/homebrew/bin/node\n",
			command: DAEMON,
			lstart: "Thu Sep  4 09:15:02 2026",
		});
		expect(readHarnessProcessIdentity(CWD, 4242)).toBe(`Thu Sep  4 09:15:02 2026\n${DAEMON}`);
	});

	it("accepts a bun-hosted daemon", () => {
		const bunDaemon = "/usr/bin/bun /work/dist/harness/server.js --cwd=/repo --protocol=raw";
		stubPs({ comm: "bun", command: bunDaemon, lstart: "Thu Sep  4 09:15:02 2026" });
		expect(readHarnessProcessIdentity("/repo", 4242)).toBe(
			`Thu Sep  4 09:15:02 2026\n${bunDaemon}`,
		);
	});

	it("queries ps for the runtime, the argv and the start time of that one PID", () => {
		stubPs({ comm: "node", command: DAEMON, lstart: "Thu Sep  4 09:15:02 2026" });
		readHarnessProcessIdentity(CWD, 4242);
		expect(execFileSyncMock.mock.calls.map((call) => call[1])).toEqual([
			["-p", "4242", "-o", "comm="],
			["-p", "4242", "-o", "command="],
			["-p", "4242", "-o", "lstart="],
		]);
	});

	it("rejects a process whose runtime is neither node nor bun", () => {
		stubPs({ comm: "/usr/bin/python3", command: DAEMON, lstart: "Thu Sep  4 09:15:02 2026" });
		expect(readHarnessProcessIdentity(CWD, 4242)).toBeNull();
	});

	it("stops after the runtime field when the runtime disqualifies the PID", () => {
		stubPs({ comm: "python3", command: DAEMON, lstart: "Thu Sep  4 09:15:02 2026" });
		readHarnessProcessIdentity(CWD, 4242);
		expect(execFileSyncMock.mock.calls.map((call) => call[1][3])).toEqual(["comm="]);
	});

	it("rejects a node process whose argv is not this project's daemon", () => {
		stubPs({
			comm: "node",
			command: `/opt/node /app.js --cwd ${CWD}`,
			lstart: "Thu Sep  4 09:15:02 2026",
		});
		expect(readHarnessProcessIdentity(CWD, 4242)).toBeNull();
	});

	it("rejects a daemon whose start time ps reports as blank", () => {
		stubPs({ comm: "node", command: DAEMON, lstart: "   \n" });
		expect(readHarnessProcessIdentity(CWD, 4242)).toBeNull();
	});

	it("returns null instead of throwing when ps fails for a vanished PID", () => {
		execFileSyncMock.mockReset();
		execFileSyncMock.mockImplementation(() => {
			throw new Error("ps: no such process");
		});
		expect(readHarnessProcessIdentity(CWD, 999999)).toBeNull();
	});
});
