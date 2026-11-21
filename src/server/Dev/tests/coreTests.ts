// Testes do núcleo de batalha, IA Bronze, efeitos, pause/quit, crítico, multi-hit, dia/noite, rate limit e 2.000 lutas.
import { Players } from "@rbxts/services";
import { CLASS_DATA, doesClassCounter } from "../../../shared/ClassData";
import {
	AI_BRONZE_SKILL_DELAY_MAX_SECONDS,
	AI_BRONZE_SKILL_DELAY_MIN_SECONDS,
	AI_BRONZE_TIMED_SWITCH_MAX_SECONDS,
	AI_BRONZE_TIMED_SWITCH_MIN_SECONDS,
	AI_BRONZE_ULTIMATE_DELAY_MAX_SECONDS,
	AI_BRONZE_ULTIMATE_DELAY_MIN_SECONDS,
	ALLOCATE_REQUEST_BUCKET_CAPACITY,
	ALLOCATE_REQUEST_REFILL_PER_SECOND,
	ATB_MAX,
	ATB_MIN,
	BATTLE_REQUEST_BUCKET_CAPACITY,
	BATTLE_REQUEST_REFILL_PER_SECOND,
	BLEED_DAMAGE_SHARE,
	BURN_DAMAGE_SHARE,
	CRIT_MULTIPLIER,
	DAY_NIGHT_ATTRIBUTES,
	DAY_NIGHT_DEFAULT_DURATION_SECONDS,
	DAY_NIGHT_DEFAULT_START_HOUR,
	DAY_NIGHT_EPSILON,
	DOT_TICKS,
	FLOAT_TOLERANCE,
	MAX_ITEM_UUID_LENGTH,
	MAX_SKILL_SLOT,
	MIN_SKILL_SLOT,
	PVE_PAUSE_MAX_SECONDS,
	ROOT_DURATION_BY_SLOT,
} from "../../../shared/Config";
import {
	calcNightAlpha,
	calcSolarHour,
	DayNightCycleApplier,
	lerpColor3Gamma,
	shouldSkipInterpolation,
	smoothstepQuintic,
	type DayNightLightingLike,
} from "../../../shared/DayNightCycle";
import { FIGHTER_DATA } from "../../../shared/FighterData";
import { calcDano } from "../../../shared/MathUtils";
import type { BattleEndedPayload, BattleStartedPayload } from "../../../shared/Remotes";
import type { SkillSlot } from "../../../shared/TypeDefs";
import { BattleSide, type FighterIndex, type FighterLineup } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { AIService } from "../../Services/AIService";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { DamageService } from "../../Services/DamageService";
import { DayNightService } from "../../Services/DayNightService";
import { RemoteService, type BattleRemoteAdapter } from "../../Services/RemoteService";
import { createDummySide, createJotaroVsAnubisSides, makeDummyFighter, makeRealFighter } from "../DummyFighters";
import {
	assertInvariant,
	createSeededRng,
	createSurgicalMockAdapter,
	FIRST_SIMULATION_SEED,
	MAX_SIMULATION_STEPS,
	MIN_HIT_DAMAGE,
	runBattle,
	runBattleWithSides,
	SIMULATION_COUNT,
	SIMULATION_DT,
	type RemoteServiceTestInternals,
} from "./testHelpers";

export function validateStatusEffectRules(): void {
	const alwaysHitRng = () => 0.99;
	const sideA = createDummySide(alwaysHitRng);
	const sideB = createDummySide(alwaysHitRng);
	const battle = new BattleService(sideA, sideB, alwaysHitRng);
	const target = sideB.getActiveFighter();

	// 1. Não empilha + renova duração (Bleed, Burn, Root)
	const bleedFirst = target.applyStatusEffect("Bleed", 1, 10);
	assertInvariant(bleedFirst !== undefined && !bleedFirst.renewed, "1ª aplicação de Bleed deveria ser nova");
	const bleedEffect = target.statusEffects.get("Bleed");
	assertInvariant(bleedEffect !== undefined && bleedEffect.kind === "dot", "Bleed deveria estar ativo");
	if (bleedEffect !== undefined && bleedEffect.kind === "dot") {
		bleedEffect.remainingTicks = 1;
		bleedEffect.elapsed = 0.8;
	}
	const bleedSecond = target.applyStatusEffect("Bleed", 1, 20);
	assertInvariant(bleedSecond !== undefined && bleedSecond.renewed, "2ª aplicação de Bleed deveria renovar");
	assertInvariant(target.statusEffects.size() === 1, "Bleed não pode empilhar mais de 1 instância");
	const renewedBleed = target.statusEffects.get("Bleed");
	assertInvariant(
		renewedBleed !== undefined &&
			renewedBleed.kind === "dot" &&
			renewedBleed.remainingTicks === DOT_TICKS &&
			math.abs(renewedBleed.totalDamage - 20 * BLEED_DAMAGE_SHARE) <= FLOAT_TOLERANCE,
		"Bleed renovado deve resetar para 3 ticks e recalcular dano",
	);
	target.statusEffects.clear();

	// 2. Valor por tick < 1 acumula, nenhum 0 aparece e último tick garante >= 1
	const ticksObserved: number[] = [];
	let burnExpired = false;
	const disconnectTick = battle.events.effectTick.connect(({ damage }) => {
		assertInvariant(damage >= MIN_HIT_DAMAGE, "tick de DoT nunca pode ser 0");
		ticksObserved.push(damage);
	});
	const disconnectExpired = battle.events.effectExpired.connect(({ effect }) => {
		if (effect === "Burn") burnExpired = true;
	});

	const burnApplied = target.applyStatusEffect("Burn", 2, 1); // totalDamage = 0.2, damagePerTick = 0.0666... < 1
	assertInvariant(
		burnApplied !== undefined &&
			burnApplied.activeEffect.kind === "dot" &&
			math.abs(burnApplied.activeEffect.totalDamage - 1 * BURN_DAMAGE_SHARE) <= FLOAT_TOLERANCE,
		"Burn deve calcular 20% do dano real aplicado",
	);
	battle.step(1.0);
	assertInvariant(ticksObserved.size() === 0, "tick 1 (< 1) deve acumular sem emitir 0");
	battle.step(1.0);
	assertInvariant(ticksObserved.size() === 0, "tick 2 (< 1) deve acumular sem emitir 0");
	battle.step(1.0);
	assertInvariant(
		ticksObserved.size() === 1 && ticksObserved[0] === 1 && burnExpired,
		"último tick deve garantir pelo menos 1 de dano e expirar o efeito",
	);
	disconnectTick();
	disconnectExpired();

	// 3. Root bloqueia apenas a troca (alvo ainda enche ATB e ataca); usa relógio em IDLE
	target.applyStatusEffect("Root", 1, 10);
	assertInvariant(target.isRooted(), "alvo deveria estar com Root");
	assertInvariant(!battle.requestSwitch(sideB, 1), "Root deve bloquear a troca");
	const atbBeforeIdle = sideB.atb;
	battle.step(1.0);
	assertInvariant(sideB.atb > atbBeforeIdle, "Root não deve congelar o ATB do lutador");
	sideB.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(sideB, 1), "lutador em Root ainda deve poder atacar");
	// Avança PREPARE + ATTACK + RETURN: relógio de Root deve congelar fora de IDLE
	const rootDuringAttack = target.statusEffects.get("Root");
	const remainingBeforeAttack =
		rootDuringAttack !== undefined && rootDuringAttack.kind === "root" ? rootDuringAttack.remainingDuration : 0;
	battle.step(0.55); // 0.2 prepare + 0.1 hit + 0.25 return = 0.55s exatos até voltar a IDLE
	const rootAfterReturn = target.statusEffects.get("Root");
	assertInvariant(
		rootAfterReturn !== undefined &&
			rootAfterReturn.kind === "root" &&
			math.abs(rootAfterReturn.remainingDuration - remainingBeforeAttack) <= FLOAT_TOLERANCE,
		"Root deve congelar durante PREPARE/ATTACK/RETURN",
	);
	battle.step(ROOT_DURATION_BY_SLOT[1]);
	assertInvariant(!target.isRooted(), "Root deveria ter expirado após 5s em IDLE");
	assertInvariant(battle.requestSwitch(sideB, 1), "troca deve funcionar após expiração do Root");

	// 4. Efeito não some ao trocar, continua no banco, CARREGANDO não congela e morte por DoT em IDLE dispara death/battleEnd
	const benchFighter = sideB.getActiveFighter();
	benchFighter.localState = "CARREGANDO";
	benchFighter.applyStatusEffect("Bleed", 1, 12); // 3 de dano total (1 por tick)
	assertInvariant(battle.requestSwitch(sideB, 0), "lutador sem Root pode trocar para o banco");
	assertInvariant(benchFighter.hasStatusEffect("Bleed"), "efeito não pode sumir ao trocar para o banco");
	const hpBeforeBenchTick = benchFighter.hp;
	battle.step(1.0);
	assertInvariant(
		benchFighter.hp === hpBeforeBenchTick - 1,
		"DoT deve continuar correndo no banco e durante CARREGANDO",
	);
	benchFighter.localState = "NORMAL";

	// 5. Troca automática por morte ignora Root + Morte por DoT em IDLE dispara death e battleEnd normalmente
	const dotDeathSideA = new BattleSide(
		[makeDummyFighter("Fury"), makeDummyFighter("Menace"), makeDummyFighter("Dominator")],
		alwaysHitRng,
	);
	const dotDeathSideB = new BattleSide(
		[makeDummyFighter("Fury"), makeDummyFighter("Menace"), makeDummyFighter("Dominator")],
		alwaysHitRng,
	);
	dotDeathSideB.fighters[0].hp = 1;
	dotDeathSideB.fighters[0].applyStatusEffect("Root", 3, 10);
	dotDeathSideB.fighters[0].applyStatusEffect("Burn", 1, 15); // 3 de dano total -> 1 por tick
	dotDeathSideB.fighters[2].takeDamage(100);
	const dotBattle = new BattleService(dotDeathSideA, dotDeathSideB, alwaysHitRng);
	assertInvariant(!dotBattle.requestSwitch(dotDeathSideB, 1), "troca manual deve ser bloqueada por Root");
	let rootedAutoSwitchSucceeded = false;
	let dotDeathFired = false;
	let dotBattleEnded = false;
	dotBattle.events.death.connect(({ side, fighter, nextActive }) => {
		dotDeathFired = true;
		assertInvariant(side.atb === 0, "morte por DoT deve zerar ATB");
		if (fighter === dotDeathSideB.fighters[0]) {
			assertInvariant(
				fighter.hasStatusEffect("Root") &&
					nextActive === dotDeathSideB.fighters[1] &&
					side.getActiveFighter() === dotDeathSideB.fighters[1],
				"troca automática por morte deve ignorar Root",
			);
			rootedAutoSwitchSucceeded = true;
		}
	});
	dotBattle.events.battleEnd.connect((winner) => {
		dotBattleEnded = winner === dotDeathSideA;
	});
	dotBattle.step(1.0); // Mata fighters[0] (enraizado) e troca automaticamente para fighters[1]
	assertInvariant(rootedAutoSwitchSucceeded, "troca automática por morte de lutador com Root não ocorreu");

	dotDeathSideB.fighters[1].hp = 1;
	dotDeathSideB.fighters[1].applyStatusEffect("Burn", 1, 15);
	dotDeathSideB.setAtb(5);
	dotBattle.step(1.0); // Mata o último vivo (fighters[1]) e encerra a luta
	assertInvariant(dotDeathFired && dotBattleEnded, "morte por DoT em IDLE deve disparar death e battleEnd");
}

