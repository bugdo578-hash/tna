import {
	ATB_COST_RANGES,
	DOT_TICK_INTERVAL_SECONDS,
	FLOAT_TOLERANCE,
	MIN_DAMAGE,
	S3_UNLOCK_LEVEL,
} from "../../shared/Config";
import { calcCusto } from "../../shared/MathUtils";
import type { SkillData, SkillHitTimeline } from "../../shared/SkillData";
import type { BattleGlobalState, SkillSlot, StatusEffect } from "../../shared/TypeDefs";
import { BattleSide, type FighterIndex } from "../Components/BattleSide";
import type { DotStatusEffect, Fighter } from "../Components/Fighter";
import { ATBService } from "./ATBService";
import { DamageService, type HitResult } from "./DamageService";

const STATUS_EFFECT_ORDER: readonly StatusEffect[] = ["Bleed", "Burn", "Root"];

type Listener<T> = (value: T) => void;

interface ListenerRecord<T> {
	readonly callback: Listener<T>;
	connected: boolean;
}

export class Signal<T> {
	private readonly listeners: ListenerRecord<T>[] = [];

	public connect(listener: Listener<T>): () => void {
		const record: ListenerRecord<T> = { callback: listener, connected: true };
		this.listeners.push(record);
		return () => (record.connected = false);
	}

	public fire(value: T): void {
		for (const listener of this.listeners) {
			if (listener.connected) listener.callback(value);
		}
	}
}

export interface AttackStartedEvent {
	readonly attacker: Fighter;
	readonly target: Fighter;
	readonly slot: SkillSlot;
	readonly skillData: SkillData;
}

export interface SwitchPerformedEvent {
	readonly side: BattleSide;
	readonly previousFighter: Fighter;
	readonly activeFighter: Fighter;
}

export interface HitResolvedEvent extends HitResult {
	readonly hitIndex: number;
	readonly target: Fighter;
	readonly followUpCancelled: boolean;
}

export interface FighterDeathEvent {
	readonly side: BattleSide;
	readonly fighter: Fighter;
	readonly nextActive: Fighter | undefined;
}

export interface EffectAppliedEvent {
	readonly side: BattleSide;
	readonly target: Fighter;
	readonly effect: StatusEffect;
	readonly slot: SkillSlot;
	readonly duration: number;
	readonly totalDamage: number;
	readonly renewed: boolean;
}

export interface EffectTickEvent {
	readonly side: BattleSide;
	readonly target: Fighter;
	readonly effect: DotStatusEffect;
	readonly damage: number;
	readonly remainingTicks: number;
}

export interface EffectExpiredEvent {
	readonly side: BattleSide;
	readonly target: Fighter;
	readonly effect: StatusEffect;
}

export interface BattleEvents {
	readonly state: Signal<BattleGlobalState>;
	readonly switchPerformed: Signal<SwitchPerformedEvent>;
	readonly attackStarted: Signal<AttackStartedEvent>;
	readonly hitResolved: Signal<HitResolvedEvent>;
	readonly death: Signal<FighterDeathEvent>;
	readonly battleEnd: Signal<BattleSide | undefined>;
	readonly effectApplied: Signal<EffectAppliedEvent>;
	readonly effectTick: Signal<EffectTickEvent>;
	readonly effectExpired: Signal<EffectExpiredEvent>;
}

export class BattleService {
	private readonly damageBySide = new Map<BattleSide, Map<string, number>>();

	public getDamageDealt(side: BattleSide, itemUuid: string): number {
		return this.damageBySide.get(side)?.get(itemUuid) ?? 0;
	}

	private recordDamage(source: Fighter | undefined, damage: number): void {
		if (source === undefined || source.itemUuid === undefined || damage <= 0) return;
		for (const side of this.sides) {
			if (!side.fighters.includes(source)) continue;
			let totals = this.damageBySide.get(side);
			if (totals === undefined) {
				totals = new Map<string, number>();
				this.damageBySide.set(side, totals);
			}
			totals.set(source.itemUuid, (totals.get(source.itemUuid) ?? 0) + damage);
			return;
		}
	}
	state: BattleGlobalState = "IDLE";
	readonly events: BattleEvents = {
		state: new Signal<BattleGlobalState>(),
		switchPerformed: new Signal<SwitchPerformedEvent>(),
		attackStarted: new Signal<AttackStartedEvent>(),
		hitResolved: new Signal<HitResolvedEvent>(),
		death: new Signal<FighterDeathEvent>(),
		battleEnd: new Signal<BattleSide | undefined>(),
		effectApplied: new Signal<EffectAppliedEvent>(),
		effectTick: new Signal<EffectTickEvent>(),
		effectExpired: new Signal<EffectExpiredEvent>(),
	};

