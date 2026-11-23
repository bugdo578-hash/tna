// Validacao, migracao, clonagem profunda e DataStore em memoria de PlayerDataService.
import { PVP_DAY_SECONDS, PVP_DAILY_TINYES_CAP, PVP_DAILY_XP_CAP, PVP_MAX_PAIR_ENTRIES, PVP_PAIR_MAX_REWARDED_WINS, PVP_PAIR_WINDOW_SECONDS } from "../../shared/Config";
import type { PvpSaveData } from "../../shared/TypeDefs";
import { DataStoreService, HttpService, Players, RunService } from "@rbxts/services";
import {
	SHOP_SHELF_COUNT,
	ATB_COST_RANGES,
	BIND_TO_CLOSE_POLL_INTERVAL_SECONDS,
	BIND_TO_CLOSE_TIMEOUT_SECONDS,
	DATASTORE_MAX_RETRIES,
	DATASTORE_RETRY_BACKOFF_FACTOR,
	DATASTORE_RETRY_BASE_DELAY_SECONDS,
	DATASTORE_RETRY_MAX_DELAY_SECONDS,
	DEFAULT_STARTER_FIGHTER_ID,
	FLOAT_TOLERANCE,
	INITIAL_TINYES,
	LOGOUT_RETRY_MAX_BACKOFF_SECONDS,
	MAX_ACTIVE_TEAM_SIZE,
	MAX_LEVEL,
	MAX_SAVED_NUMBER,
	MIN_LEVEL,
	PLAYER_DATA_AUTOSAVE_INTERVAL_SECONDS,
	PLAYER_DATA_KEY_PREFIX,
	PLAYER_DATA_SCHEMA_VERSION,
	PLAYER_DATASTORE_NAME,
	SAVE_WAIT_TIMEOUT_SECONDS,
	SESSION_LOCK_EXPIRATION_SECONDS,
	SESSION_LOCK_KICK_MESSAGE,
	SESSION_LOCK_LOST_KICK_MESSAGE,
	SESSION_LOCK_WAIT_ATTEMPTS,
	SESSION_LOCK_WAIT_DELAY_SECONDS,
} from "../../shared/Config";
import { findFighterDefinition, rollClassBaseStats, type RealFighterId } from "../../shared/FighterData";
import { calcMult, calcSkillSlotRoll, isValidStatAllocation } from "../../shared/MathUtils";
import { calcAvailablePoints } from "../../shared/ProgressionMath";
import type {
	DuoMember,
	DuoState,
	FighterInventoryItem,
	PlayerSaveData,
	Rarity,
	SessionLockInfo,
	SkillSlot,
	SkillSlotRoll,
	SkillSlots,
	ShopOffer,
	StatBlock,
} from "../../shared/TypeDefs";
import type { PlayerProgressionData, ProgressionService } from "./ProgressionService";

export type { PlayerSaveData, SessionLockInfo } from "../../shared/TypeDefs";

/** Interface mínima compatível com `GlobalDataStore` e mocks determinísticos de teste. */
export interface DataStoreLike {
	UpdateAsync(key: string, transform: (oldValue: unknown) => unknown): unknown;
	SetAsync?(key: string, value: unknown): unknown;
}

/** Função de migração entre versões de schema (`version -> version + 1`). */
export type SchemaMigrationFn = (raw: Record<string, unknown>) => Record<string, unknown>;

/** Resultado detalhado de `loadPlayer`. */
export interface LoadPlayerResult {
	readonly ok: boolean;
	readonly status:
		| "LOADED"
		| "LOCKED"
		| "FALLBACK_MEMORY"
		| "RECOVERED_LAST_VALID"
		| "CORRUPTED"
		| "NETWORK_ERROR"
		| "REMOVED_DURING_LOAD";
	readonly data?: PlayerSaveData;
	readonly errorMessage?: string;
}

/** Resultado detalhado de `savePlayer`. */
export interface SavePlayerResult {
	readonly ok: boolean;
	readonly status: "SAVED" | "LOCKED_BY_OTHER" | "RETRY_SCHEDULED" | "NO_SESSION";
	readonly attempts: number;
	readonly errorMessage?: string;
}

