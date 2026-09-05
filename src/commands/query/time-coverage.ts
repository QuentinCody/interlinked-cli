import { recordTimestampMs } from "./filters.js";

export interface QueryTimeCoverage {
    oldest_event_ms: number | null; newest_event_ms: number | null;
    undated_records: number; excluded_by_time: number;
}
export function createTimeCoverage(): QueryTimeCoverage {
    return { oldest_event_ms: null, newest_event_ms: null, undated_records: 0, excluded_by_time: 0 };
}
export function observeQueryTime(coverage: QueryTimeCoverage, record: Record<string, unknown>, sinceMs?: number): boolean {
    const time = recordTimestampMs(record);
    if (time === undefined) coverage.undated_records++;
    else {
        coverage.oldest_event_ms = Math.min(coverage.oldest_event_ms ?? time, time);
        coverage.newest_event_ms = Math.max(coverage.newest_event_ms ?? time, time);
    }
    if (sinceMs !== undefined && (time === undefined || time < sinceMs)) {
        coverage.excluded_by_time++;
        return false;
    }
    return true;
}
