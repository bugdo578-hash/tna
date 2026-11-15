import { Players, RunService } from "@rbxts/services";
import {
	ATB_SYNC_INTERVAL_SECONDS,
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	BATTLE_STALL_TIMEOUT_SECONDS,
	FLOAT_TOLERANCE,
	MIN_CLIENT_FIGHTER_INDEX,
	PVE_PAUSE_MAX_SECONDS,
	TINYES_WIN_BY_TIER,
	S3_UNLOCK_LEVEL,
	TEAM_XP_SLOTS,
} from "../../shared/Config";
import type {
	AttackStartedPayload,
	AtbSyncPayload,
	BattleFighterSnapshot,
	BattleSessionMode,
	BattleStartedPayload,
	EffectAppliedPayload,
	EffectExpiredPayload,
	EffectTickPayload,
	FighterDiedPayload,
	HitResolvedPayload,
	StateChangedPayload,
	SwitchPerformedPayload,
} from "../../shared/Remotes";
import type { FighterXpReward, SkillSlot } from "../../shared/TypeDefs";
import { FIGHTER_DATA, type RealFighterId } from "../../shared/FighterData";
import { calcXpForNextLevel } from "../../shared/ProgressionMath";
import type { ProgressionService, TeamBattleXpEntry } from "./ProgressionService";
import { BattleSide, type FighterIndex } from "../Components/BattleSide";
import type { Fighter } from "../Components/Fighter";
import { AIService } from "./AIService";
import { BattleService } from "./BattleService";
import type { BattleRemoteAdapter } from "./RemoteService";
import type { TinyesService } from "./TinyesService";

interface SessionParticipant {
	readonly player: Player;
	readonly side: BattleSide;
	readonly sideId: string;
}

interface BattleSessionRecord {
	readonly rewardRng: () => number;
	rewardPaid: boolean;
	readonly id: number;
	readonly battle: BattleService;
	readonly mode: SessionMode;
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

interface PlayerBattleSession {
	readonly session: BattleSessionRecord;
	readonly side: BattleSide;
}

export class BattleSessionService {
	private readonly playerSessions = new Map<Player, PlayerBattleSession>();
	private activeSessions: BattleSessionRecord[] = [];
	private nextSessionId = 0;
	private started = false;

	public constructor(
		private readonly remoteService: BattleRemoteAdapter,
		private readonly tinyesService?: TinyesService,
		private readonly progressionService?: ProgressionService,
	) {}

	public start(): void {
		if (this.started) return;
		this.started = true;
		this.remoteService.bindRequests(
			(player, slot) => this.handleSkillRequest(player, slot),
			(player, index) => this.handleSwitchRequest(player, index),
			(player) => this.requestPause(player),
			(player) => this.requestQuit(player),
		);
		Players.PlayerRemoving.Connect((player) => this.destroySessionForPlayer(player));
		RunService.Heartbeat.Connect((dt) => this.step(dt));
	}