/** Opções de configuração/injeção para `PlayerDataService` (produção e simulador). */
export interface PlayerDataServiceOptions {
	readonly dataStore?: DataStoreLike;
	readonly getDataStoreFn?: () => DataStoreLike;
	readonly isStudioFn?: () => boolean;
	readonly serverId?: string;
	readonly rng?: () => number;
	readonly now?: () => number;
	readonly waitFn?: (seconds: number) => void;
	readonly kickPlayer?: (player: Player, message: string) => void;
	readonly warnFn?: (message: string) => void;
	readonly printFn?: (message: string) => void;
	readonly schemaVersion?: number;
	readonly migrations?: ReadonlyMap<number, SchemaMigrationFn>;
	readonly maxRetries?: number;
	readonly retryBaseDelaySeconds?: number;
	readonly retryBackoffFactor?: number;
	readonly retryMaxDelaySeconds?: number;
	readonly logoutRetryMaxBackoffSeconds?: number;
	readonly lockExpirationSeconds?: number;
	readonly lockWaitAttempts?: number;
	readonly lockWaitDelaySeconds?: number;
	readonly autosaveIntervalSeconds?: number;
	readonly saveWaitTimeoutSeconds?: number;
	readonly starterFighterId?: RealFighterId;
	readonly forceStudioFallback?: boolean;
	readonly disableStudioAutoFallbackOnInjectedStore?: boolean;
}

export interface ActivePlayerSession {
	readonly sessionId: string;
	readonly player: Player;
	readonly userId: number;
	readonly key: string;
	readonly getProgressionData: () => PlayerProgressionData;
	tinyes: number;
	shopRestockCounts: number[];
	pvp: PvpSaveData;
	activeTeam: string[];
	version: number;
	lastPersistedLockTimestamp: number;
	mutationSeq: number;
	lastConfirmedMutationSeq: number;
	pendingRetrySave: boolean;
	retryTaskActive?: boolean;
	saving: boolean;
	closing: boolean;
}

export interface SnapshotMetadata {
	readonly userId: number;
	readonly key: string;
	readonly sessionId: string;
	readonly persisted: boolean;
	readonly lastPersistedTimestamp: number;
	readonly lastPersistedData?: PlayerSaveData;
	readonly lastPersistedMutationSeq: number;
	readonly isTestOverride?: boolean;
	readonly updatedAt: number;
}

export interface ValidationOutcome {
	readonly valid: boolean;
	readonly data?: PlayerSaveData;
	readonly reason?: string;
}

export function emptyPvpData(): PvpSaveData { return { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }; }
export function clonePvpData(data: PvpSaveData): PvpSaveData {
	const result: PvpSaveData = { pairs: {}, dailyTinyes: data.dailyTinyes, dailyXp: data.dailyXp ?? 0, dayKey: data.dayKey };
	for (const [key, entry] of pairs(data.pairs)) result.pairs[key] = { ...entry };
	return result;
}
export function cleanPvpData(data: PvpSaveData, now: number): PvpSaveData {
	const result = clonePvpData(data);
	for (const [key, entry] of pairs(result.pairs)) {
		if (now >= entry.windowStart + PVP_PAIR_WINDOW_SECONDS) delete result.pairs[key];
	}
	const dayKey = math.floor(now / PVP_DAY_SECONDS);
	if (result.dayKey !== dayKey) { result.dayKey = dayKey; result.dailyTinyes = 0; result.dailyXp = 0; }
	return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeOf(value) === "table";
}

export function isFiniteNumber(value: unknown): value is number {
	return typeOf(value) === "number" && (value as number) === (value as number) && (value as number) !== math.huge && (value as number) !== -math.huge;
}

function isDenseArray(value: unknown): boolean {
	if (!isRecord(value)) return false;
	let count = 0;
	let maximum = 0;
	for (const [rawKey] of pairs(value)) {
		const key: unknown = rawKey;
		if (!isFiniteNumber(key) || key < 1 || math.floor(key) !== key) return false;
		count += 1;
		maximum = math.max(maximum, key);
	}
	return count === maximum;
}

export function isNonNegativeInteger(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0 && value <= MAX_SAVED_NUMBER && math.floor(value) === value;
}

