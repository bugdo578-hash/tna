import type { SkillData } from "../../shared/SkillData";
import type { SkillSlot } from "../../shared/TypeDefs";
import { battleCleanupStep } from "./BattleCleanup";
import {
	PLACEHOLDER_ADVANCE_FRACTION,
	PLACEHOLDER_DODGE_OFFSET_STUDS,
	PLACEHOLDER_DODGE_TWEEN_SECONDS,
	PLACEHOLDER_HIT_KNOCKBACK_STUDS,
	PLACEHOLDER_HIT_REACT_TWEEN_SECONDS,
	PLACEHOLDER_ORA_ADVANCE_FRACTION,
	PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS,
	PLACEHOLDER_STAND_STRIKE_STUDS,
	PLACEHOLDER_STRIKE_TWEEN_SECONDS,
	STAND_ATTACK_FRONT_STUDS,
} from "../UI/CombatVisualConfig";

/** Estado mutável do Motor6D do Stand; `generation` invalida recuos atrasados. */
export interface StandMotionState {
	readonly joint: Motor6D;
	readonly baseC1: CFrame;
	generation: number;
	tween?: Tween;
}

/** Visão mínima do lutador usada pela movimentação placeholder. */
export interface StandMotionFighter {
	readonly fighterId: string;
	readonly model: Model;
	readonly rootPart: BasePart;
	readonly standModel: Model | undefined;
	readonly standMotion: StandMotionState | undefined;
	readonly dead: boolean;
	readonly active?: boolean;
	readonly homeCFrame: CFrame;
}

export interface CombatStandMotionHost {
	readonly createBattleTween: <T extends Instance>(
		object: T,
		info: TweenInfo,
		goal: Partial<ExtractMembers<T, Tweenable>>,
	) => Tween;
	readonly delayBattle: (seconds: number, callback: () => void) => void;
	readonly trackConnection?: (connection: RBXScriptConnection) => void;
	readonly untrackConnection?: (connection: RBXScriptConnection) => void;
	/** Verdadeiro enquanto `attackToken` for o ataque atual de uma batalha não encerrada. */
	readonly isAttackCurrent: (attackToken: number) => boolean;
	readonly isFollowUpCancelled: () => boolean;
}

function isBarrageAdvanceSkill(attacker: StandMotionFighter, timeline: SkillData): boolean {
	if (timeline.id !== undefined) return timeline.id === "jotaro_barragem_estelar";
	return attacker.fighterId.lower() === "jotaro" && timeline.name === "Barragem_estelar";
}

/** Movimentação e animações placeholder de corpo/Stand; recursos registrados pelo host. */
export class CombatStandMotion {
	private readonly temporaryMoves = new Map<Model, TemporaryMove>();
	public constructor(private readonly host: CombatStandMotionHost) {}

	public runPlaceholderAttackSequence(
		attacker: StandMotionFighter,
		target: StandMotionFighter,
		timeline: SkillData,
		attackToken: number,
		_slot: SkillSlot,
		consumeHit: (hitIndex: number) => void,
	): void {
		const isSelfOnly = timeline.effectTarget === "self" || timeline.hits.every((hit) => hit.kind === "self" || hit.noDamage === true || hit.damageShare <= 0);
		const isBarrageAdvance = isBarrageAdvanceSkill(attacker, timeline);
		const startCFrame = attacker.homeCFrame;
		const targetPos = target.homeCFrame.Position;
		const advanceFraction = isSelfOnly
			? 0
			: isBarrageAdvance
				? PLACEHOLDER_ORA_ADVANCE_FRACTION
				: PLACEHOLDER_ADVANCE_FRACTION;
		const approachPos = startCFrame.Position.Lerp(targetPos, advanceFraction);
		const strikeBaseCFrame = isSelfOnly ? startCFrame : CFrame.lookAt(approachPos, targetPos, startCFrame.UpVector);

		const firstHitTime = timeline.hits.size() > 0 ? math.max(timeline.hits[0].time, 0.05) : 0.1;
		if (!isSelfOnly) {
			this.moveTemporarily(attacker, strikeBaseCFrame, firstHitTime * 0.8);
		}

		const totalHits = timeline.hits.size();
		for (const index of $range(1, totalHits)) {
			const hitSpec = timeline.hits[index - 1];
			const isNoDamageHit =
				hitSpec?.kind === "self" ||
				hitSpec?.noDamage === true ||
				timeline.effectTarget === "self" ||
				(hitSpec !== undefined && hitSpec.damageShare <= 0);
			this.host.delayBattle(hitSpec.time, () => {
				if (!this.host.isAttackCurrent(attackToken)) return;
				if (this.host.isFollowUpCancelled() && index > 1) return;

				if (!target.dead && !isNoDamageHit) {
					// Pequeno avanço/soco a cada hit do slot (inclusive multi-hit como Barragem_estelar)
					const punchOffset = strikeBaseCFrame.LookVector.mul(index % 2 === 1 ? 0.55 : 0.35);
					const punchCFrame = strikeBaseCFrame.add(punchOffset);
					this.moveTemporarily(attacker, punchCFrame, PLACEHOLDER_STRIKE_TWEEN_SECONDS);

					// Se tiver Stand (ex.: Star Platinum), projeta o Stand levemente à frente no golpe
					const extraAdvance = isBarrageAdvance ? PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS : 0;
					this.pulseStandStrike(attacker, PLACEHOLDER_STAND_STRIKE_STUDS + extraAdvance);
				}

				consumeHit(index);
			});
		}
	}

