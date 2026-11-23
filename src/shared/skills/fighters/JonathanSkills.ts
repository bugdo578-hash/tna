import type { SkillDataSlots } from "../SkillTypes";

// Tempos provisórios até existirem animações e markers próprios.
export const JONATHAN_SKILL_DATA: SkillDataSlots = [
	{
		id: "jonathan_luck_and_pluck",
		name: "Luck & Pluck", prepareTime: 0.25,
		hits: [{ time: 0.15, damageShare: 1, followUp: false }],
		returnTime: 0.25, dodgeReturnTime: 0.12, hamonChargeCost: 1,
	},
	{
		id: "jonathan_hamon_breathing",
		name: "Respiração de Hamon", prepareTime: 0.35,
		hits: [{ time: 0.2, damageShare: 0, followUp: false, kind: "self", noDamage: true }],
		returnTime: 0.3, dodgeReturnTime: 0.15, effectTarget: "self", statusEffects: ["Hamon"],
		hamonChargeCost: 0, hamonConfig: { maxCharges: 3, initialCharges: 3, durationSeconds: 30 },
	},
	{
		id: "jonathan_sunlight_yellow_overdrive",
		name: "Sunlight Yellow Overdrive", prepareTime: 0.3,
		hits: [
			{ time: 0.1, damageShare: 1 / 3, followUp: true },
			{ time: 0.25, damageShare: 1 / 3, followUp: true },
			{ time: 0.4, damageShare: 1 / 3, followUp: false },
		],
		returnTime: 0.3, dodgeReturnTime: 0.15, hamonChargeCost: 2,
	},
];
