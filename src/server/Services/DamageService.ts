import { CRIT_PERCENT_PER_POINT, DODGE_PERCENT_PER_POINT } from "../../shared/Config";
import { applyCritMultiplier, calcCounterMult, calcDano } from "../../shared/MathUtils";
import type { SkillSlot } from "../../shared/TypeDefs";
import type { Fighter } from "../Components/Fighter";

const PERCENTAGE_BASE = 100;
const MIN_HIT_DAMAGE = 1;

export interface HitResult {
	readonly hit: boolean;
	readonly crit: boolean;
	readonly damage: number;
}

export class DamageService {
	public resolveHit(attacker: Fighter, defender: Fighter, slot: SkillSlot, damageShare: number, rng: () => number): HitResult {
		const dodgeChance = (defender.stats.dodge * DODGE_PERCENT_PER_POINT) / PERCENTAGE_BASE;
		if (rng() < dodgeChance) return { hit: false, crit: false, damage: 0 };

		const skill = attacker.slots[slot - 1];
		const baseDamage = calcDano(attacker.stats.atk, skill.mult, attacker.level) * damageShare;
		const counterMultiplier = calcCounterMult(attacker.className, defender.className);
		const normalHitDamage = math.max(math.round(baseDamage * counterMultiplier), MIN_HIT_DAMAGE);
		const critChance = (attacker.stats.crit * CRIT_PERCENT_PER_POINT) / PERCENTAGE_BASE;
		const crit = rng() < critChance;
		const damage = applyCritMultiplier(normalHitDamage, crit);

		return { hit: true, crit, damage };
	}
}