	public createSession(
		firstPlayer: Player,
		secondPlayer: Player | undefined,
		firstSide: BattleSide,
		secondSide: BattleSide,
		rng: () => number,
		mode: SessionMode = secondPlayer === undefined ? "PVE" : "PVP",
	): boolean {
		if (firstPlayer.Parent !== Players) return false;
		if (secondPlayer !== undefined && secondPlayer.Parent !== Players) return false;
		if (this.playerSessions.has(firstPlayer)) return false;
		if (secondPlayer !== undefined && (secondPlayer === firstPlayer || this.playerSessions.has(secondPlayer))) return false;

		const id = this.nextSessionId;
		this.nextSessionId += 1;
		const firstSideId = `battle-${id}-A`;
		const secondSideId = `battle-${id}-B`;
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

		const session: BattleSessionRecord = {
			rewardRng: rng,
			rewardPaid: false,
			id,
			battle: new BattleService(firstSide, secondSide, rng),
			mode,
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

		for (const participant of participants) {
			this.playerSessions.set(participant.player, { session, side: participant.side });
		}
		this.activeSessions.push(session);
		this.connectBattleEvents(session);
		this.broadcastBattleStarted(session);
		return true;
	}

	public destroySessionForPlayer(player: Player): void {
		this.quit(player, true);
	}

	/**
	 * Alterna o pause em sessões PVE (em qualquer estado da luta, inclusive ATTACK).
	 * Em PVP ignora silenciosamente. Respeita o teto acumulado de `PVE_PAUSE_MAX_SECONDS` (120s).
	 */
	public requestPause(player: Player): boolean {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return false;
		const session = playerSession.session;
		if (session.closed || session.ended || session.mode !== "PVE") return false;

		if (session.paused) {
			session.paused = false;
			return true;
		}

		if (session.pauseAccumulatedSeconds + FLOAT_TOLERANCE >= PVE_PAUSE_MAX_SECONDS) {
			return false;
		}
		session.paused = true;
		return true;
	}

	public setPaused(player: Player, paused: boolean): boolean {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return false;
		const session = playerSession.session;
		if (session.closed || session.ended || session.mode !== "PVE") return false;
		if (paused && session.pauseAccumulatedSeconds + FLOAT_TOLERANCE >= PVE_PAUSE_MAX_SECONDS) return false;
		session.paused = paused;
		return true;
	}

	public isPaused(player: Player): boolean {
		return this.playerSessions.get(player)?.session.paused ?? false;
	}

	public getPauseAccumulatedSeconds(player: Player): number {
		return this.playerSessions.get(player)?.session.pauseAccumulatedSeconds ?? 0;
	}

	public hasActiveSession(player: Player): boolean {
		return this.playerSessions.has(player);
	}

	/**
	 * Gatilho de ação de um lado da sessão (usado pelo loop dev/IA sem depender de RemoteEvent do client).
	 */
	public triggerSideSkill(player: Player, sideIndex: 0 | 1, slot: SkillSlot): boolean {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return false;
		const session = playerSession.session;
		if (session.closed || session.ended || session.paused) return false;
		if (session.mode !== "PVE") return false;
		const side = session.sides[sideIndex];
		if (side === playerSession.side) return false;
		if (session.battle.requestSkill(side, slot)) {
			session.secondsWithoutAction = 0;
			return true;
		}
		return false;
	}

	/**
	 * Gatilho de troca de um lado da sessão pelo fluxo oficial (`requestSwitch`).
	 */
	public triggerSideSwitch(player: Player, sideIndex: 0 | 1, index: FighterIndex): boolean {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return false;
		const session = playerSession.session;
		if (session.closed || session.ended || session.paused) return false;
		if (session.mode !== "PVE") return false;
		const side = session.sides[sideIndex];
		if (side === playerSession.side) return false;
		if (session.battle.requestSwitch(side, index)) {
			session.secondsWithoutAction = 0;
			return true;
		}
		return false;
	}

	/**
	 * Registra uma instância de `AIService` (Tier Bronze) para controlar um lado da sessão PVE.
	 * A IA é atualizada no `step(dt)` da sessão e limpa automaticamente em `destroySession`.
	 */
	public attachSideAI(player: Player, sideIndex: 0 | 1, rng: () => number): AIService | undefined {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return undefined;
		const session = playerSession.session;
		if (session.closed || session.ended) return undefined;
		if (session.mode !== "PVE") return undefined;
		const aiSide = session.sides[sideIndex];
		if (aiSide === playerSession.side) return undefined;
		const aiService = new AIService(session.battle, aiSide, rng, {
			requestSkill: (slot) => this.triggerSideSkill(player, sideIndex, slot),
			requestSwitch: (index) => this.triggerSideSwitch(player, sideIndex, index),
			isPaused: () => session.paused || session.closed || session.ended,
		});
		session.aiControllers.push(aiService);
		return aiService;
	}

	public getSideAtb(player: Player, sideIndex: 0 | 1): number {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return 0;
		return playerSession.session.sides[sideIndex].atb;
	}

	public getSideActiveSlotCost(player: Player, sideIndex: 0 | 1, slot: SkillSlot): number {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return 10;
		return playerSession.session.sides[sideIndex].getActiveFighter().slots[slot - 1].cost;
	}

	/**
	 * Encerra a sessão imediatamente por desistência (em qualquer estado, inclusive ATTACK).
	 * Quem saiu perde; emite `BattleEnded` com o outro lado vencedor.
	 */
	public requestQuit(player: Player): boolean {
		if (!this.playerSessions.has(player)) return false;
		this.quit(player, false);
		return true;
	}

	public quit(player: Player, disconnected = false): void {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) {
			if (disconnected) this.remoteService.forgetPlayer(player);
			return;
		}

		const session = playerSession.session;
		const losingSide = playerSession.side;
		const winnerSide = session.sides[0] === losingSide ? session.sides[1] : session.sides[0];
		this.finishSession(session, winnerSide, disconnected ? player : undefined);
		this.destroySession(session);
		if (disconnected) this.remoteService.forgetPlayer(player);
	}

