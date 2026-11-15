import {
	AI_BRONZE_LOW_HP_SWITCH_CHANCE,
	AI_BRONZE_LOW_HP_THRESHOLD,
	AI_BRONZE_MISTAKE_CHANCE,
	AI_BRONZE_SKILL_DELAY_MAX_SECONDS,
	AI_BRONZE_SKILL_DELAY_MIN_SECONDS,
	AI_BRONZE_TIMED_SWITCH_MAX_SECONDS,
	AI_BRONZE_TIMED_SWITCH_MIN_SECONDS,
	AI_BRONZE_ULTIMATE_DELAY_MAX_SECONDS,
	AI_BRONZE_ULTIMATE_DELAY_MIN_SECONDS,
	FLOAT_TOLERANCE,
	S3_UNLOCK_LEVEL,
} from "../../shared/Config";
import { clamp, lerp } from "../../shared/MathUtils";
import type { SkillSlot } from "../../shared/TypeDefs";
import type { BattleSide, FighterIndex } from "../Components/BattleSide";
import type { Fighter } from "../Components/Fighter";
import type { BattleService } from "./BattleService";

export type AITier = "Bronze";

export interface AIIntentDispatcher {
	readonly requestSkill: (slot: SkillSlot) => boolean;
	readonly requestSwitch: (index: FighterIndex) => boolean;
	readonly isPaused?: () => boolean;
}

/**
 * Serviço de IA (Tier Bronze — "O Iniciante") para combates PVE (T5).
 * Atua exclusivamente enviando intenções (`requestSkill` / `requestSwitch`),
 * nunca manipulando HP ou ATB diretamente.
 */
export class AIService {
	public readonly tier: AITier = "Bronze";
	private readonly dispatcher: AIIntentDispatcher;
	private trackedActiveFighter: Fighter | undefined;
	private lowHpSwitchEvaluatedForActive = false;
	private skillReactionElapsed = 0;
	private currentSkillDelay: number | undefined;
	private waitingForUltimate = false;
	private timedSwitchElapsed = 0;
	private nextTimedSwitchDelay: number;
	private destroyed = false;

	public constructor(
		private readonly battle: BattleService,
		private readonly aiSide: BattleSide,
		private readonly rng: () => number,
		dispatcher?: AIIntentDispatcher,
	) {
		this.dispatcher = dispatcher ?? {
			requestSkill: (slot) => this.battle.requestSkill(this.aiSide, slot),
			requestSwitch: (index) => this.battle.requestSwitch(this.aiSide, index),
		};
		this.trackedActiveFighter = this.aiSide.getActiveFighter();
		this.nextTimedSwitchDelay = this.rollRange(
			AI_BRONZE_TIMED_SWITCH_MIN_SECONDS,
			AI_BRONZE_TIMED_SWITCH_MAX_SECONDS,
		);
	}

