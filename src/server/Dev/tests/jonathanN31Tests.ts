import { Players } from "@rbxts/services";
import { ATB_MAX, BASE_ATB_SPEED, HAMON_DEFAULT_SLOT_MULTIPLIERS } from "../../../shared/Config";
import { findFighterDefinition } from "../../../shared/FighterData";
import { calcDano, calcHamonDamage, calcSkillSlotRoll, distributeDamageAcrossHits } from "../../../shared/MathUtils";
import type { AttackStartedPayload, BattleStartedPayload } from "../../../shared/Remotes";
import { getSkillId, type SkillDataSlots } from "../../../shared/SkillData";
import type { ClassName, SkillSlot, SkillSlots } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { makeRealFighter } from "../../Services/BattleTeamFactory";
import { assertInvariant, createSurgicalMockAdapter } from "./testHelpers";

function assertOverdriveBehavior(
	overdriveSlot: SkillSlot,
	skillData: SkillDataSlots,
	label: string,
): void {
	const rng = () => 0.99;
	const slots: SkillSlots = [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.5)];
	const slotHamonMult = HAMON_DEFAULT_SLOT_MULTIPLIERS[overdriveSlot];
	for (const [className, vampire, charges, expectedBurn] of [
		["Menace", false, 3, true], ["Menace", false, 2, true], ["Menace", false, 1, false],
		["Controller", false, 3, false], ["Controller", true, 3, true], ["Menace", false, 0, false],
	] as const) {
		const baseAttacker = makeRealFighter("jonathan", rng, 10);
		const attacker = new Fighter({
			fighterId: "jonathan", hp: baseAttacker.hp, hpMax: baseAttacker.hpMax,
			stats: baseAttacker.stats, level: 10, className: baseAttacker.className,
			slots: baseAttacker.slots, skillData, currentAtbSpeed: BASE_ATB_SPEED,
		});
		const target = new Fighter({
			fighterId: "synthetic", hp: 10000, hpMax: 10000,
			stats: { hp: 10000, atk: 10, dodge: 0, crit: 0 }, level: 10, className: className as ClassName,
			slots, skillData, currentAtbSpeed: BASE_ATB_SPEED, isVampire: vampire,
		});
		const a = new BattleSide([attacker], rng);
		const battle = new BattleService(a, new BattleSide([target], rng), rng);
		const hits: number[] = [];
		let burns = 0;
		let burnHitIndex = 0;
		battle.events.hitResolved.connect((hit) => hits.push(hit.damage));
		battle.events.effectApplied.connect((effect) => {
			if (effect.effect === "Burn") {
				burns++;
				burnHitIndex = hits.size();
			}
		});
		if (charges > 0) attacker.applyHamon({ initialCharges: charges });
		a.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(a, overdriveSlot), `${label}: Sunlight Yellow Overdrive aceita no S${overdriveSlot}`);
		assertInvariant(attacker.getHamonCharges() === (charges >= 2 ? charges - 2 : charges), `${label}: consome 2 cargas uma vez`);
		battle.step(1.1);
		const counter = className === "Menace" ? 1.175 : 1;
		const slotDamage = calcDano(attacker.stats.atk, attacker.slots[overdriveSlot - 1].mult, attacker.level);
		const totalDamage = calcHamonDamage(slotDamage, charges >= 2 ? slotHamonMult : 1);
		const planned = distributeDamageAcrossHits(totalDamage, [1 / 3, 1 / 3, 1 / 3]);
		const expectedHits = planned.map((d) => (d <= 0 ? 0 : counter === 1 ? d : math.max(math.round(d * counter), 1)));
		assertInvariant(
			hits.size() === 3 &&
				hits[0] === expectedHits[0] && hits[1] === expectedHits[1] && hits[2] === expectedHits[2],
			`${label}: 3 hits com multiplicador do slot S${overdriveSlot} (×${slotHamonMult}) e distribuição exata`,
		);
		assertInvariant(
			burns === (expectedBurn ? 1 : 0) && target.hasStatusEffect("Burn") === expectedBurn && (!expectedBurn || burnHitIndex === 3),
			`${label}: Burn condicional aplicado apenas no 3º hit`,
		);
	}
}

