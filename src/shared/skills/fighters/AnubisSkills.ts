import type { SkillDataSlots } from "../SkillTypes";

// Tempos provisórios; trocar pelos markers da animação.
export const ANUBIS_SKILL_DATA: SkillDataSlots = [
	// S1 Anu-Rang: 1 hit.
	{
		id: "anubis_boomerang",
		name: "Anu-Rang",
		animationName: "Boomerang",
		vfxName: "Boomerang",
		prepareTime: 0.25,
		hits: [{ time: 0.15, damageShare: 1, followUp: false }],
		returnTime: 0.25,
		dodgeReturnTime: 0.12,
	},
	// S2 Possessão: 1 hit no alvo (dano espalhado é FUTURO).
	{
		id: "anubis_possessao",
		name: "Possessão",
		prepareTime: 0.3,
		hits: [{ time: 0.2, damageShare: 1, followUp: false }],
		returnTime: 0.3,
		dodgeReturnTime: 0.15,
	},
	// S3 Adaptação: 1 hit provisório (Modo de Adaptação é FUTURO).
	{
		id: "anubis_adaptacao",
		name: "Adaptação",
		prepareTime: 0.4,
		hits: [{ time: 0.25, damageShare: 1, followUp: false }],
		returnTime: 0.35,
		dodgeReturnTime: 0.15,
	},
];
