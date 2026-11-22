import type { BattleEncounterKind } from "../../shared/Config";
import { ArenaPlayerTransportService, type ArenaSessionTransportResult } from "./ArenaPlayerTransport";
import type { ArenaRegistry, ArenaReservation, ArenaReserveFailureReason } from "./ArenaRegistry";
import type { BattleSessionRecord } from "./BattleSessionRecord";

function getArenaParticipantKey(player: Player): string {
	return player.UserId !== undefined ? `u:${player.UserId}` : `n:${player.Name}`;
}

export function cleanupSessionStep(name: string, cleanup: () => void): void {
	const [ok, failure] = pcall(cleanup);
	if (!ok) warn(`[BattleSessionService] limpeza ${name}: ${tostring(failure)}`);
}

export class BattleSessionArena {
	public lastCreateFailureReason?: ArenaReserveFailureReason;
	public lastTransportResult?: ArenaSessionTransportResult;

	public constructor(
		private readonly registry?: ArenaRegistry,
		public readonly transportService = new ArenaPlayerTransportService(),
	) {}

	public reserve(sessionKey: string, kind: BattleEncounterKind, firstPlayer: Player, secondPlayer?: Player): {
		ok: boolean; reservation?: ArenaReservation;
	} {
		if (this.registry === undefined) return { ok: true };
		const participantKeys: string[] = [getArenaParticipantKey(firstPlayer)];
		if (secondPlayer !== undefined) {
			participantKeys.push(getArenaParticipantKey(secondPlayer));
		}
		const reserveResult = this.registry.reserveForSession(sessionKey, kind, {
			participantKeys,
		});
		if (!reserveResult.ok || reserveResult.reservation === undefined) {
			this.lastCreateFailureReason = reserveResult.reason;
			return { ok: false };
		}
		return { ok: true, reservation: reserveResult.reservation };
	}

	public forget(player: Player): void {
		this.transportService.forgetPlayer(player);
		this.registry?.forgetParticipant(getArenaParticipantKey(player));
	}

	public cageFrame(player: Player): CFrame | undefined {
		return this.transportService.getActiveParticipantSnapshot(player)?.spawnCFrame;
	}

	public contain(session: BattleSessionRecord): void {
		this.transportService.enforceContainment(`battle-${session.id}`);
	}

	public isMissing(session: BattleSessionRecord): boolean {
		return session.arenaReservation !== undefined && session.arenaReservation.instance.Parent === undefined;
	}

	public transport(session: BattleSessionRecord): boolean {
		const reservation = session.arenaReservation;
		if (reservation === undefined) return true;
		const result = this.transportService.transportSessionParticipants(
			`battle-${session.id}`,
			reservation,
			session.participants.map(({ player, side }) => ({ player, physicalSideIndex: side === session.sides[0] ? 0 : 1 })),
		);
		this.lastTransportResult = result;
		if (result.ok) session.transportGeneration = result.generation;
		return result.ok || result.cageMissing;
	}

	public restore(session: BattleSessionRecord): void {
		const sessionKey = `battle-${session.id}`;
		const generation = session.transportGeneration;
		cleanupSessionStep("transporte", () => {
			this.transportService.restoreSession(sessionKey, generation);
		});
	}

	public release(session: BattleSessionRecord): void {
		const reservation = session.arenaReservation;
		session.arenaReservation = undefined;
		this.releaseReservation(reservation);
	}

	public releaseReservation(reservation?: ArenaReservation): void {
		if (reservation !== undefined) cleanupSessionStep("arena", () => this.registry?.releaseReservation(reservation));
	}
}
