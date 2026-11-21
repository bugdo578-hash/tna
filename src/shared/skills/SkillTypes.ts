import type { StatusEffect } from "../TypeDefs";

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
