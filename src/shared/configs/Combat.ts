// Constantes de combate (ATB, dano, crítico, dodge, efeitos, Root e Hamon).
import type { HamonSlotMultipliers, NumericRange, SkillSlot } from "../TypeDefs";

export const ATB_MIN = 0;
export const ATB_MAX = 10;
export const BASE_ATB_SPEED = 0.588;

export const ATB_COST_RANGES: Readonly<Record<SkillSlot, NumericRange>> = {
	1: { min: 0.75, max: 3.0 },
	2: { min: 4.0, max: 7.0 },
	3: { min: 8.0, max: 10.0 },
};

export const D_SLOT: Readonly<Record<SkillSlot, number>> = {
	1: 0.2145,
	2: 0.1373,
	3: 0.1825,
};

export interface HybridHealConfig {
	readonly healMult: number;
	readonly capHP: number;
}

export const HYBRID_HEAL: Readonly<Record<SkillSlot, HybridHealConfig>> = {
	1: { healMult: 0.55, capHP: 0.2 },
	2: { healMult: 1.1, capHP: 0.3 },
	3: { healMult: 1.4, capHP: 0.45 },
};

export const DODGE_PERCENT_PER_POINT = 1;
export const CRIT_PERCENT_PER_POINT = 1.5;

export const MIN_DAMAGE = 1;
export const MAX_MODIFIER_STACKS = 4;
export const CHARGE_DAMAGE_MULTIPLIER = 1.5; // FUTURO: CARREGANDO (T6)
export const CRIT_MULTIPLIER = 1.5;

export const DUO_PARTNER_DAMAGE_SHARE = 0.34; // FUTURO: dupla Bruford/Tarkus
export const DUO_SURVIVOR_HP_MAX_FACTOR = 1 / 3; // FUTURO: dupla Bruford/Tarkus
export const DUO_SURVIVOR_DAMAGE_MULTIPLIER = 1.1; // FUTURO: dupla Bruford/Tarkus

export const BLEED_DAMAGE_SHARE = 0.25;
export const BURN_DAMAGE_SHARE = 0.2;

export const DOT_DAMAGE_SHARE: Readonly<Record<"Bleed" | "Burn", number>> = {
	Bleed: BLEED_DAMAGE_SHARE,
	Burn: BURN_DAMAGE_SHARE,
};

// Decisão final fechada pelo autor: 3 ticks, 1/s (3s totais).
export const DOT_TICKS = 3;
export const DOT_TICK_INTERVAL_SECONDS = 1;

export const ROOT_DURATION_BY_SLOT: Readonly<Record<SkillSlot, number>> = {
	1: 5,
	2: 8,
	3: 12,
};

export const HAMON_DEFAULT_MAX_CHARGES = 3;
export const HAMON_DEFAULT_DURATION_SECONDS = 30;
export const HAMON_SINGLE_HIT_CHARGE_COST = 1;
export const HAMON_MULTI_HIT_CHARGE_COST = 2;

export const HAMON_DEFAULT_SLOT_MULTIPLIERS: HamonSlotMultipliers = {
	1: 1.3,
	2: 1.8,
	3: 2.2,
};