function isRarity(value: unknown): value is Rarity {
	return value === "Comum" || value === "Rara" || value === "Épica" || value === "Lendária";
}

function isDuoMember(value: unknown): value is DuoMember {
	return value === "Bruford" || value === "Tarkus";
}

export function cloneStatBlock(stats: StatBlock): StatBlock {
	return {
		hp: stats.hp,
		atk: stats.atk,
		dodge: stats.dodge,
		crit: stats.crit,
	};
}

function cloneSkillSlotRoll(roll: SkillSlotRoll): SkillSlotRoll {
	return {
		t: roll.t,
		cost: roll.cost,
		mult: roll.mult,
	};
}

export function cloneSkillSlots(skills: SkillSlots): SkillSlots {
	return [
		cloneSkillSlotRoll(skills[0]),
		cloneSkillSlotRoll(skills[1]),
		cloneSkillSlotRoll(skills[2]),
	];
}

function cloneDuoState(duo: DuoState | undefined): DuoState | undefined {
	if (duo === undefined) return undefined;
	return {
		activeMember: duo.activeMember,
		partnerHp: duo.partnerHp,
		partnerHpMax: duo.partnerHpMax,
		isSurvivor: duo.isSurvivor,
	};
}

export function cloneInventoryItem(item: FighterInventoryItem): FighterInventoryItem {
	return {
		itemUuid: item.itemUuid,
		fighterId: item.fighterId,
		unavailable: item.unavailable,
		rarity: item.rarity,
		level: item.level,
		xp: item.xp,
		baseStats: cloneStatBlock(item.baseStats),
		allocatedStats: cloneStatBlock(item.allocatedStats),
		skills: cloneSkillSlots(item.skills),
		equippedChip: item.equippedChip,
		duo: cloneDuoState(item.duo),
	};
}

export function clonePlayerSaveData(data: PlayerSaveData): PlayerSaveData {
	const inventory: FighterInventoryItem[] = [];
	for (const item of data.inventory) {
		inventory.push(cloneInventoryItem(item));
	}
	const activeTeam: string[] = [];
	for (const uuid of data.activeTeam) {
		activeTeam.push(uuid);
	}
	return {
		version: data.version,
		tinyes: data.tinyes,
		shopRestockCounts: data.shopRestockCounts !== undefined ? [...data.shopRestockCounts] : undefined,
		pvp: data.pvp !== undefined ? clonePvpData(data.pvp) : undefined,
		inventory,
		activeTeam,
		sessionLock:
			data.sessionLock !== undefined
				? {
						serverId: data.sessionLock.serverId,
						sessionId: data.sessionLock.sessionId,
						timestamp: data.sessionLock.timestamp,
					}
				: undefined,
	};
}

export function equalStoredValue(left: unknown, right: unknown): boolean {
	if (!isRecord(left) || !isRecord(right)) return left === right;
	for (const [key, value] of pairs(left)) {
		if (!equalStoredValue(value, right[key as string])) return false;
	}
	for (const [key] of pairs(right)) {
		if (left[key as string] === undefined) return false;
	}
	return true;
}

export function deepCloneUnknown(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const [k, v] of pairs(value)) {
		copy[k as string] = deepCloneUnknown(v);
	}
	return copy;
}

/** Implementação em memória compatível com `UpdateAsync` para fallback automático no Studio e testes. */
export class InMemoryDataStore implements DataStoreLike {
	private readonly storage = new Map<string, unknown>();

	public UpdateAsync(key: string, transform: (oldValue: unknown) => unknown): unknown {
		const existing = this.storage.get(key);
		const input = existing !== undefined ? deepCloneUnknown(existing) : undefined;
		const nextValue = transform(input);
		if (nextValue === undefined) {
			return undefined;
		}
		const stored = deepCloneUnknown(nextValue);
		this.storage.set(key, stored);
		return deepCloneUnknown(stored);
	}

	public SetAsync(key: string, value: unknown): unknown {
		const stored = deepCloneUnknown(value);
		this.storage.set(key, stored);
		return deepCloneUnknown(stored);
	}

	public getKeysForTest(): string[] {
		const keys: string[] = [];
		for (const [key] of this.storage) keys.push(key);
		return keys;
	}

