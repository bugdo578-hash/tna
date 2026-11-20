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
	readonly benchIndex: number;
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
	readonly isFollowUpCancelled: () => boolean;
	readonly hasPendingHits: () => boolean;
	readonly hasUnconsumedHitForTarget?: (targetId: string) => boolean;
	readonly getFighter: (targetId: string) => TFighter | undefined;
	readonly restoreStandBase: (entry: TFighter, duration?: number) => void;
	readonly tweenModelTo: (model: Model, targetCFrame: CFrame, duration: number) => void;
	readonly delayBattle: (seconds: number, callback: () => void) => void;
	readonly computeActiveSlotCFrame: (sideIndex: 0 | 1) => CFrame;
	readonly computeBenchSlotCFrame: (sideIndex: 0 | 1, benchSlot: number) => CFrame;
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
	private finalizerGeneration = 0;

	public constructor(private readonly host: CombatAttackFinalizerHost<TFighter>) {}

	public clear(): void {
		this.finalizerGeneration += 1;
		this.pendingSwitches.clear();
		this.pendingDeaths.clear();
		this.activeKoTargets.clear();
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
	public finalizeAttack(attacker: TFighter, timeline: SkillData): void {
		const returnDuration = this.host.isFollowUpCancelled()
			? timeline.dodgeReturnTime
			: timeline.returnTime;
		const clampedReturnDuration = math.max(returnDuration, 0.08);
		this.host.restoreStandBase(attacker, clampedReturnDuration);
		this.host.tweenModelTo(attacker.model, attacker.homeCFrame, clampedReturnDuration);
		this.flushPendingDeaths();
		this.flushPendingSwitchesIfReady();
	}

	/**
	 * Garante que mortes/trocas pendentes de um ataque anterior sejam concluídas antes de iniciar
	 * um novo AttackStarted sobreposto, evitando retenção de trocas ou estado stale no novo ataque.
	 */
	public forceCompletePendingForNextAttack(): void {
		if (this.host.isBattleEnded()) return;
		this.flushPendingDeaths();
		if (this.activeKoTargets.size() > 0) {
			this.activeKoTargets.clear();
			this.finalizerGeneration += 1;
		}
		this.flushPendingSwitchesIfReady();
	}

	public handleFighterDied(payload: FighterDiedPayload): void {
		if (this.host.isBattleEnded()) return;
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
				.add(new Vector3(0, -0.6, 0))
				.mul(CFrame.Angles(math.rad(-80), 0, 0));
			this.host.tweenModelTo(deadFighter.model, koCFrame, PLACEHOLDER_KO_TWEEN_SECONDS);
			const generation = this.finalizerGeneration;
			this.activeKoTargets.add(deadTargetId);
			this.host.delayBattle(PLACEHOLDER_KO_TWEEN_SECONDS, () => {
				if (this.host.isBattleEnded() || this.finalizerGeneration !== generation) return;
				this.activeKoTargets.delete(deadTargetId);
				if (deadFighter.model.Parent !== undefined && record.payload.nextActive !== undefined) {
					deadFighter.homeCFrame = this.host.computeBenchSlotCFrame(
						deadFighter.sideIndex,
						deadFighter.benchIndex,
					);
					deadFighter.model.PivotTo(deadFighter.homeCFrame);
					this.host.applyActiveVisualState(deadFighter);
				}
				this.flushPendingSwitchesIfReady();
			});
		}

		// Se houve troca automática por morte (nextActive), traz o substituto para o centro
		if (record.payload.nextActive !== undefined) {
			const nextFighter = this.host.getFighter(record.payload.nextActive);
			if (nextFighter !== undefined && !nextFighter.dead) {
				nextFighter.active = true;
				nextFighter.homeCFrame = this.host.computeActiveSlotCFrame(nextFighter.sideIndex);
				this.host.applyActiveVisualState(nextFighter);
				this.host.tweenModelTo(nextFighter.model, nextFighter.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
			}
		}
		this.host.notifyDeathVisualFlushed(record.payload);
	}

	public handleSwitchPerformed(payload: SwitchPerformedPayload): void {
		if (this.host.isBattleEnded()) return;
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
		const previous = this.host.getFighter(payload.previousFighterId);
		const nextActive = this.host.getFighter(payload.activeFighterId);

		if (previous !== undefined) {
			previous.active = false;
			previous.homeCFrame = this.host.computeBenchSlotCFrame(previous.sideIndex, previous.benchIndex);
			this.host.applyActiveVisualState(previous);
			this.host.tweenModelTo(previous.model, previous.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
		}

		if (nextActive !== undefined) {
			nextActive.active = true;
			nextActive.homeCFrame = this.host.computeActiveSlotCFrame(nextActive.sideIndex);
			this.host.applyActiveVisualState(nextActive);
			this.host.tweenModelTo(nextActive.model, nextActive.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
		}
	}
}
