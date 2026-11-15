import {
	DOT_DAMAGE_SHARE,
	DOT_TICKS,
	DOT_TICK_INTERVAL_SECONDS,
	ROOT_DURATION_BY_SLOT,
} from "../../shared/Config";
import { clamp } from "../../shared/MathUtils";
import type { SkillDataSlots } from "../../shared/SkillData";
import type {
	ClassName,
	FighterLocalState,
	SkillSlot,
	SkillSlots,
	StatBlock,
	StatusEffect,
} from "../../shared/TypeDefs";

export type DotStatusEffect = "Bleed" | "Burn";

export interface ActiveDotEffect {
	readonly source?: Fighter;
	readonly kind: "dot";
	readonly effect: DotStatusEffect;
	readonly slot: SkillSlot;
	readonly totalDamage: number;
	readonly damagePerTick: number;
	readonly duration: number;
	remainingTicks: number;
	elapsed: number;
	accumulatedDamage: number;
}

export interface ActiveRootEffect {
	readonly kind: "root";
	readonly effect: "Root";
	readonly slot: SkillSlot;
	readonly duration: number;
	remainingDuration: number;
}

export type ActiveStatusEffect = ActiveDotEffect | ActiveRootEffect;

export interface AppliedStatusEffectResult {
	readonly activeEffect: ActiveStatusEffect;
	readonly renewed: boolean;
}

export interface FighterConfig {
	readonly itemUuid?: string;
	readonly fighterId?: string;
	readonly hp: number;
	readonly hpMax: number;
	readonly stats: StatBlock;
	readonly level: number;
	readonly className: ClassName;
	readonly slots: SkillSlots;
	readonly skillData: SkillDataSlots;
	readonly currentAtbSpeed: number;
}

export class Fighter {
	readonly itemUuid?: string;
	hp: number;
	localState: FighterLocalState = "NORMAL";
	readonly fighterId: string;
	readonly hpMax: number;
	readonly stats: StatBlock;
	readonly level: number;
	readonly className: ClassName;
	readonly slots: SkillSlots;
	readonly skillData: SkillDataSlots;
	readonly currentAtbSpeed: number;
	/**
	 * Efeitos de status ativos neste lutador.
	 * Indexados por `StatusEffect` para garantir que nunca empilhem (nova aplicação renova).
	 * Permanecem no lutador ao trocar para o banco.
	 */
	readonly statusEffects = new Map<StatusEffect, ActiveStatusEffect>();

	public constructor(config: FighterConfig) {
		this.itemUuid = config.itemUuid;
		this.fighterId = config.fighterId ?? config.className.lower();
		this.hpMax = config.hpMax;
		this.hp = clamp(config.hp, 0, config.hpMax);
		this.stats = config.stats;
		this.level = config.level;
		this.className = config.className;
		this.slots = config.slots;
		this.skillData = config.skillData;
		this.currentAtbSpeed = config.currentAtbSpeed;
	}

	public takeDamage(amount: number): number {
		const damage = math.min(math.max(amount, 0), this.hp);
		this.hp -= damage;
		if (!this.isAlive()) this.localState = "CAIDO";
		return damage;
	}

	public heal(amount: number): number {
		const healing = math.min(math.max(amount, 0), this.hpMax - this.hp);
		this.hp += healing;
		return healing;
	}

	public isAlive(): boolean {
		return this.hp > 0;
	}

	public hasStatusEffect(effect: StatusEffect): boolean {
		return this.statusEffects.has(effect);
	}

	public isRooted(): boolean {
		return this.statusEffects.has("Root");
	}

	/**
	 * Aplica ou renova um efeito de status neste lutador.
	 * - Não empilha: sobrescreve a instância anterior do mesmo `StatusEffect`, renovando a duração.
	 * - DoT (`Bleed`/`Burn`) exige `realDamage > 0` (hits esquivados não geram DoT).
	 */
	public applyStatusEffect(
		effect: StatusEffect,
		slot: SkillSlot,
		realDamage: number,
		source?: Fighter,
	): AppliedStatusEffectResult | undefined {
		if (!this.isAlive() || this.localState === "CAIDO") return undefined;
		const renewed = this.statusEffects.has(effect);

		if (effect === "Root") {
			const duration = ROOT_DURATION_BY_SLOT[slot];
			const activeEffect: ActiveRootEffect = {
				kind: "root",
				effect: "Root",
				slot,
				duration,
				remainingDuration: duration,
			};
			this.statusEffects.set("Root", activeEffect);
			return { activeEffect, renewed };
		}

		if (realDamage <= 0) return undefined;
		const totalDamage = realDamage * DOT_DAMAGE_SHARE[effect];
		const damagePerTick = totalDamage / DOT_TICKS;
		const duration = DOT_TICKS * DOT_TICK_INTERVAL_SECONDS;
		const activeEffect: ActiveDotEffect = {
			source,
			kind: "dot",
			effect,
			slot,
			totalDamage,
			damagePerTick,
			duration,
			remainingTicks: DOT_TICKS,
			elapsed: 0,
			accumulatedDamage: 0,
		};
		this.statusEffects.set(effect, activeEffect);
		return { activeEffect, renewed };
	}
}
