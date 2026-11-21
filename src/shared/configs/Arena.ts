// Constantes compartilhadas de identificação, validação e instâncias de arenas de batalha.

export type ArenaType = "PVE" | "PVP";
export type BattleEncounterKind = "PVE" | "BOSS" | "PVP";

export const ARENA_TEMPLATES_FOLDER_NAME = "ArenaTemplates";
export const ACTIVE_ARENAS_FOLDER_NAME = "ActiveArenas";
export const ARENA_BASES_CONTAINER_NAME = "Arena_bases";

export const ARENA_ID_ATTRIBUTE = "ArenaId";
export const ARENA_TYPE_ATTRIBUTE = "ArenaType";
export const ARENA_INSTANCE_ID_ATTRIBUTE = "ArenaInstanceId";
export const ARENA_SESSION_ID_ATTRIBUTE = "BattleSessionId";

export const ARENA_ID_MAX_LENGTH = 64;
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

/** Mapeia o tipo de encontro (PVE, BOSS ou PVP) para a categoria física da arena ("PVE" ou "PVP"). */
export function resolveRequiredArenaType(kind: BattleEncounterKind): ArenaType {
	return kind === "PVP" ? "PVP" : "PVE";
}

/** Valida se o valor representa uma categoria física permitida ("PVE" ou "PVP"). */
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
