import { PvpService } from "../Services/PvpService";
import { freezeBattleMovement } from "../Services/BattleMovement";
import { calcAverageLevel, calcRewardBracket } from "../../shared/RewardMath";
import { PVP_PROMPT_MAX_DISTANCE, PVP_INVITE_INTERVAL_SECONDS, PVP_INVITE_EXPIRY_SECONDS, PVP_DECLINE_WAIT_SECONDS, PVP_PAIR_WINDOW_SECONDS, PVP_DAILY_TINYES_CAP, PVP_DAILY_XP_CAP, PVP_DAY_SECONDS, PVP_MAX_PAIR_ENTRIES } from "../../shared/Config";
import type { ChallengeReceivedPayload, ChallengeStatusPayload, NpcBattleNoticePayload } from "../../shared/Remotes";
import { InventoryService } from "../Services/InventoryService";
import { ShopService } from "../Services/ShopService";
import { DayNightService } from "../Services/DayNightService";
import {
	calcNightAlpha,
	calcSolarHour,
	DayNightCycleApplier,
	lerpColor3Gamma,
	shouldSkipInterpolation,
	smoothstepQuintic,
	type DayNightLightingLike,
} from "../../shared/DayNightCycle";
import {
	DAY_NIGHT_ATTRIBUTES,
	DAY_NIGHT_DEFAULT_DURATION_SECONDS,
	DAY_NIGHT_DEFAULT_START_HOUR,
	DAY_NIGHT_EPSILON,
} from "../../shared/Config";
import { SHOP_PRICE_RANGES, SHOP_RESET_WINDOW_SECONDS, SHOP_REQUEST_BUCKET_CAPACITY } from "../../shared/Config";
import { calcOfferPrice, calcStatQuality } from "../../shared/MathUtils";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { BATTLE_NPC_TAG, NPC_BATTLE_ACTIVE_ATTRIBUTE, NPC_PROMPT_DEBOUNCE_SECONDS, NPC_PROMPT_MAX_DISTANCE } from "../../shared/Config";
import { NPC_DATA, type NpcDefinition } from "../../shared/NpcData";
import { createNpcSide, NpcService } from "../Services/NpcService";
import { calcEffectiveStats } from "../../shared/ProgressionMath";
import { TINYES_MAX_ADD_PER_CALL, TINYES_WIN_BY_TIER, MAX_SAVED_NUMBER, BATTLE_INACTIVITY_TIMEOUT_SECONDS } from "../../shared/Config";
import { TinyesService } from "../Services/TinyesService";
import { CLASS_DATA, doesClassCounter } from "../../shared/ClassData";
import {
	AI_BRONZE_SKILL_DELAY_MAX_SECONDS,
	AI_BRONZE_SKILL_DELAY_MIN_SECONDS,
	AI_BRONZE_TIMED_SWITCH_MAX_SECONDS,
	AI_BRONZE_TIMED_SWITCH_MIN_SECONDS,
	AI_BRONZE_ULTIMATE_DELAY_MAX_SECONDS,
	AI_BRONZE_ULTIMATE_DELAY_MIN_SECONDS,
	ATB_MAX,
	ATB_MIN,
	ATK_PER_POINT,
	BLEED_DAMAGE_SHARE,
	BIND_TO_CLOSE_TIMEOUT_SECONDS,
	BURN_DAMAGE_SHARE,
	CRIT_MULTIPLIER,
	CRIT_POINTS_PER_POINT,
	DATASTORE_MAX_RETRIES,
	DATASTORE_RETRY_BACKOFF_FACTOR,
	DATASTORE_RETRY_BASE_DELAY_SECONDS,
	DEFAULT_STARTER_FIGHTER_ID,
	DODGE_POINTS_PER_POINT,
	DOT_TICKS,
	FLOAT_TOLERANCE,
	HP_PER_POINT,
	INITIAL_TINYES,
	LOGOUT_RETRY_MAX_BACKOFF_SECONDS,
	MAX_LEVEL,
	MIN_LEVEL,
	PLAYER_DATA_SCHEMA_VERSION,
	PVE_PAUSE_MAX_SECONDS,
	ROOT_DURATION_BY_SLOT,
	SAVE_WAIT_TIMEOUT_SECONDS,
	SESSION_LOCK_EXPIRATION_SECONDS,
	SESSION_LOCK_KICK_MESSAGE,
	SESSION_LOCK_LOST_KICK_MESSAGE,
	SESSION_LOCK_WAIT_ATTEMPTS,
	TOTAL_STAT_POINTS,
	ALLOCATE_REQUEST_BUCKET_CAPACITY,
	ALLOCATE_REQUEST_REFILL_PER_SECOND,
	BATTLE_REQUEST_BUCKET_CAPACITY,
	BATTLE_REQUEST_REFILL_PER_SECOND,
	MAX_ITEM_UUID_LENGTH,
	MAX_SKILL_SLOT,
	MIN_SKILL_SLOT,
	S3_UNLOCK_LEVEL,
} from "../../shared/Config";
import { FIGHTER_DATA } from "../../shared/FighterData";
import { calcDano, calcSkillSlotRoll } from "../../shared/MathUtils";
import {
	calcAvailablePoints,
	calcBattleTotalXp,
	calcFighterSlotXp,
	calcLevelDiffXpMultiplier,
	calcPostBattleTeamXp,
	calcTeamXpShareFractions,
	calcTotalPointsForLevel,
	calcMaxUsefulXp,
	calcXpForNextLevel,
	resolveXpAndLevelUp,
} from "../../shared/ProgressionMath";
import type { AllocationReason, BattleEndedPayload, BattleStartedPayload, PurchaseReason, PurchaseResultPayload, ShopStatePayload } from "../../shared/Remotes";
import type { BattleGlobalState, FighterInventoryItem, SkillSlot, SkillSlots, StatBlock } from "../../shared/TypeDefs";
import { BattleSide, type FighterIndex, type FighterLineup } from "../Components/BattleSide";
import { Fighter } from "../Components/Fighter";
import { AIService } from "../Services/AIService";
import { BattleService } from "../Services/BattleService";
import { BattleSessionService } from "../Services/BattleSessionService";
import { DamageService } from "../Services/DamageService";
import {
	InMemoryDataStore,
	PlayerDataService,
	validatePlayerSaveData,
	migratePlayerData,
	type DataStoreLike,
	type PlayerSaveData,
	type SchemaMigrationFn,
} from "../Services/PlayerDataService";
import { ProgressionService } from "../Services/ProgressionService";
import { RemoteService, type BattleRemoteAdapter } from "../Services/RemoteService";
import { createDummySide, createJotaroVsAnubisSides, makeDummyFighter, makeRealFighter } from "./DummyFighters";
import { createJotaroVsAnubisBattleSession } from "./DummyBattleSession";

const SIMULATION_DT = 0.05;
const SIMULATION_COUNT = 1000;
const FIRST_SIMULATION_SEED = 20261112;
const MAX_SIMULATION_STEPS = 200000;
const MIN_HIT_DAMAGE = 1;
const LOW_HP_SWITCH_RATIO = 0.3;
const SWITCH_COOLDOWN_STEPS = 120;
const SLOT_1_PROBABILITY = 0.4;
const SLOT_2_CUMULATIVE_PROBABILITY = 0.75;

interface SimulationResult {
	readonly winner: BattleSide;
	readonly winnerIndex: 0 | 1;
	readonly duration: number;
	readonly damageBySide: readonly [number, number];
}

function createSeededRng(initialSeed: number): () => number {
	let seed = initialSeed;
	const nextRandom = (): number => {
		seed = (seed * 48271) % 2147483647;
		return seed / 2147483647;
	};
	nextRandom();
	nextRandom();
	return nextRandom;
}

function assertInvariant(condition: boolean, message: string): void {
	if (!condition) error(`BattleSimulator assertion failed: ${message}`);
}

function isPausedState(state: BattleGlobalState): boolean {
	return state === "PREPARE" || state === "ATTACK" || state === "RETURN";
}

function formatSide(side: BattleSide, firstSide: BattleSide): string {
	return side === firstSide ? "A" : "B";
}

function pickNextSlot(rng: () => number): SkillSlot {
	const roll = rng();
	if (roll < SLOT_1_PROBABILITY) return 1;
	if (roll < SLOT_2_CUMULATIVE_PROBABILITY) return 2;
	return 3;
}

function findBestSwitchIndex(side: BattleSide, enemyActive: Fighter): FighterIndex | undefined {
	const active = side.getActiveFighter();
	const isLowHp = active.hp <= active.hpMax * LOW_HP_SWITCH_RATIO;
	const isCountered = doesClassCounter(enemyActive.className, active.className);
	if (!isLowHp && !isCountered) return undefined;

	let bestCounterIndex: FighterIndex | undefined;
	let bestHealthyIndex: FighterIndex | undefined;

	for (const index of $range(0, 2)) {
		const candidateIndex = index as FighterIndex;
		if (candidateIndex === side.activeIndex) continue;
		const candidate = side.fighters[candidateIndex];
		if (!candidate.isAlive() || candidate.hp <= candidate.hpMax * LOW_HP_SWITCH_RATIO) continue;

		if (doesClassCounter(candidate.className, enemyActive.className)) {
			bestCounterIndex = candidateIndex;
			break;
		}
		if (!doesClassCounter(enemyActive.className, candidate.className) && candidate.hp > active.hp) {
			bestHealthyIndex = candidateIndex;
		}
	}

	if (bestCounterIndex !== undefined) return bestCounterIndex;
	if (isLowHp && bestHealthyIndex !== undefined) return bestHealthyIndex;
	return undefined;
}

function validateStatusEffectRules(): void {
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

function validatePauseAndQuitRules(): void {
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

function runBattleWithSides(
	firstSide: BattleSide,
	secondSide: BattleSide,
	rng: () => number,
	verbose: boolean,
): SimulationResult {
	const sides: readonly [BattleSide, BattleSide] = [firstSide, secondSide];
	const battle = new BattleService(firstSide, secondSide, rng);
	const damageBySide: [number, number] = [0, 0];
	const deathInStep: [boolean, boolean] = [false, false];
	const plannedSlots: [SkillSlot, SkillSlot] = [pickNextSlot(rng), pickNextSlot(rng)];
	const lastSwitchStep: [number, number] = [-SWITCH_COOLDOWN_STEPS, -SWITCH_COOLDOWN_STEPS];
	let winner: BattleSide | undefined;
	let duration = 0;

	battle.events.state.connect((state) => {
		assertInvariant(winner === undefined, `mudança de estado (${state}) após o fim da luta`);
		if (verbose) print(`estado: ${state}`);
	});

	battle.events.attackStarted.connect(({ attacker, target, slot }) => {
		assertInvariant(attacker.isAlive(), "lutador morto iniciou um ataque");
		if (verbose) print(`attackStarted: ${attacker.fighterId} (${attacker.className}) S${slot} -> ${target.fighterId} (${target.className})`);
	});

	battle.events.hitResolved.connect(({ hitIndex, hit, crit, damage, target, followUpCancelled }) => {
		assertInvariant(hitIndex >= 1, "hitIndex deve começar em 1");
		if (hit) {
			assertInvariant(damage >= MIN_HIT_DAMAGE, "dano de acerto abaixo do mínimo");
			assertInvariant(!followUpCancelled, "acerto não pode cancelar follow-up");
		} else {
			assertInvariant(!crit && damage === 0, "hit esquivado não pode ser crítico nem causar dano");
		}
		const targetSideIndex = sides[0].fighters.includes(target) ? 0 : 1;
		damageBySide[1 - targetSideIndex] += damage;
		if (verbose) {
			print(
				`hitResolved: hitIndex=${hitIndex}, hit=${hit}, crit=${crit}, damage=${damage}, followUpCancelled=${followUpCancelled}, target=${target.fighterId}`,
			);
		}
	});

	battle.events.effectApplied.connect(({ side, target, effect, duration: effectDuration, totalDamage, renewed }) => {
		assertInvariant(target.isAlive() && target.localState !== "CAIDO", "efeito aplicado em lutador caído");
		assertInvariant(target.hasStatusEffect(effect), "efeito aplicado não consta no lutador");
		assertInvariant(target.statusEffects.size() <= 3, "efeitos empilharam indevidamente");
		if (effect === "Bleed" || effect === "Burn") {
			assertInvariant(totalDamage > 0, "DoT aplicado sem dano real");
		}
		if (verbose) {
			print(
				`effectApplied: lado ${formatSide(side, firstSide)}, ${target.fighterId} [${effect}] dur=${effectDuration}s renewed=${renewed}`,
			);
		}
	});

	battle.events.effectTick.connect(({ side, target, effect, damage, remainingTicks }) => {
		assertInvariant(battle.state === "IDLE", `DoT rodou fora de IDLE (${battle.state})`);
		assertInvariant(damage >= MIN_HIT_DAMAGE, "tick de DoT nunca pode ser 0");
		const targetSideIndex = side === firstSide ? 0 : 1;
		damageBySide[1 - targetSideIndex] += damage;
		if (verbose) {
			print(
				`effectTick: lado ${formatSide(side, firstSide)}, ${target.fighterId} [${effect}] dmg=${damage} restam=${remainingTicks}`,
			);
		}
	});

	battle.events.effectExpired.connect(({ side, target, effect }) => {
		assertInvariant(!target.hasStatusEffect(effect), "efeito expirado permaneceu no lutador");
		if (verbose) {
			print(`effectExpired: lado ${formatSide(side, firstSide)}, ${target.fighterId} [${effect}]`);
		}
	});

	battle.events.death.connect(({ side, fighter, nextActive }) => {
		const sideIndex = side === firstSide ? 0 : 1;
		deathInStep[sideIndex] = true;
		plannedSlots[sideIndex] = pickNextSlot(rng);
		assertInvariant(side.atb === 0, "ATB não zerou após a morte");
		if (!side.isDefeated()) {
			assertInvariant(
				(battle.state === "ATTACK" && nextActive === undefined && side.getActiveFighter() === fighter) ||
				(nextActive !== undefined && nextActive.isAlive() && side.getActiveFighter() === nextActive),
				"troca automática por morte falhou (deve ignorar Root)",
			);
		}
		if (verbose) print(`morte: lado ${formatSide(side, firstSide)}, ${fighter.fighterId}; próximo=${nextActive?.fighterId ?? "nenhum"}`);
	});

	battle.events.battleEnd.connect((winningSide) => {
		assertInvariant(winningSide !== undefined, "luta terminou sem vencedor");
		if (winningSide === undefined) return;
		winner = winningSide;
		if (verbose) print(`fim: vencedor lado ${formatSide(winningSide, firstSide)}`);
	});

	for (let stepIndex = 0; stepIndex < MAX_SIMULATION_STEPS && winner === undefined; stepIndex++) {
		if (battle.state === "IDLE") {
			const firstDecisionIndex = rng() < 0.5 ? 0 : 1;
			for (let offset = 0; offset < sides.size(); offset++) {
				const sideIndex = (firstDecisionIndex + offset) % sides.size();
				const side = sides[sideIndex];
				const enemySide = sides[1 - sideIndex];
				if (side.isDefeated() || enemySide.isDefeated()) continue;

				if (stepIndex - lastSwitchStep[sideIndex] >= SWITCH_COOLDOWN_STEPS) {
					const switchIndex = findBestSwitchIndex(side, enemySide.getActiveFighter());
					if (switchIndex !== undefined) {
						const previousFighter = side.getActiveFighter();
						const wasRooted = previousFighter.isRooted();
						const switched = battle.requestSwitch(side, switchIndex);
						if (wasRooted) {
							assertInvariant(!switched, "Root falhou em bloquear a troca");
						} else if (switched) {
							lastSwitchStep[sideIndex] = stepIndex;
							if (verbose) {
								print(
									`troca: lado ${formatSide(side, firstSide)}, ${previousFighter.fighterId} -> ${side.getActiveFighter().fighterId}`,
								);
							}
						}
					}
				}

				if (plannedSlots[sideIndex] === 3 && side.getActiveFighter().level < S3_UNLOCK_LEVEL) {
					plannedSlots[sideIndex] = rng() < SLOT_1_PROBABILITY / SLOT_2_CUMULATIVE_PROBABILITY ? 1 : 2;
				}
				const targetSlot = plannedSlots[sideIndex];
				const requiredAtb = side.getActiveFighter().slots[targetSlot - 1].cost;
				if (side.atb >= requiredAtb && battle.requestSkill(side, targetSlot)) {
					plannedSlots[sideIndex] = pickNextSlot(rng);
					break;
				}
			}
		}

		deathInStep[0] = false;
		deathInStep[1] = false;
		const previousAtb: [number, number] = [firstSide.atb, secondSide.atb];
		battle.step(SIMULATION_DT);
		duration += SIMULATION_DT;

		for (let sideIndex = 0; sideIndex < sides.size(); sideIndex++) {
			const side = sides[sideIndex];
			assertInvariant(side.atb >= ATB_MIN && side.atb <= ATB_MAX, "ATB saiu do intervalo permitido");
			if (deathInStep[sideIndex]) {
				assertInvariant(side.atb === 0, "ATB do lado do morto diferente de 0 após a morte");
			} else if (isPausedState(battle.state)) {
				assertInvariant(side.atb === previousAtb[sideIndex], `ATB mudou durante ${battle.state}`);
			}
		}
	}

	if (winner === undefined) error("BattleSimulator assertion failed: luta excedeu o limite de passos");
	return { winner, winnerIndex: winner === firstSide ? 0 : 1, duration, damageBySide };
}

function runBattle(seed: number, verbose: boolean): SimulationResult {
	const rng = createSeededRng(seed);
	const firstSide = createDummySide(rng);
	const secondSide = createDummySide(rng);
	return runBattleWithSides(firstSide, secondSide, rng, verbose);
}

function validateJotaroAndAnubis(): void {
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
	assertInvariant(
		jotaroDef.skills[0].name === "star_Finger" && jotaroDef.skills[0].hits.size() === 1,
		"Jotaro S1 star_Finger deve ter 1 hit",
	);
	assertInvariant(
		jotaroDef.skills[1].name === "Barragem_estelar" && jotaroDef.skills[1].hits.size() === 5,
		"Jotaro S2 Barragem_estelar deve ter 5 hits",
	);
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

function validateCritDamageMultiplier(): void {
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

function validateBronzeAI(): void {
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

/** Curva de custo por nível e XP pós-batalha por slot (pool, divisão por tamanho do time, multiplicador por diferença de nível, level-ups). */
function validateXpCurveAndTeamDistribution(): void {
	// a. Custo de nível = XP_LEVEL_PER_LEVEL * nível atual; no cap não há próximo nível
	assertInvariant(calcXpForNextLevel(1) === 100, "Nv.1 exige 100 XP");
	assertInvariant(calcXpForNextLevel(10) === 1000, "Nv.10 exige 1.000 XP");
	assertInvariant(calcXpForNextLevel(20) === 2000, "Nv.20 exige 2.000 XP");
	assertInvariant(calcXpForNextLevel(MAX_LEVEL) === 0, "no nível máximo não existe custo de próximo nível");

	// b. Pool total (somente vitória PvE) e divisão por quantidade de lutadores válidos
	assertInvariant(calcBattleTotalXp(20, true) === 375, "inimigo nível médio 20 gera 375 XP totais (75 + 15 * 20)");
	assertInvariant(
		calcBattleTotalXp(20, false) === 0 && calcBattleTotalXp(0 / 0, true) === 0 && calcBattleTotalXp(-1, true) === 0,
		"derrota/Quit/desconexão/timeout (sem vitória PvE) e nível médio inválido geram 0 XP",
	);
	const lv20 = (damageDealt: number) => ({ level: 20, damageDealt });
	const evenTeam = calcPostBattleTeamXp(20, true, [lv20(100), lv20(100), lv20(100)]);
	assertInvariant(
		evenTeam[0] === 187 && evenTeam[1] === 93 && evenTeam[2] === 93,
		"3 válidos com dano empatado: 50% (187) ao slot 0 e 25% (93) a cada outro (nível parelho, 1.00x)",
	);
	const defeatTeam = calcPostBattleTeamXp(20, false, [lv20(1), lv20(1), lv20(1)]);
	assertInvariant(defeatTeam[0] === 0 && defeatTeam[1] === 0 && defeatTeam[2] === 0, "derrota não paga XP");
	const emptyTeam = calcPostBattleTeamXp(20, true, [undefined, undefined, undefined]);
	assertInvariant(emptyTeam[0] === 0 && emptyTeam[1] === 0 && emptyTeam[2] === 0, "time sem lutador válido não gera XP");

	// c. 1 lutador válido: 100% do pool em qualquer slot; slots vazios não roubam fatia
	const solo0 = calcPostBattleTeamXp(20, true, [lv20(0), undefined, undefined]);
	assertInvariant(solo0[0] === 375 && solo0[1] === 0 && solo0[2] === 0, "[A, undefined, undefined]: A recebe 100% do pool (375)");
	const solo1 = calcPostBattleTeamXp(20, true, [undefined, lv20(7), undefined]);
	assertInvariant(solo1[0] === 0 && solo1[1] === 375 && solo1[2] === 0, "único válido no slot 1 recebe 100% do pool (375)");
	const solo2 = calcPostBattleTeamXp(20, true, [undefined, undefined, lv20(7)]);
	assertInvariant(solo2[0] === 0 && solo2[1] === 0 && solo2[2] === 375, "único válido no slot 2 recebe 100% do pool (375)");

	// c2. 2 lutadores válidos: 50% / 50% independentemente do dano causado (slot vazio não recebe nem rouba)
	const duoGap = calcPostBattleTeamXp(20, true, [lv20(900), undefined, lv20(0)]);
	assertInvariant(duoGap[0] === 187 && duoGap[1] === 0 && duoGap[2] === 187, "2 válidos (slots 0 e 2): 50% / 50% (187 / 187)");
	const duoTail = calcPostBattleTeamXp(20, true, [undefined, lv20(0), lv20(900)]);
	assertInvariant(duoTail[0] === 0 && duoTail[1] === 187 && duoTail[2] === 187, "2 válidos (slots 1 e 2): 50% / 50% (187 / 187)");

	// c3. 3 lutadores válidos: 50% ao maior dano causado, 25% / 25% aos demais
	const topSlot0 = calcPostBattleTeamXp(20, true, [lv20(50), lv20(30), lv20(10)]);
	assertInvariant(topSlot0[0] === 187 && topSlot0[1] === 93 && topSlot0[2] === 93, "maior dano no slot 0: 187 / 93 / 93");
	const topSlot1 = calcPostBattleTeamXp(20, true, [lv20(10), lv20(50), lv20(30)]);
	assertInvariant(topSlot1[0] === 93 && topSlot1[1] === 187 && topSlot1[2] === 93, "maior dano no slot 1: 93 / 187 / 93");
	const topSlot2 = calcPostBattleTeamXp(20, true, [lv20(10), lv20(30), lv20(50)]);
	assertInvariant(topSlot2[0] === 93 && topSlot2[1] === 93 && topSlot2[2] === 187, "maior dano no slot 2: 93 / 93 / 187");
	// Desempate determinístico no maior dano: menor índice de slot (0 > 1 > 2)
	const tieZero = calcPostBattleTeamXp(20, true, [lv20(0), lv20(0), lv20(0)]);
	assertInvariant(tieZero[0] === 187 && tieZero[1] === 93 && tieZero[2] === 93, "todos com dano 0: slot 0 leva 50%");
	const tieAll = calcPostBattleTeamXp(20, true, [lv20(9), lv20(9), lv20(9)]);
	assertInvariant(tieAll[0] === 187 && tieAll[1] === 93 && tieAll[2] === 93, "todos com mesmo dano: slot 0 leva 50%");
	const tieTopTwo12 = calcPostBattleTeamXp(20, true, [lv20(5), lv20(9), lv20(9)]);
	assertInvariant(tieTopTwo12[0] === 93 && tieTopTwo12[1] === 187 && tieTopTwo12[2] === 93, "empate no topo entre slots 1 e 2: slot 1 leva 50%");
	const tieTopTwo02 = calcPostBattleTeamXp(20, true, [lv20(9), lv20(5), lv20(9)]);
	assertInvariant(tieTopTwo02[0] === 187 && tieTopTwo02[1] === 93 && tieTopTwo02[2] === 93, "empate no topo entre slots 0 e 2: slot 0 leva 50%");
	const topLast = calcPostBattleTeamXp(20, true, [lv20(5), lv20(5), lv20(9)]);
	assertInvariant(topLast[0] === 93 && topLast[1] === 93 && topLast[2] === 187, "slot 2 com dano estritamente maior leva 50%");
	// Entradas de dano inválidas contam como 0
	const badDamage = calcPostBattleTeamXp(20, true, [lv20(0 / 0), lv20(-5), lv20(3)]);
	assertInvariant(badDamage[2] === 187 && badDamage[0] === 93 && badDamage[1] === 93, "dano NaN/negativo vale 0 e perde para dano positivo");

	// c4. 100% do pool sempre aproveitado: frações somam 1 para 1, 2 e 3 válidos
	const fractionSum = (team: readonly [{ level: number; damageDealt: number } | undefined, { level: number; damageDealt: number } | undefined, { level: number; damageDealt: number } | undefined]): number => {
		const fractions = calcTeamXpShareFractions(team);
		return fractions[0] + fractions[1] + fractions[2];
	};
	assertInvariant(
		math.abs(fractionSum([lv20(1), undefined, undefined]) - 1) <= FLOAT_TOLERANCE &&
			math.abs(fractionSum([lv20(1), lv20(2), undefined]) - 1) <= FLOAT_TOLERANCE &&
			math.abs(fractionSum([lv20(1), lv20(2), lv20(3)]) - 1) <= FLOAT_TOLERANCE,
		"frações de 1, 2 e 3 lutadores válidos somam 100% do pool",
	);

	// c5. Ordem: divisão do pool -> multiplicador de nível -> arredondamento só no fim
	// 375 * 0.50 = 187.5 * 1.35 = 253.125 -> 253 (arredondar antes da multiplicação daria 187 * 1.35 = 252)
	const cutBeforeMultiplier = calcPostBattleTeamXp(20, true, [{ level: 1, damageDealt: 10 }, lv20(0), lv20(0)]);
	assertInvariant(cutBeforeMultiplier[0] === 253, "fatia 50% e multiplicador 1.35x aplicados antes do arredondamento (253)");

	// c6. Tabela de multiplicadores por diferença de nível (fronteiras inclusivas)
	const expectedMultipliers: readonly (readonly [number, number])[] = [
		[-10, 1.35],
		[-3, 1.35],
		[-2, 1.15],
		[-1, 1.15],
		[0, 1],
		[1, 1],
		[2, 0.6],
		[3, 0.6],
		[4, 0.25],
		[5, 0.25],
		[6, 0.05],
		[29, 0.05],
	];
	for (const [diff, expected] of expectedMultipliers) {
		assertInvariant(
			math.abs(calcLevelDiffXpMultiplier(20 + diff, 20) - expected) <= FLOAT_TOLERANCE,
			`diff ${diff} deve usar multiplicador ${expected}`,
		);
	}

	// d. Catch-up individual: Nv.1 recebe 1.35x depois da divisão e não infla a XP dos aliados Nv.20 do mesmo time
	const catchUpTeam = calcPostBattleTeamXp(20, true, [{ level: 1, damageDealt: 10 }, lv20(5), lv20(5)]);
	assertInvariant(catchUpTeam[0] === 253, "Nv.1 (maior dano, 50%) contra inimigo Nv.20 recebe 375 * 0.50 * 1.35 = 253");
	assertInvariant(
		catchUpTeam[1] === evenTeam[1] && catchUpTeam[2] === evenTeam[2] && catchUpTeam[1] === 93,
		"aliado Nv.20 mantém 93 XP (25%) mesmo com um Nv.1 no time",
	);
	const catchUpOther = calcPostBattleTeamXp(20, true, [lv20(10), { level: 1, damageDealt: 5 }, lv20(5)]);
	assertInvariant(
		catchUpOther[0] === 187 && catchUpOther[1] === 126 && catchUpOther[2] === 93,
		"Nv.1 em fatia de 25%: 375 * 0.25 * 1.35 = 126; aliados mantêm 187 e 93",
	);
	const catchUpSolo = calcPostBattleTeamXp(20, true, [{ level: 1, damageDealt: 0 }, undefined, undefined]);
	assertInvariant(catchUpSolo[0] === 506 && catchUpSolo[1] === 0 && catchUpSolo[2] === 0, "Nv.1 sozinho: 375 * 1.00 * 1.35 = 506");

	// e. Overlevel: Nv.20 contra inimigo Nv.10 (diff 10) recebe 0.05x depois da divisão e nunca 0 (mínimo 1 XP inteira)
	const overlevelTeam = calcPostBattleTeamXp(10, true, [lv20(5), lv20(5), lv20(5)]);
	assertInvariant(
		overlevelTeam[0] === 5 && overlevelTeam[1] === 2 && overlevelTeam[2] === 2,
		"Nv.20 contra inimigo Nv.10 (pool 225): 112.5 * 0.05 = 5.6 -> 5 e 56.25 * 0.05 = 2.8 -> 2",
	);
	const overlevelSolo = calcPostBattleTeamXp(10, true, [lv20(0), undefined, undefined]);
	assertInvariant(overlevelSolo[0] === 11, "Nv.20 sozinho contra inimigo Nv.10: 225 * 0.05 = 11.25 -> 11");
	const tinyRawTeam = calcPostBattleTeamXp(1, true, [
		{ level: 30, damageDealt: 5 },
		{ level: 30, damageDealt: 1 },
		{ level: 30, damageDealt: 1 },
	]);
	assertInvariant(
		tinyRawTeam[0] === 2 && tinyRawTeam[1] === 1 && tinyRawTeam[2] === 1,
		"inimigo Nv.1: 90 * 0.50 * 0.05 = 2.25 -> 2 e 90 * 0.25 * 0.05 = 1.125 -> 1",
	);
	assertInvariant(
		calcFighterSlotXp(75, 0.25, { level: 30, damageDealt: 1 }, 1) === 1,
		"XP bruta positiva menor que 1 (75 * 0.25 * 0.05 = 0.9375) garante mínimo de 1 XP inteira no cálculo do slot",
	);

	// f. Múltiplos level-ups em uma única entrega e respeito ao level cap
	const resolvedMulti = resolveXpAndLevelUp(
		1,
		0,
		calcXpForNextLevel(1) + calcXpForNextLevel(2) + calcXpForNextLevel(3) + 50,
		{ hp: 0, atk: 0, dodge: 0, crit: 0 },
	);
	assertInvariant(
		resolvedMulti.level === 4 && resolvedMulti.xp === 50 && resolvedMulti.levelsGained === 3,
		"resolveXpAndLevelUp deve subir 3 níveis de uma vez e manter 50 XP residual",
	);
	const resolvedCap = resolveXpAndLevelUp(29, 0, 1_000_000, { hp: 0, atk: 0, dodge: 0, crit: 0 });
	assertInvariant(
		resolvedCap.level === MAX_LEVEL && resolvedCap.xp === 0 && resolvedCap.levelsGained === 1,
		"XP excedente no nível 29 deve parar no cap (Lv30) com XP residual 0",
	);

	const remoteService = new RemoteService();
	const progressionService = new ProgressionService(remoteService);
	const player = { Name: "XpCurveTestPlayer" } as unknown as Player;
	const skills: SkillSlots = [calcSkillSlotRoll(1, 0.25), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.75)];
	const createFighter = (): string =>
		progressionService.createInventoryFighter(player, {
			fighterId: "jotaro",
			rarity: "Comum",
			baseStats: { hp: 200, atk: 12, dodge: 5, crit: 6 },
			skills,
		}).itemUuid;
	const xpToReachLevel = (level: number): number => {
		let total = 0;
		for (const current of $range(MIN_LEVEL, level - 1)) total += calcXpForNextLevel(current);
		return total;
	};

	// f1. Entrega única pelo serviço: Nv.1 (maior dano, 50%) vs inimigo médio 30 => 525 * 0.50 * 1.35 = 354 XP => Lv3 com 54 residual
	const multiUuid = createFighter();
	const filler1 = createFighter();
	const filler2 = createFighter();
	const multiAward = progressionService.awardPostBattleTeamXp(player, 30, true, [
		{ itemUuid: multiUuid, damageDealt: 1 },
		{ itemUuid: filler1, damageDealt: 0 },
		{ itemUuid: filler2, damageDealt: 0 },
	]);
	assertInvariant(
		multiAward[0] !== undefined && multiAward[0].level === 3 && multiAward[0].xp === 54,
		"uma única entrega de XP deve processar múltiplos level-ups em loop (Lv1 -> Lv3, 54 XP residual)",
	);
	assertStoredEqual(progressionService.getFighter(player, multiUuid), multiAward[0], "múltiplos level-ups confirmados no inventário");

	// f2. Cap: nada passa de Lv30 e o XP residual no cap é 0
	const capUuid = createFighter();
	const lv29 = progressionService.addXp(player, capUuid, xpToReachLevel(29));
	assertInvariant(lv29 !== undefined && lv29.level === 29 && lv29.xp === 0, "XP acumulada exata deve levar ao Lv29 sem resíduo");
	const lv30 = progressionService.addXp(player, capUuid, calcXpForNextLevel(29) + 5000);
	assertInvariant(lv30 !== undefined && lv30.level === MAX_LEVEL && lv30.xp === 0, "XP excedente deve respeitar o level cap (Lv30, xp 0)");
	const afterCap = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: capUuid, damageDealt: 1 },
		{ itemUuid: filler1, damageDealt: 0 },
		{ itemUuid: filler2, damageDealt: 0 },
	]);
	assertInvariant(afterCap[0] !== undefined && afterCap[0].level === MAX_LEVEL && afterCap[0].xp === 0, "premiar XP no Lv30 mantém Lv30 e xp 0");

	// d2. Catch-up pelo serviço: Nv.1 (maior dano, 50%) ganha 253 e os Nv.20 do time ganham 93 (25%); nível lido do inventário
	const lowUuid = createFighter();
	const highA = createFighter();
	const highB = createFighter();
	progressionService.addXp(player, highA, xpToReachLevel(20));
	progressionService.addXp(player, highB, xpToReachLevel(20));
	const mixed = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: lowUuid, damageDealt: 1 },
		{ itemUuid: highA, damageDealt: 1 },
		{ itemUuid: highB, damageDealt: 1 },
	]);
	assertInvariant(
		mixed[0] !== undefined &&
			mixed[0].level === 2 &&
			mixed[0].xp === 153 &&
			mixed[1] !== undefined &&
			mixed[1].level === 20 &&
			mixed[1].xp === 93 &&
			mixed[2] !== undefined &&
			mixed[2].level === 20 &&
			mixed[2].xp === 93,
		"serviço aplica divisão e multiplicador individual: Nv.1 recebe 253 (Lv2, 153) e Nv.20 recebe 93",
	);

	// Derrota/Quit não altera XP
	const lossAward = progressionService.awardPostBattleTeamXp(player, 20, false, [
		{ itemUuid: lowUuid, damageDealt: 1 },
		{ itemUuid: highA, damageDealt: 1 },
		{ itemUuid: highB, damageDealt: 1 },
	]);
	assertInvariant(
		lossAward[0] !== undefined &&
			lossAward[0].level === 2 &&
			lossAward[0].xp === 153 &&
			lossAward[1] !== undefined &&
			lossAward[1].xp === 93,
		"sem vitória PvE o awardPostBattleTeamXp não altera nível nem XP",
	);

	// d3. Serviço com 1, 2 e 3 válidos (slots vazios não roubam percentual; desempate por índice de slot)
	const soloSvcUuid = createFighter();
	const soloSvcAward = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: soloSvcUuid, damageDealt: 0 },
		undefined,
		undefined,
	]);
	assertInvariant(
		soloSvcAward[0] !== undefined &&
			soloSvcAward[0].level === 3 &&
			soloSvcAward[0].xp === 206 &&
			soloSvcAward[1] === undefined &&
			soloSvcAward[2] === undefined,
		"serviço [fighterA, undefined, undefined]: A recebe 100% do pool (506 XP -> Lv3, 206)",
	);
	const duoSvcA = createFighter();
	const duoSvcB = createFighter();
	const duoSvcAward = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: duoSvcA, damageDealt: 999 },
		undefined,
		{ itemUuid: duoSvcB, damageDealt: 0 },
	]);
	assertInvariant(
		duoSvcAward[0] !== undefined &&
			duoSvcAward[0].level === 2 &&
			duoSvcAward[0].xp === 153 &&
			duoSvcAward[1] === undefined &&
			duoSvcAward[2] !== undefined &&
			duoSvcAward[2].level === 2 &&
			duoSvcAward[2].xp === 153,
		"serviço com 2 válidos divide 50% / 50% (253 XP cada -> Lv2, 153)",
	);
	const trioA = createFighter();
	const trioB = createFighter();
	const trioC = createFighter();
	progressionService.addXp(player, trioA, xpToReachLevel(20));
	progressionService.addXp(player, trioB, xpToReachLevel(20));
	progressionService.addXp(player, trioC, xpToReachLevel(20));
	const trioTop2 = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: trioA, damageDealt: 10 },
		{ itemUuid: trioB, damageDealt: 20 },
		{ itemUuid: trioC, damageDealt: 50 },
	]);
	assertInvariant(
		trioTop2[0]?.xp === 93 && trioTop2[1]?.xp === 93 && trioTop2[2]?.xp === 187,
		"serviço com 3 válidos entrega 50% (187) ao maior causador de dano (slot 2) e 25% (93) aos demais",
	);
	const trioTie12 = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: trioA, damageDealt: 10 },
		{ itemUuid: trioB, damageDealt: 50 },
		{ itemUuid: trioC, damageDealt: 50 },
	]);
	assertInvariant(
		trioTie12[0]?.xp === 93 + 93 && trioTie12[1]?.xp === 93 + 187 && trioTie12[2]?.xp === 187 + 93,
		"serviço desempata maior dano entre slots 1 e 2 dando 50% (187) ao slot 1",
	);
	validateXpHardening();
	print("XP_CURVE_AND_TEAM_DISTRIBUTION_PASSED");
}

/** Contador de chamadas a `addXp` para provar que inelegibilidade não distribuem XP. */
class SpyProgressionService extends ProgressionService {
	public addXpCalls = 0;

	public override addXp(player: Player, itemUuid: string, amount: number): FighterInventoryItem | undefined {
		this.addXpCalls += 1;
		return super.addXp(player, itemUuid, amount);
	}
}

