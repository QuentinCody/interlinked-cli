// ===========================================
// Check Pipeline Error Types
// ===========================================
// Tagged error types for the harness check pipeline.
// Each error is a discriminated union member (via _tag)
// enabling exhaustive pattern matching with Result.matchError().

import { TaggedError } from "./result.js";

// ===========================================
// File I/O Errors
// ===========================================

/** Failed to read a file from disk */
export class FileReadError extends TaggedError("FileReadError")<{
	message: string;
	path: string;
	cause: unknown;
}>() {}

/** Failed to write a file to disk */
export class FileWriteError extends TaggedError("FileWriteError")<{
	message: string;
	path: string;
	cause: unknown;
}>() {}

// ===========================================
// Parse Errors
// ===========================================

/** Failed to parse JSON content */
export class JsonParseError extends TaggedError("JsonParseError")<{
	message: string;
	input: string;
	cause: unknown;
}>() {}

/** Failed to parse an incoming harness event */
export class EventParseError extends TaggedError("EventParseError")<{
	message: string;
	raw: string;
	cause: unknown;
}>() {}

// ===========================================
// Check Pipeline Errors
// ===========================================

/** A check function failed internally (not a finding — a check malfunction) */
export class CheckError extends TaggedError("CheckError")<{
	message: string;
	check: string;
	file: string;
	cause: unknown;
}>() {}

/** A subprocess-based check (tsc, biome, etc.) failed to execute */
export class SubprocessError extends TaggedError("SubprocessError")<{
	message: string;
	command: string;
	exitCode: number;
	stderr: string;
}>() {}

// ===========================================
// Configuration Errors
// ===========================================

/** Failed to load a configuration file */
export class ConfigLoadError extends TaggedError("ConfigLoadError")<{
	message: string;
	path: string;
	cause: unknown;
}>() {}

