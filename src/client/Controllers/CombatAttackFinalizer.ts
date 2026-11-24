import type { FighterDiedPayload, SwitchPerformedPayload } from "../../shared/Remotes";
import type { SkillData } from "../../shared/SkillData";
import type { StatusEffect } from "../../shared/TypeDefs";
import {
	PLACEHOLDER_KO_TWEEN_SECONDS,
	PLACEHOLDER_SWITCH_TWEEN_SECONDS,
} from "../UI/CombatVisualConfig";

export interface PendingDeathRecord {
	readonly payload: FighterDiedPayload;
}

/** Visão mínima do lutador usada na finalização de ataque, KO e trocas visuais. */
export interface AttackFinalizerFighter {
	readonly targetId: string;
	readonly sideIndex: 0 | 1;
	benchIndex: number;
	readonly groundContactOffset: Vector3;
	readonly model: Model;
	hp: number;
	readonly hpMax: number;
	active: boolean;
	dead: boolean;
	homeCFrame: CFrame;
	readonly effectEmitters: Map<StatusEffect, ParticleEmitter>;
}

export interface CombatAttackFinalizerHost<TFighter extends AttackFinalizerFighter> {
	readonly isBattleEnded: () => boolean;
	readonly isCurrentBattle?: (generation: number) => boolean;
	readonly getBattleGeneration?: () => number;
	readonly isFollowUpCancelled: () => boolean;
	readonly hasPendingHits: () => boolean;
	readonly hasUnconsumedHitForTarget?: (targetId: string) => boolean;
	readonly getFighter: (targetId: string) => TFighter | undefined;
	readonly restoreStandBase: (entry: TFighter, duration?: number) => void;
	readonly restoreAttackMovement?: (entry: TFighter, duration: number) => void;
	readonly releaseAttackMovement?: (entry: TFighter) => void;
	readonly tweenModelTo: (model: Model, targetCFrame: CFrame, duration: number) => Tween | undefined;
	readonly delayBattle: (seconds: number, callback: () => void) => thread;
	readonly cancelBattleTask?: (taskThread: thread) => void;
	readonly trackBattleConnection?: (connection: RBXScriptConnection) => void;
	readonly untrackBattleConnection?: (connection: RBXScriptConnection) => void;
	readonly onKoAndSwitchesIdle?: () => void;
	readonly computeActiveSlotCFrame: (sideIndex: 0 | 1, groundContactOffset?: Vector3) => CFrame | undefined;
	readonly computeBenchSlotCFrame: (
		sideIndex: 0 | 1,
		benchSlot: number,
		groundContactOffset?: Vector3,
	) => CFrame | undefined;
	readonly applyActiveVisualState: (entry: TFighter) => void;
	readonly notifyHpVisualChanged: (targetId: string, hp: number, hpMax: number) => void;
	readonly notifyDeathVisualFlushed: (payload: FighterDiedPayload) => void;
	readonly emitKoVfx: (deadFighter: TFighter) => void;
}

/**
 * Coordena a finalização visual do último hit de um ataque (retorno de Stand/corpo),
 * o processamento de mortes pendentes e a fila/aplicação de trocas pendentes.
 */
export class CombatAttackFinalizer<TFighter extends AttackFinalizerFighter> {
	public readonly pendingSwitches: SwitchPerformedPayload[] = [];
	public readonly pendingDeaths = new Map<string, PendingDeathRecord>();
	private readonly activeKoTargets = new Set<string>();
	private readonly activeKoTweens = new Map<string, Tween>();
	private readonly appliedDeathSwitches = new Set<string>();
	private finalizerGeneration = 0;

	public constructor(private readonly host: CombatAttackFinalizerHost<TFighter>) {}

	public clear(): void {
		this.finalizerGeneration += 1;
		this.pendingSwitches.clear();
		this.pendingDeaths.clear();
		this.activeKoTargets.clear();
		this.activeKoTweens.clear();
		this.appliedDeathSwitches.clear();
	}

	public hasPendingDeath(targetId: string): boolean {
		return this.pendingDeaths.has(targetId);
	}

	public hasActiveKoAnimations(): boolean {
		return this.activeKoTargets.size() > 0;
	}

	public canApplySwitches(): boolean {
		return !this.host.hasPendingHits() && !this.hasActiveKoAnimations();
	}

	/**
	 * Executa a sequência de encerramento após o consumo do último hit do ataque atual:
	 * retorno visual de Stand/corpo, flush de mortes pendentes e aplicação de trocas pendentes
	 * somente quando a sequência e eventuais quedas de KO permitirem.
	 */
	public finalizeAttack(attacker: TFighter, timeline: SkillData, interrupted = false): number {
		const returnDuration = this.host.isFollowUpCancelled()
			? timeline.dodgeReturnTime
			: timeline.returnTime;
		const duration = interrupted ? 0 : math.max(returnDuration, 0.08);
		if (attacker.active && !attacker.dead && !this.hasPendingDeath(attacker.targetId)) {
			this.host.restoreStandBase(attacker, duration);
			if (this.host.restoreAttackMovement !== undefined) this.host.restoreAttackMovement(attacker, duration);
			else this.host.tweenModelTo(attacker.model, attacker.homeCFrame, duration);
		}
		this.flushPendingDeaths();
		this.flushPendingSwitchesIfReady();
		return duration;
	}