	public peekRaw(key: string): unknown {
		const existing = this.storage.get(key);
		return existing !== undefined ? deepCloneUnknown(existing) : undefined;
	}

	public setRawForTest(key: string, rawValue: unknown): void {
		this.storage.set(key, deepCloneUnknown(rawValue));
	}
}

export function wrapGlobalDataStore(store: GlobalDataStore): DataStoreLike {
	const rawStore = store as unknown as {
		UpdateAsync(
			this: unknown,
			key: string,
			transform: (oldValue: unknown) => LuaTuple<[unknown]>,
		): LuaTuple<[unknown, unknown]>;
		SetAsync(this: unknown, key: string, value: unknown): unknown;
	};
	return {
		UpdateAsync(key: string, transform: (oldValue: unknown) => unknown): unknown {
			const [result] = rawStore.UpdateAsync(key, (oldValue: unknown) => {
				const updated = transform(oldValue);
				return $tuple(updated);
			});
			return result;
		},
		SetAsync(key: string, value: unknown): unknown {
			return rawStore.SetAsync(key, value);
		},
	};
}

export function validateStatBlock(raw: unknown, allowZeroBase: boolean): StatBlock | undefined {
	if (!isRecord(raw)) return undefined;
	const hp = raw.hp;
	const atk = raw.atk;
	const dodge = raw.dodge;
	const crit = raw.crit;
	if (!isFiniteNumber(hp) || !isFiniteNumber(atk) || !isFiniteNumber(dodge) || !isFiniteNumber(crit)) {
		return undefined;
	}
	if (allowZeroBase) {
		if (
			!isNonNegativeInteger(hp) ||
			!isNonNegativeInteger(atk) ||
			!isNonNegativeInteger(dodge) ||
			!isNonNegativeInteger(crit)
		) {
			return undefined;
		}
	} else {
		if (hp <= 0 || atk <= 0 || dodge < 0 || crit < 0 ||
			hp > MAX_SAVED_NUMBER || atk > MAX_SAVED_NUMBER || dodge > 100 || crit > 100) {
			return undefined;
		}
	}
	return { hp, atk, dodge, crit };
}

export function validateSkillSlotRoll(raw: unknown, slot: SkillSlot): SkillSlotRoll | undefined {
	if (!isRecord(raw)) return undefined;
	const t = raw.t;
	const cost = raw.cost;
	const mult = raw.mult;
	if (!isFiniteNumber(t) || !isFiniteNumber(cost) || !isFiniteNumber(mult)) {
		return undefined;
	}
	if (t < -FLOAT_TOLERANCE || t > 1 + FLOAT_TOLERANCE) {
		return undefined;
	}
	const costRange = ATB_COST_RANGES[slot];
	if (cost < costRange.min - FLOAT_TOLERANCE || cost > costRange.max + FLOAT_TOLERANCE) {
		return undefined;
	}
	if (mult <= 0 || mult < calcMult(slot, costRange.min) - FLOAT_TOLERANCE || mult > calcMult(slot, costRange.max) + FLOAT_TOLERANCE) {
		return undefined;
	}
	return { t, cost, mult };
}

