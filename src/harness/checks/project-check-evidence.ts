import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { reportNotMeasured } from "./check-root.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";

export interface ProjectCheckGap { check: string; file: string; reason: string; }
type SourceRead = { content: string } | { error: unknown };
const active = new AsyncLocalStorage<ProjectCheckEvidence>();
const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** One explicitly selected verification invocation. No source or index survives
 * into another invocation, and callers outside this scope keep their live view. */
export class ProjectCheckEvidence {
	readonly root: string;
	private readonly selected = new Set<string>();
	private readonly reads = new Map<string, SourceRead>();
	private readonly gaps = new Map<string, string>();
	private readonly reported = new Set<string>();
	private readonly sourceFiles: string[];
	private readonly sourceGaps = new Set<string>();
	private readonly exclusions = new Map<string, string>();
	private unreadSources: number;

	constructor(root: string, files: readonly string[], private readonly onGap?: (gap: ProjectCheckGap) => void) {
		this.root = resolve(root);
		for (const file of files) {
			const rel = relative(this.root, resolve(this.root, file));
			if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
				this.gaps.set(file, "Selected file lies outside the project root");
				if (SOURCE_EXTENSION.test(file)) this.sourceGaps.add(file);
			} else this.selected.add(rel);
		}
		this.sourceFiles = [...this.selected].filter(file => SOURCE_EXTENSION.test(file));
		this.unreadSources = this.sourceFiles.length;
	}

	listFiles(): string[] { return this.sourceFiles.slice(); }

	/** Excluded sources remain consumption context, with no emitted findings. */
	excludeFile(file: string, reason: string): void {
		this.exclusions.set(relative(this.root, resolve(this.root, file)), reason);
	}

	isExcluded(file: string): boolean {
		return this.exclusions.has(relative(this.root, resolve(this.root, file)));
	}

	readFile(file: string): string {
		const rel = relative(this.root, resolve(this.root, file));
		if (!this.selected.has(rel)) throw new Error(`File is outside selected project evidence: ${file}`);
		let read = this.reads.get(rel);
		if (!read) {
			try { read = { content: readFileSync(resolve(this.root, rel), "utf-8") }; }
			catch (error) {
				read = { error };
				this.gaps.set(rel, error instanceof Error ? error.message : String(error));
				if (SOURCE_EXTENSION.test(rel)) this.sourceGaps.add(rel);
			}
			this.reads.set(rel, read);
			if (SOURCE_EXTENSION.test(rel)) this.unreadSources--;
		}
		if ("error" in read) throw read.error;
		return read.content;
	}

	/** Read the entire selected source population once, retaining failures as gaps. */
	sources(): Array<{ file: string; content: string }> {
		const sources: Array<{ file: string; content: string }> = [];
		for (const file of this.listFiles()) {
			try { sources.push({ file, content: this.readFile(file) }); }
			catch (error) { this.gaps.set(file, error instanceof Error ? error.message : String(error)); }
		}
		return sources;
	}

	get complete(): boolean {
		return this.sourceGaps.size === 0 && this.unreadSources === 0;
	}

	reportGaps(check: string): void {
		for (const [file, reason] of this.gaps) {
			if (!SOURCE_EXTENSION.test(file)) continue;
			this.reportUnavailable(check, file, reason);
		}
	}

	/** Check-specific unknowns do not make otherwise readable source bytes missing. */
	reportUnavailable(check: string, file: string, reason: string): void {
		const key = `${check}\0${file}\0${reason}`;
		if (this.reported.has(key)) return;
		this.reported.add(key);
		if (this.onGap) this.onGap({ check, file, reason });
		else reportNotMeasured(check, `${file}: ${reason}`);
	}
}

export function getProjectCheckEvidence(root?: string): ProjectCheckEvidence | undefined {
	const evidence = active.getStore();
	if (root === undefined) return evidence;
	return evidence?.root === resolve(root) ? evidence : undefined;
}

export function withProjectCheckEvidence<T>(root: string, files: readonly string[], run: () => T, onGap?: (gap: ProjectCheckGap) => void): T {
	return withForegroundCheckScan(() => active.run(new ProjectCheckEvidence(root, files, onGap), run));
}