	/**
	 * Garante que mortes pendentes de um ataque anterior sejam iniciadas e que trocas pendentes
	 * sejam aplicadas apenas quando não houver animação de KO ativa.
	 */
	public forceCompletePendingForNextAttack(): void {
		if (this.host.isBattleEnded()) return;
		this.flushPendingDeaths();
		this.flushPendingSwitchesIfReady();
	}

	public handleFighterDied(payload: FighterDiedPayload): void {
		if (this.host.isBattleEnded()) return;
		if (this.host.getFighter(payload.fighterId)?.dead || this.pendingDeaths.has(payload.fighterId)) return;
		this.pendingDeaths.set(payload.fighterId, { payload });
		this.flushReadyPendingDeaths();
	}

	/** Efetiva mortes pendentes cujo hit letal já foi consumido (ou mortes fora de ataque). */
	public flushReadyPendingDeaths(): void {
		if (this.host.isBattleEnded() || this.pendingDeaths.size() === 0) return;
		const ready: Array<readonly [string, PendingDeathRecord]> = [];
		for (const [deadTargetId, record] of this.pendingDeaths) {
			if (this.host.hasUnconsumedHitForTarget?.(deadTargetId) ?? false) continue;
			ready.push([deadTargetId, record]);
		}
		for (const [deadTargetId, record] of ready) {
			this.pendingDeaths.delete(deadTargetId);
			this.applyDeathRecord(deadTargetId, record);
		}
	}

	public flushPendingDeaths(): void {
		if (this.host.isBattleEnded() || this.pendingDeaths.size() === 0) return;
		const allPending: Array<readonly [string, PendingDeathRecord]> = [];
		for (const [deadTargetId, record] of this.pendingDeaths) {
			allPending.push([deadTargetId, record]);
		}
		this.pendingDeaths.clear();
		for (const [deadTargetId, record] of allPending) {
			this.applyDeathRecord(deadTargetId, record);
		}
	}

	private applyDeathRecord(deadTargetId: string, record: PendingDeathRecord): void {
		if (this.host.isBattleEnded()) return;
		const deadFighter = this.host.getFighter(deadTargetId);
		if (deadFighter !== undefined && !deadFighter.dead) {
			this.host.releaseAttackMovement?.(deadFighter);
			this.host.restoreStandBase(deadFighter);
			deadFighter.dead = true;
			deadFighter.active = false;
			deadFighter.hp = 0;
			this.host.notifyHpVisualChanged(deadTargetId, 0, deadFighter.hpMax);

			// Limpa VFX de status ativos no lutador derrotado
			for (const [, emitter] of deadFighter.effectEmitters) {
				emitter.Enabled = false;
				emitter.Destroy();
			}
			deadFighter.effectEmitters.clear();
			this.host.emitKoVfx(deadFighter);

			// Animação placeholder de KO (tomba para trás)
			const koCFrame = deadFighter.homeCFrame
				.mul(new CFrame(0, -0.6, 0))
				.mul(CFrame.Angles(math.rad(-80), 0, 0));
			const koTween = this.host.tweenModelTo(deadFighter.model, koCFrame, PLACEHOLDER_KO_TWEEN_SECONDS);
			const generation = this.finalizerGeneration;
			const battleGeneration = this.host.getBattleGeneration?.();
			this.activeKoTargets.add(deadTargetId);
			if (koTween !== undefined) {
				this.activeKoTweens.set(deadTargetId, koTween);
			}

			let koSettled = false;
			let completedConnection: RBXScriptConnection | undefined;
			let fallbackTask: thread | undefined;

			const completeKo = (): void => {
				if (koSettled) return;
				koSettled = true;
				if (completedConnection !== undefined) {
					const conn = completedConnection;
					completedConnection = undefined;
					conn.Disconnect();
					this.host.untrackBattleConnection?.(conn);
				}
				if (fallbackTask !== undefined) {
					const pending = fallbackTask;
					fallbackTask = undefined;
					this.host.cancelBattleTask?.(pending);
				}

				const isStaleBattle =
					battleGeneration !== undefined && !(this.host.isCurrentBattle?.(battleGeneration) ?? true);
				if (this.host.isBattleEnded() || this.finalizerGeneration !== generation || isStaleBattle) {
					return;
				}

				if (koTween !== undefined && koTween.PlaybackState === Enum.PlaybackState.Playing) {
					koTween.Cancel();
				}
				if (this.activeKoTweens.get(deadTargetId) === koTween) {
					this.activeKoTweens.delete(deadTargetId);
				}
				this.activeKoTargets.delete(deadTargetId);
				this.flushPendingSwitchesIfReady();
				if (!this.hasActiveKoAnimations()) {
					this.host.onKoAndSwitchesIdle?.();
				}
			};

			if (koTween !== undefined) {
				completedConnection = koTween.Completed.Connect(() => {
					completeKo();
				});
				this.host.trackBattleConnection?.(completedConnection);
				// Fallback defensivo após a duração nominal caso Completed não seja emitido.
				fallbackTask = this.host.delayBattle(PLACEHOLDER_KO_TWEEN_SECONDS + 0.15, () => {
					fallbackTask = undefined;
					completeKo();
				});
			} else {
				fallbackTask = this.host.delayBattle(PLACEHOLDER_KO_TWEEN_SECONDS, () => {
					fallbackTask = undefined;
					completeKo();
				});
			}
		}

		// Troca automática por morte (nextActive) aguarda fim da sequência e da queda de KO, deduplicada com SwitchPerformed.
		if (record.payload.nextActive !== undefined && record.payload.nextActive !== deadTargetId) {
			const nextFighter = this.host.getFighter(record.payload.nextActive);
			if (nextFighter !== undefined && !nextFighter.dead && !nextFighter.active) {
				this.handleSwitchPerformed({
					sideId: record.payload.sideId,
					previousFighterId: deadTargetId,
					activeFighterId: record.payload.nextActive,
				});
			}
		}
		this.host.notifyDeathVisualFlushed(record.payload);
	}

