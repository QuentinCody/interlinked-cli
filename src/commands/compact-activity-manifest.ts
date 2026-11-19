import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../lib/config.js";
import { isJsonObject } from "../lib/json-types.js";
import {
	type ArchiveManifest,
	type ArchiveSegment,
	parseArchiveSegment,
	readArchiveManifestJson,
} from "./compact-plain.js";
import { nextArchiveSegmentSeq, rebuildArchiveManifestFromDisk } from "./compact-plain-state.js";

export function activityArchiveDir(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "archive");
}

export function activityManifestPath(cwd: string = process.cwd()): string {
	return join(activityArchiveDir(cwd), "manifest.json");
}

function parseActivityManifest(value: unknown): ArchiveManifest | null {
	if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.segments)) return null;
	const segments: ArchiveSegment[] = [];
	for (const entry of value.segments) {
		const segment = parseArchiveSegment(entry, "activity");
		if (!segment) return null;
		segments.push(segment);
	}
	return { version: 1, segments };
}

/** Pick one sequence beyond both indexed and self-describing on-disk rows. */
export function nextActivitySegmentSeq(
	cwd: string,
	manifest: ArchiveManifest,
): number {
	return nextArchiveSegmentSeq("activity", cwd, manifest);
}

export function loadArchiveManifest(cwd: string = process.cwd()): ArchiveManifest {
	const path = activityManifestPath(cwd);
	if (!existsSync(path)) return { version: 1, segments: [] };
	try {
		return parseActivityManifest(readArchiveManifestJson(path)) ?? { version: 1, segments: [] };
	} catch {
		return { version: 1, segments: [] };
	}
}

/** Rebuild only for the writer; audit verification still fails closed. */
export function loadOrRebuildArchiveManifest(
	cwd: string = process.cwd(),
): ArchiveManifest {
	if (!existsSync(activityManifestPath(cwd))) return { version: 1, segments: [] };
	const loaded = loadArchiveManifest(cwd);
	if (loaded.segments.length > 0) return loaded;
	return rebuildArchiveManifestFromDisk("activity", cwd);
}
