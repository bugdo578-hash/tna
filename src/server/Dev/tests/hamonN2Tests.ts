import { Players } from "@rbxts/services";
import {
	ATB_MAX, BASE_ATB_SPEED, FLOAT_TOLERANCE,
	HAMON_DEFAULT_DURATION_SECONDS, HAMON_DEFAULT_MAX_CHARGES, HAMON_DEFAULT_SLOT_MULTIPLIERS,
} from "../../../shared/Config";
import { calcDano, calcSkillSlotRoll } from "../../../shared/MathUtils";
import type { BattleEndedPayload, EffectAppliedPayload, EffectExpiredPayload, HitResolvedPayload } from "../../../shared/Remotes";
import type { SkillDataSlots } from "../../../shared/SkillData";
import type { HamonConfig, SkillSlot, SkillSlots, StatBlock, StatusEffect } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { BattleService, type EffectAppliedEvent, type HitResolvedEvent } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import type { BattleRemoteAdapter } from "../../Services/RemoteService";
import { createDummySide, makeDummyFighter } from "../DummyFighters";
import { assertInvariant, createSurgicalMockAdapter } from "./testHelpers";

const hitNoCritRng = () => 0.99;

function makeSyntheticHamonSkills(hamonConfig?: HamonConfig): SkillDataSlots {
	return [
		{
			name: "Hamon_Single", prepareTime: 0.2,
			hits: [{ time: 0.1, damageShare: 1, followUp: false }],
			returnTime: 0.25, dodgeReturnTime: 0.1,
		},
		{
			name: "Hamon_Barrage_3", prepareTime: 0.3,
			hits: [
				{ time: 0.1, damageShare: 1 / 3, followUp: true },
				{ time: 0.25, damageShare: 1 / 3, followUp: true },
				{ time: 0.4, damageShare: 1 / 3, followUp: false },
			],
			returnTime: 0.3, dodgeReturnTime: 0.15, hamonStatusEffects: ["Burn"],
		},
		{
			name: "Hamon_Charge", prepareTime: 0.35,
			hits: [{ time: 0.2, damageShare: 0, followUp: false, kind: "self", noDamage: true }],
			returnTime: 0.3, dodgeReturnTime: 0.15, effectTarget: "self", statusEffects: ["Hamon"], hamonConfig,
		},
	];
}

function makeSyntheticHamonFighter(
	fighterId = "synthetic_hamon", hamonConfig?: HamonConfig, customSkills?: SkillDataSlots,
): Fighter {
	const stats: StatBlock = { hp: 500, atk: 20, dodge: 0, crit: 0 };
	const slots: SkillSlots = [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.5)];
	return new Fighter({
		fighterId, hp: 500, hpMax: 500, stats, level: 10, className: "Dominator", slots,
		skillData: customSkills ?? makeSyntheticHamonSkills(hamonConfig),
		currentAtbSpeed: BASE_ATB_SPEED, hamonConfig,
	});
}

function makeHighHpDefender(dodge = 0): Fighter {
	const base = makeDummyFighter("Controller");
	return new Fighter({
		fighterId: "target_dummy", hp: 2000, hpMax: 2000,
		stats: { hp: 2000, atk: 10, dodge, crit: 0 }, level: 10,
		className: base.className, slots: base.slots, skillData: base.skillData, currentAtbSpeed: BASE_ATB_SPEED,
	});
}

