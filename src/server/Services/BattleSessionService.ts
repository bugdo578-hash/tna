import type { BattleEndReason, BattleTransitionAck } from "../../shared/Remotes";
import { Players, RunService } from "@rbxts/services";
import {
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	BATTLE_STALL_TIMEOUT_SECONDS,
	FLOAT_TOLERANCE,
	MIN_CLIENT_FIGHTER_INDEX,
	PVE_PAUSE_MAX_SECONDS,
	type BattleEncounterKind,
} from "../../shared/Config";
import type { FighterXpReward, SkillSlot } from "../../shared/TypeDefs";
import type { ProgressionService } from "./ProgressionService";
import type { BattleSide, FighterIndex } from "../Components/BattleSide";
import { AIService } from "./AIService";
import type { ArenaPlayerTransportService, ArenaSessionTransportResult } from "./ArenaPlayerTransport";
import type { ArenaRegistry, ArenaReservation, ArenaReserveFailureReason } from "./ArenaRegistry";
import { BattleSessionArena, cleanupSessionStep } from "./BattleSessionArena";
import { BattleSessionPresentation } from "./BattleSessionPresentation";
import { createBattleSessionRecord, type BattleSessionRecord, type SessionMode, type SessionParticipant } from "./BattleSessionRecord";
import { BattleRewardService } from "./BattleRewardService";
import { BattleService } from "./BattleService";
import type { BattleRemoteAdapter } from "./RemoteService";
import type { TinyesService } from "./TinyesService";

export type { SessionMode } from "./BattleSessionRecord";

interface PlayerBattleSession {
	readonly session: BattleSessionRecord;
	readonly side: BattleSide;
}

export class BattleSessionService {
	private readonly playerSessions = new Map<Player, PlayerBattleSession>();
	private activeSessions: BattleSessionRecord[] = [];
	private nextSessionId = 0;
	private started = false;
	private readonly presentation: BattleSessionPresentation;
	private readonly rewardService: BattleRewardService;
	private readonly arena: BattleSessionArena;

	public constructor(
		private readonly remoteService: BattleRemoteAdapter,
		private readonly tinyesService?: TinyesService,
		private readonly progressionService?: ProgressionService,
		arenaRegistry?: ArenaRegistry,
		playerTransport?: ArenaPlayerTransportService,
		private readonly preparationClock?: () => number,
	) {
		this.presentation = new BattleSessionPresentation(remoteService);
		this.rewardService = new BattleRewardService(tinyesService, progressionService);
		this.arena = new BattleSessionArena(arenaRegistry, playerTransport);
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
		this.remoteService.transition?.bind((player, id, ack) => this.receiveTransition(player, id, ack));
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
		this.arena.lastCreateFailureReason = undefined;
		this.arena.lastTransportResult = undefined;
		if (firstPlayer.Parent !== Players) return false;
		if (secondPlayer !== undefined && secondPlayer.Parent !== Players) return false;
		if (this.playerSessions.has(firstPlayer)) return false;
		if (secondPlayer !== undefined && (secondPlayer === firstPlayer || this.playerSessions.has(secondPlayer))) return false;

		const id = this.nextSessionId;
		this.nextSessionId += 1;
		const sessionKey = `battle-${id}`;

		const { ok: reserved, reservation: arenaReservation } = this.arena.reserve(
			sessionKey, mode === "PVP" ? "PVP" : (encounterKind ?? "PVE"), firstPlayer, secondPlayer,
		);
		if (!reserved) return false;

		let battle: BattleService | undefined;
		const [battleOk, battleError] = pcall(() => {
			battle = new BattleService(firstSide, secondSide, rng);
		});
		if (!battleOk || battle === undefined) {
			this.arena.releaseReservation(arenaReservation);
			warn(`[BattleSessionService] erro ao inicializar ${sessionKey}: ${tostring(battleError)}`);
			return false;
		}

		const session = createBattleSessionRecord(
			id, battle, [firstSide, secondSide], firstPlayer, secondPlayer, rng, mode, onFinished, arenaReservation,
			this.remoteService.transition, this.preparationClock,
		);

		if (session.preparation === undefined && !this.arena.transport(session)) {
			this.arena.release(session);
			return false;
		}
		for (const participant of session.participants) {
			this.playerSessions.set(participant.player, { session, side: participant.side });
		}
		this.activeSessions.push(session);
		const [ok, failure] = pcall(() => {
			this.presentation.connect(session, (winner) => this.finishSession(session, winner, "victory"));
			if (session.preparation !== undefined) session.preparation.cover();
			else this.presentation.sendStarted(session);
		});
		if (!ok) {
			this.abortSession(session, failure);
			return false;
		}
		return true;
	}

