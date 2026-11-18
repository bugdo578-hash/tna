// Testes de persistência de dados do jogador, locks de sessão, tokens, backups de corrupção, saída durante load e orçamento de shutdown.
import { Players } from "@rbxts/services";
import {
	BIND_TO_CLOSE_TIMEOUT_SECONDS,
	DATASTORE_MAX_RETRIES,
	DATASTORE_RETRY_BACKOFF_FACTOR,
	DATASTORE_RETRY_BASE_DELAY_SECONDS,
	DEFAULT_STARTER_FIGHTER_ID,
	FLOAT_TOLERANCE,
	INITIAL_TINYES,
	LOGOUT_RETRY_MAX_BACKOFF_SECONDS,
	MAX_LEVEL,
	MIN_LEVEL,
	PLAYER_DATA_SCHEMA_VERSION,
	SAVE_WAIT_TIMEOUT_SECONDS,
	SESSION_LOCK_EXPIRATION_SECONDS,
	SESSION_LOCK_KICK_MESSAGE,
	SESSION_LOCK_LOST_KICK_MESSAGE,
	SESSION_LOCK_WAIT_ATTEMPTS,
} from "../../../shared/Config";
import { FIGHTER_DATA } from "../../../shared/FighterData";
import { calcSkillSlotRoll } from "../../../shared/MathUtils";
import { calcTotalPointsForLevel, calcXpForNextLevel } from "../../../shared/ProgressionMath";
import type { FighterInventoryItem, SkillSlots } from "../../../shared/TypeDefs";
import { PlayerDataService } from "../../Services/PlayerDataService";
import {
	InMemoryDataStore,
	migratePlayerData,
	validatePlayerSaveData,
	type DataStoreLike,
	type PlayerSaveData,
	type SchemaMigrationFn,
} from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { RemoteService } from "../../Services/RemoteService";
import {
	assertInvariant,
	assertStoredEqual,
	createSeededRng,
	findBackupKey,
	FIRST_SIMULATION_SEED,
	SpyProgressionService,
} from "./testHelpers";

export function validatePlayerDataPersistence(): void {
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


export function validateSessionTokensAndConfirmations(): void {
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

export function validateCorruptionBackupAndInventory(): void {
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

export function validateLeavingDuringLoad(): void {
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

export function validateLoadGuardsAndInvalidLock(): void {
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

export function validateSetRetryShutdownBudget(): void {
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
