import { PVP_MIN_QUIT_DAMAGE_FRACTION, PVP_MIN_RESOLVED_HITS, PVP_REWARD_FACTOR, REWARD_BRACKET_MIN_LEVEL, TEAM_XP_SLOTS } from "../../shared/Config";
import { FIGHTER_DATA, type RealFighterId } from "../../shared/FighterData";
import { calcXpForNextLevel } from "../../shared/ProgressionMath";
import type { BattleEndReason, BattleSessionMode, RewardBlockedReason } from "../../shared/Remotes";
import { calcRewardBracket } from "../../shared/RewardMath";
import type { FighterInventoryItem, FighterXpReward } from "../../shared/TypeDefs";
import type { BattleSide } from "../Components/BattleSide";
import type { BattleService } from "./BattleService";
import type { ProgressionService, TeamBattleXpEntry } from "./ProgressionService";
import type { TinyesService } from "./TinyesService";

/** Subconjunto estrutural de `SessionParticipant` necessário às recompensas. */
export interface RewardParticipant {
	readonly player: Player;
	readonly side: BattleSide;
}

/** Subconjunto estrutural de `BattleSessionRecord` necessário às recompensas. */
export interface RewardSession {
	readonly id: number;
	readonly mode: BattleSessionMode;
	readonly battle: BattleService;
	readonly sides: readonly [BattleSide, BattleSide];
	readonly participants: readonly RewardParticipant[];
	readonly averageLevels: readonly [number, number];
	readonly totalMaxHp: readonly [number, number];
	readonly rewardRng: () => number;
	resolvedHits: number;
	rewardPaid: boolean;
}

export interface ParticipantRewardResult {
	tinyesReward: number;
	rewardBlockedReason?: RewardBlockedReason;
	xpRewards?: FighterXpReward[];
}

/** Concede XP em nome da sessão; `BattleSessionService` mantém o ponto de entrada (monkey-patch em testes). */
export type AwardSessionXpFn<S extends RewardSession, P extends RewardParticipant> = (session: S, participant: P, maxTotalXp?: number) => FighterXpReward[] | undefined;

export class BattleRewardService {
	public constructor(
		private readonly tinyesService?: TinyesService,
		private readonly progressionService?: ProgressionService,
	) {}

	/**
	 * Decide e paga as recompensas de um participante ao fim da sessão.
	 * Erros são isolados por participante (`pcall` + `warn`); o resultado parcial é preservado.
	 */
	public settleParticipant<S extends RewardSession, P extends RewardParticipant>(
		session: S,
		participant: P,
		winnerSide: BattleSide | undefined,
		reason: BattleEndReason,
		awardXp: AwardSessionXpFn<S, P>,
	): ParticipantRewardResult {
		const result: ParticipantRewardResult = { tinyesReward: 0 };
		const player = participant.player;
		const [rewardOk, rewardError] = pcall(() => {
			if (
				reason === "victory" && session.mode === "PVE" && session.participants.size() === 1 &&
				participant.side === winnerSide && !session.rewardPaid
			) {
				// TODO: Rival aguarda regras do autor. Bronze não terá teto diário.
				session.rewardPaid = true;
				result.xpRewards = awardXp(session, participant);
				if (this.tinyesService !== undefined) {
					// Preserva a economia Bronze do PVE atual, independente do tier da IA.
					const range = calcRewardBracket(REWARD_BRACKET_MIN_LEVEL.Bronze);
					const amount = math.clamp(range.min + math.floor(session.rewardRng() * (range.max - range.min + 1)), range.min, range.max);
					if (this.tinyesService.addTinyes(player, amount, "PVE_Bronze_victory").ok) result.tinyesReward = amount;
				}
			}
			if (session.mode === "PVP" && participant.side === winnerSide && !session.rewardPaid &&
				(reason === "victory" || reason === "quit" || reason === "disconnect")) {
				// TODO autor: eventual punicao para desistencia; nenhuma aplicada atualmente.
				session.rewardPaid = true;
				const loserIndex = session.sides[0] === participant.side ? 1 : 0;
				let winnerRealDamage = 0;
				for (const fighter of participant.side.fighters) {
					if (fighter.itemUuid !== undefined) winnerRealDamage += session.battle.getDamageDealt(participant.side, fighter.itemUuid);
				}
				if (session.resolvedHits < PVP_MIN_RESOLVED_HITS ||
					((reason === "quit" || reason === "disconnect") && winnerRealDamage < PVP_MIN_QUIT_DAMAGE_FRACTION * session.totalMaxHp[loserIndex])) result.rewardBlockedReason = "luta_curta";
				else {
					const opponent = session.participants.find(other => other.side !== participant.side);
					const range = calcRewardBracket(session.averageLevels[session.sides[0] === participant.side ? 1 : 0]);
					const amount = math.floor(math.clamp(range.min + math.floor(session.rewardRng() * (range.max - range.min + 1)), range.min, range.max) * PVP_REWARD_FACTOR);
					if (opponent !== undefined && this.tinyesService !== undefined) {
						const reward = this.tinyesService.awardPvpWin(player, opponent.player.UserId, amount);
						result.tinyesReward = reward.amount;
						result.rewardBlockedReason = reward.blockedReason;
						// Limite do par continua comum; os saldos diários de Tinyes e XP são independentes.
						if (reward.blockedReason !== "limite_par") {
							const remainingXp = this.tinyesService.getRemainingPvpXp(player);
							if (remainingXp === 0) result.rewardBlockedReason = "limite_diario_xp";
							else {
								const [xpOk, xpResOrErr] = pcall(() => awardXp(session, participant, remainingXp));
								const gainedFromReturn = xpOk && xpResOrErr !== undefined && xpResOrErr.some((xp) => xp.xpGained > 0);
								const gainedFromDailyCounter = this.tinyesService.getRemainingPvpXp(player) < remainingXp;
								if (reward.amount === 0 && (gainedFromReturn || gainedFromDailyCounter)) {
									this.tinyesService.recordPvpPairWin?.(player, opponent.player.UserId);
								}
								if (!xpOk) error(xpResOrErr);
								result.xpRewards = xpResOrErr;
							}
						}
						pcall(() => this.tinyesService?.syncBalance(player));
					}
				}
			}
		});
		if (!rewardOk) warn(`[BattleSessionService] erro de recompensa battle-${session.id}: ${tostring(rewardError)}`);
		return result;
	}

