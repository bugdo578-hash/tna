import { calcAverageLevel } from "../../shared/RewardMath";
import type { BattleEndReason } from "../../shared/Remotes";
import { Players, RunService } from "@rbxts/services";
import {
	ATB_SYNC_INTERVAL_SECONDS,
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	BATTLE_STALL_TIMEOUT_SECONDS,
	FLOAT_TOLERANCE,
	MIN_CLIENT_FIGHTER_INDEX,
	PVE_PAUSE_MAX_SECONDS,
	S3_UNLOCK_LEVEL,
	type BattleEncounterKind,
} from "../../shared/Config";
import type {
	AttackStartedPayload,
	AtbSyncPayload,
	BattleArenaPayload,
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
import type { ProgressionService } from "./ProgressionService";
import { BattleSide, type FighterIndex } from "../Components/BattleSide";
import type { Fighter } from "../Components/Fighter";
import { AIService } from "./AIService";
import type { ArenaRegistry, ArenaReservation, ArenaReserveFailureReason } from "./ArenaRegistry";
import { BattleRewardService } from "./BattleRewardService";
import { BattleService } from "./BattleService";
import type { BattleRemoteAdapter } from "./RemoteService";
import type { TinyesService } from "./TinyesService";

interface SessionParticipant {
	readonly player: Player;
	readonly side: BattleSide;
	readonly sideId: string;
}

interface BattleSessionRecord {
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
	private lastCreateFailureReason?: ArenaReserveFailureReason;
	private readonly rewardService: BattleRewardService;

	public constructor(
		private readonly remoteService: BattleRemoteAdapter,
		private readonly tinyesService?: TinyesService,
		private readonly progressionService?: ProgressionService,
		private readonly arenaRegistry?: ArenaRegistry,
	) {
		this.rewardService = new BattleRewardService(tinyesService, progressionService);
	}

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
		onFinished?: (firstSideWon: boolean) => void,
		encounterKind?: BattleEncounterKind,
	): boolean {
		this.lastCreateFailureReason = undefined;
		if (firstPlayer.Parent !== Players) return false;
		if (secondPlayer !== undefined && secondPlayer.Parent !== Players) return false;
		if (this.playerSessions.has(firstPlayer)) return false;
		if (secondPlayer !== undefined && (secondPlayer === firstPlayer || this.playerSessions.has(secondPlayer))) return false;

		const id = this.nextSessionId;
		this.nextSessionId += 1;
		const sessionKey = `battle-${id}`;

		let arenaReservation: ArenaReservation | undefined;
		if (this.arenaRegistry !== undefined) {
			const arenaKind: BattleEncounterKind = mode === "PVP" ? "PVP" : (encounterKind ?? "PVE");
			const reserveResult = this.arenaRegistry.reserveForSession(sessionKey, arenaKind);
			if (!reserveResult.ok || reserveResult.reservation === undefined) {
				this.lastCreateFailureReason = reserveResult.reason;
				return false;
			}
			arenaReservation = reserveResult.reservation;
		}

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

		let battle: BattleService | undefined;
		const [battleOk, battleError] = pcall(() => {
			battle = new BattleService(firstSide, secondSide, rng);
		});
		if (!battleOk || battle === undefined) {
			if (arenaReservation !== undefined && this.arenaRegistry !== undefined) {
				this.cleanupSessionStep("arena rollback", () => this.arenaRegistry?.releaseReservation(arenaReservation));
			}
			warn(`[BattleSessionService] erro ao inicializar ${sessionKey}: ${tostring(battleError)}`);
			return false;
		}

		const session: BattleSessionRecord = {
			resolvedHits: 0,
			averageLevels: [calcAverageLevel(firstSide.fighters.map(f => f.level)), calcAverageLevel(secondSide.fighters.map(f => f.level))],
			totalMaxHp: [firstSide.fighters.reduce((sum, f) => sum + f.hpMax, 0), secondSide.fighters.reduce((sum, f) => sum + f.hpMax, 0)],
			onFinished,
			rewardRng: rng,
			rewardPaid: false,
			id,
			battle,
			mode,
			arenaReservation,
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
		const [ok, failure] = pcall(() => {
			this.connectBattleEvents(session);
			this.broadcastBattleStarted(session);
		});
		if (!ok) {
			this.abortSession(session, failure);
			return false;
		}
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

	public getLastCreateFailureReason(): ArenaReserveFailureReason | undefined {
		return this.lastCreateFailureReason;
	}

	public getSessionArenaReservation(player: Player): ArenaReservation | undefined {
		return this.playerSessions.get(player)?.session.arenaReservation;
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
		const [ok, failure] = pcall(() => this.finishSession(session, winnerSide, disconnected ? "disconnect" : "quit"));
		this.destroySession(session);
		if (!ok) warn(`[BattleSessionService] erro ao sair: ${tostring(failure)}`);
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
				const [finishOk, finishError] = pcall(() => this.finishSession(session, undefined, "error"));
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
			this.finishSession(session, undefined, "timeout");
		}
		if (!session.ended && session.secondsWithoutAction >= BATTLE_INACTIVITY_TIMEOUT_SECONDS) {
			this.finishSession(session, undefined, "timeout");
		}
		if (session.ended) return true;
		this.syncAtb(session, remainingDt);
		return false;
	}

	private handleSkillRequest(player: Player, slot: SkillSlot): void {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined || playerSession.session.closed || playerSession.session.paused) return;
		const [ok, failure] = pcall(() => {
			if (playerSession.session.battle.requestSkill(playerSession.side, slot)) {
				playerSession.session.secondsWithoutAction = 0;
			}
		});
		if (!ok) this.abortSession(playerSession.session, failure);
	}

	private handleSwitchRequest(player: Player, clientIndex: number): void {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined || playerSession.session.closed || playerSession.session.paused) return;
		const fighterIndex = (clientIndex - MIN_CLIENT_FIGHTER_INDEX) as FighterIndex;
		const [ok, failure] = pcall(() => {
			if (playerSession.session.battle.requestSwitch(playerSession.side, fighterIndex)) {
				playerSession.session.secondsWithoutAction = 0;
			}
		});
		if (!ok) this.abortSession(playerSession.session, failure);
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
				session.resolvedHits++;
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
				this.finishSession(session, winnerSide, "victory");
			}),
		);
	}

	private finishSession(
		session: BattleSessionRecord,
		winnerSide: BattleSide | undefined,
		reason: BattleEndReason = "error",
	): void {
		if (session.ended || session.closed) return;
		session.ended = true;
		session.reason = reason;
		this.releaseSession(session, reason === "victory" && winnerSide === session.sides[0]);
		for (const participant of session.participants) {
			const player = participant.player;
			if (player.Parent !== Players) continue;
			const { tinyesReward, rewardBlockedReason, xpRewards } = this.rewardService.settleParticipant(
				session, participant, winnerSide, reason,
				(rewardSession, rewardParticipant, maxTotalXp) => this.awardSessionXp(rewardSession, rewardParticipant, maxTotalXp),
			);
			const [sent, sendError] = pcall(() => this.remoteService.sendBattleEnded(player, {
				winnerSideId: winnerSide === undefined ? undefined : this.getSideId(session, winnerSide),
				tinyesReward: session.mode === "PVP" && participant.side !== winnerSide ? undefined : tinyesReward,
				reason,
				rewardBlockedReason,
				xpRewards,
			}));
			if (!sent) warn(`[BattleSessionService] erro de resultado privado: ${tostring(sendError)}`);
		}
		this.releaseArena(session);
	}

	private awardSessionXp(session: BattleSessionRecord, participant: SessionParticipant, maxTotalXp = math.huge): FighterXpReward[] | undefined {
		return this.rewardService.awardSessionXp(session, participant, maxTotalXp);
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
		const arena: BattleArenaPayload | undefined = session.arenaReservation === undefined
			? undefined
			: {
				arenaId: session.arenaReservation.arenaId,
				arenaType: session.arenaReservation.arenaType,
				instanceId: session.arenaReservation.instanceId,
				physicalSides: session.sideIds,
			};
		const payload: BattleStartedPayload = {
			sides: session.sideIds,
			fighters,
			mode: session.mode,
			canPause: session.mode === "PVE",
			arena,
		};
		for (const participant of session.participants) {
			const opponentId = session.sideIds[0] === participant.sideId ? session.sideIds[1] : session.sideIds[0];
			this.remoteService.sendBattleStarted(participant.player, { ...payload, sides: [participant.sideId, opponentId] });
		}
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
		this.releaseSession(session);
		this.releaseArena(session);
		session.paused = false;
		for (const aiController of session.aiControllers) {
			this.cleanupSessionStep("IA", () => aiController.destroy());
		}
		session.aiControllers.clear();
		for (const disconnect of session.disconnectors) this.cleanupSessionStep("conexao", disconnect);
		session.disconnectors.clear();
		for (const participant of session.participants) {
			const playerSession = this.playerSessions.get(participant.player);
			if (playerSession?.session === session) this.playerSessions.delete(participant.player);
		}
		session.sideIdBySide.clear();
		session.fighterIds.clear();
		this.activeSessions = this.activeSessions.filter((activeSession) => activeSession !== session);
	}

	private cleanupSessionStep(name: string, cleanup: () => void): void {
		const [ok, failure] = pcall(cleanup);
		if (!ok) warn(`[BattleSessionService] limpeza ${name}: ${tostring(failure)}`);
	}

	private releaseSession(session: BattleSessionRecord, firstSideWon = false): void {
		const release = session.onFinished;
		session.onFinished = undefined;
		if (release !== undefined) {
			const [ok, failure] = pcall(() => release(firstSideWon));
			if (!ok) warn(`[BattleSessionService] erro de limpeza: ${tostring(failure)}`);
		}
	}

	private releaseArena(session: BattleSessionRecord): void {
		const reservation = session.arenaReservation;
		session.arenaReservation = undefined;
		if (reservation !== undefined && this.arenaRegistry !== undefined) {
			this.cleanupSessionStep("arena", () => this.arenaRegistry?.releaseReservation(reservation));
		}
	}

	private abortSession(session: BattleSessionRecord, failure: unknown): void {
		warn(`[BattleSessionService] erro na sessão battle-${session.id}: ${tostring(failure)}`);
		const [finished, finishError] = pcall(() => this.finishSession(session, undefined, "error"));
		if (!finished) warn(`[BattleSessionService] erro ao abortar battle-${session.id}: ${tostring(finishError)}`);
		this.destroySession(session);
	}
}
