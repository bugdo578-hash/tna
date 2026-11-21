import type { SkillDataSlots } from "../SkillTypes";

// Tempos provisórios; trocar pelos markers da animação.
export const ANUBIS_SKILL_DATA: SkillDataSlots = [
	// S1 Boomerang: 1 hit.
	{
		name: "Boomerang",
		prepareTime: 0.25,
		hits: [{ time: 0.15, damageShare: 1, followUp: false }],
		returnTime: 0.25,
		dodgeReturnTime: 0.12,
	},
	// S2 Possessão: 1 hit no alvo (dano espalhado é FUTURO).
	{
		name: "Possessão",
		prepareTime: 0.3,
		hits: [{ time: 0.2, damageShare: 1, followUp: false }],
		returnTime: 0.3,
		dodgeReturnTime: 0.15,
	},
	// S3 Adaptação: 1 hit provisório (Modo de Adaptação é FUTURO).
	{
		name: "Adaptação",
		prepareTime: 0.4,
		hits: [{ time: 0.25, damageShare: 1, followUp: false }],
		returnTime: 0.35,
		dodgeReturnTime: 0.15,
	},
];