export function validatePauseAndQuitRules(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	const endedEvents: { player: Player; payload: BattleEndedPayload }[] = [];
	const startedEvents: { player: Player; payload: BattleStartedPayload }[] = [];
	const forgottenPlayers: Player[] = [];
	let onSkillBound: ((player: Player, slot: SkillSlot) => void) | undefined;

	const mockAdapter: BattleRemoteAdapter = {
		bindRequests(onSkill) {
			onSkillBound = onSkill;
		},
		forgetPlayer(player) {
			forgottenPlayers.push(player);
		},
		sendBattleStarted(player, payload) {
			startedEvents.push({ player, payload });
		},
		sendStateChanged() {},
		sendSwitchPerformed() {},
		sendAttackStarted() {},
		sendHitResolved() {},
		sendEffectApplied() {},
		sendEffectTick() {},
		sendEffectExpired() {},
		sendFighterDied() {},
		sendBattleEnded(player, payload) {
			endedEvents.push({ player, payload });
		},
		sendAtbSync() {},
	};

	const sessionService = new BattleSessionService(mockAdapter);
	mockAdapter.bindRequests(
		(player, slot) => {
			if (onSkillBound !== undefined) onSkillBound(player, slot);
		},
		() => {},
		(player) => sessionService.requestPause(player),
		(player) => sessionService.requestQuit(player),
	);

	const fakePlayerA = { Parent: Players, Name: "PlayerA" } as unknown as Player;
	const fakePlayerB = { Parent: Players, Name: "PlayerB" } as unknown as Player;

	// 1. PVE: Pause alterna, congela ATB/timers/timeouts (inclusive em ATTACK) e desfaz sozinho após 120s acumulados
	const pveSideA = createDummySide(rng);
	const pveSideB = createDummySide(rng);
	pveSideA.fighters[0].applyStatusEffect("Bleed", 1, 12);
	assertInvariant(
		sessionService.createSession(fakePlayerA, undefined, pveSideA, pveSideB, rng, "PVE"),
		"deveria criar sessão PVE",
	);
	assertInvariant(
		startedEvents.size() === 1 && startedEvents[0].payload.mode === "PVE" && startedEvents[0].payload.canPause === true,
		"sessão PVE deve informar canPause = true",
	);

	sessionService.step(4.0); // Enche ATB em IDLE
	const atbBeforePause = pveSideA.atb;
	const hpBeforePause = pveSideA.fighters[0].hp;
	assertInvariant(sessionService.requestPause(fakePlayerA), "RequestPause deveria ativar pause no PVE");
	assertInvariant(sessionService.isPaused(fakePlayerA), "sessão PVE deveria estar pausada");

	// Avança 100s pausado (acima do timeout de inatividade de 90s): nada pode mudar nem dar timeout
	sessionService.step(100.0);
	assertInvariant(sessionService.hasActiveSession(fakePlayerA), "timeout de 90s deve congelar durante pause");
	assertInvariant(
		math.abs(pveSideA.atb - atbBeforePause) <= FLOAT_TOLERANCE && pveSideA.fighters[0].hp === hpBeforePause,
		"pause não pode alterar ATB nem timers/DoT",
	);

	// Despausa, entra em ATTACK e pausa durante ATTACK
	assertInvariant(sessionService.requestPause(fakePlayerA), "RequestPause deveria despausar");
	assertInvariant(!sessionService.isPaused(fakePlayerA), "sessão PVE deveria ter saído do pause");
	pveSideA.setAtb(ATB_MAX);
	pveSideB.fighters[0].applyStatusEffect("Root", 1, 10);
	// Inicia skill e avança até ATTACK (prepareTime S1 = 0.2s)
	assertInvariant(
		sessionService.requestPause(fakePlayerA) && sessionService.requestPause(fakePlayerA),
		"alternância rápida de pause no PVE deve funcionar",
	);
	sessionService.step(0.25);
	assertInvariant(sessionService.requestPause(fakePlayerA), "pause deve ser aceito em qualquer estado");
	const rootBeforePausedStep = pveSideB.fighters[0].statusEffects.get("Root");
	const rootRemainingBefore =
		rootBeforePausedStep !== undefined && rootBeforePausedStep.kind === "root"
			? rootBeforePausedStep.remainingDuration
			: 0;

	// Já acumulou 100s; avançando mais 20s atinge PVE_PAUSE_MAX_SECONDS (120s) e desfaz o pause sozinho
	sessionService.step(20.0);
	assertInvariant(!sessionService.isPaused(fakePlayerA), "pause deve se desfazer sozinho ao atingir 120s acumulados");
	assertInvariant(
		math.abs(sessionService.getPauseAccumulatedSeconds(fakePlayerA) - PVE_PAUSE_MAX_SECONDS) <= FLOAT_TOLERANCE,
		"tempo acumulado de pause deve cravar em 120s",
	);
	assertInvariant(!sessionService.requestPause(fakePlayerA), "não deve permitir novo pause após estourar os 120s");
	const rootAfterPausedStep = pveSideB.fighters[0].statusEffects.get("Root");
	const rootRemainingAfter =
		rootAfterPausedStep !== undefined && rootAfterPausedStep.kind === "root"
			? rootAfterPausedStep.remainingDuration
			: 0;
	assertInvariant(
		math.abs(rootRemainingAfter - rootRemainingBefore) <= FLOAT_TOLERANCE,
		"timer de Root não pode correr durante os 20s finais de pause",
	);

	// Quit em PVE: quem saiu perde, outro lado (B) vence, limpa referências
	assertInvariant(sessionService.requestQuit(fakePlayerA), "RequestQuit deve encerrar sessão PVE");
	assertInvariant(!sessionService.hasActiveSession(fakePlayerA), "sessão PVE encerrada deve limpar referências");
	assertInvariant(
		endedEvents.size() === 1 && endedEvents[0].payload.winnerSideId === "battle-0-B",
		"Quit em PVE deve declarar o lado oposto (B) como vencedor",
	);

	// 2. PVP: RequestPause é ignorado em silêncio (canPause = false); Quit e desconexão declaram o outro lado vencedor
	const pvpSideA = createDummySide(rng);
	const pvpSideB = createDummySide(rng);
	assertInvariant(
		sessionService.createSession(fakePlayerA, fakePlayerB, pvpSideA, pvpSideB, rng, "PVP"),
		"deveria criar sessão PVP",
	);
	const lastStarted = startedEvents[startedEvents.size() - 1];
	assertInvariant(
		lastStarted.payload.mode === "PVP" && lastStarted.payload.canPause === false,
		"sessão PVP deve informar canPause = false (apenas quit visível)",
	);
	assertInvariant(!sessionService.requestPause(fakePlayerA), "RequestPause em PVP deve ser ignorado em silêncio");
	assertInvariant(!sessionService.isPaused(fakePlayerA), "sessão PVP nunca pode ficar pausada");

	// PlayerA dá Quit em PVP -> Lado B vence
	assertInvariant(sessionService.requestQuit(fakePlayerA), "RequestQuit em PVP deve funcionar");
	assertInvariant(
		!sessionService.hasActiveSession(fakePlayerA) && !sessionService.hasActiveSession(fakePlayerB),
		"Quit em PVP deve limpar referências dos dois participantes",
	);
	const pvpQuitEndEvent = endedEvents[endedEvents.size() - 1];
	assertInvariant(
		pvpQuitEndEvent.payload.winnerSideId === "battle-1-B",
		"Quit do PlayerA em PVP deve declarar o lado B como vencedor",
	);

	// Desconexão do PlayerB em nova sessão PVP -> Lado A vence
	const pvpSideA2 = createDummySide(rng);
	const pvpSideB2 = createDummySide(rng);
	assertInvariant(
		sessionService.createSession(fakePlayerA, fakePlayerB, pvpSideA2, pvpSideB2, rng, "PVP"),
		"deveria criar 2ª sessão PVP",
	);
	(fakePlayerB as unknown as { Parent?: Instance }).Parent = undefined;
	sessionService.destroySessionForPlayer(fakePlayerB);
	const disconnectEndEvent = endedEvents[endedEvents.size() - 1];
	assertInvariant(
		disconnectEndEvent.player === fakePlayerA && disconnectEndEvent.payload.winnerSideId === "battle-2-A",
		"desconexão do PlayerB deve emitir BattleEnded para PlayerA com lado A vencedor",
	);
	assertInvariant(forgottenPlayers.includes(fakePlayerB), "desconexão deve limpar rate limit do jogador");
}

