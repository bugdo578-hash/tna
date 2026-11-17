import { HttpService } from "@rbxts/services";
import { MAX_LEVEL, MIN_LEVEL, PLAYER_DATA_SCHEMA_VERSION, TEAM_XP_SLOTS } from "../../shared/Config";
import { isValidStatAllocation } from "../../shared/MathUtils";
import {
	calcAvailablePoints,
	calcEffectiveStats,
	calcMaxUsefulXp,
	calcPostBattleTeamXp,
	isValidXpAmount,
	resolveXpAndLevelUp,
	type FighterBattleParticipation,
	type FighterXpInput,
} from "../../shared/ProgressionMath";
import type {
	AllocatableStat,
	DuoState,
	FighterInventoryItem,
	Rarity,
	SkillSlotRoll,
	SkillSlots,
	StatBlock,
} from "../../shared/TypeDefs";
import type { RemoteService } from "./RemoteService";
import type { AllocationReason } from "../../shared/Remotes";

/** Entrada de participação pós-batalha vinculada ao `itemUuid` do inventário. */
export interface TeamBattleXpEntry extends FighterBattleParticipation {
	readonly itemUuid: string;
}

/** Dados de progressão e inventário em memória em schema versionado (pronto para T7.2). */
export interface PlayerProgressionData {
	readonly version: number;
	readonly inventory: FighterInventoryItem[];
}

/** Parâmetros para registrar um novo lutador no inventário em memória. */
export interface CreateInventoryFighterParams {
	readonly level?: number;
	readonly fighterId: string;
	readonly rarity?: Rarity;
	readonly baseStats: StatBlock;
	readonly skills: SkillSlots;
	readonly equippedChip?: string;
	readonly duo?: DuoState;
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

function cloneInventoryItem(item: FighterInventoryItem): FighterInventoryItem {
	return {
		...item,
		baseStats: cloneStatBlock(item.baseStats),
		allocatedStats: cloneStatBlock(item.allocatedStats),
		skills: cloneSkillSlots(item.skills),
		duo: item.duo !== undefined ? { ...item.duo } : undefined,
	};
}

function clonePlayerData(data: PlayerProgressionData): PlayerProgressionData {
	return { version: data.version, inventory: data.inventory.map(cloneInventoryItem) };
}

function isAllocatableStat(stat: unknown): stat is AllocatableStat {
	return stat === "hp" || stat === "atk" || stat === "dodge" || stat === "crit";
}

export class ProgressionService {
	public onInventoryChanged?: (player: Player, allocationReason?: AllocationReason) => void;
	private readonly playerData = new Map<Player, PlayerProgressionData>();

	public constructor(remoteService?: RemoteService) {
		if (remoteService !== undefined) {
			remoteService.bindAllocateRequest((player, payload) => {
				this.allocatePoints(player, payload.itemUuid, payload.stat, payload.amount);
			}, (player) => this.onInventoryChanged?.(player, "invalido"));
		}
	}

	/** Retorna (ou inicializa) o estado em memória versionado do jogador. */
	public getOrCreatePlayerData(player: Player): PlayerProgressionData {
		return clonePlayerData(this.getOrCreateInternalData(player));
	}

	/** Entrada exclusiva da persist?ncia: dados previamente migrados e validados por PlayerDataService. */
	public loadValidatedPlayerData(player: Player, data: PlayerProgressionData): void {
		this.playerData.set(player, clonePlayerData(data));
	}

	private getOrCreateInternalData(player: Player): PlayerProgressionData {
		const existing = this.playerData.get(player);
		if (existing !== undefined) return existing;

		const created: PlayerProgressionData = {
			version: PLAYER_DATA_SCHEMA_VERSION,
			inventory: [],
		};
		this.playerData.set(player, created);
		return created;
	}

	/** Consulta o estado em memória do jogador sem criá-lo. */
	public getPlayerData(player: Player): PlayerProgressionData | undefined {
		const data = this.playerData.get(player);
		return data !== undefined ? clonePlayerData(data) : undefined;
	}

	/** Limpa os dados em memória de um jogador ao sair. */
	public forgetPlayer(player: Player): void {
		this.playerData.delete(player);
	}

