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

function isValidRarity(value: unknown): value is Rarity {
	return value === "Comum" || value === "Rara" || value === "Épica" || value === "Lendária";
}

function isValidFighterDefinition(entry: unknown, expectedId: string): entry is FighterDefinition {
	if (!typeIs(entry, "table")) return false;
	const def = entry as Partial<FighterDefinition>;
	if (!typeIs(def.fighterId, "string") || def.fighterId.size() === 0 || def.fighterId !== expectedId) return false;
	if (!typeIs(def.name, "string") || def.name.size() === 0) return false;
	if (!typeIs(def.className, "string") || (CLASS_DATA as Record<string, unknown>)[def.className] === undefined) return false;
	if (!isValidRarity(def.rarity)) return false;
	if (!typeIs(def.skills, "table")) return false;
	const skills = def.skills as unknown as ReadonlyArray<{ readonly hits?: ReadonlyArray<unknown> }>;
	if (skills.size() !== 3) return false;
	for (const index of $range(0, 2)) {
		const slotSkill = skills[index];
		if (!typeIs(slotSkill, "table") || !typeIs(slotSkill.hits, "table") || slotSkill.hits.size() === 0) {
			return false;
		}
	}
	return true;
}

/** Busca uma definição válida em `FIGHTER_DATA`; rejeita strings arbitrárias e entradas malformadas. */
export function findFighterDefinition(fighterId: unknown): FighterDefinition | undefined {
	if (!typeIs(fighterId, "string") || fighterId.size() === 0) return undefined;
	const entry = (FIGHTER_DATA as Record<string, unknown>)[fighterId];
	return isValidFighterDefinition(entry, fighterId) ? entry : undefined;
}

/** Valida se `fighterId` existe com dados válidos em `FIGHTER_DATA`. */
export function isRegisteredFighterId(fighterId: unknown): fighterId is RealFighterId {
	return findFighterDefinition(fighterId) !== undefined;
}

/** Retorna todos os IDs válidos registrados em `FIGHTER_DATA` em ordem determinística. */
export function getRegisteredFighterIds(): readonly RealFighterId[] {
	const ids: RealFighterId[] = [];
	for (const [id, entry] of pairs(FIGHTER_DATA as Record<string, unknown>)) {
		if (typeIs(id, "string") && isValidFighterDefinition(entry, id)) {
			ids.push(id as RealFighterId);
		}
	}
	table.sort(ids);
	return ids;
}

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
	const definition = findFighterDefinition(fighterId);
	assert(definition !== undefined, `fighterId não registrado em FIGHTER_DATA: ${tostring(fighterId)}`);
	return definition;
}
