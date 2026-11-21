// Constantes compartilhadas de identificação, validação, implantação e instâncias de arenas de batalha.

/** @deprecated Legado L1.5: ArenaType deixou de ser requisito de elegibilidade no catálogo universal (L1.6). */
export type ArenaType = "PVE" | "PVP";
export type BattleEncounterKind = "PVE" | "BOSS" | "PVP";

export const ARENA_TEMPLATES_FOLDER_NAME = "ArenaTemplates";
export const ARENA_SLOTS_FOLDER_NAME = "ArenaSlots";
export const ACTIVE_ARENAS_FOLDER_NAME = "ActiveArenas";
export const ARENA_BASES_CONTAINER_NAME = "Arena_bases";
export const ARENA_PLAYER_CAGE_FOLDER_NAME = "Gaiola dos players";
export const ARENA_PLAYER_SPAWN_A_NAME = "PlayerSpawn_A";
export const ARENA_PLAYER_SPAWN_B_NAME = "PlayerSpawn_B";
export const ARENA_PLAYER_SPAWN_NAMES = [ARENA_PLAYER_SPAWN_A_NAME, ARENA_PLAYER_SPAWN_B_NAME] as const;
export const ARENA_PLAYER_CAGE_MAX_DRIFT_STUDS = 8; // provisório: tolerância máxima de contenção física na gaiola

export const ARENA_ID_ATTRIBUTE = "ArenaId";
/** @deprecated Legado L1.5 opcional; não utilizado para filtrar elegibilidade de arenas. */
export const ARENA_TYPE_ATTRIBUTE = "ArenaType";
export const ARENA_INSTANCE_ID_ATTRIBUTE = "ArenaInstanceId";
export const ARENA_SESSION_ID_ATTRIBUTE = "BattleSessionId";
export const ARENA_SLOT_ID_ATTRIBUTE = "ArenaSlotId";

export const ARENA_ID_MAX_LENGTH = 64;
export const ARENA_SLOT_MIN_SEPARATION_STUDS = 0.01;
export const ARENA_CLIENT_REPLICATION_TIMEOUT_SECONDS = 3.0;
export const ARENA_CLIENT_REPLICATION_POLL_SECONDS = 0.05;

export const ARENA_REQUIRED_TEAM_FOLDERS = ["Time A", "Time B"] as const;
export const ARENA_REQUIRED_ANCHOR_NAMES = [
	{
		active: "Current_Fighter_A",
		waiting: ["Waiting_Fighter_A", "Waiting_Fighter_A_2"] as const,
	},
	{
		active: "Current_Fighter_B",
		waiting: ["Waiting_Fighter_B", "Waiting_Fighter_B_2"] as const,
	},
] as const;

export const ARENA_OPTIONAL_CAMERA_NAMES = ["Camera_A", "Camera_B"] as const;
export const ARENA_OPTIONAL_AOE_ANCHOR_NAMES = [
	["AoE_Target_A_1", "AoE_Target_A_2"] as const,
	["AoE_Target_B_1", "AoE_Target_B_2"] as const,
] as const;

/** @deprecated Legado L1.5 opcional: valida categoria física apenas quando fornecida explicitamente. */
export function isValidArenaType(value: unknown): value is ArenaType {
	return value === "PVE" || value === "PVP";
}

/** Valida se o ArenaId é uma string não vazia, sem espaços e composta apenas por caracteres seguros. */
export function isValidArenaId(value: unknown): value is string {
	if (!typeIs(value, "string")) return false;
	const length = value.size();
	if (length === 0 || length > ARENA_ID_MAX_LENGTH) return false;
	const [matched] = string.match(value, "^[A-Za-z0-9_%-]+$");
	return matched !== undefined;
}
