import { Players } from "@rbxts/services";
import { ATB_MAX, BATTLE_INACTIVITY_TIMEOUT_SECONDS, FLOAT_TOLERANCE } from "../../../shared/Config";
import type { BattleEndedPayload, EffectAppliedPayload, EffectExpiredPayload, EffectTickPayload } from "../../../shared/Remotes";
import type { BattleGlobalState, SkillSlot } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { BattleService, type EffectAppliedEvent, type EffectTickEvent } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import type { BattleRemoteAdapter } from "../../Services/RemoteService";
import { createDummySide, DUMMY_SKILL_DATA, makeDummyFighter } from "../DummyFighters";
import { assertInvariant, createSurgicalMockAdapter } from "./testHelpers";

const hitRng = () => 0.99;

export function validateN1DotSkillTimeline(): void {
	const attacker = new Fighter({
		...makeDummyFighter("Fury"),
		skillData: [
			{
				prepareTime: 1,
				hits: [
					{ time: 0.25, damageShare: 0.5, followUp: true, statusEffects: ["Burn"] },
					{ time: 0.75, damageShare: 0.5, followUp: false },
				],
				returnTime: 1,
				dodgeReturnTime: 0.25,
				statusEffects: ["Bleed"],
			},
			DUMMY_SKILL_DATA[1],
			DUMMY_SKILL_DATA[2],
		],
	});
	const attackers = new BattleSide([attacker], hitRng);
	const defenders = createDummySide(hitRng);
	const target = defenders.getActiveFighter();
	const battle = new BattleService(attackers, defenders, hitRng);
	const applications: EffectAppliedEvent[] = [];
	const ticks: EffectTickEvent[] = [];
	battle.events.effectApplied.connect((event) => applications.push(event));
	battle.events.effectTick.connect((event) => ticks.push(event));

	const advance = (dt: number, phase: BattleGlobalState): void => {
		const burn = target.statusEffects.get("Burn");
		const bleed = target.statusEffects.get("Bleed");
		const burnElapsed = burn?.kind === "dot" ? burn.elapsed : undefined;
		const bleedElapsed = bleed?.kind === "dot" ? bleed.elapsed : undefined;
		battle.step(dt);
		assertInvariant(battle.state === phase, `fase esperada ${phase}, atual ${battle.state}`);
		assertInvariant(ticks.size() === 0, `DoT avançou durante a timeline (${phase})`);
		if (burn?.kind === "dot") assertInvariant(burn.elapsed === burnElapsed, "relógio de Burn deve ficar congelado");
		if (bleed?.kind === "dot") assertInvariant(bleed.elapsed === bleedElapsed, "relógio de Bleed deve ficar congelado");
	};
	for (const attackIndex of $range(0, 1)) {
		attackers.setAtb(ATB_MAX);
		assertInvariant(battle.requestSkill(attackers, 1), "ataque multi-hit aceito");
		assertInvariant(!battle.requestSkill(attackers, 1), "pedido duplicado durante PREPARE recusado");
		const hpBefore = target.hp;
		advance(0.75, "PREPARE");
		assertInvariant(!battle.requestSwitch(defenders, 1), "troca recusada durante PREPARE");
		advance(0.25, "ATTACK");
		advance(0.25, "ATTACK");
		const burn = applications[attackIndex * 2];
		assertInvariant(
			applications.size() === attackIndex * 2 + 1 &&
				burn.target === target && burn.effect === "Burn" && burn.duration === 3 &&
				burn.renewed === (attackIndex === 1) &&
				math.abs(burn.totalDamage - (hpBefore - target.hp) * 0.2) <= FLOAT_TOLERANCE,
			"Burn usa somente o dano real do hit que o declarou",
		);
		assertInvariant(!battle.requestSwitch(defenders, 1), "troca recusada durante ATTACK");
		advance(0.5, "RETURN");
		const bleed = applications[attackIndex * 2 + 1];
		assertInvariant(
			applications.size() === (attackIndex + 1) * 2 &&
				bleed.target === target && bleed.effect === "Bleed" && bleed.duration === 3 &&
				bleed.renewed === (attackIndex === 1) &&
				math.abs(bleed.totalDamage - (hpBefore - target.hp) * 0.25) <= FLOAT_TOLERANCE,
			"Bleed usa a soma dos hits conectados uma vez por skill",
		);
		assertInvariant(!battle.requestSwitch(defenders, 1), "troca recusada durante RETURN");
		advance(0.75, "RETURN");
		advance(0.25, "IDLE");
		battle.step(0.75);
		assertInvariant(ticks.size() === 0 && target.statusEffects.size() === 2, "cada efeito renova o seu relógio sem empilhar");
		for (const [, effect] of target.statusEffects) {
			assertInvariant(effect.kind === "dot" && effect.remainingTicks === 3 && effect.elapsed === 0.75,
				"PREPARE, ATTACK e RETURN não consomem tempo do DoT");
		}
	}

	const dodging = createDummySide(hitRng);
	const missedBattle = new BattleService(attackers, dodging, () => 0);
	const dodgeTarget = dodging.getActiveFighter();
	let missedHits = 0;
	missedBattle.events.hitResolved.connect(({ hit }) => {
		if (!hit) missedHits += 1;
	});
	attackers.setAtb(ATB_MAX);
	assertInvariant(missedBattle.requestSkill(attackers, 1), "ataque para testar esquiva aceito");
	missedBattle.step(3);
	assertInvariant(missedHits === 2 && dodgeTarget.hp === dodgeTarget.hpMax && dodgeTarget.statusEffects.size() === 0,
		"hits esquivados não aplicam DoT por hit nem por skill");
	print("N1_DOT_SKILL_TIMELINE_PASSED");
}