export function validateJotaroAndAnubis(): void {
	// 1. Valida definições estáticas de FighterData e timelines em SkillData
	const jotaroDef = FIGHTER_DATA.jotaro;
	const anubisDef = FIGHTER_DATA.anubis;
	assertInvariant(
		jotaroDef.fighterId === "jotaro" &&
			jotaroDef.name === "Jotaro" &&
			jotaroDef.className === "Fury" &&
			jotaroDef.rarity === "Lendária",
		"definição de Jotaro incorreta",
	);
	assertInvariant(
		anubisDef.fighterId === "anubis" &&
			anubisDef.name === "Anubis" &&
			anubisDef.className === "Menace" &&
			anubisDef.rarity === "Épica",
		"definição de Anubis incorreta",
	);
	const starFinger = jotaroDef.skills[0];
	const barrage = jotaroDef.skills[1];
	// SkillData no Studio usa nomes de exibição. O fonte ainda usa as grafias legadas.
	assertInvariant(
		starFinger.name === "Star Finger" || starFinger.name === "star_Finger",
		`Jotaro S1 deve ser Star Finger (nome recebido: ${starFinger.name})`,
	);
	assertInvariant(starFinger.hits.size() === 1, `Jotaro S1 deve ter 1 hit (recebidos: ${starFinger.hits.size()})`);
	assertInvariant(
		barrage.name === "Barragem Estelar" || barrage.name === "Barragem_estelar",
		`Jotaro S2 deve ser Barragem Estelar (nome recebido: ${barrage.name})`,
	);
	assertInvariant(barrage.hits.size() === 5, `Jotaro S2 deve ter 5 hits (recebidos: ${barrage.hits.size()})`);
	let oraShareSum = 0;
	for (const hit of jotaroDef.skills[1].hits) {
		assertInvariant(math.abs(hit.damageShare - 0.2) <= FLOAT_TOLERANCE, "ORA ORA deve ter damageShare igual (0.2)");
		oraShareSum += hit.damageShare;
	}
	assertInvariant(math.abs(oraShareSum - 1) <= FLOAT_TOLERANCE, "ORA ORA damageShare deve somar 1");
	assertInvariant(jotaroDef.skills[2].hits.size() === 1, "Jotaro S3 Time Stop provisório deve ter 1 hit");
	assertInvariant(
		anubisDef.skills[0].hits.size() === 1 &&
			anubisDef.skills[1].hits.size() === 1 &&
			anubisDef.skills[2].hits.size() === 1,
		"Anubis S1/S2/S3 devem ter 1 hit cada",
	);
	assertInvariant(doesClassCounter("Fury", "Menace"), "Jotaro (Fury) deve ter counter sobre Anubis (Menace)");

	// 2. Valida roll de stats base (ClassData) e payload de BattleStarted (targetId, fighterId, hp, hpMax)
	const setupRng = createSeededRng(FIRST_SIMULATION_SEED);
	const [jotaroSide, anubisSide] = createJotaroVsAnubisSides(setupRng);
	for (const fighter of jotaroSide.fighters) {
		const furyRanges = CLASS_DATA.Fury.baseStats;
		assertInvariant(
			fighter.fighterId === "jotaro" &&
				fighter.stats.hp >= furyRanges.hp.min &&
				fighter.stats.hp <= furyRanges.hp.max &&
				fighter.stats.atk >= furyRanges.atk.min &&
				fighter.stats.atk <= furyRanges.atk.max &&
				fighter.stats.dodge >= furyRanges.dodge.min &&
				fighter.stats.dodge <= furyRanges.dodge.max &&
				fighter.stats.crit >= furyRanges.crit.min &&
				fighter.stats.crit <= furyRanges.crit.max,
			"stats base de Jotaro fora do range de Fury",
		);
	}
	for (const fighter of anubisSide.fighters) {
		const menaceRanges = CLASS_DATA.Menace.baseStats;
		assertInvariant(
			fighter.fighterId === "anubis" &&
				fighter.stats.hp >= menaceRanges.hp.min &&
				fighter.stats.hp <= menaceRanges.hp.max &&
				fighter.stats.atk >= menaceRanges.atk.min &&
				fighter.stats.atk <= menaceRanges.atk.max &&
				fighter.stats.dodge >= menaceRanges.dodge.min &&
				fighter.stats.dodge <= menaceRanges.dodge.max &&
				fighter.stats.crit >= menaceRanges.crit.min &&
				fighter.stats.crit <= menaceRanges.crit.max,
			"stats base de Anubis fora do range de Menace",
		);
	}

	let capturedBattleStarted: BattleStartedPayload | undefined;
	const mockAdapter: BattleRemoteAdapter = {
		bindRequests() {},
		forgetPlayer() {},
		sendBattleStarted(_player, payload) {
			capturedBattleStarted = payload;
		},
		sendStateChanged() {},
		sendSwitchPerformed() {},
		sendAttackStarted() {},
		sendHitResolved() {},
		sendEffectApplied() {},
		sendEffectTick() {},
		sendEffectExpired() {},
		sendFighterDied() {},
		sendBattleEnded() {},
		sendAtbSync() {},
	};
	const sessionService = new BattleSessionService(mockAdapter);
	const fakePlayer = { Parent: Players, Name: "TestPlayer" } as unknown as Player;
	assertInvariant(
		sessionService.createSession(fakePlayer, undefined, jotaroSide, anubisSide, setupRng, "PVE"),
		"deveria criar sessão Jotaro vs Anubis",
	);
	assertInvariant(
		capturedBattleStarted !== undefined && capturedBattleStarted.fighters.size() === 6,
		"BattleStarted deve enviar os 6 lutadores",
	);
	if (capturedBattleStarted !== undefined) {
		for (const index of $range(0, capturedBattleStarted.fighters.size() - 1)) {
			const snap = capturedBattleStarted.fighters[index];
			const expectedFighterId = index < 3 ? "jotaro" : "anubis";
			assertInvariant(
				snap.targetId.size() > 0 &&
					snap.fighterId === expectedFighterId &&
					snap.hp > 0 &&
					snap.hp === snap.hpMax,
				"BattleStarted deve mandar targetId, fighterId, hp e hpMax por lutador",
			);
		}
	}
	sessionService.requestQuit(fakePlayer);

	// 3. Assert extra explícito: troca automática por morte ignora Root (com Jotaro matando Anubis sob Root)
	const alwaysHitRng = () => 0.99;
	const [rootJotaroSide, rootAnubisSide] = createJotaroVsAnubisSides(alwaysHitRng);
	const rootedAnubis = rootAnubisSide.getActiveFighter();
	rootedAnubis.hp = 1;
	rootedAnubis.applyStatusEffect("Root", 3, 10);
	rootAnubisSide.fighters[1].applyStatusEffect("Root", 3, 10);
	rootAnubisSide.fighters[2].applyStatusEffect("Root", 3, 10);
	const rootBattle = new BattleService(rootJotaroSide, rootAnubisSide, alwaysHitRng);
	assertInvariant(!rootBattle.requestSwitch(rootAnubisSide, 1), "Root deve bloquear troca manual de Anubis");
	rootJotaroSide.setAtb(ATB_MAX);
	let autoSwitchIgnoredRoot = false;
	rootBattle.events.switchPerformed.connect(({ side, previousFighter: fighter, activeFighter: nextActive }) => {
		if (side === rootAnubisSide && fighter === rootedAnubis) {
			assertInvariant(
				!fighter.isAlive() &&
					nextActive !== undefined &&
					nextActive !== rootedAnubis &&
					nextActive.isAlive() &&
					nextActive.isRooted() &&
					rootAnubisSide.getActiveFighter() === nextActive,
				"troca automática por morte deve ignorar Root",
			);
			autoSwitchIgnoredRoot = true;
		}
	});
	assertInvariant(rootBattle.requestSkill(rootJotaroSide, 1), "Jotaro deve iniciar S1 Dedinhos");
	rootBattle.step(1.0); // 0.25 prepare + 0.15 hit + 0.25 return
	assertInvariant(autoSwitchIgnoredRoot, "troca automática por morte com Root deveria ter ocorrido");

	// 4. Simulação 1000 lutas: Jotaro vs Anubis (Jotaro deve vencer > 50% pelo counter ×1.175)
	let jotaroWins = 0;
	let totalDuration = 0;
	for (let simulationIndex = 0; simulationIndex < SIMULATION_COUNT; simulationIndex++) {
		if (simulationIndex > 0 && simulationIndex % 50 === 0) task.wait();
		const rng = createSeededRng(FIRST_SIMULATION_SEED + simulationIndex);
		const [sideJotaro, sideAnubis] = createJotaroVsAnubisSides(rng);
		const result = runBattleWithSides(sideJotaro, sideAnubis, rng, simulationIndex === 0);
		if (result.winnerIndex === 0) jotaroWins += 1;
		totalDuration += result.duration;
	}
	const jotaroWinRate = (jotaroWins / SIMULATION_COUNT) * 100;
	const averageDuration = totalDuration / SIMULATION_COUNT;
	print(
		`1000 lutas Jotaro vs Anubis: winrate Jotaro=${jotaroWinRate}% (${jotaroWins}/${SIMULATION_COUNT}), duração média=${averageDuration}s`,
	);
	assertInvariant(
		jotaroWinRate > 50,
		`Jotaro (Fury > Menace, ×1.175) deveria ganhar mais de 50% das lutas (atual: ${jotaroWinRate}%)`,
	);
}

