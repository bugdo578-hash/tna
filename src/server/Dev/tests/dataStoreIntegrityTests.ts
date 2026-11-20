// Testes de integridade do DataStore (Lote J2 / C-01): esgotamento de load com kick e round-trip JSON de floats.
import { HttpService, Players } from "@rbxts/services";
import {
	INITIAL_TINYES,
	PLAYER_DATA_SCHEMA_VERSION,
	SESSION_LOCK_KICK_MESSAGE,
	SHOP_RESET_WINDOW_SECONDS,
} from "../../../shared/Config";
import { calcSkillSlotRoll } from "../../../shared/MathUtils";
import type { PlayerSaveData, SkillSlots } from "../../../shared/TypeDefs";
import { PlayerDataService } from "../../Services/PlayerDataService";
import {
	equalStoredValue,
	InMemoryDataStore,
	type DataStoreLike,
} from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { ShopService } from "../../Services/ShopService";
import { assertInvariant, assertStoredEqual, createSeededRng, FIRST_SIMULATION_SEED } from "./testHelpers";

interface KickRecord {
	readonly player: Player;
	readonly message: string;
}

class JsonRoundTripDataStore implements DataStoreLike {
	private readonly rawJson = new Map<string, string>();
	public roundTrips = 0;

	public UpdateAsync(key: string, transform: (oldValue: unknown) => unknown): unknown {
		const existingJson = this.rawJson.get(key);
		const oldValue = existingJson !== undefined ? HttpService.JSONDecode(existingJson) : undefined;
		const nextValue = transform(oldValue);
		if (nextValue === undefined) {
			return undefined;
		}
		const encoded = HttpService.JSONEncode(nextValue);
		this.rawJson.set(key, encoded);
		this.roundTrips += 1;
		return HttpService.JSONDecode(encoded);
	}

	public SetAsync(key: string, value: unknown): unknown {
		const encoded = HttpService.JSONEncode(value);
		this.rawJson.set(key, encoded);
		this.roundTrips += 1;
		return HttpService.JSONDecode(encoded);
	}

	public peekDecoded(key: string): unknown {
		const existingJson = this.rawJson.get(key);
		return existingJson !== undefined ? HttpService.JSONDecode(existingJson) : undefined;
	}
}

/**
 * C-01A: valida que o esgotamento das tentativas de confirmação em `loadPlayerInternal()`
 * expulsa o jogador exatamente uma vez com `SESSION_LOCK_KICK_MESSAGE`, registra diagnóstico,
 * não deixa sessão parcialmente inicializada e não libera indevidamente nenhum lock.
 */