export function validateFighterInventoryItem(raw: unknown, log: (message: string) => void): ValidationOutcome & { readonly item?: FighterInventoryItem } {
	if (!isRecord(raw)) {
		return { valid: false, reason: "item do inventário não é uma tabela" };
	}
	const itemUuid = raw.itemUuid;
	const fighterId = raw.fighterId;
	if (typeOf(itemUuid) !== "string" || (itemUuid as string).size() === 0) {
		return { valid: false, reason: "itemUuid ausente ou inválido" };
	}
	if (typeOf(fighterId) !== "string" || (fighterId as string).size() === 0) {
		return { valid: false, reason: `fighterId inválido no item ${itemUuid as string}` };
	}

	const rarity = raw.rarity;
	if (rarity !== undefined && !isRarity(rarity)) {
		return { valid: false, reason: `raridade inválida no item ${itemUuid as string}` };
	}

	const level = raw.level;
	if (!isNonNegativeInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
		return { valid: false, reason: `level fora do limite [1, 30] no item ${itemUuid as string}` };
	}

	const xp = raw.xp;
	if (!isFiniteNumber(xp) || xp < 0 || xp > MAX_SAVED_NUMBER) {
		return { valid: false, reason: `xp inválido no item ${itemUuid as string}` };
	}

	const baseStats = validateStatBlock(raw.baseStats, false);
	if (baseStats === undefined) {
		return { valid: false, reason: `baseStats corrompidos no item ${itemUuid as string}` };
	}

	const allocatedStats = validateStatBlock(raw.allocatedStats, true);
	if (allocatedStats === undefined) {
		return { valid: false, reason: `allocatedStats corrompidos no item ${itemUuid as string}` };
	}
	if (!isValidStatAllocation(allocatedStats, level) || calcAvailablePoints(level, allocatedStats) < 0) {
		return {
			valid: false,
			reason: `allocatedStats violam cap de nível ou trava de pares no item ${itemUuid as string}`,
		};
	}

	if (!isDenseArray(raw.skills) || (raw.skills as unknown[]).size() !== 3) {
		return { valid: false, reason: `skills ausentes no item ${itemUuid as string}` };
	}
	const rawSkills = raw.skills as unknown as ReadonlyArray<unknown>;
	const s1 = validateSkillSlotRoll(rawSkills[0], 1);
	const s2 = validateSkillSlotRoll(rawSkills[1], 2);
	const s3 = validateSkillSlotRoll(rawSkills[2], 3);
	if (s1 === undefined || s2 === undefined || s3 === undefined) {
		return { valid: false, reason: `rolls de skills corrompidos ou fora de limite no item ${itemUuid as string}` };
	}

	const equippedChip = raw.equippedChip;
	if (equippedChip !== undefined && typeOf(equippedChip) !== "string") {
		return { valid: false, reason: `equippedChip inválido no item ${itemUuid as string}` };
	}

	const unavailable = findFighterDefinition(fighterId) === undefined ? true : undefined;
	if (unavailable) log(`fighterId desconhecido ${fighterId as string}: item ${itemUuid as string} preservado e indisponível`);
	let duo: DuoState | undefined;
	if (raw.duo !== undefined) {
		const source = isRecord(raw.duo) ? raw.duo : {} as Record<string, unknown>;
		const hp = isFiniteNumber(source.partnerHp) ? math.clamp(source.partnerHp, 0, MAX_SAVED_NUMBER) : 0;
		const maxHp = isFiniteNumber(source.partnerHpMax) && source.partnerHpMax >= 0
			? math.min(source.partnerHpMax, MAX_SAVED_NUMBER) : hp;
		duo = {
			activeMember: isDuoMember(source.activeMember) ? source.activeMember : "Bruford",
			partnerHp: math.min(hp, maxHp),
			partnerHpMax: maxHp,
			isSurvivor: typeOf(source.isSurvivor) === "boolean" ? source.isSurvivor as boolean : undefined,
		};
		if (!equalStoredValue(raw.duo, duo)) log(`Duo normalizado no item ${itemUuid as string}`);
	}

	return {
		valid: true,
		item: {
			itemUuid: itemUuid as string,
			fighterId: fighterId as string,
			unavailable,
			rarity: rarity as Rarity | undefined,
			level,
			xp,
			baseStats,
			allocatedStats,
			skills: [s1, s2, s3],
			equippedChip: equippedChip as string | undefined,
			duo,
		},
	};
}

/**
 * Migra um registro bruto para `targetSchemaVersion` preservando integralmente
 * `itemUuid`, `baseStats`, `skills`, `level`, `xp` e `allocatedStats`.
 */
