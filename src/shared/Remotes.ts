import type { AllocatableStat, BattleGlobalState, ClassName, FighterXpReward, SkillSlot, StatusEffect } from "./TypeDefs";

export const REMOTES_FOLDER_NAME = "Remotes";

export const REMOTE_NAMES = {
	TinyesChanged: "TinyesChanged",
	RequestSkill: "RequestSkill",
	RequestSwitch: "RequestSwitch",
	RequestPause: "RequestPause",
	RequestQuit: "RequestQuit",
	RequestAllocate: "RequestAllocate",
	BattleStarted: "BattleStarted",
	StateChanged: "StateChanged",
	SwitchPerformed: "SwitchPerformed",
	AttackStarted: "AttackStarted",
	HitResolved: "HitResolved",
	EffectApplied: "EffectApplied",
	EffectTick: "EffectTick",
	EffectExpired: "EffectExpired",
	FighterDied: "FighterDied",
	BattleEnded: "BattleEnded",
	AtbSync: "AtbSync",
} as const;

export type ClientFighterIndex = 1 | 2 | 3;
export type BattleSessionMode = "PVE" | "PVP";

export interface RequestSkillPayload {
	readonly slot: SkillSlot;
}

export interface RequestSwitchPayload {
	readonly index: ClientFighterIndex;
}

/** RequestPause não recebe payload. */
export type RequestPausePayload = undefined;

/** RequestQuit não recebe payload. */
export type RequestQuitPayload = undefined;

/** Payload de alocação de pontos de atributo em um lutador do inventário. */
export interface RequestAllocatePayload {
	readonly itemUuid: string;
	readonly stat: AllocatableStat;
	readonly amount: number;
}

export interface BattleFighterSnapshot {
	readonly sideId: string;
	readonly targetId: string;
	readonly fighterId: string;
	readonly className: ClassName;
	readonly level: number;
	readonly s3Unlocked: boolean;
	readonly hp: number;
	readonly hpMax: number;
	readonly active: boolean;
	/** Custos de ATB dos 3 slots (S1, S2, S3) rolados no servidor para este lutador. */
	readonly slotCosts?: readonly [number, number, number];
}

export interface BattleStartedPayload {
	readonly sides: readonly [string, string];
	readonly fighters: readonly BattleFighterSnapshot[];
	readonly mode?: BattleSessionMode;
	/** Em PVE o botão de pause fica disponível; em PVP aparece apenas o botão de quit. */
	readonly canPause?: boolean;
}

export interface StateChangedPayload {
	readonly state: BattleGlobalState;
}

export interface SwitchPerformedPayload {
	readonly sideId: string;
	readonly previousFighterId: string;
	readonly activeFighterId: string;
}

export interface AttackStartedPayload {
	readonly attackerId: string;
	readonly targetId: string;
	readonly slot: SkillSlot;
}

export interface HitResolvedPayload {
	readonly hitIndex: number;
	readonly hit: boolean;
	readonly crit: boolean;
	readonly damage: number;
	readonly targetId: string;
	readonly followUpCancelled: boolean;
}

export interface EffectAppliedPayload {
	readonly targetId: string;
	readonly effect: StatusEffect;
	readonly duration: number;
	readonly renewed: boolean;
}

export interface EffectTickPayload {
	readonly targetId: string;
	readonly effect: "Bleed" | "Burn";
	readonly damage: number;
	readonly remainingTicks: number;
}

export interface EffectExpiredPayload {
	readonly targetId: string;
	readonly effect: StatusEffect;
}

export interface FighterDiedPayload {
	readonly sideId: string;
	readonly fighterId: string;
	readonly nextActive: string | undefined;
}

export interface BattleEndedPayload {
	readonly xpRewards?: readonly FighterXpReward[];
	readonly winnerSideId?: string;
	readonly tinyesReward?: number;
}

export interface TinyesChangedPayload {
	readonly balance: number;
}

export interface AtbSyncPayload {
	readonly sideId: string;
	readonly atb: number;
}