export function validateCritDamageMultiplier(): void {
	const damageService = new DamageService();
	const attacker = makeDummyFighter("Fury"); // atk=10, crit=5 (7.5%), dodge=5 (5%)
	const defender = makeDummyFighter("Dominator"); // sem counter a favor de Fury
	const baseDamageS2 = calcDano(attacker.stats.atk, attacker.slots[1].mult, attacker.level);
	assertInvariant(baseDamageS2 >= 4, `dano base de teste para S2 deveria ser >= 4 (atual: ${baseDamageS2})`);

	// 1. Mesmo hit e mesmos stats: rng que acerta sem crit vs rng que acerta com crit
	let noCritCall = 0;
	const hitNoCritRng = (): number => {
		noCritCall += 1;
		return noCritCall === 1 ? 0.99 : 0.99; // 1º roll >= dodgeChance (acerta), 2º roll >= critChance (sem crit)
	};
	let critCall = 0;
	const hitCritRng = (): number => {
		critCall += 1;
		return critCall === 1 ? 0.99 : 0.0; // 1º roll >= dodgeChance (acerta), 2º roll < critChance (crit!)
	};

	for (const slot of [1, 2, 3] as const) {
		noCritCall = 0;
		critCall = 0;
		const normalRes = damageService.resolveHit(attacker, defender, slot, 1, hitNoCritRng);
		const critRes = damageService.resolveHit(attacker, defender, slot, 1, hitCritRng);
		assertInvariant(normalRes.hit && !normalRes.crit, `hit normal no slot S${slot} não deveria ser crítico`);
		assertInvariant(critRes.hit && critRes.crit, `hit crítico no slot S${slot} deveria marcar crit = true`);
		assertInvariant(
			critRes.damage > normalRes.damage &&
				critRes.damage === math.round(normalRes.damage * CRIT_MULTIPLIER),
			`dano crítico no slot S${slot} (${critRes.damage}) deve ser maior que o dano normal (${normalRes.damage}) e igual a round(normal * ${CRIT_MULTIPLIER})`,
		);
	}

	// 2. Valida no BattleService que o HP descontado no Fighter alvo corresponde ao dano crítico multiplicado
	const sideA = new BattleSide([makeDummyFighter("Fury"), makeDummyFighter("Menace"), makeDummyFighter("Dominator")], () => 0.99);
	const sideB = new BattleSide([makeDummyFighter("Dominator"), makeDummyFighter("Fury"), makeDummyFighter("Menace")], () => 0.99);
	let battleRngStep = 0;
	const forceCritInBattleRng = (): number => {
		battleRngStep += 1;
		// No resolveHit: ímpar = roll de dodge (0.99 -> acerta), par = roll de crit (0.0 -> crit!)
		return battleRngStep % 2 === 1 ? 0.99 : 0.0;
	};
	const critBattle = new BattleService(sideA, sideB, forceCritInBattleRng);
	const target = sideB.getActiveFighter();
	const hpBefore = target.hp;
	let resolvedDamage = 0;
	let resolvedCrit = false;
	critBattle.events.hitResolved.connect(({ hit, crit, damage }) => {
		if (hit) {
			resolvedCrit = crit;
			resolvedDamage += damage;
		}
	});
	sideA.setAtb(ATB_MAX);
	assertInvariant(critBattle.requestSkill(sideA, 1), "deveria iniciar S1 para validar desconto de HP crítico");
	critBattle.step(1.0);
	const hpAfter = target.hp;
	noCritCall = 0;
	const expectedNormalS1 = damageService.resolveHit(sideA.getActiveFighter(), target, 1, 1, hitNoCritRng).damage;
	assertInvariant(
		resolvedCrit &&
			resolvedDamage > expectedNormalS1 &&
			hpBefore - hpAfter === resolvedDamage,
		`HP descontado no alvo (${hpBefore - hpAfter}) deve corresponder exatamente ao dano crítico (${resolvedDamage} > ${expectedNormalS1})`,
	);
}

