import { ANUBIS_SKILL_DATA } from "./fighters/AnubisSkills";
import { JOTARO_SKILL_DATA } from "./fighters/JotaroSkills";
import { JONATHAN_SKILL_DATA } from "./fighters/JonathanSkills";
import type { SkillData, SkillDataSlots } from "./SkillTypes";

export const SKILL_REGISTRY = {
	jotaro: JOTARO_SKILL_DATA,
	anubis: ANUBIS_SKILL_DATA,
	jonathan: JONATHAN_SKILL_DATA,
} as const;

export type RealFighterId = keyof typeof SKILL_REGISTRY;

const SKILL_BY_ID = new Map<string, SkillData>();
for (const [, slots] of pairs(SKILL_REGISTRY as Record<string, SkillDataSlots>)) {
	for (const skill of slots) {
		if (skill.id !== undefined && skill.id.size() > 0) {
			SKILL_BY_ID.set(skill.id.lower(), skill);
		}
	}
}

/** Retorna a identidade estável da habilidade, independente do slot S1/S2/S3 equipado. */
export function getSkillId(skill: SkillData, fallback = ""): string {
	return skill.id ?? skill.name ?? fallback;
}

/** Busca uma definição de habilidade registrada pelo seu `id` estável. */
export function findSkillById(skillId: unknown): SkillData | undefined {
	if (!typeIs(skillId, "string") || skillId.size() === 0) return undefined;
	return SKILL_BY_ID.get(skillId.lower());
}

/** Resolve os 3 slots equipados a partir de `skillIds` opcionais, preservando fallback posicional. */
export function resolveEquippedSkillSlots(
	fallbackSlots: SkillDataSlots,
	equippedSkillIds?: readonly [string, string, string],
): SkillDataSlots {
	if (equippedSkillIds === undefined) return fallbackSlots;
	return [
		findSkillById(equippedSkillIds[0]) ?? fallbackSlots[0],
		findSkillById(equippedSkillIds[1]) ?? fallbackSlots[1],
		findSkillById(equippedSkillIds[2]) ?? fallbackSlots[2],
	];
}
