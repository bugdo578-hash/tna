import { ATB_MAX, BASE_ATB_SPEED } from "../../../shared/Config";
import { findFighterDefinition } from "../../../shared/FighterData";
import { calcDano, calcSkillSlotRoll } from "../../../shared/MathUtils";
import type { ClassName, SkillSlots } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { BattleService } from "../../Services/BattleService";
import { makeRealFighter } from "../../Services/BattleTeamFactory";
import { assertInvariant } from "./testHelpers";

export function validateJonathanN31(): void {
	const def = findFighterDefinition("jonathan");
	assertInvariant(def !== undefined && def.className === "Fury" && def.rarity === "Comum" && def.skills.size() === 3, "registro Jonathan");
	const rng = () => 0.99;
	const slots: SkillSlots = [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.5)];
	for (const [className, vampire, charges, expectedBurn] of [
		["Menace", false, 3, true], ["Menace", false, 2, true], ["Menace", false, 1, false],
		["Controller", false, 3, false], ["Controller", true, 3, true], ["Menace", false, 0, false],
	] as const) {
		const attacker = makeRealFighter("jonathan", rng, 10);
		const target = new Fighter({ fighterId: "synthetic", hp: 10000, hpMax: 10000,
			stats: { hp: 10000, atk: 10, dodge: 0, crit: 0 }, level: 10, className: className as ClassName,
			slots, skillData: def!.skills, currentAtbSpeed: BASE_ATB_SPEED, isVampire: vampire });
		const a = new BattleSide([attacker], rng);
		const battle = new BattleService(a, new BattleSide([target], rng), rng);
		const hits: number[] = [];
		let burns = 0;
		battle.events.hitResolved.connect((hit) => hits.push(hit.damage));
		battle.events.effectApplied.connect((effect) => { if (effect.effect === "Burn") burns++; });
		if (charges > 0) attacker.applyHamon({ initialCharges: charges });
		a.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(a, 2), "S2 aceita");
		assertInvariant(attacker.getHamonCharges() === (charges >= 2 ? charges - 2 : charges), "S2 consome cargas uma vez");
		battle.step(1.1);
		const counter = className === "Menace" ? 1.175 : 1;
		const expected = math.max(math.round(calcDano(attacker.stats.atk, attacker.slots[1].mult, attacker.level) / 3 * counter * (charges >= 2 ? 1.8 : 1)), 1);
		assertInvariant(hits.size() === 3 && hits.every((damage) => damage === expected), "S2 resolve três hits com multiplicador esperado");
		assertInvariant(burns === (expectedBurn ? 1 : 0) && target.hasStatusEffect("Burn") === expectedBurn, "Burn condicional aplicado apenas no terceiro hit");
	}
	const jonathan = makeRealFighter("jonathan", rng, 10);
	const ally = makeRealFighter("jotaro", rng, 10);
	const enemy = makeRealFighter("anubis", rng, 10);
	const side = new BattleSide([jonathan, ally], rng);
	const battle = new BattleService(side, new BattleSide([enemy], rng), rng);
	side.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(side, 3), "S3 aceita");
	battle.step(1);
	assertInvariant(jonathan.getHamonCharges() === 3 && !ally.hasHamon() && !enemy.hasHamon(), "S3 é individual");
	jonathan.consumeHamonCharges(1);
	side.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(side, 3), "S3 renovada aceita");
	battle.step(1);
	assertInvariant(jonathan.getHamonCharges() === 3, "S3 renova cargas");
	const s1Hits: number[] = [];
	battle.events.hitResolved.connect((hit) => s1Hits.push(hit.damage));
	side.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(side, 1) && jonathan.getHamonCharges() === 2, "S1 consome uma carga");
	battle.step(1);
	const s1Expected = math.max(math.round(calcDano(jonathan.stats.atk, jonathan.slots[0].mult, jonathan.level) * 1.3 * 1.175), 1);
	assertInvariant(s1Hits.size() === 1 && s1Hits[0] === s1Expected, "S1 aplica ×1,30 ao dano base");
	assertInvariant(!ally.hasHamon() && !enemy.hasHamon(), "cargas permanecem individuais após S1");
	print("JONATHAN_N31_PASSED");
}
