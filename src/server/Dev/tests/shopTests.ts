// Testes da loja rotativa, preços determinísticos, sincronização de estado e resultados de compra e alocação.
import { Players } from "@rbxts/services";
import { CLASS_DATA } from "../../../shared/ClassData";
import {
	ALLOCATE_REQUEST_BUCKET_CAPACITY,
	ALLOCATE_REQUEST_REFILL_PER_SECOND,
	FLOAT_TOLERANCE,
	MAX_ITEM_UUID_LENGTH,
	PLAYER_DATA_SCHEMA_VERSION,
	SHOP_PRICE_RANGES,
	SHOP_REQUEST_BUCKET_CAPACITY,
	SHOP_RESET_WINDOW_SECONDS,
} from "../../../shared/Config";
import { FIGHTER_DATA } from "../../../shared/FighterData";
import { calcOfferPrice, calcSkillSlotRoll, calcStatQuality } from "../../../shared/MathUtils";
import { calcAvailablePoints } from "../../../shared/ProgressionMath";
import type {
	AllocationReason,
	PurchaseReason,
	PurchaseResultPayload,
	ShopStatePayload,
} from "../../../shared/Remotes";
import type { FighterInventoryItem } from "../../../shared/TypeDefs";
import { InventoryService } from "../../Services/InventoryService";
import {
	InMemoryDataStore,
	migratePlayerData,
	PlayerDataService,
	validatePlayerSaveData,
	type DataStoreLike,
	type PlayerSaveData,
} from "../../Services/PlayerDataService";
import { ProgressionService } from "../../Services/ProgressionService";
import { RemoteService } from "../../Services/RemoteService";
import { ShopService } from "../../Services/ShopService";
import { TinyesService } from "../../Services/TinyesService";
import { assertInvariant, assertStoredEqual } from "./testHelpers";

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

export function validateShopSynchronization(): void {
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
