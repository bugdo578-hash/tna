// Auditoria matemática completa de dano: rolls canônicos, BASE_ATB_SPEED fixo, Hamon pós-arredondamento e distribuição multi-hit.
import { Players } from "@rbxts/services";
import {
	ATB_COST_RANGES,
	ATB_MAX,
	BASE_ATB_SPEED,
	D_SLOT,
	FLOAT_TOLERANCE,
	HAMON_DEFAULT_SLOT_MULTIPLIERS,
} from "../../../shared/Config";
import { getFighterDefinition } from "../../../shared/FighterData";
import {
	calcCusto,
	calcDano,
	calcHamonDamage,
	calcLevelScale,
	calcMult,
	calcSkillSlotRoll,
	distributeDamageAcrossHits,
} from "../../../shared/MathUtils";
import type { SkillDataSlots } from "../../../shared/SkillData";
import type { ClassName, SkillSlot, SkillSlots } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { BattleService } from "../../Services/BattleService";
import { createPlayerInventorySide, makeRealFighter } from "../../Services/BattleTeamFactory";
import { DamageService } from "../../Services/DamageService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import { InMemoryDataStore } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { assertInvariant } from "./testHelpers";

const hitNoCritRng = () => 0.99;

function makeTarget(hp = 10000, className: ClassName = "Controller", dodge = 0, isVampire = false): Fighter {
	const slots: SkillSlots = [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.5)];
	return new Fighter({
		fighterId: "audit_target", hp, hpMax: hp,
		stats: { hp, atk: 10, dodge, crit: 0 }, level: 30, className,
		slots, skillData: getFighterDefinition("anubis").skills, currentAtbSpeed: BASE_ATB_SPEED, isVampire,
	});
}

