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

	public constructor(private readonly host: CombatAttackFinalizerHost<TFighter>) {}

	public clear(): void {
		this.pendingSwitches.clear();
		this.pendingDeaths.clear();
	}

	/**
	 * Executa a sequência de encerramento após o consumo do último hit do ataque atual:
	 * retorno visual de Stand/corpo, flush de mortes pendentes e aplicação de trocas pendentes.
	 */
	public finalizeAttack(attacker: TFighter, timeline: SkillData): void {
		const returnDuration = this.host.isFollowUpCancelled()
			? timeline.dodgeReturnTime
			: timeline.returnTime;
		const clampedReturnDuration = math.max(returnDuration, 0.08);
		this.host.restoreStandBase(attacker, clampedReturnDuration);
		this.host.tweenModelTo(attacker.model, attacker.homeCFrame, clampedReturnDuration);
		this.flushPendingDeaths();
		for (const pending of this.pendingSwitches) {
			this.handleSwitchPerformed(pending);
		}
		this.pendingSwitches.clear();
	}

	public handleFighterDied(payload: FighterDiedPayload): void {
		if (this.host.isBattleEnded()) return;
		this.pendingDeaths.set(payload.fighterId, { payload });
		// Provisório: KO imediato; a troca chega separadamente ao fim de ATTACK.
		this.flushPendingDeaths();
	}

	public flushPendingDeaths(): void {
		for (const [deadTargetId, record] of this.pendingDeaths) {
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
				this.host.delayBattle(PLACEHOLDER_KO_TWEEN_SECONDS, () => {
					if (deadFighter.model.Parent !== undefined && record.payload.nextActive !== undefined) {
						deadFighter.homeCFrame = this.host.computeBenchSlotCFrame(
							deadFighter.sideIndex,
							deadFighter.benchIndex,
						);
						deadFighter.model.PivotTo(deadFighter.homeCFrame);
						this.host.applyActiveVisualState(deadFighter);
					}
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
		this.pendingDeaths.clear();
	}

	public handleSwitchPerformed(payload: SwitchPerformedPayload): void {
		if (this.host.isBattleEnded()) return;
		if (this.host.hasPendingHits()) {
			this.pendingSwitches.push(payload);
			return;
		}
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
