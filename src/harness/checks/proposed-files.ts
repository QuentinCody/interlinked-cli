// ===========================================
// The PROPOSED filesystem view — what a batch is about to make true
// ===========================================
// A registry check is `(content, filePath) => InlineMatch[]`: it sees the one
// file being written and, for anything else, the disk. That is the wrong tree
// for a batch (`interlinked write --batch`, `multi-edit`, `verify-changeset`):
// the batch that CREATES `widget.native.ts` and updates `widget.ts` to import
// it was refused as a self-import, because resolution probed a disk on which
// the sibling did not exist yet (session review r3, 2026-09-05, finding 3 —
// a valid atomic batch in the documented exporter-first order, refused).
//
// The batch gate therefore publishes the whole changeset — creates, updates
// and deletions, config and package files included — as an AMBIENT view for
// the duration of its synchronous evaluation. A context-dependent check asks
// the view first and the disk second; outside a batch the view is empty and
// every question is `undefined`, so the disk decides. The view never invents
// absence: a path the batch does not name is `undefined`, not `false`.
//
// Ambient state is a deliberate trade: the registry contract cannot grow a
// parameter without touching every check, and the gate's evaluation is
// synchronous, so a scoped stack is exact. Nothing here is async-safe and
// nothing here needs to be.

import { dirname, resolve as toAbsolutePath } from "node:path";

/** Absolute path → proposed bytes, or `null` for a deletion. */
export type ProposedFilesView = ReadonlyMap<string, string | null>;

interface Frame {
	readonly files: ReadonlyMap<string, string | null>;
	readonly directories: ReadonlySet<string>;
	/** A suspension frame: lookups stop here and fall through to the disk,
	 *  hiding every view beneath it (`withoutProposedFiles`). */
	readonly suspended?: true;
}

const frames: Frame[] = [];

function key(path: string): string {
	return toAbsolutePath(path);
}

function frameFor(view: ProposedFilesView): Frame {
	const files = new Map<string, string | null>();
	const directories = new Set<string>();
	for (const [path, content] of view) {
		const absolute = key(path);
		files.set(absolute, content);
		if (content === null) continue;
		// Every ancestor of a written file exists once the batch lands.
		let dir = absolute;
		for (;;) {
			const parent = dirname(dir);
			if (parent === dir) break;
			directories.add(parent);
			dir = parent;
		}
	}
	return { files, directories };
}

/** Evaluate `fn` with `view` as the innermost proposed view. Nested views
 *  stack (innermost wins per path); the frame is popped even when `fn` throws. */
export function withProposedFiles<T>(view: ProposedFilesView, fn: () => T): T {
	frames.push(frameFor(view));
	try {
		return fn();
	} finally {
		frames.pop();
	}
}

/** A frame that answers nothing, so every lookup falls through to the disk. */
const SUSPENDED: Frame = { files: new Map(), directories: new Set(), suspended: true };

/** Evaluate `fn` against the DISK alone — the pre-change view — even inside a
 *  batch. The introduced-only gate compares proposed findings (under the
 *  proposed view) with baseline findings (under the disk); a baseline scanned
 *  under the batch's own configuration would call a self-import the batch
 *  creates "pre-existing" (session review r4, finding 2). */
export function withoutProposedFiles<T>(fn: () => T): T {
	frames.push(SUSPENDED);
	try {
		return fn();
	} finally {
		frames.pop();
	}
}

/** The proposed bytes for `path`: a string for a write, `null` for a deletion,
 *  `undefined` when no active batch names it (ask the disk). */
export function proposedFileContent(path: string): string | null | undefined {
	const absolute = key(path);
	for (let index = frames.length - 1; index >= 0; index -= 1) {
		const frame = frames[index];
		if (frame?.suspended === true) return undefined;
		if (frame?.files.has(absolute)) return frame.files.get(absolute);
	}
	return undefined;
}

/** Whether `path` exists as a FILE in the proposed tree, or `undefined` when
 *  no active batch names it. */
export function proposedFileExists(path: string): boolean | undefined {
	const content = proposedFileContent(path);
	return content === undefined ? undefined : content !== null;
}

/** Whether `path` is a directory some proposed write lives under, or
 *  `undefined` when no active batch writes beneath it. A batch can create a
 *  directory (by writing into it) but never proves one absent. */
export function proposedDirectoryExists(path: string): boolean | undefined {
	const absolute = key(path);
	for (let index = frames.length - 1; index >= 0; index -= 1) {
		const frame = frames[index];
		if (frame?.suspended === true) return undefined;
		if (frame?.directories.has(absolute)) return true;
		if (frame?.files.has(absolute)) return false;
	}
	return undefined;
}