	private receiveTransition(player: Player, id: number, ack: BattleTransitionAck): void {
		const session = this.playerSessions.get(player)?.session;
		const preparation = session?.preparation;
		if (session === undefined || session.id !== id || session.closed || preparation === undefined) return;
		if (!session.ended && ack === "cancel" && !preparation.isRunning()) this.quit(player);
		else if (!session.ended && ack === "failed" && !preparation.isRunning()) this.finishSession(session, undefined, "error");
		else preparation.accept(player, ack);
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
		if (!this.isRunning(session) || session.mode !== "PVE") return false;

		const changed = this.setPaused(player, !session.paused);
		if (!changed) this.presentation.sendState(session);
		return changed;
	}

	public setPaused(player: Player, paused: boolean): boolean {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return false;
		const session = playerSession.session;
		if (!this.isRunning(session) || session.mode !== "PVE") return false;
		if (paused && session.pauseAccumulatedSeconds + FLOAT_TOLERANCE >= PVE_PAUSE_MAX_SECONDS) return false;
		session.paused = paused;
		this.presentation.sendState(session);
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
		return this.arena.lastCreateFailureReason;
	}

	public getSessionArenaReservation(player: Player): ArenaReservation | undefined {
		return this.playerSessions.get(player)?.session.arenaReservation;
	}

	public getPlayerTransportService(): ArenaPlayerTransportService {
		return this.arena.transportService;
	}

	public getLastTransportResult(): ArenaSessionTransportResult | undefined {
		return this.arena.lastTransportResult;
	}

