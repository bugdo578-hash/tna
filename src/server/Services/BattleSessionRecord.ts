import { MIN_CLIENT_FIGHTER_INDEX } from "../../shared/Config";
import { calcAverageLevel } from "../../shared/RewardMath";
import type { BattleEndReason, BattleSessionMode } from "../../shared/Remotes";
import type { BattleSide } from "../Components/BattleSide";
import type { Fighter } from "../Components/Fighter";
import type { AIService } from "./AIService";
import type { ArenaReservation } from "./ArenaRegistry";
import { BattlePreparation, type BattleTransitionChannel } from "./BattlePreparation";
import type { BattleService } from "./BattleService";

export interface SessionParticipant {
	readonly player: Player;
	readonly side: BattleSide;
	readonly sideId: string;
}

export interface BattleSessionRecord {
	reason?: BattleEndReason;
	resolvedHits: number;
	readonly averageLevels: readonly [number, number];
	readonly totalMaxHp: readonly [number, number];
	onFinished?: (firstSideWon: boolean) => void;
	readonly rewardRng: () => number;
	rewardPaid: boolean;
	readonly id: number;
	readonly battle: BattleService;
	readonly mode: SessionMode;
	arenaReservation?: ArenaReservation;
	transportGeneration?: number;
	readonly preparation?: BattlePreparation;
	finalizeAfterCover?: () => void;
	readonly sides: readonly [BattleSide, BattleSide];
	readonly participants: readonly SessionParticipant[];
	readonly sideIds: readonly [string, string];
	readonly sideIdBySide: Map<BattleSide, string>;
	readonly fighterIds: Map<Fighter, string>;
	readonly disconnectors: (() => void)[];
	readonly aiControllers: AIService[];
	secondsWithoutAction: number;
	secondsOutsideIdle: number;
	pauseAccumulatedSeconds: number;
	atbSyncElapsed: number;
	paused: boolean;
	ended: boolean;
	closed: boolean;
}

export type SessionMode = BattleSessionMode;

export function createBattleSessionRecord(
	id: number,
	battle: BattleService,
	[firstSide, secondSide]: readonly [BattleSide, BattleSide],
	firstPlayer: Player,
	secondPlayer: Player | undefined,
	rng: () => number,
	mode: SessionMode,
	onFinished: ((firstSideWon: boolean) => void) | undefined,
	reservation: ArenaReservation | undefined,
	channel?: BattleTransitionChannel,
	clock?: () => number,
): BattleSessionRecord {
	const sessionKey = `battle-${id}`;
	const firstSideId = `${sessionKey}-A`;
	const secondSideId = `${sessionKey}-B`;
	const sideIds: readonly [string, string] = [firstSideId, secondSideId];
	const sideIdBySide = new Map<BattleSide, string>();
	sideIdBySide.set(firstSide, firstSideId);
	sideIdBySide.set(secondSide, secondSideId);

	const fighterIds = new Map<Fighter, string>();
	for (const [side, sideId] of [[firstSide, firstSideId], [secondSide, secondSideId]] as const) {
		for (const index of $range(0, side.fighters.size() - 1)) {
			fighterIds.set(side.fighters[index], `${sideId}-fighter-${index + MIN_CLIENT_FIGHTER_INDEX}`);
		}
	}

	const participants: SessionParticipant[] = [{ player: firstPlayer, side: firstSide, sideId: firstSideId }];
	if (secondPlayer !== undefined) participants.push({ player: secondPlayer, side: secondSide, sideId: secondSideId });

	return {
		resolvedHits: 0,
		averageLevels: [calcAverageLevel(firstSide.fighters.map(f => f.level)), calcAverageLevel(secondSide.fighters.map(f => f.level))],
		totalMaxHp: [firstSide.fighters.reduce((sum, f) => sum + f.hpMax, 0), secondSide.fighters.reduce((sum, f) => sum + f.hpMax, 0)],
		onFinished,
		rewardRng: rng,
		rewardPaid: false,
		id,
		battle,
		mode,
		arenaReservation: reservation,
		preparation: channel !== undefined
			? new BattlePreparation(id, channel, participants.map(({ player }) => player), clock)
			: undefined,
		sides: [firstSide, secondSide],
		participants,
		sideIds,
		sideIdBySide,
		fighterIds,
		disconnectors: [],
		aiControllers: [],
		secondsWithoutAction: 0,
		secondsOutsideIdle: 0,
		pauseAccumulatedSeconds: 0,
		atbSyncElapsed: 0,
		paused: false,
		ended: false,
		closed: false,
	};
}