export function validateLoadExhaustionKick(): void {
	// 1. Falha persistente de confirmação (UpdateAsync retorna nil em todas as tentativas)
	{
		const backing = new InMemoryDataStore();
		let updateCalls = 0;
		const unconfirmedStore: DataStoreLike = {
			UpdateAsync(key, transform) {
				updateCalls += 1;
				backing.UpdateAsync(key, transform);
				return undefined;
			},
			SetAsync(key, value) {
				return backing.SetAsync(key, value);
			},
		};
		const kicks: KickRecord[] = [];
		const warnings: string[] = [];
		const progression = new ProgressionService();
		const service = new PlayerDataService(progression, {
			dataStore: unconfirmedStore,
			serverId: "Server_C01A_Nil",
			rng: createSeededRng(FIRST_SIMULATION_SEED + 901),
			now: () => 20_000,
			waitFn: () => {},
			kickPlayer: (player, message) => kicks.push({ player, message }),
			warnFn: (message) => warnings.push(message),
			lockWaitAttempts: 2,
			disableStudioAutoFallbackOnInjectedStore: true,
		});

		const player = { Parent: Players, Name: "C01A_UnconfirmedNil", UserId: 910101 } as unknown as Player;
		const key = service.getPlayerKey(player.UserId);
		const result = service.loadPlayer(player);
		const callsAfterLoad = updateCalls;
		const rawAfterLoad = backing.peekRaw(key) as PlayerSaveData | undefined;

		assertInvariant(
			callsAfterLoad === 3 &&
				!result.ok &&
				result.status === "LOCKED" &&
				result.errorMessage === SESSION_LOCK_KICK_MESSAGE,
			"C-01A: esgotamento de confirmação deve tentar 1 + lockWaitAttempts vezes e retornar LOCKED",
		);
		assertInvariant(
			kicks.size() === 1 && kicks[0].player === player && kicks[0].message === SESSION_LOCK_KICK_MESSAGE,
			"C-01A: falha definitiva no load deve expulsar o jogador exatamente uma vez com SESSION_LOCK_KICK_MESSAGE",
		);
		assertInvariant(
			warnings.size() > 0,
			"C-01A: falha definitiva no load deve registrar aviso de diagnóstico",
		);
		assertInvariant(
			!service.isSessionLoaded(player) &&
				progression.getPlayerData(player) === undefined &&
				!service.hasLastValidSnapshot(player.UserId),
			"C-01A: falha definitiva no load não pode deixar sessão, progressão ou snapshot parcialmente inicializados",
		);

		const saveAfterFail = service.savePlayer(player, true);
		const removeAfterFail = service.handlePlayerRemoving(player);
		assertInvariant(
			!saveAfterFail.ok &&
				saveAfterFail.status === "NO_SESSION" &&
				!removeAfterFail.ok &&
				removeAfterFail.status === "NO_SESSION" &&
				updateCalls === callsAfterLoad,
			"C-01A: savePlayer/handlePlayerRemoving após falha definitiva não podem disparar UpdateAsync ou liberar lock",
		);
		assertStoredEqual(
			backing.peekRaw(key),
			rawAfterLoad,
			"C-01A: registro no DataStore permanece inalterado após tentativa de saída sem sessão",
		);
	}

	// 2. Falha persistente por payload divergente no retorno de UpdateAsync
	{
		const backing = new InMemoryDataStore();
		let updateCalls = 0;
		const mismatchedStore: DataStoreLike = {
			UpdateAsync(key, transform) {
				updateCalls += 1;
				const result = backing.UpdateAsync(key, transform);
				if (result !== undefined) {
					return { ...(result as PlayerSaveData), tinyes: 999_999 };
				}
				return undefined;
			},
			SetAsync(key, value) {
				return backing.SetAsync(key, value);
			},
		};
		const kicks: KickRecord[] = [];
		const warnings: string[] = [];
		const progression = new ProgressionService();
		const service = new PlayerDataService(progression, {
			dataStore: mismatchedStore,
			serverId: "Server_C01A_Mismatch",
			rng: createSeededRng(FIRST_SIMULATION_SEED + 902),
			now: () => 20_100,
			waitFn: () => {},
			kickPlayer: (player, message) => kicks.push({ player, message }),
			warnFn: (message) => warnings.push(message),
			lockWaitAttempts: 1,
			disableStudioAutoFallbackOnInjectedStore: true,
		});

		const player = { Parent: Players, Name: "C01A_Mismatch", UserId: 910102 } as unknown as Player;
		const result = service.loadPlayer(player);
		assertInvariant(
			updateCalls === 2 &&
				!result.ok &&
				result.status === "LOCKED" &&
				kicks.size() === 1 &&
				kicks[0].message === SESSION_LOCK_KICK_MESSAGE &&
				warnings.size() > 0 &&
				!service.isSessionLoaded(player) &&
				progression.getPlayerData(player) === undefined,
			"C-01A: retorno divergente persistente deve expulsar uma única vez, logar diagnóstico e não inicializar sessão",
		);
	}

	// 3. Preservação de lock alheio quando UpdateAsync aborta sem invocar transform
	{
		const backing = new InMemoryDataStore();
		const player = { Parent: Players, Name: "C01A_PreserveLock", UserId: 910103 } as unknown as Player;
		const seedService = new PlayerDataService(new ProgressionService(), {
			dataStore: backing,
			serverId: "Server_OtherOwner",
			rng: createSeededRng(FIRST_SIMULATION_SEED + 903),
			now: () => 20_200,
			waitFn: () => {},
			warnFn: () => {},
			disableStudioAutoFallbackOnInjectedStore: true,
		});
		const seedLoad = seedService.loadPlayer(player);
		assertInvariant(seedLoad.ok && seedLoad.data !== undefined, "C-01A: fixture com lock alheio deve carregar");
		const key = seedService.getPlayerKey(player.UserId);
		const lockedBefore = backing.peekRaw(key) as PlayerSaveData;

		let noopUpdates = 0;
		const noopStore: DataStoreLike = {
			UpdateAsync() {
				noopUpdates += 1;
				return undefined;
			},
		};
		const kicks: KickRecord[] = [];
		const warnings: string[] = [];
		const progression = new ProgressionService();
		const service = new PlayerDataService(progression, {
			dataStore: noopStore,
			serverId: "Server_C01A_Noop",
			now: () => 20_200,
			waitFn: () => {},
			kickPlayer: (p, msg) => kicks.push({ player: p, message: msg }),
			warnFn: (msg) => warnings.push(msg),
			lockWaitAttempts: 1,
			disableStudioAutoFallbackOnInjectedStore: true,
		});
		const result = service.loadPlayer(player);
		assertInvariant(
			noopUpdates === 2 &&
				!result.ok &&
				result.status === "LOCKED" &&
				kicks.size() === 1 &&
				kicks[0].message === SESSION_LOCK_KICK_MESSAGE &&
				warnings.size() > 0 &&
				!service.isSessionLoaded(player),
			"C-01A: falha definitiva sem transform deve expulsar uma vez e não criar sessão",
		);
		assertStoredEqual(
			backing.peekRaw(key),
			lockedBefore,
			"C-01A: lock ativo de outro servidor não pode ser liberado ou alterado",
		);
	}

	// 4. Retry transitório seguido de confirmação: NÃO deve expulsar durante retries normais
	{
		const backing = new InMemoryDataStore();
		let updateCalls = 0;
		const transientStore: DataStoreLike = {
			UpdateAsync(key, transform) {
				updateCalls += 1;
				const result = backing.UpdateAsync(key, transform);
				if (updateCalls === 1) {
					return undefined;
				}
				return result;
			},
			SetAsync(key, value) {
				return backing.SetAsync(key, value);
			},
		};
		const kicks: KickRecord[] = [];
		const progression = new ProgressionService();
		const service = new PlayerDataService(progression, {
			dataStore: transientStore,
			serverId: "Server_C01A_RetryOk",
			rng: createSeededRng(FIRST_SIMULATION_SEED + 904),
			now: () => 20_300,
			waitFn: () => {},
			kickPlayer: (p, msg) => kicks.push({ player: p, message: msg }),
			warnFn: () => {},
			lockWaitAttempts: 2,
			disableStudioAutoFallbackOnInjectedStore: true,
		});

		const player = { Parent: Players, Name: "C01A_RetryOk", UserId: 910104 } as unknown as Player;
		const loadRes = service.loadPlayer(player);
		assertInvariant(
			updateCalls === 2 &&
				loadRes.ok &&
				loadRes.status === "LOADED" &&
				kicks.size() === 0 &&
				service.isSessionLoaded(player) &&
				progression.getPlayerData(player) !== undefined,
			"C-01A: retry normal que confirma na tentativa seguinte não deve expulsar o jogador",
		);
		const leaveRes = service.handlePlayerRemoving(player);
		assertInvariant(
			leaveRes.ok && leaveRes.status === "SAVED" && kicks.size() === 0,
			"C-01A: sessão carregada após retry deve salvar e encerrar normalmente",
		);
	}

	print("LOAD_EXHAUSTION_KICK_PASSED");
}