	public step(dt: number): void {
		const clampedDt = math.max(dt, 0);
		const sessionsToDestroy: BattleSessionRecord[] = [];
		for (const session of this.activeSessions) {
			if (session.closed) continue;
			const [ok, result] = pcall(() => this.stepSession(session, clampedDt));
			if (!ok) {
				warn(`[BattleSessionService] erro na sessão battle-${session.id}: ${tostring(result)}`);
				const [finishOk, finishError] = pcall(() => this.finishSession(session, undefined));
				if (!finishOk) {
					warn(`[BattleSessionService] erro ao encerrar sessão battle-${session.id}: ${tostring(finishError)}`);
				}
				sessionsToDestroy.push(session);
				continue;
			}
			if (result === true) sessionsToDestroy.push(session);
		}
		for (const session of sessionsToDestroy) this.destroySession(session);
	}

	/** Avança uma sessão (step + syncAtb). Retorna `true` quando a sessão terminou e deve ser destruída. */
	private stepSession(session: BattleSessionRecord, clampedDt: number): boolean {
		let remainingDt = clampedDt;
		if (session.paused) {
			const remainingPauseBudget = math.max(PVE_PAUSE_MAX_SECONDS - session.pauseAccumulatedSeconds, 0);
			if (remainingDt + FLOAT_TOLERANCE < remainingPauseBudget) {
				session.pauseAccumulatedSeconds += remainingDt;
				return false;
			}
			session.pauseAccumulatedSeconds = PVE_PAUSE_MAX_SECONDS;
			session.paused = false;
			remainingDt = math.max(remainingDt - remainingPauseBudget, 0);
			if (remainingDt <= FLOAT_TOLERANCE) return false;
		}

		session.secondsWithoutAction += remainingDt;
		if (session.battle.state === "IDLE") session.secondsOutsideIdle = 0;
		else session.secondsOutsideIdle += remainingDt;
		session.battle.step(remainingDt);
		if (!session.ended && !session.closed && !session.paused) {
			for (const aiController of session.aiControllers) {
				if (session.ended || session.closed) break;
				aiController.step(remainingDt);
			}
		}
		if (session.battle.state === "IDLE") session.secondsOutsideIdle = 0;
		if (!session.ended && session.secondsOutsideIdle >= BATTLE_STALL_TIMEOUT_SECONDS) {
			this.finishSession(session, undefined);
		}
		if (!session.ended && session.secondsWithoutAction >= BATTLE_INACTIVITY_TIMEOUT_SECONDS) {
			this.finishSession(session, undefined);
		}
		if (session.ended) return true;
		this.syncAtb(session, remainingDt);
		return false;
	}

	private handleSkillRequest(player: Player, slot: SkillSlot): void {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined || playerSession.session.closed || playerSession.session.paused) return;
		if (playerSession.session.battle.requestSkill(playerSession.side, slot)) {
			playerSession.session.secondsWithoutAction = 0;
		}
	}

