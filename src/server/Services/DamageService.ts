import { CRIT_PERCENT_PER_POINT, DODGE_PERCENT_PER_POINT } from "../../shared/Config";
import {
	applyCritMultiplier,
	calcCounterMult,
	calcDano,
	calcHamonDamage,
	distributeDamageAcrossHits,
} from "../../shared/MathUtils";
import type { SkillData } from "../../shared/SkillData";
import type { SkillSlot } from "../../shared/TypeDefs";
import type { Fighter } from "../Components/Fighter";

const PERCENTAGE_BASE = 100;
const MIN_HIT_DAMAGE = 1;

export interface HitResult {
	readonly hit: boolean;
	readonly crit: boolean;
	readonly damage: number;
}

export interface PlannedAttackDamage {
	readonly slotDamage: number;
	readonly totalDamage: number;
	readonly hitDamages: readonly number[];
}

export class DamageService {
	/**
	 * Planeja o dano total inteiro da habilidade seguindo a ordem canônica:
	 * 1) `D_slot = round(ATK_final * mult_do_roll * levelScale)`
	 * 2) `D_total = round(D_slot * hamonMult_do_slot)` (quando Hamon elegível)
	 * 3) Distribui `D_total` entre os hits ofensivos por `damageShare` com resíduos determinísticos.
	 */
	public planAttackDamage(
		attacker: Fighter,
		slot: SkillSlot,
		timeline: SkillData,
		hamonMultiplier = 1,
	): PlannedAttackDamage {
		const skill = attacker.slots[slot - 1];
		const slotDamage = calcDano(attacker.stats.atk, skill.mult, attacker.level);
		const totalDamage = calcHamonDamage(slotDamage, hamonMultiplier);

		const offensiveIndices: number[] = [];
		const offensiveShares: number[] = [];
		for (const index of $range(0, timeline.hits.size() - 1)) {
			const hit = timeline.hits[index];
			const isNoDamage =
				hit.kind === "self" || hit.noDamage === true || timeline.effectTarget === "self" || hit.damageShare <= 0;
			if (!isNoDamage) {
				offensiveIndices.push(index);
				offensiveShares.push(hit.damageShare);
			}
		}

		const hitDamages: number[] = [];
		for (const _ of $range(1, timeline.hits.size())) hitDamages.push(0);
		if (offensiveIndices.size() > 0) {
			const distributed = distributeDamageAcrossHits(totalDamage, offensiveShares);
			for (const i of $range(0, offensiveIndices.size() - 1)) {
				hitDamages[offensiveIndices[i]] = distributed[i];
			}
		}

		return { slotDamage, totalDamage, hitDamages };
	}

	/**
	 * Resolve um hit individual a partir do dano planejado já distribuído, aplicando
	 * esquiva, vantagem de classe e crítico sem re-aplicar Hamon nem inventar piso 1 para hits planejados com 0.
	 */
	public resolvePlannedHit(
		attacker: Fighter,
		defender: Fighter,
		plannedDamage: number,
		rng: () => number,
	): HitResult {
		const dodgeChance = (defender.stats.dodge * DODGE_PERCENT_PER_POINT) / PERCENTAGE_BASE;
		if (rng() < dodgeChance) return { hit: false, crit: false, damage: 0 };

		const safePlanned = math.max(math.round(plannedDamage), 0);
		if (safePlanned <= 0) return { hit: true, crit: false, damage: 0 };

		const counterMultiplier = calcCounterMult(attacker.className, defender.className);
		const normalHitDamage = counterMultiplier === 1
			? safePlanned
			: math.max(math.round(safePlanned * counterMultiplier), MIN_HIT_DAMAGE);
		const critChance = (attacker.stats.crit * CRIT_PERCENT_PER_POINT) / PERCENTAGE_BASE;
		const crit = rng() < critChance;
		const damage = applyCritMultiplier(normalHitDamage, crit);

		return { hit: true, crit, damage };
	}

	public resolveHit(
		attacker: Fighter,
		defender: Fighter,
		slot: SkillSlot,
		damageShare: number,
		rng: () => number,
		baseDamageMultiplier = 1,
	): HitResult {
		const skill = attacker.slots[slot - 1];
		const slotDamage = calcDano(attacker.stats.atk, skill.mult, attacker.level);
		const totalDamage = calcHamonDamage(slotDamage, baseDamageMultiplier);
		const plannedDamage = damageShare === 1 ? totalDamage : math.round(totalDamage * damageShare);
		return this.resolvePlannedHit(attacker, defender, plannedDamage, rng);
	}
}
