// Constantes de progressão de nível, alocação de pontos e XP.
import type { StatPointPair } from "../TypeDefs";

export const MIN_LEVEL = 1;
export const S3_UNLOCK_LEVEL = 5;
export const MAX_LEVEL = 30;
export const STAT_POINTS_PER_LEVEL = 2;
export const TOTAL_STAT_POINTS = (MAX_LEVEL - MIN_LEVEL) * STAT_POINTS_PER_LEVEL;

export const HP_PER_POINT = 12.5;
export const ATK_PER_POINT = 1;
export const DODGE_POINTS_PER_POINT = 1;
export const CRIT_POINTS_PER_POINT = 1;

export const MAX_STAT_POINT_DIFFERENCE = 5;
export const STAT_POINT_PAIRS: readonly [StatPointPair, StatPointPair] = [
	["atk", "dodge"],
	["hp", "crit"],
];

export const TEAM_XP_SLOTS = 3;
export const XP_SHARE_SOLO = 1.0;
export const XP_SHARE_DUO_EACH = 0.5;
export const XP_SHARE_TRIO_TOP_DAMAGE = 0.5;
export const XP_SHARE_TRIO_OTHER = 0.25;
export const XP_LEVEL_PER_LEVEL = 100;
export const XP_BATTLE_BASE = 75;
export const XP_BATTLE_PER_ENEMY_LEVEL = 15;
export const XP_MIN_AWARD = 1;

export interface XpLevelDiffTier {
	readonly maxDiff: number;
	readonly multiplier: number;
}

export const XP_LEVEL_DIFF_TIERS: readonly XpLevelDiffTier[] = [
	{ maxDiff: -3, multiplier: 1.35 },
	{ maxDiff: -1, multiplier: 1.15 },
	{ maxDiff: 1, multiplier: 1 },
	{ maxDiff: 3, multiplier: 0.6 },
	{ maxDiff: 5, multiplier: 0.25 },
];

export const XP_LEVEL_DIFF_FLOOR_MULTIPLIER = 0.05;