/** Endurecimento do XP: UUIDs repetidos/inexistentes, entradas inválidas, teto até Lv30 e bloqueio fora de vitória PvE. */
function validateXpHardening(): void {
	const service = new SpyProgressionService();
	const player = { Name: "XpHardeningTestPlayer" } as unknown as Player;
	const skills: SkillSlots = [calcSkillSlotRoll(1, 0.25), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.75)];
	const create = (): string =>
		service.createInventoryFighter(player, {
			fighterId: "jotaro",
			rarity: "Comum",
			baseStats: { hp: 200, atk: 12, dodge: 5, crit: 6 },
			skills,
		}).itemUuid;
	const snapshot = (uuid: string): string => {
		const fighter = service.getFighter(player, uuid)!;
		return `${fighter.level}:${fighter.xp}`;
	};
	const allWin = (a: string, b: string, c: string) =>
		[
			{ itemUuid: a, damageDealt: 1 },
			{ itemUuid: b, damageDealt: 1 },
			{ itemUuid: c, damageDealt: 1 },
		] as const;

	// a. UUID repetido: só a 1ª ocorrência conta (1 válido = 100%: Nv.1 vs inimigo 20 = 375 * 1.35 = 506 => Lv3, 206), nunca 3x
	const dup = create();
	const dupAward = service.awardPostBattleTeamXp(player, 20, true, allWin(dup, dup, dup));
	assertInvariant(
		dupAward[0] !== undefined && dupAward[0].level === 3 && dupAward[0].xp === 206,
		"UUID repetido 3x recebe XP uma única vez, com 100% do pool (Lv3, 206 XP)",
	);
	assertInvariant(dupAward[1] === undefined && dupAward[2] === undefined, "slots duplicados são ignorados (undefined)");
	assertInvariant(snapshot(dup) === "3:206", "inventário do UUID repetido não acumulou XP extra");

	// a2. Repetido misturado: 2 válidos distintos dividem 50% / 50% e mantêm o multiplicador individual (Nv.1 => 253, Nv.20 => 187)
	const dupHigh = create();
	const dupLow = create();
	service.addXp(player, dupHigh, xpToReach(20));
	const mixedDup = service.awardPostBattleTeamXp(player, 20, true, allWin(dupLow, dupHigh, dupLow));
	assertInvariant(
		mixedDup[0] !== undefined &&
			mixedDup[0].level === 2 &&
			mixedDup[0].xp === 153 &&
			mixedDup[1] !== undefined &&
			mixedDup[1].level === 20 &&
			mixedDup[1].xp === 187 &&
			mixedDup[2] === undefined,
		"repetido misto: Nv.1 recebe 253 uma vez e Nv.20 recebe 187 (50% / 50%, multiplicador individual)",
	);

	// b. UUID inexistente é ignorado sem criar item nem afetar os demais
	const realA = create();
	const realB = create();
	const sizeBefore = service.getPlayerData(player)!.inventory.size();
	const missing = service.awardPostBattleTeamXp(player, 20, true, allWin(realA, "uuid-inexistente", realB));
	assertInvariant(
		missing[0] !== undefined && missing[0].xp === 153 && missing[1] === undefined && missing[2] !== undefined && missing[2].xp === 153,
		"UUID inexistente é ignorado e os 2 válidos dividem 50% / 50% (253 cada, Lv2 com 153)",
	);
	assertInvariant(service.getPlayerData(player)!.inventory.size() === sizeBefore, "UUID inexistente não cria item no inventário");
	const emptyUuid = service.awardPostBattleTeamXp(player, 20, true, allWin("", "", ""));
	assertInvariant(
		emptyUuid[0] === undefined && emptyUuid[1] === undefined && emptyUuid[2] === undefined,
		"UUIDs vazios não recebem XP",
	);
	assertInvariant(service.addXp(player, "uuid-inexistente", 10) === undefined, "addXp com UUID inexistente retorna undefined");
	assertInvariant(service.addXp(player, "", 10) === undefined, "addXp com UUID vazio retorna undefined");

	// c. Entradas inválidas em addXp: NaN, ±infinito, negativo e tipo errado não alteram nada
	const invalid = create();
	const invalidBefore = snapshot(invalid);
	const badAmounts: readonly unknown[] = [0 / 0, math.huge, -math.huge, -1, -0.5, "50", true, undefined];
	for (const bad of badAmounts) {
		assertInvariant(
			service.addXp(player, invalid, bad as number) === undefined,
			`addXp deve rejeitar entrada inválida (${tostring(bad)})`,
		);
	}
	assertInvariant(snapshot(invalid) === invalidBefore, "entradas inválidas não alteram nível nem XP");
	assertInvariant(service.addXp(player, invalid, 0) !== undefined && snapshot(invalid) === invalidBefore, "addXp(0) é válido e não altera nada");
	assertInvariant(
		calcBattleTotalXp(math.huge, true) === 0 && calcBattleTotalXp(-math.huge, true) === 0,
		"nível médio inimigo infinito gera 0 XP",
	);
	for (const enemyLevel of [1e300, 1e308, 0 / 0, -1, 0, 30.1, math.huge, -math.huge]) {
		assertInvariant(calcBattleTotalXp(enemyLevel, true) === 0, "nível inimigo inválido gera pool exatamente zero");
		const shares = calcPostBattleTeamXp(enemyLevel, true, [
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
		]);
		assertStoredEqual(shares, [0, 0, 0], "nível inimigo inválido gera exatamente zero XP por slot");
		const ids = [create(), create(), create()];
		service.awardPostBattleTeamXp(player, enemyLevel, true, allWin(ids[0], ids[1], ids[2]));
		for (const id of ids) assertInvariant(snapshot(id) === "1:0", "nível inimigo inválido preserva nível e XP no inventário");
	}
	for (const enemyLevel of [1, 30]) {
		assertInvariant(calcBattleTotalXp(enemyLevel, true) === (enemyLevel === 1 ? 90 : 525), "pool exato nos limites do nível inimigo");
		const shares = calcPostBattleTeamXp(enemyLevel, true, [
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
		]);
		assertStoredEqual(shares, enemyLevel === 1 ? [45, 22, 22] : [354, 177, 177], "divisão, multiplicador e arredondamento exatos nos limites");
		const ids = [create(), create(), create()];
		service.awardPostBattleTeamXp(player, enemyLevel, true, allWin(ids[0], ids[1], ids[2]));
		assertStoredEqual(ids.map(snapshot), enemyLevel === 1 ? ["1:45", "1:22", "1:22"] : ["3:54", "2:77", "2:77"], "estado final exato após recompensa nos limites");
	}

	// d. Teto derivado da curva (soma Lv1..Lv29 = 43.500) e múltiplos level-ups até Lv30
	assertInvariant(calcMaxUsefulXp() === 43500, "teto de XP útil = soma de calcXpForNextLevel(1..29)");
	const climber = create();
	const stepped = service.addXp(player, climber, calcXpForNextLevel(1) + calcXpForNextLevel(2) + calcXpForNextLevel(3) + 7);
	assertInvariant(stepped !== undefined && stepped.level === 4 && stepped.xp === 7, "3 level-ups em uma chamada (Lv4, 7 XP)");
	const exactMax = create();
	const atMax = service.addXp(player, exactMax, calcMaxUsefulXp());
	assertInvariant(atMax !== undefined && atMax.level === MAX_LEVEL && atMax.xp === 0, "XP total da curva leva exatamente ao Lv30 (xp 0)");
	const absurd = create();
	const absurdResult = service.addXp(player, absurd, 1e308);
	assertInvariant(
		absurdResult !== undefined && absurdResult.level === MAX_LEVEL && absurdResult.xp === 0,
		"valor finito absurdo é limitado ao teto e resulta em Lv30, xp 0",
	);
	assertInvariant(
		service.addXp(player, absurd, 1e308)?.level === MAX_LEVEL,
		"XP repetido absurdo no Lv30 permanece Lv30 sem overflow",
	);
	const resolvedHuge = resolveXpAndLevelUp(1, 0, math.huge, { hp: 0, atk: 0, dodge: 0, crit: 0 });
	assertInvariant(resolvedHuge.level === 1 && resolvedHuge.xp === 0, "resolveXpAndLevelUp ignora XP infinito/NaN");

	// e. Sem vitória PvE (derrota ou fuga) não há XP nem chamada a addXp; retorno preserva o estado atual
	const lossA = create();
	const lossB = create();
	const lossC = create();
	const lossBefore = `${snapshot(lossA)}|${snapshot(lossB)}|${snapshot(lossC)}`;
	const callsBefore = service.addXpCalls;
	const lossResult = service.awardPostBattleTeamXp(player, 20, false, allWin(lossA, lossB, lossC));
	const pvpResult = service.awardPostBattleTeamXp(player, 20, false, allWin(lossA, lossA, "uuid-inexistente"));
	assertInvariant(service.addXpCalls === callsBefore, "derrota/fuga não chamam addXp");
	assertInvariant(
		`${snapshot(lossA)}|${snapshot(lossB)}|${snapshot(lossC)}` === lossBefore,
		"derrota/fuga não alteram nível nem XP",
	);
	assertInvariant(
		lossResult[0]?.itemUuid === lossA && lossResult[1]?.itemUuid === lossB && lossResult[2]?.itemUuid === lossC,
		"sem vitória PvE o retorno preserva os lutadores atuais",
	);
	assertInvariant(pvpResult[2] === undefined, "sem vitória PvE UUID inexistente retorna undefined");
	assertInvariant(pvpResult[1] === undefined, "PvP tambem preserva undefined no slot duplicado");
	service.awardPostBattleTeamXp(player, 20, false, allWin(lossA, lossB, lossC)); // fuga
	assertInvariant(`${snapshot(lossA)}|${snapshot(lossB)}|${snapshot(lossC)}` === lossBefore, "fuga preserva estado final");

	// Cada posicao invalida preserva as recompensas individuais e a ordem.
	for (const badUuid of ["", "missing", 42 as unknown as string]) {
		for (const badIndex of $range(0, 2)) {
			const ids = [create(), create(), create()];
			service.addXp(player, ids[1], xpToReach(20));
			const team = [
				{ itemUuid: badIndex === 0 ? badUuid : ids[0], damageDealt: 1 },
				{ itemUuid: badIndex === 1 ? badUuid : ids[1], damageDealt: 1 },
				{ itemUuid: badIndex === 2 ? badUuid : ids[2], damageDealt: 0 },
			] as const;
			const before = ids.map(snapshot);
			const result = service.awardPostBattleTeamXp(player, 20, true, team);
			const expected = ["2:153", "20:187", "2:153"];
			for (const index of $range(0, 2)) {
				assertInvariant(snapshot(ids[index]) === (index === badIndex ? before[index] : expected[index]), "slot invalido nao altera XP dos validos");
				assertInvariant(index === badIndex ? result[index] === undefined : result[index]?.itemUuid === ids[index], "posicoes preservadas");
			}
		}
	}
	const first = create();
	const other = create();
	service.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: first, damageDealt: 0 },
		{ itemUuid: first, damageDealt: 1 },
		{ itemUuid: other, damageDealt: 1 },
	]);
	assertInvariant(snapshot(first) === "2:153" && snapshot(other) === "2:153", "primeira participacao prevalece: 2 validos dividem 50% / 50% sem duplicar XP");

	// Fronteira exata e excesso em todos os niveis, consultando o inventario final.
	for (const level of $range(1, MAX_LEVEL - 1)) {
		const uuid = create();
		service.addXp(player, uuid, xpToReach(level) + 7);
		const remaining = 43500 - xpToReach(level) - 7;
		service.addXp(player, uuid, remaining - 1);
		assertInvariant(snapshot(uuid) === "29:2899", "um XP antes do teto em qualquer nivel");
		service.addXp(player, uuid, 1);
		assertInvariant(snapshot(uuid) === "30:0", "teto exato zera residual");
		service.addXp(player, uuid, 1_000_000);
		assertInvariant(snapshot(uuid) === "30:0", "Lv30 nao acumula residual");
		const excess = create();
		service.addXp(player, excess, xpToReach(level) + 7);
		service.addXp(player, excess, 1_000_000);
		assertInvariant(snapshot(excess) === "30:0", "excesso em nivel intermediario limitado");
	}
	for (const bad of badAmounts) {
		const resolved = resolveXpAndLevelUp(10, 7, bad as number, { hp: 0, atk: 0, dodge: 0, crit: 0 });
		assertInvariant(resolved.level === 10 && resolved.xp === 7, "resolver ignora adicao invalida");
		const capped = resolveXpAndLevelUp(30, bad as number, 1_000_000, { hp: 0, atk: 0, dodge: 0, crit: 0 });
		assertInvariant(capped.level === 30 && capped.xp === 0, "resolver limpa residual invalido no Lv30");
	}
	const winCallsBefore = service.addXpCalls;
	service.awardPostBattleTeamXp(player, 20, true, allWin(lossA, lossB, lossC));
	assertInvariant(service.addXpCalls === winCallsBefore + 3, "vitória PvE ainda chama addXp uma vez por lutador único");
}

function xpToReach(level: number): number {
	let total = 0;
	for (const current of $range(MIN_LEVEL, level - 1)) total += calcXpForNextLevel(current);
	return total;
}

function validateProgressionAndInventory(): void {
	const remoteService = new RemoteService();
	const progressionService = new ProgressionService(remoteService);
	const fakePlayer = { Name: "ProgressionTestPlayer" } as unknown as Player;

	// 2. Schema versionado, itemUuid permanente gerado no server e imutabilidade de baseStats / rolls de skills
	const initialBaseStats: StatBlock = { hp: 200, atk: 12, dodge: 5, crit: 6 };
	const initialSkills: SkillSlots = [
		calcSkillSlotRoll(1, 0.25),
		calcSkillSlotRoll(2, 0.5),
		calcSkillSlotRoll(3, 0.75),
	];
	const fighterA = progressionService.createInventoryFighter(fakePlayer, {
		fighterId: "jotaro",
		rarity: "Lendária",
		baseStats: initialBaseStats,
		skills: initialSkills,
	});
	const fighterB = progressionService.createInventoryFighter(fakePlayer, {
		fighterId: "anubis",
		rarity: "Épica",
		baseStats: { hp: 175, atk: 11, dodge: 6, crit: 7 },
		skills: initialSkills,
	});
	const fighterC = progressionService.createInventoryFighter(fakePlayer, {
		fighterId: "jotaro",
		rarity: "Comum",
		baseStats: initialBaseStats,
		skills: initialSkills,
	});

	const playerData = progressionService.getPlayerData(fakePlayer);
	assertInvariant(
		playerData !== undefined &&
			playerData.version === PLAYER_DATA_SCHEMA_VERSION &&
			playerData.inventory.size() === 3,
		"estado em memória deve usar schema versionado com os 3 lutadores criados",
	);
	assertInvariant(
		fighterA.itemUuid.size() >= 32 &&
			fighterA.itemUuid !== fighterB.itemUuid &&
			fighterA.itemUuid !== fighterC.itemUuid,
		"itemUuid deve ser gerado no servidor via HttpService:GenerateGUID e único por instância",
	);
	assertInvariant(
		fighterA.level === 1 &&
			calcTotalPointsForLevel(1) === 0 &&
			progressionService.getAvailablePoints(fakePlayer, fighterA.itemUuid) === 0,
		"Lv1 deve começar sem pontos disponíveis (0)",
	);
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 1),
		"não deve permitir alocar pontos no Lv1 (0 pontos disponíveis)",
	);

	// Award XP pós-batalha para a equipe no ProgressionService (inimigo nível médio 20: pool 375, 50% / 25% / 25%, catch-up 1.35x)
	const awarded = progressionService.awardPostBattleTeamXp(fakePlayer, 20, true, [
		{ itemUuid: fighterA.itemUuid, damageDealt: 1 },
		{ itemUuid: fighterB.itemUuid, damageDealt: 1 },
		{ itemUuid: fighterC.itemUuid, damageDealt: 0 },
	]);
	assertInvariant(
		awarded[0] !== undefined &&
			awarded[0].level === 2 &&
			awarded[0].xp === 253 - calcXpForNextLevel(1) &&
			awarded[1] !== undefined &&
			awarded[1].level === 2 &&
			awarded[1].xp === 26 &&
			awarded[2] !== undefined &&
			awarded[2].level === 2 &&
			awarded[2].xp === 26,
		"awardPostBattleTeamXp deve aplicar divisão 50% / 25% / 25%, multiplicador por nível e subir de nível quando atingir a curva",
	);

	// 3. Cap por nível (cap por stat = nível atual) e trava de pares (|ATK - Dodge| <= 5 e |HP - Crit| <= 5)
	// Sobe fighterA até o Lv4 (total 6 pontos disponíveis)
	while ((progressionService.getFighter(fakePlayer, fighterA.itemUuid)?.level ?? 1) < 4) {
		const currentLvl = progressionService.getFighter(fakePlayer, fighterA.itemUuid)!.level;
		progressionService.addXp(fakePlayer, fighterA.itemUuid, calcXpForNextLevel(currentLvl));
	}
	assertInvariant(
		progressionService.getFighter(fakePlayer, fighterA.itemUuid)?.level === 4 &&
			progressionService.getAvailablePoints(fakePlayer, fighterA.itemUuid) === 6,
		"no Lv4 o lutador deve ter 6 pontos disponíveis ((4 - 1) * 2)",
	);
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 5),
		"deve rejeitar alocação que excede o cap por atributo igual ao nível atual (5 > Lv4)",
	);
	assertInvariant(
		progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 4),
		"deve permitir alocar 4 pontos em ATK no Lv4 (cap = 4, |4 - 0| <= 5)",
	);

	// Sobe fighterA até o Lv7 (total 12 pontos, 8 disponíveis, ATK já está em 4 e Dodge em 0)
	while ((progressionService.getFighter(fakePlayer, fighterA.itemUuid)?.level ?? 1) < 7) {
		const currentLvl = progressionService.getFighter(fakePlayer, fighterA.itemUuid)!.level;
		progressionService.addXp(fakePlayer, fighterA.itemUuid, calcXpForNextLevel(currentLvl));
	}
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 2),
		"deve rejeitar ATK=6 com Dodge=0 por violar a trava de par |ATK - Dodge| <= 5",
	);
	assertInvariant(
		progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "dodge", 2) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 2),
		"após subir Dodge para 2, deve permitir subir ATK para 6 (|6 - 2| = 4 <= 5 e 6 <= Lv7)",
	);
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 6),
		"deve rejeitar HP=6 com Crit=0 por violar a trava de par |HP - Crit| <= 5",
	);

	// 4. Lv30 máximo, 58 pontos totais no Lv30, ganhos por ponto e imutabilidade de itemUuid/baseStats/skills
	const lv30Fighter = progressionService.addXp(fakePlayer, fighterA.itemUuid, 1_000_000);
	assertInvariant(
		lv30Fighter !== undefined &&
			lv30Fighter.level === MAX_LEVEL &&
			lv30Fighter.xp === 0 &&
			calcTotalPointsForLevel(lv30Fighter.level) === TOTAL_STAT_POINTS &&
			TOTAL_STAT_POINTS === 58,
		"no Lv30 (nível máximo) o lutador deve ter exatamente 58 pontos totais e XP zerado",
	);

	// Já alocou 6 em ATK e 2 em Dodge (8 pontos). Aloca os 50 pontos restantes respeitando pares e cap <= 30:
	// Alvo final: ATK=15 (+9), Dodge=14 (+12), HP=15 (+15), Crit=14 (+14) -> soma = 58
	assertInvariant(
		progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "dodge", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "dodge", 7) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 4) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 4),
		"deve permitir distribuir todos os 58 pontos no Lv30 respeitando |ATK-Dodge|<=5 e |HP-Crit|<=5",
	);
	assertInvariant(
		progressionService.getAvailablePoints(fakePlayer, fighterA.itemUuid) === 0 &&
			!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 1),
		"após alocar os 58 pontos no Lv30, deve restar 0 disponíveis e rejeitar pontos extras",
	);

	const finalFighterA = progressionService.getFighter(fakePlayer, fighterA.itemUuid)!;
	const effectiveStats = progressionService.getEffectiveStats(fakePlayer, fighterA.itemUuid)!;
	assertInvariant(
		math.abs(effectiveStats.hp - (initialBaseStats.hp + 15 * HP_PER_POINT)) <= FLOAT_TOLERANCE &&
			effectiveStats.atk === initialBaseStats.atk + 15 * ATK_PER_POINT &&
			effectiveStats.dodge === initialBaseStats.dodge + 14 * DODGE_POINTS_PER_POINT &&
			effectiveStats.crit === initialBaseStats.crit + 14 * CRIT_POINTS_PER_POINT,
		"stats efetivos devem somar +12.5 HP/pt e +1 ATK, Dodge e Crit/pt sobre os baseStats",
	);
	assertInvariant(
		finalFighterA.itemUuid === fighterA.itemUuid &&
			finalFighterA.baseStats.hp === initialBaseStats.hp &&
			finalFighterA.baseStats.atk === initialBaseStats.atk &&
			finalFighterA.baseStats.dodge === initialBaseStats.dodge &&
			finalFighterA.baseStats.crit === initialBaseStats.crit &&
			finalFighterA.skills[0].t === initialSkills[0].t &&
			finalFighterA.skills[0].cost === initialSkills[0].cost &&
			finalFighterA.skills[0].mult === initialSkills[0].mult &&
			finalFighterA.skills[1].t === initialSkills[1].t &&
			finalFighterA.skills[2].t === initialSkills[2].t,
		"itemUuid, baseStats e rolls de custo/mult nunca podem ser rerrolados",
	);

	// 5. Rejeição de payloads inválidos no Remote RequestAllocate { itemUuid, stat, amount }
	progressionService.addXp(fakePlayer, fighterB.itemUuid, calcXpForNextLevel(1)); // fighterB já está no Lv2 (2 pts) após o XP pós-batalha
	assertInvariant(
		remoteService.readAllocatePayload(undefined) === undefined &&
			remoteService.readAllocatePayload("invalido") === undefined &&
			remoteService.readAllocatePayload({}) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: "", stat: "atk", amount: 1 }) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "velocidade", amount: 1 }) ===
				undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "atk", amount: 0 }) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "atk", amount: -1 }) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "atk", amount: 1.5 }) ===
				undefined &&
			remoteService.readAllocatePayload({
				itemUuid: fighterB.itemUuid,
				stat: "atk",
				amount: TOTAL_STAT_POINTS + 1,
			}) === undefined &&
			remoteService.readAllocatePayload({
				itemUuid: fighterB.itemUuid,
				stat: "atk",
				amount: 1,
				hack: true,
			}) === undefined,
		"RequestAllocate deve rejeitar qualquer payload malformado ou fora dos limites",
	);

	assertInvariant(
		remoteService.processAllocateEvent(fakePlayer, {
			itemUuid: fighterB.itemUuid,
			stat: "hp",
			amount: 1,
		}) && progressionService.getFighter(fakePlayer, fighterB.itemUuid)?.allocatedStats.hp === 1,
		"RequestAllocate válido dentro do rate limit deve alocar o ponto no ProgressionService",
	);

	// Rate limit (bucket próprio do RequestAllocate): após ALLOCATE_REQUEST_BUCKET_CAPACITY requisições seguidas, a próxima é barrada
	const rateLimitPlayer = { Name: "RateLimitAllocatePlayer" } as unknown as Player;
	const fighterRate = progressionService.createInventoryFighter(rateLimitPlayer, {
		fighterId: "jotaro",
		baseStats: initialBaseStats,
		skills: initialSkills,
	});
	progressionService.addXp(rateLimitPlayer, fighterRate.itemUuid, 1_000_000); // Lv30 (58 pontos)
	for (const reqIndex of $range(1, ALLOCATE_REQUEST_BUCKET_CAPACITY)) {
		assertInvariant(
			remoteService.processAllocateEvent(rateLimitPlayer, {
				itemUuid: fighterRate.itemUuid,
				stat: reqIndex % 2 === 1 ? "hp" : "crit",
				amount: 1,
			}),
			"requisições de RequestAllocate até a capacidade do bucket devem passar pelo rate limit",
		);
	}
	assertInvariant(
		!remoteService.processAllocateEvent(rateLimitPlayer, {
			itemUuid: fighterRate.itemUuid,
			stat: "hp",
			amount: 1,
		}),
		"requisição de RequestAllocate além da capacidade do bucket deve ser bloqueada pelo rate limit",
	);

	progressionService.forgetPlayer(rateLimitPlayer);
	remoteService.forgetPlayer(rateLimitPlayer);
	progressionService.forgetPlayer(fakePlayer);
	remoteService.forgetPlayer(fakePlayer);
}