export function validateN1DotTicks(): void {
	const sourceSide = createDummySide(hitRng);
	const targetSide = createDummySide(hitRng);
	const target = targetSide.getActiveFighter();
	const battle = new BattleService(sourceSide, targetSide, hitRng);
	const ticks: EffectTickEvent[] = [];
	const expirations: string[] = [];
	battle.events.effectTick.connect((tick) => ticks.push(tick));
	battle.events.effectExpired.connect(({ target: expiredTarget, effect }) => {
		assertInvariant(expiredTarget === target && !target.hasStatusEffect(effect), "expiração remove o status antes de notificar");
		expirations.push(effect);
	});

	assertInvariant(target.applyStatusEffect("Burn", 1, 0) === undefined, "Burn exige dano real positivo");
	target.applyStatusEffect("Burn", 1, 30);
	target.applyStatusEffect("Bleed", 1, 30);
	battle.step(0.75);
	assertInvariant(ticks.size() === 0 && target.hp === 100, "nenhum tick antes de 1 segundo de IDLE");
	battle.step(0.25);
	battle.step(0);
	assertInvariant(ticks.size() === 2 && target.hp === 96, "cada efeito faz exatamente um tick no primeiro segundo");
	assertInvariant(battle.requestSwitch(targetSide, 1), "troca aceita em IDLE com Burn e Bleed ativos");
	const active = targetSide.getActiveFighter();
	battle.step(2.75);
	assertInvariant(ticks.size() === 6 && target.hp === 86 && active.hp === active.hpMax,
		"catch-up consome apenas os ticks restantes do reserva sem atingir o novo ativo");
	const expected = [
		["Bleed", 2, 2], ["Burn", 2, 2],
		["Bleed", 3, 1], ["Bleed", 3, 0], ["Burn", 2, 1], ["Burn", 2, 0],
	] as const;
	for (const [index, tick] of ipairs(ticks)) {
		const [effect, damage, remainingTicks] = expected[index - 1];
		assertInvariant(tick.target === target && tick.effect === effect && tick.damage === damage && tick.remainingTicks === remainingTicks,
			`tick ${index} deve seguir a ordem e o acúmulo existentes`);
	}
	battle.step(5);
	assertInvariant(expirations.size() === 2 && expirations.includes("Burn") && expirations.includes("Bleed") && ticks.size() === 6,
		"cada efeito expira uma vez e para de emitir ticks");
	print("N1_DOT_TICKS_PASSED");
}