export function migratePlayerData(
	raw: unknown,
	targetSchemaVersion = PLAYER_DATA_SCHEMA_VERSION,
	customMigrations?: ReadonlyMap<number, SchemaMigrationFn>,
): Record<string, unknown> | undefined {
	if (!isRecord(raw)) return undefined;

	let working = deepCloneUnknown(raw) as Record<string, unknown>;
	let currentVersion = isNonNegativeInteger(working.version) ? working.version : 0;

	if (currentVersion > targetSchemaVersion) {
		return undefined;
	}

	while (currentVersion < targetSchemaVersion) {
		const nextVersion = currentVersion + 1;
		const customStep = customMigrations?.get(currentVersion);
		if (customStep !== undefined) {
			const stepped = customStep(deepCloneUnknown(working) as Record<string, unknown>);
			if (!isRecord(stepped)) {
				return undefined;
			}
			if (
				stepped.version !== undefined &&
				stepped.version !== nextVersion &&
				stepped.version !== currentVersion
			) {
				return undefined;
			}
			working = {
				...stepped,
				version: nextVersion,
			};
		} else if (currentVersion === 0) {
			// Migração v0 -> v1: preserva inventário existente sem rerrolar nada, garante tinyes e activeTeam
			const legacyCoins = isNonNegativeInteger(working.tinyes)
				? working.tinyes
				: isNonNegativeInteger(working.coins)
					? working.coins
					: INITIAL_TINYES;
			const legacyInventory = isRecord(working.inventory)
				? (working.inventory as unknown as unknown[])
				: isRecord(working.fighters)
					? (working.fighters as unknown as unknown[])
					: [];

			let activeTeam: string[] = [];
			if (isRecord(working.activeTeam)) {
				const rawTeam = working.activeTeam as unknown as unknown[];
				for (const entry of rawTeam) {
					if (typeOf(entry) === "string" && (entry as string).size() > 0 && activeTeam.size() < MAX_ACTIVE_TEAM_SIZE) {
						activeTeam.push(entry as string);
					}
				}
			}
			if (activeTeam.size() === 0) {
				for (const item of legacyInventory) {
					if (
						isRecord(item) &&
						typeOf(item.itemUuid) === "string" &&
						(item.itemUuid as string).size() > 0 &&
						activeTeam.size() < MAX_ACTIVE_TEAM_SIZE
					) {
						activeTeam.push(item.itemUuid as string);
					}
				}
			}

			working = {
				...working,
				version: 1,
				tinyes: legacyCoins,
				inventory: legacyInventory,
				activeTeam,
			};
		} else if (currentVersion === 1) {
			working = { ...working, version: 2, shopRestockCounts: [0, 0, 0] };
		} else if (currentVersion === 2) {
			working = { ...working, version: 3, pvp: { pairs: {}, dailyTinyes: 0, dayKey: 0 } };
		} else if (currentVersion === 3) {
			if (!isRecord(working.pvp)) return undefined;
			working = { ...working, version: 4, pvp: { ...working.pvp, dailyXp: working.pvp.dailyXp ?? 0 } };
		} else {
			return undefined;
		}

		const stepValidation = validatePlayerSaveData(working, nextVersion);
		if (!stepValidation.valid || stepValidation.data === undefined) {
			return undefined;
		}

		currentVersion = nextVersion;
	}

	return working;
}

/**
 * Valida estritamente um registro de `PlayerSaveData` (após migração).
 * Nunca rerrola `baseStats` nem `skills`.
 */