function validatePlayerDataPersistence(): void {
	const sharedBackingStore = new InMemoryDataStore();
	let simulatedNow = 10_000;
	let backingUpdateCount = 0;
	const countingBackingStore: DataStoreLike = {
		UpdateAsync(key, transform) {
			backingUpdateCount += 1;
			return sharedBackingStore.UpdateAsync(key, transform);
		},
		SetAsync(key, value) {
			return sharedBackingStore.SetAsync(key, value);
		},
	};
	const recordedWaits: number[] = [];
	const kickedReasons = new Map<Player, string>();

	const progressionServerA = new ProgressionService();
	const dataServiceA = new PlayerDataService(progressionServerA, {
		dataStore: countingBackingStore,
		serverId: "Server_A",
		rng: createSeededRng(FIRST_SIMULATION_SEED + 501),
		now: () => simulatedNow,
		waitFn: (seconds) => recordedWaits.push(seconds),
		kickPlayer: (player, msg) => kickedReasons.set(player, msg),
		warnFn: () => {},
	});

	const fakePlayer = { Parent: Players, Name: "PersistTestPlayer", UserId: 777001 } as unknown as Player;

	// 1. Load inicial (primeira entrada: cria starter em apenas 1 UpdateAsync + schema versionado + tinyes iniciais + activeTeam)
	backingUpdateCount = 0;
	const initialLoad = dataServiceA.loadPlayer(fakePlayer);
	const rawAfterFirstLogin = sharedBackingStore.peekRaw(dataServiceA.getPlayerKey(777001)) as PlayerSaveData;
	assertInvariant(
		backingUpdateCount === 1 &&
			initialLoad.ok &&
			initialLoad.status === "LOADED" &&
			initialLoad.data !== undefined &&
			initialLoad.data.version === PLAYER_DATA_SCHEMA_VERSION &&
			initialLoad.data.tinyes === INITIAL_TINYES &&
			initialLoad.data.inventory.size() === 1 &&
			initialLoad.data.activeTeam.size() === 1 &&
			initialLoad.data.inventory[0].fighterId === DEFAULT_STARTER_FIGHTER_ID &&
			initialLoad.data.activeTeam[0] === initialLoad.data.inventory[0].itemUuid &&
			rawAfterFirstLogin !== undefined &&
			rawAfterFirstLogin.inventory.size() === 1 &&
			rawAfterFirstLogin.activeTeam[0] === initialLoad.data.inventory[0].itemUuid,
		"primeiro login deve criar e persistir o starter em apenas 1 UpdateAsync",
	);

	// Conta existente com inventário vazio não deve receber starter novamente
	const emptyExistingPlayer = { Parent: Players, Name: "EmptyExistingPlayer", UserId: 777010 } as unknown as Player;
	sharedBackingStore.setRawForTest(dataServiceA.getPlayerKey(777010), {
		version: PLAYER_DATA_SCHEMA_VERSION,
		pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
		tinyes: 250,
		inventory: [],
		activeTeam: [],
	});
	const emptyExistingLoad = dataServiceA.loadPlayer(emptyExistingPlayer);
	assertInvariant(
		emptyExistingLoad.ok &&
			emptyExistingLoad.data !== undefined &&
			emptyExistingLoad.data.inventory.size() === 0 &&
			emptyExistingLoad.data.activeTeam.size() === 0,
		"conta existente com inventário vazio não deve receber starter por cima",
	);
	dataServiceA.handlePlayerRemoving(emptyExistingPlayer);

	const starter = initialLoad.data!.inventory[0];
	const secondFighter = progressionServerA.createInventoryFighter(fakePlayer, {
		fighterId: "anubis",
		rarity: "Épica",
		baseStats: { hp: 15, atk: 12, dodge: 6, crit: 9 },
		skills: [calcSkillSlotRoll(1, 0.15), calcSkillSlotRoll(2, 0.65), calcSkillSlotRoll(3, 0.85)],
	});
	// Sobe o starter para o Lv3 (4 pontos) e aloca 2 em ATK e 2 em HP
	progressionServerA.addXp(fakePlayer, starter.itemUuid, calcXpForNextLevel(1) + calcXpForNextLevel(2) + 35);
	assertInvariant(
		progressionServerA.allocatePoints(fakePlayer, starter.itemUuid, "atk", 2) &&
			progressionServerA.allocatePoints(fakePlayer, starter.itemUuid, "hp", 2),
		"deve alocar pontos no starter carregado no ProgressionService",
	);
	assertInvariant(dataServiceA.addTinyes(fakePlayer, 450), "deve adicionar Tinyes na sessão do jogador");
	assertInvariant(
		dataServiceA.setActiveTeam(fakePlayer, [starter.itemUuid, secondFighter.itemUuid]),
		"deve atualizar activeTeam com os 2 itemUuids válidos",
	);

	// 2. Rejeição de session lock ativo em outro servidor (Server_B tenta carregar enquanto Server_A mantém lock)
	const progressionServerB = new ProgressionService();
	const dataServiceB = new PlayerDataService(progressionServerB, {
		dataStore: sharedBackingStore,
		serverId: "Server_B",
		rng: () => 0.99, // RNG diferente para provar que nada é rerrolado ao recarregar
		now: () => simulatedNow,
		waitFn: (seconds) => recordedWaits.push(seconds),
		kickPlayer: (player, msg) => kickedReasons.set(player, msg),
		warnFn: () => {},
	});

	recordedWaits.clear();
	const lockedLoadOnB = dataServiceB.loadPlayer(fakePlayer);
	assertInvariant(
		!lockedLoadOnB.ok &&
			lockedLoadOnB.status === "LOCKED" &&
			kickedReasons.get(fakePlayer) === SESSION_LOCK_KICK_MESSAGE &&
			recordedWaits.size() === SESSION_LOCK_WAIT_ATTEMPTS,
		"Server_B deve aguardar e recusar a entrada com mensagem se o session lock de Server_A estiver ativo",
	);

	// 3. Save ao sair no Server_A (libera session lock) e reload idêntico no Server_B sem rerrolar nada
	const starterBeforeSave = progressionServerA.getFighter(fakePlayer, starter.itemUuid)!;
	const saveOnLeaveA = dataServiceA.handlePlayerRemoving(fakePlayer);
	assertInvariant(saveOnLeaveA.ok && saveOnLeaveA.status === "SAVED", "Server_A deve salvar e liberar lock ao sair");

	const reloadOnB = dataServiceB.loadPlayer(fakePlayer);
	assertInvariant(
		reloadOnB.ok && reloadOnB.status === "LOADED" && reloadOnB.data !== undefined,
		"após Server_A liberar o session lock, Server_B deve carregar os dados normalmente",
	);
	const reloadedStarter = progressionServerB.getFighter(fakePlayer, starter.itemUuid)!;
	const reloadedSecond = progressionServerB.getFighter(fakePlayer, secondFighter.itemUuid)!;
	assertInvariant(
		reloadedStarter !== undefined &&
			reloadedSecond !== undefined &&
			reloadOnB.data!.tinyes === INITIAL_TINYES + 450 &&
			reloadOnB.data!.activeTeam.size() === 2 &&
			reloadOnB.data!.activeTeam[0] === starter.itemUuid &&
			reloadOnB.data!.activeTeam[1] === secondFighter.itemUuid &&
			reloadedStarter.itemUuid === starterBeforeSave.itemUuid &&
			reloadedStarter.level === 3 &&
			math.abs(reloadedStarter.xp - 35) <= FLOAT_TOLERANCE &&
			reloadedStarter.baseStats.hp === starterBeforeSave.baseStats.hp &&
			reloadedStarter.baseStats.atk === starterBeforeSave.baseStats.atk &&
			reloadedStarter.baseStats.dodge === starterBeforeSave.baseStats.dodge &&
			reloadedStarter.baseStats.crit === starterBeforeSave.baseStats.crit &&
			reloadedStarter.allocatedStats.atk === 2 &&
			reloadedStarter.allocatedStats.hp === 2 &&
			reloadedStarter.skills[0].t === starterBeforeSave.skills[0].t &&
			reloadedStarter.skills[0].cost === starterBeforeSave.skills[0].cost &&
			reloadedStarter.skills[0].mult === starterBeforeSave.skills[0].mult &&
			reloadedStarter.skills[1].t === starterBeforeSave.skills[1].t &&
			reloadedStarter.skills[1].cost === starterBeforeSave.skills[1].cost &&
			reloadedStarter.skills[1].mult === starterBeforeSave.skills[1].mult &&
			reloadedStarter.skills[2].t === starterBeforeSave.skills[2].t &&
			reloadedStarter.skills[2].cost === starterBeforeSave.skills[2].cost &&
			reloadedStarter.skills[2].mult === starterBeforeSave.skills[2].mult &&
			reloadedSecond.baseStats.hp === 15 &&
			reloadedSecond.skills[0].t === secondFighter.skills[0].t &&
			reloadedSecond.skills[1].t === secondFighter.skills[1].t &&
			reloadedSecond.skills[2].t === secondFighter.skills[2].t,
		"save/load deve preservar EXATAMENTE itemUuid, baseStats, rolls (t, cost, mult) de S1/S2/S3, level, xp, allocatedStats, tinyes e activeTeam",
	);

	// 4. SESSION_LOCK_EXPIRATION_SECONDS = 120 (Config) e autosave continua renovando o lock
	assertInvariant(
		SESSION_LOCK_EXPIRATION_SECONDS === 120,
		"SESSION_LOCK_EXPIRATION_SECONDS deve ser 120 em Config.ts",
	);
	simulatedNow += 60;
	dataServiceB.autosaveAllPlayers();
	const rawAfterLockRenewal = sharedBackingStore.peekRaw(dataServiceB.getPlayerKey(777001)) as PlayerSaveData;
	assertInvariant(
		rawAfterLockRenewal !== undefined &&
			rawAfterLockRenewal.sessionLock?.serverId === "Server_B" &&
			rawAfterLockRenewal.sessionLock?.timestamp === simulatedNow,
		"autosave deve continuar renovando o timestamp do sessionLock",
	);
	// Mais 70s depois (130s desde o load original, mas apenas 70s desde o último autosave < 120s): lock de Server_B ainda está ativo!
	simulatedNow += 70;
	const stillLockedOnA = dataServiceA.loadPlayer(fakePlayer);
	assertInvariant(
		!stillLockedOnA.ok && stillLockedOnA.status === "LOCKED",
		"lock renovado pelo autosave não deve expirar antes de 120s desde o último autosave",
	);

	// Expiração de session lock travado: avança relógio além de SESSION_LOCK_EXPIRATION_SECONDS sem Server_B renovar/liberar
	simulatedNow += SESSION_LOCK_EXPIRATION_SECONDS + 5;
	const expiredLockLoadOnA = dataServiceA.loadPlayer(fakePlayer);
	assertInvariant(
		expiredLockLoadOnA.ok && expiredLockLoadOnA.status === "LOADED",
		"session lock expirado de servidor travado deve ser assumido pelo novo servidor",
	);

	// 3.1. Posse explícita do sessionLock em savePlayer: aborta, descarta sessão local e expulsa jogador se o lock mudou ou foi limpo no DataStore
	const lockCheckPlayer = { Parent: Players, Name: "LockLostPlayer", UserId: 777011 } as unknown as Player;
	assertInvariant(dataServiceA.loadPlayer(lockCheckPlayer).ok, "deve carregar sessão para teste de perda de lock");
	dataServiceA.addTinyes(lockCheckPlayer, 999);
	kickedReasons.delete(lockCheckPlayer);
	const rawBeforeStolenSave = sharedBackingStore.peekRaw(dataServiceA.getPlayerKey(777011)) as PlayerSaveData;
	sharedBackingStore.setRawForTest(dataServiceA.getPlayerKey(777011), {
		...rawBeforeStolenSave,
		tinyes: 111,
		sessionLock: { serverId: "Server_Other", timestamp: simulatedNow },
	});
	const saveWhenLockChanged = dataServiceA.savePlayer(lockCheckPlayer, false);
	const rawAfterStolenSave = sharedBackingStore.peekRaw(dataServiceA.getPlayerKey(777011)) as PlayerSaveData;
	assertInvariant(
		!saveWhenLockChanged.ok &&
			saveWhenLockChanged.status === "LOCKED_BY_OTHER" &&
			!dataServiceA.isSessionLoaded(lockCheckPlayer) &&
			progressionServerA.getPlayerData(lockCheckPlayer) === undefined &&
			kickedReasons.get(lockCheckPlayer) === SESSION_LOCK_LOST_KICK_MESSAGE &&
			rawAfterStolenSave.tinyes === 111 &&
			rawAfterStolenSave.sessionLock?.serverId === "Server_Other",
		"savePlayer deve abortar, descartar a sessão local e expulsar o jogador com mensagem clara se o sessionLock mudou para outro servidor",
	);

	// Limpa o sessionLock no DataStore (sessionLock = undefined) e recarrega para testar perda por lock limpo
	sharedBackingStore.setRawForTest(dataServiceA.getPlayerKey(777011), {
		...rawBeforeStolenSave,
		tinyes: 222,
		sessionLock: undefined,
	});
	assertInvariant(dataServiceA.loadPlayer(lockCheckPlayer).ok, "deve recarregar após lock limpo");
	dataServiceA.addTinyes(lockCheckPlayer, 888);
	kickedReasons.delete(lockCheckPlayer);
	sharedBackingStore.setRawForTest(dataServiceA.getPlayerKey(777011), {
		...rawBeforeStolenSave,
		tinyes: 222,
		sessionLock: undefined,
	});
	const saveWhenLockCleared = dataServiceA.savePlayer(lockCheckPlayer, false);
	const rawAfterClearedSave = sharedBackingStore.peekRaw(dataServiceA.getPlayerKey(777011)) as PlayerSaveData;
	assertInvariant(
		!saveWhenLockCleared.ok &&
			saveWhenLockCleared.status === "LOCKED_BY_OTHER" &&
			!dataServiceA.isSessionLoaded(lockCheckPlayer) &&
			progressionServerA.getPlayerData(lockCheckPlayer) === undefined &&
			kickedReasons.get(lockCheckPlayer) === SESSION_LOCK_LOST_KICK_MESSAGE &&
			rawAfterClearedSave.tinyes === 222 &&
			rawAfterClearedSave.sessionLock === undefined,
		"savePlayer deve abortar, descartar a sessão local e expulsar o jogador com mensagem clara se o sessionLock foi limpo no DataStore",
	);

	dataServiceA.handlePlayerRemoving(fakePlayer);
	progressionServerB.forgetPlayer(fakePlayer);

	// 4. Falha de rede com retry + backoff exponencial; falha de rede no loadPlayer não registra sessão nem sobrescreve chave
	let failuresRemaining = 0;
	let setFailuresRemaining = 0;
	let insideUpdateAsyncCallback = false;
	let setAsyncCalledInsideCallback = false;
	let setAsyncCallCount = 0;
	const flakyStore: DataStoreLike = {
		UpdateAsync(key, transform) {
			if (failuresRemaining > 0) {
				failuresRemaining -= 1;
				error("Simulated503: DataStore service unavailable");
			}
			insideUpdateAsyncCallback = true;
			const [ok, res] = pcall(() => sharedBackingStore.UpdateAsync(key, transform));
			insideUpdateAsyncCallback = false;
			if (!ok) {
				error(res);
			}
			return res;
		},
		SetAsync(key, value) {
			setAsyncCallCount += 1;
			if (insideUpdateAsyncCallback) {
				setAsyncCalledInsideCallback = true;
			}
			if (setFailuresRemaining > 0) {
				setFailuresRemaining -= 1;
				error("Simulated503: SetAsync backup write failure");
			}
			return sharedBackingStore.SetAsync(key, value);
		},
	};
	const retryWaits: number[] = [];
	let onWaitHook: (() => void) | undefined;
	const progressionFlaky = new ProgressionService();
	const flakyService = new PlayerDataService(progressionFlaky, {
		dataStore: flakyStore,
		serverId: "Server_Flaky",
		now: () => simulatedNow,
		waitFn: (seconds) => {
			retryWaits.push(seconds);
			if (onWaitHook !== undefined) {
				onWaitHook();
			}
		},
		kickPlayer: (player, msg) => kickedReasons.set(player, msg),
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});

	// 4.1. Falha total de rede no loadPlayer: expulsa o jogador, não registra sessão e não sobrescreve a chave
	kickedReasons.delete(fakePlayer);
	failuresRemaining = DATASTORE_MAX_RETRIES + 5;
	const failedNetworkLoad = flakyService.loadPlayer(fakePlayer);
	failuresRemaining = 0;
	flakyService.autosaveAllPlayers();
	const saveAfterFailedLoad = flakyService.savePlayer(fakePlayer, false);
	const rawAfterFailedNetworkLoad = sharedBackingStore.peekRaw(flakyService.getPlayerKey(777001)) as PlayerSaveData;
	assertInvariant(
		!failedNetworkLoad.ok &&
			failedNetworkLoad.status === "NETWORK_ERROR" &&
			failedNetworkLoad.data === undefined &&
			failedNetworkLoad.errorMessage !== undefined &&
			kickedReasons.has(fakePlayer) &&
			!flakyService.isSessionLoaded(fakePlayer) &&
			progressionFlaky.getPlayerData(fakePlayer) === undefined &&
			!saveAfterFailedLoad.ok &&
			saveAfterFailedLoad.status === "NO_SESSION" &&
			rawAfterFailedNetworkLoad !== undefined &&
			rawAfterFailedNetworkLoad.tinyes === INITIAL_TINYES + 450 &&
			rawAfterFailedNetworkLoad.inventory.size() === 2,
		"falha de rede no loadPlayer deve expulsar o jogador, não registrar sessão salvável e nunca sobrescrever a chave",
	);

	// 4.2. Falha transitória (2 falhas) com backoff exponencial no loadPlayer
	retryWaits.clear();
	failuresRemaining = 2;
	assertInvariant(flakyService.loadPlayer(fakePlayer).ok, "load deve ter sucesso após 2 falhas transitórias");
	assertInvariant(
		retryWaits.size() === 2 &&
			math.abs(retryWaits[0] - DATASTORE_RETRY_BASE_DELAY_SECONDS) <= FLOAT_TOLERANCE &&
			math.abs(retryWaits[1] - DATASTORE_RETRY_BASE_DELAY_SECONDS * DATASTORE_RETRY_BACKOFF_FACTOR) <=
				FLOAT_TOLERANCE,
		"retry de DataStore deve aplicar backoff exponencial configurado em Config.ts",
	);

	// Falha final em todas as tentativas no savePlayer: não zera os dados em memória nem no DataStore; tenta de novo no autosave
	flakyService.addTinyes(fakePlayer, 300); // Total em memória = 750
	failuresRemaining = DATASTORE_MAX_RETRIES + 5;
	const failedSave = flakyService.savePlayer(fakePlayer, false);
	const rawInStoreAfterFail = sharedBackingStore.peekRaw(flakyService.getPlayerKey(777001)) as PlayerSaveData;
	assertInvariant(
		!failedSave.ok &&
			failedSave.status === "RETRY_SCHEDULED" &&
			failedSave.attempts === DATASTORE_MAX_RETRIES + 1 &&
			flakyService.getTinyes(fakePlayer) === INITIAL_TINYES + 750 &&
			progressionFlaky.getFighter(fakePlayer, starter.itemUuid)?.level === 3 &&
			rawInStoreAfterFail !== undefined &&
			rawInStoreAfterFail.tinyes === INITIAL_TINYES + 450 &&
			rawInStoreAfterFail.inventory.size() === 2,
		"falha final de rede nunca deve zerar os dados em memória nem no DataStore",
	);

	// Rede volta a funcionar -> autosave periódico persiste os dados pendentes
	failuresRemaining = 0;
	flakyService.autosaveAllPlayers();
	const rawInStoreAfterAutosave = sharedBackingStore.peekRaw(flakyService.getPlayerKey(777001)) as PlayerSaveData;
	assertInvariant(
		rawInStoreAfterAutosave !== undefined && rawInStoreAfterAutosave.tinyes === INITIAL_TINYES + 750,
		"autosave deve reprocessar e salvar os dados após recuperação de falha de rede",
	);

	// 4.3. Save de saída com falha prolongada (mais ciclos consecutivos do que o antigo maxRetryCycles = 4) seguida de recuperação:
	// - na falha inicial e ao longo de todos os ciclos falhos, mantém a sessão marcada como closing=true (autosave periódico ignora) e mantém o lock;
	// - enqueueBackgroundRetrySave não abandona a sessão após 4 ciclos, aplica backoff progressivo (dobrando de DATASTORE_RETRY_BASE_DELAY_SECONDS até LOGOUT_RETRY_MAX_BACKOFF_SECONDS)
	//   e, quando o DataStore recupera, conclui o save com releaseLock=true, limpando o sessionLock no DataStore e removendo a sessão da memória.
	assertInvariant(
		LOGOUT_RETRY_MAX_BACKOFF_SECONDS === 30,
		"LOGOUT_RETRY_MAX_BACKOFF_SECONDS deve ser 30 em Config.ts",
	);
	flakyService.addTinyes(fakePlayer, 200); // Total em memória = 950
	let inspectedPendingLogoutState = false;
	const attemptsPerSaveCycle = DATASTORE_MAX_RETRIES + 1; // 4 tentativas por savePlayer
	const failedBackgroundCycles = 6; // > 4 (antigo maxRetryCycles = 1 + DATASTORE_MAX_RETRIES)
	retryWaits.clear();
	failuresRemaining = (1 + failedBackgroundCycles) * attemptsPerSaveCycle; // 1 ciclo inicial + 6 ciclos completos em background falham; 7º ciclo em background sucede
	onWaitHook = () => {
		if (failuresRemaining === 0 && !inspectedPendingLogoutState) {
			inspectedPendingLogoutState = true;
			const rawWhilePendingRetry = sharedBackingStore.peekRaw(
				flakyService.getPlayerKey(777001),
			) as PlayerSaveData;
			assertInvariant(
				flakyService.isSessionLoaded(fakePlayer) &&
					flakyService.hasPendingRetrySave(fakePlayer) &&
					progressionFlaky.getPlayerData(fakePlayer) !== undefined &&
					flakyService.getTinyes(fakePlayer) === INITIAL_TINYES + 950 &&
					rawWhilePendingRetry !== undefined &&
					rawWhilePendingRetry.tinyes === INITIAL_TINYES + 750 &&
					rawWhilePendingRetry.sessionLock?.serverId === "Server_Flaky",
				"save de saída com falha prolongada (> antigo maxRetryCycles) não deve abandonar a sessão nem liberar o lock antes de concluir",
			);
			// Enquanto closing=true, o autosave periódico deve ignorar a sessão (não salvar com releaseLock=false)
			simulatedNow += 10;
			flakyService.autosaveAllPlayers();
			const rawAfterIgnoredAutosave = sharedBackingStore.peekRaw(
				flakyService.getPlayerKey(777001),
			) as PlayerSaveData;
			assertInvariant(
				rawAfterIgnoredAutosave !== undefined &&
					rawAfterIgnoredAutosave.tinyes === INITIAL_TINYES + 750 &&
					rawAfterIgnoredAutosave.sessionLock?.timestamp !== simulatedNow,
				"autosave periódico deve ignorar sessão marcada como saída pendente (closing=true)",
			);
		}
	};
	const failedExitSave = flakyService.handlePlayerRemoving(fakePlayer);
	onWaitHook = undefined;
	// Extrai os 7 delays de backoff entre os ciclos de enqueueBackgroundRetrySave (a cada 3 waits internos de executeUpdateWithRetry, o 4º é o wait do loop de background):
	// Índices em retryWaits (base 0): 3, 7, 11, 15, 19, 23, 27 -> [0.5, 1, 2, 4, 8, 16, 30]
	const backgroundCycleDelays: number[] = [];
	for (const cycleIdx of $range(0, failedBackgroundCycles)) {
		const waitIdx = cycleIdx * (DATASTORE_MAX_RETRIES + 1) + DATASTORE_MAX_RETRIES;
		backgroundCycleDelays.push(retryWaits[waitIdx]);
	}
	const expectedBackgroundDelays = [0.5, 1, 2, 4, 8, 16, LOGOUT_RETRY_MAX_BACKOFF_SECONDS];
	let backgroundBackoffMatches = backgroundCycleDelays.size() === expectedBackgroundDelays.size();
	for (const i of $range(0, expectedBackgroundDelays.size() - 1)) {
		if (math.abs((backgroundCycleDelays[i] ?? -1) - expectedBackgroundDelays[i]) > FLOAT_TOLERANCE) {
			backgroundBackoffMatches = false;
		}
	}
	const rawAfterExitRetry = sharedBackingStore.peekRaw(flakyService.getPlayerKey(777001)) as PlayerSaveData;
	assertInvariant(
		!failedExitSave.ok &&
			failedExitSave.status === "RETRY_SCHEDULED" &&
			inspectedPendingLogoutState &&
			backgroundBackoffMatches &&
			!flakyService.isSessionLoaded(fakePlayer) &&
			!flakyService.hasPendingRetrySave(fakePlayer) &&
			progressionFlaky.getPlayerData(fakePlayer) === undefined &&
			rawAfterExitRetry !== undefined &&
			rawAfterExitRetry.tinyes === INITIAL_TINYES + 950 &&
			rawAfterExitRetry.sessionLock === undefined,
		"enqueueBackgroundRetrySave deve manter o loop ativo além do antigo maxRetryCycles, aplicar backoff progressivo até LOGOUT_RETRY_MAX_BACKOFF_SECONDS e concluir o save com releaseLock=true limpando a sessão",
	);

	// Como a sessão foi removida após o retry de logout, autosaveAllPlayers não renova mais o lock
	simulatedNow += 15;
	flakyService.autosaveAllPlayers();
	const rawAfterPostLogoutAutosave = sharedBackingStore.peekRaw(flakyService.getPlayerKey(777001)) as PlayerSaveData;
	assertInvariant(
		rawAfterPostLogoutAutosave !== undefined &&
			rawAfterPostLogoutAutosave.tinyes === INITIAL_TINYES + 950 &&
			rawAfterPostLogoutAutosave.sessionLock === undefined,
		"após o retry de logout remover a sessão da memória, o autosave não deve renovar o sessionLock",
	);

	// 4.4. Confiabilidade de enqueueBackgroundRetrySave contra exceções inesperadas em savePlayer, concorrência, LOCKED_BY_OTHER/NO_SESSION e transição para BindToClose
	{
		let throwInSavePlayerCount = 0;
		let throwInWaitFnOnce = false;
		const exceptionWarnings: string[] = [];
		const bgExceptionWaits: number[] = [];
		let onBgWaitHook: ((delay: number, waitCallIndex: number) => void) | undefined;
		const bgProgression = new ProgressionService();
		const bgService = new PlayerDataService(bgProgression, {
			dataStore: flakyStore,
			serverId: "Server_BgReliability",
			now: () => {
				if (throwInSavePlayerCount > 0) {
					throwInSavePlayerCount -= 1;
					error("SimulatedSavePlayerInternalException: unexpected runtime failure inside performSavePlayer");
				}
				return simulatedNow;
			},
			waitFn: (seconds) => {
				bgExceptionWaits.push(seconds);
				const callIdx = bgExceptionWaits.size();
				if (onBgWaitHook !== undefined) {
					onBgWaitHook(seconds, callIdx);
				}
				if (throwInWaitFnOnce) {
					throwInWaitFnOnce = false;
					error("SimulatedWaitFnFailure: unexpected coroutine error in background retry worker");
				}
			},
			kickPlayer: (player, msg) => kickedReasons.set(player, msg),
			warnFn: (msg) => exceptionWarnings.push(msg),
			disableStudioAutoFallbackOnInjectedStore: true,
		});

		// (Teste 1 + Teste 5) Exceção no 1º salvamento em background e sucesso na tentativa seguinte (limpa fila e sessão)
		const bgPlayer1 = { Parent: Players, Name: "BgExceptionRecoveryPlayer", UserId: 777020 } as unknown as Player;
		failuresRemaining = 0;
		assertInvariant(bgService.loadPlayer(bgPlayer1).ok, "deve carregar bgPlayer1");
		bgService.addTinyes(bgPlayer1, 400);
		bgExceptionWaits.clear();
		exceptionWarnings.clear();
		failuresRemaining = DATASTORE_MAX_RETRIES + 1; // Falha o save inicial de handlePlayerRemoving (4 tentativas)
		onBgWaitHook = (_delay, callIdx) => {
			// callIdx 1..3 são os 3 backoffs internos do save inicial; callIdx 4 é o 1º wait (0.5s) do enqueueBackgroundRetrySave
			if (callIdx === DATASTORE_MAX_RETRIES + 1) {
				throwInSavePlayerCount = 1; // Faz o 1º savePlayer() dentro do worker lançar exceção!
			}
		};
		const bgRes1 = bgService.handlePlayerRemoving(bgPlayer1);
		onBgWaitHook = undefined;
		const rawBg1 = sharedBackingStore.peekRaw(bgService.getPlayerKey(777020)) as PlayerSaveData;
		assertInvariant(
			!bgRes1.ok &&
				bgRes1.status === "RETRY_SCHEDULED" &&
				throwInSavePlayerCount === 0 &&
				exceptionWarnings.some((w) => w.find("Exceção inesperada")[0] !== undefined) &&
				!bgService.isSessionLoaded(bgPlayer1) &&
				!bgService.hasPendingRetrySave(bgPlayer1) &&
				bgProgression.getPlayerData(bgPlayer1) === undefined &&
				rawBg1 !== undefined &&
				rawBg1.tinyes === INITIAL_TINYES + 400 &&
				rawBg1.sessionLock === undefined,
			"Teste 1/5: exceção no 1º retry em background deve ser capturada com aviso, manter na fila e concluir com sucesso na tentativa seguinte limpando fila e sessão",
		);

		// (Teste 2 + Teste 4) Exceções consecutivas em savePlayer mantendo backoff progressivo + bloqueio de tasks concorrentes para a mesma sessão
		const bgPlayer2 = { Parent: Players, Name: "BgConsecutiveExceptionsPlayer", UserId: 777021 } as unknown as Player;
		assertInvariant(bgService.loadPlayer(bgPlayer2).ok, "deve carregar bgPlayer2");
		bgService.addTinyes(bgPlayer2, 600);
		bgExceptionWaits.clear();
		exceptionWarnings.clear();
		let nestedDuplicateTriggerDone = false;
		failuresRemaining = DATASTORE_MAX_RETRIES + 1; // Falha o save inicial
		onBgWaitHook = (_delay, callIdx) => {
			if (callIdx === DATASTORE_MAX_RETRIES + 1) {
				// 3 exceções consecutivas em savePlayer nos 3 primeiros ciclos de background; 4º ciclo sucede
				throwInSavePlayerCount = 3;
			}
			if (callIdx === DATASTORE_MAX_RETRIES + 2 && !nestedDuplicateTriggerDone) {
				nestedDuplicateTriggerDone = true;
				// Enquanto o worker 1 já está ativo (retryTaskActive = true), uma chamada repetida a handlePlayerRemoving
				// (que falha por exceção e chama enqueueBackgroundRetrySave) NÃO deve criar um 2º worker concorrente
				throwInSavePlayerCount += 1;
				const [dupOk] = pcall(() => bgService.handlePlayerRemoving(bgPlayer2));
				assertInvariant(!dupOk, "chamada aninhada com exceção deve propagar erro no chamador direto");
			}
		};
		bgService.handlePlayerRemoving(bgPlayer2);
		onBgWaitHook = undefined;
		// Waits esperados: 3 internos do save inicial ([0.5, 1, 2]) + 4 waits do único worker de background ([0.5, 1, 2, 4])
		const workerWaitsAfterInitial = [
			bgExceptionWaits[3],
			bgExceptionWaits[4],
			bgExceptionWaits[5],
			bgExceptionWaits[6],
		];
		const rawBg2 = sharedBackingStore.peekRaw(bgService.getPlayerKey(777021)) as PlayerSaveData;
		assertInvariant(
			bgExceptionWaits.size() === 7 &&
				math.abs((workerWaitsAfterInitial[0] ?? -1) - 0.5) <= FLOAT_TOLERANCE &&
				math.abs((workerWaitsAfterInitial[1] ?? -1) - 1.0) <= FLOAT_TOLERANCE &&
				math.abs((workerWaitsAfterInitial[2] ?? -1) - 2.0) <= FLOAT_TOLERANCE &&
				math.abs((workerWaitsAfterInitial[3] ?? -1) - 4.0) <= FLOAT_TOLERANCE &&
				!bgService.isSessionLoaded(bgPlayer2) &&
				!bgService.hasPendingRetrySave(bgPlayer2) &&
				rawBg2 !== undefined &&
				rawBg2.tinyes === INITIAL_TINYES + 600 &&
				rawBg2.sessionLock === undefined,
			"Teste 2/4: exceções consecutivas devem respeitar o backoff progressivo [0.5, 1, 2, 4] e chamadas repetidas não devem criar múltiplas tasks concorrentes",
		);

		// (Teste 3) retryTaskActive nunca fica permanentemente preso em true mesmo se a task inteira abortar por erro inesperado
		const bgPlayer3 = { Parent: Players, Name: "BgUnstuckFlagPlayer", UserId: 777022 } as unknown as Player;
		assertInvariant(bgService.loadPlayer(bgPlayer3).ok, "deve carregar bgPlayer3");
		bgService.addTinyes(bgPlayer3, 250);
		failuresRemaining = DATASTORE_MAX_RETRIES + 1;
		onBgWaitHook = (_delay, callIdx) => {
			if (callIdx === DATASTORE_MAX_RETRIES + 1) {
				// Força erro fatal na própria waitFn dentro da task de background
				throwInWaitFnOnce = true;
			}
		};
		bgExceptionWaits.clear();
		bgService.handlePlayerRemoving(bgPlayer3);
		onBgWaitHook = undefined;
		assertInvariant(
			bgService.isSessionLoaded(bgPlayer3) && bgService.hasPendingRetrySave(bgPlayer3),
			"após falha forçada na waitFn, a sessão ainda deve estar pendente antes da nova tentativa",
		);
		// Como retryTaskActive foi limpo para false no bloco de finalização, uma nova chamada que reenfileire o background retry deve iniciar uma nova task e concluir o save!
		failuresRemaining = DATASTORE_MAX_RETRIES + 1; // Falha o save síncrono e depende exclusivamente da nova task de background
		bgService.handlePlayerRemoving(bgPlayer3);
		const rawBg3 = sharedBackingStore.peekRaw(bgService.getPlayerKey(777022)) as PlayerSaveData;
		assertInvariant(
			!bgService.isSessionLoaded(bgPlayer3) &&
				!bgService.hasPendingRetrySave(bgPlayer3) &&
				rawBg3 !== undefined &&
				rawBg3.tinyes === INITIAL_TINYES + 250 &&
				rawBg3.sessionLock === undefined,
			"Teste 3: retryTaskActive deve ser sempre redefinido para false mesmo após erro fatal na task, permitindo que novo retry em background salve a sessão",
		);

		// (Teste 6) LOCKED_BY_OTHER e NO_SESSION continuam seguindo o fluxo de limpeza após exceção no worker
		const bgPlayerLocked = { Parent: Players, Name: "BgLockedByOtherPlayer", UserId: 777023 } as unknown as Player;
		assertInvariant(bgService.loadPlayer(bgPlayerLocked).ok, "deve carregar bgPlayerLocked");
		bgService.addTinyes(bgPlayerLocked, 500);
		bgExceptionWaits.clear();
		failuresRemaining = DATASTORE_MAX_RETRIES + 1;
		onBgWaitHook = (_delay, callIdx) => {
			if (callIdx === DATASTORE_MAX_RETRIES + 1) {
				throwInSavePlayerCount = 1; // 1º ciclo em background lança exceção
			} else if (callIdx === DATASTORE_MAX_RETRIES + 2) {
				// Antes do 2º ciclo em background, outro servidor assume o lock no DataStore
				const currentRaw = sharedBackingStore.peekRaw(bgService.getPlayerKey(777023)) as PlayerSaveData;
				sharedBackingStore.setRawForTest(bgService.getPlayerKey(777023), {
					...currentRaw,
					tinyes: 999,
					sessionLock: { serverId: "Server_Other", timestamp: simulatedNow },
				});
			}
		};
		bgService.handlePlayerRemoving(bgPlayerLocked);
		onBgWaitHook = undefined;
		const rawBgLocked = sharedBackingStore.peekRaw(bgService.getPlayerKey(777023)) as PlayerSaveData;
		assertInvariant(
			!bgService.isSessionLoaded(bgPlayerLocked) &&
				!bgService.hasPendingRetrySave(bgPlayerLocked) &&
				bgProgression.getPlayerData(bgPlayerLocked) === undefined &&
				rawBgLocked.tinyes === 999 &&
				rawBgLocked.sessionLock?.serverId === "Server_Other",
			"Teste 6a: LOCKED_BY_OTHER após exceção em background deve limpar fila, sessão e ProgressionService",
		);

		const bgPlayerNoSession = { Parent: Players, Name: "BgNoSessionPlayer", UserId: 777024 } as unknown as Player;
		assertInvariant(bgService.loadPlayer(bgPlayerNoSession).ok, "deve carregar bgPlayerNoSession");
		bgExceptionWaits.clear();
		failuresRemaining = DATASTORE_MAX_RETRIES + 1;
		onBgWaitHook = (_delay, callIdx) => {
			if (callIdx === DATASTORE_MAX_RETRIES + 1) {
				throwInSavePlayerCount = 1; // 1º ciclo lança exceção
			} else if (callIdx === DATASTORE_MAX_RETRIES + 2) {
				// Antes do 2º ciclo, o jogador reentra ou a sessão é encerrada externamente
				bgService.loadPlayer(bgPlayerNoSession);
			}
		};
		bgService.handlePlayerRemoving(bgPlayerNoSession);
		onBgWaitHook = undefined;
		assertInvariant(
			bgService.isSessionLoaded(bgPlayerNoSession) &&
				!bgService.hasPendingRetrySave(bgPlayerNoSession) &&
				bgService.handlePlayerRemoving(bgPlayerNoSession).ok,
			"Teste 6b: quando a sessão anterior não está mais pendente (reentrada/NO_SESSION), o worker encerra e libera retryTaskActive",
		);

		// (Teste 7) Shutdown interrompe o worker de background e permite que BindToClose assuma os retries
		const bgPlayerShutdown = { Parent: Players, Name: "BgShutdownHandoffPlayer", UserId: 777025 } as unknown as Player;
		assertInvariant(bgService.loadPlayer(bgPlayerShutdown).ok, "deve carregar bgPlayerShutdown");
		bgService.addTinyes(bgPlayerShutdown, 800);
		bgExceptionWaits.clear();
		failuresRemaining = DATASTORE_MAX_RETRIES + 1;
		let bindToCloseTriggeredDuringWorker = false;
		onBgWaitHook = (_delay, callIdx) => {
			if (callIdx === DATASTORE_MAX_RETRIES + 1) {
				throwInSavePlayerCount = 1; // 1º ciclo do worker falha com exceção
			} else if (callIdx === DATASTORE_MAX_RETRIES + 2 && !bindToCloseTriggeredDuringWorker) {
				bindToCloseTriggeredDuringWorker = true;
				// Durante o wait do 2º ciclo do worker, o servidor entra em shutdown (BindToClose):
				// o worker deve encerrar imediatamente ao acordar e deixar saveAllPlayersOnClose concluir o save
				onBgWaitHook = undefined;
				bgService.saveAllPlayersOnClose();
			}
		};
		bgService.handlePlayerRemoving(bgPlayerShutdown);
		onBgWaitHook = undefined;
		const rawBgShutdown = sharedBackingStore.peekRaw(bgService.getPlayerKey(777025)) as PlayerSaveData;
		assertInvariant(
			bindToCloseTriggeredDuringWorker &&
				!bgService.isSessionLoaded(bgPlayerShutdown) &&
				!bgService.hasPendingRetrySave(bgPlayerShutdown) &&
				bgProgression.getPlayerData(bgPlayerShutdown) === undefined &&
				rawBgShutdown !== undefined &&
				rawBgShutdown.tinyes === INITIAL_TINYES + 800 &&
				rawBgShutdown.sessionLock === undefined,
			"Teste 7: shutdown deve interromper o worker de background e permitir que BindToClose assuma e conclua o save com releaseLock=true",
		);
	}

	// 5. Validação no load com dado corrompido: backup é gravado FORA do callback do UpdateAsync com pcall e retry
	const mainKey = flakyService.getPlayerKey(777001);
	sharedBackingStore.setRawForTest(mainKey, {
		version: PLAYER_DATA_SCHEMA_VERSION,
		pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
		tinyes: -999,
		inventory: "CORRUPTED_INVENTORY",
		activeTeam: [],
	});
	kickedReasons.delete(fakePlayer);
	retryWaits.clear();
	setAsyncCalledInsideCallback = false;
	setAsyncCallCount = 0;
	setFailuresRemaining = 2; // Força 2 falhas no SetAsync para provar pcall + retry fora do callback
	const beforeCorruptedLoad = new Set(sharedBackingStore.getKeysForTest());
	const corruptedLoad = flakyService.loadPlayer(fakePlayer);
	const rawMainAfterCorruptedLoad = sharedBackingStore.peekRaw(mainKey) as Record<string, unknown> | undefined;
	const rawBackupAfterCorruptedLoad = sharedBackingStore.peekRaw(
		findBackupKey(sharedBackingStore, simulatedNow, beforeCorruptedLoad),
	) as Record<string, unknown> | undefined;
	assertInvariant(
		!corruptedLoad.ok &&
			corruptedLoad.status === "CORRUPTED" &&
			corruptedLoad.data === undefined &&
			!setAsyncCalledInsideCallback &&
			setAsyncCallCount === 3 &&
			retryWaits.size() === 2 &&
			flakyService.getCorruptionLogs().size() >= 1 &&
			kickedReasons.has(fakePlayer) &&
			!flakyService.isSessionLoaded(fakePlayer) &&
			progressionFlaky.getPlayerData(fakePlayer) === undefined &&
			rawMainAfterCorruptedLoad !== undefined &&
			rawMainAfterCorruptedLoad.tinyes === -999 &&
			rawMainAfterCorruptedLoad.inventory === "CORRUPTED_INVENTORY" &&
			rawBackupAfterCorruptedLoad !== undefined &&
			rawBackupAfterCorruptedLoad.tinyes === -999 &&
			rawBackupAfterCorruptedLoad.inventory === "CORRUPTED_INVENTORY",
		"backup de dado corrompido deve ser gravado FORA do callback do UpdateAsync com pcall e retry, sem sobrescrever a chave principal e expulsando o jogador",
	);

	// 5.1. Saves concorrentes (autosave + logout) são serializados sem perda de dados
	const concurrentPlayer = { Parent: Players, Name: "ConcurrentSavePlayer", UserId: 777012 } as unknown as Player;
	let interceptAutosaveInFlight = false;
	let concurrentUpdateCalls = 0;
	let concurrentPollWaits = 0;
	let nestedAutosaveResultAttempts = -1;
	let logoutThread: thread | undefined;
	let logoutResult: { ok: boolean; status: string } | undefined;

	const progressionConcurrent = new ProgressionService();
	let concurrentService!: PlayerDataService;
	const concurrentStore: DataStoreLike = {
		UpdateAsync(key, transform) {
			concurrentUpdateCalls += 1;
			if (interceptAutosaveInFlight) {
				interceptAutosaveInFlight = false;
				// 1) Segundo autosave concorrente deve retornar imediatamente sem chamar UpdateAsync
				const nestedAutosave = concurrentService.savePlayer(concurrentPlayer, false);
				nestedAutosaveResultAttempts = nestedAutosave.attempts;
				// 2) Jogador ganha +250 Tinyes enquanto o 1º autosave (com 100 Tinyes) ainda está em andamento
				concurrentService.addTinyes(concurrentPlayer, 250);
				// 3) Logout inicia em paralelo: marca closing=true e aguarda while (session.saving)
				logoutThread = coroutine.create(() => {
					logoutResult = concurrentService.handlePlayerRemoving(concurrentPlayer);
				});
				const [resumedOk, resumeErr] = coroutine.resume(logoutThread);
				assertInvariant(resumedOk, `falha ao iniciar coroutine de logout concorrente: ${tostring(resumeErr)}`);
				// Enquanto closing=true, autosaveAllPlayers também deve ignorar a sessão
				concurrentService.autosaveAllPlayers();
			}
			return sharedBackingStore.UpdateAsync(key, transform);
		},
	};
	concurrentService = new PlayerDataService(progressionConcurrent, {
		dataStore: concurrentStore,
		serverId: "Server_Concurrent",
		now: () => simulatedNow,
		waitFn: () => {
			concurrentPollWaits += 1;
			coroutine.yield();
		},
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});

	assertInvariant(concurrentService.loadPlayer(concurrentPlayer).ok, "deve carregar jogador para teste concorrente");
	concurrentService.addTinyes(concurrentPlayer, 100);
	concurrentUpdateCalls = 0;
	interceptAutosaveInFlight = true;

	const firstAutosaveResult = concurrentService.savePlayer(concurrentPlayer, false);
	assertInvariant(
		firstAutosaveResult.ok &&
			firstAutosaveResult.status === "SAVED" &&
			nestedAutosaveResultAttempts === 0 &&
			concurrentUpdateCalls === 1 &&
			concurrentPollWaits === 1 &&
			logoutThread !== undefined &&
			coroutine.status(logoutThread) === "suspended",
		"autosave concorrente deve ser ignorado enquanto saving=true e logout deve aguardar término do save em andamento",
	);

	// Retoma o logout que aguardava `while (session.saving)`: agora captura o snapshot atualizado (350 Tinyes) e libera lock
	const [finishedOk, finishErr] = coroutine.resume(logoutThread!);
	assertInvariant(finishedOk, `falha ao concluir coroutine de logout concorrente: ${tostring(finishErr)}`);
	const finalConcurrentRaw = sharedBackingStore.peekRaw(
		concurrentService.getPlayerKey(777012),
	) as PlayerSaveData;
	assertInvariant(
		logoutResult !== undefined &&
			logoutResult.ok &&
			logoutResult.status === "SAVED" &&
			concurrentUpdateCalls === 2 &&
			!concurrentService.isSessionLoaded(concurrentPlayer) &&
			progressionConcurrent.getPlayerData(concurrentPlayer) === undefined &&
			finalConcurrentRaw !== undefined &&
			finalConcurrentRaw.tinyes === INITIAL_TINYES + 350 &&
			finalConcurrentRaw.sessionLock === undefined,
		"saves concorrentes (autosave + logout) devem ser serializados sem perda dos dados alterados durante o autosave",
	);

	// 5.2. Tempo limite na espera while (session.saving) (SAVE_WAIT_TIMEOUT_SECONDS em Config.ts)
	assertInvariant(
		SAVE_WAIT_TIMEOUT_SECONDS > 0,
		"SAVE_WAIT_TIMEOUT_SECONDS deve ser definido e positivo em Config.ts",
	);
	const stuckPlayer = { Parent: Players, Name: "StuckSavePlayer", UserId: 777013 } as unknown as Player;
	let interceptStuckSave = false;
	let stuckLogoutResult: { ok: boolean; status: string } | undefined;
	let stuckWaitTotal = 0;
	const progressionStuck = new ProgressionService();
	let stuckService!: PlayerDataService;
	const stuckStore: DataStoreLike = {
		UpdateAsync(key, transform) {
			if (interceptStuckSave) {
				interceptStuckSave = false;
				// Enquanto o autosave está travado com session.saving = true, handlePlayerRemoving aguarda até o timeout e reenfileira
				stuckLogoutResult = stuckService.handlePlayerRemoving(stuckPlayer);
			}
			return sharedBackingStore.UpdateAsync(key, transform);
		},
	};
	stuckService = new PlayerDataService(progressionStuck, {
		dataStore: stuckStore,
		serverId: "Server_Stuck",
		now: () => simulatedNow,
		waitFn: (seconds) => {
			stuckWaitTotal += seconds;
		},
		saveWaitTimeoutSeconds: 0.25,
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	assertInvariant(stuckService.loadPlayer(stuckPlayer).ok, "deve carregar jogador para teste de timeout de saving");
	stuckService.addTinyes(stuckPlayer, 50);
	interceptStuckSave = true;
	stuckService.savePlayer(stuckPlayer, false);
	assertInvariant(
		stuckLogoutResult !== undefined &&
			!stuckLogoutResult.ok &&
			stuckLogoutResult.status === "RETRY_SCHEDULED" &&
			stuckWaitTotal >= 0.25 - FLOAT_TOLERANCE &&
			stuckService.isSessionLoaded(stuckPlayer) &&
			stuckService.hasPendingRetrySave(stuckPlayer),
		"espera while (session.saving) deve respeitar o tempo limite configurado e reenfileirar o save sem descartar a sessão",
	);
	assertInvariant(stuckService.handlePlayerRemoving(stuckPlayer).ok, "deve liberar sessão após o save travado concluir");

	// 6. Migração de versão de schema em etapas (v0 -> v1 -> v2 -> v3, uma versão por vez e validando após cada passo)
	const migrationPlayer = { Parent: Players, Name: "LegacySchemaPlayer", UserId: 777002 } as unknown as Player;
	const legacyUuid = "legacy-uuid-0001-0002-0003-000000000001";
	const legacySkills: SkillSlots = [
		calcSkillSlotRoll(1, 0.33),
		calcSkillSlotRoll(2, 0.44),
		calcSkillSlotRoll(3, 0.55),
	];
	sharedBackingStore.setRawForTest(flakyService.getPlayerKey(777002), {
		version: 0,
		coins: 1200,
		fighters: [
			{
				itemUuid: legacyUuid,
				fighterId: "jotaro",
				rarity: "Lendária",
				level: 4,
				xp: 80,
				baseStats: { hp: 16, atk: 11, dodge: 7, crit: 10 },
				allocatedStats: { hp: 2, atk: 2, dodge: 1, crit: 1 },
				skills: legacySkills,
			},
		],
	});
	const migratedLoad = flakyService.loadPlayer(migrationPlayer);
	assertInvariant(
		migratedLoad.ok &&
			migratedLoad.data !== undefined &&
			migratedLoad.data.version === PLAYER_DATA_SCHEMA_VERSION &&
			migratedLoad.data.tinyes === 1200 &&
			migratedLoad.data.inventory.size() === 1 &&
			migratedLoad.data.inventory[0].itemUuid === legacyUuid &&
			migratedLoad.data.inventory[0].level === 4 &&
			migratedLoad.data.inventory[0].baseStats.atk === 11 &&
			migratedLoad.data.inventory[0].skills[0].t === legacySkills[0].t &&
			migratedLoad.data.activeTeam[0] === legacyUuid,
		"migração de schema v0 -> v1 deve atualizar versão e preservar itemUuid, baseStats, skills e moedas",
	);

	// 6.1. Salto de várias versões (v0 -> v1 -> v2 -> v3) validando após cada etapa
	const multiStepPlayer = { Parent: Players, Name: "MultiStepMigrationPlayer", UserId: 777014 } as unknown as Player;
	const executedSteps: number[] = [];
	const multiStepMigrations = new Map<number, SchemaMigrationFn>([
		[
			1,
			(raw) => {
				executedSteps.push(1);
				return {
					...raw,
					version: 2,
					pvp: { pairs: {}, dailyTinyes: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
					tinyes: (raw.tinyes as number) + 300,
				};
			},
		],
		[
			2,
			(raw) => {
				executedSteps.push(2);
				return {
					...raw,
					version: 3,
					pvp: { pairs: {}, dailyTinyes: 0, dayKey: 0 },
					tinyes: (raw.tinyes as number) + 500,
				};
			},
		],
	]);
	const multiStepProgression = new ProgressionService();
	const multiStepService = new PlayerDataService(multiStepProgression, {
		dataStore: sharedBackingStore,
		serverId: "Server_MultiStep",
		schemaVersion: 3,
		migrations: multiStepMigrations,
		now: () => simulatedNow,
		waitFn: () => {},
		kickPlayer: (player, msg) => kickedReasons.set(player, msg),
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	sharedBackingStore.setRawForTest(multiStepService.getPlayerKey(777014), {
		version: 0,
		coins: 1000,
		fighters: [
			{
				itemUuid: legacyUuid,
				fighterId: "jotaro",
				rarity: "Lendária",
				level: 4,
				xp: 80,
				baseStats: { hp: 16, atk: 11, dodge: 7, crit: 10 },
				allocatedStats: { hp: 2, atk: 2, dodge: 1, crit: 1 },
				skills: legacySkills,
			},
		],
	});
	const multiStepLoad = multiStepService.loadPlayer(multiStepPlayer);
	assertInvariant(
		multiStepLoad.ok &&
			multiStepLoad.data !== undefined &&
			multiStepLoad.data.version === 3 &&
			multiStepLoad.data.tinyes === 1800 &&
			executedSteps.size() === 2 &&
			executedSteps[0] === 1 &&
			executedSteps[1] === 2 &&
			multiStepLoad.data.inventory[0].itemUuid === legacyUuid &&
			multiStepLoad.data.inventory[0].skills[0].t === legacySkills[0].t,
		"migração com salto de várias versões (v0 -> v1 -> v2 -> v3) deve rodar uma versão por vez na ordem correta preservando dados",
	);
	multiStepService.handlePlayerRemoving(multiStepPlayer);

	// 6.2. Se uma etapa intermediária (v1 -> v2) produzir estado inválido, a validação após o passo aborta antes de rodar v2 -> v3
	const brokenStepPlayer = { Parent: Players, Name: "BrokenIntermediateStepPlayer", UserId: 777015 } as unknown as Player;
	let step2To3CalledAfterInvalidStep = false;
	const brokenMigrations = new Map<number, SchemaMigrationFn>([
		[
			1,
			(raw) => ({
				...raw,
				version: 2,
				pvp: { pairs: {}, dailyTinyes: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
				tinyes: -50, // inválido na validação pós-etapa v1 -> v2!
			}),
		],
		[
			2,
			(raw) => {
				step2To3CalledAfterInvalidStep = true;
				return {
					...raw,
					version: 3,
					pvp: { pairs: {}, dailyTinyes: 0, dayKey: 0 },
					tinyes: 500, // tentaria mascarar o erro se não validasse a cada passo
				};
			},
		],
	]);
	const brokenStepService = new PlayerDataService(new ProgressionService(), {
		dataStore: sharedBackingStore,
		serverId: "Server_BrokenStep",
		schemaVersion: 3,
		migrations: brokenMigrations,
		now: () => simulatedNow,
		waitFn: () => {},
		kickPlayer: (player, msg) => kickedReasons.set(player, msg),
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	sharedBackingStore.setRawForTest(brokenStepService.getPlayerKey(777015), {
		version: 0,
		coins: 100,
		fighters: [],
	});
	const beforeBrokenStep = new Set(sharedBackingStore.getKeysForTest());
	const brokenStepLoad = brokenStepService.loadPlayer(brokenStepPlayer);
	const brokenBackupRaw = sharedBackingStore.peekRaw(
		findBackupKey(sharedBackingStore, simulatedNow, beforeBrokenStep),
	) as Record<string, unknown> | undefined;
	assertInvariant(
		!brokenStepLoad.ok &&
			brokenStepLoad.status === "CORRUPTED" &&
			!step2To3CalledAfterInvalidStep &&
			brokenBackupRaw !== undefined &&
			brokenBackupRaw.coins === 100,
		"migração deve validar após cada passo individual (v1 -> v2 inválido deve abortar imediatamente sem executar v2 -> v3 e gravar backup via executeSetWithRetry no InMemoryDataStore)",
	);

	// 7. BindToClose (saveAllPlayersOnClose) com falha inicial seguida de sucesso dentro da janela de timeout,
	//    respeito ao prazo máximo nos retries internos de executeUpdateWithRetry e Fallback automático em memória no Studio
	flakyService.addTinyes(migrationPlayer, 350); // Total em memória = 1200 + 350 = 1550
	retryWaits.clear();
	failuresRemaining = DATASTORE_MAX_RETRIES + 2; // 1º ciclo de handlePlayerRemoving falha todas as 4 tentativas; 2º ciclo no loop do BindToClose sucede
	flakyService.saveAllPlayersOnClose();
	const afterBindToClose = sharedBackingStore.peekRaw(flakyService.getPlayerKey(777002)) as PlayerSaveData;
	assertInvariant(
		failuresRemaining === 0 &&
			afterBindToClose !== undefined &&
			afterBindToClose.tinyes === 1550 &&
			afterBindToClose.sessionLock === undefined &&
			!flakyService.isSessionLoaded(migrationPlayer) &&
			progressionFlaky.getPlayerData(migrationPlayer) === undefined,
		"BindToClose deve continuar retentando após falha inicial dentro da janela de timeout, persistir os dados finais, liberar o sessionLock e remover a sessão antes de encerrar",
	);

	// 7.1. Durante BindToClose (shuttingDown = true), o backoff interno de executeUpdateWithRetry nunca deve ultrapassar o tempo restante até BIND_TO_CLOSE_TIMEOUT_SECONDS (com margem segura)
	const shutdownBudgetPlayer = { Parent: Players, Name: "ShutdownBudgetPlayer", UserId: 777016 } as unknown as Player;
	const shutdownWaits: number[] = [];
	const shutdownBudgetProgression = new ProgressionService();
	const shutdownBudgetService = new PlayerDataService(shutdownBudgetProgression, {
		dataStore: flakyStore,
		serverId: "Server_ShutdownBudget",
		now: () => simulatedNow,
		waitFn: (seconds) => {
			shutdownWaits.push(seconds);
		},
		retryBaseDelaySeconds: 2.0,
		retryBackoffFactor: 4,
		retryMaxDelaySeconds: 20.0,
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	failuresRemaining = 0;
	assertInvariant(
		shutdownBudgetService.loadPlayer(shutdownBudgetPlayer).ok,
		"deve carregar jogador para teste de orçamento de tempo do BindToClose",
	);
	shutdownWaits.clear();
	failuresRemaining = 999; // Falha contínua durante todo o BindToClose
	shutdownBudgetService.saveAllPlayersOnClose();
	failuresRemaining = 0;
	let totalShutdownWaitSeconds = 0;
	for (const w of shutdownWaits) {
		totalShutdownWaitSeconds += w;
	}
	assertInvariant(
		shutdownWaits.size() > 0 &&
			totalShutdownWaitSeconds <= BIND_TO_CLOSE_TIMEOUT_SECONDS - 2 + FLOAT_TOLERANCE,
		`backoff interno de executeUpdateWithRetry durante BindToClose não pode ultrapassar o prazo seguro de BIND_TO_CLOSE_TIMEOUT_SECONDS (esperado <= ${BIND_TO_CLOSE_TIMEOUT_SECONDS - 2}s, atual: ${totalShutdownWaitSeconds}s)`,
	);

	const fallbackWarnings: string[] = [];
	const studioFallbackProgression = new ProgressionService();
	const studioFallbackService = new PlayerDataService(studioFallbackProgression, {
		forceStudioFallback: true,
		warnFn: (msg) => fallbackWarnings.push(msg),
	});
	const studioPlayer = { Parent: Players, Name: "StudioPlaytestPlayer", UserId: 777003 } as unknown as Player;
	const studioLoad = studioFallbackService.loadPlayer(studioPlayer);
	assertInvariant(
		studioFallbackService.isUsingMemoryFallback() &&
			fallbackWarnings.size() >= 1 &&
			studioLoad.ok &&
			studioLoad.status === "FALLBACK_MEMORY" &&
			studioLoad.data !== undefined &&
			studioLoad.data.inventory.size() === 1,
		"fallback automático em memória para Studio deve logar aviso claro e manter o playtest funcional",
	);
	studioFallbackService.handlePlayerRemoving(studioPlayer);
	assertInvariant(
		!studioFallbackService.hasLastValidSnapshot(777003),
		"snapshot deve ser removido após encerramento definitivo da sessão no fallback em memória",
	);

	// 8. Fallback do Studio: shouldTriggerStudioFallback restrito a 403/studio e preservação de sessão após 1º load bem-sucedido
	{
		let injectedErrorToThrow: string | undefined;
		const studioDynamicWarnings: string[] = [];
		const studioBackingStore = new InMemoryDataStore();
		const dynamicStudioStore: DataStoreLike = {
			UpdateAsync(key, transform) {
				if (injectedErrorToThrow !== undefined) {
					error(injectedErrorToThrow);
				}
				return studioBackingStore.UpdateAsync(key, transform);
			},
			SetAsync(key, value) {
				if (injectedErrorToThrow !== undefined) {
					error(injectedErrorToThrow);
				}
				return studioBackingStore.SetAsync(key, value);
			},
		};
		const dynamicStudioProg = new ProgressionService();
		const dynamicStudioService = new PlayerDataService(dynamicStudioProg, {
			dataStore: dynamicStudioStore,
			serverId: "Server_StudioDynamic",
			now: () => simulatedNow,
			waitFn: () => {},
			kickPlayer: (player, msg) => kickedReasons.set(player, msg),
			warnFn: (msg) => studioDynamicWarnings.push(msg),
			disableStudioAutoFallbackOnInjectedStore: false,
		});

		const studioCheckPlayer = { Parent: Players, Name: "StudioCheckPlayer", UserId: 777030 } as unknown as Player;
		// Erros "502", "api" e "publish" NÃO devem acionar o fallback automático do Studio
		for (const nonStudioErr of ["HTTP 502 Bad Gateway", "API Services rejected request", "Publish failure"]) {
			injectedErrorToThrow = nonStudioErr;
			const failedNonStudio = dynamicStudioService.loadPlayer(studioCheckPlayer);
			assertInvariant(
				!failedNonStudio.ok &&
					failedNonStudio.status === "NETWORK_ERROR" &&
					!dynamicStudioService.isUsingMemoryFallback(),
				`erro '${nonStudioErr}' não deve acionar shouldTriggerStudioFallback`,
			);
		}

		// Primeiro load bem-sucedido na store normal
		injectedErrorToThrow = undefined;
		const firstValidLoad = dynamicStudioService.loadPlayer(studioCheckPlayer);
		assertInvariant(
			firstValidLoad.ok &&
				firstValidLoad.status === "LOADED" &&
				firstValidLoad.data !== undefined &&
				!dynamicStudioService.isUsingMemoryFallback(),
			"primeiro load antes do fallback deve carregar como LOADED",
		);
		const originalStarterUuid = firstValidLoad.data!.inventory[0].itemUuid;
		dynamicStudioService.addTinyes(studioCheckPlayer, 350);

		// Agora ocorre erro 403 / Studio depois do primeiro load bem-sucedido:
		// Não deve criar conta nova, deve manter a sessão existente (mesmo itemUuid e tinyes) e avisar!
		studioDynamicWarnings.clear();
		injectedErrorToThrow = "403: Studio access to APIs is not allowed";
		const loadAfterFallback = dynamicStudioService.loadPlayer(studioCheckPlayer);
		assertInvariant(
			dynamicStudioService.isUsingMemoryFallback() &&
				loadAfterFallback.ok &&
				loadAfterFallback.status === "FALLBACK_MEMORY" &&
				loadAfterFallback.data !== undefined &&
				loadAfterFallback.data.tinyes === INITIAL_TINYES + 350 &&
				loadAfterFallback.data.inventory.size() === 1 &&
				loadAfterFallback.data.inventory[0].itemUuid === originalStarterUuid &&
				dynamicStudioService.isSessionLoaded(studioCheckPlayer) &&
				studioDynamicWarnings.some((w) => w.find("Mantendo a sessão")[0] !== undefined),
			"fallback acionado após o primeiro load bem-sucedido não deve criar conta nova: deve manter a sessão e avisar",
		);
		dynamicStudioService.handlePlayerRemoving(studioCheckPlayer);
	}

	// 9. Gerenciamento de ciclo de vida de lastValidSnapshots e fluxo completo de RECOVERED_LAST_VALID
	{
		const snapBackingStore = new InMemoryDataStore();
		let failRecoveryUpdateAttempts = 0;
		let totalUpdateCalls = 0;
		let onBeforeRecoveryUpdateHook: (() => void) | undefined;
		const snapWarnings: string[] = [];

		const snapStore: DataStoreLike = {
			UpdateAsync(key, transform) {
				totalUpdateCalls += 1;
				if (key.sub(1, 2) !== "C_" && onBeforeRecoveryUpdateHook !== undefined) {
					const hook = onBeforeRecoveryUpdateHook;
					onBeforeRecoveryUpdateHook = undefined;
					hook();
				}
				if (failRecoveryUpdateAttempts > 0) {
					failRecoveryUpdateAttempts -= 1;
					error("Simulated503: UpdateAsync failed during recovery");
				}
				return snapBackingStore.UpdateAsync(key, transform);
			},
			SetAsync(key, value) {
				return snapBackingStore.SetAsync(key, value);
			},
		};

		const snapProg = new ProgressionService();
		const snapService = new PlayerDataService(snapProg, {
			dataStore: snapStore,
			serverId: "Server_SnapTest",
			rng: createSeededRng(FIRST_SIMULATION_SEED + 900),
			now: () => simulatedNow,
			waitFn: () => {},
			kickPlayer: (player, msg) => kickedReasons.set(player, msg),
			warnFn: (msg) => snapWarnings.push(msg),
			disableStudioAutoFallbackOnInjectedStore: true,
		});

		// 9.1. Distinção entre snapshot válido em memória e dados efetivamente persistidos + remoção no encerramento definitivo
		const snapPlayer1 = { Parent: Players, Name: "SnapLifecyclePlayer", UserId: 777040 } as unknown as Player;
		const loadSnap1 = snapService.loadPlayer(snapPlayer1);
		assertInvariant(
			loadSnap1.ok &&
				snapService.hasLastValidSnapshot(777040) &&
				snapService.isLastValidSnapshotPersisted(777040) &&
				snapService.getLastPersistedSnapshot(777040)?.tinyes === INITIAL_TINYES,
			"após loadPlayer confirmado, lastValidSnapshots deve existir e estar marcado como persistido",
		);

		// Alteração em memória (addTinyes): atualiza snapshot em memória (persisted = false), sem confundir com dados persistidos
		snapService.addTinyes(snapPlayer1, 500);
		assertInvariant(
			snapService.hasLastValidSnapshot(777040) &&
				!snapService.isLastValidSnapshotPersisted(777040) &&
				snapService.getLastValidSnapshot(777040)?.tinyes === INITIAL_TINYES + 500 &&
				snapService.getLastPersistedSnapshot(777040)?.tinyes === INITIAL_TINYES,
			"alteração em memória antes da confirmação do DataStore deve manter isLastValidSnapshotPersisted = false",
		);

		// Save que falha no DataStore: snapshot continua não-persistido (persisted = false)
		failRecoveryUpdateAttempts = DATASTORE_MAX_RETRIES + 1;
		const failedMidSave = snapService.savePlayer(snapPlayer1, false);
		failRecoveryUpdateAttempts = 0;
		assertInvariant(
			!failedMidSave.ok &&
				failedMidSave.status === "RETRY_SCHEDULED" &&
				snapService.hasLastValidSnapshot(777040) &&
				!snapService.isLastValidSnapshotPersisted(777040) &&
				snapService.getLastPersistedSnapshot(777040)?.tinyes === INITIAL_TINYES,
			"falha em savePlayer não deve marcar o snapshot em memória como efetivamente persistido",
		);

		// Save confirmado no DataStore: agora isLastValidSnapshotPersisted volta a ser true
		simulatedNow += 10;
		const confirmedMidSave = snapService.savePlayer(snapPlayer1, false);
		assertInvariant(
			confirmedMidSave.ok &&
				snapService.isLastValidSnapshotPersisted(777040) &&
				snapService.getLastPersistedSnapshot(777040)?.tinyes === INITIAL_TINYES + 500,
			"após confirmação de UpdateAsync em savePlayer, o snapshot deve ser marcado como persistido",
		);

		// Encerramento normal imediato remove o snapshot de snapService
		assertInvariant(snapService.hasLastValidSnapshot(777040), "snapshot deve existir durante a sessão");
		assertInvariant(snapService.handlePlayerRemoving(snapPlayer1).ok, "save de saída deve ter sucesso");
		assertInvariant(
			!snapService.hasLastValidSnapshot(777040),
			"snapshot deve ser removido imediatamente após encerramento definitivo da sessão com save bem-sucedido",
		);

		// Preservação do snapshot enquanto houver retry de saída pendente + remoção após conclusão definitiva
		let checkedSnapshotWhileRetryPending = false;
		const pendingWaitService = new PlayerDataService(snapProg, {
			dataStore: snapStore,
			serverId: "Server_SnapPending",
			now: () => simulatedNow,
			waitFn: () => {
				if (failRecoveryUpdateAttempts === 0 && !checkedSnapshotWhileRetryPending) {
					checkedSnapshotWhileRetryPending = true;
					assertInvariant(
						pendingWaitService.hasPendingRetrySave(snapPlayer1) &&
							pendingWaitService.hasLastValidSnapshot(777040),
						"snapshot deve ser preservado enquanto ainda houver retry de save pendente",
					);
				}
			},
			kickPlayer: (player, msg) => kickedReasons.set(player, msg),
			warnFn: () => {},
			disableStudioAutoFallbackOnInjectedStore: true,
		});
		failRecoveryUpdateAttempts = 0;
		assertInvariant(pendingWaitService.loadPlayer(snapPlayer1).ok, "deve carregar no pendingWaitService");
		pendingWaitService.addTinyes(snapPlayer1, 150);
		failRecoveryUpdateAttempts = DATASTORE_MAX_RETRIES + 1;
		const exitWithRetry = pendingWaitService.handlePlayerRemoving(snapPlayer1);
		assertInvariant(
			!exitWithRetry.ok &&
				exitWithRetry.status === "RETRY_SCHEDULED" &&
				checkedSnapshotWhileRetryPending &&
				!pendingWaitService.isSessionLoaded(snapPlayer1) &&
				!pendingWaitService.hasPendingRetrySave(snapPlayer1) &&
				!pendingWaitService.hasLastValidSnapshot(777040),
			"snapshot deve ser preservado durante retry pendente e removido assim que o retry de saída concluir definitivamente",
		);

		// 9.2. Recuperação bem-sucedida a partir de snapshot válido (RECOVERED_LAST_VALID)
		const recoverPlayer = { Parent: Players, Name: "RecoverValidPlayer", UserId: 777041 } as unknown as Player;
		const initialRecoverLoad = snapService.loadPlayer(recoverPlayer);
		assertInvariant(initialRecoverLoad.ok && initialRecoverLoad.data !== undefined, "deve carregar recoverPlayer");
		const recoverStarterUuid = initialRecoverLoad.data!.inventory[0].itemUuid;
		const recoverStarterSkills = initialRecoverLoad.data!.inventory[0].skills;
		snapService.addTinyes(recoverPlayer, 900);
		snapProg.addXp(recoverPlayer, recoverStarterUuid, calcXpForNextLevel(1) + 25);
		assertInvariant(snapProg.allocatePoints(recoverPlayer, recoverStarterUuid, "atk", 2), "deve alocar 2 ATK");
		simulatedNow += 15;
		assertInvariant(snapService.savePlayer(recoverPlayer, false).ok, "deve confirmar save antes da corrupção");

		// Corrompe o registro bruto no DataStore
		const recoverKey = snapService.getPlayerKey(777041);
		simulatedNow += 5;
		snapBackingStore.setRawForTest(recoverKey, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -777,
			inventory: "BROKEN_ARRAY",
			activeTeam: [],
		});
		const beforeRecoveredResult = new Set(snapBackingStore.getKeysForTest());
		const recoveredResult = snapService.loadPlayer(recoverPlayer);
		const backupAfterRecovery = snapBackingStore.peekRaw(
			findBackupKey(snapBackingStore, simulatedNow, beforeRecoveredResult),
		) as Record<string, unknown> | undefined;
		const persistedAfterRecovery = snapBackingStore.peekRaw(recoverKey) as PlayerSaveData | undefined;
		assertInvariant(
			recoveredResult.ok &&
				recoveredResult.status === "RECOVERED_LAST_VALID" &&
				recoveredResult.data !== undefined &&
				recoveredResult.data.tinyes === INITIAL_TINYES + 900 &&
				recoveredResult.data.inventory.size() === 1 &&
				recoveredResult.data.inventory[0].itemUuid === recoverStarterUuid &&
				recoveredResult.data.inventory[0].level === 2 &&
				math.abs(recoveredResult.data.inventory[0].xp - 25) <= FLOAT_TOLERANCE &&
				recoveredResult.data.inventory[0].allocatedStats.atk === 2 &&
				recoveredResult.data.inventory[0].skills[0].t === recoverStarterSkills[0].t &&
				backupAfterRecovery !== undefined &&
				backupAfterRecovery.tinyes === -777 &&
				backupAfterRecovery.inventory === "BROKEN_ARRAY" &&
				persistedAfterRecovery !== undefined &&
				persistedAfterRecovery.tinyes === INITIAL_TINYES + 900 &&
				persistedAfterRecovery.sessionLock?.serverId === "Server_SnapTest" &&
				snapService.isSessionLoaded(recoverPlayer) &&
				snapService.isLastValidSnapshotPersisted(777041),
			"RECOVERED_LAST_VALID deve preservar backup _Corrupted_ primeiro, restaurar via UpdateAsync com sessionLock e retornar os dados íntegros",
		);

		// 9.3. Recusa de snapshot inválido e recusa de snapshot pertencente a outro jogador
		simulatedNow += 10;
		snapBackingStore.setRawForTest(recoverKey, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -123,
			inventory: [],
			activeTeam: [],
		});
		// Injeta snapshot de outro jogador (userId divergente)
		snapService.setLastValidSnapshotForTest(777041, recoveredResult.data!, {
			userId: 999999,
			key: snapService.getPlayerKey(999999),
		});
		kickedReasons.delete(recoverPlayer);
		const crossPlayerLoad = snapService.loadPlayer(recoverPlayer);
		assertInvariant(
			!crossPlayerLoad.ok &&
				crossPlayerLoad.status === "CORRUPTED" &&
				kickedReasons.has(recoverPlayer) &&
				!snapService.isSessionLoaded(recoverPlayer),
			"nunca deve utilizar snapshot pertencente a outro jogador",
		);

		// Injeta snapshot inválido (tinyes negativo / falha em validatePlayerSaveData)
		simulatedNow += 10;
		snapBackingStore.setRawForTest(recoverKey, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -456,
			inventory: [],
			activeTeam: [],
		});
		snapService.setLastValidSnapshotForTest(777041, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -10,
			inventory: [],
			activeTeam: [],
		});
		kickedReasons.delete(recoverPlayer);
		const invalidSnapshotLoad = snapService.loadPlayer(recoverPlayer);
		assertInvariant(
			!invalidSnapshotLoad.ok &&
				invalidSnapshotLoad.status === "CORRUPTED" &&
				kickedReasons.has(recoverPlayer) &&
				!snapService.isSessionLoaded(recoverPlayer) &&
				!snapService.hasLastValidSnapshot(777041),
			"deve revalidar o snapshot com validatePlayerSaveData() e recusar snapshot inválido",
		);

		// 9.4. Recusa de recuperação quando não existe snapshot
		simulatedNow += 10;
		kickedReasons.delete(recoverPlayer);
		const noSnapshotLoad = snapService.loadPlayer(recoverPlayer);
		assertInvariant(
			!noSnapshotLoad.ok &&
				noSnapshotLoad.status === "CORRUPTED" &&
				kickedReasons.has(recoverPlayer) &&
				!snapService.isSessionLoaded(recoverPlayer),
			"sem snapshot disponível em lastValidSnapshots, deve recusar recuperação e retornar CORRUPTED",
		);

		// 9.5. Falha de UpdateAsync durante a recuperação + garantia de que RECOVERED_LAST_VALID só retorna após confirmação real
		const failRecPlayer = { Parent: Players, Name: "FailRecUpdatePlayer", UserId: 777042 } as unknown as Player;
		snapBackingStore.setRawForTest(snapService.getPlayerKey(777042), undefined);
		assertInvariant(snapService.loadPlayer(failRecPlayer).ok, "deve carregar failRecPlayer");
		snapService.addTinyes(failRecPlayer, 300);
		simulatedNow += 10;
		assertInvariant(snapService.savePlayer(failRecPlayer, false).ok, "deve salvar failRecPlayer");

		const failRecKey = snapService.getPlayerKey(777042);
		simulatedNow += 10;
		snapBackingStore.setRawForTest(failRecKey, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -888,
			inventory: "CORRUPTED",
			activeTeam: [],
		});
		// 1º UpdateAsync (detecção) passa, SetAsync do backup passa, mas o 2º UpdateAsync (restauração) falha em todas as tentativas
		onBeforeRecoveryUpdateHook = () => {
			onBeforeRecoveryUpdateHook = () => {
				failRecoveryUpdateAttempts = DATASTORE_MAX_RETRIES + 1;
			};
		};
		kickedReasons.delete(failRecPlayer);
		const failedRecoveryLoad = snapService.loadPlayer(failRecPlayer);
		failRecoveryUpdateAttempts = 0;
		onBeforeRecoveryUpdateHook = undefined;
		const rawAfterFailedRecovery = snapBackingStore.peekRaw(failRecKey) as Record<string, unknown> | undefined;
		assertInvariant(
			!failedRecoveryLoad.ok &&
				failedRecoveryLoad.status === "CORRUPTED" &&
				failedRecoveryLoad.data === undefined &&
				kickedReasons.has(failRecPlayer) &&
				!snapService.isSessionLoaded(failRecPlayer) &&
				rawAfterFailedRecovery !== undefined &&
				rawAfterFailedRecovery.tinyes === -888,
			"RECOVERED_LAST_VALID nunca pode ser retornado se o UpdateAsync de recuperação falhar",
		);

		// 9.6. Session lock pertencente a outro servidor (na leitura inicial e adquirido concorrentemente antes do UpdateAsync de recuperação)
		const lockRecPlayer = { Parent: Players, Name: "LockRecPlayer", UserId: 777043 } as unknown as Player;
		assertInvariant(snapService.loadPlayer(lockRecPlayer).ok, "deve carregar lockRecPlayer");
		const lockRecKey = snapService.getPlayerKey(777043);
		simulatedNow += 10;
		// Caso A: registro corrompido no DataStore já possui sessionLock ativo de outro servidor
		snapBackingStore.setRawForTest(lockRecKey, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -555,
			inventory: "CORRUPTED_BY_OTHER",
			activeTeam: [],
			sessionLock: {
				serverId: "Server_OtherActive",
				timestamp: simulatedNow,
			},
		});
		kickedReasons.delete(lockRecPlayer);
		const lockedCorruptLoadA = snapService.loadPlayer(lockRecPlayer);
		const rawAfterLockedA = snapBackingStore.peekRaw(lockRecKey) as Record<string, unknown> | undefined;
		assertInvariant(
			!lockedCorruptLoadA.ok &&
				lockedCorruptLoadA.status === "LOCKED" &&
				kickedReasons.get(lockRecPlayer) === SESSION_LOCK_KICK_MESSAGE &&
				!snapService.isSessionLoaded(lockRecPlayer) &&
				rawAfterLockedA !== undefined &&
				rawAfterLockedA.sessionLock !== undefined &&
				(rawAfterLockedA.sessionLock as { serverId: string }).serverId === "Server_OtherActive",
			"não deve recuperar dados quando o sessionLock no DataStore pertence a outro servidor ativo",
		);

		// Caso B: outro servidor adquire o sessionLock exatamente entre a detecção/backup e o transform do UpdateAsync de recuperação
		snapBackingStore.setRawForTest(lockRecKey, undefined);
		assertInvariant(snapService.loadPlayer(lockRecPlayer).ok, "deve recarregar lockRecPlayer");
		simulatedNow += 10;
		snapBackingStore.setRawForTest(lockRecKey, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -333,
			inventory: "CORRUPTED_RACE",
			activeTeam: [],
		});
		onBeforeRecoveryUpdateHook = () => {
			onBeforeRecoveryUpdateHook = () => {
				snapBackingStore.setRawForTest(lockRecKey, {
					version: PLAYER_DATA_SCHEMA_VERSION,
					pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
					tinyes: -333,
					inventory: "CORRUPTED_RACE",
					activeTeam: [],
					sessionLock: {
						serverId: "Server_RacedLock",
						timestamp: simulatedNow,
					},
				});
			};
		};
		kickedReasons.delete(lockRecPlayer);
		const lockedCorruptLoadB = snapService.loadPlayer(lockRecPlayer);
		onBeforeRecoveryUpdateHook = undefined;
		const rawAfterLockedB = snapBackingStore.peekRaw(lockRecKey) as Record<string, unknown> | undefined;
		assertInvariant(
			!lockedCorruptLoadB.ok &&
				lockedCorruptLoadB.status === "LOCKED" &&
				kickedReasons.get(lockRecPlayer) === SESSION_LOCK_KICK_MESSAGE &&
				!snapService.isSessionLoaded(lockRecPlayer) &&
				rawAfterLockedB !== undefined &&
				(rawAfterLockedB.sessionLock as { serverId: string }).serverId === "Server_RacedLock",
			"transform de recuperação deve verificar o lock atual e abortar se outro servidor assumiu o lock concorrentemente",
		);

		// 9.7. Proteção contra snapshot antigo sobrescrevendo dados mais recentes
		const stalePlayer = { Parent: Players, Name: "StaleSnapshotPlayer", UserId: 777044 } as unknown as Player;
		assertInvariant(snapService.loadPlayer(stalePlayer).ok, "deve carregar stalePlayer");
		const staleKey = snapService.getPlayerKey(777044);
		// Avança o tempo e faz uma alteração APENAS em memória (não confirmada no DataStore!) em t = simulatedNow + 100
		// Enquanto isso, o DataStore recebeu uma gravação em t = simulatedNow + 50 (> timestamp persistido do snapshot)
		const newerStoreTimestamp = simulatedNow + 50;
		simulatedNow += 100;
		snapService.addTinyes(stalePlayer, 50); // Em memória em t+100, mas lastPersistedTimestamp continua em t+0!
		snapBackingStore.setRawForTest(staleKey, {
			version: PLAYER_DATA_SCHEMA_VERSION,
			pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
			tinyes: -999,
			inventory: "NEWER_CORRUPTED_RECORD",
			activeTeam: [],
			sessionLock: {
				serverId: "Server_SnapTest",
				timestamp: newerStoreTimestamp,
			},
		});
		kickedReasons.delete(stalePlayer);
		const staleLoad = snapService.loadPlayer(stalePlayer);
		const rawAfterStaleLoad = snapBackingStore.peekRaw(staleKey) as Record<string, unknown> | undefined;
		assertInvariant(
			!staleLoad.ok &&
				staleLoad.status === "CORRUPTED" &&
				kickedReasons.has(stalePlayer) &&
				!snapService.isSessionLoaded(stalePlayer) &&
				rawAfterStaleLoad !== undefined &&
				rawAfterStaleLoad.inventory === "NEWER_CORRUPTED_RECORD",
			"snapshot antigo (mesmo com alteração em memória não persistida posterior) nunca pode sobrescrever dados com timestamp persistido mais recente no DataStore",
		);
	}

	// 10. Testes cirúrgicos de fallback exclusivo no Studio, preservação de sessão em erro passageiro e autosave isolado
	{
		// 10.a. GetDataStore() falha em produção (RunService:IsStudio() === false):
		// sem fallback, NETWORK_ERROR, jogador expulso, nenhuma conta nova criada.
		const prodKickReasons = new Map<Player, string>();
		const prodWarnings: string[] = [];
		const prodPrints: string[] = [];
		const prodProgression = new ProgressionService();
		const prodService = new PlayerDataService(prodProgression, {
			isStudioFn: () => false,
			getDataStoreFn: () => {
				error("GetDataStoreFailedInProd: DataStoreService internal error");
			},
			serverId: "Server_ProdNoFallback",
			now: () => simulatedNow,
			waitFn: () => {},
			kickPlayer: (player, msg) => prodKickReasons.set(player, msg),
			warnFn: (msg) => prodWarnings.push(msg),
			printFn: (msg) => prodPrints.push(msg),
		});
		const prodPlayer = { Parent: Players, Name: "ProdFailedGetDataStorePlayer", UserId: 777050 } as unknown as Player;
		const prodLoadRes = prodService.loadPlayer(prodPlayer);
		assertInvariant(
			!prodService.isUsingMemoryFallback() &&
				!prodLoadRes.ok &&
				prodLoadRes.status === "NETWORK_ERROR" &&
				prodLoadRes.data === undefined &&
				prodKickReasons.has(prodPlayer) &&
				!prodService.isSessionLoaded(prodPlayer) &&
				prodProgression.getPlayerData(prodPlayer) === undefined &&
				!prodService.hasLastValidSnapshot(777050) &&
				!prodPrints.includes("FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS") &&
				!prodWarnings.includes("FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS"),
			"Teste a: GetDataStore() falhando em produção não pode ativar fallbackStore, deve retornar NETWORK_ERROR, expulsar o jogador e não criar conta nova",
		);

		// 10.b. GetDataStore() falha no Studio (RunService:IsStudio() === true):
		// fallback ativa com aviso em print e warn ("FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS").
		const studioWarnings: string[] = [];
		const studioPrints: string[] = [];
		const studioProg = new ProgressionService();
		const studioGetStoreService = new PlayerDataService(studioProg, {
			isStudioFn: () => true,
			getDataStoreFn: () => {
				error("403: Cannot access DataStore from unconfigured Studio");
			},
			serverId: "Server_StudioGetDataStoreFail",
			now: () => simulatedNow,
			waitFn: () => {},
			kickPlayer: (player, msg) => prodKickReasons.set(player, msg),
			warnFn: (msg) => studioWarnings.push(msg),
			printFn: (msg) => studioPrints.push(msg),
		});
		const studioGetStorePlayer = { Parent: Players, Name: "StudioGetDataStorePlayer", UserId: 777051 } as unknown as Player;
		const studioGetStoreLoad = studioGetStoreService.loadPlayer(studioGetStorePlayer);
		assertInvariant(
			studioGetStoreService.isUsingMemoryFallback() &&
				studioPrints.includes("FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS") &&
				studioWarnings.includes("FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS") &&
				studioGetStoreLoad.ok &&
				studioGetStoreLoad.status === "FALLBACK_MEMORY" &&
				studioGetStoreLoad.data !== undefined &&
				studioGetStoreLoad.data.inventory.size() === 1 &&
				studioGetStoreService.isSessionLoaded(studioGetStorePlayer),
			"Teste b: GetDataStore() falhando no Studio deve ativar fallback em memória imprimindo aviso em print e warn",
		);
		studioGetStoreService.handlePlayerRemoving(studioGetStorePlayer);

		// 10.c. Erro passageiro depois de um load bem-sucedido:
		// sessão já carregada em memória é preservada (mesmos tinyes, inventário e itemUuid), sem criar conta nova nem trocar por dados padrão.
		let transientFailActive = false;
		const transientBackingStore = new InMemoryDataStore();
		const transientStore: DataStoreLike = {
			UpdateAsync(key, transform) {
				if (transientFailActive) {
					error("HTTP 502 Bad Gateway: temporary network failure");
				}
				return transientBackingStore.UpdateAsync(key, transform);
			},
			SetAsync(key, value) {
				if (transientFailActive) {
					error("HTTP 502 Bad Gateway: temporary network failure");
				}
				return transientBackingStore.SetAsync(key, value);
			},
		};
		const transientKicks = new Map<Player, string>();
		const transientProg = new ProgressionService();
		const transientService = new PlayerDataService(transientProg, {
			dataStore: transientStore,
			isStudioFn: () => false,
			serverId: "Server_TransientAfterLoad",
			now: () => simulatedNow,
			waitFn: () => {},
			kickPlayer: (player, msg) => transientKicks.set(player, msg),
			warnFn: () => {},
		});
		const transientPlayer = { Parent: Players, Name: "TransientReloadPlayer", UserId: 777052 } as unknown as Player;
		const firstTransientLoad = transientService.loadPlayer(transientPlayer);
		assertInvariant(
			firstTransientLoad.ok &&
				firstTransientLoad.status === "LOADED" &&
				firstTransientLoad.data !== undefined,
			"primeiro load antes do erro passageiro deve ter sucesso",
		);
		const preservedStarterUuid = firstTransientLoad.data!.inventory[0].itemUuid;
		transientService.addTinyes(transientPlayer, 777);
		transientProg.addXp(transientPlayer, preservedStarterUuid, calcXpForNextLevel(1) + 40);
		assertInvariant(
			transientProg.allocatePoints(transientPlayer, preservedStarterUuid, "atk", 2),
			"deve alocar pontos na sessão antes do erro passageiro",
		);

		// Dispara um segundo loadPlayer durante falha temporária de conexão (502):
		transientFailActive = true;
		const secondTransientLoad = transientService.loadPlayer(transientPlayer);
		transientFailActive = false;
		const sessionFighterAfterTransient = transientProg.getFighter(transientPlayer, preservedStarterUuid);
		assertInvariant(
			!secondTransientLoad.ok &&
				secondTransientLoad.status === "NETWORK_ERROR" &&
				!transientService.isUsingMemoryFallback() &&
				!transientKicks.has(transientPlayer) &&
				transientService.isSessionLoaded(transientPlayer) &&
				transientService.getTinyes(transientPlayer) === INITIAL_TINYES + 777 &&
				sessionFighterAfterTransient !== undefined &&
				sessionFighterAfterTransient.itemUuid === preservedStarterUuid &&
				sessionFighterAfterTransient.level === 2 &&
				sessionFighterAfterTransient.allocatedStats.atk === 2 &&
				(transientProg.getPlayerData(transientPlayer)?.inventory.size() ?? 0) === 1,
			"Teste c: erro passageiro após load bem-sucedido deve preservar integralmente a sessão em memória sem criar conta nova nem expulsar/resetar o jogador",
		);
		// Quando a conexão normaliza, o save persiste a sessão preservada normalmente
		const saveAfterTransient = transientService.handlePlayerRemoving(transientPlayer);
		const rawSavedAfterTransient = transientBackingStore.peekRaw(
			transientService.getPlayerKey(777052),
		) as PlayerSaveData;
		assertInvariant(
			saveAfterTransient.ok &&
				rawSavedAfterTransient !== undefined &&
				rawSavedAfterTransient.tinyes === INITIAL_TINYES + 777 &&
				rawSavedAfterTransient.inventory.size() === 1 &&
				rawSavedAfterTransient.inventory[0].itemUuid === preservedStarterUuid &&
				rawSavedAfterTransient.inventory[0].level === 2 &&
				rawSavedAfterTransient.inventory[0].allocatedStats.atk === 2,
			"Teste c: após erro passageiro, a sessão preservada deve salvar normalmente seus dados reais no DataStore",
		);

		// 10.d. Exceção no autosave de um jogador: os demais salvam normalmente; erro registrado com userId e key; sessão e retry preservados.
		const isolatedBackingStore = new InMemoryDataStore();
		const isolatedWarnings: string[] = [];
		let throwOnPlayer2Autosave = false;
		const isolatedStore: DataStoreLike = {
			UpdateAsync(key, transform) {
				return isolatedBackingStore.UpdateAsync(key, transform);
			},
			SetAsync(key, value) {
				return isolatedBackingStore.SetAsync(key, value);
			},
		};
		const isoPlayer1 = { Parent: Players, Name: "IsoAutosaveP1", UserId: 777061 } as unknown as Player;
		const isoPlayer2 = { Parent: Players, Name: "IsoAutosaveP2", UserId: 777062 } as unknown as Player;
		const isoPlayer3 = { Parent: Players, Name: "IsoAutosaveP3", UserId: 777063 } as unknown as Player;
		const isoProg = new ProgressionService();
		const isoService = new PlayerDataService(isoProg, {
			dataStore: isolatedStore,
			isStudioFn: () => false,
			serverId: "Server_IsolatedAutosave",
			now: () => simulatedNow,
			waitFn: () => {},
			warnFn: (msg) => isolatedWarnings.push(msg),
		});

		assertInvariant(
			isoService.loadPlayer(isoPlayer1).ok &&
				isoService.loadPlayer(isoPlayer2).ok &&
				isoService.loadPlayer(isoPlayer3).ok,
			"deve carregar os 3 jogadores para teste de autosave isolado",
		);
		isoService.addTinyes(isoPlayer1, 111);
		isoService.addTinyes(isoPlayer2, 222);
		isoService.addTinyes(isoPlayer3, 333);

		// Injeta uma exceção síncrona em savePlayer apenas quando salvar isoPlayer2 (antes do UpdateAsync, simulando exceção inesperada no save daquele jogador)
		const originalSavePlayer = isoService.savePlayer as unknown as (
			svc: PlayerDataService,
			p: Player,
			r?: boolean,
		) => unknown;
		(isoService as unknown as { savePlayer: (svc: PlayerDataService, p: Player, r?: boolean) => unknown }).savePlayer =
			(svc: PlayerDataService, p: Player, r = false) => {
				if (p === isoPlayer2 && throwOnPlayer2Autosave) {
					error("SimulatedPlayer2AutosaveCrash: unexpected exception for player 2");
				}
				return originalSavePlayer(svc, p, r);
			};

		isolatedWarnings.clear();
		simulatedNow += 30;
		throwOnPlayer2Autosave = true;
		isoService.autosaveAllPlayers();
		throwOnPlayer2Autosave = false;

		const rawIso1 = isolatedBackingStore.peekRaw(isoService.getPlayerKey(777061)) as PlayerSaveData;
		const rawIso2BeforeRetry = isolatedBackingStore.peekRaw(isoService.getPlayerKey(777062)) as PlayerSaveData;
		const rawIso3 = isolatedBackingStore.peekRaw(isoService.getPlayerKey(777063)) as PlayerSaveData;
		const keyP2 = isoService.getPlayerKey(777062);
		const loggedUserIdAndKey = isolatedWarnings.some(
			(w) => w.find("777062")[0] !== undefined && w.find(keyP2)[0] !== undefined,
		);
		assertInvariant(
			rawIso1 !== undefined &&
				rawIso1.tinyes === INITIAL_TINYES + 111 &&
				rawIso3 !== undefined &&
				rawIso3.tinyes === INITIAL_TINYES + 333 &&
				rawIso2BeforeRetry !== undefined &&
				rawIso2BeforeRetry.tinyes === INITIAL_TINYES &&
				loggedUserIdAndKey &&
				isoService.isSessionLoaded(isoPlayer2) &&
				isoService.getTinyes(isoPlayer2) === INITIAL_TINYES + 222 &&
				isoService.hasPendingRetrySave(isoPlayer2),
			"Teste d: exceção no autosave de isoPlayer2 não pode interromper o autosave de isoPlayer1 e isoPlayer3, deve registrar aviso com userId e key, e preservar sessão e retry de isoPlayer2",
		);

		// No próximo ciclo de autosave (sem a exceção), isoPlayer2 salva seu estado final real (222 Tinyes)
		simulatedNow += 30;
		isoService.autosaveAllPlayers();
		const rawIso2AfterRetry = isolatedBackingStore.peekRaw(isoService.getPlayerKey(777062)) as PlayerSaveData;
		assertInvariant(
			rawIso2AfterRetry !== undefined &&
				rawIso2AfterRetry.tinyes === INITIAL_TINYES + 222 &&
				!isoService.hasPendingRetrySave(isoPlayer2),
			"Teste d: no ciclo seguinte de autosave, o jogador que sofreu exceção deve persistir seu estado final (222 Tinyes) e limpar o retry pendente",
		);

		isoService.handlePlayerRemoving(isoPlayer1);
		isoService.handlePlayerRemoving(isoPlayer2);
		isoService.handlePlayerRemoving(isoPlayer3);
	}
}


function assertStoredEqual(actual: unknown, expected: unknown, message: string): void {
	if (typeOf(actual) !== "table" || typeOf(expected) !== "table") {
		assertInvariant(actual === expected, message);
		return;
	}
	const a = actual as Record<string, unknown>;
	const b = expected as Record<string, unknown>;
	for (const [key, value] of pairs(a)) assertStoredEqual(value, b[key as string], message);
	for (const [key] of pairs(b)) assertInvariant(a[key as string] !== undefined, message);
}

function validateSessionTokensAndConfirmations(): void {
	const backing = new InMemoryDataStore();
	let beforeUpdate: (() => void) | undefined;
	let afterUpdate: (() => void) | undefined;
	let suppressResult = false;
	let mismatchedResult = false;
	let updates = 0;
	const store: DataStoreLike = {
		UpdateAsync(key, transform) {
			updates += 1;
			const before = beforeUpdate;
			beforeUpdate = undefined;
			before?.();
			const result = backing.UpdateAsync(key, transform);
			const after = afterUpdate;
			afterUpdate = undefined;
			after?.();
			if (suppressResult) return undefined;
			if (mismatchedResult && result !== undefined) return { ...(result as PlayerSaveData), tinyes: 1 };
			return result;
		},
		SetAsync(key, value) { return backing.SetAsync(key, value); },
	};
	let now = 1000;
	const makeService = (serverId = "TokenServer") => new PlayerDataService(new ProgressionService(), {
		dataStore: store, serverId, now: () => now, waitFn: () => {},
		warnFn: () => {}, kickPlayer: () => {}, lockWaitAttempts: 0,
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	const service = makeService();
	const player = { Parent: Players, Name: "TokenPlayer", UserId: 889001 } as unknown as Player;
	const key = service.getPlayerKey(player.UserId);
	beforeUpdate = () => {
		const count = updates;
		const second = service.loadPlayer(player);
		const alias = service.loadPlayer({ Parent: Players, Name: "Alias", UserId: player.UserId } as unknown as Player);
		assertInvariant(!second.ok && !alias.ok && updates === count, "loads simultâneos devem ser recusados antes do DataStore");
	};
	const load = service.loadPlayer(player);
	assertInvariant(load.ok && load.data?.sessionLock?.sessionId !== undefined && updates === 1, "load deve adquirir uma única sessão com token");
	assertStoredEqual(service.getLastPersistedSnapshot(player.UserId), backing.peekRaw(key), "load deve confirmar payload exato");

	// Mesmo servidor, outra sessão: save e release jamais alteram dados/lock.
	for (const release of [false, true]) {
		const owner = makeService();
		const p = { Parent: Players, Name: "Stale", UserId: release ? 889003 : 889002 } as unknown as Player;
		assertInvariant(owner.loadPlayer(p).ok, "carregar sessão antiga");
		const k = owner.getPlayerKey(p.UserId);
		const raw = backing.peekRaw(k) as PlayerSaveData;
		const replacement = { ...raw, tinyes: raw.tinyes + 7,
			sessionLock: { serverId: "TokenServer", sessionId: "newer-session", timestamp: now } };
		backing.setRawForTest(k, replacement);
		owner.addTinyes(p, 999);
		const denied = owner.savePlayer(p, release);
		assertInvariant(!denied.ok && denied.status === "LOCKED_BY_OTHER" && !owner.isSessionLoaded(p), "token errado deve negar save/release");
		assertStoredEqual(backing.peekRaw(k), replacement, "sessão antiga não pode alterar payload nem lock novo");
	}
	const rival = makeService("OtherServer");
	const sameServerRival = makeService();
	const lockedRaw = backing.peekRaw(key);
	assertInvariant(!rival.loadPlayer(player).ok && !sameServerRival.loadPlayer(player).ok, "lock ativo deve bloquear outro servidor e outra sessão");
	assertStoredEqual(backing.peekRaw(key), lockedRaw, "aquisição negada deve preservar registro completo");

	const legacyPlayer = { Parent: Players, Name: "Legacy", UserId: 889004 } as unknown as Player;
	const legacyKey = service.getPlayerKey(legacyPlayer.UserId);
	const legacy = { ...(load.data!), sessionLock: { serverId: "ForeignLegacy", timestamp: now } };
	backing.setRawForTest(legacyKey, legacy);
	assertInvariant(!service.loadPlayer(legacyPlayer).ok, "legacy de outro servidor ativo deve ser recusado");
	assertStoredEqual(backing.peekRaw(legacyKey), legacy, "legacy ativo preservado");
	now += SESSION_LOCK_EXPIRATION_SECONDS + 1;
	assertInvariant(service.loadPlayer(legacyPlayer).ok, "legacy expirado pode ser adquirido");
	const acquired = backing.peekRaw(legacyKey) as PlayerSaveData;
	assertInvariant(acquired.sessionLock?.serverId === "TokenServer" && acquired.sessionLock.sessionId !== undefined, "legacy adquirido ganha token");
	assertInvariant(acquired.tinyes === legacy.tinyes && acquired.inventory[0].itemUuid === legacy.inventory[0].itemUuid, "legacy preserva dados");
	assertInvariant(service.savePlayer(legacyPlayer, true).ok && (backing.peekRaw(legacyKey) as PlayerSaveData).sessionLock === undefined, "release correto remove lock");

	service.addTinyes(player, 10);
	afterUpdate = () => { service.addTinyes(player, 20); };
	assertInvariant(service.savePlayer(player).ok, "save confirma candidato anterior à mutação");
	const committed = backing.peekRaw(key) as PlayerSaveData;
	assertInvariant(committed.tinyes === INITIAL_TINYES + 10 &&
		service.getTinyes(player) === INITIAL_TINYES + 30 &&
		!service.isLastValidSnapshotPersisted(player.UserId), "mutação durante save permanece não persistida");
	assertStoredEqual(service.getLastPersistedSnapshot(player.UserId), committed, "lastPersistedData deve ser exatamente o retorno confirmado");
	assertInvariant(service.savePlayer(player).ok && service.isLastValidSnapshotPersisted(player.UserId), "save seguinte confirma mutação pendente");
	const confirmed = service.getLastPersistedSnapshot(player.UserId);
	for (const mismatch of [false, true]) {
		service.addTinyes(player, 1);
		suppressResult = !mismatch;
		mismatchedResult = mismatch;
		const result = service.savePlayer(player);
		assertInvariant(!result.ok && service.hasPendingRetrySave(player) &&
			!service.isLastValidSnapshotPersisted(player.UserId), "retorno nil/divergente não confirma save");
		assertStoredEqual(service.getLastPersistedSnapshot(player.UserId), confirmed, "retorno não confirmado mantém último payload");
		suppressResult = false;
		mismatchedResult = false;
	}
	assertInvariant(service.savePlayer(player).ok, "retry confirma estado final");
	assertStoredEqual(service.getLastPersistedSnapshot(player.UserId), backing.peekRaw(key), "retry confirma payload e lock finais");

	// Falha após transformação e nova posse antes do retry: revalidar token em cada tentativa.
	const retryPlayer = { Parent: Players, Name: "TokenRetry", UserId: 889005 } as unknown as Player;
	const retryService = makeService();
	assertInvariant(retryService.loadPlayer(retryPlayer).ok, "carregar sessão para retry com troca de token");
	const retryKey = retryService.getPlayerKey(retryPlayer.UserId);
	const retryRaw = backing.peekRaw(retryKey) as PlayerSaveData;
	const newOwner = { ...retryRaw, sessionLock: { serverId: "TokenServer", sessionId: "retry-new-owner", timestamp: now } };
	beforeUpdate = () => {
		backing.setRawForTest(retryKey, newOwner);
		error("Injected network failure before retry");
	};
	const retryDenied = retryService.savePlayer(retryPlayer, true);
	assertInvariant(!retryDenied.ok && retryDenied.status === "LOCKED_BY_OTHER", "retry de release deve verificar token novamente");
	assertStoredEqual(backing.peekRaw(retryKey), newOwner, "retry não pode liberar lock novo");

	// Alterações de inventário também devem invalidar persisted, mesmo sem addTinyes.
	const progression = new ProgressionService();
	const inventoryService = new PlayerDataService(progression, {
		dataStore: store, serverId: "InventoryToken", now: () => now,
		waitFn: () => {}, warnFn: () => {}, kickPlayer: () => {},
	});
	const inventoryPlayer = { Parent: Players, Name: "InventoryToken", UserId: 889006 } as unknown as Player;
	const inventoryLoad = inventoryService.loadPlayer(inventoryPlayer);
	assertInvariant(inventoryLoad.ok && inventoryLoad.data !== undefined, "carregar inventário");
	const uuid = inventoryLoad.data!.inventory[0].itemUuid;
	progression.addXp(inventoryPlayer, uuid, 1);
	assertInvariant(!inventoryService.isLastValidSnapshotPersisted(inventoryPlayer.UserId), "XP em memória invalida persisted");
	afterUpdate = () => { progression.addXp(inventoryPlayer, uuid, 2); };
	assertInvariant(inventoryService.savePlayer(inventoryPlayer).ok &&
		!inventoryService.isLastValidSnapshotPersisted(inventoryPlayer.UserId), "XP durante save permanece não confirmado");
	assertStoredEqual(inventoryService.getLastPersistedSnapshot(inventoryPlayer.UserId),
		backing.peekRaw(inventoryService.getPlayerKey(inventoryPlayer.UserId)), "payload confirmado mantém XP anterior");
	assertInvariant(inventoryService.savePlayer(inventoryPlayer, true).ok, "salvar XP final e liberar");
	const finalInventory = backing.peekRaw(inventoryService.getPlayerKey(inventoryPlayer.UserId)) as PlayerSaveData;
	assertInvariant(finalInventory.inventory[0].xp === 3 && finalInventory.sessionLock === undefined, "validar XP final e lock");

	// Recuperação usa o último payload confirmado, não a alteração apenas em memória.
	const beforeCorruption = backing.peekRaw(key) as PlayerSaveData;
	service.addTinyes(player, 500);
	backing.setRawForTest(key, { ...beforeCorruption, tinyes: -1 });
	const recovered = service.loadPlayer(player);
	assertInvariant(recovered.ok && recovered.status === "RECOVERED_LAST_VALID" &&
		recovered.data?.tinyes === beforeCorruption.tinyes, "recuperação distingue dado confirmado de mutação em memória");
	assertStoredEqual(service.getLastPersistedSnapshot(player.UserId), backing.peekRaw(key), "recuperação confirma payload final exato");
	assertInvariant(service.savePlayer(player, true).ok &&
		(backing.peekRaw(key) as PlayerSaveData).sessionLock === undefined, "release final preserva dados e remove lock");
}

function findBackupKey(store: InMemoryDataStore, timestamp: number, previousKeys: ReadonlySet<string>): string {
	const prefix = `C_${timestamp}_`;
	const keys = store.getKeysForTest().filter((key) => key.sub(1, prefix.size()) === prefix && !previousKeys.has(key));
	assertInvariant(keys.size() === 1, "deve existir exatamente um novo backup para este cenário");
	return keys[keys.size() - 1];
}

function validateCorruptionBackupAndInventory(): void {
	// Each failure starts with a confirmed snapshot, so refusal cannot pass merely
	// because recovery had no eligible snapshot.
	for (const mode of ["backup-fails", "no-set", "nil-result", "wrong-result", "changed", "new-token", "newer", "valid-race", "collision", "success"]) {
		const backing = new InMemoryDataStore();
		const backups: string[] = [];
		const warnings: string[] = [];
		let corrupting = false;
		let mainWrites = 0;
		let collidedKey: string | undefined;
		let collisionValue: unknown;
		let racedValue: unknown;
		let key = "";
		const store: DataStoreLike = {
			UpdateAsync(k, transform) {
				if (k.sub(1, 2) === "C_") {
					assertInvariant(k.size() <= 50, "backup deve caber no limite de chave Roblox");
					if (mode === "collision") {
						collidedKey = k;
						collisionValue = { previousBackup: "must-survive" };
						backing.setRawForTest(k, collisionValue);
					}
					return backing.UpdateAsync(k, transform);
				}
				if (corrupting && backups.size() > 0 && racedValue === undefined) {
					const raw = backing.peekRaw(k) as PlayerSaveData;
					if (mode === "changed") racedValue = { ...raw, tinyes: -999 };
					if (mode === "new-token") racedValue = { ...raw, sessionLock: { serverId: "Surgical", sessionId: "rival", timestamp: 1000 } };
					if (mode === "newer") racedValue = { ...raw, updatedAt: 1001 };
					if (mode === "valid-race") racedValue = { ...raw, tinyes: 333 };
					if (racedValue !== undefined) backing.setRawForTest(k, racedValue);
				}
				const result = backing.UpdateAsync(k, (raw) => {
					const replacement = transform(raw);
					if (corrupting && replacement !== undefined) {
						mainWrites += 1;
						assertInvariant(backups.size() > 0, "restauração exige backup concluído primeiro");
						assertStoredEqual(backing.peekRaw(backups[backups.size() - 1]), raw, "backup deve preservar exatamente o registro substituído");
					}
					return replacement;
				});
				if (corrupting && result !== undefined && mode === "nil-result") return undefined;
				if (corrupting && result !== undefined && mode === "wrong-result") return { ...(result as PlayerSaveData), tinyes: 1 };
				return result;
			},
			SetAsync(k, value) {
				if (mode === "backup-fails") error("Injected backup failure");
				backups.push(k);
				return backing.SetAsync(k, value);
			},
		};
		if (mode === "no-set") store.SetAsync = undefined;
		const service = new PlayerDataService(new ProgressionService(), {
			dataStore: store, serverId: "Surgical", now: () => 1000, maxRetries: 0,
			waitFn: () => {}, warnFn: (message) => warnings.push(message), kickPlayer: () => {},
			isStudioFn: () => false, disableStudioAutoFallbackOnInjectedStore: true,
		});
		const player = { Parent: Players, Name: "Surgical", UserId: 990001 } as unknown as Player;
		key = service.getPlayerKey(player.UserId);
		const initial = service.loadPlayer(player);
		assertInvariant(initial.ok && initial.data !== undefined, "fixture deve ter snapshot confirmado");
		const raw = { ...initial.data!, tinyes: -123 };
		backing.setRawForTest(key, raw);
		corrupting = true;
		const result = service.loadPlayer(player);
		if (mode === "success") {
			assertInvariant(result.ok && result.status === "RECOVERED_LAST_VALID", "recuperação confirmada deve carregar");
			assertStoredEqual(backing.peekRaw(key), initial.data, "restauração deve preservar conteúdo e lock reais");
			assertStoredEqual(backing.peekRaw(backups[0]), raw, "backup bruto preservado");
			const secondRaw = { ...initial.data!, tinyes: -456 };
			backing.setRawForTest(key, secondRaw);
			const second = service.loadPlayer(player);
			assertInvariant(second.ok && backups.size() === 2 && backups[0] !== backups[1], "duas corrupções no mesmo segundo exigem chaves distintas");
			assertStoredEqual(backing.peekRaw(backups[0]), raw, "primeiro backup não pode ser sobrescrito");
			assertStoredEqual(backing.peekRaw(backups[1]), secondRaw, "segundo backup deve preservar segunda corrupção");
			assertStoredEqual(second.data, backing.peekRaw(key), "RECOVERED_LAST_VALID deve conter restauração confirmada");
		} else {
			assertInvariant(!result.ok && result.status !== "RECOVERED_LAST_VALID" && !service.isSessionLoaded(player), `${mode}: não pode anunciar recuperação nem carregar sessão`);
			if (mode === "nil-result" || mode === "wrong-result") {
				assertStoredEqual(backing.peekRaw(key), initial.data, "escrita real sem retorno confiável não é confirmação");
			} else {
				assertInvariant(mainWrites === 0, `${mode}: nenhuma substituição permitida`);
				assertStoredEqual(backing.peekRaw(key), racedValue ?? raw, `${mode}: preservar registro principal integralmente`);
			}
			if (collidedKey !== undefined) assertStoredEqual(backing.peekRaw(collidedKey), collisionValue, "colisão nunca sobrescreve backup existente");
		}
	}

	const seedStore = new InMemoryDataStore();
	const seedService = new PlayerDataService(new ProgressionService(), { dataStore: seedStore, serverId: "Seed", now: () => 1000 });
	const seed = seedService.loadPlayer({ Parent: Players, Name: "Seed", UserId: 990002 } as unknown as Player).data!;
	for (const mode of ["unknown", "hole", "invalid", "extra", "duplicate", "duo", "duo-negative", "duo-nan", "duo-legacy", "duo-invalid", "legacy", "infinite", "huge", "mult"]) {
		const backing = new InMemoryDataStore();
		const warnings: string[] = [];
		const progression = new ProgressionService();
		const service = new PlayerDataService(progression, {
			dataStore: backing, serverId: "Validation", now: () => 1000, waitFn: () => {},
			warnFn: (message) => warnings.push(message), kickPlayer: () => {}, isStudioFn: () => false,
		});
		const player = { Parent: Players, Name: "Validation", UserId: 990003 } as unknown as Player;
		const key = service.getPlayerKey(player.UserId);
		const item = seed.inventory[0];
		let inventory: unknown = [item];
		if (mode === "unknown") inventory = [{ ...item, fighterId: "removed-from-catalog" }];
		if (mode === "hole") { const sparse: unknown[] = [item]; sparse[2] = { ...item, itemUuid: "second" }; inventory = sparse; }
		if (mode === "invalid") inventory = [item, false];
		if (mode === "extra") { const extra = [item] as unknown as Record<string, unknown>; extra.unexpected = item; inventory = extra; }
		if (mode === "duplicate") inventory = [item, item];
		if (mode === "duo") inventory = [{ ...item, duo: { partnerHp: 300, partnerHpMax: 20, activeMember: "invalid" } }];
		if (mode === "duo-negative") inventory = [{ ...item, duo: { partnerHp: -7, partnerHpMax: -10, activeMember: "Tarkus" } }];
		if (mode === "duo-nan") inventory = [{ ...item, duo: { partnerHp: 0 / 0, partnerHpMax: math.huge } }];
		if (mode === "duo-legacy") inventory = [{ ...item, duo: { partnerHp: 7, activeMember: "Tarkus" } }];
		if (mode === "duo-invalid") inventory = [{ ...item, duo: false }];
		if (mode === "infinite") inventory = [{ ...item, xp: math.huge }];
		if (mode === "huge") inventory = [{ ...item, baseStats: { ...item.baseStats, hp: 1e100 } }];
		if (mode === "mult") inventory = [{ ...item, skills: [{ ...item.skills[0], mult: 1e100 }, item.skills[1], item.skills[2]] }];
		const raw = mode === "legacy" ? { coins: 77, fighters: inventory }
			: { ...seed, sessionLock: undefined, inventory };
		backing.setRawForTest(key, raw);
		const result = service.loadPlayer(player);
		if (mode === "unknown" || mode.sub(1, 3) === "duo" || mode === "legacy") {
			assertInvariant(result.ok && result.data !== undefined, `${mode}: conta deve carregar`);
			const saved = backing.peekRaw(key) as PlayerSaveData;
			assertInvariant(saved.inventory.size() === 1 && saved.inventory[0].itemUuid === item.itemUuid, "preservar propriedade do item");
			assertStoredEqual(saved.inventory[0].skills, item.skills, "não rerrolar skills");
			if (mode === "unknown") {
				assertInvariant(saved.inventory[0].fighterId === "removed-from-catalog" && saved.inventory[0].unavailable === true &&
					progression.getPlayerData(player)?.inventory[0].unavailable === true && warnings.some((w) => w.find("desconhecido")[0] !== undefined), "item desconhecido preservado, marcado e registrado em disco e memória");
			}
			if (mode === "duo") assertInvariant(saved.inventory[0].duo?.partnerHp === 20 && saved.inventory[0].duo?.partnerHpMax === 20 && saved.inventory[0].duo?.activeMember === "Bruford" && warnings.some((w) => w.find("Duo normalizado")[0] !== undefined), "Duo inconsistente normalizado e registrado");
			if (mode.sub(1, 4) === "duo-") {
				const expectedHp = mode === "duo-legacy" ? 7 : 0;
				const expectedMember = mode === "duo-negative" || mode === "duo-legacy" ? "Tarkus" : "Bruford";
				assertInvariant(saved.inventory[0].duo?.partnerHp === expectedHp && saved.inventory[0].duo?.partnerHpMax === expectedHp && saved.inventory[0].duo?.activeMember === expectedMember && warnings.some((w) => w.find("Duo normalizado")[0] !== undefined), `${mode}: normalizar números inválidos/campos legados sem travar a conta`);
			}
			if (mode === "legacy") assertInvariant(saved.tinyes === 77 && saved.version === PLAYER_DATA_SCHEMA_VERSION && saved.inventory[0].unavailable === undefined, "save antigo migra sem exigir campos novos");
		} else {
			assertInvariant(!result.ok && result.status === "CORRUPTED" && warnings.size() > 0, `${mode}: corrupção deve ser detectada e registrada`);
			assertStoredEqual(backing.peekRaw(key), raw, `${mode}: não descartar silenciosamente elementos inválidos`);
		}
	}
	print("CORRUPTION_BACKUP_AND_INVENTORY_PASSED");
}

function validateLeavingDuringLoad(): void {
	for (const mode of ["during", "parent-only", "after", "failure"]) {
		const backing = new InMemoryDataStore();
		const progression = new ProgressionService();
		const mock = { Parent: Players as Players | undefined, Name: "LeavingLoad", UserId: 991001 };
		const player = mock as Player;
		let service!: PlayerDataService;
		let intercept = true;
		const store: DataStoreLike = {
			UpdateAsync(key, transform) {
				if (intercept) {
					intercept = false;
					if (mode === "failure") {
						service.handlePlayerRemoving(player);
						mock.Parent = undefined;
						error("load network failure before commit");
					}
					const result = backing.UpdateAsync(key, transform);
					if (mode === "during") {
						assertInvariant(service.handlePlayerRemoving(player).status === "NO_SESSION", "saida antes da sessao");
						// Parent ainda e Players durante PlayerRemoving: exercita o Set.
					} else if (mode === "parent-only") {
						mock.Parent = undefined;
					}
					return result;
				}
				return backing.UpdateAsync(key, transform);
			},
		};
		service = new PlayerDataService(progression, {
			dataStore: store, serverId: "LeavingLoadServer", maxRetries: 0,
			waitFn: () => {}, warnFn: () => {}, kickPlayer: () => {},
		});
		const key = service.getPlayerKey(player.UserId);
		const loaded = service.loadPlayer(player);
		assertInvariant(mode === "after" ? loaded.ok : !loaded.ok &&
			(mode === "failure" ? loaded.status === "NETWORK_ERROR" : loaded.status === "REMOVED_DURING_LOAD"), `${mode}: resultado do load`);
		if (mode === "after") {
			assertInvariant(service.isSessionLoaded(player), "sessao conectada existe");
			service.addTinyes(player, 37);
			mock.Parent = undefined;
			const before = backing.peekRaw(key);
			service.autosaveAllPlayers();
			assertStoredEqual(backing.peekRaw(key), before, "autosave ignora jogador ausente");
			assertInvariant(service.handlePlayerRemoving(player).ok, "saida normal salva");
		}
		assertInvariant(!service.isSessionLoaded(player) && progression.getPlayerData(player) === undefined &&
			!service.hasPendingRetrySave(player), `${mode}: nenhuma sessao ou retry orfao`);
		const stored = backing.peekRaw(key) as PlayerSaveData | undefined;
		if (mode === "failure") {
			assertInvariant(stored === undefined, "load falho nao cria registro nem lock");
		} else {
			assertInvariant(stored !== undefined && stored.sessionLock === undefined, `${mode}: lock removido no DataStore`);
			if (mode === "after") {
				const expected = { ...loaded.data!, sessionLock: undefined, tinyes: loaded.data!.tinyes + 37 };
				assertStoredEqual(stored, expected, `${mode}: dados finais preservados`);
			} else {
				assertInvariant(stored !== undefined && stored.inventory.size() === 1 && stored.tinyes === INITIAL_TINYES, `${mode}: dados finais preservados`);
			}
		}
		service.autosaveAllPlayers();
		assertStoredEqual(backing.peekRaw(key), stored, `${mode}: autosave nao recria lock`);
		// Reusar o mock comprova que a marca foi limpa inclusive no load falho.
		mock.Parent = Players;
		assertInvariant(service.loadPlayer(player).ok && service.isSessionLoaded(player), `${mode}: marca limpa permite novo load`);
		assertInvariant(service.handlePlayerRemoving(player).ok, `${mode}: limpeza final`);
		assertInvariant((backing.peekRaw(key) as PlayerSaveData).sessionLock === undefined, `${mode}: lock final liberado`);
	}
	print("LEAVING_DURING_LOAD_PASSED");
}

function validateLoadGuardsAndInvalidLock(): void {
	const backing = new InMemoryDataStore();
	const warnings: string[] = [];
	const kicked: Player[] = [];
	const player = { Parent: Players, Name: "Guarded", UserId: 991010 } as unknown as Player;
	let service!: PlayerDataService;
	let nested = false;
	const store: DataStoreLike = {
		UpdateAsync(key, transform) {
			if (!nested) {
				nested = true;
				const duplicate = service.loadPlayer(player);
				assertInvariant(!duplicate.ok && duplicate.status === "LOCKED", "load simultaneo recusado");
			}
			return backing.UpdateAsync(key, transform);
		},
	};
	service = new PlayerDataService(new ProgressionService(), { dataStore: store, serverId: "GuardedServer",
		now: () => 1000, waitFn: () => {}, warnFn: (message) => warnings.push(message),
		kickPlayer: (target) => kicked.push(target), lockWaitAttempts: 0 });
	assertInvariant(service.loadPlayer(player).ok && kicked.size() === 1, "primeiro retorno antecipado expulsa jogador");
	const alias = { Parent: Players, Name: "Alias", UserId: player.UserId } as unknown as Player;
	const aliasResult = service.loadPlayer(alias);
	assertInvariant(!aliasResult.ok && aliasResult.status === "LOCKED" && kicked.size() === 2 && kicked[1] === alias,
		"segundo retorno antecipado expulsa jogador");
	assertInvariant(service.handlePlayerRemoving(player).ok, "limpar sessao de guarda");
	const raw = backing.peekRaw(service.getPlayerKey(player.UserId)) as PlayerSaveData;
	backing.setRawForTest(service.getPlayerKey(player.UserId), {
		...raw, inventory: [], activeTeam: [], sessionLock: { serverId: "Foreign", timestamp: "broken" },
	});
	const loaded = service.loadPlayer(player);
	assertInvariant(loaded.ok && loaded.data?.sessionLock?.serverId === "GuardedServer" &&
		warnings.some((message) => message.find("sem timestamp válido")[0] !== undefined),
		`lock sem timestamp valido expira com aviso e permite load (ok=${loaded.ok}, status=${loaded.status}, avisos=${warnings.join(" | ")})`);
	assertInvariant(service.handlePlayerRemoving(player).ok &&
		(backing.peekRaw(service.getPlayerKey(player.UserId)) as PlayerSaveData).sessionLock === undefined,
		"estado final sem lock");
	print("LOAD_GUARDS_AND_INVALID_LOCK_PASSED");
}

function validateSetRetryShutdownBudget(): void {
	const waits: number[] = [];
	let attempts = 0;
	const service = new PlayerDataService(new ProgressionService(), {
		dataStore: { UpdateAsync() { return undefined; }, SetAsync() { attempts += 1; error("set unavailable"); } },
		serverId: "SetBudget", maxRetries: 4, retryBaseDelaySeconds: 10,
		waitFn: (seconds) => waits.push(seconds), warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	const internals = service as unknown as {
		shuttingDown: boolean; shutdownStartClock: number; shutdownDeadlineSeconds: number;
		executeSetWithRetry(key: string, value: unknown): { ok: boolean };
	};
	internals.shuttingDown = true;
	internals.shutdownStartClock = os.clock();
	internals.shutdownDeadlineSeconds = 3;
	const result = internals.executeSetWithRetry("backup", {});
	let waited = 0;
	for (const seconds of waits) waited += seconds;
	assertInvariant(!result.ok && attempts <= 3 && waits.size() <= 2 && waited <= 3,
		`SetAsync limita backoff ao prazo do BindToClose (tentativas=${attempts}, waits=${waits.size()}, primeiro=${waits[0]})`);
	print("SET_RETRY_SHUTDOWN_BUDGET_PASSED");
}

interface SurgicalAdapterHooks {
	readonly onBattleStarted?: (player: Player, payload: BattleStartedPayload) => void;
	readonly onBattleEnded?: (player: Player, payload: BattleEndedPayload) => void;
	readonly onEffectTick?: (player: Player) => void;
	readonly onAtbSync?: (player: Player) => void;
}

function createSurgicalMockAdapter(hooks: SurgicalAdapterHooks): BattleRemoteAdapter {
	return {
		bindRequests() {},
		forgetPlayer() {},
		sendBattleStarted(player, payload) {
			hooks.onBattleStarted?.(player, payload);
		},
		sendStateChanged() {},
		sendSwitchPerformed() {},
		sendAttackStarted() {},
		sendHitResolved() {},
		sendEffectApplied() {},
		sendEffectTick(player) {
			hooks.onEffectTick?.(player);
		},
		sendEffectExpired() {},
		sendFighterDied() {},
		sendBattleEnded(player, payload) {
			hooks.onBattleEnded?.(player, payload);
		},
		sendAtbSync(player) {
			hooks.onAtbSync?.(player);
		},
	};
}

interface RemoteServiceTestInternals {
	consumeRequest(player: Player): boolean;
	readSkillSlot(payload: unknown): SkillSlot | undefined;
}

/** End-of-session notifications cannot depend on rewards or optional cleanup succeeding. Studio mocks only. */
export function validateBattleTeardownLifecycle(): void {
	for (const outcome of ["pveWin", "pveLoss", "pveQuit", "pvpWin", "pvpQuit", "disconnect", "respawn",
		"error", "timeout", "startError", "rewardError", "xpError", "sendError", "cleanupError"] as const) {
		const makePlayer = (id: number) => {
			const humanoid = new Instance("Humanoid");
			humanoid.WalkSpeed = 23; humanoid.JumpPower = 61; humanoid.JumpHeight = 9;
			const removing = new Instance("BindableEvent");
			const attributes = new Map<string, AttributeValue>();
			const mock = { Parent: Players as Players | undefined, Name: `Teardown${id}`, UserId: id,
				CharacterRemoving: removing.Event,
				SetAttribute(name: string, value: AttributeValue): void { attributes.set(name, value); } };
			return { player: mock as unknown as Player, mock, humanoid, removing, attributes };
		};
		const a = makePlayer(993001); const b = makePlayer(993002);
		const pve = outcome === "pveWin" || outcome === "pveLoss" || outcome === "pveQuit";
		const participants = pve ? [a] : [a, b];
		const attempts: { player: Player; payload: BattleEndedPayload }[] = [];
		const adapter = createSurgicalMockAdapter({
			onBattleStarted: (player) => { if (outcome === "startError" && player === b.player) error("teardown start injection"); },
			onBattleEnded: (player, payload) => {
				attempts.push({ player, payload });
				if (outcome === "sendError" && player === a.player) error("teardown send injection");
			},
		});
		const tinyes = { awardPvpWin: () => {
			if (outcome === "rewardError") error("teardown reward injection");
			return { amount: 100 };
		}, getRemainingPvpXp: () => PVP_DAILY_XP_CAP, recordPvpXp: () => {}, syncBalance: () => {}, addTinyes: () => ({ ok: true }) } as unknown as TinyesService;
		const sessions = new BattleSessionService(adapter, tinyes);
		const rng = () => 0.5;
		const releases = participants.map(p => freezeBattleMovement(p.player, p.humanoid, () => sessions.destroySessionForPlayer(p.player)));
		let releaseCount = 0;
		const created = sessions.createSession(a.player, pve ? undefined : b.player, createDummySide(rng), createDummySide(rng), rng,
			pve ? "PVE" : "PVP", () => { releaseCount++; for (const release of releases) release(); });
		const internals = sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide];
			resolvedHits: number; disconnectors: (() => void)[]; aiControllers: AIService[] }[]; awardSessionXp(): void };
		if (outcome !== "startError") {
			assertInvariant(created && attempts.size() === 0 && releaseCount === 0, `${outcome}: no premature end`);
			for (const p of participants) assertInvariant(sessions.hasActiveSession(p.player) && p.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === true &&
				p.humanoid.WalkSpeed === 0, `${outcome}: battle remains active`);
			const record = internals.activeSessions[0];
			record.resolvedHits = 99;
			// Fixture da trava de dano; a contagem de dano real é exercitada nos testes PVP.
			for (const fighter of record.sides[0].fighters) (fighter as unknown as { itemUuid: string }).itemUuid = `teardown-${fighter.fighterId}`;
			record.battle.getDamageDealt = () => 100;
			if (outcome === "xpError") internals.awardSessionXp = () => error("teardown XP injection");
			if (outcome === "cleanupError") {
				record.aiControllers.push({ destroy: () => error("teardown AI injection") } as unknown as AIService);
				record.disconnectors.push(() => error("teardown connection injection"));
			}
			if (outcome === "pveQuit") sessions.requestQuit(a.player);
			else if (outcome === "pvpQuit" || outcome === "rewardError" || outcome === "xpError") sessions.requestQuit(b.player);
			else if (outcome === "disconnect") { b.mock.Parent = undefined; sessions.destroySessionForPlayer(b.player); }
			else if (outcome === "respawn") { b.removing.Fire(); task.wait(); }
			else if (outcome === "error") { record.battle.step = () => error("teardown step injection"); sessions.step(0.1); }
			else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
			else { record.battle.events.battleEnd.fire(record.sides[outcome === "pveLoss" ? 1 : 0]); sessions.step(0); }
		}
		for (const p of participants) {
			const events = attempts.filter(event => event.player === p.player);
			assertInvariant(events.size() === (p.mock.Parent === Players ? 1 : 0), `${outcome}: every connected participant notified exactly once`);
			assertInvariant(!sessions.hasActiveSession(p.player) && p.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false,
				`${outcome}: no session and NpcBattleActive false`);
			assertInvariant(p.humanoid.WalkSpeed === 23 && p.humanoid.JumpPower === 61 && p.humanoid.JumpHeight === 9,
				`${outcome}: movement restored`);
			if (outcome === "error" || outcome === "timeout" || outcome === "startError") assertInvariant(events[0].payload.winnerSideId === undefined &&
				events[0].payload.xpRewards === undefined, `${outcome}: no winner or XP`);
			p.humanoid.Destroy(); p.removing.Destroy();
		}
		assertInvariant(releaseCount === 1 && internals.activeSessions.size() === 0, `${outcome}: cleanup once`);
	}
	print("BATTLE_TEARDOWN_LIFECYCLE_PASSED");
}

/** Item 1: createSession recusa jogador fora de Players (primeiro ou segundo). */
function validateCreateSessionRequiresPlayersParent(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	const startedEvents: { player: Player; payload: BattleStartedPayload }[] = [];
	const sessionService = new BattleSessionService(
		createSurgicalMockAdapter({ onBattleStarted: (player, payload) => startedEvents.push({ player, payload }) }),
	);
	const insidePlayer = { Parent: Players, Name: "InsidePlayer" } as unknown as Player;
	const outsidePlayer = { Name: "OutsidePlayer" } as unknown as Player;

	assertInvariant(
		!sessionService.createSession(outsidePlayer, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
		"createSession deve recusar primeiro jogador fora de Players",
	);
	assertInvariant(
		!sessionService.createSession(insidePlayer, outsidePlayer, createDummySide(rng), createDummySide(rng), rng, "PVP"),
		"createSession deve recusar segundo jogador fora de Players",
	);
	assertInvariant(
		!sessionService.hasActiveSession(outsidePlayer) && !sessionService.hasActiveSession(insidePlayer),
		"sessão recusada não pode registrar nenhum participante",
	);
	assertInvariant(startedEvents.size() === 0, "sessão recusada não pode emitir BattleStarted");

	// Controle: jogador em Players cria sessão; o id não foi consumido pelas recusas
	assertInvariant(
		sessionService.createSession(insidePlayer, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
		"createSession deve aceitar jogador em Players",
	);
	assertInvariant(
		startedEvents.size() === 1 && startedEvents[0].payload.sides[0] === "battle-0-A",
		"recusas não podem consumir id de sessão",
	);
	sessionService.requestQuit(insidePlayer);
	assertInvariant(!sessionService.hasActiveSession(insidePlayer), "sessão de controle deve ser limpa");
	print("SURGICAL_1_CREATE_SESSION_PLAYERS_PASSED");
}

/** Item 2: erro em uma sessão (step ou syncAtb) encerra só ela; as outras continuam avançando. */
function validateSessionErrorIsolation(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	const stepFailPlayer = { Parent: Players, Name: "StepFailPlayer" } as unknown as Player;
	const syncFailPlayer = { Parent: Players, Name: "SyncFailPlayer" } as unknown as Player;
	const healthyPlayer = { Parent: Players, Name: "HealthyPlayer" } as unknown as Player;
	const endedEvents: { player: Player; payload: BattleEndedPayload }[] = [];
	let healthySyncCount = 0;

	const sessionService = new BattleSessionService(
		createSurgicalMockAdapter({
			onBattleEnded: (player, payload) => endedEvents.push({ player, payload }),
			onEffectTick: (player) => {
				if (player === stepFailPlayer) error("falha simulada dentro do step");
			},
			onAtbSync: (player) => {
				if (player === syncFailPlayer) error("falha simulada dentro do syncAtb");
				if (player === healthyPlayer) healthySyncCount += 1;
			},
		}),
	);

	const stepFailSide = createDummySide(rng);
	stepFailSide.fighters[0].applyStatusEffect("Bleed", 1, 12); // tick em 1s dispara sendEffectTick dentro do step
	assertInvariant(
		sessionService.createSession(stepFailPlayer, undefined, stepFailSide, createDummySide(rng), rng, "PVE"),
		"deveria criar sessão que falha no step",
	);
	assertInvariant(
		sessionService.createSession(syncFailPlayer, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
		"deveria criar sessão que falha no syncAtb",
	);
	const healthySide = createDummySide(rng);
	assertInvariant(
		sessionService.createSession(healthyPlayer, undefined, healthySide, createDummySide(rng), rng, "PVE"),
		"deveria criar sessão saudável",
	);

	// 1º step: syncAtb da sessão syncFail lança erro (antes da sessão saudável no loop)
	sessionService.step(0.5);
	assertInvariant(!sessionService.hasActiveSession(syncFailPlayer), "sessão com erro em syncAtb deve ser destruída");
	assertInvariant(sessionService.hasActiveSession(stepFailPlayer), "sessão sem erro ainda deve estar ativa");
	assertInvariant(sessionService.hasActiveSession(healthyPlayer), "sessão saudável deve continuar ativa");
	const healthyAtbAfterFirstStep = healthySide.atb;
	const healthySyncsAfterFirstStep = healthySyncCount;
	assertInvariant(
		healthyAtbAfterFirstStep > ATB_MIN && healthySyncsAfterFirstStep > 0,
		"sessão saudável deve avançar ATB e sincronizar mesmo após erro de outra sessão",
	);

	// 2º step: tick de Bleed lança erro dentro do battle.step da sessão stepFail (primeira do loop)
	sessionService.step(0.6);
	assertInvariant(!sessionService.hasActiveSession(stepFailPlayer), "sessão com erro em step deve ser destruída");
	assertInvariant(sessionService.hasActiveSession(healthyPlayer), "sessão saudável deve continuar ativa");
	assertInvariant(
		healthySide.atb > healthyAtbAfterFirstStep && healthySyncCount > healthySyncsAfterFirstStep,
		"sessão saudável deve seguir avançando após erro em step de outra sessão",
	);

	let syncFailEnded = 0;
	let stepFailEnded = 0;
	let healthyEnded = 0;
	for (const event of endedEvents) {
		if (event.player === syncFailPlayer && event.payload.winnerSideId === undefined) syncFailEnded += 1;
		if (event.player === stepFailPlayer && event.payload.winnerSideId === undefined) stepFailEnded += 1;
		if (event.player === healthyPlayer) healthyEnded += 1;
	}
	assertInvariant(
		syncFailEnded === 1 && stepFailEnded === 1 && healthyEnded === 0,
		"sessões com erro devem receber BattleEnded sem vencedor exatamente uma vez; saudável nenhuma",
	);
	sessionService.requestQuit(healthyPlayer);
	assertInvariant(!sessionService.hasActiveSession(healthyPlayer), "sessão saudável deve ser limpa no fim");
	print("SURGICAL_2_SESSION_ERROR_ISOLATION_PASSED");
}

/** Item 3: RequestSkill aceita somente slots 1, 2 e 3. */
function validateSkillSlotValidation(): void {
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
function validateItemUuidLength(): void {
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
function validateTokenBucketRateLimit(): void {
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
function validateSideTriggersRestrictions(): void {
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
function validateTrocarIndexValidation(): void {
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

export function validateTinyesEconomy(): void {
	const mock = { Parent: Players as Players | undefined, Name: "TinyesTest", UserId: 991987 };
	const player = mock as Player;
	const data = new PlayerDataService(new ProgressionService(), { forceStudioFallback: true, serverId: "TinyesTest" });
	const notifications: number[] = [];
	const tinyes = new TinyesService(data, (recipient, payload) => {
		assertInvariant(recipient === player, "TinyesChanged isolado por jogador");
		notifications.push(payload.balance);
	});
	assertInvariant(data.loadPlayer(player).ok, "load Tinyes");
	tinyes.syncBalance(player);
	assertInvariant(notifications[0] === INITIAL_TINYES, "notificação inicial após load");
	assertInvariant(!tinyes.spendTinyes(player, 1, "sem saldo").ok && data.getTinyes(player) === INITIAL_TINYES, "spend sem saldo não muda estado");
	for (const amount of [0, -1, 0.5, 0 / 0, math.huge, -math.huge, MAX_SAVED_NUMBER + 1]) {
		assertInvariant(!tinyes.addTinyes(player, amount, "inválido").ok, "add recusa inválido");
		assertInvariant(!tinyes.spendTinyes(player, amount, "inválido").ok, "spend recusa inválido");
		assertInvariant(data.getTinyes(player) === INITIAL_TINYES, "inválido preserva saldo");
	}
	assertInvariant(!tinyes.addTinyes(player, TINYES_MAX_ADD_PER_CALL + 1, "teto").ok, "teto add");
	for (const _ of $range(1, 6)) assertInvariant(tinyes.addTinyes(player, TINYES_MAX_ADD_PER_CALL, "crédito").ok, "add válido");
	assertInvariant(tinyes.spendTinyes(player, 5000, "loja").ok && data.getTinyes(player) === 1000, "spend acima do teto add");
	assertInvariant(!tinyes.spendTinyes(player, 1001, "insuficiente").ok && data.getTinyes(player) === 1000, "saldo insuficiente preservado");
	assertInvariant(tinyes.spendTinyes(player, 1000, "zerar").ok && data.getTinyes(player) === 0, "saldo nunca negativo");
	const range = TINYES_WIN_BY_TIER.Bronze;
	for (const outcome of ["win", "loss", "quit", "disconnect", "timeout", "error", "outside", "pvp"] as const) {
		const before = tinyes.getBalance(player).balance;
		const rng = createSeededRng(FIRST_SIMULATION_SEED);
		const expected = range.min + math.floor(createSeededRng(FIRST_SIMULATION_SEED)() * (range.max - range.min + 1));
		const ended: BattleEndedPayload[] = [];
		const sessions = new BattleSessionService(createSurgicalMockAdapter({ onBattleEnded: (_, payload) => ended.push(payload) }), tinyes);
		const side = createDummySide(() => 0.5);
		const enemy = createDummySide(() => 0.5);
		assertInvariant(sessions.createSession(player, undefined, side, enemy, rng, outcome === "pvp" ? "PVP" : "PVE"), "cria sessão Tinyes");
		const internal = sessions as unknown as { activeSessions: { battle: BattleService; rewardPaid: boolean }[] };
		const record = internal.activeSessions[0];
		if (outcome === "quit") sessions.requestQuit(player);
		else if (outcome === "disconnect") sessions.destroySessionForPlayer(player);
		else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
		else if (outcome === "error") {
			record.battle.step = () => error("erro intencional Tinyes");
			sessions.step(SIMULATION_DT);
		} else {
			if (outcome === "outside") mock.Parent = undefined;
			record.battle.events.battleEnd.fire(outcome === "loss" ? enemy : side);
			record.battle.events.battleEnd.fire(side);
		}
		const reward = outcome === "win" ? expected : 0;
		assertInvariant(data.getTinyes(player) === before + reward, `${outcome}: saldo final correto`);
		if (outcome === "win") {
			assertInvariant(record.rewardPaid && reward >= range.min && reward <= range.max, "prêmio único e dentro do range");
			assertInvariant(ended.size() === 1 && ended[0].tinyesReward === reward, "BattleEnded duplicado paga e notifica uma vez");
		}
		mock.Parent = Players;
		sessions.requestQuit(player);
		assertInvariant(data.savePlayer(player).ok, "save Tinyes");
		assertInvariant(data.getLastPersistedSnapshot(player.UserId)?.tinyes === before + reward, `${outcome}: snapshot confirmado contém saldo final`);
	}
	assertInvariant(notifications[notifications.size() - 1] === data.getTinyes(player), "último remote corresponde ao saldo");
	const previous = tinyes.getBalance(player).balance;
	assertInvariant(data.addTinyes(player, MAX_SAVED_NUMBER - previous), "saldo no limite de precisão");
	assertInvariant(!tinyes.addTinyes(player, 1, "overflow").ok && data.getTinyes(player) === MAX_SAVED_NUMBER, "overflow não altera saldo");
	assertInvariant(tinyes.spendTinyes(player, MAX_SAVED_NUMBER, "limite").ok && data.getTinyes(player) === 0, "spend aceita limite seguro e zera");
	assertInvariant(data.savePlayer(player).ok && data.getLastPersistedSnapshot(player.UserId)?.tinyes === 0, "snapshot final zero confirmado");
	print("TINYES_ECONOMY_PASSED");
}

/** Valida os lutadores reais entregues à sessão, incluindo persistência e equipes incompletas. */
function validateInventoryTestBattles(): void {
	const player = { Parent: Players, Name: "InventoryBattleTest", UserId: 991988 } as unknown as Player;
	const backing = new InMemoryDataStore();
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, {
		dataStore: backing, serverId: "InventoryBattle_A", now: () => 1000,
		waitFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true,
		rng: createSeededRng(FIRST_SIMULATION_SEED),
	});
	let started: BattleStartedPayload | undefined;
	const sessions = new BattleSessionService(createSurgicalMockAdapter({
		onBattleStarted: (_, payload) => started = payload,
	}));
	assertInvariant(!createJotaroVsAnubisBattleSession(sessions, player, progression, data, () => 0.1), "sem load não cria time nem rolls");
	assertInvariant(data.loadPlayer(player).ok, "load para batalha do inventário");
	const starter = progression.getPlayerData(player)!.inventory[0];
	let inventoryBattle = false;
	let inventorySends = 0;
	const inventoryNetwork = new InventoryService(data, progression, () => inventoryBattle, () => inventorySends++);
	for (const team of [[], [starter.itemUuid, starter.itemUuid], ["foreign"], ["a", "b", "c", "d"]]) {
		assertInvariant(!inventoryNetwork.setTeam(player, team), "invalid inventory team");
	}
	inventoryBattle = true;
	assertInvariant(!inventoryNetwork.setTeam(player, [starter.itemUuid]), "team rejected during battle");
	inventoryBattle = false;
	const savedProgression = progression.getPlayerData(player)!;
	progression.loadValidatedPlayerData(player, { ...savedProgression, inventory: [{ ...starter, unavailable: true }] });
	assertInvariant(!inventoryNetwork.setTeam(player, [starter.itemUuid]), "unavailable inventory team");
	progression.loadValidatedPlayerData(player, savedProgression);
	assertInvariant(inventoryNetwork.setTeam(player, [starter.itemUuid]), "valid inventory team");
	progression.addXp(player, starter.itemUuid, 100);
	const sendsBeforeAllocate = inventorySends;
	assertInvariant(progression.allocatePoints(player, starter.itemUuid, "atk", 1), "inventory allocate");
	assertInvariant(inventorySends === sendsBeforeAllocate + 1, "allocate sends inventory");
	assertInvariant(inventoryNetwork.getState(player)!.fighters[0].allocatedStats.atk === 1, "inventory snapshot");

	const jotaro = progression.createInventoryFighter(player, {
		fighterId: "jotaro", baseStats: { hp: 17, atk: 11, dodge: 6, crit: 9 },
		skills: [calcSkillSlotRoll(1, 0.17), calcSkillSlotRoll(2, 0.41), calcSkillSlotRoll(3, 0.83)],
	});
	const anubis = progression.createInventoryFighter(player, {
		fighterId: "anubis", baseStats: { hp: 14, atk: 12, dodge: 5, crit: 10 },
		skills: [calcSkillSlotRoll(1, 0.91), calcSkillSlotRoll(2, 0.28), calcSkillSlotRoll(3, 0.62)],
	});
	assertInvariant(data.setActiveTeam(player, [anubis.itemUuid, jotaro.itemUuid]), "seleciona dois itens fora da ordem do inventário");
	const permanentRolls = (item: typeof jotaro) => ({
		itemUuid: item.itemUuid, baseStats: { ...item.baseStats },
		skills: item.skills.map((roll) => ({ ...roll })),
	});
	const initialJotaro = permanentRolls(jotaro);
	const initialAnubis = permanentRolls(anubis);
	const snapshot = (side: BattleSide) => side.fighters.map((fighter) => ({
		itemUuid: fighter.itemUuid, fighterId: fighter.fighterId, level: fighter.level,
		stats: { ...fighter.stats }, hp: fighter.hp, hpMax: fighter.hpMax,
		slots: fighter.slots.map((roll) => ({ ...roll })),
	}));
	let battleSeed = FIRST_SIMULATION_SEED;
	const start = (p = progression, d = data): readonly [BattleSide, BattleSide] => {
		assertInvariant(createJotaroVsAnubisBattleSession(sessions, player, p, d, createSeededRng(battleSeed++)), "cria batalha do inventário");
		const internal = sessions as unknown as { activeSessions: { sides: readonly [BattleSide, BattleSide] }[] };
		assertInvariant(internal.activeSessions.size() === 1, "substitui a sessão anterior");
		const sides = internal.activeSessions[0].sides;
		assertInvariant(started !== undefined && started.fighters.size() === sides[0].fighters.size() + 3, "payload contém somente integrantes existentes e os três oponentes");
		for (let i = 0; i < sides[0].fighters.size(); i++) {
			const fighter = sides[0].fighters[i];
			const payload = started!.fighters[i];
			assertInvariant(payload.level === fighter.level && payload.hpMax === fighter.hpMax, "HUD recebe level e HP salvos");
			assertStoredEqual(payload.slotCosts, fighter.slots.map((roll) => roll.cost), "HUD recebe custos salvos");
		}
		return sides;
	};
	const [firstPlayer, firstAI] = start();
	const firstSnapshot = snapshot(firstPlayer);
	const aiSnapshot = snapshot(firstAI);
	assertStoredEqual(firstPlayer.fighters.map((f) => f.itemUuid), [anubis.itemUuid, jotaro.itemUuid], "time segue activeTeam, sem starter extra");
	assertStoredEqual(firstPlayer.fighters[0].stats, anubis.baseStats, "Anubis usa seus baseStats salvos");
	assertStoredEqual(firstPlayer.fighters[1].stats, jotaro.baseStats, "Jotaro usa seus baseStats salvos");
	assertStoredEqual(firstPlayer.fighters[0].slots, anubis.skills, "Anubis preserva t/cost/mult dos três slots");
	assertStoredEqual(firstPlayer.fighters[1].slots, jotaro.skills, "Jotaro preserva t/cost/mult dos três slots");
	const [secondPlayer, secondAI] = start();
	assertStoredEqual(snapshot(secondPlayer), firstSnapshot, "duas batalhas: UUID, level, stats, HP e custos idênticos");
	assertStoredEqual(snapshot(secondAI), aiSnapshot, "IA idêntica com outro RNG de combate");
	assertInvariant(firstPlayer.fighters[0] !== secondPlayer.fighters[0] && firstPlayer.fighters[0].slots[0] !== anubis.skills[0], "sessões e inventário possuem cópias independentes");
	secondPlayer.fighters[0].takeDamage(1);
	secondPlayer.fighters[0].applyStatusEffect("Burn", 1, 10);
	const [freshPlayer] = start();
	assertStoredEqual(snapshot(freshPlayer), firstSnapshot, "dano e efeitos da luta anterior não contaminam o inventário");
	assertInvariant(freshPlayer.fighters[0].statusEffects.size() === 0, "nova luta sem efeitos antigos");

	const xpToLevel4 = calcXpForNextLevel(1) + calcXpForNextLevel(2) + calcXpForNextLevel(3);
	assertInvariant(progression.addXp(player, jotaro.itemUuid, xpToLevel4)?.level === 4, "XP eleva Jotaro ao Lv4");
	const [leveledPlayer] = start();
	assertInvariant(leveledPlayer.fighters[1].level === 4, "nova batalha usa nível atualizado");
	assertStoredEqual(leveledPlayer.fighters[1].stats, jotaro.baseStats, "nível libera pontos, sem bônus automático de stats");
	assertStoredEqual(leveledPlayer.fighters[1].slots, initialJotaro.skills, "subir nível preserva os rolls");
	for (const stat of ["hp", "atk", "dodge", "crit"] as const) {
		assertInvariant(progression.allocatePoints(player, jotaro.itemUuid, stat, 1), "aloca ponto para batalha");
	}
	const [allocatedPlayer, allocatedAI] = start();
	assertStoredEqual(allocatedPlayer.fighters[1].stats, {
		hp: jotaro.baseStats.hp + HP_PER_POINT, atk: jotaro.baseStats.atk + ATK_PER_POINT,
		dodge: jotaro.baseStats.dodge + DODGE_POINTS_PER_POINT, crit: jotaro.baseStats.crit + CRIT_POINTS_PER_POINT,
	}, "stats finais usam base mais os quatro atributos alocados");
	assertInvariant(allocatedPlayer.fighters[1].hpMax === jotaro.baseStats.hp + HP_PER_POINT, "HP máximo usa HP efetivo");
	assertStoredEqual(allocatedPlayer.fighters[1].slots, initialJotaro.skills, "alocar pontos preserva t/cost/mult");
	assertStoredEqual(permanentRolls(progression.getFighter(player, jotaro.itemUuid)!), initialJotaro, "progressão preserva UUID/base/rolls");
	assertStoredEqual(permanentRolls(progression.getFighter(player, anubis.itemUuid)!), initialAnubis, "Anubis permanece inalterado");
	assertStoredEqual(snapshot(allocatedAI), aiSnapshot, "progressão do jogador não altera IA");
	const beforeReload = snapshot(allocatedPlayer);
	sessions.requestQuit(player);
	assertInvariant(data.savePlayer(player, true).ok, "salva e libera lock antes do reload");
	const reloadedProgression = new ProgressionService();
	const reloadedData = new PlayerDataService(reloadedProgression, {
		dataStore: backing, serverId: "InventoryBattle_B", now: () => 1001,
		waitFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true,
	});
	assertInvariant(reloadedData.loadPlayer(player).ok, "load em novo serviço");
	const [reloadedPlayer, reloadedAI] = start(reloadedProgression, reloadedData);
	assertStoredEqual(snapshot(reloadedPlayer), beforeReload, "save/load e batalha preservam lutador completo");
	assertStoredEqual(snapshot(reloadedAI), aiSnapshot, "save/load não altera a IA");
	assertStoredEqual(permanentRolls(reloadedProgression.getFighter(player, jotaro.itemUuid)!), initialJotaro, "base/rolls persistidos intactos");

	// Três UUIDs, inclusive dois Jotaros distintos, continuam sendo itens independentes.
	assertInvariant(reloadedData.setActiveTeam(player, [jotaro.itemUuid, anubis.itemUuid, starter.itemUuid]), "seleciona três itens");
	const [fullPlayer, fullAI] = start(reloadedProgression, reloadedData);
	assertStoredEqual(fullPlayer.fighters.map((f) => f.itemUuid), [jotaro.itemUuid, anubis.itemUuid, starter.itemUuid], "três integrantes na ordem selecionada");
	assertStoredEqual(snapshot(fullAI), aiSnapshot, "tamanho do time não altera IA");
	for (const uuids of [[anubis.itemUuid], [jotaro.itemUuid, anubis.itemUuid]]) {
		assertInvariant(reloadedData.setActiveTeam(player, uuids), "seleciona equipe incompleta");
		const [partial] = start(reloadedProgression, reloadedData);
		assertStoredEqual(partial.fighters.map((f) => f.itemUuid), uuids, "sem completar ou duplicar vagas");
		assertInvariant(!partial.trocar(2), "vaga vazia não aceita troca");
		for (const fighter of partial.fighters) {
			fighter.hp = 1;
			fighter.applyStatusEffect("Bleed", 1, 12);
		}
		sessions.step(1.0);
		assertInvariant(partial.isDefeated(), "morte percorre somente integrantes existentes");
		assertInvariant(!sessions.hasActiveSession(player), "último integrante morto encerra sessão incompleta");
	}
	reloadedProgression.forgetPlayer(player);
	reloadedProgression.getOrCreatePlayerData(player);
	assertInvariant(!createJotaroVsAnubisBattleSession(sessions, player, reloadedProgression, reloadedData, () => 0.5), "inventário vazio não gera substitutos");
	assertInvariant(!sessions.hasActiveSession(player), "sem lutadores não cria sessão");
	print("INVENTORY_TEST_BATTLES_PASSED");
}

function validateProgressionSnapshots(): void {
	const service = new ProgressionService();
	const player = { UserId: 991989 } as Player;
	const created = service.createInventoryFighter(player, {
		fighterId: "jotaro", rarity: "Lendária", equippedChip: "test-chip",
		duo: { activeMember: "Tarkus", partnerHp: 9, partnerHpMax: 17, isSurvivor: false }, baseStats: { hp: 17, atk: 12, dodge: 5, crit: 8 },
		skills: [calcSkillSlotRoll(1, 0.2), calcSkillSlotRoll(2, 0.4), calcSkillSlotRoll(3, 0.6)],
	});
	service.addXp(player, created.itemUuid, 4507);
	const expected = service.getFighter(player, created.itemUuid)!;
	for (const snapshot of [service.getPlayerData(player)!, service.getOrCreatePlayerData(player)]) {
		snapshot.inventory.clear();
		assertInvariant(service.getPlayerData(player)!.inventory.size() === 1, "inventory snapshot isolated");
	}
	for (const item of [created, service.getOrCreatePlayerData(player).inventory[0], service.getPlayerData(player)!.inventory[0], service.getFighter(player, created.itemUuid)!, service.levelUp(player, created.itemUuid)!, service.addXp(player, created.itemUuid, 0)!]) {
		const mutable = item as unknown as { duo: { partnerHp: number }; level: number; xp: number; baseStats: { hp: number }; allocatedStats: { atk: number; hp: number }; skills: { t: number; cost: number; mult: number }[] };
		mutable.duo.partnerHp = 999;
		mutable.level = 30;
		mutable.xp = 99999;
		mutable.baseStats.hp = 99999;
		mutable.allocatedStats.atk = 30;
		mutable.allocatedStats.hp = 30;
		for (const roll of mutable.skills) { roll.t = 1; roll.cost = 999; roll.mult = 999; }
		assertStoredEqual(service.getFighter(player, created.itemUuid), expected, "external mutation isolated");
	}
	assertInvariant(!service.allocatePoints(player, created.itemUuid, "atk", 6), "ATK/Dodge guard");
	assertInvariant(!service.allocatePoints(player, created.itemUuid, "hp", 6), "HP/Crit guard");
	assertInvariant(service.allocatePoints(player, created.itemUuid, "atk", 5), "valid allocation");
	// Percorre o validador real e a entrada da persistencia, sem rerrolar campos.
	const source = service.getPlayerData(player)!;
	const validated = validatePlayerSaveData({ ...source, tinyes: 123, activeTeam: [created.itemUuid], pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0] });
	assertInvariant(validated.valid && validated.data !== undefined, "fixture passa pelo validador real");
	const loaded = new ProgressionService();
	loaded.loadValidatedPlayerData(player, validated.data!);
	assertStoredEqual(loaded.getPlayerData(player), source, "load preserva todos os campos, chip, duo e rolls");
	const inputItem = validated.data!.inventory[0] as unknown as { baseStats: { hp: number }; allocatedStats: { atk: number }; skills: { t: number }[]; duo: { partnerHp: number } };
	inputItem.baseStats.hp = 999;
	inputItem.allocatedStats.atk = 999;
	for (const roll of inputItem.skills) roll.t = 999;
	inputItem.duo.partnerHp = 999;
	validated.data!.inventory.clear();
	assertStoredEqual(loaded.getPlayerData(player), source, "load copia profundamente a entrada validada");
	// Item indisponível preserva todos os metadados nas duas reconstruções.
	const unavailableService = new ProgressionService();
	const unavailableItem = { ...expected, unavailable: true };
	unavailableService.loadValidatedPlayerData(player, { version: source.version, inventory: [unavailableItem] });
	const afterXp = { ...unavailableItem, level: expected.level + 1, xp: 0 };
	assertStoredEqual(
		unavailableService.addXp(player, created.itemUuid, calcXpForNextLevel(expected.level) - expected.xp),
		afterXp,
		"addXp retorna item com unavailable, metadados e nível atualizado",
	);
	assertStoredEqual(unavailableService.getFighter(player, created.itemUuid), afterXp, "addXp preserva unavailable e todos os campos no inventário");
	assertStoredEqual(unavailableService.levelUp(player, created.itemUuid), afterXp, "levelUp direto preserva unavailable e metadados");
	assertInvariant(unavailableService.allocatePoints(player, created.itemUuid, "atk", 1), "alocação válida no item indisponível");
	assertStoredEqual(
		unavailableService.getPlayerData(player)!.inventory[0],
		{ ...afterXp, allocatedStats: { ...afterXp.allocatedStats, atk: afterXp.allocatedStats.atk + 1 } },
		"allocatePoints preserva unavailable e todos os demais campos no estado final",
	);
	print("PROGRESSION_SNAPSHOTS_PASSED");
}

/** Trava autoritativa, payload por lutador, troca e seleção/reação da IA. */
function validateS3Unlock(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	for (const level of $range(MIN_LEVEL, S3_UNLOCK_LEVEL)) {
		const side = new BattleSide([
			makeRealFighter("jotaro", rng, level),
			makeRealFighter("jotaro", rng, level),
			makeRealFighter("jotaro", rng, level),
		], rng);
		const enemy = createDummySide(rng);
		const battle = new BattleService(side, enemy, rng);
		side.setAtb(ATB_MAX);
		const unlocked = level >= S3_UNLOCK_LEVEL;
		assertInvariant(battle.requestSkill(side, 3) === unlocked, `S3 no nível ${level}`);
		assertInvariant(side.atb === (unlocked ? ATB_MAX - side.fighters[0].slots[2].cost : ATB_MAX), "recusa não consome ATB");
		assertInvariant(battle.state === (unlocked ? "PREPARE" : "IDLE"), "estado final após pedido de S3");
		if (!unlocked) {
			const decisions: SkillSlot[] = [];
			const ai = new AIService(battle, side, rng, { requestSkill: (slot) => { decisions.push(slot); return true; }, requestSwitch: () => false });
			for (let decision = 0; decision < SIMULATION_COUNT; decision++) {
				assertInvariant(ai.chooseSkillSlot([1, 2, 3]) !== 3, "IA não escolhe S3 bloqueado");
				ai.step(AI_BRONZE_SKILL_DELAY_MAX_SECONDS);
			}
			assertInvariant(decisions.size() === SIMULATION_COUNT && decisions.every((slot) => slot !== 3), "1000 intenções usam reação normal e nunca S3 bloqueado");
			ai.destroy();
		}
	}
	const low = makeRealFighter("jotaro", rng, S3_UNLOCK_LEVEL - 1);
	const high = makeRealFighter("anubis", rng, S3_UNLOCK_LEVEL);
	const side = new BattleSide([low, high], rng);
	const enemy = createDummySide(rng);
	const player = { Parent: Players, Name: "S3UnlockTest", UserId: 991987 } as unknown as Player;
	let started: BattleStartedPayload | undefined;
	let request: ((player: Player, slot: SkillSlot) => void) | undefined;
	const sessions = new BattleSessionService({
		...createSurgicalMockAdapter({ onBattleStarted: (_, payload) => started = payload }),
		bindRequests(onSkill) { request = onSkill; },
	});
	sessions.start();
	assertInvariant(sessions.createSession(player, undefined, side, enemy, rng, "PVE"), "sessão para pedido forçado");
	assertInvariant(started !== undefined && request !== undefined, "payload e handler registrados");
	const snapshots = started!.fighters.filter((fighter) => fighter.sideId === started!.sides[0]);
	assertInvariant(snapshots[0].s3Unlocked === false && snapshots[1].s3Unlocked === true, "BattleStarted envia trava individual pelo nível do servidor");
	side.setAtb(ATB_MAX);
	request!(player, 3);
	const internal = sessions as unknown as { activeSessions: { battle: BattleService }[] };
	const battle = internal.activeSessions[0].battle;
	assertInvariant(side.atb === ATB_MAX && battle.state === "IDLE", "client forçando S3 é recusado sem alterar estado");
	assertInvariant(battle.requestSwitch(side, 1), "troca para nível liberado");
	assertInvariant(side.getActiveFighter() === high && snapshots[1].s3Unlocked, "ativo usa snapshot liberado");
	assertInvariant(battle.requestSwitch(side, 0), "volta ao nível bloqueado");
	assertInvariant(!battle.requestSkill(side, 3) && !snapshots[0].s3Unlocked, "troca reaplica bloqueio");
	assertInvariant(battle.requestSwitch(side, 1) && battle.requestSkill(side, 3), "S3 aceita após trocar para Lv de desbloqueio");
	sessions.requestQuit(player);
	print("S3_UNLOCK_PASSED");
}

export function validatePostBattleXp(): void {
	const mock = { Parent: Players as Players | undefined, Name: "XpBattle", UserId: 991989 };
	const player = mock as Player;
	const rng = () => 0.5;
	for (const outcome of ["win", "tie", "dot", "invalid", "last", "multi", "cap", "loss", "quit", "disconnect", "timeout", "stall", "error", "outside", "pvp"] as const) {
		const progression = new ProgressionService();
		const template = makeDummyFighter("Fury");
		const items = [0, 1, 2].map(() => progression.createInventoryFighter(player, {
			fighterId: "jotaro", baseStats: template.stats, skills: template.slots,
		}));
		const solo = outcome === "multi" || outcome === "cap";
		if (outcome === "cap") progression.addXp(player, items[0].itemUuid, calcMaxUsefulXp() - 1);
		const before = items.map((item) => progression.getFighter(player, item.itemUuid)!);
		const fighters = before.map((item) => new Fighter({
			itemUuid: item.itemUuid, fighterId: item.fighterId, level: item.level,
			hp: 100, hpMax: 100, stats: template.stats, className: "Fury",
			slots: item.skills, skillData: template.skillData, currentAtbSpeed: template.currentAtbSpeed,
		}));
		const side = new BattleSide(solo ? [fighters[0]] : [fighters[0], fighters[1], fighters[2]], rng);
		const enemyFighter = new Fighter({
			fighterId: "anubis", level: solo ? 30 : 1, hp: 100, hpMax: 100,
			stats: template.stats, className: "Fury", slots: template.slots,
			skillData: template.skillData, currentAtbSpeed: template.currentAtbSpeed,
		});
		const enemy = new BattleSide(outcome === "multi" ? [enemyFighter, new Fighter({ ...enemyFighter, level: 20 })] : [enemyFighter], rng);
		const ended: BattleEndedPayload[] = [];
		const sessions = new BattleSessionService(createSurgicalMockAdapter({
			onBattleEnded: (recipient, payload) => {
				assertInvariant(recipient === player, "XP privado do participante");
				ended.push(payload);
			},
		}), undefined, progression);
		assertInvariant(sessions.createSession(player, undefined, side, enemy, rng, outcome === "pvp" ? "PVP" : "PVE"), "sessão XP");
		const record = (sessions as unknown as { activeSessions: { battle: BattleService; rewardPaid: boolean }[] }).activeSessions[0];
		const battle = record.battle;
		const hit = (index: FighterIndex) => {
			if (side.activeIndex !== index) assertInvariant(battle.requestSwitch(side, index), "troca para causador");
			side.setAtb(10);
			assertInvariant(battle.requestSkill(side, 1), "hit real autorizado");
			battle.step(0.6);
		};
		if (outcome === "win") {
			hit(1);
			const direct = battle.getDamageDealt(side, items[1].itemUuid);
			assertInvariant(direct === 100 - enemyFighter.hp, "dano direto contabiliza HP realmente removido");
			enemyFighter.statusEffects.clear();
			enemyFighter.hp = 1;
			hit(1); // overkill deve contar somente 1, inclusive antes do BattleEnded.
			assertInvariant(battle.getDamageDealt(side, items[1].itemUuid) === direct + 1, "overkill direto conta somente HP restante");
		} else if (outcome === "dot") {
			hit(1);
			const direct = battle.getDamageDealt(side, items[1].itemUuid);
			assertInvariant(enemyFighter.statusEffects.get("Bleed")?.kind === "dot", "hit cria DoT");
			hit(2); // renovação transfere autoria para o novo aplicador.
			const effect = enemyFighter.statusEffects.get("Bleed");
			assertInvariant(effect?.kind === "dot" && effect.source === fighters[2], "renovação guarda causador");
			const secondDirect = battle.getDamageDealt(side, items[2].itemUuid);
			battle.requestSwitch(side, 0);
			enemyFighter.hp = 1;
			battle.step(3); // DoT letal do lutador no banco, limitado ao HP real.
			assertInvariant(battle.getDamageDealt(side, items[1].itemUuid) === direct, "DoT renovado não credita causador antigo");
			assertInvariant(battle.getDamageDealt(side, items[2].itemUuid) === secondDirect + 1, "DoT credita 1 real ao causador no banco");
			assertInvariant(battle.getDamageDealt(side, items[0].itemUuid) === 0, "ativo não rouba DoT");
		} else if (outcome === "quit") sessions.requestQuit(player);
		else if (outcome === "disconnect") sessions.destroySessionForPlayer(player);
		else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
		else if (outcome === "stall") {
			side.setAtb(10);
			battle.requestSkill(side, 1);
			battle.step = () => {};
			sessions.step(31);
		} else if (outcome === "error") {
			battle.step = () => error("erro intencional XP");
			sessions.step(SIMULATION_DT);
		} else {
			if (outcome === "invalid") progression.loadValidatedPlayerData(player, {
				version: PLAYER_DATA_SCHEMA_VERSION, inventory: [items[0], { ...items[2], unavailable: true }],
			});
			if (outcome === "last") progression.loadValidatedPlayerData(player, {
				version: PLAYER_DATA_SCHEMA_VERSION, inventory: [{ ...items[0], unavailable: true }, items[2]],
			});
			if (outcome === "outside") mock.Parent = undefined;
			battle.events.battleEnd.fire(outcome === "loss" ? enemy : side);
		}
		const eligible = ["win", "tie", "dot", "invalid", "last", "multi", "cap"].includes(outcome);
		const finalSnapshot = progression.getPlayerData(player);
		battle.events.battleEnd.fire(side);
		assertStoredEqual(progression.getPlayerData(player), finalSnapshot, "segundo fim não paga XP novamente");
		if (eligible) {
			assertInvariant(record.rewardPaid && ended.size() === 1, "vitória paga e notifica uma vez");
			const rewards = ended[0].xpRewards!;
			assertInvariant(rewards !== undefined && rewards.size() === (solo || outcome === "invalid" || outcome === "last" ? 1 : 3), "somente itens válidos recebem XP");
			for (const reward of rewards) {
				const index = before.findIndex((item) => item.itemUuid === reward.itemUuid);
				const initial = before[index];
				const final = progression.getFighter(player, reward.itemUuid)!;
				assertInvariant(reward.previousLevel === initial.level && reward.previousXp === initial.xp &&
					reward.previousXpToNext === calcXpForNextLevel(initial.level), "previous vem do snapshot anterior");
				assertInvariant(reward.newLevel === final.level && reward.newXp === final.xp &&
					reward.newXpToNext === calcXpForNextLevel(final.level) &&
					reward.leveledUp === (final.level > initial.level), "payload bate com inventário final");
				assertInvariant(reward.fighterId === "jotaro" && reward.displayName === "Jotaro" && reward.className === "Fury", "identidade servidor");
			}
			if (outcome === "win" || outcome === "tie" || outcome === "dot") {
				const top = outcome === "win" ? 1 : outcome === "dot" ? 2 : 0;
				for (const index of $range(0, 2)) assertInvariant(rewards[index].xpGained === (index === top ? 45 : 22), "maior dano/desempate recebe maior fração");
			}
			if (outcome === "invalid") assertInvariant(rewards[0].xpGained === 90 && progression.getFighter(player, items[2].itemUuid)?.xp === 0, "removido/unavailable não roubam fatia");
			if (outcome === "last") assertInvariant(rewards[0].xpGained === 90 && rewards[0].itemUuid === items[2].itemUuid, "vagas inválidas anteriores não ocultam recompensa do último slot");
			if (outcome === "multi") assertInvariant(rewards[0].newLevel === 4 && rewards[0].newXp === 7 && rewards[0].xpGained === 607, "média inimiga 25 da sessão e múltiplos níveis corretos");
			if (outcome === "cap") assertInvariant(rewards[0].newLevel === MAX_LEVEL && rewards[0].newXp === 0 && rewards[0].xpGained === 1, "XP útil no cap");
		} else {
			assertStoredEqual(progression.getPlayerData(player)!.inventory, before, "sem vitória elegível preserva inventário");
			for (const payload of ended) assertInvariant(payload.xpRewards === undefined, "sem xpRewards fora de vitória PVE");
		}
		mock.Parent = Players;
		sessions.requestQuit(player);
	}
	print("POST_BATTLE_XP_PASSED");
}

export function validateShop(): void {
	for (const rarity of ["Comum", "Rara", "Épica", "Lendária"] as const) {
		const range = SHOP_PRICE_RANGES[rarity];
		assertInvariant(calcOfferPrice(rarity, 0, 1) === range.min && calcOfferPrice(rarity, 1, 3) === range.max, "extremos do preço");
		for (let level = 1; level <= 3; level++) {
			let previous = range.min;
			for (let step = 0; step <= 100; step++) {
				const quality = step / 100;
				const price = calcOfferPrice(rarity, quality, level);
				assertInvariant(price === calcOfferPrice(rarity, quality, level) && price >= previous && price >= range.min && price <= range.max, "preço determinístico, monotônico em qualidade e dentro da faixa");
				if (level < 3) assertInvariant(calcOfferPrice(rarity, quality, level + 1) >= price, "preço monotônico em nível");
				previous = price;
			}
		}
	}
	for (const className of ["Fury", "Menace", "Support", "Controller", "Dominator"] as const) {
		const ranges = CLASS_DATA[className].baseStats;
		assertInvariant(calcStatQuality(className, { hp: ranges.hp.min, atk: ranges.atk.min, dodge: ranges.dodge.min, crit: ranges.crit.min }) === 0, "qualidade mínima");
		assertInvariant(calcStatQuality(className, { hp: ranges.hp.max, atk: ranges.atk.max, dodge: ranges.dodge.max, crit: ranges.crit.max }) === 1, "qualidade máxima");
	}
	const backing = new InMemoryDataStore();
	let now = SHOP_RESET_WINDOW_SECONDS * 10 + 100;
	let clock = 0;
	let inBattle = false;
	const mock = { Parent: Players as Players | undefined, Name: "ShopTest", UserId: 991990 };
	const player = mock as Player;
	const progression = new ProgressionService();
	const warnings: string[] = [];
	const data = new PlayerDataService(progression, { dataStore: backing, serverId: "ShopTest", now: () => now,
		waitFn: () => {}, warnFn: (message) => warnings.push(message), disableStudioAutoFallbackOnInjectedStore: true });
	let changes = 0;
	let states = 0;
	const shop = new ShopService(data, () => inBattle, (recipient, payload) => {
		assertInvariant(recipient === player && payload.offers.size() === 3, "ShopState privado com três prateleiras");
		const offers = shop.getOffers(player)!;
		for (let i = 0; i < 3; i++) {
			assertStoredEqual(payload.offers[i].baseStats, offers[i].baseStats, "atributos expostos antes da compra");
			assertInvariant(payload.offers[i].level === offers[i].level && payload.offers[i].price === offers[i].price, "nível e preço expostos");
		}
		states++;
	}, () => changes++, () => {}, () => {}, () => now, () => clock);
	const state = () => {
		const snapshot = data.getPlayerSaveSnapshot(player)!;
		return { tinyes: snapshot.tinyes, inventory: snapshot.inventory, activeTeam: snapshot.activeTeam, counts: snapshot.shopRestockCounts };
	};
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: "inventado" }), "sessão ausente");
	assertInvariant(data.loadPlayer(player).ok, "load loja");
	shop.sync(player);
	const original = shop.getOffers(player)!;
	assertStoredEqual(shop.getOffers(player), original, "estoque estável sem compra");
	let before = state();
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: original[0].offerId }), "saldo insuficiente");
	assertStoredEqual(state(), before, "saldo insuficiente preserva estado final");
	assertInvariant(data.addTinyes(player, 100000), "crédito de teste");
	clock += 10;
	before = state();
	const offer = original[0];
	assertInvariant(shop.requestPurchase(player, { requestId: "regression", offerId: offer.offerId }), "compra válida");
	const after = state();
	const item = after.inventory[after.inventory.size() - 1];
	assertInvariant(after.tinyes === before.tinyes - offer.price && after.inventory.size() === before.inventory.size() + 1, "um pagamento e um item");
	assertInvariant(item.itemUuid !== offer.offerId && item.level === offer.level && item.xp === 0 && item.fighterId === offer.fighterId, "identidade e nível da oferta");
	assertStoredEqual(item.baseStats, offer.baseStats, "baseStats intactos");
	assertStoredEqual(item.skills, offer.skills, "três rolls intactos");
	assertStoredEqual(item.allocatedStats, { hp: 0, atk: 0, dodge: 0, crit: 0 }, "nenhum ponto alocado");
	assertInvariant(calcAvailablePoints(item.level, item.allocatedStats) === (item.level - 1) * 2, "pontos livres do nível");
	assertStoredEqual(after.activeTeam, before.activeTeam, "compra não altera time");
	assertInvariant(changes === 1 && states === 2, "notificações após commit");
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: offer.offerId }), "mesmo offerId recusado");
	assertStoredEqual(state(), after, "duplicação não cobra nem entrega");
	const restocked = shop.getOffers(player)!;
	assertInvariant(restocked[0].offerId !== offer.offerId, "nova identidade no reabastecimento");
	assertStoredEqual(restocked[1], original[1], "prateleira vizinha intacta");
	const secondService = new ShopService(data, () => false, () => {}, () => {}, () => {}, () => {}, () => now, () => clock);
	assertStoredEqual(secondService.getOffers(player), restocked, "reabastecimento determinístico");
	const alteredSkills = { ...offer, skills: [calcSkillSlotRoll(1, 0), calcSkillSlotRoll(2, 1), calcSkillSlotRoll(3, 0)] };
	const className = FIGHTER_DATA[offer.fighterId as "jotaro" | "anubis"].className;
	assertInvariant(calcOfferPrice(alteredSkills.rarity, calcStatQuality(className, alteredSkills.baseStats), alteredSkills.level) === offer.price, "skills não alteram preço");
	// Save e reentrada na mesma janela preservam tudo, incluindo a prateleira reabastecida.
	assertInvariant(data.savePlayer(player).ok, "save compra");
	data.handlePlayerRemoving(player);
	shop.forgetPlayer(player);
	assertInvariant(data.loadPlayer(player).ok, "reload compra");
	assertStoredEqual(state(), after, "saldo, inventário, rolls e contadores persistem");
	assertStoredEqual(shop.getOffers(player), restocked, "reentrada não rerrola nem muda GUID");
	// Falha mesmo depois de inserir: rollback precisa remover o item parcialmente criado.
	const methodSlot = progression as unknown as { createInventoryFighter: unknown };
	const create = methodSlot.createInventoryFighter;
	progression.createInventoryFighter = (owner, params) => {
		const current = progression.getPlayerData(owner)!;
		progression.loadValidatedPlayerData(owner, { ...current, inventory: [...current.inventory,
			{ ...params, itemUuid: "partial", level: params.level ?? 1, xp: 0, allocatedStats: { hp: 0, atk: 0, dodge: 0, crit: 0 } }] });
		error("falha injetada na criação");
	};
	before = state(); clock += 10;
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: restocked[0].offerId }), "falha na entrega recusada");
	assertStoredEqual(state(), before, "rollback devolve saldo e remove item parcial");
	assertInvariant(warnings.size() > 0, "rollback registrado");
	methodSlot.createInventoryFighter = create;
	for (const payload of [{ requestId: "regression", offerId: "inventado" }, { requestId: "regression", offerId: "" }, { requestId: "regression", offerId: string.rep("a", MAX_ITEM_UUID_LENGTH + 1) }, { requestId: "regression", offerId: 1 }, { requestId: "regression", offerId: restocked[0].offerId, price: 1 }, "invalid"]) {
		clock += 10;
		assertInvariant(!shop.requestPurchase(player, payload), "payload inválido recusado");
		assertStoredEqual(state(), before, "payload inválido preserva estado");
	}
	clock += 10; inBattle = true;
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: restocked[0].offerId }), "batalha recusa compra");
	inBattle = false; mock.Parent = undefined;
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: restocked[0].offerId }), "fora de Players recusa compra");
	mock.Parent = Players;
	assertStoredEqual(state(), before, "batalha e ausência preservam estado");
	// Bucket próprio: três compras no mesmo instante, quarta recusada; reposição aceita após 1s.
	clock += 10; before = state();
	let spent = 0;
	for (let i = 0; i < SHOP_REQUEST_BUCKET_CAPACITY; i++) {
		const current = shop.getOffers(player)![0]; spent += current.price;
		assertInvariant(shop.requestPurchase(player, { requestId: "regression", offerId: current.offerId }), "compra dentro do bucket");
	}
	const burst = state();
	assertInvariant(burst.tinyes === before.tinyes - spent && burst.inventory.size() === before.inventory.size() + 3, "rajada paga exatamente três");
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: shop.getOffers(player)![0].offerId }), "rajada excedente recusada");
	assertStoredEqual(state(), burst, "rate limit não altera estado");
	clock += 1;
	assertInvariant(shop.requestPurchase(player, { requestId: "regression", offerId: shop.getOffers(player)![0].offerId }), "bucket repõe após um segundo");
	// Saldo para exatamente uma das duas ofertas.
	data.trySpendTinyes(player, data.getTinyes(player)!);
	const pair = shop.getOffers(player)!;
	data.addTinyes(player, pair[0].price);
	before = state(); clock += 10;
	assertInvariant(shop.requestPurchase(player, { requestId: "regression", offerId: pair[0].offerId }) && !shop.requestPurchase(player, { requestId: "regression", offerId: pair[1].offerId }), "duas ofertas disputam saldo para uma");
	assertInvariant(data.getTinyes(player) === 0 && state().inventory.size() === before.inventory.size() + 1, "saldo nunca negativo e só uma entrega");
	const previousWindow = shop.getOffers(player)!;
	now += SHOP_RESET_WINDOW_SECONDS;
	assertInvariant(shop.getOffers(player)![0].offerId !== previousWindow[0].offerId, "janela renova oferta");
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: previousWindow[0].offerId }), "oferta expirada recusada");
	// Migração real de v1 e validação estrita dos contadores novos.
	const legacy = { ...data.getPlayerSaveSnapshot(player)!, version: 1, shopRestockCounts: undefined };
	const migrated = migratePlayerData(legacy)!;
	assertStoredEqual(migrated.shopRestockCounts, [0, 0, 0], "migração v1 -> v2 inicializa contadores");
	assertStoredEqual(migrated.inventory, legacy.inventory, "migração preserva inventário e rolls");
	for (const counts of [undefined, [], [0, 0], [0, -1, 0], [0, 0.5, 0], [0, math.huge, 0]]) {
		assertInvariant(!validatePlayerSaveData({ ...migrated, shopRestockCounts: counts }).valid, "schema v2 rejeita contador inválido");
	}
	data.handlePlayerRemoving(player);
	backing.setRawForTest(data.getPlayerKey(player.UserId), { ...legacy, sessionLock: undefined });
	assertInvariant(data.loadPlayer(player).ok, "save antigo carrega pela migração");
	assertStoredEqual(data.getShopRestockCounts(player), [0, 0, 0], "load antigo inicializa contadores");
	assertStoredEqual(progression.getPlayerData(player)!.inventory, legacy.inventory, "load antigo preserva inventário");
	data.handlePlayerRemoving(player);
	backing.setRawForTest(data.getPlayerKey(player.UserId), {
		version: PLAYER_DATA_SCHEMA_VERSION, tinyes: 100000, inventory: [], activeTeam: [], pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0],
	});
	assertInvariant(data.loadPlayer(player).ok, "conta existente com time vazio");
	const levels = new Set<number>();
	for (let sample = 0; sample < 100 && levels.size() < 3; sample++) {
		now += SHOP_RESET_WINDOW_SECONDS; clock += 10;
		for (const sampled of shop.getOffers(player)!) {
			if (levels.has(sampled.level)) continue;
			assertInvariant(shop.requestPurchase(player, { requestId: "regression", offerId: sampled.offerId }), "compra do nível sorteado");
			levels.add(sampled.level);
			const inventory = progression.getPlayerData(player)!.inventory;
			const purchased = inventory[inventory.size() - 1];
			assertInvariant(purchased.level === sampled.level && purchased.xp === 0 && calcAvailablePoints(purchased.level, purchased.allocatedStats) === (sampled.level - 1) * 2, "Lv1/Lv2/Lv3 com pontos livres corretos");
			assertStoredEqual(purchased.skills, sampled.skills, "skills intactas em todos os níveis");
			assertStoredEqual(purchased.baseStats, sampled.baseStats, "stats intactos em todos os níveis");
			assertStoredEqual(data.getActiveTeam(player), [], "comprar com time vazio não equipa");
		}
	}
	assertInvariant(levels.size() === 3, "distribuição oferece Lv1, Lv2 e Lv3");
	const purchased = progression.getPlayerData(player)!.inventory;
	assertInvariant(purchased.size() === 3 && new Set(purchased.map((entry) => entry.itemUuid)).size() === 3 && new Set(purchased.map((entry) => entry.fighterId)).size() < 3, "duplicatas permitidas com UUIDs próprios");
	const beforeEmptyTeamReload = state();
	data.handlePlayerRemoving(player); shop.forgetPlayer(player);
	assertInvariant(data.loadPlayer(player).ok, "reload com time vazio");
	assertStoredEqual(state(), beforeEmptyTeamReload, "save/load preserva time vazio e itens de todos os níveis");
	data.handlePlayerRemoving(player);
	print("SHOP_PASSED");
}

