import { S3_UNLOCK_LEVEL } from "../../shared/Config";
import { FIGHTER_DATA, type RealFighterId } from "../../shared/FighterData";
import { calcAvailablePoints, calcEffectiveStats, calcXpForNextLevel } from "../../shared/ProgressionMath";
import type { PlayerDataService } from "./PlayerDataService";
import type { ProgressionService } from "./ProgressionService";
import type { AllocationReason } from "../../shared/Remotes";

/** Contrato privado: todos os valores derivam exclusivamente do invent?rio do dono. */
export class InventoryService {
	public constructor(
		private readonly data: PlayerDataService,
		private readonly progression: ProgressionService,
		private readonly inBattle: (player: Player) => boolean,
		private readonly send: (player: Player, payload: InventoryStatePayload) => void,
	) {
		progression.onInventoryChanged = (player, reason) => this.sync(player, reason);
	}

	public getState(player: Player, allocationReason?: AllocationReason) {
		if (!this.data.isSessionLoaded(player)) return undefined;
		return {
			allocationReason,
			fighters: (this.progression.getPlayerData(player)?.inventory ?? []).map((item) => {
				const definition = FIGHTER_DATA[item.fighterId as RealFighterId];
				return {
					itemUuid: item.itemUuid, fighterId: item.fighterId,
					displayName: definition?.name ?? item.fighterId,
					rarity: item.rarity ?? definition?.rarity,
					className: definition?.className,
					level: item.level, xp: item.xp, xpToNext: calcXpForNextLevel(item.level),
					baseStats: item.baseStats, allocatedStats: item.allocatedStats,
					effectiveStats: calcEffectiveStats(item.baseStats, item.allocatedStats),
					availablePoints: calcAvailablePoints(item.level, item.allocatedStats),
					skills: item.skills, s3Unlocked: item.level >= S3_UNLOCK_LEVEL,
					unavailable: item.unavailable === true || definition === undefined,
				};
			}),
			activeTeam: this.data.getActiveTeam(player) ?? [],
		};
	}

	public sync(player: Player, allocationReason?: AllocationReason): void {
		const state = this.getState(player, allocationReason);
		if (state !== undefined) this.send(player, state);
	}

	public setTeam(player: Player, uuids: readonly string[]): boolean {
		if (this.inBattle(player) || !this.data.setActiveTeam(player, uuids)) return false;
		this.sync(player);
		return true;
	}
}

export type InventoryStatePayload = NonNullable<ReturnType<InventoryService["getState"]>>;
