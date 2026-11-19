import { expect, it } from "vitest";
import { consumptionPathKey, parseConsumptionEdges } from "./export-consumption.js";

it("retains relative named/type/re-export/default edges with original imported names", () => {
	const edges = parseConsumptionEdges('import value, { type Item as Local, used } from "./target.js";\nexport type { Exported } from "./target.js";', "src/use.ts");
	expect(edges).toEqual([
		{ targetKey: "src/target", symbols: ["Item", "used"], allUsed: false },
		{ targetKey: "src/target", symbols: ["Exported"], allUsed: false },
	]);
});

it("retains namespace/dynamic/CommonJS consumption and excludes unresolved package aliases", () => {
	const edges = parseConsumptionEdges('export * from "./target.js";\nconst loaded = import("./lazy"); require("./common.cjs"); import { X } from "@/outside";', "src/use.ts");
	expect(edges).toEqual([
		{ targetKey: "src/target", symbols: ["*"], allUsed: true },
		{ targetKey: "src/lazy", symbols: [], allUsed: true },
		{ targetKey: "src/common", symbols: [], allUsed: true },
	]);
	expect(consumptionPathKey("src/module/index.ts")).toBe("src/module");
});