	private readonly atbService = new ATBService();
	private readonly damageService = new DamageService();
	private readonly sides: readonly [BattleSide, BattleSide];
	private phaseElapsed = 0;
	private nextHitIndex = 0;
	private skillSlot: SkillSlot | undefined;
	private skillData: SkillData | undefined;
	private attackerSide: BattleSide | undefined;
	private connectedTarget: Fighter | undefined;
	private connectedTargetSide: BattleSide | undefined;
	private connectedDamageOnTarget = 0;
	private returnDuration = 0;
	private nextTickSideIndex: 0 | 1 = 0;
	private battleEnded = false;

	public constructor(
		firstSide: BattleSide,
		secondSide: BattleSide,
		private readonly rng: () => number,
	) {
		this.sides = [firstSide, secondSide];
	}

	public requestSwitch(side: BattleSide, index: FighterIndex): boolean {
		if (this.state !== "IDLE" || this.battleEnded || !this.sides.includes(side)) return false;
		const previousFighter = side.getActiveFighter();
		if (!side.trocar(index)) return false;
		this.events.switchPerformed.fire({
			side,
			previousFighter,
			activeFighter: side.getActiveFighter(),
		});
		return true;
	}

	public requestSkill(side: BattleSide, slot: SkillSlot): boolean {
		if (this.state !== "IDLE" || this.battleEnded || !this.sides.includes(side)) return false;
		const fighter = side.getActiveFighter();
		if (!fighter.isAlive() || side.isDefeated()) return false;
		if (slot === 3 && fighter.level < S3_UNLOCK_LEVEL) return false;

		const roll = fighter.slots[slot - 1];
		const timeline = fighter.skillData[slot - 1];
		const range = ATB_COST_RANGES[slot];
		const cost = calcCusto(slot, roll.t);
		if (
			math.abs(roll.cost - cost) > FLOAT_TOLERANCE ||
			roll.cost < range.min ||
			roll.cost > range.max ||
			side.atb < cost
		)
			return false;
		if (timeline.hits.size() === 0) return false;

		side.setAtb(side.atb - cost);
		this.attackerSide = side;
		this.skillSlot = slot;
		this.skillData = timeline;
		this.connectedTarget = undefined;
		this.connectedTargetSide = undefined;
		this.connectedDamageOnTarget = 0;
		this.nextHitIndex = 0;
		this.phaseElapsed = 0;
		this.returnDuration = timeline.returnTime;
		this.setState("PREPARE");
		return true;
	}

	public step(dt: number): void {
		if (this.battleEnded) return;
		let remaining = math.max(dt, 0);
		if (this.state === "IDLE") {
			this.tickIdle(remaining);
			return;
		}

		while (true) {
			if (this.state === "PREPARE") {
				const timeline = this.skillData;
				if (timeline === undefined) return;
				const untilAttack = math.max(timeline.prepareTime - this.phaseElapsed, 0);
				if (untilAttack > remaining) {
					this.phaseElapsed += remaining;
					return;
				}
				this.phaseElapsed += untilAttack;
				remaining -= untilAttack;
				this.phaseElapsed = 0;
				this.setState("ATTACK");
				this.emitAttackStarted();
				continue;
			}

			if (this.state === "ATTACK") {
				const timeline = this.skillData;
				if (timeline === undefined) return;
				if (this.nextHitIndex >= timeline.hits.size()) {
					this.resolvePendingSkillEffects(timeline);
					this.enterReturn(timeline.returnTime);
					continue;
				}

				const hitTimeline = timeline.hits[this.nextHitIndex];
				const untilHit = math.max(hitTimeline.time - this.phaseElapsed, 0);
				if (untilHit > remaining) {
					this.phaseElapsed += remaining;
					return;
				}
				this.phaseElapsed += untilHit;
				remaining -= untilHit;
				const hitIndex = this.nextHitIndex + 1;
				const totalHits = timeline.hits.size();
				const missed = this.resolveScheduledHit(hitTimeline, hitIndex, totalHits);
				this.nextHitIndex += 1;

				if (this.battleEnded) {
					this.clearSkill();
					return;
				} else if (missed && timeline.hits.size() === 1) {
					this.enterReturn(timeline.dodgeReturnTime);
				} else if (this.nextHitIndex >= timeline.hits.size()) {
					this.resolvePendingSkillEffects(timeline);
					this.enterReturn(timeline.returnTime);
				}
				continue;
			}

			if (this.state === "RETURN") {
				const untilIdle = math.max(this.returnDuration - this.phaseElapsed, 0);
				if (untilIdle > remaining) {
					this.phaseElapsed += remaining;
					return;
				}
				remaining -= untilIdle;
				this.phaseElapsed = 0;
				this.setState("IDLE");
				this.clearSkill();
				if (!this.battleEnded && remaining > 0) this.tickIdle(remaining);
				return;
			}

			return;
		}
	}