export function validateN1DotSessions(): void {
	const firstPlayer = { Parent: Players, Name: "N1First", UserId: 501 } as unknown as Player;
	const secondPlayer = { Parent: Players, Name: "N1Second", UserId: 502 } as unknown as Player;
	const applied: Array<{ player: Player; payload: EffectAppliedPayload }> = [];
	const ticks: Array<{ player: Player; payload: EffectTickPayload }> = [];
	const expired: Array<{ player: Player; payload: EffectExpiredPayload }> = [];
	const ended: BattleEndedPayload[] = [];
	const adapter: BattleRemoteAdapter = {
		...createSurgicalMockAdapter({ onBattleEnded: (_, payload) => ended.push(payload) }),
		sendEffectApplied(player, payload) { applied.push({ player, payload }); },
		sendEffectTick(player, payload) { ticks.push({ player, payload }); },
		sendEffectExpired(player, payload) { expired.push({ player, payload }); },
	};
	const sessions = new BattleSessionService(adapter);
	const requestSkill = sessions as unknown as { handleSkillRequest(player: Player, slot: SkillSlot): void };
	for (const mode of ["PVE", "PVP"] as const) {
		const opponent = mode === "PVP" ? secondPlayer : undefined;
		const attacker = createDummySide(hitRng);
		const defender = createDummySide(hitRng);
		const target = defender.getActiveFighter();
		const recipients = opponent === undefined ? [firstPlayer] : [firstPlayer, secondPlayer];
		applied.clear();
		ticks.clear();
		expired.clear();
		assertInvariant(sessions.createSession(firstPlayer, opponent, attacker, defender, hitRng, mode), `cria ${mode}`);
		attacker.setAtb(ATB_MAX);
		requestSkill.handleSkillRequest(firstPlayer, 2);
		sessions.step(1.25); // 0.9s da skill + 0.35s em IDLE
		const hpBeforeTicks = target.hp;
		assertInvariant(hpBeforeTicks < target.hpMax && applied.size() === recipients.size(), `${mode} aplica Burn no servidor`);
		const targetId = applied[0].payload.targetId;
		assertInvariant(targetId !== "", "alvo possui ID de sessão");
		const paused = sessions.requestPause(firstPlayer);
		assertInvariant(paused === (mode === "PVE"), "Pause é aceito apenas no PvE");
		if (paused) {
			sessions.step(4);
			assertInvariant(target.hp === hpBeforeTicks && ticks.size() === 0 && expired.size() === 0, "Pause congela DoT pendente");
			assertInvariant(sessions.requestPause(firstPlayer), "retoma PvE");
		}
		sessions.step(2.5);
		assertInvariant(target.hasStatusEffect("Burn"), "o DoT ainda não completou três segundos de IDLE");
		sessions.step(0.25);
		const damageToEachClient = (player: Player): number => ticks
			.filter((tick) => tick.player === player)
			.reduce((total, tick) => {
				assertInvariant(tick.payload.effect === "Burn" && tick.payload.targetId === targetId && tick.payload.damage > 0,
					"tick privado deve identificar efeito e alvo, com dano positivo");
				return total + tick.payload.damage;
			}, 0);
		for (const player of recipients) {
			assertInvariant(applied.some((event) => event.player === player && event.payload.effect === "Burn" &&
				event.payload.targetId === targetId && event.payload.duration === 3 && !event.payload.renewed),
				"cada participante recebe a aplicação autoritativa");
			assertInvariant(expired.some((event) => event.player === player && event.payload.targetId === targetId && event.payload.effect === "Burn"),
				"cada participante recebe a expiração autoritativa");
			assertInvariant(damageToEachClient(player) === hpBeforeTicks - target.hp && target.hp < hpBeforeTicks,
				"cada participante recebe o mesmo dano descontado do HP");
		}
		assertInvariant(expired.size() === recipients.size() && !target.hasStatusEffect("Burn"), "Burn expira uma vez por participante");
		assertInvariant(sessions.requestQuit(firstPlayer), "fecha sessão após expiração");
	}

	for (const reason of ["quit", "timeout"] as const) {
		applied.clear();
		ticks.clear();
		expired.clear();
		const side = createDummySide(hitRng);
		const oldTarget = side.getActiveFighter();
		assertInvariant(sessions.createSession(firstPlayer, undefined, side, createDummySide(hitRng), hitRng), "cria sessão para cancelamento");
		if (reason === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS - 1.25);
		oldTarget.applyStatusEffect("Bleed", 1, 12);
		sessions.step(1);
		assertInvariant(ticks.size() === 1 && oldTarget.hp === 99, "cancelamento começa após o primeiro tick de três");
		const oldTargetId = ticks[0].payload.targetId;
		if (reason === "quit") {
			assertInvariant(sessions.requestPause(firstPlayer) && sessions.requestQuit(firstPlayer), "Quit encerra mesmo durante Pause");
		} else {
			sessions.step(0.25);
		}
		assertInvariant(ended[ended.size() - 1].reason === reason && !sessions.hasActiveSession(firstPlayer), `sessão encerra por ${reason}`);
		assertInvariant(ticks.size() === 1 && expired.size() === 0, "encerramento cancela os ticks pendentes");
		ticks.clear();
		const newSide = createDummySide(hitRng);
		const newTarget = newSide.getActiveFighter();
		assertInvariant(sessions.createSession(firstPlayer, undefined, newSide, createDummySide(hitRng), hitRng), "nova luta após cancelamento");
		newTarget.applyStatusEffect("Burn", 1, 15);
		sessions.step(3);
		assertInvariant(oldTarget.hp === 99 && newTarget.hp === 97 && ticks.size() === 3 && expired.size() === 1 &&
			expired[0].payload.targetId !== oldTargetId && ticks.every(({ payload }) =>
				payload.effect === "Burn" && payload.targetId === expired[0].payload.targetId),
			"apenas a nova luta pode emitir ticks e expiração depois do cancelamento");
		sessions.requestQuit(firstPlayer);
	}
	print("N1_DOT_SESSIONS_PASSED");
}