function validateShopSynchronization(): void {
	const player = { Parent: Players, Name: "ShopSyncTest", UserId: 991991 } as unknown as Player;
	let now = SHOP_RESET_WINDOW_SECONDS * 11 - 1;
	let clock = 0.1;
	let nowCalls = 0;
	let advanceOnRead = false;
	let inBattle = false;
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(), serverId: "ShopSyncTest",
		now: () => now, waitFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true });
	let shown: ShopStatePayload | undefined;
	let purchaseResult: PurchaseResultPayload | undefined;
	let fail: string | undefined;
	const attempts: string[] = [];
	let balanceReceived = -1;
	let inventoryReceived: string[] = [];
	const tinyes = new TinyesService(data, (_, payload) => {
		attempts.push("TinyesChanged");
		if (fail === "TinyesChanged") error("falha injetada TinyesChanged");
		balanceReceived = payload.balance;
	});
	const inventory = new InventoryService(data, progression, () => inBattle, (_, payload) => {
		attempts.push("InventoryState");
		if (fail === "InventoryState") error("falha injetada InventoryState");
		inventoryReceived = payload.fighters.map((fighter) => fighter.itemUuid);
	});
	const shop = new ShopService(data, () => inBattle, (_, payload) => {
		attempts.push("ShopState");
		if (fail === "ShopState") error("falha injetada ShopState");
		shown = payload;
	}, (owner) => tinyes.syncBalance(owner), (owner) => inventory.sync(owner), (owner, payload) => {
		assertInvariant(owner === player, "PurchaseResult continua privado após falha de outro envio");
		purchaseResult = payload;
	}, () => {
		nowCalls++;
		const value = now;
		if (advanceOnRead) now++;
		return value;
	}, () => clock);
	const internals = shop as unknown as {
		buckets: Map<Player, { tokens: number; time: number }>; windows: Map<Player, number>;
	};
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: "sem sessão" }) && !internals.buckets.has(player), "sem sessão não cria bucket");
	shop.refresh(player);
	assertInvariant(nowCalls === 0 && attempts.size() === 0 && !internals.windows.has(player), "refresh sem sessão sai antes de consultar relógio ou publicar");
	assertInvariant(data.loadPlayer(player).ok && data.addTinyes(player, 1000000), "sessão para regressões da loja");
	const oldOffers = shop.getOffers(player)!;
	nowCalls = 0; advanceOnRead = true;
	shop.sync(player);
	advanceOnRead = false;
	assertInvariant(nowCalls === 1 && internals.windows.get(player) === 10, "sync decide janela com uma única leitura na virada");
	assertStoredEqual(shown!.offers.map((offer) => offer.offerId), oldOffers.map((offer) => offer.offerId), "client e janela gravada pertencem à mesma fatia");
	shop.refresh(player);
	assertInvariant(internals.windows.get(player) === 11 && shown!.offers[0].offerId !== oldOffers[0].offerId, "refresh envia a fatia seguinte na virada");
	const beforeSync = shop.getOffers(player)!;
	now += SHOP_RESET_WINDOW_SECONDS;
	shop.sync(player);
	assertInvariant(internals.windows.get(player) === 12 && shown!.offers[0].offerId !== beforeSync[0].offerId, "virada entre getOffers e sync usa a nova fatia");
	assertStoredEqual(shown!.offers.map((offer) => offer.offerId), shop.getOffers(player)!.map((offer) => offer.offerId), "ofertas publicadas correspondem à janela final");
	for (const failure of ["ShopState", "TinyesChanged", "InventoryState"]) {
		clock += 10; shop.sync(player);
		const advertised = shown!.offers[0];
		const before = data.getPlayerSaveSnapshot(player)!;
		attempts.clear(); fail = failure;
		assertInvariant(shop.requestPurchase(player, { requestId: "regression", offerId: advertised.offerId }), "falha de notificação preserva compra confirmada");
		fail = undefined;
		const after = data.getPlayerSaveSnapshot(player)!;
		assertStoredEqual(attempts, ["ShopState", "TinyesChanged", "InventoryState"], "cada notificação é tentada apesar da falha");
		assertStoredEqual(purchaseResult, { requestId: "regression", offerId: advertised.offerId, ok: true }, "falha de apresentação não impede resultado confirmado");
		assertInvariant(after.tinyes === before.tinyes - advertised.price && after.inventory.size() === before.inventory.size() + 1, "preço mostrado é o debitado mesmo com falha de notificação");
		assertStoredEqual(after.activeTeam, before.activeTeam, "falha de envio preserva time");
		assertInvariant(after.shopRestockCounts![0] === before.shopRestockCounts![0] + 1, "falha de envio mantém contador confirmado");
		if (failure !== "TinyesChanged") assertInvariant(balanceReceived === after.tinyes, "TinyesChanged recebe saldo final mesmo se ShopState falha");
		if (failure !== "InventoryState") assertStoredEqual(inventoryReceived, after.inventory.map((item) => item.itemUuid), "InventoryState recebe itens finais mesmo se outro envio falha");
	}
	const beforeBattle = data.getPlayerSaveSnapshot(player)!;
	clock += 10; inBattle = true;
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: shop.getOffers(player)![0].offerId }), "compra em batalha recusada");
	assertStoredEqual(data.getPlayerSaveSnapshot(player), beforeBattle, "recusa em batalha preserva estado final completo");
	inBattle = false; shop.forgetPlayer(player); clock = 0.1;
	const beforeBurst = data.getPlayerSaveSnapshot(player)!;
	let spent = 0;
	const buy = () => {
		shop.sync(player);
		const advertised = shown!.offers[0];
		assertInvariant(shop.requestPurchase(player, { requestId: "regression", offerId: advertised.offerId }), "bucket aceita compra no limite exato");
		spent += advertised.price;
	};
	for (let i = 0; i < SHOP_REQUEST_BUCKET_CAPACITY; i++) buy();
	for (let second = 0; second < 10; second++) {
		const beforeDenied = data.getPlayerSaveSnapshot(player)!;
		assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: shop.getOffers(player)![0].offerId }), "rajada extra recusada no mesmo instante");
		assertStoredEqual(data.getPlayerSaveSnapshot(player), beforeDenied, "rajada excedente preserva estado final");
		clock += 1 - FLOAT_TOLERANCE / 2;
		buy();
		assertInvariant(internals.buckets.get(player)!.tokens === 0, "tolerância nunca deixa tokens negativos");
	}
	const afterBurst = data.getPlayerSaveSnapshot(player)!;
	assertInvariant(afterBurst.tinyes === beforeBurst.tinyes - spent && afterBurst.inventory.size() === beforeBurst.inventory.size() + SHOP_REQUEST_BUCKET_CAPACITY + 10, "rajada inicial e uma compra por segundo debitam e entregam exatamente");
	assertInvariant(!shop.requestPurchase(player, { requestId: "regression", offerId: shop.getOffers(player)![0].offerId }), "último segundo também aceita só uma compra");
	assertStoredEqual(data.getPlayerSaveSnapshot(player), afterBurst, "última recusa mantém estado final");
	data.handlePlayerRemoving(player); shop.forgetPlayer(player);
	print("SHOP_SYNCHRONIZATION_PASSED");
}

