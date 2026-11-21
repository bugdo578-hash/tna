import { CLASS_DATA } from "./ClassData";
import { clamp, lerp } from "./MathUtils";
import { SKILL_REGISTRY, type RealFighterId } from "./skills/SkillRegistry";
import type { SkillDataSlots } from "./skills/SkillTypes";
import type { ClassName, NumericRange, Rarity, StatBlock } from "./TypeDefs";

export type { RealFighterId } from "./skills/SkillRegistry";

export interface FighterDefinition {
	readonly fighterId: RealFighterId;
	readonly name: string;
	readonly className: ClassName;
	readonly rarity: Rarity;
	readonly skills: SkillDataSlots;
}

export const FIGHTER_DATA: Readonly<Record<RealFighterId, FighterDefinition>> = {
	jotaro: {
		fighterId: "jotaro",
		name: "Jotaro",
		className: "Fury",
		rarity: "Lendária",
		skills: SKILL_REGISTRY.jotaro,
	},
	anubis: {
		fighterId: "anubis",
		name: "Anubis",
		className: "Menace",
		rarity: "Épica",
		skills: SKILL_REGISTRY.anubis,
	},
};

function rollStatInRange(range: NumericRange, rng: () => number): number {
	const t = clamp(rng(), 0, 1);
	return clamp(math.round(lerp(range.min, range.max, t)), range.min, range.max);
}

/** Rola `baseStats` dentro dos ranges canônicos da classe em `ClassData.ts`. */
export function rollClassBaseStats(className: ClassName, rng: () => number): StatBlock {
	const ranges = CLASS_DATA[className].baseStats;
	return {
		hp: rollStatInRange(ranges.hp, rng),
		atk: rollStatInRange(ranges.atk, rng),
		dodge: rollStatInRange(ranges.dodge, rng),
		crit: rollStatInRange(ranges.crit, rng),
	};
}

export function getFighterDefinition(fighterId: RealFighterId): FighterDefinition {
	return FIGHTER_DATA[fighterId];
}
