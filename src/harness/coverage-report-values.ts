import { wireAbsentOptional, wireNullable, wireNumber, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import type { CoverageMetric, FileCoverageEntry } from "./coverage-ratchet.js";

export interface IstanbulLoc {
	line: number;
	column?: number | null;
}

/** Partial ranges occur in truncated and instrumenter-specific reports. */
export interface IstanbulRange {
	start?: IstanbulLoc;
	end?: IstanbulLoc;
}

interface IstanbulFnMapEntry {
	name?: string;
	decl?: IstanbulRange;
	loc?: IstanbulRange;
	line?: number;
}

export interface IstanbulFileEntry {
	path?: string;
	fnMap?: Record<string, IstanbulFnMapEntry>;
	f?: Record<string, number>;
	statementMap?: Record<string, IstanbulRange | null | undefined>;
	s?: Record<string, number>;
	/** Branch slots are validated individually when deriving the summary. */
	b?: Record<string, unknown>;
}

const isLocation = wireObject<IstanbulLoc>({ line: wireNumber, column: wireAbsentOptional(wireNullable(wireNumber)) });
const isRange = wireObject<IstanbulRange>({ start: wireAbsentOptional(isLocation), end: wireAbsentOptional(isLocation) });
const isFunction = wireObject<IstanbulFnMapEntry>({
	name: wireAbsentOptional(wireString),
	decl: wireAbsentOptional(isRange),
	loc: wireAbsentOptional(isRange),
	line: wireAbsentOptional(wireNumber),
});

export const isIstanbulFileEntry = wireObject<IstanbulFileEntry>({
	path: wireAbsentOptional(wireString),
	fnMap: wireAbsentOptional(wireRecord(isFunction)),
	f: wireAbsentOptional(wireRecord(wireNumber)),
	statementMap: wireAbsentOptional(wireRecord(wireOptional(wireNullable(isRange)))),
	s: wireAbsentOptional(wireRecord(wireNumber)),
	b: wireAbsentOptional(wireRecord(wireUnknown)),
});

const isMetric = wireObject<CoverageMetric>({
	pct: wireNumber,
	covered: wireAbsentOptional(wireNumber),
	total: wireAbsentOptional(wireNumber),
});

export const isFileCoverageEntry = wireObject<FileCoverageEntry>({
	lines: wireAbsentOptional(isMetric),
	statements: wireAbsentOptional(isMetric),
	functions: wireAbsentOptional(isMetric),
	branches: wireAbsentOptional(isMetric),
});
