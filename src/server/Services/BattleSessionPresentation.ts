import { ATB_SYNC_INTERVAL_SECONDS, MIN_CLIENT_FIGHTER_INDEX, S3_UNLOCK_LEVEL } from "../../shared/Config";
import { getSkillId } from "../../shared/SkillData";
import type {
	AttackStartedPayload,
	AtbSyncPayload,
	BattleArenaPayload,
	BattleFighterSnapshot,
	BattleStartedPayload,
	EffectAppliedPayload,
	EffectExpiredPayload,
	EffectTickPayload,
	FighterDiedPayload,
	HitResolvedPayload,
	StateChangedPayload,
	SwitchPerformedPayload,
} from "../../shared/Remotes";
import type { BattleSide } from "../Components/BattleSide";
import type { Fighter } from "../Components/Fighter";
import type { BattleSessionRecord } from "./BattleSessionRecord";
import type { BattleRemoteAdapter } from "./RemoteService";

export class BattleSessionPresentation {
	public constructor(private readonly remoteService: BattleRemoteAdapter) {}

	public connect(session: BattleSessionRecord, onVictory: (side: BattleSide | undefined) => void): void {
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
			events.attackStarted.connect(({ attacker, target, slot, skillData }) => {
				const payload: AttackStartedPayload = {
					attackerId: this.getFighterId(session, attacker),
					targetId: this.getFighterId(session, target),
					slot,
					skillId: getSkillId(skillData, `S${slot}`),
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendAttackStarted(player, payload));
			}),
			events.hitResolved.connect(({ hitIndex, hit, crit, damage, target, followUpCancelled, noDamage }) => {
				session.resolvedHits++;
				const payload: HitResolvedPayload = {
					hitIndex,
					hit,
					crit,
					damage,
					targetId: this.getFighterId(session, target),
					followUpCancelled,
					noDamage,
				};
				this.sendToParticipants(session, (player) => this.remoteService.sendHitResolved(player, payload));
			}),
			events.effectApplied.connect(({ target, effect, duration, renewed, charges, maxCharges, remainingDuration }) => {
				const payload: EffectAppliedPayload = {
					targetId: this.getFighterId(session, target),
					effect,
					duration,
					renewed,
					charges,
					maxCharges,
					remainingDuration,
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
				onVictory(winnerSide);
			}),
		);
	}

	public sendReleased(session: BattleSessionRecord): void {
		this.sendToParticipants(session, (player) => this.remoteService.sendStateChanged(player, {
			state: session.battle.state,
			battleReleased: session.id,
		}));
	}

	public sendStarted(session: BattleSessionRecord): void {
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
					skillIds: [
						getSkillId(fighter.skillData[0], "S1"),
						getSkillId(fighter.skillData[1], "S2"),
						getSkillId(fighter.skillData[2], "S3"),
					],
				});
			}
		}
		const arena: BattleArenaPayload | undefined = session.arenaReservation === undefined
			? undefined
			: {
				arenaId: session.arenaReservation.arenaId,
				instanceId: session.arenaReservation.instanceId,
				physicalSides: session.sideIds,
			};
		const payload: BattleStartedPayload = {
			transitionId: session.preparation !== undefined ? session.id : undefined,
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

	public syncAtb(session: BattleSessionRecord, dt: number): void {
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

	public getSideId(session: BattleSessionRecord, side: BattleSide): string {
		return session.sideIdBySide.get(side) ?? "";
	}

	private getFighterId(session: BattleSessionRecord, fighter: Fighter): string {
		return session.fighterIds.get(fighter) ?? "";
	}
}