	private emitAttackStarted(): void {
		const side = this.attackerSide;
		const slot = this.skillSlot;
		const skillData = this.skillData;
		if (side === undefined || slot === undefined || skillData === undefined) return;
		const defenderSide = side === this.sides[0] ? this.sides[1] : this.sides[0];
		this.events.attackStarted.fire({
			attacker: side.getActiveFighter(),
			target: defenderSide.getActiveFighter(),
			slot,
			skillData,
		});
	}

	private resolveScheduledHit(hitTimeline: SkillHitTimeline, hitIndex: number, totalHits: number): boolean {
		const side = this.attackerSide;
		const slot = this.skillSlot;
		if (side === undefined || slot === undefined) return false;
		const defenderSide = side === this.sides[0] ? this.sides[1] : this.sides[0];
		const attacker = side.getActiveFighter();
		const target = defenderSide.getActiveFighter();
		const result = this.damageService.resolveHit(attacker, target, slot, hitTimeline.damageShare, this.rng);
		const followUpCancelled = !result.hit && totalHits === 1;
		let realDamage = 0;
		if (result.hit) {
			realDamage = target.takeDamage(result.damage);
			this.recordDamage(attacker, realDamage);
		}
		this.events.hitResolved.fire({ hitIndex, target, followUpCancelled, ...result });

		if (result.hit && realDamage > 0) {
			if (this.connectedTarget !== target) {
				this.connectedTarget = target;
				this.connectedTargetSide = defenderSide;
				this.connectedDamageOnTarget = realDamage;
			} else {
				this.connectedDamageOnTarget += realDamage;
			}

			if (target.isAlive() && hitTimeline.statusEffects !== undefined) {
				this.applyEffectsToTarget(defenderSide, target, slot, hitTimeline.statusEffects, realDamage);
			}
		}

		if (!target.isAlive()) {
			this.connectedTarget = undefined;
			this.connectedTargetSide = undefined;
			this.connectedDamageOnTarget = 0;
			this.handleFighterDeath(defenderSide, target);
		}
		return !result.hit;
	}

	private resolvePendingSkillEffects(timeline: SkillData): void {
		const slot = this.skillSlot;
		const target = this.connectedTarget;
		const targetSide = this.connectedTargetSide;
		const connectedDamage = this.connectedDamageOnTarget;
		if (
			slot === undefined ||
			timeline.statusEffects === undefined ||
			target === undefined ||
			targetSide === undefined ||
			connectedDamage <= 0 ||
			!target.isAlive()
		)
			return;

		this.applyEffectsToTarget(targetSide, target, slot, timeline.statusEffects, connectedDamage);
	}

	private applyEffectsToTarget(
		targetSide: BattleSide,
		target: Fighter,
		slot: SkillSlot,
		effects: readonly StatusEffect[],
		realDamage: number,
	): void {
		for (const effect of effects) {
			const applied = target.applyStatusEffect(effect, slot, realDamage, this.attackerSide?.getActiveFighter());
			if (applied === undefined) continue;
			const totalDamage = applied.activeEffect.kind === "dot" ? applied.activeEffect.totalDamage : 0;
			this.events.effectApplied.fire({
				side: targetSide,
				target,
				effect,
				slot,
				duration: applied.activeEffect.duration,
				totalDamage,
				renewed: applied.renewed,
			});
		}
	}