export function validateBronzeAI(): void {
	// 1. Delay de reação para skills (1.5s a 3.0s) quando há ATB suficiente para pelo menos uma skill
	const rngMid = () => 0.5;
	const sidePlayer1 = createDummySide(rngMid);
	const sideAI1 = createDummySide(rngMid);
	const battle1 = new BattleService(sidePlayer1, sideAI1, rngMid);
	const ai1 = new AIService(battle1, sideAI1, rngMid);
	let aiAttackCount = 0;
	let lastUsedSlot: SkillSlot | undefined;
	battle1.events.attackStarted.connect(({ attacker, slot }) => {
		if (sideAI1.fighters.includes(attacker)) {
			aiAttackCount += 1;
			lastUsedSlot = slot;
		}
	});

	sideAI1.setAtb(sideAI1.getActiveFighter().slots[0].cost); // Suficiente apenas para S1
	ai1.step(AI_BRONZE_SKILL_DELAY_MIN_SECONDS - 0.1);
	assertInvariant(battle1.state === "IDLE", "AI Bronze não deve executar skill antes do delay mínimo de 1.5s");
	ai1.step(AI_BRONZE_SKILL_DELAY_MAX_SECONDS);
	assertInvariant(
		battle1.state !== "IDLE",
		"AI Bronze deve iniciar skill dentro do delay de reação [1.5s, 3.0s]",
	);
	battle1.step(1.0); // Conclui PREPARE + ATTACK + RETURN
	assertInvariant(aiAttackCount === 1 && lastUsedSlot === 1, "AI Bronze deveria ter disparado S1");

	// 2. Se ATB atingir o custo da Slot 3 (Ultimate), aguarda 2.0s a 4.0s e dispara a S3
	sideAI1.setAtb(ATB_MAX);
	ai1.step(AI_BRONZE_ULTIMATE_DELAY_MIN_SECONDS - 0.1);
	assertInvariant(battle1.state === "IDLE", "AI Bronze não deve disparar S3 antes do delay mínimo de 2.0s");
	ai1.step(AI_BRONZE_ULTIMATE_DELAY_MAX_SECONDS);
	assertInvariant(battle1.state !== "IDLE", "AI Bronze deve iniciar S3 após o delay [2.0s, 4.0s]");
	battle1.step(1.5);
	assertInvariant(lastUsedSlot === 3, "AI Bronze com ATB no custo da S3 deve desperdiçar disparando S3");

	// 3. Escolha de Skill e Erro Proposital (30% força S1 mesmo tendo ATB para S2/S3; 70% aleatório entre disponíveis)
	const mistakeAi = new AIService(battle1, sideAI1, () => 0.15); // 0.15 < 0.30 -> força erro (S1)
	assertInvariant(
		mistakeAi.chooseSkillSlot([1, 2]) === 1 && mistakeAi.chooseSkillSlot([1, 2, 3]) === 1,
		"com roll < 30%, AI Bronze deve forçar uso da Slot 1 mesmo tendo S2 ou S3 disponível",
	);
	const noMistakeHighAi = new AIService(battle1, sideAI1, () => 0.95); // >= 0.30 -> escolhe último disponível
	assertInvariant(
		noMistakeHighAi.chooseSkillSlot([1, 2]) === 2 && noMistakeHighAi.chooseSkillSlot([1, 2, 3]) === 3,
		"nos outros 70%, AI Bronze deve escolher aleatoriamente entre as skills que consegue pagar",
	);

	// 4. Lógica de Troca (HP baixo < 25%: 50% de chance, respeitando Root e com trava anti-loop; e troca por tempo 20s..30s)
	const sidePlayer2 = createDummySide(rngMid);
	const sideAI2 = createDummySide(rngMid);
	const battle2 = new BattleService(sidePlayer2, sideAI2, rngMid);
	let switchRollValue = 0.8; // >= 0.50 -> falha no roll de 50%
	const ai2 = new AIService(battle2, sideAI2, () => switchRollValue);
	const initialActive = sideAI2.getActiveFighter();
	initialActive.hp = math.floor(initialActive.hpMax * 0.2); // < 25% HP_MAX

	ai2.step(0.1);
	assertInvariant(sideAI2.getActiveFighter() === initialActive, "com roll >= 0.50, AI Bronze não deve trocar por HP baixo");
	// Muda o roll para 0.1 (< 0.50): como já avaliou para este ativo, a trava anti-loop deve impedir nova tentativa
	switchRollValue = 0.1;
	ai2.step(0.1);
	assertInvariant(
		sideAI2.getActiveFighter() === initialActive,
		"trava de HP baixo deve impedir tentativas de troca em loop no mesmo lutador ativo",
	);

	// Reseta HP e volta a cair abaixo de 25% sob Root -> Root bloqueia
	initialActive.hp = initialActive.hpMax;
	ai2.step(0.1);
	initialActive.applyStatusEffect("Root", 1, 10);
	initialActive.hp = math.floor(initialActive.hpMax * 0.2);
	ai2.step(0.1);
	assertInvariant(
		sideAI2.getActiveFighter() === initialActive,
		"AI Bronze em HP baixo deve respeitar Root e não trocar",
	);

	// Remove Root, reseta trava e cai abaixo de 25% com roll 0.1 (< 0.50) -> troca realizada!
	initialActive.statusEffects.clear();
	initialActive.hp = initialActive.hpMax;
	ai2.step(0.1);
	initialActive.hp = math.floor(initialActive.hpMax * 0.2);
	ai2.step(0.1);
	const activeAfterLowHpSwitch = sideAI2.getActiveFighter();
	assertInvariant(
		activeAfterLowHpSwitch !== initialActive,
		"AI Bronze com HP < 25% e roll < 50% (sem Root) deve trocar para um aliado vivo",
	);

	// Troca por tempo (a cada 20s a 30s em IDLE)
	sideAI2.setAtb(0);
	ai2.step(AI_BRONZE_TIMED_SWITCH_MIN_SECONDS - 1.0);
	assertInvariant(
		sideAI2.getActiveFighter() === activeAfterLowHpSwitch,
		"AI Bronze não deve realizar troca por tempo antes de 20s",
	);
	ai2.step(AI_BRONZE_TIMED_SWITCH_MAX_SECONDS);
	assertInvariant(
		sideAI2.getActiveFighter() !== activeAfterLowHpSwitch,
		"AI Bronze deve realizar troca aleatória por tempo entre 20s e 30s",
	);

	// 5. Limpeza completa da IA no encerramento da sessão (RequestQuit / BattleEnded)
	const mockAdapter: BattleRemoteAdapter = {
		bindRequests() {},
		forgetPlayer() {},
		sendBattleStarted() {},
		sendStateChanged() {},
		sendSwitchPerformed() {},
		sendAttackStarted() {},
		sendHitResolved() {},
		sendEffectApplied() {},
		sendEffectTick() {},
		sendEffectExpired() {},
		sendFighterDied() {},
		sendBattleEnded() {},
		sendAtbSync() {},
	};
	const sessionService = new BattleSessionService(mockAdapter);
	const fakePlayer = { Parent: Players, Name: "AISessionPlayer" } as unknown as Player;
	const [pveSideA, pveSideB] = createJotaroVsAnubisSides(createSeededRng(FIRST_SIMULATION_SEED));
	assertInvariant(
		sessionService.createSession(fakePlayer, undefined, pveSideA, pveSideB, createSeededRng(FIRST_SIMULATION_SEED), "PVE"),
		"deveria criar sessão PVE com IA",
	);
	const attachedAi = sessionService.attachSideAI(fakePlayer, 1, createSeededRng(FIRST_SIMULATION_SEED));
	assertInvariant(attachedAi !== undefined && !attachedAi.isDestroyed(), "IA deveria estar ativa na sessão PVE");
	sessionService.requestQuit(fakePlayer);
	assertInvariant(attachedAi !== undefined && attachedAi.isDestroyed(), "encerrar sessão deve limpar/destruir a IA");

	// 6. Luta completa: Player simulado (Jotaro) vs AI Bronze (Anubis) até o fim sem travar
	const matchRng = createSeededRng(FIRST_SIMULATION_SEED + 77);
	const [playerJotaroSide, bronzeAnubisSide] = createJotaroVsAnubisSides(matchRng);
	const pveBattle = new BattleService(playerJotaroSide, bronzeAnubisSide, matchRng);
	const bronzeAi = new AIService(pveBattle, bronzeAnubisSide, matchRng);
	let pveWinner: BattleSide | undefined;
	pveBattle.events.battleEnd.connect((winner) => {
		pveWinner = winner;
	});
	let pveElapsed = 0;
	for (let stepIdx = 0; stepIdx < MAX_SIMULATION_STEPS && pveWinner === undefined; stepIdx++) {
		if (pveBattle.state === "IDLE") {
			const playerSlot: SkillSlot = playerJotaroSide.atb >= playerJotaroSide.getActiveFighter().slots[1].cost ? 2 : 1;
			if (playerJotaroSide.atb >= playerJotaroSide.getActiveFighter().slots[playerSlot - 1].cost) {
				pveBattle.requestSkill(playerJotaroSide, playerSlot);
			}
		}
		pveBattle.step(SIMULATION_DT);
		bronzeAi.step(SIMULATION_DT);
		pveElapsed += SIMULATION_DT;
	}
	bronzeAi.destroy();
	assertInvariant(pveWinner !== undefined, "luta completa Player vs AI Bronze deveria terminar sem travar");
	print(
		`Validação Player vs AI Bronze concluída: vencedor=${pveWinner === playerJotaroSide ? "Player (Jotaro)" : "AI Bronze (Anubis)"}, duração=${pveElapsed}s`,
	);
}

/** Item 3: RequestSkill aceita somente slots 1, 2 e 3. */
export function validateSkillSlotValidation(): void {
	const internals = new RemoteService() as unknown as RemoteServiceTestInternals;
	assertInvariant(MIN_SKILL_SLOT === 1 && MAX_SKILL_SLOT === 3, "limites de slot devem ser 1..3 em Config");
	assertInvariant(
		internals.readSkillSlot({ slot: 1 }) === 1 &&
			internals.readSkillSlot({ slot: 2 }) === 2 &&
			internals.readSkillSlot({ slot: 3 }) === 3,
		"slots 1, 2 e 3 devem ser aceitos",
	);
	assertInvariant(
		internals.readSkillSlot({ slot: 4 }) === undefined &&
			internals.readSkillSlot({ slot: 0 }) === undefined &&
			internals.readSkillSlot({ slot: 0 / 0 }) === undefined &&
			internals.readSkillSlot({ slot: 1.5 }) === undefined,
		"slots 4, 0, NaN e 1.5 devem ser recusados",
	);
	print("SURGICAL_3_SKILL_SLOT_PASSED");
}

/** Item 4: itemUuid vazio ou com mais de 64 caracteres é recusado. */
export function validateItemUuidLength(): void {
	const remoteService = new RemoteService();
	const uuidPlayer = { Parent: Players, Name: "UuidLengthPlayer" } as unknown as Player;
	const tooLong = "a".rep(MAX_ITEM_UUID_LENGTH + 1);
	const maxLength = "a".rep(MAX_ITEM_UUID_LENGTH);
	assertInvariant(tooLong.size() === 65 && MAX_ITEM_UUID_LENGTH === 64, "uuid de teste deve ter 65 caracteres");
	assertInvariant(
		remoteService.readAllocatePayload({ itemUuid: tooLong, stat: "atk", amount: 1 }) === undefined,
		"itemUuid com 65 caracteres deve ser recusado",
	);
	assertInvariant(
		remoteService.readAllocatePayload({ itemUuid: "", stat: "atk", amount: 1 }) === undefined,
		"itemUuid vazio deve ser recusado",
	);
	assertInvariant(
		!remoteService.processAllocateEvent(uuidPlayer, { itemUuid: tooLong, stat: "atk", amount: 1 }),
		"processAllocateEvent deve recusar itemUuid com 65 caracteres",
	);
	const accepted = remoteService.readAllocatePayload({ itemUuid: maxLength, stat: "atk", amount: 1 });
	assertInvariant(accepted !== undefined && accepted.itemUuid === maxLength, "itemUuid com 64 caracteres deve ser aceito");
	remoteService.forgetPlayer(uuidPlayer);
	print("SURGICAL_4_ITEM_UUID_PASSED");
}

