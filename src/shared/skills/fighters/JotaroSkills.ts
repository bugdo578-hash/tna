import type { SkillDataSlots } from "../SkillTypes";

// Tempos provisórios; trocar pelos markers da animação.
export const JOTARO_SKILL_DATA: SkillDataSlots = [
	// S1 Star finger: 1 hit. Só dano (cegueira é FUTURO).
	{
		id: "jotaro_star_finger",
		name: "Star finger",
		animationName: "star_Finger",
		vfxName: "star_Finger",
		prepareTime: 0.25,
		hits: [{ time: 0.15, damageShare: 1, followUp: false }],
		returnTime: 0.25,
		dodgeReturnTime: 0.12,
	},
	// S2 Platinum Barrage (ORA ORA): 3 hits, damageShare igual (soma 1). Sem Stun.
	{
		id: "jotaro_barragem_estelar",
		name: "Platinum Barrage",
		animationName: "Barragem_estelar",
		vfxName: "Barragem_estelar",
		prepareTime: 0.3,
		hits: [
			{ time: 0.1, damageShare: 1 / 3, followUp: true },
			{ time: 0.25, damageShare: 1 / 3, followUp: true },
			{ time: 0.4, damageShare: 1 / 3, followUp: false },
		],
		returnTime: 0.3,
		dodgeReturnTime: 0.15,
	},
	// S3 Time Stop: 1 hit forte provisório (Time Stop real é FUTURO).
	{
		id: "jotaro_time_stop",
		name: "Time Stop",
		prepareTime: 0.4,
		hits: [{ time: 0.25, damageShare: 1, followUp: false }],
		returnTime: 0.35,
		dodgeReturnTime: 0.15,
	},
];