	/**
	 * Cria um novo lutador no inventário em memória com `itemUuid` permanente gerado no servidor
	 * (`HttpService:GenerateGUID(false)`). `baseStats` e rolls de `skills` são copiados e nunca rerrolados.
	 */
	public createInventoryFighter(player: Player, params: CreateInventoryFighterParams, notify = true): FighterInventoryItem {
		assert(params.level === undefined || (params.level >= MIN_LEVEL && params.level <= MAX_LEVEL && math.floor(params.level) === params.level), "Nível inválido");
		const data = this.getOrCreateInternalData(player);
		const item: FighterInventoryItem = {
			itemUuid: HttpService.GenerateGUID(false),
			fighterId: params.fighterId,
			rarity: params.rarity,
			level: params.level ?? MIN_LEVEL,
			xp: 0,
			baseStats: cloneStatBlock(params.baseStats),
			allocatedStats: { hp: 0, atk: 0, dodge: 0, crit: 0 },
			skills: cloneSkillSlots(params.skills),
			equippedChip: params.equippedChip,
			duo: params.duo !== undefined ? { ...params.duo } : undefined,
		};
		data.inventory.push(item);
		if (notify) this.onInventoryChanged?.(player);
		return cloneInventoryItem(item);
	}

	/** Busca um lutador específico pelo seu `itemUuid` permanente. */
	public getFighter(player: Player, itemUuid: string): FighterInventoryItem | undefined {
		const data = this.playerData.get(player);
		if (data === undefined) return undefined;
		for (const item of data.inventory) {
			if (item.itemUuid === itemUuid) return cloneInventoryItem(item);
		}
		return undefined;
	}

	/** Retorna a quantidade de pontos de atributo disponíveis para alocar no lutador. */
	public getAvailablePoints(player: Player, itemUuid: string): number | undefined {
		const fighter = this.getFighter(player, itemUuid);
		if (fighter === undefined) return undefined;
		return calcAvailablePoints(fighter.level, fighter.allocatedStats);
	}

	/** Retorna os atributos efetivos (`baseStats` + ganhos por ponto alocado) do lutador. */
	public getEffectiveStats(player: Player, itemUuid: string): StatBlock | undefined {
		const fighter = this.getFighter(player, itemUuid);
		if (fighter === undefined) return undefined;
		return calcEffectiveStats(fighter.baseStats, fighter.allocatedStats);
	}

	/**
	 * Adiciona XP a um lutador do inventário e resolve automaticamente quaisquer subidas de nível
	 * até o limite máximo (`Lv30`), preservando `itemUuid`, `baseStats` e `skills`.
	 */
	public addXp(player: Player, itemUuid: string, amount: number): FighterInventoryItem | undefined {
		// Rejeita não numérico, NaN, ±infinito e negativo (0 é permitido).
		if (!isValidXpAmount(amount)) return undefined;
		if (typeOf(itemUuid) !== "string" || itemUuid.size() === 0) return undefined;
		const data = this.playerData.get(player);
		if (data === undefined) return undefined;

		const index = this.findFighterIndex(data.inventory, itemUuid);
		if (index === undefined) return undefined;

		// Teto seguro: acima do XP necessário do Lv1 ao Lv30 o resultado é o mesmo (Lv30, xp 0).
		const safeAmount = math.min(amount, calcMaxUsefulXp());
		const current = data.inventory[index];
		const withAddedXp: FighterInventoryItem = {
			...current,
			xp: math.min(current.xp + safeAmount, calcMaxUsefulXp()),
		};
		data.inventory[index] = withAddedXp;
		return this.levelUp(player, itemUuid);
	}

	/**
	 * Processa subidas de nível pendentes a partir do XP acumulado do lutador até `MAX_LEVEL` (30).
	 * Nunca rerrola `itemUuid`, `baseStats` nem `skills`.
	 */
	public levelUp(player: Player, itemUuid: string): FighterInventoryItem | undefined {
		const data = this.playerData.get(player);
		if (data === undefined) return undefined;

		const index = this.findFighterIndex(data.inventory, itemUuid);
		if (index === undefined) return undefined;

		const current = data.inventory[index];
		const resolved = resolveXpAndLevelUp(current.level, current.xp, 0, current.allocatedStats);
		const updated: FighterInventoryItem = {
			...current,
			level: resolved.level,
			xp: resolved.xp,
		};
		data.inventory[index] = updated;
		this.onInventoryChanged?.(player);
		return cloneInventoryItem(updated);
	}