	/**
	 * Gatilho de ação de um lado da sessão (usado pelo loop dev/IA sem depender de RemoteEvent do client).
	 */
	public triggerSideSkill(player: Player, sideIndex: 0 | 1, slot: SkillSlot): boolean {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined) return false;
		const session = playerSession.session;
		if (!this.isRunning(session) || session.paused) return false;
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
		if (!this.isRunning(session) || session.paused) return false;
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
			isPaused: () => session.paused || !this.isRunning(session),
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
			if (disconnected) this.forgetParticipant(player);
			return;
		}

		const session = playerSession.session;
		if (disconnected) this.forgetParticipant(player);
		const losingSide = playerSession.side;
		const winnerSide = this.isRunning(session) ? (session.sides[0] === losingSide ? session.sides[1] : session.sides[0]) : undefined;
		const [ok, failure] = pcall(() => this.finishSession(session, winnerSide, disconnected ? "disconnect" : "quit"));
		if (disconnected) session.preparation?.forget(player);
		if (session.finalizeAfterCover === undefined) this.destroySession(session);
		if (!ok) warn(`[BattleSessionService] erro ao sair: ${tostring(failure)}`);
	}

	private forgetParticipant(player: Player): void {
		this.arena.forget(player);
		this.remoteService.forgetPlayer(player);
	}

	public step(dt: number): void {
		const clampedDt = math.max(dt, 0);
		const sessionsToDestroy: BattleSessionRecord[] = [];
		for (const session of this.activeSessions) {
			if (session.closed) continue;
			const [ok, result] = pcall(() => this.stepSession(session, clampedDt));
			if (!ok) {
				this.abortSession(session, result);
				continue;
			}
			if (result === true) sessionsToDestroy.push(session);
		}
		for (const session of sessionsToDestroy) this.destroySession(session);
	}

	private isRunning(session: BattleSessionRecord): boolean {
		return !session.closed && !session.ended && (session.preparation?.isRunning() ?? true);
	}

	/** Avança uma sessão (step + syncAtb). Retorna `true` quando a sessão terminou e deve ser destruída. */
	private stepSession(session: BattleSessionRecord, clampedDt: number): boolean {
		if (session.ended) {
			if (session.finalizeAfterCover === undefined) return true;
			if (!session.preparation?.canFinish()) return false;
			const finalize = session.finalizeAfterCover;
			session.finalizeAfterCover = undefined;
			finalize();
			return true;
		}
		if (session.preparation !== undefined && this.arena.isMissing(session)) {
			this.finishSession(session, undefined, "error");
			return false;
		}
		if (!this.isRunning(session)) {
			this.arena.contain(session);
			const action = session.preparation?.step();
			if (action === "load") {
				if (this.arena.transport(session)) this.presentation.sendStarted(session);
				else this.finishSession(session, undefined, "error");
			} else if (action === "go") {
				this.presentation.sendReleased(session);
			} else if (action === "timeout") {
				this.finishSession(session, undefined, "timeout");
			}
			return false;
		}
		let remainingDt = clampedDt;
		if (session.paused) {
			const remainingPauseBudget = math.max(PVE_PAUSE_MAX_SECONDS - session.pauseAccumulatedSeconds, 0);
			if (remainingDt + FLOAT_TOLERANCE < remainingPauseBudget) {
				session.pauseAccumulatedSeconds += remainingDt;
				return false;
			}
			session.pauseAccumulatedSeconds = PVE_PAUSE_MAX_SECONDS;
			session.paused = false;
			this.presentation.sendState(session);
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
		if (session.ended) return session.finalizeAfterCover === undefined;
		this.arena.contain(session);
		this.presentation.syncAtb(session, remainingDt);
		return false;
	}

	private handleSkillRequest(player: Player, slot: SkillSlot): void {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined || !this.isRunning(playerSession.session) || playerSession.session.paused) return;
		const [ok, failure] = pcall(() => {
			if (playerSession.session.battle.requestSkill(playerSession.side, slot)) {
				playerSession.session.secondsWithoutAction = 0;
			}
		});
		if (!ok) this.abortSession(playerSession.session, failure);
	}

	private handleSwitchRequest(player: Player, clientIndex: number): void {
		const playerSession = this.playerSessions.get(player);
		if (playerSession === undefined || !this.isRunning(playerSession.session) || playerSession.session.paused) return;
		const fighterIndex = (clientIndex - MIN_CLIENT_FIGHTER_INDEX) as FighterIndex;
		const [ok, failure] = pcall(() => {
			if (playerSession.session.battle.requestSwitch(playerSession.side, fighterIndex)) {
				playerSession.session.secondsWithoutAction = 0;
			}
		});
		if (!ok) this.abortSession(playerSession.session, failure);
	}

	private finishSession(
		session: BattleSessionRecord,
		winnerSide: BattleSide | undefined,
		reason: BattleEndReason = "error",
	): void {
		if (session.ended || session.closed) return;
		session.ended = true;
		session.reason = reason;
		if (session.preparation !== undefined) {
			session.finalizeAfterCover = () => this.publishResult(session, winnerSide, reason);
			session.preparation.beginExit((player) => this.arena.cageFrame(player));
		} else {
			this.publishResult(session, winnerSide, reason);
		}
	}

	private publishResult(session: BattleSessionRecord, winnerSide: BattleSide | undefined, reason: BattleEndReason): void {
		this.arena.restore(session);
		this.releaseSession(session, reason === "victory" && winnerSide === session.sides[0]);
		for (const participant of session.participants) {
			const player = participant.player;
			if (player.Parent !== Players) continue;
			const { tinyesReward, rewardBlockedReason, xpRewards } = this.rewardService.settleParticipant(
				session, participant, winnerSide, reason,
				(rewardSession, rewardParticipant, maxTotalXp) => this.awardSessionXp(rewardSession, rewardParticipant, maxTotalXp),
			);
			const [sent, sendError] = pcall(() => this.remoteService.sendBattleEnded(player, {
				sessionId: session.id,
				transitionId: session.preparation !== undefined ? session.id : undefined,
				winnerSideId: winnerSide === undefined ? undefined : this.presentation.getSideId(session, winnerSide),
				tinyesReward: session.mode === "PVP" && participant.side !== winnerSide ? undefined : tinyesReward,
				reason,
				rewardBlockedReason,
				xpRewards,
			}));
			if (!sent) warn(`[BattleSessionService] erro de resultado privado: ${tostring(sendError)}`);
		}
		this.arena.release(session);
	}

	private awardSessionXp(session: BattleSessionRecord, participant: SessionParticipant, maxTotalXp = math.huge): FighterXpReward[] | undefined {
		return this.rewardService.awardSessionXp(session, participant, maxTotalXp);
	}

	private destroySession(session: BattleSessionRecord): void {
		if (session.closed) return;
		session.closed = true;
		this.arena.restore(session);
		this.releaseSession(session);
		this.arena.release(session);
		session.paused = false;
		for (const aiController of session.aiControllers) {
			cleanupSessionStep("IA", () => aiController.destroy());
		}
		session.aiControllers.clear();
		for (const disconnect of session.disconnectors) cleanupSessionStep("conexao", disconnect);
		session.disconnectors.clear();
		for (const participant of session.participants) {
			const playerSession = this.playerSessions.get(participant.player);
			if (playerSession?.session === session) this.playerSessions.delete(participant.player);
		}
		session.sideIdBySide.clear();
		session.fighterIds.clear();
		this.activeSessions = this.activeSessions.filter((activeSession) => activeSession !== session);
	}

	private releaseSession(session: BattleSessionRecord, firstSideWon = false): void {
		const release = session.onFinished;
		session.onFinished = undefined;
		if (release !== undefined) {
			const [ok, failure] = pcall(() => release(firstSideWon));
			if (!ok) warn(`[BattleSessionService] erro de limpeza: ${tostring(failure)}`);
		}
	}

	private abortSession(session: BattleSessionRecord, failure: unknown): void {
		warn(`[BattleSessionService] erro na sessão battle-${session.id}: ${tostring(failure)}`);
		const [finished, finishError] = pcall(() => this.finishSession(session, undefined, "error"));
		if (!finished) warn(`[BattleSessionService] erro ao abortar battle-${session.id}: ${tostring(finishError)}`);
		if (session.finalizeAfterCover === undefined) this.destroySession(session);
	}
}