/**
 * C-01B: testa round-trip real via `HttpService.JSONEncode()` + `HttpService.JSONDecode()`
 * no DataStore cobrindo carregamento inicial, floats reais de habilidades, operação de economia
 * (loja + Tinyes + PvP), salvamento e recarregamento.
 */
export function validateJsonRoundTripPersistence(): void {
	const jsonStore = new JsonRoundTripDataStore();
	let now = SHOP_RESET_WINDOW_SECONDS * 20 + 500;
	let clock = 10;
	const kicks: KickRecord[] = [];
	const warnings: string[] = [];

	const progressionA = new ProgressionService();
	const serviceA = new PlayerDataService(progressionA, {
		dataStore: jsonStore,
		serverId: "Server_Json_A",
		rng: createSeededRng(FIRST_SIMULATION_SEED + 911),
		now: () => now,
		waitFn: () => {},
		kickPlayer: (player, message) => kicks.push({ player, message }),
		warnFn: (message) => warnings.push(message),
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	const shopA = new ShopService(
		serviceA,
		() => false,
		() => {},
		() => {},
		() => {},
		() => {},
		() => now,
		() => clock,
	);

	const player = { Parent: Players, Name: "JsonRoundTripPlayer", UserId: 910201 } as unknown as Player;
	const key = serviceA.getPlayerKey(player.UserId);

	// 1. Carregamento inicial (starter com floats reais)
	const initialLoad = serviceA.loadPlayer(player);
	assertInvariant(
		initialLoad.ok &&
			initialLoad.status === "LOADED" &&
			initialLoad.data !== undefined &&
			initialLoad.data.version === PLAYER_DATA_SCHEMA_VERSION &&
			initialLoad.data.tinyes === INITIAL_TINYES &&
			jsonStore.roundTrips === 1 &&
			kicks.size() === 0 &&
			warnings.size() === 0,
		"C-01B: carregamento inicial com round-trip JSON deve confirmar sem erro",
	);

	// 2. Lutadores com floats reais de habilidades (dízimas, constantes irracionais e 53 bits de mantissa via Random)
	const trickyTs = [
		1 / 3,
		2 / 3,
		1 / 7,
		0.1 + 0.2,
		math.pi - 3,
		math.sqrt(2) - 1,
		1e-7,
		1 - 1e-12,
		0.588,
	];
	const fullPrecisionRng = new Random(20261120);
	for (let i = 0; i < 6; i++) {
		trickyTs.push(fullPrecisionRng.NextNumber());
	}
	for (let idx = 0; idx < trickyTs.size(); idx += 3) {
		const skills: SkillSlots = [
			calcSkillSlotRoll(1, trickyTs[idx]),
			calcSkillSlotRoll(2, trickyTs[idx + 1]),
			calcSkillSlotRoll(3, trickyTs[idx + 2]),
		];
		progressionA.createInventoryFighter(player, {
			fighterId: idx % 2 === 0 ? "anubis" : "jotaro",
			rarity: "Rara",
			baseStats: { hp: 14, atk: 10, dodge: 6, crit: 8 },
			skills,
		});
	}

	// 3. Operação real de economia: crédito de Tinyes + compra na loja (gera lutador com floats próprios) + vitória PvP
	shopA.sync(player);
	const offers = shopA.getOffers(player);
	assertInvariant(offers !== undefined && offers.size() === 3, "C-01B: loja deve gerar ofertas válidas");
	const chosenOffer = offers![0];
	assertInvariant(serviceA.addTinyes(player, chosenOffer.price + 500), "C-01B: deve creditar Tinyes");
	clock += 5;
	assertInvariant(
		shopA.requestPurchase(player, { requestId: "c01b-purchase-1", offerId: chosenOffer.offerId }),
		"C-01B: compra real na loja deve concluir",
	);
	const pvpReward = serviceA.awardPvpWin(player, 910299, 120);
	assertInvariant(pvpReward.amount === 120, "C-01B: recompensa PvP deve ser registrada");

	const expectedBeforeSave = serviceA.getPlayerSaveSnapshot(player)!;

	// 4. Salvamento intermediário (mantém lock) + verificação de confirmação exata após JSONEncode/JSONDecode
	const midSave = serviceA.savePlayer(player, false);
	assertInvariant(
		midSave.ok &&
			midSave.status === "SAVED" &&
			serviceA.isLastValidSnapshotPersisted(player.UserId) &&
			!serviceA.hasPendingRetrySave(player) &&
			kicks.size() === 0 &&
			warnings.size() === 0,
		"C-01B: salvamento com floats reais e operação de economia deve confirmar no round-trip JSON",
	);

	// 5. Salvamento de saída (libera lock)
	const leaveSave = serviceA.handlePlayerRemoving(player);
	const storedAfterLeave = jsonStore.peekDecoded(key) as PlayerSaveData;
	assertInvariant(
		leaveSave.ok &&
			leaveSave.status === "SAVED" &&
			!serviceA.isSessionLoaded(player) &&
			storedAfterLeave.sessionLock === undefined,
		"C-01B: salvamento de saída com round-trip JSON deve confirmar e liberar o lock",
	);
	shopA.forgetPlayer(player);

	// 6. Recarregamento em outro servidor sobre o mesmo DataStore JSON
	const progressionB = new ProgressionService();
	const serviceB = new PlayerDataService(progressionB, {
		dataStore: jsonStore,
		serverId: "Server_Json_B",
		rng: createSeededRng(FIRST_SIMULATION_SEED + 912),
		now: () => now + 10,
		waitFn: () => {},
		kickPlayer: (p, msg) => kicks.push({ player: p, message: msg }),
		warnFn: (msg) => warnings.push(msg),
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	const reload = serviceB.loadPlayer(player);
	assertInvariant(
		reload.ok &&
			reload.status === "LOADED" &&
			reload.data !== undefined &&
			serviceB.isLastValidSnapshotPersisted(player.UserId) &&
			kicks.size() === 0 &&
			warnings.size() === 0 &&
			jsonStore.roundTrips === 4,
		"C-01B: recarregamento após round-trip JSON deve confirmar exatamente sem kicks ou avisos",
	);

	// Compara todos os campos de negócio (exceto sessionLock, que pertence agora a Server_Json_B)
	const reloadedData = reload.data!;
	assertInvariant(
		reloadedData.tinyes === expectedBeforeSave.tinyes &&
			reloadedData.inventory.size() === expectedBeforeSave.inventory.size(),
		"C-01B: saldo e tamanho do inventário devem ser preservados integralmente após round-trip JSON",
	);
	assertStoredEqual(
		reloadedData.shopRestockCounts,
		expectedBeforeSave.shopRestockCounts,
		"C-01B: contadores da loja preservados após round-trip JSON",
	);
	assertStoredEqual(
		reloadedData.pvp,
		expectedBeforeSave.pvp,
		"C-01B: dados PvP preservados após round-trip JSON",
	);
	assertStoredEqual(
		reloadedData.activeTeam,
		expectedBeforeSave.activeTeam,
		"C-01B: activeTeam preservado após round-trip JSON",
	);
	assertStoredEqual(
		reloadedData.inventory,
		expectedBeforeSave.inventory,
		"C-01B: todos os lutadores e floats de skills (t, cost, mult) devem sobreviver bit-a-bit ao round-trip JSON",
	);

	// 7. Garante que equalStoredValue continua estrita para divergências materiais
	assertInvariant(
		!equalStoredValue(reloadedData, { ...reloadedData, tinyes: reloadedData.tinyes + 1 }),
		"C-01B: equalStoredValue deve rejeitar divergência de saldo",
	);
	assertInvariant(
		!equalStoredValue(reloadedData, {
			...reloadedData,
			sessionLock: {
				serverId: reloadedData.sessionLock!.serverId,
				sessionId: reloadedData.sessionLock!.sessionId,
				timestamp: reloadedData.sessionLock!.timestamp + 1,
			},
		}),
		"C-01B: equalStoredValue deve rejeitar divergência de sessionLock",
	);

	const finalLeave = serviceB.handlePlayerRemoving(player);
	assertInvariant(finalLeave.ok && finalLeave.status === "SAVED", "C-01B: encerramento final deve salvar normalmente");

	print("JSON_ROUND_TRIP_PERSISTENCE_PASSED");
}
