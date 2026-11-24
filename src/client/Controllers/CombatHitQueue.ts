import type { HitResolvedPayload } from "../../shared/Remotes";
import { HIT_RESULT_WAIT_SECONDS, HIT_WAIT_POLL_INTERVAL_SECONDS } from "../UI/CombatVisualConfig";

export interface CombatHitQueueHost {
	readonly isBattleEnded: () => boolean;
	/** Verdadeiro enquanto `attackToken` for o ataque atual de uma batalha não encerrada. */
	readonly isAttackCurrent: (attackToken: number) => boolean;
	readonly isFollowUpCancelled: () => boolean;
	readonly now?: () => number;
	readonly awaitResume?: () => void;
	/** Mantém `CombatController.activePendingHits` sincronizado para compatibilidade com os QAs Luau. */
	readonly onPendingHitsChanged?: (activePendingHits: number) => void;
}

/** Fila de resultados de hits por índice: armazenamento, espera, consumo único e limpeza. */
export class CombatHitQueue {
	public readonly hitResultsByIndex = new Map<number, HitResolvedPayload[]>();
	public readonly consumedHitIndices = new Set<number>();

	private activePendingHits = 0;
	private expectedTotalHits = 0;
	private attackFinalized = false;
	private attackSequence?: number;
	private readonly expiredWaits = new Set<number>();

	public constructor(private readonly host: CombatHitQueueHost) {}

	public getActivePendingHits(): number {
		return this.activePendingHits;
	}

	public hasPendingHits(): boolean {
		return this.activePendingHits > 0;
	}

	public isHitConsumed(hitIndex: number): boolean {
		return this.consumedHitIndices.has(hitIndex);
	}

	/** Verdadeiro quando existe HitResolved já recebido para `targetId` ainda não consumido neste ataque. */
	public hasUnconsumedHitForTarget(targetId: string): boolean {
		for (const [hitIndex, bucket] of this.hitResultsByIndex) {
			if (this.consumedHitIndices.has(hitIndex)) continue;
			for (const result of bucket) {
				if (result.targetId === targetId) return true;
			}
		}
		return false;
	}

	/**
	 * Consome imediatamente apenas os HitResolved já recebidos do servidor que ainda não foram consumidos,
	 * em ordem crescente de `hitIndex`, sem inventar impactos para índices ausentes.
	 */
	public drainUnconsumedResults(consumeResults: (results: readonly HitResolvedPayload[]) => void): void {
		if (this.attackFinalized) return;
		const pendingIndices: number[] = [];
		for (const [hitIndex] of this.hitResultsByIndex) {
			if (!this.consumedHitIndices.has(hitIndex)) {
				pendingIndices.push(hitIndex);
			}
		}
		pendingIndices.sort((a, b) => a < b);

		for (const hitIndex of pendingIndices) {
			if (this.attackFinalized || this.host.isBattleEnded() || this.host.isFollowUpCancelled()) break;
			this.consumedHitIndices.add(hitIndex);
			const results = this.hitResultsByIndex.get(hitIndex);
			if (results !== undefined && results.size() > 0) {
				consumeResults(results);
			}
		}

		this.attackFinalized = true;
		this.setActivePendingHits(0);
	}

	public recordHitResult(payload: HitResolvedPayload): boolean {
		if (this.host.isBattleEnded() || this.attackFinalized || payload.attackSequence !== this.attackSequence) return false;
		if (payload.hitIndex < 1 || payload.hitIndex > this.expectedTotalHits || this.isHitConsumed(payload.hitIndex)) return false;
		let bucket = this.hitResultsByIndex.get(payload.hitIndex);
		if (bucket === undefined) {
			bucket = [];
			this.hitResultsByIndex.set(payload.hitIndex, bucket);
		}
		if (!bucket.some((result) => result.targetId === payload.targetId)) bucket.push(payload);
		return this.expiredWaits.delete(payload.hitIndex);
	}

	public beginAttack(totalHits: number, attackSequence?: number): void {
		const normalizedTotal = math.max(totalHits, 0);
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.expiredWaits.clear();
		this.expectedTotalHits = normalizedTotal;
		this.attackSequence = attackSequence;
		this.attackFinalized = false;
		this.setActivePendingHits(normalizedTotal);
	}

	public clear(): void {
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.expiredWaits.clear();
		this.expectedTotalHits = 0;
		this.attackSequence = undefined;
		this.attackFinalized = false;
		this.setActivePendingHits(0);
	}

	/**
	 * Aguarda e consome `hitIndex` no máximo uma vez dentro do ataque atual.
	 * Retorna verdadeiro quando o hit consumido encerra a sequência (todos os hits esperados consumidos ou follow-up cancelado).
	 */
	public waitForAndConsumeHitIndex(
		hitIndex: number,
		totalHits: number,
		attackToken: number,
		isTargetDead: () => boolean,
		consumeResults: (results: readonly HitResolvedPayload[]) => void,
	): boolean {
		if (this.attackFinalized || this.consumedHitIndices.has(hitIndex) || !this.host.isAttackCurrent(attackToken)) {
			return false;
		}

		const now = this.host.now ?? os.clock;
		const deadline = now() + HIT_RESULT_WAIT_SECONDS;
		this.host.awaitResume?.();
		while (this.hitResultsByIndex.get(hitIndex) === undefined && !isTargetDead() && now() < deadline) {
			if (this.attackFinalized || !this.host.isAttackCurrent(attackToken)) return false;
			task.wait(HIT_WAIT_POLL_INTERVAL_SECONDS);
			this.host.awaitResume?.();
		}

		if (this.attackFinalized || this.consumedHitIndices.has(hitIndex) || !this.host.isAttackCurrent(attackToken)) {
			return false;
		}
		const results = this.hitResultsByIndex.get(hitIndex) ?? [];
		if (results.isEmpty() && !isTargetDead()) {
			this.expiredWaits.add(hitIndex);
			return false;
		}
		this.expiredWaits.delete(hitIndex);
		this.consumedHitIndices.add(hitIndex);
		consumeResults(results);

		if (this.attackFinalized || !this.host.isAttackCurrent(attackToken)) {
			return false;
		}

		const expectedHits = math.max(totalHits, this.expectedTotalHits, 0);
		const remainingHits = math.max(expectedHits - this.consumedHitIndices.size(), 0);
		const isLastHit = remainingHits === 0 || this.host.isFollowUpCancelled();
		if (isLastHit) {
			this.attackFinalized = true;
			this.setActivePendingHits(0);
		} else {
			this.setActivePendingHits(remainingHits);
		}
		return isLastHit;
	}

	private setActivePendingHits(value: number): void {
		this.activePendingHits = value;
		this.host.onPendingHitsChanged?.(value);
	}
}
