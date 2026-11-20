import type { SkillData } from "../../shared/SkillData";
import type { SkillSlot } from "../../shared/TypeDefs";
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
	readonly homeCFrame: CFrame;
}

export interface CombatStandMotionHost {
	readonly createBattleTween: <T extends Instance>(
		object: T,
		info: TweenInfo,
		goal: Partial<ExtractMembers<T, Tweenable>>,
	) => Tween;
	readonly delayBattle: (seconds: number, callback: () => void) => void;
	/** Verdadeiro enquanto `attackToken` for o ataque atual de uma batalha não encerrada. */
	readonly isAttackCurrent: (attackToken: number) => boolean;
	readonly isFollowUpCancelled: () => boolean;
}

/** Movimentação e animações placeholder de corpo/Stand; recursos registrados pelo host. */
export class CombatStandMotion {
	public constructor(private readonly host: CombatStandMotionHost) {}

	public runPlaceholderAttackSequence(
		attacker: StandMotionFighter,
		target: StandMotionFighter,
		timeline: SkillData,
		attackToken: number,
		slot: SkillSlot,
		consumeHit: (hitIndex: number) => void,
	): void {
		const startCFrame = attacker.homeCFrame;
		const targetPos = target.homeCFrame.Position;
		const advanceFraction = attacker.fighterId.lower() === "jotaro" && slot === 2
			? PLACEHOLDER_ORA_ADVANCE_FRACTION
			: PLACEHOLDER_ADVANCE_FRACTION;
		const approachPos = startCFrame.Position.Lerp(targetPos, advanceFraction);
		const strikeBaseCFrame = CFrame.lookAt(approachPos, targetPos);

		const firstHitTime = timeline.hits.size() > 0 ? math.max(timeline.hits[0].time, 0.05) : 0.1;
		this.tweenModelTo(attacker.model, strikeBaseCFrame, firstHitTime * 0.8);

		const totalHits = timeline.hits.size();
		for (const index of $range(1, totalHits)) {
			const hitSpec = timeline.hits[index - 1];
			this.host.delayBattle(hitSpec.time, () => {
				if (!this.host.isAttackCurrent(attackToken)) return;
				if (this.host.isFollowUpCancelled() && index > 1) return;

				if (!target.dead) {
					// Pequeno avanço/soco a cada hit do slot (inclusive multi-hit como Barragem_estelar)
					const punchOffset = strikeBaseCFrame.LookVector.mul(index % 2 === 1 ? 0.55 : 0.35);
					const punchCFrame = strikeBaseCFrame.add(punchOffset);
					this.tweenModelTo(attacker.model, punchCFrame, PLACEHOLDER_STRIKE_TWEEN_SECONDS);

					// Se tiver Stand (ex.: Star Platinum), projeta o Stand levemente à frente no golpe
					const extraAdvance = attacker.fighterId.lower() === "jotaro" && slot === 2
						? PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS
						: 0;
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

		this.tweenModelTo(target.model, knockedCF, PLACEHOLDER_HIT_REACT_TWEEN_SECONDS);
		this.host.delayBattle(PLACEHOLDER_HIT_REACT_TWEEN_SECONDS, () => {
			if (!target.dead && target.model.Parent !== undefined) {
				this.tweenModelTo(target.model, target.homeCFrame, PLACEHOLDER_HIT_REACT_TWEEN_SECONDS);
			}
		});
	}

	public playDodgeReaction(target: StandMotionFighter): void {
		const baseCF = target.homeCFrame;
		const dodgeCF = baseCF.add(baseCF.RightVector.mul(PLACEHOLDER_DODGE_OFFSET_STUDS));

		this.tweenModelTo(target.model, dodgeCF, PLACEHOLDER_DODGE_TWEEN_SECONDS);
		this.host.delayBattle(PLACEHOLDER_DODGE_TWEEN_SECONDS, () => {
			if (!target.dead && target.model.Parent !== undefined) {
				this.tweenModelTo(target.model, target.homeCFrame, PLACEHOLDER_DODGE_TWEEN_SECONDS);
			}
		});
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
