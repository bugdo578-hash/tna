import { Players } from "@rbxts/services";
import {
	FLOAT_TOLERANCE, MAX_ITEM_UUID_LENGTH, MAX_SAVED_NUMBER, SHOP_LEVEL_WEIGHTS, SHOP_REQUEST_BUCKET_CAPACITY,
	SHOP_REQUEST_REFILL_PER_SECOND, SHOP_RESET_WINDOW_SECONDS, SHOP_SHELF_COUNT,
} from "../../shared/Config";
import { findFighterDefinition, getFighterDefinition, getRegisteredFighterIds, rollClassBaseStats } from "../../shared/FighterData";
import { calcOfferPrice, calcSkillSlotRoll, calcStatQuality } from "../../shared/MathUtils";
import type { ShopOffer } from "../../shared/TypeDefs";
import type { PurchaseReason, PurchaseResultPayload, ShopStatePayload } from "../../shared/Remotes";
import type { PlayerDataService } from "./PlayerDataService";

function cloneOffer(offer: ShopOffer): ShopOffer {
	return { ...offer, baseStats: { ...offer.baseStats },
		skills: [{ ...offer.skills[0] }, { ...offer.skills[1] }, { ...offer.skills[2] }] };
}

/** Estoque regenerável: somente os contadores persistem no registro do jogador. */
export class ShopService {
	private readonly buckets = new Map<Player, { tokens: number; time: number }>();
	private readonly windows = new Map<Player, number>();
	private readonly stock = new Map<Player, { keys: string[]; offers: ShopOffer[] }>();
	public constructor(
		private readonly data: PlayerDataService,
		private readonly inBattle: (player: Player) => boolean,
		private readonly send: (player: Player, payload: ShopStatePayload) => void,
		private readonly changed: (player: Player) => void,
		private readonly inventoryChanged: (player: Player) => void,
		private readonly result: (player: Player, payload: PurchaseResultPayload) => void,
		private readonly now: () => number = os.time,
		private readonly clock: () => number = os.clock,
	) {}

	public getOffers(player: Player): ShopOffer[] | undefined {
		return this.getOfferState(player)?.offers;
	}

	private getOfferState(player: Player): { window: number; offers: ShopOffer[] } | undefined {
		const counts = this.data.getShopRestockCounts(player);
		if (counts === undefined) return undefined;
		const window = math.floor(this.now() / SHOP_RESET_WINDOW_SECONDS);
		const cached = this.stock.get(player) ?? { keys: [], offers: [] };
		const offers: ShopOffer[] = [];
		for (let shelf = 0; shelf < SHOP_SHELF_COUNT; shelf++) {
			const key = `${player.UserId}:${window}:${shelf}:${counts[shelf]}`;
			if (cached.keys[shelf] === key) {
				offers.push(cloneOffer(cached.offers[shelf]));
				continue;
			}
			let seed = 0;
			for (let i = 1; i <= key.size(); i++) seed = (seed * 31 + string.byte(key, i)[0]) % 2147483647;
			const random = new Random(seed);
			const rng = () => random.NextNumber();
			const registeredIds = getRegisteredFighterIds();
			assert(registeredIds.size() > 0, "[Shop] FIGHTER_DATA sem lutadores registrados");
			const pickIndex = math.min(math.floor(math.clamp(rng(), 0, 1) * registeredIds.size()), registeredIds.size() - 1);
			const definition = getFighterDefinition(registeredIds[pickIndex]);
			const baseStats = rollClassBaseStats(definition.className, rng);
			const skills = [calcSkillSlotRoll(1, rng()), calcSkillSlotRoll(2, rng()), calcSkillSlotRoll(3, rng())] as const;
			const roll = rng();
			let cumulative = 0;
			let level = SHOP_LEVEL_WEIGHTS.size();
			for (let index = 0; index < SHOP_LEVEL_WEIGHTS.size(); index++) {
				cumulative += SHOP_LEVEL_WEIGHTS[index];
				if (roll < cumulative) { level = index + 1; break; }
			}
			// UUID no formato GUID, determinístico para a identidade desta oferta (sem itemUuid).
			let hex = "";
			for (let i = 0; i < 32; i++) hex += string.format("%x", random.NextInteger(0, 15));
			const offerId = `${hex.sub(1, 8)}-${hex.sub(9, 12)}-4${hex.sub(14, 16)}-8${hex.sub(18, 20)}-${hex.sub(21, 32)}`;
			offers.push({ offerId, fighterId: definition.fighterId, rarity: definition.rarity, level, baseStats, skills,
				price: calcOfferPrice(definition.rarity, calcStatQuality(definition.className, baseStats), level) });
			cached.keys[shelf] = key;
			cached.offers[shelf] = cloneOffer(offers[shelf]);
		}
		this.stock.set(player, cached);
		return { window, offers };
	}

	public sync(player: Player): void {
		if (player.Parent !== Players) return;
		const state = this.getOfferState(player);
		if (state !== undefined) this.sendState(player, state);
	}

