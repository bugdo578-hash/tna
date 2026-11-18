import type { AllocatableStat, BattleGlobalState, ClassName, FighterXpReward, Rarity, StatBlock, SkillSlot, StatusEffect } from "./TypeDefs";

export interface RequestPurchasePayload { readonly offerId: string; readonly requestId: string; }
export type PurchaseReason = "saldo" | "oferta_invalida" | "em_batalha" | "limite" | "erro";
export interface PurchaseResultPayload {
	readonly requestId: string;
	readonly offerId: string;
	readonly ok: boolean;
	readonly reason?: PurchaseReason;
}
export type AllocationReason = "sem_pontos" | "cap_nivel" | "par" | "invalido";
export interface ShopStatePayload {
	readonly offers: readonly {
		readonly offerId: string; readonly fighterId: string; readonly displayName: string;
		readonly rarity: Rarity; readonly className: ClassName; readonly level: number;
		readonly baseStats: StatBlock; readonly price: number;
		readonly slotCosts: readonly [number, number, number];
	}[];
}

export const REMOTES_FOLDER_NAME = "Remotes";

export type NpcBattleNoticeReason = "em_batalha" | "carregando" | "distancia" | "time_invalido" | "erro";
export type NpcBattleNoticePayload =
	| { readonly reason: NpcBattleNoticeReason }
	| { readonly reason: "cooldown"; readonly npcId: string; readonly remainingSeconds: number };

export type ChallengeStatus = "enviado" | "aceito" | "recusado" | "expirado" | "indisponivel";
export interface ChallengeReceivedPayload { readonly inviteId: string; readonly challengerName: string; readonly expiresIn: number; }
export interface RequestChallengeResponsePayload { readonly inviteId: string; readonly accept: boolean; }
export interface ChallengeStatusPayload { readonly inviteId: string; readonly status: ChallengeStatus; }
export type BattleEndReason = "victory" | "quit" | "disconnect" | "timeout" | "error";
export type RewardBlockedReason = "limite_par" | "limite_diario" | "limite_diario_xp" | "luta_curta";
export const REMOTE_NAMES = {
	ChallengeReceived: "ChallengeReceived",
	RequestChallengeResponse: "RequestChallengeResponse",
	ChallengeStatus: "ChallengeStatus",
	NpcBattleNotice: "NpcBattleNotice",
	RequestPurchase: "RequestPurchase",
	PurchaseResult: "PurchaseResult",
	ShopState: "ShopState",
	InventoryState: "InventoryState",
	RequestSetTeam: "RequestSetTeam",
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
	readonly reason?: BattleEndReason;
	readonly rewardBlockedReason?: RewardBlockedReason;
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