	/**
	 * Distribui o XP pós-batalha entre os lutadores válidos da equipe (1, 2 ou 3; só vitória PvE paga), dividindo 100% do pool por quantidade de válidos.
	 * O nível de cada lutador é lido do inventário no servidor, então o multiplicador por diferença de nível
	 * é individual (um Nv.1 no time não altera a XP de um Nv.20). Level-ups múltiplos e cap em `MAX_LEVEL`
	 * são resolvidos por `addXp`.
	 */
	public awardPostBattleTeamXp(
		player: Player,
		avgEnemyLevel: number,
		rewardEligible: boolean,
		team: readonly [
			(TeamBattleXpEntry | undefined)?,
			(TeamBattleXpEntry | undefined)?,
			(TeamBattleXpEntry | undefined)?,
		],
		maxTotalXp = math.huge,
	): readonly [
		FighterInventoryItem | undefined,
		FighterInventoryItem | undefined,
		FighterInventoryItem | undefined,
	] {
		// Valida todos os slots antes do calculo; primeira ocorrencia valida participa.
		const seen = new Set<string>();
		const fighters: (FighterInventoryItem | undefined)[] = [undefined, undefined, undefined];
		const inputs: [FighterXpInput | undefined, FighterXpInput | undefined, FighterXpInput | undefined] = [undefined, undefined, undefined];
		for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
			const entry = team[index];
			if (entry === undefined || typeOf(entry) !== "table") continue;
			const itemUuid = entry.itemUuid;
			if (typeOf(itemUuid) !== "string" || itemUuid.size() === 0 || seen.has(itemUuid)) continue;
			const fighter = this.getFighter(player, itemUuid);
			if (fighter === undefined || fighter.unavailable === true) continue;
			seen.add(itemUuid);
			fighters[index] = fighter;
			inputs[index] = { level: fighter.level, damageDealt: entry.damageDealt };
		}

		// Sem elegibilidade, preserva o estado, com undefined nos slots invalidos.
		if (rewardEligible !== true) return [fighters[0], fighters[1], fighters[2]];

		// Vagas invalidas recebem zero e nao entram na divisao: 1 valido = 100%, 2 = 50%/50%, 3 = 50% maior dano / 25% / 25%.
		const xpShares = calcPostBattleTeamXp(avgEnemyLevel, rewardEligible, inputs);
		let remaining = math.max(0, math.floor(maxTotalXp));
		const results: (FighterInventoryItem | undefined)[] = [undefined, undefined, undefined];
		for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
			const fighter = fighters[index];
			if (fighter !== undefined) {
				const slotXp = math.min(xpShares[index], remaining);
				remaining -= slotXp;
				results[index] = this.addXp(player, fighter.itemUuid, slotXp);
			}
		}
		return [results[0], results[1], results[2]];
	}


	/**
	 * Valida e aloca `amount` pontos em `stat` para o lutador `itemUuid` do jogador.
	 * Regras validadas no servidor:
	 * - `amount` inteiro >= 1 e <= pontos disponíveis (`(level - 1) * 2 - somaAlocada`).
	 * - Cap por atributo = nível atual (`allocated[stat] <= level`).
	 * - Trava de pares (`|ATK - Dodge| <= 5` e `|HP - Crit| <= 5`) via `isValidStatAllocation`.
	 */
	public allocatePoints(player: Player, itemUuid: string, stat: AllocatableStat, amount: number): boolean {
		const refuse = (reason: AllocationReason) => {
			this.onInventoryChanged?.(player, reason);
			return false;
		};
		if (typeOf(itemUuid) !== "string" || itemUuid.size() === 0) return refuse("invalido");
		if (!isAllocatableStat(stat)) return refuse("invalido");
		if (typeOf(amount) !== "number" || amount !== amount || math.floor(amount) !== amount || amount < 1) {
			return refuse("invalido");
		}

		const data = this.playerData.get(player);
		if (data === undefined) return refuse("invalido");

		const index = this.findFighterIndex(data.inventory, itemUuid);
		if (index === undefined) return refuse("invalido");

		const current = data.inventory[index];
		const available = calcAvailablePoints(current.level, current.allocatedStats);
		if (amount > available) return refuse("sem_pontos");
		if (current.allocatedStats[stat] + amount > current.level) return refuse("cap_nivel");

		const nextAllocated: StatBlock = {
			hp: current.allocatedStats.hp + (stat === "hp" ? amount : 0),
			atk: current.allocatedStats.atk + (stat === "atk" ? amount : 0),
			dodge: current.allocatedStats.dodge + (stat === "dodge" ? amount : 0),
			crit: current.allocatedStats.crit + (stat === "crit" ? amount : 0),
		};

		if (!isValidStatAllocation(nextAllocated, current.level)) {
			return refuse("par");
		}

		data.inventory[index] = {
			...current,
			allocatedStats: nextAllocated,
		};
		this.onInventoryChanged?.(player);
		return true;
	}

	private findFighterIndex(inventory: readonly FighterInventoryItem[], itemUuid: string): number | undefined {
		for (const index of $range(0, inventory.size() - 1)) {
			if (inventory[index].itemUuid === itemUuid) {
				return index;
			}
		}
		return undefined;
	}
}
