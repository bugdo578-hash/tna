import { doesClassCounter } from "../../shared/ClassData";
import type { SkillHitTimeline } from "../../shared/SkillData";
import type { Fighter } from "../Components/Fighter";

export function canApplyHamonHitEffects(hit: SkillHitTimeline, attacker: Fighter, target: Fighter): boolean {
	return hit.hamonEffectCondition !== "vampireOrClassCounter" || target.isVampire || doesClassCounter(attacker.className, target.className);
}