export function validateJonathanN31(): void {
	const def = findFighterDefinition("jonathan");
	assertInvariant(def !== undefined && def.className === "Fury" && def.rarity === "Comum" && def.skills.size() === 3, "registro Jonathan");
	const skills = def!.skills;
	assertInvariant(
		getSkillId(skills[0]) === "jonathan_luck_and_pluck" && skills[0].name === "Luck & Pluck" &&
			getSkillId(skills[1]) === "jonathan_hamon_breathing" && skills[1].name === "Respiração de Hamon" &&
			getSkillId(skills[2]) === "jonathan_sunlight_yellow_overdrive" && skills[2].name === "Sunlight Yellow Overdrive",
		"Jonathan na ordem oficial: S1 Luck & Pluck, S2 Respiração de Hamon, S3 Sunlight Yellow Overdrive",
	);

	// 1. Ordem oficial do Jonathan: S3 = Sunlight Yellow Overdrive (×2,20 no S3, 3 hits, 2 cargas, Burn condicional)
	assertOverdriveBehavior(3, skills, "Jonathan S3 oficial");

	const rng = () => 0.99;
	const jonathan = makeRealFighter("jonathan", rng, 10);
	const ally = makeRealFighter("jotaro", rng, 10);
	const enemy = makeRealFighter("anubis", rng, 10);
	const side = new BattleSide([jonathan, ally], rng);
	const battle = new BattleService(side, new BattleSide([enemy], rng), rng);

	// 2. S2 = Respiração de Hamon: ativa e renova 3 cargas individuais
	side.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(side, 2), "S2 (Respiração de Hamon) aceita");
	battle.step(1);
	assertInvariant(jonathan.getHamonCharges() === 3 && !ally.hasHamon() && !enemy.hasHamon(), "S2 é auto-buff individual com 3 cargas");
	jonathan.consumeHamonCharges(1);
	side.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(side, 2), "S2 renovada aceita");
	battle.step(1);
	assertInvariant(jonathan.getHamonCharges() === 3, "S2 renova cargas para 3");

	// 3. S1 = Luck & Pluck: 1 hit, consome 1 carga, aplica ×1,30 do slot S1 sobre D_slot arredondado
	const s1Hits: number[] = [];
	battle.events.hitResolved.connect((hit) => s1Hits.push(hit.damage));
	side.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(side, 1) && jonathan.getHamonCharges() === 2, "S1 consome 1 carga");
	battle.step(1);
	const s1SlotDamage = calcDano(jonathan.stats.atk, jonathan.slots[0].mult, jonathan.level);
	const s1HamonDamage = calcHamonDamage(s1SlotDamage, HAMON_DEFAULT_SLOT_MULTIPLIERS[1]);
	const s1Expected = math.max(math.round(s1HamonDamage * 1.175), 1);
	assertInvariant(s1Hits.size() === 1 && s1Hits[0] === s1Expected, "S1 aplica ×1,30 sobre D_slot arredondado");
	assertInvariant(!ally.hasHamon() && !enemy.hasHamon(), "cargas permanecem individuais após S1");

	// 4. Permutação temporária de slots em fixture: [Respiração de Hamon (S1), Sunlight Yellow Overdrive (S2), Luck & Pluck (S3)]
	const permutedSkills: SkillDataSlots = [skills[1], skills[2], skills[0]];
	assertOverdriveBehavior(2, permutedSkills, "Fixture permutada Overdrive no S2 (×1,80)");

	const permBase = makeRealFighter("jonathan", rng, 10);
	const permJonathan = new Fighter({
		fighterId: "jonathan", hp: permBase.hp, hpMax: permBase.hpMax,
		stats: permBase.stats, level: 10, className: permBase.className,
		slots: permBase.slots, skillData: permutedSkills, currentAtbSpeed: BASE_ATB_SPEED,
	});
	const permEnemy = makeRealFighter("anubis", rng, 10);
	const permSide = new BattleSide([permJonathan], rng);
	const permBattle = new BattleService(permSide, new BattleSide([permEnemy], rng), rng);

	// S1 permutado = Respiração de Hamon -> recarrega 3 cargas sem dano
	permSide.setAtb(ATB_MAX);
	assertInvariant(permBattle.requestSkill(permSide, 1), "Fixture permutada: Respiração de Hamon aceita no S1");
	permBattle.step(1);
	assertInvariant(permJonathan.getHamonCharges() === 3 && permEnemy.hp === permEnemy.hpMax, "Fixture permutada: S1 recarrega 3 cargas sem dano");

	// S3 permutado = Luck & Pluck -> 1 hit, consome 1 carga, usa roll de S3 e Hamon ×2,20 do slot S3
	const permS3Hits: number[] = [];
	permBattle.events.hitResolved.connect((hit) => permS3Hits.push(hit.damage));
	permSide.setAtb(ATB_MAX);
	assertInvariant(permBattle.requestSkill(permSide, 3) && permJonathan.getHamonCharges() === 2, "Fixture permutada: Luck & Pluck no S3 consome 1 carga");
	permBattle.step(1);
	const permS3Slot = calcDano(permJonathan.stats.atk, permJonathan.slots[2].mult, permJonathan.level);
	const permS3Hamon = calcHamonDamage(permS3Slot, HAMON_DEFAULT_SLOT_MULTIPLIERS[3]);
	const permS3Expected = math.max(math.round(permS3Hamon * 1.175), 1);
	assertInvariant(permS3Hits.size() === 1 && permS3Hits[0] === permS3Expected, "Fixture permutada: Luck & Pluck no S3 usa ×2,20 do slot S3");

	// 5. Permutação com Overdrive no S1: 3 hits, 2 cargas, usa roll de S1 e Hamon ×1,30 do slot S1
	const overdriveInS1: SkillDataSlots = [skills[2], skills[0], skills[1]];
	assertOverdriveBehavior(1, overdriveInS1, "Fixture permutada Overdrive no S1 (×1,30)");

	// 6. BattleSessionPresentation transmite skillIds no BattleStarted e skillId no AttackStarted
	const p1 = { Parent: Players, Name: "N311PermP1", UserId: 993111 } as unknown as Player;
	let startedPayload: BattleStartedPayload | undefined;
	const attacks: AttackStartedPayload[] = [];
	const sessions = new BattleSessionService({
		...createSurgicalMockAdapter({ onBattleStarted: (_, payload) => { startedPayload = payload; } }),
		sendAttackStarted(_, payload) { attacks.push(payload); },
	});
	const sessionSideA = new BattleSide([new Fighter({
		fighterId: "jonathan", hp: 500, hpMax: 500, stats: permBase.stats, level: 10,
		className: "Fury", slots: permBase.slots, skillData: permutedSkills, currentAtbSpeed: BASE_ATB_SPEED,
	})], rng);
	const sessionSideB = new BattleSide([makeRealFighter("anubis", rng, 10)], rng);
	assertInvariant(sessions.createSession(p1, undefined, sessionSideA, sessionSideB, rng, "PVE"), "sessão permutada criada");
	const ownSnap = startedPayload?.fighters.find((f) => f.fighterId === "jonathan");
	assertInvariant(
		ownSnap?.skillIds !== undefined &&
			ownSnap.skillIds[0] === "jonathan_hamon_breathing" &&
			ownSnap.skillIds[1] === "jonathan_sunlight_yellow_overdrive" &&
			ownSnap.skillIds[2] === "jonathan_luck_and_pluck",
		"BattleStarted envia skillIds na ordem equipada da fixture",
	);
	sessionSideA.setAtb(ATB_MAX);
	(sessions as unknown as { handleSkillRequest(player: Player, slot: SkillSlot): void }).handleSkillRequest(p1, 1);
	sessions.step(0.5);
	assertInvariant(attacks.size() === 1 && attacks[0].slot === 1 && attacks[0].skillId === "jonathan_hamon_breathing", "AttackStarted envia skillId estável");
	sessions.requestQuit(p1);

	print("JONATHAN_N31_PASSED");
}
