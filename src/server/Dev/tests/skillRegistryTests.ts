import { getFighterDefinition } from "../../../shared/FighterData";
import {
	ANUBIS_SKILL_DATA,
	JOTARO_SKILL_DATA,
	type SkillData,
	type SkillDataSlots,
	type SkillHitTimeline,
} from "../../../shared/SkillData";
import { ANUBIS_SKILL_DATA as ANUBIS_MODULE_SKILLS } from "../../../shared/skills/fighters/AnubisSkills";
import { JOTARO_SKILL_DATA as JOTARO_MODULE_SKILLS } from "../../../shared/skills/fighters/JotaroSkills";
import { SKILL_REGISTRY } from "../../../shared/skills/SkillRegistry";
import { assertInvariant } from "./testHelpers";

function assertSkill(
	skill: SkillData,
	name: string,
	[prepareTime, returnTime, dodgeReturnTime]: readonly [
		prepareTime: number,
		returnTime: number,
		dodgeReturnTime: number,
	],
	expectedHits: readonly SkillHitTimeline[],
): void {
	assertInvariant(skill.name === name, `skill esperada ${name}, recebida ${skill.name}`);
	assertInvariant(skill.prepareTime === prepareTime, `${name}: prepareTime`);
	assertInvariant(skill.returnTime === returnTime, `${name}: returnTime`);
	assertInvariant(skill.dodgeReturnTime === dodgeReturnTime, `${name}: dodgeReturnTime`);
	assertInvariant(skill.statusEffects === undefined, `${name}: statusEffects da skill`);
	assertInvariant(skill.hits.size() === expectedHits.size(), `${name}: quantidade de hits`);

	let damageShareSum = 0;
	for (const [index, hit] of ipairs(skill.hits)) {
		const expected = expectedHits[index - 1];
		assertInvariant(hit.time === expected.time, `${name}: tempo do hit ${index}`);
		assertInvariant(hit.damageShare === expected.damageShare, `${name}: damageShare do hit ${index}`);
		assertInvariant(hit.followUp === expected.followUp, `${name}: followUp do hit ${index}`);
		assertInvariant(hit.statusEffects === undefined, `${name}: statusEffects do hit ${index}`);
		damageShareSum += hit.damageShare;
	}
	assertInvariant(math.abs(damageShareSum - 1) < 1e-6, `${name}: soma de damageShare`);
}

export function validateSkillRegistry(): void {
	const jotaro: SkillDataSlots = SKILL_REGISTRY.jotaro;
	const anubis: SkillDataSlots = SKILL_REGISTRY.anubis;
	assertInvariant(jotaro === JOTARO_SKILL_DATA && jotaro === JOTARO_MODULE_SKILLS, "tupla compartilhada de Jotaro");
	assertInvariant(anubis === ANUBIS_SKILL_DATA && anubis === ANUBIS_MODULE_SKILLS, "tupla compartilhada de Anubis");
	assertInvariant(getFighterDefinition("jotaro").skills === jotaro, "FighterData deve usar as skills de Jotaro");
	assertInvariant(getFighterDefinition("anubis").skills === anubis, "FighterData deve usar as skills de Anubis");
	assertInvariant(jotaro.size() === 3 && anubis.size() === 3, "cada personagem deve ter os slots S1, S2 e S3");

	// Valores de SkillData.ts na master antes da extração (0d5a772).
	assertSkill(jotaro[0], "star_Finger", [0.25, 0.25, 0.12], [
		{ time: 0.15, damageShare: 1, followUp: false },
	]);
	assertSkill(jotaro[1], "Barragem_estelar", [0.3, 0.3, 0.15], [
		{ time: 0.08, damageShare: 0.2, followUp: true },
		{ time: 0.18, damageShare: 0.2, followUp: true },
		{ time: 0.28, damageShare: 0.2, followUp: true },
		{ time: 0.38, damageShare: 0.2, followUp: true },
		{ time: 0.48, damageShare: 0.2, followUp: false },
	]);
	assertSkill(jotaro[2], "Time Stop", [0.4, 0.35, 0.15], [
		{ time: 0.25, damageShare: 1, followUp: false },
	]);
	assertSkill(anubis[0], "Boomerang", [0.25, 0.25, 0.12], [
		{ time: 0.15, damageShare: 1, followUp: false },
	]);
	assertSkill(anubis[1], "Possessão", [0.3, 0.3, 0.15], [
		{ time: 0.2, damageShare: 1, followUp: false },
	]);
	assertSkill(anubis[2], "Adaptação", [0.4, 0.35, 0.15], [
		{ time: 0.25, damageShare: 1, followUp: false },
	]);
}