	/**
	 * Atualiza os timers e decisões da IA Bronze.
	 * Só age quando a batalha está em `IDLE`, não pausada e o lutador ativo da IA não está bloqueado.
	 */
	public step(dt: number): void {
		if (this.destroyed || dt <= 0) return;
		if (this.dispatcher.isPaused !== undefined && this.dispatcher.isPaused()) return;
		if (this.battle.state !== "IDLE") return;
		if (this.aiSide.isDefeated()) return;

		const activeFighter = this.aiSide.getActiveFighter();
		if (activeFighter !== this.trackedActiveFighter) {
			this.trackedActiveFighter = activeFighter;
			this.lowHpSwitchEvaluatedForActive = false;
			this.resetSkillReactionTimer();
		}

		if (!activeFighter.isAlive() || activeFighter.localState !== "NORMAL") {
			return;
		}

		// 1. Lógica de Troca por HP baixo (< 25% do HP_MAX): 50% de chance, respeitando Root e com trava anti-loop
		const isLowHp = activeFighter.hp < activeFighter.hpMax * AI_BRONZE_LOW_HP_THRESHOLD;
		if (!isLowHp) {
			this.lowHpSwitchEvaluatedForActive = false;
		} else if (!this.lowHpSwitchEvaluatedForActive) {
			this.lowHpSwitchEvaluatedForActive = true;
			if (!activeFighter.isRooted()) {
				const livingBench = this.getLivingBenchIndices();
				if (livingBench.size() > 0 && this.rng() < AI_BRONZE_LOW_HP_SWITCH_CHANCE) {
					const targetIndex = this.pickRandomElement(livingBench);
					if (this.dispatcher.requestSwitch(targetIndex)) {
						this.trackedActiveFighter = this.aiSide.getActiveFighter();
						this.lowHpSwitchEvaluatedForActive = false;
						this.resetSkillReactionTimer();
						return;
					}
				}
			}
		}

		// 2. Lógica de Troca por tempo (a cada 20s a 30s em IDLE, respeitando Root)
		this.timedSwitchElapsed += dt;
		if (this.timedSwitchElapsed + FLOAT_TOLERANCE >= this.nextTimedSwitchDelay) {
			this.timedSwitchElapsed = 0;
			this.nextTimedSwitchDelay = this.rollRange(
				AI_BRONZE_TIMED_SWITCH_MIN_SECONDS,
				AI_BRONZE_TIMED_SWITCH_MAX_SECONDS,
			);
			if (!activeFighter.isRooted()) {
				const livingBench = this.getLivingBenchIndices();
				if (livingBench.size() > 0) {
					const targetIndex = this.pickRandomElement(livingBench);
					if (this.dispatcher.requestSwitch(targetIndex)) {
						this.trackedActiveFighter = this.aiSide.getActiveFighter();
						this.lowHpSwitchEvaluatedForActive = false;
						this.resetSkillReactionTimer();
						return;
					}
				}
			}
		}

		// 3. Ciclo de reação e escolha de Skill
		const affordableSlots = this.getAffordableSlots(activeFighter, this.aiSide.atb);
		if (affordableSlots.size() === 0) {
			this.resetSkillReactionTimer();
			return;
		}

		const canAffordUltimate = affordableSlots.includes(3);
		if (canAffordUltimate) {
			// Se a ATB atingir o custo da Slot 3 (Ultimate), aguarda 2.0s a 4.0s e dispara a S3
			if (!this.waitingForUltimate || this.currentSkillDelay === undefined) {
				this.waitingForUltimate = true;
				this.skillReactionElapsed = 0;
				this.currentSkillDelay = this.rollRange(
					AI_BRONZE_ULTIMATE_DELAY_MIN_SECONDS,
					AI_BRONZE_ULTIMATE_DELAY_MAX_SECONDS,
				);
			}

			this.skillReactionElapsed += dt;
			if (this.skillReactionElapsed + FLOAT_TOLERANCE >= this.currentSkillDelay) {
				this.resetSkillReactionTimer();
				this.dispatcher.requestSkill(3);
			}
			return;
		}

		// Delay de reação normal (1.5s a 3.0s) quando há ATB para pelo menos uma skill
		if (this.waitingForUltimate || this.currentSkillDelay === undefined) {
			this.waitingForUltimate = false;
			this.skillReactionElapsed = 0;
			this.currentSkillDelay = this.rollRange(
				AI_BRONZE_SKILL_DELAY_MIN_SECONDS,
				AI_BRONZE_SKILL_DELAY_MAX_SECONDS,
			);
		}

		this.skillReactionElapsed += dt;
		if (this.skillReactionElapsed + FLOAT_TOLERANCE >= this.currentSkillDelay) {
			this.resetSkillReactionTimer();
			const chosenSlot = this.chooseSkillSlot(affordableSlots);
			this.dispatcher.requestSkill(chosenSlot);
		}
	}

	/**
	 * Escolhe o slot de skill aplicando a regra de Erro Proposital da IA Bronze:
	 * - 30% de chance de "errar": força o uso da Slot 1 (se tiver ATB) mesmo tendo ATB disponível para Slot 2 ou Slot 3.
	 * - Nos outros 70%, escolhe aleatoriamente entre as skills disponíveis que consegue pagar.
	 */
	public chooseSkillSlot(affordableSlots: readonly SkillSlot[]): SkillSlot {
		affordableSlots = affordableSlots.filter((slot) => slot !== 3 || this.aiSide.getActiveFighter().level >= S3_UNLOCK_LEVEL);
		if (affordableSlots.size() === 0) return 1;
		const hasStrongerOption = affordableSlots.includes(2) || affordableSlots.includes(3);
		if (hasStrongerOption && affordableSlots.includes(1)) {
			if (this.rng() < AI_BRONZE_MISTAKE_CHANCE) {
				return 1;
			}
		}
		return this.pickRandomElement(affordableSlots);
	}

	/** Limpa estado e desativa esta instância de IA ao encerrar a sessão. */
	public destroy(): void {
		this.destroyed = true;
		this.trackedActiveFighter = undefined;
		this.resetSkillReactionTimer();
		this.timedSwitchElapsed = 0;
	}

	public isDestroyed(): boolean {
		return this.destroyed;
	}

	private resetSkillReactionTimer(): void {
		this.skillReactionElapsed = 0;
		this.currentSkillDelay = undefined;
		this.waitingForUltimate = false;
	}

	private getAffordableSlots(fighter: Fighter, currentAtb: number): SkillSlot[] {
		const slots: SkillSlot[] = [];
		for (const slot of [1, 2, 3] as const) {
			if (slot === 3 && fighter.level < S3_UNLOCK_LEVEL) continue;
			const cost = fighter.slots[slot - 1].cost;
			if (currentAtb + FLOAT_TOLERANCE >= cost) {
				slots.push(slot);
			}
		}
		return slots;
	}

	private getLivingBenchIndices(): FighterIndex[] {
		const living: FighterIndex[] = [];
		for (const index of $range(0, 2)) {
			const fighterIndex = index as FighterIndex;
			if (fighterIndex === this.aiSide.activeIndex) continue;
			if (this.aiSide.fighters[fighterIndex].isAlive()) {
				living.push(fighterIndex);
			}
		}
		return living;
	}

	private rollRange(minValue: number, maxValue: number): number {
		return lerp(minValue, maxValue, clamp(this.rng(), 0, 1));
	}

	private pickRandomElement<T extends defined>(items: readonly T[]): T {
		const roll = clamp(this.rng(), 0, 1);
		const index = math.min(math.floor(roll * items.size()), items.size() - 1);
		return items[index];
	}
}