export function validatePurchaseAndAllocationResults(): void {
	const player = { Parent: Players, Name: "ResultTest", UserId: 991992 } as unknown as Player;
	const other = { Parent: Players, Name: "OtherResultTest", UserId: 991993 } as unknown as Player;
	let clock = 0;
	let inBattle = false;
	let failResult = false;
	const remotes = new RemoteService(() => clock);
	const progression = new ProgressionService(remotes);
	const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(), serverId: "ResultTest",
		now: () => SHOP_RESET_WINDOW_SECONDS * 20, waitFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true,
		warnFn: () => {} });
	const allocations: { owner: Player; state: ReturnType<InventoryService["getState"]> }[] = [];
	const inventory = new InventoryService(data, progression, () => inBattle, (owner, state) => {
		assertStoredEqual(state, { ...inventory.getState(owner)!, allocationReason: state.allocationReason }, "alocação publica somente o estado final do destinatário");
		allocations.push({ owner, state });
	});
	const results: { owner: Player; payload: PurchaseResultPayload; state: PlayerSaveData | undefined }[] = [];
	const shop = new ShopService(data, () => inBattle, () => {}, () => {}, (owner) => inventory.sync(owner), (owner, payload) => {
		results.push({ owner, payload, state: data.getPlayerSaveSnapshot(owner) });
		if (failResult) error("falha injetada PurchaseResult");
	}, () => SHOP_RESET_WINDOW_SECONDS * 20, () => clock);
	assertInvariant(remotes.purchaseResult.Name === "PurchaseResult", "remote de resultado criado");
	const expectRefusal = (payload: unknown, reason: PurchaseReason, requestId: string, offerId: string) => {
		clock += 10;
		const before = data.getPlayerSaveSnapshot(player);
		const count = results.size();
		assertInvariant(!shop.requestPurchase(player, payload), "compra recusada");
		assertInvariant(results.size() === count + 1 && results[results.size() - 1].owner === player, "uma resposta só ao solicitante");
		assertStoredEqual(results[results.size() - 1].payload, { requestId, offerId, ok: false, reason }, "motivo fixo e correlação sem dados adicionais");
		assertStoredEqual(data.getPlayerSaveSnapshot(player), before, "recusa preserva saldo, inventário, time e contadores");
		assertStoredEqual(results[results.size() - 1].state, before, "resultado observa estado final da recusa");
	};
	expectRefusal({ requestId: "unloaded", offerId: "any" }, "erro", "unloaded", "any");
	assertInvariant(data.loadPlayer(player).ok && data.loadPlayer(other).ok, "duas sessões isoladas");
	const offer = shop.getOffers(player)![0];
	expectRefusal({ requestId: "balance", offerId: offer.offerId }, "saldo", "balance", offer.offerId);
	inBattle = true;
	expectRefusal({ requestId: "battle", offerId: offer.offerId }, "em_batalha", "battle", offer.offerId);
	inBattle = false;
	const foreign = shop.getOffers(other)![0].offerId;
	const otherBefore = data.getPlayerSaveSnapshot(other)!;
	for (const id of [foreign, "inventada"]) expectRefusal({ requestId: "private", offerId: id }, "oferta_invalida", "private", id);
	for (const requestId of [undefined, "", 1, string.rep("x", MAX_ITEM_UUID_LENGTH + 1)]) {
		expectRefusal({ requestId, offerId: offer.offerId }, "oferta_invalida", "", offer.offerId);
	}
	expectRefusal({ requestId: "extra", offerId: offer.offerId, price: 1 }, "oferta_invalida", "extra", offer.offerId);
	expectRefusal("invalid", "oferta_invalida", "", "");
	expectRefusal({ requestId: "bad-id", offerId: string.rep("x", MAX_ITEM_UUID_LENGTH + 1) }, "oferta_invalida", "bad-id", "");
	assertInvariant(data.addTinyes(player, 1000000), "saldo para resultados");
	const createSlot = progression as unknown as { createInventoryFighter: unknown };
	const create = createSlot.createInventoryFighter;
	progression.createInventoryFighter = () => error("falha injetada na entrega");
	expectRefusal({ requestId: "rollback", offerId: offer.offerId }, "erro", "rollback", offer.offerId);
	createSlot.createInventoryFighter = create;
	clock += 10;
	const before = data.getPlayerSaveSnapshot(player)!;
	assertInvariant(shop.requestPurchase(player, { requestId: "success", offerId: offer.offerId }), "compra confirmada");
	const success = results[results.size() - 1];
	assertStoredEqual(success.payload, { requestId: "success", offerId: offer.offerId, ok: true }, "sucesso correlacionado sem motivo");
	assertStoredEqual(success.state, data.getPlayerSaveSnapshot(player), "sucesso observa commit final");
	assertInvariant(success.state!.tinyes === before.tinyes - offer.price && success.state!.inventory.size() === before.inventory.size() + 1, "sucesso cobra e entrega exatamente uma vez");
	expectRefusal({ requestId: "duplicate", offerId: offer.offerId }, "oferta_invalida", "duplicate", offer.offerId);
	// Rajadas inválidas também consomem tokens; respostas não autorizam mutações extras.
	shop.forgetPlayer(player);
	for (let i = 0; i < SHOP_REQUEST_BUCKET_CAPACITY; i++) shop.requestPurchase(player, { requestId: "burst", offerId: "inventada" });
	const limited = data.getPlayerSaveSnapshot(player)!;
	const current = shop.getOffers(player)![0];
	assertInvariant(!shop.requestPurchase(player, { requestId: "limited", offerId: current.offerId }), "rate limit preservado");
	assertStoredEqual(results[results.size() - 1].payload, { requestId: "limited", offerId: current.offerId, ok: false, reason: "limite" }, "limite também responde");
	assertStoredEqual(data.getPlayerSaveSnapshot(player), limited, "limite não compra");
	// O bucket e as respostas são pessoais.
	assertInvariant(data.addTinyes(other, 1000000) && shop.requestPurchase(other, { requestId: "other", offerId: foreign }), "rajada de um jogador não bloqueia outro");
	assertInvariant(results[results.size() - 1].owner === other, "resultado privado do outro jogador");
	assertStoredEqual(data.getPlayerSaveSnapshot(player), limited, "compra alheia não muda o solicitante anterior");
	clock += 1;
	failResult = true;
	assertInvariant(shop.requestPurchase(player, { requestId: "send-failure", offerId: current.offerId }), "falha no resultado não desfaz commit");
	failResult = false;
	const delivered = data.getPlayerSaveSnapshot(player)!;
	expectRefusal({ requestId: "send-retry", offerId: current.offerId }, "oferta_invalida", "send-retry", current.offerId);
	assertStoredEqual(data.getPlayerSaveSnapshot(player), delivered, "retry não entrega duas vezes");

	// RequestAllocate existente responde pelo InventoryState, sem mudar o payload do pedido.
	const fighter = progression.createInventoryFighter(player, { ...offer, level: 10 });
	const low = progression.createInventoryFighter(player, { ...offer, level: 1 });
	const allocation = (payload: unknown, reason?: AllocationReason) => {
		clock += 10;
		const previous = progression.getPlayerData(player);
		const otherState = progression.getPlayerData(other);
		const count = allocations.size();
		remotes.processAllocateEvent(player, payload);
		assertInvariant(allocations.size() === count + 1, "alocação produz uma resposta");
		const response = allocations[allocations.size() - 1];
		assertInvariant(response.owner === player && response.state!.allocationReason === reason, "motivo de alocação fixo e privado");
		if (reason !== undefined) assertStoredEqual(progression.getPlayerData(player), previous, "recusa não aloca pontos");
		assertStoredEqual(progression.getPlayerData(other), otherState, "alocação não afeta outro jogador");
	};
	allocation({ itemUuid: low.itemUuid, stat: "atk", amount: 1 }, "sem_pontos");
	allocation({ itemUuid: fighter.itemUuid, stat: "atk", amount: 11 }, "cap_nivel");
	allocation({ itemUuid: fighter.itemUuid, stat: "atk", amount: 6 }, "par");
	allocation({ itemUuid: fighter.itemUuid, stat: "hp", amount: 6 }, "par");
	allocation({ itemUuid: otherBefore.inventory[0].itemUuid, stat: "atk", amount: 1 }, "invalido");
	for (const payload of [undefined, { itemUuid: fighter.itemUuid, stat: "bad", amount: 1 },
		{ itemUuid: fighter.itemUuid, stat: "atk", amount: 0 }, { itemUuid: fighter.itemUuid, stat: "atk", amount: math.huge },
		{ itemUuid: fighter.itemUuid, stat: "atk", amount: 1, extra: true }]) allocation(payload, "invalido");
	allocation({ itemUuid: fighter.itemUuid, stat: "atk", amount: 5 });
	assertInvariant(progression.getFighter(player, fighter.itemUuid)!.allocatedStats.atk === 5, "snapshot de sucesso contém pontos finais");
	allocation({ itemUuid: fighter.itemUuid, stat: "atk", amount: 1 }, "par");
	allocation({ itemUuid: fighter.itemUuid, stat: "dodge", amount: 1 });
	assertInvariant(allocations[allocations.size() - 1].state!.allocationReason === undefined, "sucesso limpa motivo anterior");
	remotes.forgetPlayer(player);
	const allocationBefore = progression.getPlayerData(player);
	for (let i = 0; i < ALLOCATE_REQUEST_BUCKET_CAPACITY; i++) remotes.processAllocateEvent(player, "invalid");
	const count = allocations.size();
	assertInvariant(!remotes.processAllocateEvent(player, { itemUuid: fighter.itemUuid, stat: "dodge", amount: 1 }), "rate limit da alocação preservado");
	assertInvariant(allocations.size() === count + 1 && allocations[allocations.size() - 1].state!.allocationReason === "invalido", "rate limit da alocação responde invalido");
	assertStoredEqual(progression.getPlayerData(player), allocationBefore, "rajada recusada não muda alocação");
	clock += 1 / ALLOCATE_REQUEST_REFILL_PER_SECOND;
	assertInvariant(remotes.processAllocateEvent(player, { itemUuid: fighter.itemUuid, stat: "dodge", amount: 1 }), "alocação volta após reposição");
	assertInvariant(allocations[allocations.size() - 1].state!.allocationReason === undefined, "reposição termina em sucesso");
	data.handlePlayerRemoving(player); data.handlePlayerRemoving(other);
	shop.forgetPlayer(player); shop.forgetPlayer(other);
	remotes.forgetPlayer(player); remotes.forgetPlayer(other);
	print("PURCHASE_AND_ALLOCATION_RESULTS_PASSED");
}

