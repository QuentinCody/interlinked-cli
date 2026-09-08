import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs before importing config
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { getConfigDir, getDataDir, getHooksDir } from "../config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("getConfigDir", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns INTERLINKED_HOME when set", () => {
		process.env.INTERLINKED_HOME = "/custom/home";
		expect(getConfigDir("/some/cwd")).toBe("/custom/home");
	});

	it("returns {cwd}/.interlinked when no env override", () => {
		delete process.env.INTERLINKED_HOME;
		expect(getConfigDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked"));
	});

	it("trims whitespace from INTERLINKED_HOME", () => {
		process.env.INTERLINKED_HOME = "  /trimmed/home  ";
		expect(getConfigDir("/some/cwd")).toBe("/trimmed/home");
	});

	it("ignores empty INTERLINKED_HOME", () => {
		process.env.INTERLINKED_HOME = "   ";
		expect(getConfigDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked"));
	});
});

describe("getDataDir", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns INTERLINKED_DATA_DIR when set (highest priority)", () => {
		process.env.INTERLINKED_DATA_DIR = "/custom/data";
		process.env.INTERLINKED_HOME = "/custom/home";
		expect(getDataDir("/some/cwd")).toBe("/custom/data");
	});

	it("reads data_dir from config.local.json", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		delete process.env.INTERLINKED_HOME;
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify({ data_dir: "/config/data", future_option: true }));
		expect(getDataDir("/some/cwd")).toBe("/config/data");
	});

	it("falls back to INTERLINKED_HOME when no data_dir in config", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		process.env.INTERLINKED_HOME = "/custom/home";
		mockExistsSync.mockReturnValue(false);
		expect(getDataDir("/some/cwd")).toBe("/custom/home");
	});

	it("falls back to {cwd}/.interlinked when no overrides", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		delete process.env.INTERLINKED_HOME;
		mockExistsSync.mockReturnValue(false);
		expect(getDataDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked"));
	});

	it("handles corrupt config.local.json gracefully", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		delete process.env.INTERLINKED_HOME;
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("not json");
		expect(getDataDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked"));
	});

	// data_dir boundary parsing — replaces `JSON.parse(...) as LocalConfig`,
	// an unchecked cast that let a wrongly-typed data_dir (e.g. a number) flow
	// out of a function typed to return `string`.
	it("P1: reads a well-formed string data_dir", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		delete process.env.INTERLINKED_HOME;
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify({ data_dir: "/config/data" }));
		expect(getDataDir("/some/cwd")).toBe("/config/data");
	});

	it("N1: falls through to default when data_dir is not a string", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		delete process.env.INTERLINKED_HOME;
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify({ data_dir: 42 }));
		expect(getDataDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked"));
	});

	it("N2: falls through to default when config.local.json parses to a non-object (a bare JSON array)", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		delete process.env.INTERLINKED_HOME;
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify(["not", "an", "object"]));
		expect(getDataDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked"));
	});

	it("N3: falls through to default when config.local.json parses to null", () => {
		delete process.env.INTERLINKED_DATA_DIR;
		delete process.env.INTERLINKED_HOME;
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("null");
		expect(getDataDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked"));
	});
});

describe("getHooksDir", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns {configDir}/hooks", () => {
		delete process.env.INTERLINKED_HOME;
		expect(getHooksDir("/some/cwd")).toBe(join("/some/cwd", ".interlinked", "hooks"));
	});

	it("respects INTERLINKED_HOME", () => {
		process.env.INTERLINKED_HOME = "/custom/home";
		expect(getHooksDir("/some/cwd")).toBe(join("/custom/home", "hooks"));
	});
});