	private handleFighterDeath(defenderSide: BattleSide, deadFighter: Fighter): void {
		let nextActive: Fighter | undefined;
		if (!defenderSide.getActiveFighter().isAlive()) {
			const nextIndex = defenderSide.onActiveFighterDeath(this.rng);
			nextActive = nextIndex === undefined ? undefined : defenderSide.getActiveFighter();
		} else {
			defenderSide.resetAtb();
			const currentActive = defenderSide.getActiveFighter();
			nextActive = currentActive.isAlive() ? currentActive : undefined;
		}

		this.events.death.fire({
			side: defenderSide,
			fighter: deadFighter,
			nextActive,
		});

		if (defenderSide.isDefeated()) {
			this.battleEnded = true;
			const winnerSide = defenderSide === this.sides[0] ? this.sides[1] : this.sides[0];
			this.events.battleEnd.fire(winnerSide);
		}
	}

	private enterReturn(duration: number): void {
		this.phaseElapsed = 0;
		this.returnDuration = duration;
		this.setState("RETURN");
	}

	private clearSkill(): void {
		this.attackerSide = undefined;
		this.skillSlot = undefined;
		this.skillData = undefined;
		this.connectedTarget = undefined;
		this.connectedTargetSide = undefined;
		this.connectedDamageOnTarget = 0;
		this.nextHitIndex = 0;
	}

	private tickIdle(dt: number): void {
		const firstIndex = this.nextTickSideIndex;
		const secondIndex = (1 - firstIndex) as 0 | 1;
		this.nextTickSideIndex = secondIndex;
		this.atbService.tick(this.sides[firstIndex], dt);
		this.atbService.tick(this.sides[secondIndex], dt);
		this.tickSideStatusEffects(this.sides[firstIndex], dt);
		if (!this.battleEnded) {
			this.tickSideStatusEffects(this.sides[secondIndex], dt);
		}
	}

	private tickSideStatusEffects(side: BattleSide, dt: number): void {
		if (dt <= 0 || this.battleEnded) return;

		for (const fighter of side.fighters) {
			if (this.battleEnded) return;
			if (!fighter.isAlive() || fighter.localState === "CAIDO") continue;

			for (const effectName of STATUS_EFFECT_ORDER) {
				const activeEffect = fighter.statusEffects.get(effectName);
				if (activeEffect === undefined) continue;

				if (activeEffect.kind === "root") {
					activeEffect.remainingDuration -= dt;
					if (activeEffect.remainingDuration <= FLOAT_TOLERANCE) {
						fighter.statusEffects.delete("Root");
						this.events.effectExpired.fire({
							side,
							target: fighter,
							effect: "Root",
						});
					}
					continue;
				}

				activeEffect.elapsed += dt;
				while (
					activeEffect.elapsed + FLOAT_TOLERANCE >= DOT_TICK_INTERVAL_SECONDS &&
					activeEffect.remainingTicks > 0 &&
					fighter.isAlive() &&
					!this.battleEnded
				) {
					activeEffect.elapsed = math.max(activeEffect.elapsed - DOT_TICK_INTERVAL_SECONDS, 0);
					activeEffect.remainingTicks -= 1;
					activeEffect.accumulatedDamage += activeEffect.damagePerTick;
					const isLastTick = activeEffect.remainingTicks === 0;

					let tickDamage = 0;
					if (isLastTick) {
						tickDamage = math.max(math.round(activeEffect.accumulatedDamage), MIN_DAMAGE);
						activeEffect.accumulatedDamage = 0;
					} else if (activeEffect.accumulatedDamage + FLOAT_TOLERANCE >= MIN_DAMAGE) {
						tickDamage = math.floor(activeEffect.accumulatedDamage + FLOAT_TOLERANCE);
						activeEffect.accumulatedDamage = math.max(activeEffect.accumulatedDamage - tickDamage, 0);
					}

					if (tickDamage >= MIN_DAMAGE) {
						const realDamage = fighter.takeDamage(tickDamage);
						this.recordDamage(activeEffect.source, realDamage);
						this.events.effectTick.fire({
							side,
							target: fighter,
							effect: activeEffect.effect,
							damage: tickDamage,
							remainingTicks: activeEffect.remainingTicks,
						});
					}

					if (isLastTick) {
						fighter.statusEffects.delete(activeEffect.effect);
						this.events.effectExpired.fire({
							side,
							target: fighter,
							effect: activeEffect.effect,
						});
					}

					if (!fighter.isAlive()) {
						this.handleFighterDeath(side, fighter);
						break;
					}
				}
			}
		}
	}

	private setState(state: BattleGlobalState): void {
		this.state = state;
		this.events.state.fire(state);
	}
}