/** Fluxo real do Triggered, com inventário/DataStore isolados e Instances descartáveis. */
export function validateNpcBattles(): void {
	const npc = new Instance("Model");
	npc.Name = "BattleSimulatorNpc";
	const part = new Instance("Part");
	part.Anchored = true;
	part.Transparency = 1;
	part.CanCollide = false;
	part.Parent = npc;
	npc.PrimaryPart = part;
	const prompt = new Instance("ProximityPrompt");
	prompt.Name = "ExistingPrompt";
	prompt.Style = Enum.ProximityPromptStyle.Custom;
	prompt.Parent = npc;
	npc.SetAttribute("NpcId", "bronze_trainer");
	CollectionService.AddTag(npc, BATTLE_NPC_TAG);
	npc.Parent = Workspace;
	const definition = NPC_DATA.bronze_trainer;
	const describe = (side: BattleSide) => side.fighters.map((fighter) => ({
		fighterId: fighter.fighterId, level: fighter.level, stats: fighter.stats, slots: fighter.slots,
	}));
	const fixedTeam = describe(createNpcSide(definition, () => 0));
	assertStoredEqual(describe(createNpcSide(definition, () => 1)), fixedTeam, "rolls NPC independem do RNG de combate");

	for (const outcome of ["win", "loss", "quit", "disconnect", "error", "startError", "endError", "requestError", "respawn", "timeout"] as const) {
		const character = new Instance("Model");
		const root = new Instance("Part");
		root.Name = "HumanoidRootPart";
		root.Anchored = true;
		root.Parent = character;
		const humanoid = new Instance("Humanoid");
		humanoid.WalkSpeed = 23;
		humanoid.JumpPower = 61;
		humanoid.JumpHeight = 9;
		humanoid.UseJumpPower = outcome !== "win" && outcome !== "disconnect";
		humanoid.Parent = character;
		const usePower = humanoid.UseJumpPower;
		const removing = new Instance("BindableEvent");
		const attributes = new Map<string, AttributeValue>();
		const mock = {
			Parent: Players as Players | undefined, Name: "NpcTest", UserId: 991994,
			Character: character, CharacterRemoving: removing.Event,
			SetAttribute(name: string, value: AttributeValue): void { attributes.set(name, value); },
		};
		const player = mock as unknown as Player;
		const progression = new ProgressionService();
		const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(),
			serverId: "NpcTest", now: () => 1000, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true });
		const tinyes = new TinyesService(data, () => {});
		let started = 0;
		const ended: BattleEndedPayload[] = [];
		const adapter = createSurgicalMockAdapter({
			onBattleStarted: () => { if (outcome === "startError") error("NPC start error intencional"); started++; },
			onBattleEnded: (_, payload) => { if (outcome === "endError") error("NPC end error intencional"); ended.push(payload); },
		});
		const sessions = new BattleSessionService(adapter, tinyes, progression);
		let now = 0;
		const notices: NpcBattleNoticePayload[] = [];
		const service = new NpcService(sessions, data, progression, (_, message) => notices.push(message), () => now, () => 0.5);
		service.bindNpc(npc);
		service.bindNpc(npc);
		assertInvariant(npc.FindFirstChildWhichIsA("ProximityPrompt", true) === prompt && npc.GetDescendants().filter((x) => x.IsA("ProximityPrompt")).size() === 1,
			"reutiliza prompt sem duplicar");
		assertInvariant(prompt.ActionText === "Batalhar" && prompt.ObjectText === definition.displayName && prompt.MaxActivationDistance === NPC_PROMPT_MAX_DISTANCE,
			"configura prompt existente");
		assertInvariant((prompt.Style as Enum.ProximityPromptStyle) === Enum.ProximityPromptStyle.Default, "prompt Custom existente passa a mostrar a interface padrão com E");
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "recusa sem sessão carregada");
		assertInvariant(data.loadPlayer(player).ok, "load NPC");
		const item = progression.getPlayerData(player)!.inventory[0];
		const second = progression.createInventoryFighter(player, { fighterId: "anubis", baseStats: item.baseStats, skills: item.skills });
		assertInvariant(data.setActiveTeam(player, [second.itemUuid, item.itemUuid]), "time salvo personalizado");
		const selected = [second, item];
		const recordData = data as unknown as { sessions: Map<Player, { activeTeam: string[] }> };
		const saved = recordData.sessions.get(player)!;
		saved.activeTeam = [];
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "time vazio recusa sem sessão");
		assertInvariant(notices[notices.size() - 1].reason === "time_invalido", "aviso curto para time inválido");
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		progression.loadValidatedPlayerData(player, { version: PLAYER_DATA_SCHEMA_VERSION, inventory: [{ ...item, unavailable: true }] });
		saved.activeTeam = [item.itemUuid];
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "só unavailable recusa");
		progression.loadValidatedPlayerData(player, { version: PLAYER_DATA_SCHEMA_VERSION, inventory: [item, second] });
		data.setActiveTeam(player, [second.itemUuid, item.itemUuid]);
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		root.Position = part.Position.add(new Vector3(NPC_PROMPT_MAX_DISTANCE + 1, 0, 0));
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "longe recusa no servidor");
		root.Position = part.Position;
		assertInvariant(!service.trigger(player, npc), "debounce também limita tentativas recusadas");
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		mock.Parent = undefined;
		assertInvariant(!service.trigger(player, npc), "fora de Players recusa");
		mock.Parent = Players;
		const before = data.getPlayerSaveSnapshot(player)!;
		const created = service.trigger(player, npc);
		if (outcome !== "startError") {
			assertInvariant(created && sessions.hasActiveSession(player) && started === 1, "disparo válido cria uma sessão");
			assertInvariant(!service.trigger(player, npc) && started === 1, "disparo duplo não cria segunda sessão");
			now += NPC_PROMPT_DEBOUNCE_SECONDS;
			assertInvariant(!service.trigger(player, npc) && started === 1, "em batalha recusa mesmo após debounce");
			assertInvariant(humanoid.WalkSpeed === 0 && humanoid.JumpPower === 0 && humanoid.JumpHeight === 0 && attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === true,
				"movimento congelado para ambos os modos de salto");
			assertInvariant(prompt.Enabled, "prompt permanece habilitado no servidor");
			const record = (sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide]; aiControllers: AIService[] }[] }).activeSessions[0];
			assertInvariant(record.aiControllers.size() === 1, "IA Bronze anexada");
			for (let index = 0; index < selected.size(); index++) {
				const fighter = record.sides[0].fighters[index];
				assertInvariant(fighter.itemUuid === selected[index].itemUuid && fighter.level === selected[index].level, "UUID/nível e ordem do time salvo");
				assertStoredEqual(fighter.stats, calcEffectiveStats(selected[index].baseStats, selected[index].allocatedStats), "stats salvos usados na batalha");
				assertStoredEqual(fighter.slots, selected[index].skills, "rolls salvos sem rerrolar");
			}
			assertStoredEqual(describe(record.sides[1]), fixedTeam, "NPC idêntico entre sessões");
			if (outcome === "win") {
				const otherCharacter = character.Clone();
				const otherHumanoid = otherCharacter.FindFirstChildOfClass("Humanoid")!;
				otherHumanoid.WalkSpeed = 19;
				const otherRemoving = new Instance("BindableEvent");
				const other = { Parent: Players, Name: "OtherNpcTest", UserId: 991995,
					Character: otherCharacter, CharacterRemoving: otherRemoving.Event,
					SetAttribute(_name: string, _value: AttributeValue) {},
				} as unknown as Player;
				assertInvariant(data.loadPlayer(other).ok && service.trigger(other, npc), "mesmo NPC aceita segundo jogador durante batalha");
				const records = (sessions as unknown as { activeSessions: { sides: [BattleSide, BattleSide] }[] }).activeSessions;
				assertInvariant(records.size() === 2 && records[1].sides[1] !== record.sides[1], "sessões pessoais com instâncias de combate independentes");
				assertStoredEqual(describe(records[1].sides[1]), fixedTeam, "mesmos rolls para os dois jogadores");
				sessions.requestQuit(other);
				assertInvariant(otherHumanoid.WalkSpeed === 19 && sessions.hasActiveSession(player) && !sessions.hasActiveSession(other), "Quit alheio restaura somente o respectivo jogador");
				assertInvariant(prompt.Enabled && humanoid.WalkSpeed === 0, "NPC e primeira sessão continuam disponíveis/isolados");
				ended.clear(); // Resultado do segundo jogador não pertence à verificação de recompensa abaixo.
				data.handlePlayerRemoving(other);
				otherCharacter.Destroy();
				otherRemoving.Destroy();
			}
			// A batalha dura mais que o cooldown: a contagem deve começar somente no fim.
			now += definition.rematchCooldownSeconds * 2;
			if (outcome === "quit" || outcome === "disconnect") {
				const side = record.sides[0];
				const attacker = side.getActiveFighter();
				side.setAtb(10);
				assertInvariant(record.battle.requestSkill(side, 1), `${outcome}: ataque antes de sair`);
				for (let step = 0; step < 200 && record.battle.getDamageDealt(side, attacker.itemUuid!) === 0; step++) {
					sessions.step(SIMULATION_DT);
				}
				assertInvariant(record.battle.getDamageDealt(side, attacker.itemUuid!) > 0 && sessions.hasActiveSession(player),
					`${outcome}: causou dano real sem vencer antes de sair`);
			}
			if (outcome === "win" || outcome === "loss") {
				const winningSide = record.sides[outcome === "win" ? 0 : 1];
				const losingSide = record.sides[outcome === "win" ? 1 : 0];
				for (const fighter of losingSide.fighters) fighter.hp = 1;
				for (let step = 0; step < 200 && sessions.hasActiveSession(player); step++) {
					winningSide.setAtb(10);
					record.battle.requestSkill(winningSide, 1);
					sessions.step(SIMULATION_DT);
				}
				assertInvariant(!sessions.hasActiveSession(player), "fim natural pela morte de todo o time");
			} else if (outcome === "disconnect") {
				mock.Parent = undefined;
				sessions.destroySessionForPlayer(player);
			} else if (outcome === "error") {
				record.battle.step = () => error("NPC step error intencional");
				sessions.step(SIMULATION_DT);
			} else if (outcome === "requestError") {
				record.battle.requestSkill = () => error("NPC request error intencional");
				(sessions as unknown as { handleSkillRequest(player: Player, slot: SkillSlot): void }).handleSkillRequest(player, 1);
			} else if (outcome === "respawn") {
				removing.Fire(character);
				task.wait();
			} else if (outcome === "timeout") {
				for (const ai of record.aiControllers) ai.destroy();
				sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
			}
			else sessions.requestQuit(player);
			const after = data.getPlayerSaveSnapshot(player)!;
			record.battle.events.battleEnd.fire(record.sides[0]);
			sessions.requestQuit(player);
			assertStoredEqual(data.getPlayerSaveSnapshot(player), after, `${outcome}: segundo fim não paga novamente`);
			if (outcome === "win") {
				assertInvariant(after.tinyes - before.tinyes === 100 && ended.size() === 1 && ended[0].tinyesReward === 100,
					`vitória Bronze paga Tinyes uma vez (saldo=${after.tinyes - before.tinyes}, eventos=${ended.size()}, recompensa=${ended[0]?.tinyesReward}, vencedor=${ended[0]?.winnerSideId})`);
				assertInvariant(ended[0].xpRewards?.size() === 2, "vitória paga XP aos dois selecionados");
				for (const reward of ended[0].xpRewards!) assertInvariant(reward.xpGained === 48 && progression.getFighter(player, reward.itemUuid)?.xp === 48, "XP final usa média NPC 1,5 e divisão dupla");
			} else {
				assertInvariant(after.tinyes === before.tinyes, "sem vitória não paga Tinyes");
				assertStoredEqual(after.inventory, before.inventory, "sem vitória não paga XP");
			}
		} else assertInvariant(!created && started === 0, "falha no BattleStarted não deixa sessão parcial");
		assertInvariant(!sessions.hasActiveSession(player) && humanoid.WalkSpeed === 23 && humanoid.JumpPower === 61 && humanoid.JumpHeight === 9 && humanoid.UseJumpPower === usePower,
			`${outcome}: estado final restaura movimento original`);
		assertInvariant(attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false, `${outcome}: client liberado mesmo se remote falhar`);
		mock.Parent = Players;
		if (outcome === "win") {
			assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), `${outcome}: cooldown recusa sem criar sessão`);
			const cooldownNotice = notices[notices.size() - 1];
			assertInvariant(cooldownNotice.reason === "cooldown" && cooldownNotice.npcId === definition.npcId &&
				cooldownNotice.remainingSeconds === definition.rematchCooldownSeconds, `${outcome}: cooldown completo contado do fim`);
		} else {
			now += NPC_PROMPT_DEBOUNCE_SECONDS;
			const retried = service.trigger(player, npc);
			assertInvariant(notices[notices.size() - 1].reason !== "cooldown", `${outcome}: não gera cooldown`);
			assertInvariant(outcome === "startError" ? !retried : retried, `${outcome}: reencontro liberado sem vitória`);
			sessions.destroySessionForPlayer(player);
		}
		service.destroy();
		mock.Parent = Players;
		data.handlePlayerRemoving(player);
		character.Destroy();
		removing.Destroy();
	}
	npc.Destroy();
	print("NPC_BATTLES_PASSED");
}