	/** Resolve a pose no eixo do dono, removendo o desvio lateral da pose de descanso. */
	public standAttackC1(attacker: StandMotionFighter, advanceStuds = 0): CFrame | undefined {
		const motion = attacker.standMotion;
		const part0 = motion?.joint.Part0;
		if (motion === undefined || part0 === undefined) return undefined;
		const jointFrame = attacker.rootPart.CFrame.ToObjectSpace(part0.CFrame).mul(motion.joint.C0);
		const restFrame = jointFrame.mul(motion.baseC1.Inverse());
		const frontFrame = new CFrame(0, restFrame.Y, -STAND_ATTACK_FRONT_STUDS - advanceStuds);
		return frontFrame.Inverse().mul(jointFrame);
	}

	public positionStandForAttack(attacker: StandMotionFighter, duration: number): void {
		const motion = attacker.standMotion;
		const frontC1 = this.standAttackC1(attacker);
		if (motion === undefined || frontC1 === undefined) return;
		motion.generation += 1;
		motion.tween?.Cancel();
		motion.tween = this.host.createBattleTween(motion.joint,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { C1: frontC1 });
		motion.tween.Play();
	}

	public pulseStandStrike(attacker: StandMotionFighter, advanceStuds = PLACEHOLDER_STAND_STRIKE_STUDS): void {
		const motion = attacker.standMotion;
		if (attacker.standModel === undefined || motion === undefined) return;
		const standJoint = motion.joint;
		if (standJoint.Parent !== undefined) {
			motion.generation += 1;
			const generation = motion.generation;
			motion.tween?.Cancel();
			const forwardC1 = this.standAttackC1(attacker, advanceStuds);
			const frontC1 = this.standAttackC1(attacker);
			if (forwardC1 === undefined || frontC1 === undefined) return;
			const punchIn = this.host.createBattleTween(
				standJoint,
				new TweenInfo(PLACEHOLDER_STRIKE_TWEEN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
				{ C1: forwardC1 },
			);
			motion.tween = punchIn;
			punchIn.Play();
			this.host.delayBattle(PLACEHOLDER_STRIKE_TWEEN_SECONDS, () => {
				if (standJoint.Parent && motion.generation === generation) {
					motion.tween = this.host.createBattleTween(
						standJoint,
						new TweenInfo(PLACEHOLDER_STRIKE_TWEEN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
						{ C1: frontC1 },
					);
					motion.tween.Play();
				}
			});
		}
	}

	public restoreStandBase(entry: StandMotionFighter, duration = 0): void {
		const motion = entry.standMotion;
		if (motion === undefined) return;
		// Invalida também recuos atrasados: Cancel sozinho preserva o deslocamento parcial.
		motion.generation += 1;
		motion.tween?.Cancel();
		motion.tween = undefined;
		if (duration > 0 && motion.joint.Parent !== undefined) {
			motion.tween = this.host.createBattleTween(motion.joint,
				new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { C1: motion.baseC1 });
			motion.tween.Play();
			return;
		}
		motion.joint.C1 = motion.baseC1;
	}

	public playHitReaction(target: StandMotionFighter, isCrit: boolean): void {
		const baseCF = target.homeCFrame;
		const knockbackDist = isCrit ? PLACEHOLDER_HIT_KNOCKBACK_STUDS * 1.4 : PLACEHOLDER_HIT_KNOCKBACK_STUDS;
		const knockedCF = baseCF.add(baseCF.LookVector.mul(-knockbackDist));

		this.reactAndReturn(target, knockedCF, PLACEHOLDER_HIT_REACT_TWEEN_SECONDS);
	}

	public playDodgeReaction(target: StandMotionFighter): void {
		const baseCF = target.homeCFrame;
		const dodgeCF = baseCF.add(baseCF.RightVector.mul(PLACEHOLDER_DODGE_OFFSET_STUDS));

		this.reactAndReturn(target, dodgeCF, PLACEHOLDER_DODGE_TWEEN_SECONDS);
	}

	private reactAndReturn(fighter: StandMotionFighter, pose: CFrame, seconds: number): void {
		const move = this.moveTemporarily(fighter, pose, seconds, true);
		if (move === undefined) return;
		this.host.delayBattle(seconds, () => {
			if (this.temporaryMoves.get(fighter.model) === move && this.canRestore(move)) {
				this.returnMove(move, seconds);
			}
		});
	}

	/** Usa o home calculado pelos anchors, sem recapturar a pose atual. */
	public moveTemporarily(fighter: StandMotionFighter, pose: CFrame, duration: number, reaction = false): TemporaryMove | undefined {
		const move: TemporaryMove = { fighter, home: fighter.homeCFrame, reaction };
		if (!this.canRestore(move)) return undefined;
		this.releaseTemporaryMove(fighter.model);
		move.tween = this.tweenModelTo(fighter.model, pose, duration);
		this.temporaryMoves.set(fighter.model, move);
		return move;
	}

	public releaseTemporaryMove(model: Model): void {
		const move = this.temporaryMoves.get(model);
		this.temporaryMoves.delete(model);
		move?.tween?.Cancel();
	}

	public returnFromAttack(fighter: StandMotionFighter, duration: number): void {
		if (!this.temporaryMoves.has(fighter.model) && fighter.model.GetPivot() !== fighter.homeCFrame) {
			this.temporaryMoves.set(fighter.model, { fighter, home: fighter.homeCFrame, reaction: false });
		}
		this.restoreTemporaryMoves(duration, false);
	}

	public restoreTemporaryMoves(duration = 0, includeReactions = true): void {
		for (const [, move] of this.temporaryMoves) {
			if (move.reaction && !includeReactions) continue;
			this.returnMove(move, duration);
		}
	}

	private returnMove(move: TemporaryMove, duration: number): void {
		const model = move.fighter.model;
		move.tween?.Cancel();
		const tween = this.canRestore(move) ? this.tweenModelTo(model, move.home, duration) : undefined;
		if (tween === undefined) {
			this.temporaryMoves.delete(model);
			return;
		}
		move.tween = tween;
		const connection = tween.Completed.Once(() => {
			this.host.untrackConnection?.(connection);
			if (this.temporaryMoves.get(model) === move && move.tween === tween) this.temporaryMoves.delete(model);
		});
		this.host.trackConnection?.(connection);
	}

	public resetStage(fighters: ReadonlyMap<string, StandMotionFighter>): void {
		this.temporaryMoves.clear();
		for (const [, fighter] of fighters) {
			if (fighter.dead) continue;
			battleCleanupStep("stand base", () => this.restoreStandBase(fighter));
			battleCleanupStep("fighter base", () => fighter.model.PivotTo(fighter.homeCFrame));
		}
	}

	private canRestore(move: TemporaryMove): boolean {
		const { fighter, home } = move;
		return !fighter.dead && fighter.active !== false && fighter.model.Parent !== undefined && fighter.homeCFrame === home;
	}

	public tweenModelTo(model: Model, targetCFrame: CFrame, duration: number): Tween | undefined {
		const root = model.PrimaryPart;
		if (root === undefined || !model.Parent) return undefined;
		if (duration <= 0.01) {
			model.PivotTo(targetCFrame);
			return undefined;
		}
		const tween = this.host.createBattleTween(
			root,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ CFrame: targetCFrame },
		);
		tween.Play();
		return tween;
	}
}

interface TemporaryMove {
	readonly fighter: StandMotionFighter;
	readonly home: CFrame;
	readonly reaction: boolean;
	tween?: Tween;
}