export function validateN2HamonSystem(): void {
	// 1, 2, 3 & Contrato Skill Sem Dano (Dodge 100% no alvo não afeta a carga; resolve dano 0; aplica em si mesmo; volta a IDLE)
	{
		const attacker = makeSyntheticHamonFighter();
		const ally = makeDummyFighter("Support");
		const defender = makeHighHpDefender(100);
		const sideA = new BattleSide([attacker, ally], () => 0);
		const sideB = new BattleSide([defender], () => 0);
		const battle = new BattleService(sideA, sideB, () => 0);

		const hits: HitResolvedEvent[] = [];
		const applied: EffectAppliedEvent[] = [];
		battle.events.hitResolved.connect((h) => hits.push(h));
		battle.events.effectApplied.connect((e) => applied.push(e));

		assertInvariant(attacker.applyStatusEffect("Hamon", 3, 100) === undefined, "applyStatusEffect não deve aceitar Hamon");

		sideA.setAtb(ATB_MAX);
		const s3Cost = attacker.slots[2].cost;
		assertInvariant(battle.requestSkill(sideA, 3), "S3 de carga deve ser aceita");
		assertInvariant(math.abs(sideA.atb - (ATB_MAX - s3Cost)) <= FLOAT_TOLERANCE, "S3 desconta custo de ATB");
		battle.step(0.35);
		assertInvariant(battle.state === "ATTACK", "S3 entra em ATTACK após prepareTime");
		battle.step(0.2);
		assertInvariant(hits.size() === 1, "S3 emite 1 HitResolved");
		assertInvariant(
			hits[0].hit && !hits[0].crit && hits[0].damage === 0 && hits[0].noDamage === true &&
				!hits[0].followUpCancelled && hits[0].target === attacker,
			"hit sem dano da carga não rola Dodge nem crítico, tem dano 0, noDamage=true e não marca followUpCancelled",
		);
		assertInvariant(defender.hp === defender.hpMax, "S3 de carga não causa dano no inimigo");
		assertInvariant(
			attacker.hasHamon() &&
				attacker.getHamonCharges() === HAMON_DEFAULT_MAX_CHARGES &&
				attacker.getHamonMaxCharges() === HAMON_DEFAULT_MAX_CHARGES &&
				math.abs(attacker.getHamonRemainingDuration() - HAMON_DEFAULT_DURATION_SECONDS) <= FLOAT_TOLERANCE,
			"1. Ativação concede exatamente 3 cargas e duração de 30s no próprio atacante",
		);
		assertInvariant(!ally.hasHamon() && !defender.hasHamon(), "Hamon é exclusivo do fighter que ativou");
		assertInvariant(
			applied.size() === 1 && applied[0].target === attacker && applied[0].effect === "Hamon" &&
				!applied[0].renewed && applied[0].charges === 3 && applied[0].maxCharges === 3 && applied[0].duration === 30,
			"EffectApplied emitido para Hamon com charges=3, maxCharges=3, duration=30, renewed=false",
		);

		battle.step(0.3);
		assertInvariant(battle.state === "IDLE", "S3 conclui RETURN e restaura IDLE");

		// Item 2 & 3: Reativação com 1, 2 ou 3 cargas restaura exatamente 3 cargas e renova a duração
		for (const remainingBeforeReactivate of [1, 2, 3] as const) {
			attacker.getHamonEffect()!.charges = remainingBeforeReactivate;
			battle.step(5);
			assertInvariant(math.abs(attacker.getHamonRemainingDuration() - 25) <= FLOAT_TOLERANCE, "temporizador corre em IDLE");
			sideA.setAtb(ATB_MAX);
			assertInvariant(battle.requestSkill(sideA, 3), `reativação com ${remainingBeforeReactivate} carga(s) aceita`);
			battle.step(0.85);
			assertInvariant(battle.state === "IDLE", "volta a IDLE após reativação");
			assertInvariant(
				attacker.getHamonCharges() === 3 && attacker.getHamonMaxCharges() === 3 &&
					math.abs(attacker.getHamonRemainingDuration() - 30) <= FLOAT_TOLERANCE,
				`2/3. Reativação com ${remainingBeforeReactivate} carga(s) restaura 3 cargas e renova duração para 30s`,
			);
			const lastApplied = applied[applied.size() - 1];
			assertInvariant(
				lastApplied.effect === "Hamon" && lastApplied.renewed && lastApplied.charges === 3,
				"reativação emite EffectApplied com renewed=true e charges=3",
			);
		}
	}

	// 4, 5, 6, 7, 8, 9, 16: Consumo (1 em single-hit, 2 em multi-hit, 1 carga em multi-hit não consome nem dá bônus, 0 cargas normal, multiplicadores e duplicatas)
	{
		const offensiveSkills: SkillDataSlots = [
			makeSyntheticHamonSkills()[0],
			makeSyntheticHamonSkills()[1],
			{
				name: "Hamon_Offensive_S3", prepareTime: 0.2,
				hits: [{ time: 0.1, damageShare: 1, followUp: false }],
				returnTime: 0.2, dodgeReturnTime: 0.1,
			},
		];
		const attacker = makeSyntheticHamonFighter("hamon_offense", undefined, offensiveSkills);
		const defender = makeHighHpDefender(0);
		const sideA = new BattleSide([attacker], hitNoCritRng);
		const sideB = new BattleSide([defender], hitNoCritRng);
		const battle = new BattleService(sideA, sideB, hitNoCritRng);

		const hitDamages: number[] = [];
		const appliedEvents: EffectAppliedEvent[] = [];
		battle.events.hitResolved.connect((h) => hitDamages.push(h.damage));
		battle.events.effectApplied.connect((e) => appliedEvents.push(e));

		const expectedBaseDamage = (slot: SkillSlot, share: number, mult: number): number => {
			const base = calcDano(attacker.stats.atk, attacker.slots[slot - 1].mult, attacker.level) * share * mult;
			return math.max(math.round(base), 1);
		};

		// Item 7: Zero cargas -> dano normal
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 1), "S1 sem Hamon aceito");
		battle.step(0.55);
		const normalS1Damage = expectedBaseDamage(1, 1, 1);
		assertInvariant(
			hitDamages.size() === 1 && hitDamages[0] === normalS1Damage && attacker.getHamonCharges() === 0,
			`7. Zero cargas causa dano normal (${normalS1Damage})`,
		);

		// Item 4, 8 (Slot 1 ×1.30) & 16 (requisições duplicadas)
		attacker.applyHamon();
		hitDamages.clear();
		appliedEvents.clear();
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 1), "S1 com Hamon aceito");
		assertInvariant(!battle.requestSkill(sideA, 1), "16. Requisição duplicada em PREPARE rejeitada");
		assertInvariant(attacker.getHamonCharges() === 2, "4/16. Exatamente 1 carga consumida para ataque simples");
		assertInvariant(
			appliedEvents.size() === 1 && appliedEvents[0].effect === "Hamon" && appliedEvents[0].charges === 2,
			"mudança de cargas no consumo gera atualização EffectApplied para o HUD com charges=2",
		);
		battle.step(0.25);
		assertInvariant(!battle.requestSkill(sideA, 1), "16. Requisição duplicada em ATTACK rejeitada");
		assertInvariant(attacker.getHamonCharges() === 2, "16. Cargas permanecem em 2 durante ATTACK");
		battle.step(0.5);
		assertInvariant(battle.state === "IDLE", "volta a IDLE após S1");
		const hamonS1Damage = expectedBaseDamage(1, 1, HAMON_DEFAULT_SLOT_MULTIPLIERS[1]);
		assertInvariant(
			hitDamages.size() === 1 && hitDamages[0] === hamonS1Damage && hamonS1Damage > normalS1Damage,
			`4/8. S1 com Hamon aplica multiplicador ×1.30 no dano base (${hamonS1Damage} vs ${normalS1Damage})`,
		);

		// Item 5, 8 (Slot 2 ×1.80) & 9 (3 hits mesmo bônus)
		hitDamages.clear();
		appliedEvents.clear();
		defender.statusEffects.clear();
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 2), "S2 multi-hit com 2 cargas aceito");
		assertInvariant(attacker.getHamonCharges() === 0, "5. Multi-hit consome 2 cargas uma única vez no início do ataque");
		assertInvariant(
			appliedEvents.size() === 1 && appliedEvents[0].effect === "Hamon" && appliedEvents[0].charges === 0,
			"consumo de 2 cargas notifica HUD com charges=0",
		);
		battle.step(1.1);
		assertInvariant(battle.state === "IDLE", "volta a IDLE após S2");
		const expectedS2Hit = expectedBaseDamage(2, 1 / 3, HAMON_DEFAULT_SLOT_MULTIPLIERS[2]);
		assertInvariant(
			hitDamages.size() === 3 &&
				hitDamages[0] === expectedS2Hit && hitDamages[1] === expectedS2Hit && hitDamages[2] === expectedS2Hit,
			`5/8/9. Todos os 3 hits recebem o mesmo bônus ×1.80 (${expectedS2Hit}) de uma única ativação`,
		);
		assertInvariant(defender.hasStatusEffect("Burn"), "5. Efeito condicional ao Hamon (Burn) aplicado quando Hamon foi consumido");

		// Item 6 (Exemplo obrigatório): 1 carga restante + S2 de 3 hits -> executa 3 hits com dano normal, conserva 1 carga, sem Burn condicional
		attacker.applyHamon({ initialCharges: 1, maxCharges: 3 });
		hitDamages.clear();
		appliedEvents.clear();
		defender.statusEffects.clear();
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 2), "6. S2 com apenas 1 carga executa normalmente");
		assertInvariant(attacker.getHamonCharges() === 1, "6. S2 com 1 carga não consome a carga restante");
		battle.step(1.1);
		assertInvariant(battle.state === "IDLE", "volta a IDLE após S2 sem bônus");
		const normalS2Hit = expectedBaseDamage(2, 1 / 3, 1);
		assertInvariant(
			hitDamages.size() === 3 &&
				hitDamages[0] === normalS2Hit && hitDamages[1] === normalS2Hit && hitDamages[2] === normalS2Hit &&
				attacker.getHamonCharges() === 1 && !defender.hasStatusEffect("Burn") && appliedEvents.size() === 0,
			"6. Multi-hit com 1 carga causa dano normal nos 3 hits, preserva a carga e não aplica bônus nem Burn condicional",
		);

		// Item 8 (Slot 3 ×2.20)
		hitDamages.clear();
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 3), "8. S3 ofensiva de 1 hit com 1 carga aceita");
		assertInvariant(attacker.getHamonCharges() === 0, "8. S3 ofensiva de 1 hit consome a 1 carga restante");
		battle.step(0.5);
		const expectedS3Damage = expectedBaseDamage(3, 1, HAMON_DEFAULT_SLOT_MULTIPLIERS[3]);
		assertInvariant(
			hitDamages.size() === 1 && hitDamages[0] === expectedS3Damage,
			`8. Slot 3 aplica multiplicador ×2.20 (${expectedS3Damage})`,
		);

		attacker.applyHamon();
		sideA.setAtb(0);
		assertInvariant(!battle.requestSkill(sideA, 1) && attacker.getHamonCharges() === 3, "requisição rejeitada não consome cargas");
	}

	// 10 & 11: Expiração após o tempo configurado e expiração durante multi-hit sem modificar os hits já confirmados
	{
		const attacker = makeSyntheticHamonFighter("hamon_timer", { durationSeconds: 5 });
		const defender = makeHighHpDefender(0);
		const sideA = new BattleSide([attacker], hitNoCritRng);
		const sideB = new BattleSide([defender], hitNoCritRng);
		const battle = new BattleService(sideA, sideB, hitNoCritRng);

		const expired: StatusEffect[] = [];
		const hitDamages: number[] = [];
		battle.events.effectExpired.connect(({ target, effect }) => { if (target === attacker) expired.push(effect); });
		battle.events.hitResolved.connect((h) => hitDamages.push(h.damage));

		attacker.applyHamon();
		battle.step(4.9);
		assertInvariant(attacker.hasHamon() && expired.size() === 0, "ainda ativo em 4.9s de IDLE");

		// Item 11: Inicia S2 (3 hits); mesmo se o buff expirar após o Hit 1, os Hits 2 e 3 mantêm o bônus congelado
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 2) && attacker.getHamonCharges() === 1, "S2 iniciado faltando 0.1s");
		battle.step(0.45);
		assertInvariant(battle.state === "ATTACK" && hitDamages.size() === 1, "Hit 1 resolvido");
		attacker.statusEffects.delete("Hamon");
		assertInvariant(!attacker.hasHamon(), "Hamon removido durante a resolução do multi-hit");
		battle.step(0.7);
		assertInvariant(battle.state === "IDLE", "S2 concluído e voltou a IDLE");
		const expectedBoostedHit = math.max(
			math.round(calcDano(attacker.stats.atk, attacker.slots[1].mult, attacker.level) * (1 / 3) * HAMON_DEFAULT_SLOT_MULTIPLIERS[2]),
			1,
		);
		assertInvariant(
			hitDamages.size() === 3 &&
				hitDamages[0] === expectedBoostedHit && hitDamages[1] === expectedBoostedHit && hitDamages[2] === expectedBoostedHit,
			"11. Bônus calculado no início permanece congelado para todos os hits mesmo se o buff expirar durante a resolução",
		);

		// Item 10: Expiração natural após o tempo configurado em IDLE
		attacker.applyHamon({ durationSeconds: 4 });
		battle.step(3.5);
		assertInvariant(attacker.hasHamon() && attacker.getHamonCharges() === 3, "ainda ativo aos 3.5s");
		battle.step(0.6);
		assertInvariant(
			!attacker.hasHamon() && attacker.getHamonCharges() === 0 && !attacker.hasStatusEffect("Hamon") && expired.includes("Hamon"),
			"10. Expiração remove o buff, zera as cargas restantes e emite EffectExpired",
		);
	}

	// 12 & 13: Troca de fighter preservando cargas/duração e KO limpando TODOS os efeitos
	{
		const fighter1 = makeSyntheticHamonFighter("hamon_switch_1");
		const fighter2 = makeDummyFighter("Fury");
		const defender = makeHighHpDefender(0);
		const sideA = new BattleSide([fighter1, fighter2], hitNoCritRng);
		const sideB = new BattleSide([defender], hitNoCritRng);
		const battle = new BattleService(sideA, sideB, hitNoCritRng);

		fighter1.applyHamon();
		sideA.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideA, 1), "consome 1 carga antes de trocar");
		battle.step(0.55);
		assertInvariant(fighter1.getHamonCharges() === 2, "fighter1 tem 2 cargas");

		assertInvariant(battle.requestSwitch(sideA, 1), "12. Troca para fighter2 em IDLE");
		assertInvariant(sideA.getActiveFighter() === fighter2 && !fighter2.hasHamon(), "fighter2 não recebe Hamon de fighter1");
		battle.step(2.0);
		assertInvariant(
			fighter1.hasHamon() && fighter1.getHamonCharges() === 2 &&
				math.abs(fighter1.getHamonRemainingDuration() - 28) <= FLOAT_TOLERANCE,
			"12. Troca preserva as 2 cargas do fighter1 enquanto vivo",
		);
		assertInvariant(battle.requestSwitch(sideA, 0) && fighter1.getHamonCharges() === 2, "12. Fighter1 retorna com 2 cargas");

		// Item 13: KO limpa Hamon e TODOS os efeitos do morto
		fighter1.applyStatusEffect("Burn", 1, 20);
		fighter1.applyStatusEffect("Bleed", 1, 20);
		fighter1.applyStatusEffect("Root", 1, 20);
		assertInvariant(fighter1.statusEffects.size() === 4, "fighter1 possui Burn, Bleed, Root e Hamon ativos");
		fighter1.hp = 1;
		sideB.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(sideB, 1), "inimigo ataca para nocautear fighter1");
		battle.step(1.0);
		assertInvariant(
			!fighter1.isAlive() && fighter1.statusEffects.size() === 0 && !fighter1.hasHamon() && fighter1.getHamonCharges() === 0,
			"13. KO remove Hamon e limpa TODOS os efeitos do lutador morto",
		);
	}

	// 14 & 15: PvE e PvP sem mistura de estados, Pause congelando Hamon, Quit/teardown e nova batalha sem resíduos
	{
		const p1 = { Parent: Players, Name: "N2P1", UserId: 2201 } as unknown as Player;
		const p2 = { Parent: Players, Name: "N2P2", UserId: 2202 } as unknown as Player;
		const p3 = { Parent: Players, Name: "N2P3", UserId: 2203 } as unknown as Player;

		const appliedByPlayer = new Map<Player, EffectAppliedPayload[]>();
		const expiredByPlayer = new Map<Player, EffectExpiredPayload[]>();
		const hitsByPlayer = new Map<Player, HitResolvedPayload[]>();
		const ended: BattleEndedPayload[] = [];

		const pushTo = <T extends defined>(map: Map<Player, T[]>, player: Player, item: T): void => {
			let list = map.get(player);
			if (list === undefined) {
				list = [];
				map.set(player, list);
			}
			list.push(item);
		};

		const adapter: BattleRemoteAdapter = {
			...createSurgicalMockAdapter({ onBattleEnded: (_, payload) => ended.push(payload) }),
			sendEffectApplied(player, payload) { pushTo(appliedByPlayer, player, payload); },
			sendEffectExpired(player, payload) { pushTo(expiredByPlayer, player, payload); },
			sendHitResolved(player, payload) { pushTo(hitsByPlayer, player, payload); },
		};

		const sessions = new BattleSessionService(adapter);
		const req = sessions as unknown as { handleSkillRequest(player: Player, slot: SkillSlot): void };

		const pveFighter = makeSyntheticHamonFighter("pve_hamon", { durationSeconds: 10 });
		const pveSideA = new BattleSide([pveFighter], hitNoCritRng);
		const pveSideB = new BattleSide([makeHighHpDefender(0)], hitNoCritRng);

		const pvpFighterA = makeSyntheticHamonFighter("pvp_hamon_a", { durationSeconds: 6, maxCharges: 3 });
		const pvpFighterB = makeSyntheticHamonFighter("pvp_hamon_b", { durationSeconds: 12, maxCharges: 3 });
		const pvpSideA = new BattleSide([pvpFighterA], hitNoCritRng);
		const pvpSideB = new BattleSide([pvpFighterB], hitNoCritRng);

		assertInvariant(sessions.createSession(p1, undefined, pveSideA, pveSideB, hitNoCritRng, "PVE"), "cria PvE");
		assertInvariant(sessions.createSession(p2, p3, pvpSideA, pvpSideB, hitNoCritRng, "PVP"), "cria PvP");

		pveSideA.setAtb(ATB_MAX);
		pvpSideA.setAtb(ATB_MAX);
		req.handleSkillRequest(p1, 3);
		req.handleSkillRequest(p2, 3);
		sessions.step(0.9);

		assertInvariant(
			pveFighter.hasHamon() && pveFighter.getHamonCharges() === 3 &&
				pvpFighterA.hasHamon() && pvpFighterA.getHamonCharges() === 3 && !pvpFighterB.hasHamon(),
			"14. PvE e PvP ativam Hamon isoladamente por lutador e sessão",
		);

		const pveRemainingBeforePause = pveFighter.getHamonRemainingDuration();
		assertInvariant(sessions.requestPause(p1), "pausa PvE");
		sessions.step(7.0);
		assertInvariant(
			pveFighter.hasHamon() && math.abs(pveFighter.getHamonRemainingDuration() - pveRemainingBeforePause) <= FLOAT_TOLERANCE,
			"temporizador de Hamon congela durante Pause no PvE",
		);
		assertInvariant(
			!pvpFighterA.hasHamon() &&
				(expiredByPlayer.get(p2)?.some((e) => e.effect === "Hamon") ?? false) &&
				(expiredByPlayer.get(p3)?.some((e) => e.effect === "Hamon") ?? false) &&
				(expiredByPlayer.get(p1)?.size() ?? 0) === 0,
			"14. Expiração do Hamon no PvP não afeta a sessão PvE pausada",
		);

		assertInvariant(sessions.requestQuit(p1) && sessions.requestQuit(p2), "15. Quit encerra PvE e PvP");
		assertInvariant(!sessions.hasActiveSession(p1) && !sessions.hasActiveSession(p2) && !sessions.hasActiveSession(p3), "15. Sessões limpas");

		appliedByPlayer.clear();
		expiredByPlayer.clear();
		const freshFighter = makeSyntheticHamonFighter("fresh_hamon");
		const freshSideA = new BattleSide([freshFighter], hitNoCritRng);
		const freshSideB = createDummySide(hitNoCritRng);
		assertInvariant(sessions.createSession(p1, undefined, freshSideA, freshSideB, hitNoCritRng, "PVE"), "15. Nova batalha criada");
		assertInvariant(
			!freshFighter.hasHamon() && freshFighter.getHamonCharges() === 0 && (appliedByPlayer.get(p1)?.size() ?? 0) === 0,
			"15. Nova batalha inicia sem resíduos de Hamon da sessão anterior",
		);
		sessions.step(20);
		assertInvariant((expiredByPlayer.get(p1)?.size() ?? 0) === 0, "15. Nenhum EffectExpired fantasma da sessão anterior");
		sessions.requestQuit(p1);
	}

	// 17: Dois fighters sintéticos diferentes usando configurações independentes de Hamon
	{
		const customConfigA: HamonConfig = { maxCharges: 3, durationSeconds: 15, slotMultipliers: { 1: 1.5, 2: 2.0, 3: 2.5 } };
		const customConfigB: HamonConfig = { maxCharges: 4, durationSeconds: 45, slotMultipliers: { 1: 1.15, 2: 1.4, 3: 1.75 } };
		const fighterA = makeSyntheticHamonFighter("synth_hamon_a", customConfigA);
		const fighterB = makeSyntheticHamonFighter("synth_hamon_b", customConfigB);
		const sideA = new BattleSide([fighterA], hitNoCritRng);
		const sideB = new BattleSide([fighterB], hitNoCritRng);
		const battleA = new BattleService(sideA, new BattleSide([makeHighHpDefender(0)], hitNoCritRng), hitNoCritRng);
		const battleB = new BattleService(sideB, new BattleSide([makeHighHpDefender(0)], hitNoCritRng), hitNoCritRng);

		sideA.setAtb(ATB_MAX);
		sideB.setAtb(ATB_MAX);
		assertInvariant(battleA.requestSkill(sideA, 3) && battleB.requestSkill(sideB, 3), "17. Ambos ativam Hamon via S3");
		battleA.step(0.85);
		battleB.step(0.85);

		assertInvariant(
			fighterA.getHamonCharges() === 3 && fighterA.getHamonMaxCharges() === 3 &&
				math.abs(fighterA.getHamonRemainingDuration() - 15) <= FLOAT_TOLERANCE &&
				fighterA.getHamonSlotMultiplier(1) === 1.5 && fighterA.getHamonSlotMultiplier(2) === 2.0 && fighterA.getHamonSlotMultiplier(3) === 2.5,
			"17. Fighter A usa sua configuração própria (3 cargas, 15s, ×1.5/×2.0/×2.5)",
		);
		assertInvariant(
			fighterB.getHamonCharges() === 4 && fighterB.getHamonMaxCharges() === 4 &&
				math.abs(fighterB.getHamonRemainingDuration() - 45) <= FLOAT_TOLERANCE &&
				fighterB.getHamonSlotMultiplier(1) === 1.15 && fighterB.getHamonSlotMultiplier(2) === 1.4 && fighterB.getHamonSlotMultiplier(3) === 1.75,
			"17. Fighter B usa sua configuração própria (4 cargas, 45s, ×1.15/×1.4/×1.75)",
		);

		let dmgA = 0;
		let dmgB = 0;
		battleA.events.hitResolved.connect((h) => { dmgA = h.damage; });
		battleB.events.hitResolved.connect((h) => { dmgB = h.damage; });
		sideA.setAtb(ATB_MAX);
		sideB.setAtb(ATB_MAX);
		assertInvariant(battleA.requestSkill(sideA, 1) && battleB.requestSkill(sideB, 1), "17. Ambos usam S1");
		battleA.step(0.55);
		battleB.step(0.55);
		const expectedA = math.round(calcDano(fighterA.stats.atk, fighterA.slots[0].mult, fighterA.level) * 1.5);
		const expectedB = math.round(calcDano(fighterB.stats.atk, fighterB.slots[0].mult, fighterB.level) * 1.15);
		assertInvariant(
			dmgA === expectedA && dmgB === expectedB && dmgA !== dmgB &&
				fighterA.getHamonCharges() === 2 && fighterB.getHamonCharges() === 3,
			"17. Multiplicadores e cargas de dois fighters sintéticos operam de forma totalmente independente",
		);
	}

	print("N2_HAMON_SYSTEM_PASSED");
}