/** Relógio manual: limites, isolamento e ambas as ordens de limpeza de PlayerRemoving. */
export function validateNpcRematchCooldown(): void {
	const primary = NPC_DATA.bronze_trainer;
	const secondaryId = "simulator_rematch_npc";
	const catalog = NPC_DATA as Record<string, NpcDefinition | undefined>;
	catalog[secondaryId] = { ...primary, npcId: secondaryId };
	const npcs = [primary.npcId, secondaryId].map((npcId) => {
		const part = new Instance("Part");
		part.Anchored = true;
		part.CanCollide = false;
		part.Transparency = 1;
		part.SetAttribute("NpcId", npcId);
		CollectionService.AddTag(part, BATTLE_NPC_TAG);
		part.Parent = Workspace;
		return part;
	});
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(), serverId: "NpcCooldown",
		now: () => 1000, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true });
	let started = 0;
	const sessions = new BattleSessionService(createSurgicalMockAdapter({ onBattleStarted: () => { started++; } }));
	let now = 0;
	const notices: { player: Player; payload: NpcBattleNoticePayload }[] = [];
	const service = new NpcService(sessions, data, progression,
		(player, payload) => notices.push({ player, payload }), () => now, () => 0.5);
	for (const npc of npcs) service.bindNpc(npc);
	const participants = [0, 1].map((index) => {
		const character = new Instance("Model");
		const root = new Instance("Part");
		root.Name = "HumanoidRootPart";
		root.Anchored = true;
		root.Position = npcs[0].Position;
		root.Parent = character;
		const humanoid = new Instance("Humanoid");
		humanoid.Parent = character;
		const removing = new Instance("BindableEvent");
		const mock = { Parent: Players as Players | undefined, Name: `Cooldown${index}`, UserId: 995100 + index,
			Character: character, CharacterRemoving: removing.Event,
			SetAttribute(_name: string, _value: AttributeValue): void {},
		};
		const player = mock as unknown as Player;
		assertInvariant(data.loadPlayer(player).ok, "load cooldown");
		return { mock, player, character, removing };
	});
	const a = participants[0].player;
	const b = participants[1].player;
	const expectBlocked = (player: Player, npc: Instance, remaining: number) => {
		const before = started;
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player) && started === before,
			`cooldown recusa sem BattleStarted/sessão: now=${now}, npc=${npc.GetAttribute("NpcId")}, jogador=${player.Name}`);
		const notice = notices[notices.size() - 1];
		assertInvariant(notice.player === player && notice.payload.reason === "cooldown" &&
			notice.payload.npcId === npc.GetAttribute("NpcId") && notice.payload.remainingSeconds === remaining,
			"aviso privado informa NPC e segundos restantes arredondados para cima");
	};
	const win = (player: Player) => {
		const record = (sessions as unknown as { activeSessions: { participants: { player: Player }[]; battle: BattleService; sides: [BattleSide, BattleSide] }[] })
			.activeSessions.find((session) => session.participants.some((participant) => participant.player === player))!;
		record.battle.events.battleEnd.fire(record.sides[0]);
		sessions.step(0);
	};
	try {
		assertInvariant(service.trigger(a, npcs[0]), "primeiro encontro liberado");
		now += primary.rematchCooldownSeconds * 2;
		win(a);
		const firstEnd = now;
		expectBlocked(a, npcs[0], primary.rematchCooldownSeconds);
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		assertInvariant(service.trigger(a, npcs[1]), "cooldown de um NPC não bloqueia outro");
		assertInvariant(service.trigger(b, npcs[0]), "cooldown de um jogador não bloqueia outro");
		win(a);
		win(b);
		now = firstEnd + primary.rematchCooldownSeconds - 0.25;
		expectBlocked(a, npcs[0], 1);
		now = firstEnd + primary.rematchCooldownSeconds;
		assertInvariant(service.trigger(a, npcs[0]), "libera exatamente ao vencer cooldown, sem wait");
		expectBlocked(b, npcs[0], NPC_PROMPT_DEBOUNCE_SECONDS);
		win(a);
		expectBlocked(a, npcs[0], primary.rematchCooldownSeconds);
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		assertInvariant(service.trigger(a, npcs[1]), "segundo NPC expira independentemente do novo cooldown do primeiro");
		win(a);

		// Callback de sessão antes da limpeza: saída apaga os dois NPCs e o debounce.
		service.handlePlayerRemoving(a);
		assertInvariant(service.trigger(a, npcs[0]), "reentrada zera cooldown do primeiro NPC e debounce");
		win(a);
		service.handlePlayerRemoving(a);
		assertInvariant(service.trigger(a, npcs[1]), "saída também apaga cooldown do segundo NPC");

		// Limpeza antes do callback: fim tardio não recria cooldown na reentrada.
		service.handlePlayerRemoving(a);
		participants[0].mock.Parent = undefined;
		sessions.destroySessionForPlayer(a);
		participants[0].mock.Parent = Players;
		assertInvariant(service.trigger(a, npcs[1]), "fim de desconexão após limpeza não repõe cooldown");
		win(a);
	} finally {
		for (const participant of participants) {
			sessions.destroySessionForPlayer(participant.player);
			service.handlePlayerRemoving(participant.player);
			data.handlePlayerRemoving(participant.player);
			participant.character.Destroy();
			participant.removing.Destroy();
		}
		service.destroy();
		for (const npc of npcs) npc.Destroy();
		catalog[secondaryId] = undefined;
	}
	print("NPC_REMATCH_COOLDOWN_PASSED");
}

