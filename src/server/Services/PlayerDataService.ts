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
import { FIGHTER_DATA, rollClassBaseStats, type RealFighterId } from "../../shared/FighterData";
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

interface ActivePlayerSession {
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

interface SnapshotMetadata {
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

function emptyPvpData(): PvpSaveData { return { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }; }
function clonePvpData(data: PvpSaveData): PvpSaveData {
	const result: PvpSaveData = { pairs: {}, dailyTinyes: data.dailyTinyes, dailyXp: data.dailyXp ?? 0, dayKey: data.dayKey };
	for (const [key, entry] of pairs(data.pairs)) result.pairs[key] = { ...entry };
	return result;
}
function cleanPvpData(data: PvpSaveData, now: number): PvpSaveData {
	const result = clonePvpData(data);
	for (const [key, entry] of pairs(result.pairs)) {
		if (now >= entry.windowStart + PVP_PAIR_WINDOW_SECONDS) delete result.pairs[key];
	}
	const dayKey = math.floor(now / PVP_DAY_SECONDS);
	if (result.dayKey !== dayKey) { result.dayKey = dayKey; result.dailyTinyes = 0; result.dailyXp = 0; }
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeOf(value) === "table";
}

function isFiniteNumber(value: unknown): value is number {
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

function isNonNegativeInteger(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0 && value <= MAX_SAVED_NUMBER && math.floor(value) === value;
}

function isRarity(value: unknown): value is Rarity {
	return value === "Comum" || value === "Rara" || value === "Épica" || value === "Lendária";
}

function isDuoMember(value: unknown): value is DuoMember {
	return value === "Bruford" || value === "Tarkus";
}

function cloneStatBlock(stats: StatBlock): StatBlock {
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

function cloneSkillSlots(skills: SkillSlots): SkillSlots {
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

function equalStoredValue(left: unknown, right: unknown): boolean {
	if (!isRecord(left) || !isRecord(right)) return left === right;
	for (const [key, value] of pairs(left)) {
		if (!equalStoredValue(value, right[key as string])) return false;
	}
	for (const [key] of pairs(right)) {
		if (left[key as string] === undefined) return false;
	}
	return true;
}

function deepCloneUnknown(value: unknown): unknown {
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

function wrapGlobalDataStore(store: GlobalDataStore): DataStoreLike {
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

function validateStatBlock(raw: unknown, allowZeroBase: boolean): StatBlock | undefined {
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

function validateSkillSlotRoll(raw: unknown, slot: SkillSlot): SkillSlotRoll | undefined {
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

function validateFighterInventoryItem(raw: unknown, log: (message: string) => void): ValidationOutcome & { readonly item?: FighterInventoryItem } {
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

	const unavailable = FIGHTER_DATA[fighterId as RealFighterId] === undefined ? true : undefined;
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

export class PlayerDataService {
	private readonly progressionService: ProgressionService;
	private dataStore: DataStoreLike;
	private readonly getDataStoreFn: () => DataStoreLike;
	private readonly isStudioFn: () => boolean;
	private readonly fallbackStore = new InMemoryDataStore();
	private usingMemoryFallback = false;
	private readonly allowStudioAutoFallback: boolean;
	private readonly serverId: string;
	private readonly rng: () => number;
	private readonly now: () => number;
	private readonly waitFn: (seconds: number) => void;
	private readonly kickPlayer: (player: Player, message: string) => void;
	private readonly warnFn: (message: string) => void;
	private readonly printFn: (message: string) => void;
	private readonly schemaVersion: number;
	private readonly migrations?: ReadonlyMap<number, SchemaMigrationFn>;
	private readonly maxRetries: number;
	private readonly retryBaseDelaySeconds: number;
	private readonly retryBackoffFactor: number;
	private readonly retryMaxDelaySeconds: number;
	private readonly logoutRetryMaxBackoffSeconds: number;
	private readonly lockExpirationSeconds: number;
	private readonly lockWaitAttempts: number;
	private readonly lockWaitDelaySeconds: number;
	private readonly autosaveIntervalSeconds: number;
	private readonly saveWaitTimeoutSeconds: number;
	private readonly starterFighterId: RealFighterId;

	private readonly sessions = new Map<Player, ActivePlayerSession>();
	private readonly retrySaveQueue = new Set<Player>();
	private readonly lastValidSnapshots = new Map<number, PlayerSaveData>();
	private readonly snapshotMetadata = new Map<number, SnapshotMetadata>();
	private readonly loadingUserIds = new Set<number>();
	private readonly loadingPlayers = new Set<Player>();
	private readonly removedDuringLoad = new Set<Player>();
	private readonly corruptionLogs: string[] = [];
	private readonly shutdownThreadElapsed = new Map<thread, number>();
	private hasCompletedFirstLoad = false;
	private nextSessionCounter = 0;
	private started = true;
	private autosaveStarted = false;
	private shuttingDown = false;
	private shutdownStartClock = 0;
	private shutdownDeadlineSeconds = BIND_TO_CLOSE_TIMEOUT_SECONDS;

	public constructor(progressionService: ProgressionService, options?: PlayerDataServiceOptions) {
		this.progressionService = progressionService;
		this.isStudioFn = options?.isStudioFn ?? (() => RunService.IsStudio());
		this.getDataStoreFn =
			options?.getDataStoreFn ??
			(() => wrapGlobalDataStore(DataStoreService.GetDataStore(PLAYER_DATASTORE_NAME)));
		this.serverId =
			options?.serverId ??
			(game.JobId !== "" ? game.JobId : `StudioServer_${HttpService.GenerateGUID(false)}`);
		this.rng = options?.rng ?? (() => math.random());
		this.now = options?.now ?? (() => os.time());
		this.waitFn = options?.waitFn ?? ((seconds: number) => task.wait(seconds));
		this.kickPlayer =
			options?.kickPlayer ??
			((player: Player, message: string) => {
				pcall(() => player.Kick(message));
			});
		this.warnFn = options?.warnFn ?? ((message: string) => warn(message));
		this.printFn = options?.printFn ?? ((message: string) => print(message));
		this.schemaVersion = options?.schemaVersion ?? PLAYER_DATA_SCHEMA_VERSION;
		this.migrations = options?.migrations;
		this.maxRetries = options?.maxRetries ?? DATASTORE_MAX_RETRIES;
		this.retryBaseDelaySeconds = options?.retryBaseDelaySeconds ?? DATASTORE_RETRY_BASE_DELAY_SECONDS;
		this.retryBackoffFactor = options?.retryBackoffFactor ?? DATASTORE_RETRY_BACKOFF_FACTOR;
		this.retryMaxDelaySeconds = options?.retryMaxDelaySeconds ?? DATASTORE_RETRY_MAX_DELAY_SECONDS;
		this.logoutRetryMaxBackoffSeconds =
			options?.logoutRetryMaxBackoffSeconds ?? LOGOUT_RETRY_MAX_BACKOFF_SECONDS;
		this.lockExpirationSeconds = options?.lockExpirationSeconds ?? SESSION_LOCK_EXPIRATION_SECONDS;
		this.lockWaitAttempts = options?.lockWaitAttempts ?? SESSION_LOCK_WAIT_ATTEMPTS;
		this.lockWaitDelaySeconds = options?.lockWaitDelaySeconds ?? SESSION_LOCK_WAIT_DELAY_SECONDS;
		this.autosaveIntervalSeconds = options?.autosaveIntervalSeconds ?? PLAYER_DATA_AUTOSAVE_INTERVAL_SECONDS;
		this.saveWaitTimeoutSeconds = options?.saveWaitTimeoutSeconds ?? SAVE_WAIT_TIMEOUT_SECONDS;
		this.starterFighterId = options?.starterFighterId ?? DEFAULT_STARTER_FIGHTER_ID;

		if (options?.forceStudioFallback === true) {
			if (this.isStudioFn()) {
				this.dataStore = this.fallbackStore;
				this.allowStudioAutoFallback = true;
				this.activateMemoryFallback("Fallback em memória forçado por configuração (Studio/Teste).");
			} else {
				this.allowStudioAutoFallback = false;
				this.dataStore = this.resolveInitialDataStore();
			}
		} else if (options?.dataStore !== undefined) {
			this.dataStore = options.dataStore;
			this.allowStudioAutoFallback = options.disableStudioAutoFallbackOnInjectedStore === false;
		} else {
			this.allowStudioAutoFallback = true;
			this.dataStore = this.resolveInitialDataStore();
		}
	}

	/** Inicia o loop de autosave periódico e registra o `game:BindToClose`. */
	public start(): void {
		if (this.autosaveStarted) return;
		this.autosaveStarted = true;
		this.started = true;

		task.spawn(() => {
			while (this.started && !this.shuttingDown) {
				this.waitFn(this.autosaveIntervalSeconds);
				if (!this.started || this.shuttingDown) break;
				this.autosaveAllPlayers();
			}
		});

		pcall(() => {
			game.BindToClose(() => {
				this.saveAllPlayersOnClose();
			});
		});
	}

	public isUsingMemoryFallback(): boolean {
		return this.usingMemoryFallback;
	}

	public getServerId(): string {
		return this.serverId;
	}

	public getCorruptionLogs(): readonly string[] {
		return this.corruptionLogs;
	}

	public getPlayerKey(userId: number): string {
		return `${PLAYER_DATA_KEY_PREFIX}${userId}`;
	}

	public isSessionLoaded(player: Player): boolean {
		return this.sessions.has(player);
	}

	public hasPendingRetrySave(player: Player): boolean {
		const session = this.sessions.get(player);
		return session !== undefined && (session.pendingRetrySave || this.retrySaveQueue.has(player));
	}

	public hasLastValidSnapshot(userId: number): boolean {
		return this.lastValidSnapshots.has(userId);
	}

	public getLastValidSnapshot(userId: number): PlayerSaveData | undefined {
		const snap = this.lastValidSnapshots.get(userId);
		return snap !== undefined ? clonePlayerSaveData(snap) : undefined;
	}

	public isLastValidSnapshotPersisted(userId: number): boolean {
		if (!this.lastValidSnapshots.has(userId)) return false;
		const meta = this.snapshotMetadata.get(userId);
		if (meta === undefined || !meta.persisted || meta.lastPersistedData === undefined) return false;
		for (const [, session] of this.sessions) {
			if (session.userId === userId && session.sessionId === meta.sessionId) {
				return equalStoredValue(
					this.buildSaveDataFromSession(session, meta.lastPersistedData.sessionLock),
					meta.lastPersistedData,
				);
			}
		}
		return false;
	}

	public getLastPersistedSnapshot(userId: number): PlayerSaveData | undefined {
		const meta = this.snapshotMetadata.get(userId);
		if (meta?.lastPersistedData === undefined) return undefined;
		return clonePlayerSaveData(meta.lastPersistedData);
	}

	public setLastValidSnapshotForTest(
		userId: number,
		rawSnapshot: unknown,
		metaOverrides?: {
			readonly userId?: number;
			readonly key?: string;
			readonly sessionId?: string;
			readonly persisted?: boolean;
			readonly lastPersistedTimestamp?: number;
		},
	): void {
		const clonedRaw = deepCloneUnknown(rawSnapshot) as PlayerSaveData;
		this.lastValidSnapshots.set(userId, clonedRaw);
		const existingMeta = this.snapshotMetadata.get(userId);
		const targetUserId = metaOverrides?.userId ?? existingMeta?.userId ?? userId;
		const targetKey = metaOverrides?.key ?? existingMeta?.key ?? this.getPlayerKey(targetUserId);
		const targetSessionId = metaOverrides?.sessionId ?? existingMeta?.sessionId ?? "test_session";
		const targetPersisted = metaOverrides?.persisted ?? existingMeta?.persisted ?? true;
		const targetTimestamp =
			metaOverrides?.lastPersistedTimestamp ??
			(isRecord(rawSnapshot) &&
			isRecord(rawSnapshot.sessionLock) &&
			isFiniteNumber(rawSnapshot.sessionLock.timestamp)
				? rawSnapshot.sessionLock.timestamp
				: (existingMeta?.lastPersistedTimestamp ?? this.now()));
		const fallbackPersistedData =
			existingMeta !== undefined ? existingMeta.lastPersistedData : clonedRaw;
		this.snapshotMetadata.set(userId, {
			userId: targetUserId,
			key: targetKey,
			sessionId: targetSessionId,
			persisted: targetPersisted,
			lastPersistedTimestamp: targetTimestamp,
			lastPersistedData: fallbackPersistedData,
			lastPersistedMutationSeq: existingMeta?.lastPersistedMutationSeq ?? 0,
			isTestOverride: true,
			updatedAt: this.now(),
		});
	}

	public getShopRestockCounts(player: Player): number[] | undefined {
		const session = this.sessions.get(player);
		return session !== undefined && !session.closing ? [...session.shopRestockCounts] : undefined;
	}

	/** Transação síncrona: nenhum callback, remote ou yield entre débito e entrega. */
	public purchaseShopOffer(player: Player, shelf: number, expectedCount: number, offer: ShopOffer): boolean {
		const session = this.sessions.get(player);
		if (session === undefined || session.closing || player.Parent !== Players ||
			shelf < 0 || shelf >= SHOP_SHELF_COUNT || math.floor(shelf) !== shelf ||
			session.shopRestockCounts[shelf] !== expectedCount || expectedCount >= MAX_SAVED_NUMBER ||
			!isNonNegativeInteger(offer.price) || offer.price <= 0 || session.tinyes < offer.price) return false;
		const before = session.getProgressionData();
		const balance = session.tinyes;
		session.tinyes -= offer.price;
		const [ok, result] = pcall(() => this.progressionService.createInventoryFighter(player, offer, false));
		if (!ok) {
			session.tinyes = balance;
			this.progressionService.loadValidatedPlayerData(player, before);
			this.warnFn(`[Shop] Compra revertida para ${player.UserId}: ${tostring(result)}`);
			return false;
		}
		session.shopRestockCounts[shelf] += 1;
		this.updateLastValidSnapshotFromSession(session);
		return true;
	}

	/** Commit unico em memoria: saldo, janela e teto sem callback/yield. Notificacao ocorre depois. */
	public awardPvpWin(player: Player, opponentUserId: number, requested: number): { amount: number; blockedReason?: "limite_par" | "limite_diario" } {
		const session = this.sessions.get(player);
		if (session === undefined || session.closing || player.Parent !== Players || !isNonNegativeInteger(requested) || requested === 0) return { amount: 0 };
		const now = this.now();
		const pvp = cleanPvpData(session.pvp, now);
		const key = tostring(opponentUserId);
		const entry = pvp.pairs[key];
		let entries = 0;
		for (const _ of pairs(pvp.pairs)) entries++;
		// Nunca expulsa janela ativa: isso permitiria contornar o limite alternando oponentes.
		if ((entry !== undefined && entry.count >= PVP_PAIR_MAX_REWARDED_WINS) || (entry === undefined && entries >= PVP_MAX_PAIR_ENTRIES)) return { amount: 0, blockedReason: "limite_par" };
		const remaining = PVP_DAILY_TINYES_CAP - pvp.dailyTinyes;
		if (remaining <= 0) return { amount: 0, blockedReason: "limite_diario" };
		const amount = math.min(requested, remaining, MAX_SAVED_NUMBER - session.tinyes);
		if (amount <= 0) return { amount: 0 };
		pvp.pairs[key] = { count: (entry?.count ?? 0) + 1, windowStart: entry?.windowStart ?? now };
		pvp.dailyTinyes += amount;
		session.pvp = pvp;
		session.tinyes += amount;
		this.updateLastValidSnapshotFromSession(session);
		return { amount, blockedReason: amount < requested && remaining < requested ? "limite_diario" : undefined };
	}

	public getTinyes(player: Player): number | undefined {
		return this.sessions.get(player)?.tinyes;
	}

	public getRemainingPvpXp(player: Player): number {
		const session = this.sessions.get(player);
		if (session === undefined || session.closing || player.Parent !== Players) return 0;
		session.pvp = cleanPvpData(session.pvp, this.now());
		return math.max(0, PVP_DAILY_XP_CAP - session.pvp.dailyXp);
	}

	/** Contabiliza somente o XP útil já incorporado ao inventário. */
	public recordPvpXp(player: Player, xpGained: number): void {
		const session = this.sessions.get(player);
		if (session === undefined || session.closing || !isNonNegativeInteger(xpGained)) return;
		session.pvp = cleanPvpData(session.pvp, this.now());
		session.pvp.dailyXp = math.min(MAX_SAVED_NUMBER, session.pvp.dailyXp + xpGained);
		this.updateLastValidSnapshotFromSession(session);
	}

	public onTinyesChanged?: (player: Player, balance: number, amount: number, reason: string) => void;

	public addTinyes(player: Player, amount: number, reason = "addTinyes"): boolean {
		if (!isNonNegativeInteger(amount) || amount <= 0) return false;
		const session = this.sessions.get(player);
		if (session === undefined || amount > MAX_SAVED_NUMBER - session.tinyes) return false;
		session.tinyes += amount;
		this.updateLastValidSnapshotFromSession(session);
		this.onTinyesChanged?.(player, session.tinyes, amount, reason);
		return true;
	}

	public trySpendTinyes(player: Player, amount: number, reason = "spendTinyes"): boolean {
		if (!isNonNegativeInteger(amount) || amount <= 0) return false;
		const session = this.sessions.get(player);
		if (session === undefined || session.tinyes < amount) return false;
		session.tinyes -= amount;
		this.updateLastValidSnapshotFromSession(session);
		this.onTinyesChanged?.(player, session.tinyes, -amount, reason);
		return true;
	}

	public getActiveTeam(player: Player): readonly string[] | undefined {
		const session = this.sessions.get(player);
		if (session === undefined) return undefined;
		this.reconcileActiveTeam(session);
		return [...session.activeTeam];
	}

	public setActiveTeam(player: Player, teamUuids: readonly string[]): boolean {
		const session = this.sessions.get(player);
		if (session === undefined) return false;
		if (teamUuids.size() === 0 || teamUuids.size() > MAX_ACTIVE_TEAM_SIZE) return false;

		const inventoryUuids = new Set<string>();
		for (const fighter of session.getProgressionData().inventory) {
			if (!fighter.unavailable) inventoryUuids.add(fighter.itemUuid);
		}

		const nextTeam: string[] = [];
		const seen = new Set<string>();
		for (const uuid of teamUuids) {
			if (typeOf(uuid) !== "string" || uuid.size() === 0) return false;
			if (!inventoryUuids.has(uuid) || seen.has(uuid)) return false;
			seen.add(uuid);
			nextTeam.push(uuid);
		}

		session.activeTeam = nextTeam;
		this.updateLastValidSnapshotFromSession(session);
		return true;
	}

	/** Retorna um snapshot imutável do estado atual do jogador (sincronizado com `ProgressionService`). */
	public getPlayerSaveSnapshot(player: Player): PlayerSaveData | undefined {
		const session = this.sessions.get(player);
		if (session === undefined) return undefined;
		return this.buildSaveDataFromSession(session, {
			serverId: this.serverId,
			sessionId: session.sessionId,
			timestamp: this.now(),
		});
	}

	/**
	 * Carrega os dados do jogador via `UpdateAsync` com session lock, migração de schema,
	 * validação contra corrupção, recuperação segura via `lastValidSnapshots` (`RECOVERED_LAST_VALID`),
	 * concessão de starter (se conta nova) e sincronização com `ProgressionService`.
	 */
	public loadPlayer(player: Player): LoadPlayerResult {
		const userId = this.resolveUserId(player);
		if (this.loadingUserIds.has(userId)) {
			this.kickPlayer(player, "Falha ao carregar seus dados. Tente entrar novamente.");
			return { ok: false, status: "LOCKED", errorMessage: "Load já em andamento para este jogador." };
		}
		for (const [otherPlayer, session] of this.sessions) {
			if (session.userId === userId && otherPlayer !== player) {
				this.kickPlayer(player, "Falha ao carregar seus dados. Tente entrar novamente.");
				return { ok: false, status: "LOCKED", errorMessage: "Jogador já possui sessão local." };
			}
		}
		this.loadingUserIds.add(userId);
		if (this.sessions.get(player)?.saving) {
			this.loadingUserIds.delete(userId);
			this.kickPlayer(player, "Falha ao carregar seus dados. Tente entrar novamente.");
			return { ok: false, status: "LOCKED", errorMessage: "Save em andamento." };
		}

		this.loadingPlayers.add(player);
		const [ok, resultOrErr] = pcall(() => this.loadPlayerInternal(player));
		this.loadingPlayers.delete(player);
		this.loadingUserIds.delete(userId);
		const removedDuringLoad = this.removedDuringLoad.has(player);
		this.removedDuringLoad.delete(player);
		if (!ok) {
			const errMsg = tostring(resultOrErr);
			const userId = this.resolveUserId(player);
			const key = this.getPlayerKey(userId);
			const existingSession = this.sessions.get(player);
			if (existingSession !== undefined) {
				this.warnFn(
					`[PlayerDataService] Erro inesperado ao recarregar ${key}: ${errMsg}. Preservando sessão já carregada em memória sem criar conta nova.`,
				);
				return {
					ok: false,
					status: "NETWORK_ERROR",
					errorMessage: errMsg,
				};
			}
			this.cleanupFailedLoadSession(player);
			const networkKickMessage =
				"Falha ao carregar seus dados devido a um erro de conexão. Tente novamente em instantes.";
			this.warnFn(
				`[PlayerDataService] Erro inesperado ao carregar ${key}: ${errMsg}. Expulsando jogador sem criar sessão.`,
			);
			this.kickPlayer(player, networkKickMessage);
			return {
				ok: false,
				status: "NETWORK_ERROR",
				errorMessage: errMsg,
			};
		}
		if (resultOrErr.ok && (removedDuringLoad || player.Parent !== Players)) {
			this.handlePlayerRemoving(player);
			return { ok: false, status: "REMOVED_DURING_LOAD" };
		}
		return resultOrErr;
	}

	private loadPlayerInternal(player: Player): LoadPlayerResult {
		const userId = this.resolveUserId(player);
		const key = this.getPlayerKey(userId);
		const maxLockChecks = 1 + math.max(0, this.lockWaitAttempts);

		const existingSession = this.sessions.get(player);
		const sessionId = existingSession?.sessionId ?? HttpService.GenerateGUID(false);
		if (existingSession !== undefined && this.usingMemoryFallback) {
			this.warnFn(
				`[PlayerDataService] Fallback em memória ativo para ${key}: mantendo sessão existente sem criar conta nova.`,
			);
			const currentSnapshot = this.buildSaveDataFromSession(existingSession, {
				serverId: this.serverId,
				sessionId: existingSession.sessionId,
				timestamp: this.now(),
			});
			this.fallbackStore.setRawForTest(key, currentSnapshot);
		}

		for (const lockAttempt of $range(1, maxLockChecks)) {
			let lockedByOtherServer = false;
			let recoveredFromCorruption = false;
			let corruptionReason: string | undefined;
			let corruptedRawSnapshot: unknown;
			let corruptedTimestamp = 0;
			let loadedData: PlayerSaveData | undefined;
			let persistedTimestamp = 0;

			const updateResult = this.executeUpdateWithRetry(key, (oldValue: unknown) => {
				lockedByOtherServer = false;
				recoveredFromCorruption = false;
				corruptionReason = undefined;
				corruptedRawSnapshot = undefined;
				corruptedTimestamp = 0;
				loadedData = undefined;
				persistedTimestamp = 0;

				const currentTime = this.now();

				let valueToLoad = oldValue;
				if (isRecord(oldValue) && isRecord(oldValue.sessionLock)) {
					const existingServerId = oldValue.sessionLock.serverId;
					const existingTimestamp = oldValue.sessionLock.timestamp;
					if (!isFiniteNumber(existingTimestamp) || !isNonNegativeInteger(existingTimestamp)) {
						this.warnFn(`[PlayerDataService] Session lock sem timestamp válido para ${key}. Tratando como expirado.`);
						const sanitized = { ...oldValue };
						delete sanitized.sessionLock;
						valueToLoad = sanitized;
					}
					if (
						valueToLoad === oldValue &&
						typeOf(existingServerId) === "string" &&
						(existingServerId as string).size() > 0 &&
						(existingServerId !== this.serverId ||
							(oldValue.sessionLock.sessionId !== undefined && oldValue.sessionLock.sessionId !== sessionId))
					) {
						const lockAge = isFiniteNumber(existingTimestamp) ? currentTime - existingTimestamp : 0;
						if (lockAge < this.lockExpirationSeconds) {
							lockedByOtherServer = true;
							return undefined;
						}
						this.warnFn(
							`[PlayerDataService] Session lock expirado (${lockAge}s >= ${this.lockExpirationSeconds}s) do servidor ${existingServerId} para ${key}. Assumindo sessão.`,
						);
					}
				}

				const lockInfo: SessionLockInfo = {
					sessionId,
					serverId: this.serverId,
					timestamp: currentTime,
				};

				if (oldValue === undefined) {
					const fresh = this.createDefaultSaveData(lockInfo, true);
					loadedData = fresh;
					persistedTimestamp = currentTime;
					return clonePlayerSaveData(fresh);
				}

				const migrated = migratePlayerData(valueToLoad, this.schemaVersion, this.migrations);
				const validation =
					migrated !== undefined
						? validatePlayerSaveData(migrated, this.schemaVersion, this.warnFn)
						: { valid: false, reason: "falha na migração de versão ou formato irreconhecível" };

				if (!validation.valid || validation.data === undefined) {
					recoveredFromCorruption = true;
					const reason = validation.reason ?? "dados corrompidos";
					corruptionReason = reason;
					corruptedRawSnapshot = deepCloneUnknown(oldValue);
					corruptedTimestamp = currentTime;
					return undefined;
				}

				const validData: PlayerSaveData = {
					version: validation.data.version,
					tinyes: validation.data.tinyes,
					shopRestockCounts: validation.data.shopRestockCounts !== undefined ? [...validation.data.shopRestockCounts] : undefined,
					pvp: validation.data.pvp !== undefined ? cleanPvpData(validation.data.pvp, this.now()) : undefined,
					inventory: validation.data.inventory.map((item) => cloneInventoryItem(item)),
					activeTeam: [...validation.data.activeTeam],
					sessionLock: lockInfo,
				};
				loadedData = validData;
				persistedTimestamp = currentTime;
				return clonePlayerSaveData(validData);
			});

			if (!updateResult.ok) {
				if (existingSession !== undefined && this.sessions.get(player) === existingSession) {
					this.warnFn(
						`[PlayerDataService] Falha temporária de rede ao recarregar ${key}: ${updateResult.errorMessage ?? "erro desconhecido"}. Preservando sessão já carregada em memória sem criar conta nova.`,
					);
					return {
						ok: false,
						status: "NETWORK_ERROR",
						errorMessage: updateResult.errorMessage,
					};
				}
				this.cleanupFailedLoadSession(player);
				const networkKickMessage =
					"Falha ao carregar seus dados devido a um erro de conexão. Tente novamente em instantes.";
				this.warnFn(
					`[PlayerDataService] Falha final de rede ao carregar ${key}: ${updateResult.errorMessage ?? "erro desconhecido"}. Expulsando jogador sem criar sessão.`,
				);
				this.kickPlayer(player, networkKickMessage);
				return {
					ok: false,
					status: "NETWORK_ERROR",
					errorMessage: updateResult.errorMessage,
				};
			}

			if (recoveredFromCorruption) {
				const reason = corruptionReason ?? "dados corrompidos";
				const logEntry = `[PlayerDataService] Dados corrompidos no load (${key}): ${reason}. Preservando registro bruto na chave principal.`;
				this.corruptionLogs.push(logEntry);
				this.warnFn(logEntry);

				let backupSucceeded = false;
				if (corruptedRawSnapshot !== undefined) {
					// Compact key stays below Roblox's 50-character limit. Reserve atomically
					// before SetAsync: even a GUID collision cannot overwrite an existing backup.
					const [suffix] = HttpService.GenerateGUID(false).gsub("-", "");
					const backupKey = `C_${corruptedTimestamp}_${suffix}`;
					const reservation = { backupReservation: suffix, sourceKey: key };
					let reserved = false;
					const [reserveOk, reserveResult] = pcall(() => this.dataStore.UpdateAsync(backupKey, (old) => {
						reserved = old === undefined;
						return reserved ? reservation : undefined;
					}));
					if (this.dataStore.SetAsync !== undefined && reserveOk && reserved && equalStoredValue(reserveResult, reservation)) {
						const backupStore = this.dataStore;
						backupSucceeded = this.executeSetWithRetry(backupKey, corruptedRawSnapshot).ok && this.dataStore === backupStore;
					}
					this.warnFn(`[PlayerDataService] Backup ${backupKey} de ${key}: ${backupSucceeded ? "confirmado" : "falhou; recuperação bloqueada"}`);
				}

				if (backupSucceeded) {
					const recoveryAttempt = this.tryRecoverFromLastValidSnapshot(
						player,
						userId,
						key,
						corruptedRawSnapshot,
						sessionId,
					);
					if (recoveryAttempt.status === "RECOVERED" && recoveryAttempt.data !== undefined) {
						this.hasCompletedFirstLoad = true;
						const recoveredSession = this.applyLoadedDataToProgression(
							player,
							userId,
							key,
							recoveryAttempt.data,
							recoveryAttempt.persistedTimestamp,
							sessionId,
							existingSession,
						);
						const finalRecoveredSnapshot = this.recordConfirmedSnapshot(
							recoveredSession,
							recoveryAttempt.persistedTimestamp,
							recoveryAttempt.data,
						);
						return {
							ok: true,
							status: "RECOVERED_LAST_VALID",
							data: finalRecoveredSnapshot,
						};
					}

					if (recoveryAttempt.status === "LOCKED") {
						this.cleanupFailedLoadSession(player, true);
						const lockMsg = SESSION_LOCK_KICK_MESSAGE;
						this.warnFn(
							`[PlayerDataService] Recuperação abortada para ${key}: session lock pertence a outro servidor.`,
						);
						this.kickPlayer(player, lockMsg);
						return {
							ok: false,
							status: "LOCKED",
							errorMessage: lockMsg,
						};
					}
				}

				this.cleanupFailedLoadSession(player);
				const corruptionKickMessage =
					"Erro ao ler seus dados salvos (dados corrompidos ou incompatíveis). Sua conta foi protegida.";
				this.kickPlayer(player, corruptionKickMessage);
				return {
					ok: false,
					status: "CORRUPTED",
					errorMessage: corruptionReason ?? corruptionKickMessage,
				};
			}

			if (lockedByOtherServer) {
				if (lockAttempt < maxLockChecks) {
					this.waitFn(this.lockWaitDelaySeconds);
					continue;
				}
				this.cleanupFailedLoadSession(player, true);
				const lockMsg = SESSION_LOCK_KICK_MESSAGE;
				this.warnFn(
					`[PlayerDataService] Entrada recusada para ${key}: session lock ativo em outro servidor.`,
				);
				this.kickPlayer(player, lockMsg);
				return {
					ok: false,
					status: "LOCKED",
					errorMessage: lockMsg,
				};
			}

			if (loadedData !== undefined && equalStoredValue(loadedData, updateResult.result)) {
				this.hasCompletedFirstLoad = true;
				const preserveExistingSession = existingSession;
				const session = this.applyLoadedDataToProgression(
					player,
					userId,
					key,
					loadedData,
					persistedTimestamp,
					sessionId,
					preserveExistingSession,
				);
				const finalSnapshot = this.recordConfirmedSnapshot(session, persistedTimestamp, loadedData);

				return {
					ok: true,
					status: this.usingMemoryFallback ? "FALLBACK_MEMORY" : "LOADED",
					data: finalSnapshot,
				};
			}
		}

		this.cleanupFailedLoadSession(player, true);
		return {
			ok: false,
			status: "LOCKED",
			errorMessage: SESSION_LOCK_KICK_MESSAGE,
		};
	}

	private cleanupFailedLoadSession(player: Player, forceClearSnapshot = false): void {
		const session = this.sessions.get(player);
		if (session !== undefined) {
			if (!session.pendingRetrySave && !this.retrySaveQueue.has(player)) {
				this.sessions.delete(player);
				this.progressionService.forgetPlayer(player);
				if (forceClearSnapshot) {
					this.clearSessionSnapshot(session);
				}
			} else if (forceClearSnapshot) {
				session.pendingRetrySave = false;
				this.retrySaveQueue.delete(player);
				this.sessions.delete(player);
				this.progressionService.forgetPlayer(player);
				this.clearSessionSnapshot(session);
			}
		} else if (forceClearSnapshot) {
			this.clearOrphanedSnapshotForUser(this.resolveUserId(player));
		}
	}

	private tryRecoverFromLastValidSnapshot(
		player: Player,
		userId: number,
		key: string,
		corruptedRawSnapshot: unknown,
		sessionId: string,
	): {
		readonly status: "RECOVERED" | "LOCKED" | "CORRUPTED";
		readonly data?: PlayerSaveData;
		readonly persistedTimestamp: number;
	} {
		if (!this.lastValidSnapshots.has(userId)) {
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		const rawSnapshot = this.lastValidSnapshots.get(userId);
		const meta = this.snapshotMetadata.get(userId);
		if (rawSnapshot === undefined) {
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		// Verifica se o snapshot pertence estritamente a este jogador (userId e key)
		if (meta !== undefined && (meta.userId !== userId || meta.key !== key)) {
			this.warnFn(
				`[PlayerDataService] Snapshot em memória para ${key} pertence a outro jogador (${meta.key}). Recusando recuperação.`,
			);
			this.discardUnusableSnapshotIfNotPending(player, userId);
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		if (isRecord(rawSnapshot)) {
			const attachedUserId = (rawSnapshot as Record<string, unknown>).userId;
			const attachedKey = (rawSnapshot as Record<string, unknown>).key;
			if (
				(attachedUserId !== undefined && attachedUserId !== userId) ||
				(attachedKey !== undefined && attachedKey !== key)
			) {
				this.warnFn(
					`[PlayerDataService] Snapshot em memória com identificador incompatível para ${key}. Recusando recuperação.`,
				);
				this.discardUnusableSnapshotIfNotPending(player, userId);
				return { status: "CORRUPTED", persistedTimestamp: 0 };
			}
		}

		// Revalida integralmente o snapshot com validatePlayerSaveData() e verifica schemaVersion
		const snapshotValidation = validatePlayerSaveData(rawSnapshot, this.schemaVersion);
		if (!snapshotValidation.valid || snapshotValidation.data === undefined) {
			this.warnFn(
				`[PlayerDataService] Snapshot em memória inválido para ${key} (${snapshotValidation.reason ?? "inválido"}). Recusando recuperação.`,
			);
			this.discardUnusableSnapshotIfNotPending(player, userId);
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		const confirmedValidation = validatePlayerSaveData(
			meta?.isTestOverride ? rawSnapshot : meta?.lastPersistedData,
			this.schemaVersion,
		);
		if (!confirmedValidation.valid || confirmedValidation.data === undefined) {
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}
		const validSnapshot = confirmedValidation.data;

		// Garante que nenhum itemUuid do snapshot colida com outra sessão ativa de outro jogador
		for (const [, otherSession] of this.sessions) {
			if (otherSession.userId !== userId) {
				const otherUuids = new Set<string>();
				for (const item of otherSession.getProgressionData().inventory) {
					otherUuids.add(item.itemUuid);
				}
				for (const item of validSnapshot.inventory) {
					if (otherUuids.has(item.itemUuid)) {
						this.warnFn(
							`[PlayerDataService] Snapshot em memória para ${key} contém itemUuid pertencente a outro jogador ativo. Recusando recuperação.`,
						);
						this.discardUnusableSnapshotIfNotPending(player, userId);
						return { status: "CORRUPTED", persistedTimestamp: 0 };
					}
				}
			}
		}

		// Timestamp efetivamente persistido do snapshot (nunca confunde timestamp de alteração em memória não confirmada)
		const snapshotPersistedTimestamp =
			meta !== undefined
				? meta.lastPersistedTimestamp
				: validSnapshot.sessionLock !== undefined
					? validSnapshot.sessionLock.timestamp
					: 0;
		const snapshotLockTimestamp =
			validSnapshot.sessionLock !== undefined
				? math.min(validSnapshot.sessionLock.timestamp, snapshotPersistedTimestamp)
				: snapshotPersistedTimestamp;

		// Verifica se o registro bruto já indica sessionLock ativo de outro servidor ou dados mais recentes que o snapshot
		const preCheck = this.inspectRawRecordAgainstSnapshot(
			corruptedRawSnapshot,
			validSnapshot,
			snapshotLockTimestamp,
			this.now(),
		);
		if (preCheck === "LOCKED_BY_OTHER") {
			return { status: "LOCKED", persistedTimestamp: 0 };
		}
		if (preCheck === "NEWER_THAN_SNAPSHOT") {
			this.warnFn(
				`[PlayerDataService] Snapshot em memória para ${key} é mais antigo que os dados do DataStore. Recusando sobrescrita.`,
			);
			this.discardUnusableSnapshotIfNotPending(player, userId);
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		// Restaura atomicamente via UpdateAsync, revalidando o estado atual da chave e do sessionLock dentro do transform
		let recoveryLockedByOther = false;
		let recoveryAbortedStale = false;
		let recoveryConfirmedData: PlayerSaveData | undefined;
		let recoveryTimestamp = 0;

		const recoveryUpdateResult = this.executeUpdateWithRetry(key, (currentRawValue: unknown) => {
			recoveryLockedByOther = false;
			recoveryAbortedStale = false;
			recoveryConfirmedData = undefined;
			recoveryTimestamp = 0;

			const currentTime = this.now();
			const checkOutcome = this.inspectRawRecordAgainstSnapshot(
				currentRawValue,
				validSnapshot,
				snapshotLockTimestamp,
				currentTime,
			);
			if (checkOutcome === "LOCKED_BY_OTHER") {
				recoveryLockedByOther = true;
				return undefined;
			}
			if (checkOutcome === "NEWER_THAN_SNAPSHOT") {
				recoveryAbortedStale = true;
				return undefined;
			}

			// Only the exact record preserved in the backup may be replaced.
			if (!equalStoredValue(currentRawValue, corruptedRawSnapshot)) {
				recoveryAbortedStale = true;
				return undefined;
			}

			// Se a chave atual no DataStore já foi corrigida/atualizada com dados válidos, não sobrescreve
			if (currentRawValue !== undefined) {
				const migratedCurrent = migratePlayerData(currentRawValue, this.schemaVersion, this.migrations);
				if (migratedCurrent !== undefined) {
					const currentValidation = validatePlayerSaveData(migratedCurrent, this.schemaVersion);
					if (currentValidation.valid && currentValidation.data !== undefined) {
						recoveryAbortedStale = true;
						return undefined;
					}
				}
			}

			const lockInfo: SessionLockInfo = {
				sessionId,
				serverId: this.serverId,
				timestamp: currentTime,
			};
			const restoredData: PlayerSaveData = {
				version: validSnapshot.version,
				tinyes: validSnapshot.tinyes,
				shopRestockCounts: validSnapshot.shopRestockCounts !== undefined ? [...validSnapshot.shopRestockCounts] : undefined,
				pvp: validSnapshot.pvp !== undefined ? cleanPvpData(validSnapshot.pvp, this.now()) : undefined,
				inventory: validSnapshot.inventory.map((item) => cloneInventoryItem(item)),
				activeTeam: [...validSnapshot.activeTeam],
				sessionLock: lockInfo,
			};
			recoveryConfirmedData = restoredData;
			recoveryTimestamp = currentTime;
			return clonePlayerSaveData(restoredData);
		});

		if (!recoveryUpdateResult.ok) {
			this.warnFn(
				`[PlayerDataService] Falha em UpdateAsync durante recuperação de snapshot para ${key}: ${recoveryUpdateResult.errorMessage ?? "erro desconhecido"}.`,
			);
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		if (recoveryLockedByOther) {
			return { status: "LOCKED", persistedTimestamp: 0 };
		}

		if (
			recoveryAbortedStale ||
			recoveryConfirmedData === undefined ||
			!equalStoredValue(recoveryConfirmedData, recoveryUpdateResult.result)
		) {
			this.warnFn(
				`[PlayerDataService] Recuperação abortada para ${key}: estado da chave mudou ou não pôde ser confirmado.`,
			);
			this.discardUnusableSnapshotIfNotPending(player, userId);
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		const finalValidation = validatePlayerSaveData(recoveryUpdateResult.result, this.schemaVersion);
		if (!finalValidation.valid || finalValidation.data === undefined) {
			return { status: "CORRUPTED", persistedTimestamp: 0 };
		}

		const recoveryLog = `[PlayerDataService] Dados recuperados com sucesso via RECOVERED_LAST_VALID para ${key}.`;
		this.corruptionLogs.push(recoveryLog);
		this.warnFn(recoveryLog);

		return {
			status: "RECOVERED",
			data: finalValidation.data,
			persistedTimestamp: recoveryTimestamp,
		};
	}

	private inspectRawRecordAgainstSnapshot(
		rawRecord: unknown,
		snapshot: PlayerSaveData,
		snapshotPersistedTimestamp: number,
		currentTime: number,
	): "OK" | "LOCKED_BY_OTHER" | "NEWER_THAN_SNAPSHOT" {
		if (!isRecord(rawRecord)) {
			return "OK";
		}

		if (isRecord(rawRecord.sessionLock)) {
			const existingServerId = rawRecord.sessionLock.serverId;
			const existingTimestamp = rawRecord.sessionLock.timestamp;
			if (typeOf(existingServerId) === "string" && (existingServerId as string).size() > 0) {
				if (
					existingServerId !== this.serverId ||
					(rawRecord.sessionLock.sessionId !== undefined && rawRecord.sessionLock.sessionId !== snapshot.sessionLock?.sessionId)
				) {
					if (!isFiniteNumber(existingTimestamp)) {
						return "LOCKED_BY_OTHER";
					}
					const lockAge = isFiniteNumber(existingTimestamp) ? currentTime - existingTimestamp : 0;
					if (lockAge < this.lockExpirationSeconds) {
						return "LOCKED_BY_OTHER";
					}
				}
			}
			if (isFiniteNumber(existingTimestamp) && existingTimestamp > snapshotPersistedTimestamp) {
				return "NEWER_THAN_SNAPSHOT";
			}
		}

		if (isFiniteNumber(rawRecord.timestamp) && rawRecord.timestamp > snapshotPersistedTimestamp) {
			return "NEWER_THAN_SNAPSHOT";
		}
		if (isFiniteNumber(rawRecord.updatedAt) && rawRecord.updatedAt > snapshotPersistedTimestamp) {
			return "NEWER_THAN_SNAPSHOT";
		}
		if (isFiniteNumber(rawRecord.lastSavedAt) && rawRecord.lastSavedAt > snapshotPersistedTimestamp) {
			return "NEWER_THAN_SNAPSHOT";
		}

		if (
			isNonNegativeInteger(rawRecord.version) &&
			rawRecord.version > snapshot.version &&
			rawRecord.version <= this.schemaVersion
		) {
			return "NEWER_THAN_SNAPSHOT";
		}

		if (isRecord(rawRecord.inventory)) {
			const snapshotByUuid = new Map<string, FighterInventoryItem>();
			for (const item of snapshot.inventory) {
				snapshotByUuid.set(item.itemUuid, item);
			}
			const rawItems = rawRecord.inventory as unknown as ReadonlyArray<unknown>;
			for (const rawItem of rawItems) {
				if (!isRecord(rawItem) || typeOf(rawItem.itemUuid) !== "string") continue;
				const snapItem = snapshotByUuid.get(rawItem.itemUuid as string);
				if (snapItem === undefined) continue;
				if (
					isNonNegativeInteger(rawItem.level) &&
					rawItem.level >= MIN_LEVEL &&
					rawItem.level <= MAX_LEVEL
				) {
					if (rawItem.level > snapItem.level) {
						return "NEWER_THAN_SNAPSHOT";
					}
					if (
						rawItem.level === snapItem.level &&
						isFiniteNumber(rawItem.xp) &&
						rawItem.xp >= 0 &&
						rawItem.xp > snapItem.xp
					) {
						return "NEWER_THAN_SNAPSHOT";
					}
				}
			}
		}

		return "OK";
	}

	private discardUnusableSnapshotIfNotPending(player: Player, userId: number): void {
		const session = this.sessions.get(player);
		if (session !== undefined && (session.pendingRetrySave || this.retrySaveQueue.has(player) || session.saving)) {
			return;
		}
		this.lastValidSnapshots.delete(userId);
		this.snapshotMetadata.delete(userId);
	}

	/**
	 * Salva o estado atual do jogador via `UpdateAsync` verificando a posse explícita do session lock.
	 * Em caso de falha de rede após todos os retries, nunca zera os dados: loga e agenda nova tentativa.
	 */
	public savePlayer(player: Player, releaseLock = false): SavePlayerResult {
		const session = this.sessions.get(player);
		if (session === undefined) {
			return { ok: false, status: "NO_SESSION", attempts: 0 };
		}

		if (this.loadingUserIds.has(session.userId)) {
			session.pendingRetrySave = true;
			this.retrySaveQueue.add(player);
			return { ok: false, status: "RETRY_SCHEDULED", attempts: 0 };
		}
		if (!releaseLock) {
			if (session.saving || session.closing || this.loadingPlayers.has(player)) {
				return { ok: false, status: "RETRY_SCHEDULED", attempts: 0 };
			}
		} else {
			const waitStartClock = os.clock();
			let waitedSeconds = 0;
			while (
				session.saving &&
				waitedSeconds < this.saveWaitTimeoutSeconds &&
				os.clock() - waitStartClock < this.saveWaitTimeoutSeconds
			) {
				this.waitFn(BIND_TO_CLOSE_POLL_INTERVAL_SECONDS);
				waitedSeconds += BIND_TO_CLOSE_POLL_INTERVAL_SECONDS;
			}
			if (session.saving) {
				session.pendingRetrySave = true;
				this.retrySaveQueue.add(player);
				const timeoutMessage = `Tempo limite (${this.saveWaitTimeoutSeconds}s) excedido aguardando conclusão de save em andamento para ${session.key}.`;
				this.warnFn(`[PlayerDataService] ${timeoutMessage}`);
				return {
					ok: false,
					status: "RETRY_SCHEDULED",
					attempts: 0,
					errorMessage: timeoutMessage,
				};
			}
			if (this.sessions.get(player) !== session) {
				this.clearSessionSnapshot(session);
				return { ok: false, status: "NO_SESSION", attempts: 0 };
			}
		}

		session.saving = true;
		const [ok, resultOrErr] = pcall(() => this.performSavePlayer(player, session, releaseLock));
		session.saving = false;
		if (!ok) {
			error(resultOrErr);
		}
		return resultOrErr;
	}

	private performSavePlayer(
		player: Player,
		session: ActivePlayerSession,
		releaseLock: boolean,
	): SavePlayerResult {
		this.reconcileActiveTeam(session);
		// Atualiza apenas como snapshot em memória (persisted = false), mantendo o último timestamp confirmado pelo DataStore
		this.updateLastValidSnapshotFromSession(session);
		const candidateSnapshot = this.buildSaveDataFromSession(session, undefined);
		const candidateMutationSeq = session.mutationSeq;
		let expectedPayload: PlayerSaveData | undefined;

		let lockedByOtherServer = false;
		let persistedTimestamp = 0;
		const updateResult = this.executeUpdateWithRetry(session.key, (oldValue: unknown) => {
			lockedByOtherServer = false;
			expectedPayload = undefined;
			persistedTimestamp = 0;
			const currentTime = this.now();

			if (
				!isRecord(oldValue) ||
				!isRecord(oldValue.sessionLock) ||
				oldValue.sessionLock.serverId !== this.serverId ||
				oldValue.sessionLock.sessionId !== session.sessionId
			) {
				lockedByOtherServer = true;
				return undefined;
			}

			persistedTimestamp = currentTime;
			const payload: PlayerSaveData = {
				version: candidateSnapshot.version,
				tinyes: candidateSnapshot.tinyes,
				shopRestockCounts: candidateSnapshot.shopRestockCounts !== undefined ? [...candidateSnapshot.shopRestockCounts] : undefined,
				pvp: candidateSnapshot.pvp !== undefined ? clonePvpData(candidateSnapshot.pvp) : undefined,
				inventory: candidateSnapshot.inventory.map((item) => cloneInventoryItem(item)),
				activeTeam: [...candidateSnapshot.activeTeam],
				sessionLock: releaseLock
					? undefined
					: {
							serverId: this.serverId,
							sessionId: session.sessionId,
							timestamp: currentTime,
						},
			};
			expectedPayload = payload;
			return clonePlayerSaveData(payload);
		});

		if (!updateResult.ok) {
			session.pendingRetrySave = true;
			this.retrySaveQueue.add(player);
			this.warnFn(
				`[PlayerDataService] Falha ao salvar ${session.key} após ${updateResult.attempts} tentativa(s). Dados mantidos em memória para nova tentativa.`,
			);
			return {
				ok: false,
				status: "RETRY_SCHEDULED",
				attempts: updateResult.attempts,
				errorMessage: updateResult.errorMessage,
			};
		}

		if (lockedByOtherServer) {
			session.pendingRetrySave = false;
			this.retrySaveQueue.delete(player);
			this.sessions.delete(player);
			this.progressionService.forgetPlayer(player);
			this.clearSessionSnapshot(session);
			this.warnFn(
				`[PlayerDataService] Gravação abortada para ${session.key}: session lock ausente ou pertencente a outro servidor/sessão. Sessão local descartada e jogador expulso.`,
			);
			this.kickPlayer(player, SESSION_LOCK_LOST_KICK_MESSAGE);
			return {
				ok: false,
				status: "LOCKED_BY_OTHER",
				attempts: updateResult.attempts,
				errorMessage: SESSION_LOCK_LOST_KICK_MESSAGE,
			};
		}

		if (expectedPayload === undefined || !equalStoredValue(expectedPayload, updateResult.result)) {
			session.pendingRetrySave = true;
			this.retrySaveQueue.add(player);
			this.warnFn(`[PlayerDataService] UpdateAsync não confirmou o payload de ${session.key}. Retry preservado.`);
			return { ok: false, status: "RETRY_SCHEDULED", attempts: updateResult.attempts };
		}

		if (releaseLock) {
			session.pendingRetrySave = false;
			this.retrySaveQueue.delete(player);
			this.sessions.delete(player);
			this.progressionService.forgetPlayer(player);
			this.clearSessionSnapshot(session);
			return {
				ok: true,
				status: "SAVED",
				attempts: updateResult.attempts,
			};
		}

		this.recordConfirmedSnapshot(session, persistedTimestamp, updateResult.result as PlayerSaveData, candidateMutationSeq);
		if (!session.closing) {
			session.pendingRetrySave = false;
			this.retrySaveQueue.delete(player);
		}
		return {
			ok: true,
			status: "SAVED",
			attempts: updateResult.attempts,
		};
	}

	/**
	 * Salva quando o jogador sai (`PlayerRemoving`).
	 * Se o save de saída falhar, mantém a sessão marcada como saída pendente (`closing = true`) e o lock,
	 * e reenfileira o save em segundo plano com `releaseLock = true`.
	 */
	public handlePlayerRemoving(player: Player): SavePlayerResult {
		if (this.loadingPlayers.has(player) || this.loadingUserIds.has(this.resolveUserId(player))) {
			this.removedDuringLoad.add(player);
		}
		const session = this.sessions.get(player);
		if (session === undefined) {
			this.progressionService.forgetPlayer(player);
			this.clearOrphanedSnapshotForUser(this.resolveUserId(player));
			return { ok: false, status: "NO_SESSION", attempts: 0 };
		}

		session.closing = true;
		const [ok, resultOrErr] = pcall(() => this.savePlayer(player, true));
		if (!ok) {
			session.pendingRetrySave = true;
			this.retrySaveQueue.add(player);
			if (!this.shuttingDown) {
				this.enqueueBackgroundRetrySave(player, session);
			}
			error(resultOrErr);
		}

		const result = resultOrErr;
		if (result.ok || result.status === "LOCKED_BY_OTHER" || result.status === "NO_SESSION") {
			session.pendingRetrySave = false;
			this.retrySaveQueue.delete(player);
			if (this.sessions.get(player) === session) {
				this.sessions.delete(player);
				this.progressionService.forgetPlayer(player);
			}
			this.clearSessionSnapshot(session);
			return result;
		}

		session.pendingRetrySave = true;
		this.retrySaveQueue.add(player);
		this.warnFn(
			`[PlayerDataService] Save de saída falhou para ${session.key}. Sessão e lock mantidos; save reenfileirado em segundo plano.`,
		);
		if (!this.shuttingDown) {
			this.enqueueBackgroundRetrySave(player, session);
		}
		return result;
	}

	private enqueueBackgroundRetrySave(player: Player, session: ActivePlayerSession): void {
		session.pendingRetrySave = true;
		this.retrySaveQueue.add(player);
		if (this.shuttingDown || session.retryTaskActive) {
			return;
		}
		session.retryTaskActive = true;
		task.spawn(() => {
			const [taskOk, taskErr] = pcall(() => {
				let retryDelay = this.retryBaseDelaySeconds;
				while (this.started && !this.shuttingDown) {
					const currentSession = this.sessions.get(player);
					if (currentSession === undefined || currentSession !== session || !currentSession.pendingRetrySave) {
						this.clearSessionSnapshot(session);
						break;
					}
					this.waitFn(retryDelay);
					if (!this.started || this.shuttingDown) {
						break;
					}
					const activeSession = this.sessions.get(player);
					if (activeSession === undefined || activeSession !== session || !activeSession.pendingRetrySave) {
						this.clearSessionSnapshot(session);
						break;
					}
					if (activeSession.saving) {
						break;
					}
					const releaseLock = activeSession.closing;
					if (!releaseLock && player.Parent !== Players) break;
					const [saveOk, retryResultOrErr] = pcall(() => this.savePlayer(player, releaseLock));
					if (!saveOk) {
						activeSession.pendingRetrySave = true;
						this.retrySaveQueue.add(player);
						this.warnFn(
							`[PlayerDataService] Exceção inesperada durante retry em background para ${activeSession.key} (releaseLock=${tostring(releaseLock)}): ${tostring(retryResultOrErr)}. Mantendo sessão na fila para nova tentativa.`,
						);
					} else {
						const retryResult = retryResultOrErr;
						if (releaseLock) {
							if (
								retryResult.ok ||
								retryResult.status === "LOCKED_BY_OTHER" ||
								retryResult.status === "NO_SESSION"
							) {
								session.pendingRetrySave = false;
								this.retrySaveQueue.delete(player);
								if (this.sessions.get(player) === session) {
									this.sessions.delete(player);
									this.progressionService.forgetPlayer(player);
								}
								this.clearSessionSnapshot(session);
								break;
							}
						} else if (retryResult.ok || retryResult.status !== "RETRY_SCHEDULED") {
							break;
						}
					}
					retryDelay = math.min(
						retryDelay * this.retryBackoffFactor,
						this.logoutRetryMaxBackoffSeconds,
					);
				}
			});
			session.retryTaskActive = false;
			const finalSession = this.sessions.get(player);
			if (finalSession === session) {
				finalSession.retryTaskActive = false;
			}
			if (!taskOk) {
				this.warnFn(
					`[PlayerDataService] Erro inesperado na finalização da task de retry em background para ${session.key}: ${tostring(taskErr)}`,
				);
			}
		});
	}

	/** Executa um ciclo de autosave periódico para todos os jogadores ativos (ignorando sessões em saída). */
	public autosaveAllPlayers(): void {
		for (const [player, session] of this.sessions) {
			if (player.Parent === Players && !this.shuttingDown && !session.closing && !session.saving && !this.loadingPlayers.has(player)) {
				const [ok, errOrRes] = pcall(() => this.savePlayer(player, false));
				if (!ok) {
					session.saving = false;
					if (this.sessions.get(player) === session) {
						session.pendingRetrySave = true;
						this.retrySaveQueue.add(player);
					}
					this.warnFn(
						`[PlayerDataService] Exceção no autosave (userId=${session.userId}, key=${session.key}): ${tostring(errOrRes)}. Sessão e retry preservados.`,
					);
				}
			}
		}
	}

	/**
	 * Salva todos os jogadores ativos e libera seus session locks dentro do tempo limite de `BindToClose`,
	 * retentando em loop enquanto houver sessões pendentes dentro da margem segura do timeout.
	 */
	public saveAllPlayersOnClose(): void {
		const startClock = os.clock();
		const safeMarginSeconds = math.min(
			2,
			math.max(BIND_TO_CLOSE_POLL_INTERVAL_SECONDS, this.retryBaseDelaySeconds),
		);
		const deadlineSeconds = math.max(
			BIND_TO_CLOSE_POLL_INTERVAL_SECONDS,
			BIND_TO_CLOSE_TIMEOUT_SECONDS - safeMarginSeconds,
		);
		this.shutdownStartClock = startClock;
		this.shutdownDeadlineSeconds = deadlineSeconds;
		this.shutdownThreadElapsed.clear();
		this.shuttingDown = true;

		const activePlayers: Player[] = [];
		for (const [player] of this.sessions) {
			activePlayers.push(player);
		}
		if (activePlayers.size() === 0) return;

		const retryIntervalSeconds =
			this.retryBaseDelaySeconds > 0 ? this.retryBaseDelaySeconds : BIND_TO_CLOSE_POLL_INTERVAL_SECONDS;

		let remaining = activePlayers.size();
		for (const player of activePlayers) {
			task.spawn(() => {
				while (
					this.sessions.has(player) &&
					this.getRemainingShutdownSeconds() > 0
				) {
					const currentSession = this.sessions.get(player);
					const [ok, resultOrErr] = pcall(() => this.handlePlayerRemoving(player));
					if (!ok) {
						this.warnFn(
							`[PlayerDataService] Erro ao salvar jogador no BindToClose: ${tostring(resultOrErr)}`,
						);
					} else if (
						resultOrErr.ok ||
						resultOrErr.status === "LOCKED_BY_OTHER" ||
						resultOrErr.status === "NO_SESSION"
					) {
						this.retrySaveQueue.delete(player);
						this.sessions.delete(player);
						this.progressionService.forgetPlayer(player);
						if (currentSession !== undefined) {
							this.clearSessionSnapshot(currentSession);
						}
						break;
					}

					if (!this.sessions.has(player)) {
						if (currentSession !== undefined) {
							this.clearSessionSnapshot(currentSession);
						}
						break;
					}
					const remainingBeforeWait = this.getRemainingShutdownSeconds();
					if (remainingBeforeWait <= 0) {
						break;
					}
					this.waitWithShutdownTracking(math.min(retryIntervalSeconds, remainingBeforeWait));
				}
				remaining -= 1;
			});
		}

		let pollElapsedSeconds = 0;
		while (
			remaining > 0 &&
			pollElapsedSeconds < BIND_TO_CLOSE_TIMEOUT_SECONDS &&
			os.clock() - startClock < BIND_TO_CLOSE_TIMEOUT_SECONDS
		) {
			this.waitFn(BIND_TO_CLOSE_POLL_INTERVAL_SECONDS);
			pollElapsedSeconds += BIND_TO_CLOSE_POLL_INTERVAL_SECONDS;
		}
	}

	private getRemainingShutdownSeconds(): number {
		if (!this.shuttingDown) {
			return math.huge;
		}
		const currentThread = coroutine.running();
		const threadElapsed = currentThread !== undefined ? (this.shutdownThreadElapsed.get(currentThread) ?? 0) : 0;
		const wallElapsed = math.max(0, os.clock() - this.shutdownStartClock);
		const effectiveElapsed = math.max(threadElapsed, wallElapsed);
		return math.max(0, this.shutdownDeadlineSeconds - effectiveElapsed);
	}

	private waitWithShutdownTracking(seconds: number): void {
		if (seconds <= 0) return;
		if (this.shuttingDown) {
			const currentThread = coroutine.running();
			if (currentThread !== undefined) {
				const previous = this.shutdownThreadElapsed.get(currentThread) ?? 0;
				this.shutdownThreadElapsed.set(currentThread, previous + seconds);
			}
		}
		this.waitFn(seconds);
	}

	private resolveInitialDataStore(): DataStoreLike {
		if (this.isStudioFn() && game.GameId === 0) {
			this.activateMemoryFallback(
				"[PlayerDataService] Studio não publicado (GameId = 0). Usando fallback automático em memória.",
			);
			return this.fallbackStore;
		}

		const [ok, storeOrErr] = pcall(() => this.getDataStoreFn());
		if (!ok || storeOrErr === undefined) {
			const errMsg = tostring(storeOrErr ?? "DataStore indefinido");
			if (this.isStudioFn()) {
				this.activateMemoryFallback(
					`[PlayerDataService] DataStoreService indisponível no Studio (${errMsg}). Usando fallback automático em memória.`,
				);
				return this.fallbackStore;
			}
			this.warnFn(
				`[PlayerDataService] Falha crítica ao obter DataStore em produção (${errMsg}). Fallback em memória é proibido fora do Studio.`,
			);
			return {
				UpdateAsync(): unknown {
					error(`DataStoreUnavailableInProduction: ${errMsg}`);
				},
				SetAsync(): unknown {
					error(`DataStoreUnavailableInProduction: ${errMsg}`);
				},
			};
		}

		return storeOrErr;
	}

	private activateMemoryFallback(reason: string): void {
		if (!this.isStudioFn()) {
			this.warnFn(
				`[PlayerDataService] Tentativa de ativar fallback em memória bloqueada fora do Studio: ${reason}`,
			);
			return;
		}
		if (!this.usingMemoryFallback) {
			this.usingMemoryFallback = true;
			this.printFn("FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS");
			this.warnFn("FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS");
			this.warnFn(reason);
			if (this.hasCompletedFirstLoad || this.sessions.size() > 0) {
				this.warnFn(
					"[PlayerDataService] Fallback em memória acionado após o primeiro load bem-sucedido. Mantendo a sessão atual sem criar conta nova.",
				);
				this.seedFallbackStoreFromActiveSessions();
			}
		}
		this.dataStore = this.fallbackStore;
	}

	private seedFallbackStoreFromActiveSessions(): void {
		const seededKeys = new Set<string>();
		for (const [, session] of this.sessions) {
			const snapshot = this.buildSaveDataFromSession(session, {
				serverId: this.serverId,
				sessionId: session.sessionId,
				timestamp: this.now(),
			});
			this.fallbackStore.setRawForTest(session.key, snapshot);
			seededKeys.add(session.key);
		}
		for (const [userId, snapshot] of this.lastValidSnapshots) {
			const key = this.getPlayerKey(userId);
			if (!seededKeys.has(key) && this.fallbackStore.peekRaw(key) === undefined) {
				this.fallbackStore.setRawForTest(key, clonePlayerSaveData(snapshot));
			}
		}
	}

	private shouldTriggerStudioFallback(errorMessage: string): boolean {
		if (!this.allowStudioAutoFallback || this.usingMemoryFallback) return false;
		if (!this.isStudioFn()) return false;
		const lower = errorMessage.lower();
		return lower.find("403")[0] !== undefined || lower.find("studio")[0] !== undefined;
	}

	private executeUpdateWithRetry(
		key: string,
		transform: (oldValue: unknown) => unknown,
	): { readonly ok: boolean; readonly attempts: number; readonly result?: unknown; readonly errorMessage?: string } {
		const maxAttempts = 1 + math.max(0, this.maxRetries);
		let lastError = "erro desconhecido no DataStore";

		for (const attempt of $range(1, maxAttempts)) {
			const [success, valueOrErr] = pcall(() => this.dataStore.UpdateAsync(key, transform));
			if (success) {
				return {
					ok: true,
					attempts: attempt,
					result: valueOrErr,
				};
			}

			lastError = tostring(valueOrErr);
			if (this.shouldTriggerStudioFallback(lastError)) {
				this.activateMemoryFallback(
					`[PlayerDataService] Acesso à API do DataStore indisponível no Studio (${lastError}). Alternando para armazenamento em memória.`,
				);
				const [fallbackOk, fallbackRes] = pcall(() => this.dataStore.UpdateAsync(key, transform));
				if (fallbackOk) {
					return {
						ok: true,
						attempts: attempt,
						result: fallbackRes,
					};
				}
			}

			if (attempt < maxAttempts) {
				let backoffDelay = math.min(
					this.retryBaseDelaySeconds * math.pow(this.retryBackoffFactor, attempt - 1),
					this.retryMaxDelaySeconds,
				);
				if (this.shuttingDown) {
					const remainingShutdownSeconds = this.getRemainingShutdownSeconds();
					if (remainingShutdownSeconds <= 0) {
						this.warnFn(
							`[PlayerDataService] Prazo de BindToClose esgotado em UpdateAsync (${key}), tentativa ${attempt}/${maxAttempts}: ${lastError}. Encerrando retries internos.`,
						);
						return {
							ok: false,
							attempts: attempt,
							errorMessage: lastError,
						};
					}
					backoffDelay = math.min(backoffDelay, remainingShutdownSeconds);
				}
				this.warnFn(
					`[PlayerDataService] Falha em UpdateAsync (${key}), tentativa ${attempt}/${maxAttempts}: ${lastError}. Retentando em ${backoffDelay}s...`,
				);
				this.waitWithShutdownTracking(backoffDelay);
			}
		}

		return {
			ok: false,
			attempts: maxAttempts,
			errorMessage: lastError,
		};
	}

	private executeSetWithRetry(
		key: string,
		value: unknown,
	): { readonly ok: boolean; readonly errorMessage?: string } {
		if (this.dataStore.SetAsync === undefined) {
			return { ok: false, errorMessage: "SetAsync não suportado pelo DataStore" };
		}

		const maxAttempts = 1 + math.max(0, this.maxRetries);
		let lastError = "erro desconhecido no SetAsync";

		for (const attempt of $range(1, maxAttempts)) {
			const [success, valueOrErr] = pcall(() => this.dataStore.SetAsync!(key, value));
			if (success) {
				return {
					ok: true,
				};
			}

			lastError = tostring(valueOrErr);
			if (this.shouldTriggerStudioFallback(lastError) && this.dataStore.SetAsync !== undefined) {
				this.activateMemoryFallback(
					`[PlayerDataService] Acesso à API do DataStore indisponível no Studio (${lastError}). Alternando para armazenamento em memória.`,
				);
				const [fallbackOk] = pcall(() => this.dataStore.SetAsync!(key, value));
				if (fallbackOk) {
					return {
						ok: true,
					};
				}
			}

			if (attempt < maxAttempts) {
				let backoffDelay = math.min(
					this.retryBaseDelaySeconds * math.pow(this.retryBackoffFactor, attempt - 1),
					this.retryMaxDelaySeconds,
				);
				if (this.shuttingDown) {
					const remaining = this.getRemainingShutdownSeconds();
					if (remaining <= 0) return { ok: false, errorMessage: lastError };
					backoffDelay = math.min(backoffDelay, remaining);
				}
				this.warnFn(
					`[PlayerDataService] Falha em SetAsync (${key}), tentativa ${attempt}/${maxAttempts}: ${lastError}. Retentando em ${backoffDelay}s...`,
				);
				this.waitWithShutdownTracking(backoffDelay);
			}
		}

		this.warnFn(
			`[PlayerDataService] Falha final ao gravar backup em SetAsync (${key}) após ${maxAttempts} tentativa(s): ${lastError}`,
		);
		return {
			ok: false,
			errorMessage: lastError,
		};
	}

	private resolveUserId(player: Player): number {
		const rawId = (player as unknown as { readonly UserId?: number }).UserId;
		if (isFiniteNumber(rawId)) {
			return rawId;
		}
		return 0;
	}

	private createStarterInventoryItem(): FighterInventoryItem {
		const starterDef = FIGHTER_DATA[this.starterFighterId];
		const starterBaseStats = rollClassBaseStats(starterDef.className, this.rng);
		const starterSkills: SkillSlots = [
			calcSkillSlotRoll(1, this.rng()),
			calcSkillSlotRoll(2, this.rng()),
			calcSkillSlotRoll(3, this.rng()),
		];
		return {
			itemUuid: HttpService.GenerateGUID(false),
			fighterId: starterDef.fighterId,
			rarity: starterDef.rarity,
			level: MIN_LEVEL,
			xp: 0,
			baseStats: cloneStatBlock(starterBaseStats),
			allocatedStats: { hp: 0, atk: 0, dodge: 0, crit: 0 },
			skills: cloneSkillSlots(starterSkills),
		};
	}

	private createDefaultSaveData(lockInfo?: SessionLockInfo, isNewPlayer = false): PlayerSaveData {
		if (isNewPlayer) {
			const starterItem = this.createStarterInventoryItem();
			return {
				version: this.schemaVersion,
				tinyes: INITIAL_TINYES,
				shopRestockCounts: [0, 0, 0],
				pvp: cleanPvpData(emptyPvpData(), this.now()),
				inventory: [starterItem],
				activeTeam: [starterItem.itemUuid],
				sessionLock: lockInfo,
			};
		}
		return {
			version: this.schemaVersion,
			tinyes: INITIAL_TINYES,
			shopRestockCounts: [0, 0, 0],
			pvp: cleanPvpData(emptyPvpData(), this.now()),
			inventory: [],
			activeTeam: [],
			sessionLock: lockInfo,
		};
	}

	/**
	 * Aplica o `PlayerSaveData` carregado ao `ProgressionService` sem nunca rerrolar `baseStats` nem `skills`.
	 */
	private applyLoadedDataToProgression(
		player: Player,
		userId: number,
		key: string,
		loadedData: PlayerSaveData,
		persistedTimestamp: number,
		sessionId: string,
		reuseSession?: ActivePlayerSession,
	): ActivePlayerSession {
		this.progressionService.loadValidatedPlayerData(player, {
			version: loadedData.version,
			inventory: loadedData.inventory,
		});

		const activeTeam = [...loadedData.activeTeam];

		if (reuseSession !== undefined && reuseSession.userId === userId && reuseSession.key === key) {
			reuseSession.tinyes = loadedData.tinyes;
			reuseSession.shopRestockCounts = [...(loadedData.shopRestockCounts ?? [0, 0, 0])];
			reuseSession.pvp = cleanPvpData(loadedData.pvp ?? emptyPvpData(), this.now());
			reuseSession.activeTeam = activeTeam;
			reuseSession.version = this.schemaVersion;
			reuseSession.lastPersistedLockTimestamp = persistedTimestamp;
			reuseSession.pendingRetrySave = false;
			reuseSession.saving = false;
			reuseSession.closing = false;
			this.reconcileActiveTeam(reuseSession);
			this.retrySaveQueue.delete(player);
			this.sessions.set(player, reuseSession);
			return reuseSession;
		}

		this.nextSessionCounter += 1;
		const session: ActivePlayerSession = {
			sessionId,
			player,
			userId,
			key,
			getProgressionData: () => this.progressionService.getPlayerData(player)!,
			tinyes: loadedData.tinyes,
			shopRestockCounts: [...(loadedData.shopRestockCounts ?? [0, 0, 0])],
			pvp: cleanPvpData(loadedData.pvp ?? emptyPvpData(), this.now()),
			activeTeam,
			version: this.schemaVersion,
			lastPersistedLockTimestamp: persistedTimestamp,
			mutationSeq: 0,
			lastConfirmedMutationSeq: 0,
			pendingRetrySave: false,
			saving: false,
			closing: false,
		};
		this.reconcileActiveTeam(session);
		this.retrySaveQueue.delete(player);
		this.sessions.set(player, session);
		return session;
	}

	private reconcileActiveTeam(session: ActivePlayerSession): void {
		const inventoryUuids = new Set<string>();
		for (const fighter of session.getProgressionData().inventory) {
			inventoryUuids.add(fighter.itemUuid);
		}

		const validTeam: string[] = [];
		const seen = new Set<string>();
		for (const uuid of session.activeTeam) {
			if (inventoryUuids.has(uuid) && !seen.has(uuid) && validTeam.size() < MAX_ACTIVE_TEAM_SIZE) {
				seen.add(uuid);
				validTeam.push(uuid);
			}
		}
		session.activeTeam = validTeam;
	}

	private buildSaveDataFromSession(session: ActivePlayerSession, sessionLock?: SessionLockInfo): PlayerSaveData {
		this.reconcileActiveTeam(session);
		const inventory: FighterInventoryItem[] = [];
		for (const item of session.getProgressionData().inventory) {
			inventory.push(cloneInventoryItem(item));
		}
		return {
			version: session.version,
			tinyes: session.tinyes,
			shopRestockCounts: [...(session.shopRestockCounts ?? [0, 0, 0])],
			pvp: cleanPvpData(session.pvp, this.now()),
			inventory,
			activeTeam: [...session.activeTeam],
			sessionLock,
		};
	}

	private recordConfirmedSnapshot(
		session: ActivePlayerSession,
		persistedTimestamp: number,
		confirmedSnapshot: PlayerSaveData,
		confirmedMutationSeq = session.mutationSeq,
	): PlayerSaveData {
		if (this.sessions.get(session.player) !== session) return clonePlayerSaveData(confirmedSnapshot);
		const validation = validatePlayerSaveData(confirmedSnapshot, this.schemaVersion);
		if (!validation.valid || validation.data === undefined) {
			this.warnFn(`[PlayerDataService] Payload confirmado inválido para ${session.key}: ${validation.reason ?? "inválido"}.`);
			return clonePlayerSaveData(confirmedSnapshot);
		}
		session.lastPersistedLockTimestamp = persistedTimestamp;
		session.lastConfirmedMutationSeq = confirmedMutationSeq;
		const current = this.buildSaveDataFromSession(session, confirmedSnapshot.sessionLock);
		const persisted = session.mutationSeq === confirmedMutationSeq && equalStoredValue(current, confirmedSnapshot);
		this.lastValidSnapshots.set(session.userId, clonePlayerSaveData(persisted ? confirmedSnapshot : current));
		this.snapshotMetadata.set(session.userId, {
			userId: session.userId, key: session.key, sessionId: session.sessionId,
			persisted, lastPersistedTimestamp: persistedTimestamp,
			lastPersistedData: clonePlayerSaveData(confirmedSnapshot),
			lastPersistedMutationSeq: confirmedMutationSeq, updatedAt: this.now(),
		});
		return clonePlayerSaveData(confirmedSnapshot);
	}

	private updateLastValidSnapshotFromSession(session: ActivePlayerSession): void {
		if (this.sessions.get(session.player) !== session) {
			return;
		}
		session.mutationSeq += 1;
		const candidate = this.buildSaveDataFromSession(session, {
			serverId: this.serverId,
			sessionId: session.sessionId,
			timestamp: session.lastPersistedLockTimestamp,
		});
		const validation = validatePlayerSaveData(candidate, this.schemaVersion);
		if (!validation.valid || validation.data === undefined) {
			this.warnFn(
				`[PlayerDataService] Alteração em memória gerou snapshot inválido para ${session.key}: ${validation.reason ?? "inválido"}. Snapshot ignorado.`,
			);
			return;
		}

		const existingMeta = this.snapshotMetadata.get(session.userId);
		const lastPersistedData =
			existingMeta !== undefined && existingMeta.sessionId === session.sessionId
				? existingMeta.lastPersistedData
				: undefined;
		const lastPersistedTimestamp =
			existingMeta !== undefined && existingMeta.sessionId === session.sessionId
				? existingMeta.lastPersistedTimestamp
				: session.lastPersistedLockTimestamp;

		this.lastValidSnapshots.set(session.userId, clonePlayerSaveData(validation.data));
		this.snapshotMetadata.set(session.userId, {
			userId: session.userId,
			key: session.key,
			sessionId: session.sessionId,
			persisted: false,
			lastPersistedTimestamp,
			lastPersistedData,
			lastPersistedMutationSeq: existingMeta?.lastPersistedMutationSeq ?? 0,
			updatedAt: this.now(),
		});
	}

	private clearSessionSnapshot(session: ActivePlayerSession): void {
		const currentSession = this.sessions.get(session.player);
		if (
			currentSession === session &&
			(session.pendingRetrySave || this.retrySaveQueue.has(session.player) || session.saving)
		) {
			return;
		}
		for (const [, activeSession] of this.sessions) {
			if (activeSession.userId === session.userId && activeSession !== session) {
				const meta = this.snapshotMetadata.get(session.userId);
				if (meta === undefined || meta.sessionId !== session.sessionId) {
					return;
				}
			}
		}
		const meta = this.snapshotMetadata.get(session.userId);
		if (meta !== undefined && meta.sessionId !== session.sessionId) {
			return;
		}
		this.lastValidSnapshots.delete(session.userId);
		this.snapshotMetadata.delete(session.userId);
	}

	private clearOrphanedSnapshotForUser(userId: number): void {
		for (const [, activeSession] of this.sessions) {
			if (activeSession.userId === userId) {
				return;
			}
		}
		this.lastValidSnapshots.delete(userId);
		this.snapshotMetadata.delete(userId);
	}
}
