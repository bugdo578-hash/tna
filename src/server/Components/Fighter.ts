import {
	DOT_DAMAGE_SHARE,
	DOT_TICKS,
	DOT_TICK_INTERVAL_SECONDS,
	HAMON_DEFAULT_DURATION_SECONDS,
	HAMON_DEFAULT_MAX_CHARGES,
	HAMON_DEFAULT_SLOT_MULTIPLIERS,
	ROOT_DURATION_BY_SLOT,
} from "../../shared/Config";
import { clamp } from "../../shared/MathUtils";
import type { SkillDataSlots } from "../../shared/SkillData";
import type {
	ClassName,
	FighterLocalState,
	HamonConfig,
	HamonSlotMultipliers,
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

export interface ActiveHamonEffect {
	readonly kind: "hamon";
	readonly effect: "Hamon";
	readonly slot: SkillSlot;
	readonly duration: number;
	readonly maxCharges: number;
	readonly slotMultipliers: HamonSlotMultipliers;
	charges: number;
	remainingDuration: number;
}

export type ActiveStatusEffect = ActiveDotEffect | ActiveRootEffect | ActiveHamonEffect;

export interface AppliedStatusEffectResult {
	readonly activeEffect: ActiveStatusEffect;
	readonly renewed: boolean;
}

export interface AppliedHamonResult {
	readonly activeEffect: ActiveHamonEffect;
	readonly renewed: boolean;
}

export interface FighterConfig {
	readonly isVampire?: boolean;
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
	readonly hamonConfig?: HamonConfig;
}

export class Fighter {
	readonly isVampire: boolean;
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
	readonly hamonConfig?: HamonConfig;
	/**
	 * Efeitos de status ativos neste lutador.
	 * Indexados por `StatusEffect` para garantir que nunca empilhem (nova aplicação renova).
	 * Permanecem no lutador ao trocar para o banco.
	 */
	readonly statusEffects = new Map<StatusEffect, ActiveStatusEffect>();

	public constructor(config: FighterConfig) {
		this.isVampire = config.isVampire === true;
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
		this.hamonConfig = config.hamonConfig;
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

	public getHamonEffect(): ActiveHamonEffect | undefined {
		const active = this.statusEffects.get("Hamon");
		return active?.kind === "hamon" ? active : undefined;
	}

	public hasHamon(): boolean {
		const hamon = this.getHamonEffect();
		return hamon !== undefined && hamon.charges > 0 && hamon.remainingDuration > 0;
	}

	public getHamonCharges(): number {
		return this.getHamonEffect()?.charges ?? 0;
	}

	public getHamonMaxCharges(): number {
		return this.getHamonEffect()?.maxCharges ?? 0;
	}

	public getHamonRemainingDuration(): number {
		return this.getHamonEffect()?.remainingDuration ?? 0;
	}

	public canConsumeHamon(requiredCharges: number): boolean {
		if (!this.isAlive() || this.localState === "CAIDO" || requiredCharges <= 0) return false;
		const hamon = this.getHamonEffect();
		return hamon !== undefined && hamon.remainingDuration > 0 && hamon.charges >= requiredCharges;
	}

	public getHamonSlotMultiplier(slot: SkillSlot): number {
		const hamon = this.getHamonEffect();
		if (hamon === undefined || hamon.charges <= 0 || hamon.remainingDuration <= 0) return 1;
		return hamon.slotMultipliers[slot] ?? HAMON_DEFAULT_SLOT_MULTIPLIERS[slot];
	}

	public consumeHamonCharges(requiredCharges: number): ActiveHamonEffect | undefined {
		if (!this.canConsumeHamon(requiredCharges)) return undefined;
		const hamon = this.getHamonEffect();
		if (hamon === undefined) return undefined;
		hamon.charges = math.max(hamon.charges - requiredCharges, 0);
		return hamon;
	}

	/**
	 * Ativa ou renova o buff de Hamon neste lutador.
	 * - Restaura as cargas até o máximo configurado (sem acumular acima do máximo) e renova a duração.
	 */
	public applyHamon(config?: HamonConfig, slot: SkillSlot = 3): AppliedHamonResult | undefined {
		if (!this.isAlive() || this.localState === "CAIDO") return undefined;
		const baseConfig = this.hamonConfig;
		const maxCharges = math.max(
			math.floor(config?.maxCharges ?? baseConfig?.maxCharges ?? HAMON_DEFAULT_MAX_CHARGES),
			1,
		);
		const rawInitial = config?.initialCharges ?? baseConfig?.initialCharges ?? maxCharges;
		const charges = clamp(math.floor(rawInitial), 1, maxCharges);
		const duration = math.max(
			config?.durationSeconds ?? baseConfig?.durationSeconds ?? HAMON_DEFAULT_DURATION_SECONDS,
			0.001,
		);
		const slotMultipliers: HamonSlotMultipliers = {
			1: config?.slotMultipliers?.[1] ?? baseConfig?.slotMultipliers?.[1] ?? HAMON_DEFAULT_SLOT_MULTIPLIERS[1],
			2: config?.slotMultipliers?.[2] ?? baseConfig?.slotMultipliers?.[2] ?? HAMON_DEFAULT_SLOT_MULTIPLIERS[2],
			3: config?.slotMultipliers?.[3] ?? baseConfig?.slotMultipliers?.[3] ?? HAMON_DEFAULT_SLOT_MULTIPLIERS[3],
		};
		const renewed = this.statusEffects.has("Hamon");
		const activeEffect: ActiveHamonEffect = {
			kind: "hamon",
			effect: "Hamon",
			slot,
			duration,
			maxCharges,
			slotMultipliers,
			charges,
			remainingDuration: duration,
		};
		this.statusEffects.set("Hamon", activeEffect);
		return { activeEffect, renewed };
	}

	/**
	 * Aplica ou renova um efeito de status neste lutador.
	 * - Não empilha: sobrescreve a instância anterior do mesmo `StatusEffect`, renovando a duração.
	 * - DoT (`Bleed`/`Burn`) exige `realDamage > 0` (hits esquivados não geram DoT).
	 * - Para `Hamon`, use `applyHamon(config, slot)`.
	 */
	public applyStatusEffect(
		effect: StatusEffect,
		slot: SkillSlot,
		realDamage: number,
		source?: Fighter,
	): AppliedStatusEffectResult | undefined {
		if (!this.isAlive() || this.localState === "CAIDO") return undefined;
		if (effect === "Hamon") return undefined;
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