	public awardSessionXp(session: RewardSession, participant: RewardParticipant, maxTotalXp = math.huge): FighterXpReward[] | undefined {
		const progression = this.progressionService;
		if (progression === undefined) return undefined;
		const enemy = session.sides[0] === participant.side ? session.sides[1] : session.sides[0];
		let levelSum = 0;
		for (const fighter of enemy.fighters) levelSum += fighter.level;
		const avgEnemyLevel = session.mode === "PVP"
			? session.averageLevels[session.sides[0] === participant.side ? 1 : 0]
			: levelSum / enemy.fighters.size();
		const team: [TeamBattleXpEntry?, TeamBattleXpEntry?, TeamBattleXpEntry?] = [];
		const previous = participant.side.fighters.map((fighter, index) => {
			const itemUuid = fighter.itemUuid;
			if (itemUuid === undefined) return undefined;
			team[index] = { itemUuid, damageDealt: session.battle.getDamageDealt(participant.side, itemUuid) };
			return progression.getFighter(participant.player, itemUuid);
		});
		let updated: readonly (FighterInventoryItem | undefined)[] = [];
		const [xpOk, xpError] = pcall(() => { updated = progression.awardPostBattleTeamXp(participant.player, avgEnemyLevel, true, team, maxTotalXp); });
		// Mesmo se a notificação falhar após um commit de XP, contabiliza o que entrou no inventário.
		const rewards: FighterXpReward[] = [];
		let totalXpGained = 0;
		for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
			const before = previous[index];
			const item = xpOk ? updated[index] : before !== undefined ? progression.getFighter(participant.player, before.itemUuid) : undefined;
			if (item === undefined || before === undefined) continue;
			// Diferença acumulada da curva: inclui múltiplos níveis e somente XP útil no cap.
			let xpGained = item.xp - before.xp;
			for (let level = before.level; level < item.level; level++) xpGained += calcXpForNextLevel(level);
			totalXpGained += xpGained;
			const definition = FIGHTER_DATA[item.fighterId as RealFighterId];
			rewards.push({
				itemUuid: item.itemUuid,
				fighterId: item.fighterId,
				displayName: definition?.name ?? item.fighterId,
				className: participant.side.fighters[index].className,
				xpGained,
				previousLevel: before.level,
				previousXp: before.xp,
				previousXpToNext: calcXpForNextLevel(before.level),
				newLevel: item.level,
				newXp: item.xp,
				newXpToNext: calcXpForNextLevel(item.level),
				leveledUp: item.level > before.level,
			});
		}
		if (session.mode === "PVP") this.tinyesService?.recordPvpXp(participant.player, totalXpGained);
		if (!xpOk) error(xpError);
		return rewards;
	}
}