	private sendState(player: Player, { window, offers }: { window: number; offers: ShopOffer[] }): void {
		this.windows.set(player, window);
		const published: ShopStatePayload["offers"][number][] = [];
		for (const offer of offers) {
			const definition = findFighterDefinition(offer.fighterId);
			if (definition === undefined) continue;
			published.push({
				offerId: offer.offerId, fighterId: definition.fighterId, displayName: definition.name,
				rarity: offer.rarity, className: definition.className, level: offer.level, baseStats: offer.baseStats,
				price: offer.price, slotCosts: [offer.skills[0].cost, offer.skills[1].cost, offer.skills[2].cost] as const,
			});
		}
		this.send(player, { offers: published });
	}

	public refresh(player: Player): void {
		if (player.Parent !== Players) return;
		const state = this.getOfferState(player);
		if (state !== undefined && this.windows.get(player) !== state.window) this.sendState(player, state);
	}

	public forgetPlayer(player: Player): void {
		this.buckets.delete(player);
		this.windows.delete(player);
		this.stock.delete(player);
	}

	public requestPurchase(player: Player, payload: unknown): boolean {
		if (player.Parent !== Players) return false;
		const record = typeIs(payload, "table") ? payload as Record<string, unknown> : undefined;
		// Nunca ecoar valores arbitrários: IDs ausentes/inválidos voltam como string vazia.
		const shortId = (value: unknown) => typeIs(value, "string") && value.size() > 0 && value.size() <= MAX_ITEM_UUID_LENGTH ? value : "";
		const requestId = shortId(record?.requestId);
		const offerId = shortId(record?.offerId);
		const [handled, outcome] = pcall(() => this.purchase(player, payload));
		const reason: PurchaseReason | undefined = handled ? outcome : "erro";
		if (!handled) warn(`[Shop] Compra userId=${player.UserId}: ${tostring(outcome)}`);
		const [sent, sendReason] = pcall(() => this.result(player, { requestId, offerId, ok: reason === undefined, reason }));
		if (!sent) warn(`[Shop] PurchaseResult userId=${player.UserId}: ${tostring(sendReason)}`);
		return reason === undefined;
	}

	private purchase(player: Player, payload: unknown): PurchaseReason | undefined {
		const counts = this.data.getShopRestockCounts(player);
		if (counts === undefined) return "erro";
		const time = this.clock();
		const bucket = this.buckets.get(player) ?? { tokens: SHOP_REQUEST_BUCKET_CAPACITY, time };
		bucket.tokens = math.min(SHOP_REQUEST_BUCKET_CAPACITY, bucket.tokens + math.max(0, time - bucket.time) * SHOP_REQUEST_REFILL_PER_SECOND);
		bucket.time = time;
		this.buckets.set(player, bucket);
		if (bucket.tokens + FLOAT_TOLERANCE < 1) return "limite";
		bucket.tokens = math.max(bucket.tokens - 1, 0);
		if (!typeIs(payload, "table")) return "oferta_invalida";
		const record = payload as Record<string, unknown>;
		for (const [key] of pairs(record)) if (key !== "offerId" && key !== "requestId") return "oferta_invalida";
		const id = record.offerId;
		const requestId = record.requestId;
		if (!typeIs(id, "string") || id.size() === 0 || id.size() > MAX_ITEM_UUID_LENGTH ||
			!typeIs(requestId, "string") || requestId.size() === 0 || requestId.size() > MAX_ITEM_UUID_LENGTH) return "oferta_invalida";
		if (this.inBattle(player)) return "em_batalha";
		const offers = this.getOffers(player);
		if (offers === undefined) return "erro";
		const shelf = offers.findIndex((offer) => offer.offerId === id);
		// Consulta apenas a loja pessoal; ID alheio, inventado, expirado ou comprado tem a mesma recusa.
		if (shelf < 0) return "oferta_invalida";
		if (counts[shelf] >= MAX_SAVED_NUMBER) return "limite";
		const balance = this.data.getTinyes(player);
		if (balance === undefined) return "erro";
		if (balance < offers[shelf].price) return "saldo";
		if (!this.data.purchaseShopOffer(player, shelf, counts[shelf], offers[shelf])) return "erro";
		// Estado já confirmado; falhas de apresentação não desfazem uma compra entregue.
		const [shopSent, shopReason] = pcall(() => this.sync(player));
		if (!shopSent) warn(`[Shop] ShopState pós-compra userId=${player.UserId} offerId=${id}: ${tostring(shopReason)}`);
		const [tinyesSent, tinyesReason] = pcall(() => this.changed(player));
		if (!tinyesSent) warn(`[Shop] TinyesChanged pós-compra userId=${player.UserId} offerId=${id}: ${tostring(tinyesReason)}`);
		const [inventorySent, inventoryReason] = pcall(() => this.inventoryChanged(player));
		if (!inventorySent) warn(`[Shop] InventoryState pós-compra userId=${player.UserId} offerId=${id}: ${tostring(inventoryReason)}`);
		return undefined;
	}
}
