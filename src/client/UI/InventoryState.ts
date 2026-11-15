import type { ClassName, Rarity, SkillSlots, StatBlock } from "../../shared/TypeDefs";
import type { AllocationReason } from "../../shared/Remotes";

/** Espelho de apresentação do InventoryService; nenhuma dependência do código servidor. */
export interface InventoryFighter {
	readonly itemUuid: string;
	readonly fighterId: string;
	readonly displayName: string;
	readonly rarity?: Rarity;
	readonly className?: ClassName;
	readonly level: number;
	readonly xp: number;
	readonly xpToNext: number;
	readonly effectiveStats: StatBlock;
	readonly availablePoints: number;
	readonly skills: SkillSlots;
	readonly s3Unlocked: boolean;
	readonly unavailable: boolean;
	/** Flag visual opcional, ainda não publicada pelo servidor. */
	readonly newLevel?: boolean;
	readonly allocationReason?: AllocationReason;
}

export interface InventoryState {
	readonly fighters: readonly InventoryFighter[];
	readonly activeTeam: readonly string[];
	readonly allocationReason?: AllocationReason;
}