	private switchKey(payload: SwitchPerformedPayload): string {
		return `${payload.sideId}|${payload.previousFighterId}|${payload.activeFighterId}`;
	}

	private hasPendingSwitch(payload: SwitchPerformedPayload): boolean {
		for (const pending of this.pendingSwitches) {
			if (
				pending.sideId === payload.sideId &&
				pending.previousFighterId === payload.previousFighterId &&
				pending.activeFighterId === payload.activeFighterId
			) {
				return true;
			}
		}
		return false;
	}

	public handleSwitchPerformed(payload: SwitchPerformedPayload): void {
		if (this.host.isBattleEnded()) return;
		const key = this.switchKey(payload);
		if (this.appliedDeathSwitches.has(key) || this.hasPendingSwitch(payload)) {
			return;
		}
		if (!this.canApplySwitches()) {
			this.pendingSwitches.push(payload);
			return;
		}
		this.applySwitchPerformed(payload);
	}

	private flushPendingSwitchesIfReady(): void {
		if (this.host.isBattleEnded() || !this.canApplySwitches() || this.pendingSwitches.size() === 0) return;
		const queued = [...this.pendingSwitches];
		this.pendingSwitches.clear();
		for (const pending of queued) {
			this.applySwitchPerformed(pending);
		}
	}

	private applySwitchPerformed(payload: SwitchPerformedPayload): void {
		const key = this.switchKey(payload);
		if (this.appliedDeathSwitches.has(key)) {
			return;
		}

		const previous = this.host.getFighter(payload.previousFighterId);
		const nextActive = this.host.getFighter(payload.activeFighterId);
		if (previous === nextActive || nextActive?.active || previous?.sideIndex !== nextActive?.sideIndex) return;

		if (previous !== undefined && nextActive !== undefined && !nextActive.dead) {
			previous.benchIndex = nextActive.benchIndex;
		}

		if (previous !== undefined) {
			this.host.releaseAttackMovement?.(previous);
			this.host.restoreStandBase(previous);
			const activeKoTween = this.activeKoTweens.get(previous.targetId);
			if (activeKoTween !== undefined) {
				if (activeKoTween.PlaybackState === Enum.PlaybackState.Playing) {
					activeKoTween.Cancel();
				}
				this.activeKoTweens.delete(previous.targetId);
			}
			if (previous.dead) {
				this.appliedDeathSwitches.add(key);
			}
			previous.active = false;
			const benchCFrame = this.host.computeBenchSlotCFrame(
				previous.sideIndex,
				previous.benchIndex,
				previous.groundContactOffset,
			);
			if (benchCFrame !== undefined) {
				previous.homeCFrame = benchCFrame;
			}
			this.host.applyActiveVisualState(previous);
			if (benchCFrame !== undefined) {
				if (previous.dead) {
					if (previous.model.Parent !== undefined) {
						previous.model.PivotTo(previous.homeCFrame);
					}
				} else {
					this.host.tweenModelTo(previous.model, previous.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
				}
			}
		}

		if (nextActive !== undefined && !nextActive.dead) {
			this.host.releaseAttackMovement?.(nextActive);
			nextActive.active = true;
			const activeCFrame = this.host.computeActiveSlotCFrame(
				nextActive.sideIndex,
				nextActive.groundContactOffset,
			);
			if (activeCFrame !== undefined) {
				nextActive.homeCFrame = activeCFrame;
			}
			this.host.applyActiveVisualState(nextActive);
			if (activeCFrame !== undefined) {
				this.host.tweenModelTo(nextActive.model, nextActive.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
			}
		}
	}
}
