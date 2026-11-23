import { doesClassCounter } from "../../shared/ClassData";
import type { SkillData, SkillHitTimeline } from "../../shared/SkillData";
import type { StatusEffect } from "../../shared/TypeDefs";
import type { Fighter } from "../Components/Fighter";

/** Passiva do Hamon: todo ataque ofensivo bonificado por Hamon aplica Burn contra vampiros ou classes em desvantagem. */
export function isHamonBurnEligible(attacker: Fighter, target: Fighter): boolean {
	return target.isVampire || doesClassCounter(attacker.className, target.className);
}

export function canApplyHamonHitEffects(hit: SkillHitTimeline, attacker: Fighter, target: Fighter): boolean {
	return hit.hamonEffectCondition !== "vampireOrClassCounter" || isHamonBurnEligible(attacker, target);
}

export function resolvePendingHamonEffects(
	timeline: SkillData,
	attacker: Fighter | undefined,
	target: Fighter,
): readonly StatusEffect[] {
	const effects: StatusEffect[] = [];
	if (timeline.hamonStatusEffects !== undefined) {
		for (const effect of timeline.hamonStatusEffects) {
			if (!effects.includes(effect)) effects.push(effect);
		}
	}
	if (attacker !== undefined && isHamonBurnEligible(attacker, target) && !effects.includes("Burn")) {
		effects.push("Burn");
	}
	return effects;
}