/** Tetos independentes, migração v3 -> v4 e dano mínimo com hits reais, sem DataStore real. */
export function validatePvpDailyXpAndMinimumFight(): void {
	let userId = 994000;
	for (const outcome of ["partial", "partialThird", "full", "tinyesFull", "bothFull", "cap", "nearCap", "notifyError",
		"quitBelow", "quitExact", "disconnectBelow", "disconnectExact", "quitFew", "overkill", "opponentDamage"] as const) {
		const a = { Parent: Players, Name: outcome, UserId: userId++ } as unknown as Player;
		const b = { Parent: Players as Players | undefined, Name: "Opponent", UserId: userId++ };
		let now = PVP_DAY_SECONDS + 100;
		const store = new InMemoryDataStore();
		const progression = new ProgressionService();
		const options = { dataStore: store, serverId: "DailyXp", now: () => now, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true };
		let data = new PlayerDataService(progression, options);
		assertInvariant(data.loadPlayer(a).ok && data.loadPlayer(b as unknown as Player).ok, "load teto XP");
		const original = data.getPlayerSaveSnapshot(a)!;
		const inventory = [0, 1, 2].map(index => ({ ...original.inventory[0], itemUuid: `daily-${index}`,
			level: outcome === "cap" || outcome === "nearCap" ? (outcome === "nearCap" && index === 0 ? 29 : 30) : 1,
			xp: outcome === "nearCap" && index === 0 ? 2899 : 0 }));
		progression.loadValidatedPlayerData(a, { version: PLAYER_DATA_SCHEMA_VERSION, inventory });
		data.setActiveTeam(a, inventory.map(item => item.itemUuid));
		const state = (data as unknown as { sessions: Map<Player, { pvp: NonNullable<PlayerSaveData["pvp"]> }> }).sessions.get(a)!.pvp;
		const budget = outcome === "partial" ? 60 : outcome === "partialThird" ? 75 : outcome === "full" || outcome === "bothFull" ? 0 : PVP_DAILY_XP_CAP;
		state.dailyXp = PVP_DAILY_XP_CAP - budget;
		if (outcome === "tinyesFull" || outcome === "bothFull") state.dailyTinyes = PVP_DAILY_TINYES_CAP;
		const xpBefore = state.dailyXp;
		const before = data.getPlayerSaveSnapshot(a)!;
		const roll = { t: 0.5, cost: 1.875, mult: 1 };
		const timeline = { prepareTime: 0.1, hits: [0.1, 0.2, 0.3].map(time => ({ time, damageShare: 1, followUp: false })), returnTime: 0.1, dodgeReturnTime: 0.1 };
		const makeFighter = (item: FighterInventoryItem, atk: number) => new Fighter({ itemUuid: item.itemUuid, fighterId: item.fighterId,
			hp: 100, hpMax: 100, stats: { hp: 100, atk, crit: 0, dodge: 0 }, level: item.level, className: "Fury",
			slots: [roll, roll, roll], skillData: [timeline, timeline, timeline], currentAtbSpeed: 0 });
		const own = new BattleSide([makeFighter(inventory[0], outcome === "quitBelow" || outcome === "disconnectBelow" ? 48 : 50),
			makeFighter(inventory[1], 50), makeFighter(inventory[2], 50)], () => 0.5);
		const enemy = new BattleSide([makeFighter(original.inventory[0], 50), makeFighter(original.inventory[0], 50), makeFighter(original.inventory[0], 50)], () => 0.5);
		const ends = new Map<Player, BattleEndedPayload>();
		const sessions = new BattleSessionService(createSurgicalMockAdapter({ onBattleEnded: (player, payload) => { ends.set(player, payload); } }), new TinyesService(data, () => {}), progression);
		assertInvariant(sessions.createSession(a, b as unknown as Player, own, enemy, () => 0.5, "PVP"), "sessao teto XP");
		const record = (sessions as unknown as { activeSessions: { battle: BattleService; resolvedHits: number }[] }).activeSessions[0];
		const quitting = outcome === "quitBelow" || outcome === "quitExact" || outcome === "disconnectBelow" || outcome === "disconnectExact" || outcome === "quitFew" || outcome === "overkill" || outcome === "opponentDamage";
		if (quitting) {
			if (outcome === "overkill") enemy.fighters[0].hp = 1;
			const attacking = outcome === "opponentDamage" ? enemy : own;
			attacking.setAtb(10);
			assertInvariant(record.battle.requestSkill(attacking, 1), `${outcome}: inicia tres hits reais`);
			for (let step = 0; step < 30; step++) record.battle.step(SIMULATION_DT);
			assertInvariant(record.resolvedHits === (outcome === "overkill" ? 1 : 3), "somente hits realmente resolvidos");
			const realDamage = record.battle.getDamageDealt(own, inventory[0].itemUuid);
			if (outcome === "quitBelow" || outcome === "disconnectBelow") assertInvariant(realDamage === 72, "24% do HP total");
			if (outcome === "quitExact" || outcome === "disconnectExact") assertInvariant(realDamage === 75, "25% exatos do HP total");
			if (outcome === "overkill") assertInvariant(realDamage === 1, "overkill e hits ignorados excluidos do dano acumulado");
			if (outcome === "opponentDamage") assertInvariant(realDamage === 0, "dano do oponente nao conta para vencedor");
			if (outcome === "quitFew") record.resolvedHits = 2;
			if (outcome === "disconnectBelow" || outcome === "disconnectExact") { b.Parent = undefined; sessions.destroySessionForPlayer(b as unknown as Player); }
			else sessions.requestQuit(b as unknown as Player);
		} else {
			record.resolvedHits = 3;
			if (outcome === "notifyError") progression.onInventoryChanged = () => error("falha intencional apos commit XP");
			record.battle.events.battleEnd.fire(own);
		}
		const after = data.getPlayerSaveSnapshot(a)!;
		const pvpEnd = ends.get(a)!;
		const short = outcome === "quitBelow" || outcome === "disconnectBelow" || outcome === "quitFew" || outcome === "overkill" || outcome === "opponentDamage";
		if (short) {
			assertInvariant(pvpEnd.rewardBlockedReason === "luta_curta" && pvpEnd.tinyesReward === 0 && pvpEnd.xpRewards === undefined, `${outcome}: bloqueia ambas recompensas`);
			assertStoredEqual(after.inventory, before.inventory, "luta curta preserva inventario");
			assertStoredEqual(after.pvp, before.pvp, "luta curta preserva contadores");
		} else {
			const expectedXp = outcome === "partial" ? [45, 15, 0] : outcome === "partialThird" ? [45, 22, 8] :
				outcome === "cap" || budget === 0 ? [0, 0, 0] : outcome === "nearCap" ? [1, 0, 0] : outcome === "notifyError" ? [45, 0, 0] : [45, 22, 22];
			const total = expectedXp.reduce((sum, xp) => sum + xp, 0);
			assertInvariant(after.pvp!.dailyXp === xpBefore + total, `${outcome}: contabiliza somente XP util`);
			if (budget === 0) assertInvariant(pvpEnd.xpRewards === undefined && pvpEnd.rewardBlockedReason === "limite_diario_xp", "corte total explica limite XP");
			else if (outcome !== "notifyError") assertStoredEqual(pvpEnd.xpRewards!.map(reward => reward.xpGained), expectedXp, `${outcome}: corte deterministico por slot`);
			assertInvariant((pvpEnd.tinyesReward ?? 0) === (outcome === "tinyesFull" || outcome === "bothFull" ? 0 : 100), "teto XP nao bloqueia Tinyes");
			if (outcome === "tinyesFull") assertInvariant(pvpEnd.rewardBlockedReason === "limite_diario", "teto Tinyes permite XP");
		}
		record.battle.events.battleEnd.fire(own);
		assertStoredEqual(data.getPlayerSaveSnapshot(a), after, "recompensas e dailyXp pagos uma vez");
		progression.onInventoryChanged = undefined;
		assertInvariant(data.savePlayer(a).ok, "salva dailyXp");
		data.handlePlayerRemoving(a);
		data.handlePlayerRemoving(b as unknown as Player);
		data = new PlayerDataService(progression, options);
		assertInvariant(data.loadPlayer(a).ok, "carrega dailyXp em novo servico");
		assertStoredEqual(data.getPlayerSaveSnapshot(a)!.pvp, after.pvp, "dailyXp persiste apos save/load");
		assertStoredEqual(data.getPlayerSaveSnapshot(a)!.inventory, after.inventory, "inventario persiste junto com dailyXp");
		now = (math.floor(now / PVP_DAY_SECONDS) + 1) * PVP_DAY_SECONDS;
		assertInvariant(data.getRemainingPvpXp(a) === PVP_DAILY_XP_CAP && data.getPlayerSaveSnapshot(a)!.pvp!.dailyXp === 0, "virada do dia zera dailyXp");
		data.handlePlayerRemoving(a);
	}

	const legacyFighter: FighterInventoryItem = { itemUuid: "legacy-v3", fighterId: "jotaro", rarity: "Lendária", level: 4, xp: 80,
		baseStats: { hp: 16, atk: 11, dodge: 7, crit: 10 }, allocatedStats: { hp: 2, atk: 2, dodge: 1, crit: 1 },
		skills: [calcSkillSlotRoll(1, 0.33), calcSkillSlotRoll(2, 0.44), calcSkillSlotRoll(3, 0.55)] };
	const legacy = { version: 3, tinyes: 123, inventory: [legacyFighter], activeTeam: [legacyFighter.itemUuid], shopRestockCounts: [3, 4, 5],
		pvp: { pairs: { opponent: { count: 2, windowStart: 123 } }, dailyTinyes: 456, dayKey: 7 },
		sessionLock: { serverId: "legacy", sessionId: "legacy-session", timestamp: 124 } };
	assertInvariant(validatePlayerSaveData(legacy, 3).valid && !validatePlayerSaveData({ ...legacy, version: 4 }).valid, "v4 exige dailyXp");
	const migrated = migratePlayerData(legacy)!;
	assertInvariant(validatePlayerSaveData(migrated, 4).valid, "migração v3 -> v4 validada");
	assertStoredEqual(migrated, { ...legacy, version: 4, pvp: { ...legacy.pvp, dailyXp: 0 } }, "migração acrescenta somente dailyXp e versao");
	assertInvariant(!("dailyXp" in legacy.pvp), "migração nao altera origem");
	for (const dailyXp of [-1, 0.5, math.huge, -math.huge, 0 / 0, MAX_SAVED_NUMBER + 1, "0"]) {
		assertInvariant(!validatePlayerSaveData({ ...migrated, pvp: { ...legacy.pvp, dailyXp } }).valid, "dailyXp invalido rejeitado");
	}
	assertInvariant(validatePlayerSaveData({ ...migrated, pvp: { ...legacy.pvp, dailyXp: MAX_SAVED_NUMBER } }).valid, "dailyXp aceita MAX_SAVED_NUMBER");
	assertStoredEqual(migratePlayerData({ ...legacy, pvp: { ...legacy.pvp, dailyXp: 321 } })!.pvp, { ...legacy.pvp, dailyXp: 321 }, "migração preserva dailyXp existente");
	assertInvariant(migratePlayerData({ ...legacy, pvp: { ...legacy.pvp, dailyXp: -1 } }) === undefined, "migração valida novo campo");
	print("PVP_DAILY_XP_AND_MINIMUM_FIGHT_PASSED");
}

/** PVP: snapshots finais, dois destinatarios e estado persistido, sem DataStore real. */
export function validatePvpBattles(): void {
	assertInvariant(calcAverageLevel([1, 2, 3]) === 2 && calcAverageLevel([25, 26, 27, 28, 29, 30]) === 27.5, "media 3 contra 6");
	assertInvariant(calcAverageLevel([30]) === 30 && calcAverageLevel([1, 1, 1]) === 1, "media 1 contra 3 sem zeros");
	assertInvariant(calcRewardBracket(30).name === "Ouro" && calcRewardBracket(1).name === "Bronze" && calcRewardBracket(19.9).name === "Prata", "faixa do perdedor e limites fracionarios");
	let userId = 992100;
	const makePlayer = () => {
		const character = new Instance("Model");
		const root = new Instance("Part"); root.Name = "HumanoidRootPart"; root.Anchored = true; root.Parent = character;
		const humanoid = new Instance("Humanoid"); humanoid.WalkSpeed = 23; humanoid.JumpPower = 61; humanoid.JumpHeight = 9;
		humanoid.UseJumpPower = userId % 2 === 0; humanoid.Parent = character;
		const removing = new Instance("BindableEvent");
		const attributes = new Map<string, AttributeValue>();
		const mock = { Parent: Players as Players | undefined, Name: `PvpTest${userId}`, UserId: userId++, Character: character,
			CharacterRemoving: removing.Event, SetAttribute(name: string, value: AttributeValue): void { attributes.set(name, value); } };
		return { player: mock as unknown as Player, mock, root, humanoid, removing, attributes, character,
			usePower: humanoid.UseJumpPower };
	};
	const restored = (p: ReturnType<typeof makePlayer>) => assertInvariant(p.humanoid.WalkSpeed === 23 && p.humanoid.JumpPower === 61 &&
		p.humanoid.JumpHeight === 9 && p.humanoid.UseJumpPower === p.usePower, "movimento original restaurado");
	for (const roll of [0.1, 0.9]) {
		for (const outcome of ["victory", "quit", "disconnect", "timeout", "error", "short", "daily", "partial", "startError", "respawn", "endError"] as const) {
			const a = makePlayer(); const b = makePlayer();
			let now = 1000;
			const progression = new ProgressionService();
			const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(), serverId: "PvpTest", now: () => now,
				waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true });
			assertInvariant(data.loadPlayer(a.player).ok && data.loadPlayer(b.player).ok, "load dois jogadores");
			const original = progression.getPlayerData(b.player)!.inventory[0];
			progression.loadValidatedPlayerData(b.player, { version: PLAYER_DATA_SCHEMA_VERSION, inventory: [{ ...original, level: 30 }] });
			const starts = new Map<Player, BattleStartedPayload>();
			const ends = new Map<Player, BattleEndedPayload>();
			const sessions = new BattleSessionService(createSurgicalMockAdapter({
				onBattleStarted: (player, payload) => { if (outcome === "startError") error("PVP start intencional"); starts.set(player, payload); },
				onBattleEnded: (player, payload) => { if (outcome === "endError" && player === b.player) error("PVP end intencional"); ends.set(player, payload); },
			}), new TinyesService(data, () => {}), progression);
			let invite: ChallengeReceivedPayload | undefined;
			const statuses: ChallengeStatusPayload[] = [];
			const pvp = new PvpService(sessions, data, progression, (player, payload) => { assertInvariant(player === b.player, "convite privado"); invite = payload; },
				(_, payload) => statuses.push(payload), () => now, () => roll);
			assertInvariant(!pvp.challenge(a.player, a.player), "recusa si mesmo"); now += PVP_INVITE_INTERVAL_SECONDS;
			b.root.Position = new Vector3(PVP_PROMPT_MAX_DISTANCE + 1, 0, 0);
			assertInvariant(!pvp.challenge(a.player, b.player), "recusa longe"); now += PVP_INVITE_INTERVAL_SECONDS;
			b.root.Position = a.root.Position;
			const raw = data as unknown as { sessions: Map<Player, { activeTeam: string[] }> };
			const team = [...data.getActiveTeam(a.player)!]; raw.sessions.get(a.player)!.activeTeam = [];
			assertInvariant(!pvp.challenge(a.player, b.player), "recusa time vazio"); now += PVP_INVITE_INTERVAL_SECONDS;
			raw.sessions.get(a.player)!.activeTeam = team;
			const beforeA = data.getPlayerSaveSnapshot(a.player)!; const beforeB = data.getPlayerSaveSnapshot(b.player)!;
			assertInvariant(pvp.challenge(a.player, b.player) && invite !== undefined, "convite valido");
			assertInvariant(!pvp.challenge(b.player, a.player), "convite cruzado duplicado recusado");
			assertInvariant(!pvp.respond(a.player, { inviteId: invite!.inviteId, accept: true }), "desafiante nao pode aceitar");
			const accepted = pvp.respond(b.player, { inviteId: invite!.inviteId, accept: true });
			if (outcome !== "startError") {
				assertInvariant(accepted && sessions.hasActiveSession(a.player) && sessions.hasActiveSession(b.player), "dois jogadores na sessao");
				const record = (sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide]; resolvedHits: number; reason?: string }[] }).activeSessions[0];
				const ai = roll < 0.5 ? 0 : 1; const bi = ai === 0 ? 1 : 0;
				const own = record.sides[ai]; const enemy = record.sides[bi];
				assertStoredEqual(own.fighters.map(f => f.itemUuid), beforeA.activeTeam, "time A vem do inventario");
				assertStoredEqual(enemy.fighters.map(f => f.itemUuid), beforeB.activeTeam, "time B vem do inventario");
				assertStoredEqual(own.fighters[0].slots, beforeA.inventory[0].skills, "rolls sem alteracao");
				const ap = starts.get(a.player)!; const bp = starts.get(b.player)!;
				assertInvariant(ap.sides[0] === bp.sides[1] && ap.sides[1] === bp.sides[0] && ap.canPause === false && bp.canPause === false, "IDs reais com ordem privada");
				assertInvariant(ap.fighters.find(f => f.sideId === ap.sides[0])!.level === 1 && bp.fighters.find(f => f.sideId === bp.sides[0])!.level === 30, "cada client ve proprio time nos dois sorteios");
				assertInvariant(!sessions.requestPause(a.player), "PVP sem pause");
				// Pedidos usam o mapeamento Player -> BattleSide, nunca o ?ndice visual.
				const requests = sessions as unknown as { handleSkillRequest(player: Player, slot: SkillSlot): void };
				own.setAtb(10); enemy.setAtb(10);
				for (const fighter of [...own.fighters, ...enemy.fighters]) { fighter.hp = 100000; }
				requests.handleSkillRequest(b.player, 2);
				assertInvariant(enemy.atb < 10 && own.atb === 10, "B controla seu proprio lado");
				for (let i = 0; i < 150; i++) sessions.step(SIMULATION_DT);
				own.setAtb(10); requests.handleSkillRequest(a.player, 2);
				assertInvariant(own.atb < 10, "A controla seu proprio lado");
				for (let i = 0; i < 150; i++) sessions.step(SIMULATION_DT);
				assertInvariant(record.resolvedHits >= 3, "hits resolvidos reais contabilizados");
				// Nova captura nao pode substituir valores originais pelo zero.
				const releaseAgain = freezeBattleMovement(a.player, a.humanoid, () => {});
				if (outcome === "short") record.resolvedHits = 2;
				if (outcome === "daily" || outcome === "partial") {
					const state = (data as unknown as { sessions: Map<Player, { pvp: { dailyTinyes: number; dayKey: number } }> }).sessions.get(a.player)!;
					state.pvp.dailyTinyes = PVP_DAILY_TINYES_CAP - (outcome === "partial" ? 25 : 0);
					state.pvp.dayKey = math.floor(now / PVP_DAY_SECONDS);
				}
				if (outcome === "victory" || outcome === "short" || outcome === "daily" || outcome === "partial" || outcome === "endError") { record.battle.events.battleEnd.fire(own); sessions.step(0); }
				else if (outcome === "quit") sessions.requestQuit(b.player);
				else if (outcome === "disconnect") { b.mock.Parent = undefined; sessions.destroySessionForPlayer(b.player); }
				else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
				else if (outcome === "error") { record.battle.step = () => error("PVP step intencional"); sessions.step(SIMULATION_DT); }
				else { b.removing.Fire(b.character); task.wait(); }
				const after = data.getPlayerSaveSnapshot(a.player)!;
				const paid = outcome === "partial" || outcome === "victory" || outcome === "quit" || outcome === "disconnect" || outcome === "respawn" || outcome === "endError";
				const expected = outcome === "partial" ? 25 : paid ? 170 + math.floor(roll * 181) : 0;
				assertInvariant(after.tinyes - beforeA.tinyes === expected, `${outcome}: premio da faixa Ouro do perdedor`);
				assertInvariant(data.getTinyes(b.player) === beforeB.tinyes, "perdedor zero");
				const xpPaid = paid || outcome === "daily";
				if (!xpPaid) assertStoredEqual(after.inventory, beforeA.inventory, "PVP bloqueado nao paga XP");
				assertStoredEqual(data.getPlayerSaveSnapshot(b.player)!.inventory, beforeB.inventory, "perdedor nao recebe XP");
				assertInvariant(ends.get(b.player)?.xpRewards === undefined, "XP privado do vencedor");
				if (xpPaid) {
					assertInvariant(ends.get(a.player)?.xpRewards?.[0].xpGained === 708, "Lv1 vence Lv30: floor(525 * 1.35) = 708");
					assertInvariant(data.savePlayer(a.player).ok && data.loadPlayer(a.player).ok, "save/load XP PVP");
					assertStoredEqual(data.getPlayerSaveSnapshot(a.player)!.inventory, after.inventory, "XP PVP persiste");
					assertInvariant(data.getPlayerSaveSnapshot(a.player)!.pvp!.dailyXp === 708, "dailyXp PVP persiste");
				}
				assertInvariant((ends.get(a.player)?.tinyesReward ?? 0) === expected && (xpPaid || ends.get(a.player)?.xpRewards === undefined), "resultado privado XP");
				if (outcome === "short") assertInvariant(ends.get(a.player)?.rewardBlockedReason === "luta_curta", "bloqueio luta curta");
				assertInvariant(record.reason === (outcome === "short" || outcome === "daily" || outcome === "partial" || outcome === "endError" ? "victory" : outcome === "respawn" ? "disconnect" : outcome), "motivo registrado");
				record.battle.events.battleEnd.fire(own); sessions.requestQuit(b.player);
				assertStoredEqual(data.getPlayerSaveSnapshot(a.player), after, "pagamento unico");
				restored(a); restored(b);
				a.humanoid.WalkSpeed = 29; releaseAgain(); assertInvariant(a.humanoid.WalkSpeed === 29, "restauracao nunca roda duas vezes");
				if (outcome === "victory") {
					a.humanoid.WalkSpeed = 23;
					for (const win of [2, 3, 4]) {
						now += PVP_INVITE_INTERVAL_SECONDS;
						assertInvariant(pvp.challenge(a.player, b.player) && pvp.respond(b.player, { inviteId: invite!.inviteId, accept: true }), "revanche permitida mesmo sem premio");
						const rematch = (sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide]; resolvedHits: number }[] }).activeSessions[0];
						// Fixture da duracao: hits reais ja foram exercitados acima.
						rematch.resolvedHits = 3;
						rematch.battle.events.battleEnd.fire(rematch.sides[win === 4 ? bi : ai]);
						sessions.step(0);
						if (win === 2) assertInvariant(ends.get(a.player)?.tinyesReward === expected, "segunda vitoria paga");
						if (win === 3) assertInvariant(ends.get(a.player)?.tinyesReward === 0 && ends.get(a.player)?.rewardBlockedReason === "limite_par" && ends.get(a.player)?.xpRewards === undefined, "terceira vitoria bloqueada no BattleEnded");
						if (win === 4) assertInvariant(ends.get(b.player)?.xpRewards?.[0].xpGained === 0, "Lv30 no cap recebe zero XP util");
						if (win === 4) assertInvariant(data.getPlayerSaveSnapshot(b.player)!.pvp!.dailyXp === 0, "Lv30 nao consome teto diario XP");
						if (win === 4) assertInvariant(ends.get(b.player)?.tinyesReward === 50 + math.floor(roll * 101) && ends.get(a.player)?.tinyesReward === undefined, "Lv30 vence Lv1: Bronze e direcao independente");
						restored(a); restored(b);
					}
					assertInvariant(data.getTinyes(a.player) === beforeA.tinyes + expected * 2, "saldo final de tres vitorias limitado a dois premios");
				}
			} else assertInvariant(!accepted, "erro de criacao rejeita");
			assertInvariant(!sessions.hasActiveSession(a.player) && !sessions.hasActiveSession(b.player), "sessoes liberadas");
			if (outcome === "startError") { restored(a); restored(b); }
			assertInvariant(a.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false && b.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false, "atributos liberados");
			b.mock.Parent = Players;
			pvp.forgetPlayer(a.player); pvp.forgetPlayer(b.player);
			data.handlePlayerRemoving(a.player); data.handlePlayerRemoving(b.player);
			a.character.Destroy(); b.character.Destroy(); a.removing.Destroy(); b.removing.Destroy();
		}
	}
	assertInvariant(calcPostBattleTeamXp(1, true, [{ level: 30, damageDealt: 1 }])[0] === 4, "Lv30 contra Lv1: floor(90 * 0.05) = 4 antes do cap");
	print("PVP_BATTLES_PASSED");

	const a = makePlayer(); const b = makePlayer();
	let now = 1000;
	const store = new InMemoryDataStore(); const progression = new ProgressionService();
	const options = { dataStore: store, serverId: "PvpPersistence", now: () => now, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true };
	let data = new PlayerDataService(progression, options);
	assertInvariant(data.loadPlayer(a.player).ok && data.loadPlayer(b.player).ok, "load anti-farm");
	const sessions = new BattleSessionService(createSurgicalMockAdapter({}));
	let inviteId = "";
	const statuses: ChallengeStatusPayload[] = [];
	const pvp = new PvpService(sessions, data, progression, (_, p) => inviteId = p.inviteId, (_, p) => statuses.push(p), () => now);
	assertInvariant(pvp.challenge(a.player, b.player) && pvp.respond(b.player, { inviteId, accept: false }), "recusa convite");
	restored(a); restored(b); now += PVP_INVITE_INTERVAL_SECONDS;
	assertInvariant(!pvp.challenge(a.player, b.player), "espera apos recusa do mesmo par");
	now += PVP_DECLINE_WAIT_SECONDS;
	assertInvariant(pvp.challenge(a.player, b.player), "recusa libera ambos");
	now += PVP_INVITE_EXPIRY_SECONDS;
	assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }) && statuses.some(p => p.status === "expirado"), "aceite expirado recusado");
	restored(a); restored(b);
	assertInvariant(pvp.challenge(a.player, b.player), "expiracao libera ambos");
	b.root.Position = new Vector3(PVP_PROMPT_MAX_DISTANCE + 1, 0, 0);
	assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }), "aceite revalida distancia");
	restored(a); restored(b);
	b.root.Position = a.root.Position;
	for (const invalid of ["unavailable", "battle", "unloaded", "outside"] as const) {
		now += PVP_INVITE_EXPIRY_SECONDS;
		assertInvariant(pvp.challenge(a.player, b.player), "convite antes da mudanca de estado");
		const savedInventory = progression.getPlayerData(b.player)!;
		const dataInternals = data as unknown as { sessions: Map<Player, unknown> };
		const loadedSession = dataInternals.sessions.get(b.player);
		if (invalid === "unavailable") progression.loadValidatedPlayerData(b.player, { ...savedInventory, inventory: savedInventory.inventory.map(item => ({ ...item, unavailable: true })) });
		if (invalid === "battle") sessions.createSession(b.player, undefined, createDummySide(() => 0.5), createDummySide(() => 0.5), () => 0.5);
		if (invalid === "unloaded") dataInternals.sessions.delete(b.player);
		if (invalid === "outside") b.mock.Parent = undefined;
		assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }), `${invalid}: aceite revalida estado`);
		now += PVP_INVITE_EXPIRY_SECONDS; pvp.step();
		assertInvariant(!pvp.challenge(a.player, b.player), `${invalid}: convite tambem rejeita estado`);
		b.mock.Parent = Players;
		dataInternals.sessions.set(b.player, loadedSession);
		progression.loadValidatedPlayerData(b.player, savedInventory);
		// A reconciliacao remove unavailable de activeTeam; restaura somente a fixture.
		data.setActiveTeam(b.player, savedInventory.inventory.map(item => item.itemUuid));
		sessions.requestQuit(b.player);
		restored(a); restored(b);
	}
	now += PVP_INVITE_EXPIRY_SECONDS;
	assertInvariant(pvp.challenge(a.player, b.player), "convite para teste do bucket");
	for (let i = 0; i < 3; i++) assertInvariant(!pvp.respond(b.player, { inviteId, accept: "true" }), "boolean estrito");
	assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }) && !sessions.hasActiveSession(b.player), "rate limit proprio bloqueia resposta");
	now += 1;
	assertInvariant(pvp.respond(b.player, { inviteId, accept: false }), "bucket repoe e recusa libera ambos");
	const original = data.getPlayerSaveSnapshot(a.player)!;
	const legacy = { ...original, version: 2, pvp: undefined };
	const migrated = migratePlayerData(legacy, 3)!;
	assertInvariant(migrated.version === 3 && validatePlayerSaveData(migrated, 3).valid, "migracao uma versao v2 -> v3");
	assertStoredEqual(migrated.inventory, original.inventory, "migracao preserva inventario");
	assertStoredEqual(migrated.activeTeam, original.activeTeam, "migracao preserva time");
	assertStoredEqual(migrated.pvp, { pairs: {}, dailyTinyes: 0, dayKey: 0 }, "migracao zera apenas PVP");
	for (const invalid of [{ pairs: { x: { count: -1, windowStart: 0 } }, dailyTinyes: 0, dailyXp: 0, dayKey: 0 },
		{ pairs: {}, dailyTinyes: 0.5, dayKey: 0 }, { pairs: {}, dailyTinyes: 0, dayKey: -1 },
		{ pairs: [{ count: 1, windowStart: 0 }], dailyTinyes: 0, dailyXp: 0, dayKey: 0 }]) {
		assertInvariant(!validatePlayerSaveData({ ...original, pvp: invalid }).valid, "validacao PVP estrita");
	}
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).amount === 100, "primeira paga");
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).amount === 100, "segunda paga");
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).blockedReason === "limite_par", "terceira bloqueada");
	assertInvariant(data.awardPvpWin(b.player, a.player.UserId, 100).amount === 100, "direcao independente");
	assertInvariant(data.awardPvpWin(a.player, 1, 100).amount === 100, "outro oponente paga");
	assertInvariant(data.savePlayer(a.player).ok, "save cooldown");
	data.handlePlayerRemoving(a.player); data.handlePlayerRemoving(b.player);
	data = new PlayerDataService(progression, options);
	assertInvariant(data.loadPlayer(a.player).ok && data.awardPvpWin(a.player, b.player.UserId, 100).amount === 0, "reentrada preserva cooldown");
	now += PVP_PAIR_WINDOW_SECONDS;
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).amount === 100, "janela vencida volta a pagar");
	const raw = data as unknown as { sessions: Map<Player, { pvp: NonNullable<PlayerSaveData["pvp"]> }> };
	const state = raw.sessions.get(a.player)!.pvp;
	state.dailyTinyes = PVP_DAILY_TINYES_CAP - 25;
	assertInvariant(data.awardPvpWin(a.player, 2, 100).amount === 25 && data.getPlayerSaveSnapshot(a.player)!.pvp!.dailyTinyes === PVP_DAILY_TINYES_CAP, "teto corta premio");
	assertInvariant(data.awardPvpWin(a.player, 3, 100).blockedReason === "limite_diario", "teto bloqueia");
	now = (math.floor(now / PVP_DAY_SECONDS) + 1) * PVP_DAY_SECONDS;
	assertInvariant(data.awardPvpWin(a.player, 3, 100).amount === 100 && data.getPlayerSaveSnapshot(a.player)!.pvp!.dailyTinyes === 100, "novo dia zera");
	const full = raw.sessions.get(a.player)!.pvp;
	full.pairs = {};
	for (let i = 0; i < PVP_MAX_PAIR_ENTRIES; i++) full.pairs[tostring(i)] = { count: 1, windowStart: now };
	assertInvariant(data.awardPvpWin(a.player, 999999, 100).blockedReason === "limite_par", "limite de entradas nao remove janelas ativas");
	now += PVP_PAIR_WINDOW_SECONDS;
	assertInvariant(data.savePlayer(a.player).ok, "limpeza na escrita");
	assertStoredEqual(data.getPlayerSaveSnapshot(a.player)!.pvp!.pairs, {}, "janelas vencidas limpas");
	pvp.forgetPlayer(a.player); pvp.forgetPlayer(b.player); data.handlePlayerRemoving(a.player);
	a.character.Destroy(); b.character.Destroy(); a.removing.Destroy(); b.removing.Destroy();
	print("PVP_INVITES_AND_PERSISTENCE_PASSED");
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

function validateMultiHitDeath(): void {
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

export function runSimulation(): void {
	validateMultiHitDeath();
	validateBattleTeardownLifecycle();
	validateDayNightCycle();
	validateNpcBattles();
	validateNpcRematchCooldown();
	validatePvpBattles();
	validatePvpDailyXpAndMinimumFight();
	validatePurchaseAndAllocationResults();
	validateShopSynchronization();
	validateShop();
	validatePostBattleXp();
	validateS3Unlock();
	validateProgressionSnapshots();
	validateInventoryTestBattles();
	validateTinyesEconomy();
	validateSetRetryShutdownBudget();
	validateLoadGuardsAndInvalidLock();
	validateLeavingDuringLoad();
	validateCorruptionBackupAndInventory();
	validateSessionTokensAndConfirmations();
	validateCritDamageMultiplier();
	validateStatusEffectRules();
	validatePauseAndQuitRules();
	validateBronzeAI();
	validateXpCurveAndTeamDistribution();
	validateProgressionAndInventory();
	validatePlayerDataPersistence();
	validateCreateSessionRequiresPlayersParent();
	validateSessionErrorIsolation();
	validateSkillSlotValidation();
	validateItemUuidLength();
	validateTokenBucketRateLimit();
	validateSideTriggersRestrictions();
	validateTrocarIndexValidation();
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
	validateJotaroAndAnubis();
}
