import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

export interface FakeSidecarChild extends ChildProcess {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	killed: boolean;
	respond(value: Record<string, unknown>): void;
	exit(code: number | null): void;
	readonly killSignals: string[];
	readonly stdinLines: string[];
}

/** An unspawned ChildProcess with controllable protocol streams and lifecycle. */
export function makeSidecarChild(pid?: number): FakeSidecarChild {
	const stdinLines: string[] = [];
	const killSignals: string[] = [];
	const child: FakeSidecarChild = Object.assign(new ChildProcess(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
		stdinLines, killSignals,
		...(pid === undefined ? {} : { pid }),
		respond(value: Record<string, unknown>): void {
			child.stdout.write(`${JSON.stringify(value)}\n`);
		},
		exit(code: number | null): void {
			child.killed = true;
			child.emit("exit", code);
		},
		kill(signal?: NodeJS.Signals | number): boolean {
			killSignals.push(signal === undefined ? "" : String(signal));
			if (!child.killed) {
				child.killed = true;
				queueMicrotask(() => child.emit("exit", null));
			}
			return true;
		},
	});
	child.stdin.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString().split("\n")) {
			if (line.length > 0) stdinLines.push(line);
		}
	});
	return child;
}