	private handleSwitchRequest(player: Player, clientIndex: number): void {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined || playerSession.session.closed || playerSession.session.paused) return;
		const fighterIndex = (clientIndex - MIN_CLIENT_FIGHTER_INDEX) as FighterIndex;
		if (playerSession.session.battle.requestSwitch(playerSession.side, fighterIndex)) {
			playerSession.session.secondsWithoutAction = 0;
		}
	}

	private connectBattleEvents(session: BattleSessionRecord): void {
		const events = session.battle.events;
		session.disconnectors.push(
			events.state.connect((state) => {
				const payload: StateChangedPayload = { state };
				this.sendToParticipants(session, (player) => this.remoteService.sendStateChanged(player, payload));
			}),
			events.switchPerformed.connect(({ side, previousFighter, activeFighter }) => {
				const payload: SwitchPerformedPayload = {
					sideId: this.getSideId(session, side),
					previousFighterId: this.getFighterId(session, previousFighter),
					activeFighterId: this.getFighterId(session, activeFighter),
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendSwitchPerformed(player, payload));
			}),
			events.attackStarted.connect(({ attacker, target, slot }) => {
				const payload: AttackStartedPayload = {
					attackerId: this.getFighterId(session, attacker),
					targetId: this.getFighterId(session, target),
					slot,
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendAttackStarted(player, payload));
			}),
			events.hitResolved.connect(({ hitIndex, hit, crit, damage, target, followUpCancelled }) => {
				const payload: HitResolvedPayload = {
					hitIndex,
					hit,
					crit,
					damage,
					targetId: this.getFighterId(session, target),
					followUpCancelled,
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendHitResolved(player, payload));
			}),
			events.effectApplied.connect(({ target, effect, duration, renewed }) => {
				const payload: EffectAppliedPayload = {
					targetId: this.getFighterId(session, target),
					effect,
					duration,
					renewed,
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendEffectApplied(player, payload));
			}),
			events.effectTick.connect(({ target, effect, damage, remainingTicks }) => {
				const payload: EffectTickPayload = {
					targetId: this.getFighterId(session, target),
					effect,
					damage,
					remainingTicks,
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendEffectTick(player, payload));
			}),
			events.effectExpired.connect(({ target, effect }) => {
				const payload: EffectExpiredPayload = {
					targetId: this.getFighterId(session, target),
					effect,
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendEffectExpired(player, payload));
			}),
			events.death.connect(({ side, fighter, nextActive }) => {
				const payload: FighterDiedPayload = {
					sideId: this.getSideId(session, side),
					fighterId: this.getFighterId(session, fighter),
					nextActive: nextActive === undefined ? undefined : this.getFighterId(session, nextActive),
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendFighterDied(player, payload));
			}),
			events.battleEnd.connect((winnerSide) => {
				this.finishSession(session, winnerSide, undefined, true);
			}),
		);
	}

	private finishSession(
		session: BattleSessionRecord,
		winnerSide: BattleSide | undefined,
		excludedPlayer?: Player,
		naturalEnd = false,
	): void {
		if (session.ended || session.closed) return;
		session.ended = true;
		for (const participant of session.participants) {
			const player = participant.player;
			if (player === excludedPlayer || player.Parent !== Players) continue;
			let tinyesReward = 0;
			let xpRewards: FighterXpReward[] | undefined;
			if (
				naturalEnd && session.mode === "PVE" && session.participants.size() === 1 &&
				participant.side === winnerSide && !session.rewardPaid
			) {
				// TODO: PVP casual, Rival e teto diário Bronze aguardam regras do autor.
				session.rewardPaid = true;
				xpRewards = this.awardSessionXp(session, participant);
				if (this.tinyesService !== undefined) {
					const range = TINYES_WIN_BY_TIER.Bronze;
					const amount = math.clamp(range.min + math.floor(session.rewardRng() * (range.max - range.min + 1)), range.min, range.max);
					if (this.tinyesService.addTinyes(player, amount, "PVE_Bronze_victory").ok) tinyesReward = amount;
				}
			}
			this.remoteService.sendBattleEnded(player, {
				winnerSideId: winnerSide === undefined ? undefined : this.getSideId(session, winnerSide),
				tinyesReward,
				xpRewards,
			});
		}
	}

	private awardSessionXp(session: BattleSessionRecord, participant: SessionParticipant): FighterXpReward[] | undefined {
		const progression = this.progressionService;
		if (progression === undefined) return undefined;
		const enemy = session.sides[0] === participant.side ? session.sides[1] : session.sides[0];
		let levelSum = 0;
		for (const fighter of enemy.fighters) levelSum += fighter.level;
		const avgEnemyLevel = levelSum / enemy.fighters.size();
		const team: [TeamBattleXpEntry?, TeamBattleXpEntry?, TeamBattleXpEntry?] = [];
		const previous = participant.side.fighters.map((fighter, index) => {
			const itemUuid = fighter.itemUuid;
			if (itemUuid === undefined) return undefined;
			team[index] = { itemUuid, damageDealt: session.battle.getDamageDealt(participant.side, itemUuid) };
			return progression.getFighter(participant.player, itemUuid);
		});
		const updated = progression.awardPostBattleTeamXp(participant.player, avgEnemyLevel, true, team);
		const rewards: FighterXpReward[] = [];
		for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
			const item = updated[index];
			const before = previous[index];
			if (item === undefined || before === undefined) continue;
			// Diferença acumulada da curva: inclui múltiplos níveis e somente XP útil no cap.
			let xpGained = item.xp - before.xp;
			for (let level = before.level; level < item.level; level++) xpGained += calcXpForNextLevel(level);
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
		return rewards;
	}

	private broadcastBattleStarted(session: BattleSessionRecord): void {
		const fighters: BattleFighterSnapshot[] = [];
		for (const sideIndex of $range(0, session.sides.size() - 1)) {
			const sessionSide = session.sides[sideIndex];
			for (const index of $range(0, sessionSide.fighters.size() - 1)) {
				const fighter = sessionSide.fighters[index];
				fighters.push({
					sideId: session.sideIds[sideIndex],
					targetId: this.getFighterId(session, fighter),
					fighterId: fighter.fighterId,
					className: fighter.className,
					level: fighter.level,
					s3Unlocked: fighter.level >= S3_UNLOCK_LEVEL,
					hp: fighter.hp,
					hpMax: fighter.hpMax,
					active: sessionSide.activeIndex === index,
					slotCosts: [fighter.slots[0].cost, fighter.slots[1].cost, fighter.slots[2].cost],
				});
			}
		}
		const payload: BattleStartedPayload = {
			sides: session.sideIds,
			fighters,
			mode: session.mode,
			canPause: session.mode === "PVE",
		};
		this.sendToParticipants(session, (player) => this.remoteService.sendBattleStarted(player, payload));
	}

	private syncAtb(session: BattleSessionRecord, dt: number): void {
		session.atbSyncElapsed += dt;
		while (session.atbSyncElapsed >= ATB_SYNC_INTERVAL_SECONDS) {
			session.atbSyncElapsed -= ATB_SYNC_INTERVAL_SECONDS;
			for (const sideIndex of $range(0, session.sides.size() - 1)) {
				const side = session.sides[sideIndex];
				const sideId = session.sideIds[sideIndex];
				const payload: AtbSyncPayload = { sideId, atb: side.atb };
				this.sendToParticipants(session, (player) => this.remoteService.sendAtbSync(player, payload));
			}
		}
	}

	private sendToParticipants(session: BattleSessionRecord, send: (player: Player) => void): void {
		for (const participant of session.participants) send(participant.player);
	}

	private getSideId(session: BattleSessionRecord, side: BattleSide): string {
		return session.sideIdBySide.get(side) ?? "";
	}

	private getFighterId(session: BattleSessionRecord, fighter: Fighter): string {
		return session.fighterIds.get(fighter) ?? "";
	}

	private destroySession(session: BattleSessionRecord): void {
		if (session.closed) return;
		session.closed = true;
		session.paused = false;
		for (const aiController of session.aiControllers) {
			aiController.destroy();
		}
		session.aiControllers.clear();
		for (const disconnect of session.disconnectors) disconnect();
		session.disconnectors.clear();
		for (const participant of session.participants) {
			const playerSession = this.playerSessions.get(participant.player);
			if (playerSession?.session === session) this.playerSessions.delete(participant.player);
		}
		session.sideIdBySide.clear();
		session.fighterIds.clear();
		this.activeSessions = this.activeSessions.filter((activeSession) => activeSession !== session);
	}
}