export function validateDamageAuditSlotsHamonMultihit(): void {
	// 1. Roll único por slot coerente (custo + mult do mesmo t) e BASE_ATB_SPEED fixo = 0.588
	assertInvariant(BASE_ATB_SPEED === 0.588, "BASE_ATB_SPEED canônico = 0.588");
	assertInvariant(D_SLOT[1] === 0.2145 && D_SLOT[2] === 0.1373 && D_SLOT[3] === 0.1825, "D_SLOT canônicos preservados");
	for (const slot of [1, 2, 3] as const) {
		const range = ATB_COST_RANGES[slot];
		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			const roll = calcSkillSlotRoll(slot, t);
			const expectedCost = calcCusto(slot, t);
			const expectedMult = D_SLOT[slot] * (expectedCost / BASE_ATB_SPEED);
			assertInvariant(
				roll.t === t &&
					math.abs(roll.cost - expectedCost) <= FLOAT_TOLERANCE &&
					roll.cost >= range.min && roll.cost <= range.max &&
					math.abs(roll.mult - expectedMult) <= FLOAT_TOLERANCE &&
					math.abs(calcMult(slot, expectedCost) - expectedMult) <= FLOAT_TOLERANCE,
				`1. Roll único slot ${slot} t=${t} coerente`,
			);
		}
	}

	// 2. Buff/debuff de velocidade (currentAtbSpeed) nunca altera mult nem dano
	{
		const jonDef = getFighterDefinition("jonathan");
		const fixedSlots: SkillSlots = [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.5)];
		const fastJon = new Fighter({
			fighterId: "jonathan", hp: 500, hpMax: 500, stats: { hp: 500, atk: 30, dodge: 0, crit: 0 },
			level: 30, className: "Fury", slots: fixedSlots, skillData: jonDef.skills, currentAtbSpeed: BASE_ATB_SPEED * 2,
		});
		const slowJon = new Fighter({
			fighterId: "jonathan", hp: 500, hpMax: 500, stats: { hp: 500, atk: 30, dodge: 0, crit: 0 },
			level: 30, className: "Fury", slots: fixedSlots, skillData: jonDef.skills, currentAtbSpeed: BASE_ATB_SPEED * 0.5,
		});
		const dmgSvc = new DamageService();
		const fastPlan = dmgSvc.planAttackDamage(fastJon, 3, jonDef.skills[2], 2.2);
		const slowPlan = dmgSvc.planAttackDamage(slowJon, 3, jonDef.skills[2], 2.2);
		assertInvariant(
			fastPlan.slotDamage === slowPlan.slotDamage && fastPlan.totalDamage === slowPlan.totalDamage,
			"2. currentAtbSpeed nunca altera D_slot nem D_hamon",
		);
	}

	// 3. Persistência do roll original do item (sem reroll ao equipar/entrar em batalha)
	{
		const player = { Parent: Players, Name: "AuditRollP", UserId: 998101 } as unknown as Player;
		const progression = new ProgressionService();
		const data = new PlayerDataService(progression, {
			dataStore: new InMemoryDataStore(), serverId: "AuditRoll",
			now: () => 1000, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true,
		});
		assertInvariant(data.loadPlayer(player).ok, "load jogador");
		const fixedSkills: SkillSlots = [calcSkillSlotRoll(1, 0.13), calcSkillSlotRoll(2, 0.47), calcSkillSlotRoll(3, 0.89)];
		const item = progression.createInventoryFighter(player, {
			fighterId: "jonathan", rarity: "Comum",
			baseStats: { hp: 15, atk: 12, dodge: 5, crit: 8 }, skills: fixedSkills,
		});
		assertInvariant(data.setActiveTeam(player, [item.itemUuid]), "equipa Jonathan");
		const side1 = createPlayerInventorySide(player, progression, data, () => 0.01)!;
		const side2 = createPlayerInventorySide(player, progression, data, () => 0.99)!;
		for (const i of $range(0, 2)) {
			assertInvariant(
				side1.fighters[0].slots[i].t === fixedSkills[i].t &&
					side1.fighters[0].slots[i].cost === fixedSkills[i].cost &&
					side1.fighters[0].slots[i].mult === fixedSkills[i].mult &&
					side2.fighters[0].slots[i].mult === fixedSkills[i].mult,
				`3. Roll do slot ${i + 1} preservado sem reroll entre batalhas`,
			);
		}
		data.handlePlayerRemoving(player);
	}

	// 4. Cálculo Lv1, Lv15 e Lv30 + 6. Hamon APÓS arredondar D_slot
	{
		assertInvariant(math.abs(calcLevelScale(1) - 0.5) <= FLOAT_TOLERANCE, "levelScale Lv1 = 0.5");
		assertInvariant(math.abs(calcLevelScale(15) - (0.5 + (14 / 29) * 0.5)) <= FLOAT_TOLERANCE, "levelScale Lv15");
		assertInvariant(math.abs(calcLevelScale(30) - 1.0) <= FLOAT_TOLERANCE, "levelScale Lv30 = 1.0");

		// Caso construído onde arredondar D_slot ANTES vs DEPOIS de Hamon difere:
		// ATK=13, mult=calcMult(3, 9.0)=0.1825*(9/0.588)=2.793367..., Lv1 (scale=0.5):
		// raw = 13 * 2.7933673469 * 0.5 = 18.1568877... -> D_slot = round(18.1568877) = 18
		// Correto (Hamon sobre D_slot arredondado): round(18 * 2.2) = round(39.6) = 40
		// Errado (Hamon antes de arredondar): round(18.1568877 * 2.2) = round(39.945) = 40 -> vamos escolher ATK=17, mult=calcMult(3, 8.0), Lv1:
		// mult = 0.1825 * (8 / 0.588) = 2.482993197...
		// raw = 17 * 2.482993197 * 0.5 = 21.105442... -> D_slot = 21
		// Correto: round(21 * 2.2) = round(46.2) = 46! Errado (sem arredondar antes): round(21.105442 * 2.2) = round(46.43) = 46...
		// Para garantir diferença estrita: raw = 10.4 -> round(10.4) = 10 -> round(10 * 2.2) = 22; vs round(10.4 * 2.2) = round(22.88) = 23!
		const multFor104 = 1.04; // ATK=20, Lv1 (scale=0.5) -> raw = 20 * 1.04 * 0.5 = 10.4
		const rawSlot = 20 * multFor104 * calcLevelScale(1); // 10.4
		const dSlot = calcDano(20, multFor104, 1); // 10
		const dHamonCorrect = calcHamonDamage(dSlot, 2.2); // round(10 * 2.2) = 22
		const dHamonWrong = math.round(rawSlot * 2.2); // round(22.88) = 23
		assertInvariant(dSlot === 10 && dHamonCorrect === 22 && dHamonWrong === 23, "6. Caso discriminante D_slot=10 -> D_hamon=22 (e não 23)");

		const jonDef = getFighterDefinition("jonathan");
		const customS3Roll = { t: 0.5, cost: calcCusto(3, 0.5), mult: multFor104 };
		const jonLv30 = new Fighter({
			fighterId: "jonathan", hp: 500, hpMax: 500, stats: { hp: 500, atk: 10, dodge: 0, crit: 0 },
			level: 30, className: "Fury",
			slots: [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), customS3Roll],
			skillData: jonDef.skills, currentAtbSpeed: BASE_ATB_SPEED,
		});
		const sideA = new BattleSide([jonLv30], hitNoCritRng);
		const target = makeTarget(10000, "Controller", 0);
		const battle = new BattleService(sideA, new BattleSide([target], hitNoCritRng), hitNoCritRng);
		const hits: number[] = [];
		battle.events.hitResolved.connect((h) => hits.push(h.damage));
		jonLv30.applyHamon({ initialCharges: 3 });
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 3), "6. S3 com Hamon aceita");
		battle.step(1.2);
		assertInvariant(
			hits.size() === 3 && hits[0] === 8 && hits[1] === 7 && hits[2] === 7 && (hits[0] + hits[1] + hits[2]) === 22,
			`6. Hamon aplicado APÓS arredondar D_slot=10 -> D_hamon=22 -> [8,7,7] (obtido: ${hits.join(",")})`,
		);
	}

	// 8, 12, 13. Exemplo canônico D_slot=90 -> D_hamon=198 -> [66,66,66]; D_total=100 -> [34,33,33]; D_total=2 -> [1,1,0]; D_total=1 -> [1,0,0]
	{
		const jonDef = getFighterDefinition("jonathan");
		const runExactTotal = (totalTarget: number, hamonCharges: number, slot: SkillSlot, skillData: SkillDataSlots = jonDef.skills): number[] => {
			// Em Lv30 (scale=1.0), ATK=totalTarget e mult=1.0 -> D_slot = totalTarget exato!
			const roll = { t: 0.5, cost: calcCusto(slot, 0.5), mult: 1.0 };
			const attacker = new Fighter({
				fighterId: "jonathan", hp: 500, hpMax: 500, stats: { hp: 500, atk: totalTarget, dodge: 0, crit: 0 },
				level: 30, className: "Fury",
				slots: [
					slot === 1 ? roll : calcSkillSlotRoll(1, 0.5),
					slot === 2 ? roll : calcSkillSlotRoll(2, 0.5),
					slot === 3 ? roll : calcSkillSlotRoll(3, 0.5),
				],
				skillData, currentAtbSpeed: BASE_ATB_SPEED,
			});
			const target = makeTarget(10000, "Controller", 0);
			const sideA = new BattleSide([attacker], hitNoCritRng);
			const battle = new BattleService(sideA, new BattleSide([target], hitNoCritRng), hitNoCritRng);
			const hits: number[] = [];
			battle.events.hitResolved.connect((h) => hits.push(h.damage));
			if (hamonCharges > 0) attacker.applyHamon({ initialCharges: hamonCharges });
			sideA.setAtb(ATB_MAX);
			assertInvariant(battle.requestSkill(sideA, slot), `executa slot ${slot}`);
			battle.step(1.2);
			return hits;
		};

		// D_slot = 90, S3 com Hamon (×2.20) -> D_hamon = 198 -> [66, 66, 66]
		const h198 = runExactTotal(90, 3, 3);
		assertInvariant(h198.size() === 3 && h198[0] === 66 && h198[1] === 66 && h198[2] === 66, "8. D_slot=90 S3 Hamon = 66+66+66=198");

		// D_slot = 100, S3 sem Hamon -> [34, 33, 33] = 100
		const h100 = runExactTotal(100, 0, 3);
		assertInvariant(h100.size() === 3 && h100[0] === 34 && h100[1] === 33 && h100[2] === 33, "12. D_total=100 -> 34+33+33=100");

		// D_slot = 101, S3 sem Hamon -> [34, 34, 33] = 101
		const h101 = runExactTotal(101, 0, 3);
		assertInvariant(h101.size() === 3 && h101[0] === 34 && h101[1] === 34 && h101[2] === 33, "12. D_total=101 -> 34+34+33=101");

		// 13. Dano pequeno menor que o número de hits: D_total=2 -> [1,1,0], D_total=1 -> [1,0,0], D_total=0 -> [0,0,0]
		const h2 = runExactTotal(2, 0, 3);
		assertInvariant(h2.size() === 3 && h2[0] === 1 && h2[1] === 1 && h2[2] === 0, "13. D_total=2 em 3 hits -> [1,1,0] sem inventar dano");
		const h1 = runExactTotal(1, 0, 3);
		assertInvariant(h1.size() === 3 && h1[0] === 1 && h1[1] === 0 && h1[2] === 0, "13. D_total=1 em 3 hits -> [1,0,0] sem inventar dano");
		const h0 = runExactTotal(0, 0, 3);
		assertInvariant(h0.size() === 3 && h0[0] === 0 && h0[1] === 0 && h0[2] === 0, "13. D_total=0 em 3 hits -> [0,0,0]");

		// 17. Permutação: Overdrive em S1 usa Hamon ×1.30 (90 * 1.3 = 117 -> 39+39+39); em S2 usa ×1.80 (90 * 1.8 = 162 -> 54+54+54)
		const overdriveInS1: SkillDataSlots = [jonDef.skills[2], jonDef.skills[0], jonDef.skills[1]];
		const hPermS1 = runExactTotal(90, 3, 1, overdriveInS1);
		assertInvariant(hPermS1.size() === 3 && hPermS1[0] === 39 && hPermS1[1] === 39 && hPermS1[2] === 39, "17. Overdrive em S1: 90×1.30=117 -> [39,39,39]");

		const overdriveInS2: SkillDataSlots = [jonDef.skills[0], jonDef.skills[2], jonDef.skills[1]];
		const hPermS2 = runExactTotal(90, 3, 2, overdriveInS2);
		assertInvariant(hPermS2.size() === 3 && hPermS2[0] === 54 && hPermS2[1] === 54 && hPermS2[2] === 54, "17. Overdrive em S2: 90×1.80=162 -> [54,54,54]");

		// Pesos assimétricos em distributeDamageAcrossHits
		const asym = distributeDamageAcrossHits(11, [0.2, 0.3, 0.5]);
		assertInvariant(asym[0] === 2 && asym[1] === 3 && asym[2] === 6, "12. Distribuição assimétrica [0.2,0.3,0.5] de 11 -> [2,3,6]");
	}

	// 14. Esquiva sem redistribuir dano (hit 1 esquiva em [34, 33, 33] -> hits 2 e 3 causam 33 e 33, total efetivo = 66)
	{
		const jonDef = getFighterDefinition("jonathan");
		const roll3 = { t: 0.5, cost: calcCusto(3, 0.5), mult: 1.0 };
		const attacker = new Fighter({
			fighterId: "jonathan", hp: 500, hpMax: 500, stats: { hp: 500, atk: 100, dodge: 0, crit: 0 },
			level: 30, className: "Fury",
			slots: [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), roll3],
			skillData: jonDef.skills, currentAtbSpeed: BASE_ATB_SPEED,
		});
		const target = makeTarget(10000, "Controller", 50);
		const seq = [0.01, 0.99, 0.99, 0.99, 0.99]; // Hit1 dodge (<0.5), Hit2 hit+noCrit, Hit3 hit+noCrit
		let idx = 0;
		const rng = () => { idx += 1; return seq[idx - 1] ?? 0.99; };
		const sideA = new BattleSide([attacker], hitNoCritRng);
		const battle = new BattleService(sideA, new BattleSide([target], hitNoCritRng), rng);
		const hits: Array<{ hit: boolean; damage: number }> = [];
		battle.events.hitResolved.connect((h) => hits.push({ hit: h.hit, damage: h.damage }));
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 3), "14. S3 para teste de esquiva");
		battle.step(1.2);
		assertInvariant(
			hits.size() === 3 && !hits[0].hit && hits[0].damage === 0 &&
				hits[1].hit && hits[1].damage === 33 && hits[2].hit && hits[2].damage === 33 &&
				(10000 - target.hp) === 66,
			"14. Esquiva no hit 1 não redistribui os 34 de dano para os hits 2 e 3",
		);
	}

	// 15. Crítico e vantagem de classe sem multiplicar Hamon duas vezes
	{
		const jonDef = getFighterDefinition("jonathan");
		const roll3 = { t: 0.5, cost: calcCusto(3, 0.5), mult: 1.0 };
		const attacker = new Fighter({
			fighterId: "jonathan", hp: 500, hpMax: 500, stats: { hp: 500, atk: 90, dodge: 0, crit: 50 },
			level: 30, className: "Fury",
			slots: [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), roll3],
			skillData: jonDef.skills, currentAtbSpeed: BASE_ATB_SPEED,
		});
		const target = makeTarget(10000, "Menace", 0); // Fury > Menace (×1.175)
		// Hit1: noCrit (0.99, 0.99); Hit2: crit (0.99, 0.01); Hit3: noCrit (0.99, 0.99)
		const seq = [0.99, 0.99, 0.99, 0.01, 0.99, 0.99];
		let idx = 0;
		const rng = () => { idx += 1; return seq[idx - 1] ?? 0.99; };
		const sideA = new BattleSide([attacker], hitNoCritRng);
		const battle = new BattleService(sideA, new BattleSide([target], hitNoCritRng), rng);
		const hits: Array<{ crit: boolean; damage: number }> = [];
		battle.events.hitResolved.connect((h) => hits.push({ crit: h.crit, damage: h.damage }));
		attacker.applyHamon({ initialCharges: 3 });
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 3), "15. S3 com Hamon + counter + crit");
		battle.step(1.2);
		// D_slot=90 -> D_hamon=round(90*2.2)=198 -> planned=[66,66,66]
		// Counter por hit: round(66 * 1.175) = round(77.55) = 78
		// Crit no hit 2: round(78 * 1.5) = 117
		assertInvariant(
			hits.size() === 3 &&
				!hits[0].crit && hits[0].damage === 78 &&
				hits[1].crit && hits[1].damage === 117 &&
				!hits[2].crit && hits[2].damage === 78 &&
				target.hasStatusEffect("Burn"),
			"15. Hamon aplicado uma vez (198 -> 66/hit), counter (78) e crit no hit 2 (117), sem dupla multiplicação",
		);
	}

	// 16. Platinum Barrage (Jotaro S2) com 3 hits e dano total consistente sem Hamon
	{
		const jotaro = makeRealFighter("jotaro", () => 0.5, 30);
		const target = makeTarget(10000, "Controller", 0);
		const sideA = new BattleSide([jotaro], hitNoCritRng);
		const battle = new BattleService(sideA, new BattleSide([target], hitNoCritRng), hitNoCritRng);
		const hits: number[] = [];
		battle.events.hitResolved.connect((h) => hits.push(h.damage));
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 2), "16. Platinum Barrage (S2) aceita");
		battle.step(1.2);
		const expectedTotal = calcDano(jotaro.stats.atk, jotaro.slots[1].mult, jotaro.level);
		const expectedDist = distributeDamageAcrossHits(expectedTotal, [1 / 3, 1 / 3, 1 / 3]);
		assertInvariant(
			hits.size() === 3 &&
				hits[0] === expectedDist[0] && hits[1] === expectedDist[1] && hits[2] === expectedDist[2] &&
				(hits[0] + hits[1] + hits[2]) === expectedTotal,
			"16. Platinum Barrage distribui exatamente D_slot em 3 hits sem Hamon",
		);
	}

	print("DAMAGE_AUDIT_PASSED");
}
