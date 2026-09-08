import { vi } from "vitest";
import { ProjectGraph } from "../../project-graph.js";
import { RouteMap } from "../../route-map.js";
import { SessionTracker } from "../../session-state.js";

export function makeProjectGraph(overrides: Partial<ProjectGraph> = {}): ProjectGraph {
	const { isInitialized, ...fields } = overrides;
	const graph = Object.assign(new ProjectGraph("/workspace"), fields);
	if (isInitialized !== undefined) vi.spyOn(graph, "isInitialized", "get").mockReturnValue(isInitialized);
	return graph;
}

export function makeRouteMap(overrides: Partial<RouteMap> = {}): RouteMap {
	return Object.assign(new RouteMap("/workspace"), overrides);
}

export function makeSessionTracker(overrides: Partial<SessionTracker> = {}): SessionTracker {
	return Object.assign(new SessionTracker(), overrides);
}