export function validatePlayerSaveData(
	raw: unknown,
	expectedSchemaVersion = PLAYER_DATA_SCHEMA_VERSION,
	log: (message: string) => void = (message) => warn(`[PlayerDataService] ${message}`),
): ValidationOutcome {
	if (!isRecord(raw)) {
		return { valid: false, reason: "registro raiz não é uma tabela" };
	}

	if (raw.version !== expectedSchemaVersion) {
		return {
			valid: false,
			reason: `versão de schema inválida (${tostring(raw.version)} !== ${expectedSchemaVersion})`,
		};
	}

	let pvp: PvpSaveData | undefined;
	if (expectedSchemaVersion >= 3) {
		if (!isRecord(raw.pvp) || !isRecord(raw.pvp.pairs) || !isNonNegativeInteger(raw.pvp.dailyTinyes) ||
			!isNonNegativeInteger(raw.pvp.dayKey) || raw.pvp.dailyTinyes > PVP_DAILY_TINYES_CAP) return { valid: false, reason: "pvp invalido" };
		if (expectedSchemaVersion >= 4 && !isNonNegativeInteger(raw.pvp.dailyXp)) return { valid: false, reason: "dailyXp invalido" };
		let count = 0;
		for (const [key, entry] of pairs(raw.pvp.pairs)) {
			if (!typeIs(key, "string") || key.size() === 0 || !isRecord(entry) ||
				!isNonNegativeInteger(entry.count) || entry.count > PVP_PAIR_MAX_REWARDED_WINS ||
				!isNonNegativeInteger(entry.windowStart)) return { valid: false, reason: "par PVP invalido" };
			count++;
		}
		if (count > PVP_MAX_PAIR_ENTRIES) return { valid: false, reason: "pares PVP excedidos" };
		pvp = clonePvpData(raw.pvp as unknown as PvpSaveData);
	}
	let shopRestockCounts: number[] | undefined;
	if (expectedSchemaVersion >= 2) {
		if (!isDenseArray(raw.shopRestockCounts)) return { valid: false, reason: "shopRestockCounts inválido" };
		const counts = raw.shopRestockCounts as number[];
		if (counts.size() !== SHOP_SHELF_COUNT || counts.some((count) => !isNonNegativeInteger(count))) {
			return { valid: false, reason: "contadores da loja inválidos" };
		}
		shopRestockCounts = [...counts];
	}

	if (!isNonNegativeInteger(raw.tinyes)) {
		return { valid: false, reason: "tinyes inválido ou negativo" };
	}

	if (!isDenseArray(raw.inventory)) {
		return { valid: false, reason: "inventory não é um array válido" };
	}

	const rawInventory = raw.inventory as unknown as ReadonlyArray<unknown>;
	const inventory: FighterInventoryItem[] = [];
	const seenUuids = new Set<string>();

	for (const rawItem of rawInventory) {
		const itemResult = validateFighterInventoryItem(rawItem, log);
		if (!itemResult.valid || itemResult.item === undefined) {
			return { valid: false, reason: itemResult.reason ?? "item de inventário inválido" };
		}
		if (seenUuids.has(itemResult.item.itemUuid)) {
			return { valid: false, reason: `itemUuid duplicado no inventário: ${itemResult.item.itemUuid}` };
		}
		seenUuids.add(itemResult.item.itemUuid);
		inventory.push(itemResult.item);
	}

	if (!isDenseArray(raw.activeTeam)) {
		return { valid: false, reason: "activeTeam não é um array válido" };
	}
	const rawActiveTeam = raw.activeTeam as unknown as ReadonlyArray<unknown>;
	if (rawActiveTeam.size() > MAX_ACTIVE_TEAM_SIZE) {
		return { valid: false, reason: `activeTeam excede o limite de ${MAX_ACTIVE_TEAM_SIZE} lutadores` };
	}

	const activeTeam: string[] = [];
	const seenTeamUuids = new Set<string>();
	for (const entry of rawActiveTeam) {
		if (typeOf(entry) !== "string" || (entry as string).size() === 0) {
			return { valid: false, reason: "activeTeam contém itemUuid inválido" };
		}
		const uuid = entry as string;
		if (!seenUuids.has(uuid)) {
			return { valid: false, reason: `activeTeam referencia itemUuid inexistente no inventário: ${uuid}` };
		}
		if (seenTeamUuids.has(uuid)) {
			return { valid: false, reason: `activeTeam contém itemUuid duplicado: ${uuid}` };
		}
		seenTeamUuids.add(uuid);
		activeTeam.push(uuid);
	}

	let sessionLock: SessionLockInfo | undefined;
	if (raw.sessionLock !== undefined) {
		if (
			!isRecord(raw.sessionLock) ||
			typeOf(raw.sessionLock.serverId) !== "string" ||
			!isNonNegativeInteger(raw.sessionLock.timestamp) ||
			(raw.sessionLock.sessionId !== undefined &&
				(typeOf(raw.sessionLock.sessionId) !== "string" || (raw.sessionLock.sessionId as string).size() === 0))
		) {
			return { valid: false, reason: "sessionLock malformado" };
		}
		sessionLock = {
			serverId: raw.sessionLock.serverId as string,
			sessionId: raw.sessionLock.sessionId as string | undefined,
			timestamp: raw.sessionLock.timestamp as number,
		};
	}

	return {
		valid: true,
		data: {
			version: expectedSchemaVersion,
			tinyes: raw.tinyes,
			shopRestockCounts,
			pvp,
			inventory,
			activeTeam,
			sessionLock,
		},
	};
}

