// Per-file identity for the in-process tsc overlay's LanguageService host.
//
// Content, not metadata: a write through a shared memory mapping changes a
// file's bytes before any timestamp moves (POSIX permits the delay until
// flush), so mtime, ctime and size are not identity (session review r10,
// finding 1). The host versions a root file by the hash of its content.
//
// One read per file per run serves BOTH the version and the snapshot (session
// review r11): two reads let a write land between them, so the snapshot the
// service kept did not match the identity it remembered — and later runs,
// whose hash matched that identity, never refreshed the snapshot.
import { createHash } from "node:crypto";

/** What one run read for a file: its content (undefined when absent) and the identity of that content. */
export interface DiskRead {
	identity: string;
	content: string | undefined;
}

/** Reads a file's text from disk; undefined when it is not there. */
export type DiskReader = (fileName: string) => string | undefined;

/** The slice of the service context that disk versioning reads and writes. */
export interface DiskVersionState {
	/** Per-file version counter reported to the LanguageService. */
	versions: Map<string, number>;
	/** Last-seen content identity per file across runs. */
	identities: Map<string, string>;
	/** Reads made during the CURRENT run; cleared when a run starts and ends. */
	runReads: Map<string, DiskRead>;
}

/** A file's identity: the hash of its content, or "missing" when it is not on disk. */
export function contentIdentity(content: string | undefined): string {
	if (content === undefined) return "missing";
	// Preserve every compiler-text code unit, including lone surrogates.
	// UTF-8 would replace those with U+FFFD and merge distinct source texts.
	return createHash("sha256").update(content, "utf16le").digest("hex");
}

/** The run's single read of a file — made now if this run has not read it yet. */
export function readOnce(state: DiskVersionState, fileName: string, read: DiskReader): DiskRead {
	const cached = state.runReads.get(fileName);
	if (cached !== undefined) return cached;
	const content = read(fileName);
	const fresh = { identity: contentIdentity(content), content };
	state.runReads.set(fileName, fresh);
	return fresh;
}

/**
 * Version of a file read from disk: bumped when its content changed since the
 * service last saw it. The LanguageService asks for versions more than once
 * while it synchronizes; the run memo keeps each snapshot paired with the
 * identity of its captured text. The next run reads the disk again.
 */
export function diskVersion(state: DiskVersionState, fileName: string, read: DiskReader): string {
	const { identity } = readOnce(state, fileName, read);
	if (identity !== state.identities.get(fileName)) {
		state.identities.set(fileName, identity);
		const v = (state.versions.get(fileName) ?? 0) + 1;
		state.versions.set(fileName, v);
		return String(v);
	}
	return String(state.versions.get(fileName) ?? 0);
}