/** Item 5: token bucket por jogador; RequestAllocate com bucket próprio e mais restrito. */
export function validateTokenBucketRateLimit(): void {
	let fakeNow = 1000;
	const remoteService = new RemoteService(() => fakeNow);
	const internals = remoteService as unknown as RemoteServiceTestInternals;
	const burstPlayer = { Parent: Players, Name: "BurstPlayer" } as unknown as Player;
	const otherPlayer = { Parent: Players, Name: "OtherBurstPlayer" } as unknown as Player;
	const BURST_SIZE = 20;
	const allocatePayload = { itemUuid: "bucket-test-uuid", stat: "atk", amount: 1 };

	const burstBattle = (player: Player): number => {
		let accepted = 0;
		for (const _ of $range(1, BURST_SIZE)) if (internals.consumeRequest(player)) accepted += 1;
		return accepted;
	};
	const burstAllocate = (player: Player): number => {
		let accepted = 0;
		for (const _ of $range(1, BURST_SIZE)) if (remoteService.processAllocateEvent(player, allocatePayload)) accepted += 1;
		return accepted;
	};
	const expectedRefill = (elapsed: number, rate: number, capacity: number): number =>
		math.min(capacity, math.floor(elapsed * rate + FLOAT_TOLERANCE));

	assertInvariant(
		ALLOCATE_REQUEST_BUCKET_CAPACITY < BATTLE_REQUEST_BUCKET_CAPACITY &&
			ALLOCATE_REQUEST_REFILL_PER_SECOND < BATTLE_REQUEST_REFILL_PER_SECOND,
		"bucket do RequestAllocate deve ser mais restrito que o de batalha",
	);

	// Rajada de 20 não passa da capacidade
	assertInvariant(burstBattle(burstPlayer) === BATTLE_REQUEST_BUCKET_CAPACITY, "rajada de batalha deve parar na capacidade");
	assertInvariant(burstBattle(otherPlayer) === BATTLE_REQUEST_BUCKET_CAPACITY, "bucket deve ser independente por jogador");

	// Bucket de batalha esgotado não afeta o bucket do RequestAllocate (e vice-versa)
	assertInvariant(
		burstAllocate(burstPlayer) === ALLOCATE_REQUEST_BUCKET_CAPACITY,
		"rajada de RequestAllocate deve parar na capacidade do bucket próprio",
	);
	assertInvariant(!internals.consumeRequest(burstPlayer), "bucket de batalha continua esgotado sem tempo decorrido");

	// Recuperação parcial ao longo do tempo
	const partialElapsed = 0.5;
	fakeNow += partialElapsed;
	assertInvariant(
		burstBattle(burstPlayer) ===
			expectedRefill(partialElapsed, BATTLE_REQUEST_REFILL_PER_SECOND, BATTLE_REQUEST_BUCKET_CAPACITY),
		"bucket de batalha deve recuperar tokens proporcionalmente ao tempo",
	);
	assertInvariant(
		burstAllocate(burstPlayer) ===
			expectedRefill(partialElapsed, ALLOCATE_REQUEST_REFILL_PER_SECOND, ALLOCATE_REQUEST_BUCKET_CAPACITY),
		"bucket de RequestAllocate deve recuperar tokens proporcionalmente ao tempo",
	);

	// Recuperação longa não ultrapassa a capacidade
	fakeNow += 100;
	assertInvariant(burstBattle(burstPlayer) === BATTLE_REQUEST_BUCKET_CAPACITY, "recarga longa não passa da capacidade");
	assertInvariant(
		burstAllocate(burstPlayer) === ALLOCATE_REQUEST_BUCKET_CAPACITY,
		"recarga longa do RequestAllocate não passa da capacidade",
	);

	// forgetPlayer limpa os dois buckets
	remoteService.forgetPlayer(burstPlayer);
	assertInvariant(
		burstBattle(burstPlayer) === BATTLE_REQUEST_BUCKET_CAPACITY &&
			burstAllocate(burstPlayer) === ALLOCATE_REQUEST_BUCKET_CAPACITY,
		"forgetPlayer deve reiniciar os dois buckets",
	);
	remoteService.forgetPlayer(burstPlayer);
	remoteService.forgetPlayer(otherPlayer);
	print("SURGICAL_5_TOKEN_BUCKET_PASSED");
}

/** Item 6: triggers de lado e IA só em PVE e nunca no lado do jogador. */
export function validateSideTriggersRestrictions(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	const sessionService = new BattleSessionService(createSurgicalMockAdapter({}));
	const pvePlayer = { Parent: Players, Name: "SideTriggerPvePlayer" } as unknown as Player;
	const pvpPlayerA = { Parent: Players, Name: "SideTriggerPvpA" } as unknown as Player;
	const pvpPlayerB = { Parent: Players, Name: "SideTriggerPvpB" } as unknown as Player;

	// PVE: lado 0 é do jogador
	const pvePlayerSide = createDummySide(rng);
	const pveEnemySide = createDummySide(rng);
	assertInvariant(
		sessionService.createSession(pvePlayer, undefined, pvePlayerSide, pveEnemySide, rng, "PVE"),
		"deveria criar sessão PVE",
	);
	pvePlayerSide.setAtb(ATB_MAX);
	const pveActiveBefore = pvePlayerSide.activeIndex;
	assertInvariant(!sessionService.triggerSideSkill(pvePlayer, 0, 1), "PVE: triggerSideSkill no lado do jogador deve ser recusado");
	assertInvariant(
		!sessionService.triggerSideSwitch(pvePlayer, 0, ((pveActiveBefore + 1) % 3) as FighterIndex),
		"PVE: triggerSideSwitch no lado do jogador deve ser recusado",
	);
	assertInvariant(sessionService.attachSideAI(pvePlayer, 0, rng) === undefined, "PVE: attachSideAI no lado do jogador deve ser recusado");
	assertInvariant(
		pvePlayerSide.atb === ATB_MAX && pvePlayerSide.activeIndex === pveActiveBefore,
		"PVE: recusas não podem alterar ATB nem lutador ativo do lado do jogador",
	);
	// Controle: lado inimigo em PVE continua aceito
	pveEnemySide.setAtb(ATB_MAX);
	assertInvariant(sessionService.triggerSideSkill(pvePlayer, 1, 1), "PVE: triggerSideSkill no lado inimigo deve funcionar");
	sessionService.requestQuit(pvePlayer);

	// PVP: qualquer lado é recusado
	const pvpSideA = createDummySide(rng);
	const pvpSideB = createDummySide(rng);
	assertInvariant(
		sessionService.createSession(pvpPlayerA, pvpPlayerB, pvpSideA, pvpSideB, rng, "PVP"),
		"deveria criar sessão PVP",
	);
	pvpSideA.setAtb(ATB_MAX);
	pvpSideB.setAtb(ATB_MAX);
	const pvpActiveA = pvpSideA.activeIndex;
	const pvpActiveB = pvpSideB.activeIndex;
	assertInvariant(
		!sessionService.triggerSideSkill(pvpPlayerA, 1, 1) && !sessionService.triggerSideSkill(pvpPlayerA, 0, 1),
		"PVP: triggerSideSkill deve ser recusado",
	);
	assertInvariant(
		!sessionService.triggerSideSwitch(pvpPlayerA, 1, ((pvpActiveB + 1) % 3) as FighterIndex) &&
			!sessionService.triggerSideSwitch(pvpPlayerB, 0, ((pvpActiveA + 1) % 3) as FighterIndex),
		"PVP: triggerSideSwitch deve ser recusado",
	);
	assertInvariant(
		sessionService.attachSideAI(pvpPlayerA, 1, rng) === undefined &&
			sessionService.attachSideAI(pvpPlayerB, 0, rng) === undefined,
		"PVP: attachSideAI deve ser recusado",
	);
	assertInvariant(
		pvpSideA.atb === ATB_MAX &&
			pvpSideB.atb === ATB_MAX &&
			pvpSideA.activeIndex === pvpActiveA &&
			pvpSideB.activeIndex === pvpActiveB,
		"PVP: recusas não podem alterar ATB nem lutador ativo",
	);
	sessionService.requestQuit(pvpPlayerA);
	assertInvariant(
		!sessionService.hasActiveSession(pvpPlayerA) && !sessionService.hasActiveSession(pvpPlayerB),
		"sessões do teste devem ser limpas",
	);
	print("SURGICAL_6_SIDE_TRIGGERS_PASSED");
}

/** Item 7: BattleSide.trocar recusa índice fora do intervalo, inexistente ou de lutador morto. */
export function validateTrocarIndexValidation(): void {
	const toFighterIndex = (value: number): FighterIndex => value as FighterIndex;
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	const side = new BattleSide(
		[makeDummyFighter("Fury"), makeDummyFighter("Menace"), makeDummyFighter("Dominator")],
		rng,
		0,
	);
	assertInvariant(
		!side.trocar(toFighterIndex(3)) &&
			!side.trocar(toFighterIndex(-1)) &&
			!side.trocar(toFighterIndex(1.5)) &&
			!side.trocar(toFighterIndex(0 / 0)),
		"trocar deve recusar índice fora do intervalo ou não inteiro",
	);
	side.fighters[1].takeDamage(side.fighters[1].hpMax);
	assertInvariant(!side.trocar(1), "trocar deve recusar lutador morto");
	assertInvariant(side.activeIndex === 0, "recusas não podem alterar o lutador ativo");

	const missingSide = new BattleSide(
		[makeDummyFighter("Fury"), makeDummyFighter("Menace")] as unknown as FighterLineup,
		rng,
		0,
	);
	assertInvariant(!missingSide.trocar(2), "trocar deve recusar índice sem lutador");
	assertInvariant(missingSide.activeIndex === 0, "recusa por inexistente não pode alterar o ativo");

	// Controle: troca válida continua funcionando
	assertInvariant(side.trocar(2) && side.activeIndex === 2, "troca válida para lutador vivo deve funcionar");
	print("SURGICAL_7_TROCAR_PASSED");
}

