import { ANUBIS_SKILL_DATA } from "./fighters/AnubisSkills";
import { JOTARO_SKILL_DATA } from "./fighters/JotaroSkills";
import { JONATHAN_SKILL_DATA } from "./fighters/JonathanSkills";

export const SKILL_REGISTRY = {
	jotaro: JOTARO_SKILL_DATA,
	anubis: ANUBIS_SKILL_DATA,
	jonathan: JONATHAN_SKILL_DATA,
} as const;

export type RealFighterId = keyof typeof SKILL_REGISTRY;
