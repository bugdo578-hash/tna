import type { HamonConfig, StatusEffect } from "../TypeDefs";

export type SkillHitKind = "enemy" | "self";

export interface SkillHitTimeline {
	readonly time: number;
	readonly damageShare: number;
	readonly followUp: boolean;
	/** Marcador genérico para hit sem dano/auto-aplicado (ex.: carga de Hamon, Time Stop, cura, escudo). */
	readonly kind?: SkillHitKind;
	readonly noDamage?: boolean;
	/** Efeitos opcionais aplicados especificamente por este hit quando conecta. */
	readonly statusEffects?: readonly StatusEffect[];
	/** Efeitos opcionais aplicados especificamente por este hit quando o ataque consumiu Hamon. */
	readonly hamonStatusEffects?: readonly StatusEffect[];
	/** Restringe os efeitos Hamon deste hit a vampiros ou alvos em desvantagem. */
	readonly hamonEffectCondition?: "vampireOrClassCounter";
}

/** Linha do tempo em segundos definida pelos dados da skill. */
export interface SkillData {
	/** Identificador estável da habilidade, independente do slot S1/S2/S3 equipado. */
	readonly id?: string;
	readonly name?: string;
	/** Nome opcional do asset de animação vinculado à habilidade (fallback: `id`, `name`, `S{slot}`). */
	readonly animationName?: string;
	/** Nome opcional do asset de VFX vinculado à habilidade (fallback: `id`, `name`, `S{slot}`). */
	readonly vfxName?: string;
	readonly prepareTime: number;
	readonly hits: readonly SkillHitTimeline[];
	readonly returnTime: number;
	readonly dodgeReturnTime: number;
	/** Alvo dos efeitos da skill (`"target"` por padrão, `"self"` para auto-buffs como Hamon). */
	readonly effectTarget?: "target" | "self";
	/** Configuração opcional do buff de Hamon ativado ou sobrescrito por esta skill. */
	readonly hamonConfig?: HamonConfig;
	/** Custo explícito de cargas de Hamon desta habilidade (fallback: 1 para single-hit, 2 para multi-hit). */
	readonly hamonChargeCost?: number;
	/** Multiplicador de dano base específico desta skill quando consome Hamon (sobrescreve o slot do buff). */
	readonly hamonDamageMultiplier?: number;
	/**
	 * Efeitos de status aplicados pela skill com base no dano real dos hits que conectaram.
	 */
	readonly statusEffects?: readonly StatusEffect[];
	/**
	 * Efeitos de status adicionais aplicados pela skill somente quando o ataque consumiu Hamon.
	 */
	readonly hamonStatusEffects?: readonly StatusEffect[];
}

/** Dados de skill indexados pelos slots S1, S2 e S3. */
export type SkillDataSlots = readonly [SkillData, SkillData, SkillData];