export function validateDayNightCycle(): void {
	assertInvariant(smoothstepQuintic(-0.5) === 0 && smoothstepQuintic(0) === 0, "smoothstepQuintic início em 0");
	assertInvariant(math.abs(smoothstepQuintic(0.5) - 0.5) < 1e-6, "smoothstepQuintic simétrico em 0.5");
	assertInvariant(smoothstepQuintic(1) === 1 && smoothstepQuintic(2) === 1, "smoothstepQuintic teto em 1");
	assertInvariant(smoothstepQuintic(0 / 0) === 0, "smoothstepQuintic seguro para NaN");

	assertInvariant(
		calcNightAlpha(8) === 0 && calcNightAlpha(12) === 0 && calcNightAlpha(15.999) === 0,
		"pleno dia [8, 16) deve retornar 0",
	);
	assertInvariant(
		calcNightAlpha(16) === 0 &&
			calcNightAlpha(17) > 0 &&
			calcNightAlpha(17) < 0.5 &&
			math.abs(calcNightAlpha(18) - 0.5) < 1e-6,
		"crepúsculo [16, 20) deve suavizar até 1",
	);
	assertInvariant(
		calcNightAlpha(20) === 1 &&
			calcNightAlpha(23.9) === 1 &&
			calcNightAlpha(0) === 1 &&
			calcNightAlpha(3.999) === 1,
		"plena noite [20, 4) deve retornar 1",
	);
	assertInvariant(
		calcNightAlpha(4) === 1 &&
			calcNightAlpha(5) > 0.5 &&
			calcNightAlpha(5) < 1 &&
			math.abs(calcNightAlpha(6) - 0.5) < 1e-6,
		"amanhecer [4, 8) deve suavizar até 0",
	);
	assertInvariant(calcNightAlpha(-4) === 1 && calcNightAlpha(32) === 0, "normaliza horas fora de [0, 24)");

	assertInvariant(calcSolarHour(8, 0, 1440) === 8, "hora inicial sem tempo decorrido");
	assertInvariant(math.abs(calcSolarHour(8, 720, 1440) - 20) < 1e-6, "meio ciclo avança 12 horas");
	assertInvariant(math.abs(calcSolarHour(8, 1440, 1440) - 8) < 1e-6, "ciclo completo fecha em 24h");
	assertInvariant(math.abs(calcSolarHour(8, 0.5, 0) - 20) < 1e-6, "duração mínima limitada a 1s");
	assertInvariant(calcSolarHour(0 / 0, 0, 1440) === DAY_NIGHT_DEFAULT_START_HOUR, "hora inicial NaN usa padrão");

	const black = new Color3(0, 0, 0);
	const white = new Color3(1, 1, 1);
	assertInvariant(lerpColor3Gamma(black, white, 0) === black, "gamma t=0 retorna c1");
	assertInvariant(lerpColor3Gamma(black, white, 1) === white, "gamma t=1 retorna c2");
	const midGamma = lerpColor3Gamma(black, white, 0.5);
	const expectedMid = math.sqrt(0.5);
	assertInvariant(
		math.abs(midGamma.R - expectedMid) < 1e-5 &&
			math.abs(midGamma.G - expectedMid) < 1e-5 &&
			math.abs(midGamma.B - expectedMid) < 1e-5,
		"interpolação de cor usa espaço Gamma 2.0",
	);

	assertInvariant(!shouldSkipInterpolation(0, -1), "primeira atualização nunca pula");
	assertInvariant(shouldSkipInterpolation(0.5001, 0.5), "passo intermediário menor que epsilon pula");
	assertInvariant(!shouldSkipInterpolation(0, 0.0002), "snap exato em t=0 não pula");
	assertInvariant(shouldSkipInterpolation(0, 0), "t=0 repetido pula");
	assertInvariant(!shouldSkipInterpolation(1, 0.9998), "snap exato em t=1 não pula");
	assertInvariant(shouldSkipInterpolation(1, 1), "t=1 repetido pula");

	const makeMockWorkspace = (initial?: Record<string, AttributeValue>) => {
		const attrs = new Map<string, AttributeValue>();
		if (initial !== undefined) {
			for (const [key, value] of pairs(initial)) attrs.set(key, value);
		}
		return {
			attrs,
			GetAttribute(name: string): AttributeValue | undefined {
				return attrs.get(name);
			},
			SetAttribute(name: string, value: AttributeValue): void {
				attrs.set(name, value);
			},
		};
	};

	const freshWs = makeMockWorkspace();
	new DayNightService(freshWs, () => 1234.5).start();
	assertInvariant(
		freshWs.attrs.get(DAY_NIGHT_ATTRIBUTES.startTime) === 1234.5 &&
			freshWs.attrs.get(DAY_NIGHT_ATTRIBUTES.duration) === DAY_NIGHT_DEFAULT_DURATION_SECONDS &&
			freshWs.attrs.get(DAY_NIGHT_ATTRIBUTES.startHour) === DAY_NIGHT_DEFAULT_START_HOUR &&
			freshWs.attrs.get(DAY_NIGHT_ATTRIBUTES.paused) === false,
		"DayNightService inicializa atributos padrão no Workspace",
	);

	const presetWs = makeMockWorkspace({
		[DAY_NIGHT_ATTRIBUTES.startTime]: 500,
		[DAY_NIGHT_ATTRIBUTES.duration]: 60,
		[DAY_NIGHT_ATTRIBUTES.startHour]: 18,
		[DAY_NIGHT_ATTRIBUTES.paused]: true,
	});
	new DayNightService(presetWs, () => 9999).start();
	assertInvariant(
		presetWs.attrs.get(DAY_NIGHT_ATTRIBUTES.startTime) === 500 &&
			presetWs.attrs.get(DAY_NIGHT_ATTRIBUTES.duration) === 60 &&
			presetWs.attrs.get(DAY_NIGHT_ATTRIBUTES.startHour) === 18 &&
			presetWs.attrs.get(DAY_NIGHT_ATTRIBUTES.paused) === true,
		"DayNightService preserva atributos já configurados",
	);

	const dayFolder = new Instance("Folder");
	const nightFolder = new Instance("Folder");
	const lightingContainer = new Instance("Folder");

	dayFolder.SetAttribute("Lighting_GlobalShadows", false);
	dayFolder.SetAttribute("Lighting_Brightness", 2);
	nightFolder.SetAttribute("Lighting_Brightness", 1);
	dayFolder.SetAttribute("Lighting_GeographicLatitude", 26.8);
	nightFolder.SetAttribute("Lighting_GeographicLatitude", 26.8);
	dayFolder.SetAttribute("Lighting_FogColor", new Color3(1, 1, 1));
	nightFolder.SetAttribute("Lighting_FogColor", new Color3(0, 0, 0));

	const makeAtmosphere = (parent: Instance, density: number, color: Color3): Atmosphere => {
		const inst = new Instance("Atmosphere");
		inst.Name = "Atmosphere";
		inst.Density = density;
		inst.Color = color;
		inst.Parent = parent;
		return inst;
	};
	makeAtmosphere(dayFolder, 0.3, new Color3(1, 1, 1));
	makeAtmosphere(nightFolder, 0.5, new Color3(0, 0, 1));

	const makeBloom = (parent: Instance, intensity: number, size: number, threshold: number): BloomEffect => {
		const inst = new Instance("BloomEffect");
		inst.Name = "Bloom";
		inst.Intensity = intensity;
		inst.Size = size;
		inst.Threshold = threshold;
		inst.Parent = parent;
		return inst;
	};
	makeBloom(dayFolder, 0.16, 20, 1.25);
	makeBloom(nightFolder, 0.26, 22, 1.35);

	const existingBloom = makeBloom(lightingContainer, 0, 0, 0);
	existingBloom.Enabled = false;

	const makeColorCorrection = (parent: Instance, brightness: number, tint: Color3): ColorCorrectionEffect => {
		const inst = new Instance("ColorCorrectionEffect");
		inst.Name = "ColorCorrection";
		inst.Brightness = brightness;
		inst.TintColor = tint;
		inst.Parent = parent;
		return inst;
	};
	makeColorCorrection(dayFolder, 0.01, new Color3(1, 0.9, 0.8));
	makeColorCorrection(nightFolder, -0.01, new Color3(0.8, 0.8, 1));

	const makeSunRays = (parent: Instance, intensity: number, spread: number): SunRaysEffect => {
		const inst = new Instance("SunRaysEffect");
		inst.Name = "SunRays";
		inst.Intensity = intensity;
		inst.Spread = spread;
		inst.Parent = parent;
		return inst;
	};
	makeSunRays(dayFolder, 0.04, 0.45);
	makeSunRays(nightFolder, 0, 0.12);

	const makeDepth = (parent: Instance, far: number, focus: number, radius: number): DepthOfFieldEffect => {
		const inst = new Instance("DepthOfFieldEffect");
		inst.Name = "JoJoBackgroundDepth";
		inst.FarIntensity = far;
		inst.FocusDistance = focus;
		inst.InFocusRadius = radius;
		inst.NearIntensity = 0;
		inst.Parent = parent;
		return inst;
	};
	makeDepth(dayFolder, 0.12, 85, 60);
	makeDepth(nightFolder, 0.17, 90, 52);

	const makeGrading = (parent: Instance, preset: Enum.TonemapperPreset): ColorGradingEffect => {
		const inst = new Instance("ColorGradingEffect");
		inst.Name = "ColorGrading";
		inst.TonemapperPreset = preset;
		inst.Parent = parent;
		return inst;
	};
	makeGrading(dayFolder, Enum.TonemapperPreset.Default);
	makeGrading(nightFolder, Enum.TonemapperPreset.Retro);

	const makeSky = (parent: Instance, name: string, stars: number, moonSize: number, skyboxBk: string): Sky => {
		const inst = new Instance("Sky");
		inst.Name = name;
		inst.StarCount = stars;
		inst.MoonAngularSize = moonSize;
		inst.SunAngularSize = 21;
		inst.SkyboxBk = skyboxBk;
		inst.CelestialBodiesShown = true;
		inst.Parent = parent;
		return inst;
	};
	makeSky(dayFolder, "Sky day", 900, 11, "rbxasset://sky/sun.jpg");
	makeSky(nightFolder, "Sky night", 3000, 13, "rbxasset://sky/moon.jpg");
	const existingSky = makeSky(lightingContainer, "Sky day", 1, 1, "rbxasset://sky/sun.jpg");

	const lightingProxy: DayNightLightingLike & Record<string, unknown> = {
		ClockTime: 0,
		GlobalShadows: true,
		Brightness: 1,
		ExposureCompensation: 0,
		EnvironmentDiffuseScale: 1,
		EnvironmentSpecularScale: 1,
		Ambient: new Color3(0, 0, 0),
		OutdoorAmbient: new Color3(0, 0, 0),
		ColorShift_Top: new Color3(0, 0, 0),
		ColorShift_Bottom: new Color3(0, 0, 0),
		ShadowSoftness: 0.2,
		FogColor: new Color3(0, 0, 0),
		FogStart: 0,
		FogEnd: 100000,
		GeographicLatitude: 0,
		GetChildren(): Instance[] {
			return lightingContainer.GetChildren();
		},
		adoptEffect(effect: Instance): void {
			effect.Parent = lightingContainer;
		},
	};

	const simWs = makeMockWorkspace({
		[DAY_NIGHT_ATTRIBUTES.startTime]: 1000,
		[DAY_NIGHT_ATTRIBUTES.duration]: 24,
		[DAY_NIGHT_ATTRIBUTES.startHour]: 8,
		[DAY_NIGHT_ATTRIBUTES.paused]: false,
	});
	let simNow = 1000;
	const applier = new DayNightCycleApplier(lightingProxy, dayFolder, nightFolder, simWs, () => simNow);

	assertInvariant(
		lightingProxy.GlobalShadows === false && math.abs((lightingProxy.GeographicLatitude as number) - 26.8) < 1e-6,
		"propriedades estáticas e idênticas aplicadas no init",
	);
	applier.update();
	assertInvariant(
		math.abs(lightingProxy.ClockTime - 8) < DAY_NIGHT_EPSILON &&
			math.abs((lightingProxy.Brightness as number) - 2) < DAY_NIGHT_EPSILON &&
			existingBloom.Enabled &&
			math.abs(existingBloom.Intensity - 0.16) < DAY_NIGHT_EPSILON &&
			existingSky.StarCount === 900 &&
			existingSky.SkyboxBk === "rbxasset://sky/sun.jpg",
		"t=0 aplica dia e reutiliza Bloom/Sky existentes",
	);

	const activeDepth = lightingContainer.FindFirstChildOfClass("DepthOfFieldEffect")!;
	const activeCc = lightingContainer.FindFirstChildOfClass("ColorCorrectionEffect")!;
	const activeRays = lightingContainer.FindFirstChildOfClass("SunRaysEffect")!;
	const activeAtmo = lightingContainer.FindFirstChildOfClass("Atmosphere")!;
	const activeGrading = lightingContainer.FindFirstChildOfClass("ColorGradingEffect")!;
	assertInvariant(
		lightingContainer.GetChildren().filter((x) => x.IsA("BloomEffect")).size() === 1 &&
			lightingContainer.GetChildren().filter((x) => x.IsA("Sky")).size() === 1 &&
			activeDepth !== undefined &&
			activeCc !== undefined &&
			activeRays !== undefined &&
			activeAtmo !== undefined &&
			activeGrading !== undefined,
		"todos os efeitos são encontrados por classe sem duplicar",
	);

	simNow = 1009; // 17h -> crepúsculo antes de t=0.5
	applier.update();
	assertInvariant(
		existingBloom.Intensity > 0.16 &&
			existingBloom.Intensity < 0.26 &&
			activeDepth.FarIntensity > 0.12 &&
			activeDepth.FarIntensity < 0.17 &&
			activeRays.Intensity > 0 &&
			activeRays.Intensity < 0.04 &&
			existingSky.SkyboxBk === "rbxasset://sky/sun.jpg" &&
			activeGrading.TonemapperPreset === Enum.TonemapperPreset.Default,
		"crepúsculo interpola efeitos por classe mantendo faces diurnas antes de t=0.5",
	);

	simNow = 1010; // 18h -> t=0.5 exato
	applier.update();
	assertInvariant(
		existingSky.SkyboxBk === "rbxasset://sky/moon.jpg" &&
			activeGrading.TonemapperPreset === Enum.TonemapperPreset.Retro &&
			existingSky.StarCount === 1950,
		"virada em t=0.5 troca Skybox, TonemapperPreset e arredonda StarCount",
	);

	simNow = 1012; // 20h -> t=1
	applier.update();
	assertInvariant(
		math.abs((lightingProxy.Brightness as number) - 1) < DAY_NIGHT_EPSILON &&
			math.abs(activeRays.Intensity) < DAY_NIGHT_EPSILON &&
			existingSky.StarCount === 3000 &&
			(lightingProxy.FogColor as Color3) === new Color3(0, 0, 0),
		"plena noite aplica valores finais exatos",
	);

	simWs.attrs.set(DAY_NIGHT_ATTRIBUTES.paused, true);
	simNow = 1016; // seria 0h
	applier.update();
	assertInvariant(math.abs(lightingProxy.ClockTime - 20) < DAY_NIGHT_EPSILON, "Pausado congela ClockTime e efeitos");

	simWs.attrs.set(DAY_NIGHT_ATTRIBUTES.paused, false);
	applier.update();
	assertInvariant(math.abs(lightingProxy.ClockTime) < DAY_NIGHT_EPSILON, "retomar após pausa sincroniza hora atual");

	dayFolder.Destroy();
	nightFolder.Destroy();
	lightingContainer.Destroy();
	print("DAY_NIGHT_CYCLE_PASSED");
}

