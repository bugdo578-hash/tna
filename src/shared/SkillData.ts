import type { StatusEffect } from "./TypeDefs";

export interface SkillHitTimeline {
	readonly time: number;
	readonly damageShare: number;
	readonly followUp: boolean;
	/** Efeitos opcionais aplicados especificamente por este hit quando conecta. */
	readonly statusEffects?: readonly StatusEffect[];
}

/** Linha do tempo em segundos definida pelos dados da skill. */
export interface SkillData {
	readonly name?: string;
	readonly prepareTime: number;
	readonly hits: readonly SkillHitTimeline[];
	readonly returnTime: number;
	readonly dodgeReturnTime: number;
	/**
	 * Efeitos de status aplicados pela skill com base no dano real dos hits que conectaram.
	 */
	readonly statusEffects?: readonly StatusEffect[];
}

/** Dados de skill indexados pelos slots S1, S2 e S3. */
export type SkillDataSlots = readonly [SkillData, SkillData, SkillData];

// Tempos provisórios; trocar pelos markers da animação.
export const JOTARO_SKILL_DATA: SkillDataSlots = [
	// S1 star_Finger (Dedinhos): 1 hit. Só dano (cegueira é FUTURO).
	{
		name: "star_Finger",
		prepareTime: 0.25,
		hits: [{ time: 0.15, damageShare: 1, followUp: false }],
		returnTime: 0.25,
		dodgeReturnTime: 0.12,
	},
	// S2 Barragem_estelar (ORA ORA): 5 hits, damageShare igual (soma 1). Sem Stun.
	{
		name: "Barragem_estelar",
		prepareTime: 0.3,
		hits: [
			{ time: 0.08, damageShare: 0.2, followUp: true },
			{ time: 0.18, damageShare: 0.2, followUp: true },
			{ time: 0.28, damageShare: 0.2, followUp: true },
			{ time: 0.38, damageShare: 0.2, followUp: true },
			{ time: 0.48, damageShare: 0.2, followUp: false },
		],
		returnTime: 0.3,
		dodgeReturnTime: 0.15,
	},
	// S3 Time Stop: 1 hit forte provisório (Time Stop real é FUTURO).
	{
		name: "Time Stop",
		prepareTime: 0.4,
		hits: [{ time: 0.25, damageShare: 1, followUp: false }],
		returnTime: 0.35,
		dodgeReturnTime: 0.15,
	},
];

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

