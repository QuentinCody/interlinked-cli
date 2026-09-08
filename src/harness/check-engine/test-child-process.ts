import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { type Mock, vi } from "vitest";

type FakeChild = ChildProcess & { kill: Mock<() => boolean> };

/** An unspawned Node child gives the fixture the complete process/event API. */
export function makeFakeChildWithoutStreams(pid: number | undefined): FakeChild {
	return Object.assign(new ChildProcess(), { pid, kill: vi.fn(() => true) });
}

/** Pipe events and destruction stay under the test's control. */
export function makeFakeChild(pid: number | undefined): FakeChild & { stdout: PassThrough; stderr: PassThrough } {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	stdout.destroy = vi.fn(() => stdout);
	stderr.destroy = vi.fn(() => stderr);
	return Object.assign(makeFakeChildWithoutStreams(pid), { stdout, stderr });
}