export function validateMultiHitDeath(): void {
	for (const lastFighter of [false, true]) {
		let rolls = 0;
		const rng = () => { rolls += 1; return 0.99; };
		const base = makeRealFighter("jotaro", rng);
		const attacker = new Fighter({ ...base, itemUuid: "multi-hit-attacker" });
		const target = makeDummyFighter("Menace");
		const replacement = makeDummyFighter("Menace");
		const timeline = attacker.skillData[1];
		const hitDamage = new DamageService().resolveHit(attacker, target, 2, timeline.hits[0].damageShare, rng).damage;
		target.hp = hitDamage + 1;
		const initialHp = target.hp;
		target.applyStatusEffect("Root", 3, 10);
		target.applyStatusEffect("Burn", 3, 10);
		replacement.applyStatusEffect("Root", 3, 10);
		const a = new BattleSide([attacker], rng);
		const b = new BattleSide(lastFighter ? [target] : [target, replacement], rng);
		const battle = new BattleService(a, b, rng);
		let resolvedHits = 0;
		let switches = 0;
		let ended = false;
		const order: string[] = [];
		battle.events.hitResolved.connect(({ hitIndex, target: hitTarget }) => {
			resolvedHits += 1;
			assertInvariant(hitIndex <= 2 && hitTarget === target, "hits ignorados n?o resolvem");
		});
		battle.events.death.connect(() => { order.push("death"); });
		battle.events.switchPerformed.connect(() => {
			switches += 1;
			order.push("switch");
			assertInvariant(battle.state === "ATTACK" && b.atb === ATB_MIN, "troca antes de RETURN com ATB zero");
		});
		battle.events.state.connect((state) => { if (state === "RETURN") order.push("return"); });
		battle.events.battleEnd.connect(() => { ended = true; });
		a.setAtb(ATB_MAX);
		b.setAtb(ATB_MAX);
		assertInvariant(!battle.requestSwitch(b, 1), "Root bloqueia troca volunt?ria");
		assertInvariant(battle.requestSkill(a, 2), "ORA ORA inicia");
		battle.step(timeline.prepareTime);
		battle.step(timeline.hits[1].time);
		assertInvariant(!target.isAlive() && !target.hasStatusEffect("Burn") && target.isRooted(), "morte no hit 2 limpa efeitos");
		assertInvariant(switches === 0 && b.getActiveFighter() === target, "ativo permanece at? fim de ATTACK");
		assertInvariant(ended === lastFighter, "?ltimo lutador encerra imediatamente");
		const rollsAtDeath = rolls;
		battle.step(timeline.hits[4].time - timeline.hits[1].time + FLOAT_TOLERANCE);
		assertInvariant(rolls === rollsAtDeath + (lastFighter ? 0 : 1), "somente sorteio da troca; sem Dodge/crit ignorado");
		assertInvariant(resolvedHits === 2 && battle.getDamageDealt(a, attacker.itemUuid!) === initialHp, "contadores XP/PVP excluem hits ignorados");
		assertInvariant(replacement.hp === replacement.hpMax, "substituto intacto");
		if (!lastFighter) {
			assertInvariant(b.getActiveFighter() === replacement && b.atb === ATB_MIN && replacement.isRooted(), "troca autom?tica ignora Root");
			assertInvariant(order.join(",") === "death,switch,return", "ordem de eventos preservada");
		}
	}
	print("MULTI_HIT_DEATH_PASSED");
}

export function runDummy1000Battles(): void {
	let winsByFirstSide = 0;
	let totalDuration = 0;
	for (let simulationIndex = 0; simulationIndex < SIMULATION_COUNT; simulationIndex++) {
		if (simulationIndex > 0 && simulationIndex % 50 === 0) task.wait();
		const verbose = simulationIndex === 0;
		const result = runBattle(FIRST_SIMULATION_SEED + simulationIndex, verbose);
		if (verbose) {
			print(
				`Resumo: vencedor=${result.winnerIndex === 0 ? "A" : "B"}, duração=${result.duration}, dano A=${result.damageBySide[0]}, dano B=${result.damageBySide[1]}`,
			);
		}
		if (result.winnerIndex === 0) winsByFirstSide += 1;
		totalDuration += result.duration;
	}
	const winRate = (winsByFirstSide / SIMULATION_COUNT) * 100;
	const averageDuration = totalDuration / SIMULATION_COUNT;
	print(`1000 lutas (dummy): winrate lado A=${winRate}%, duração média=${averageDuration}s`);
}
