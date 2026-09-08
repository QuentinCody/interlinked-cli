// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Agent Cohort & File Reservation Types
// ===========================================

// ===========================================
// Agent Cohort
// ===========================================

export type AgentStatus = "active" | "idle" | "lost";

export interface CohortAgent {
	/** Agent name (from MCP registration or config) */
	name: string;
	/** Session ID from the coding agent */
	session_id: string;
	/** Stable spawned-thread id. Present for subagents that expose one. */
	subagent_id?: string;
	/** Which coding agent runtime */
	source: string;
	/** Current status */
	status: AgentStatus;
	/** If subagent, who spawned it */
	parent_agent?: string;
	/** When the agent joined the cohort */
	joined_at: string;
	/** Last event timestamp */
	last_event_at: string;
	/** Files currently reserved by this agent */
	files_reserved: string[];
	/** Current task description (if known from MCP) */
	current_task?: string;
}

// ===========================================
// File Reservations
// ===========================================

export interface ReservationEntry {
	/** File path or glob pattern */
	file_pattern: string;
	/** Agent holding the reservation */
	agent_name: string;
	/** Whether this agent belongs to the local developer or a remote one */
	cohort: "local" | "remote";
	/** When the reservation was created */
	reserved_at: string;
	/** When the reservation expires */
	expires_at: string;
}

export interface ReservationConflict {
	agent_name: string;
	cohort: "local" | "remote";
	expires_at: string;
	human?: string;
}
