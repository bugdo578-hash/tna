import type { HitResolvedPayload } from "../../shared/Remotes";
import { HIT_RESULT_WAIT_SECONDS, HIT_WAIT_POLL_INTERVAL_SECONDS } from "../UI/CombatVisualConfig";

export interface CombatHitQueueHost {
	readonly isBattleEnded: () => boolean;
	/** Verdadeiro enquanto `attackToken` for o ataque atual de uma batalha não encerrada. */
	readonly isAttackCurrent: (attackToken: number) => boolean;
	readonly isFollowUpCancelled: () => boolean;
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

	public recordHitResult(payload: HitResolvedPayload): void {
		if (this.host.isBattleEnded()) return;
		let bucket = this.hitResultsByIndex.get(payload.hitIndex);
		if (bucket === undefined) {
			bucket = [];
			this.hitResultsByIndex.set(payload.hitIndex, bucket);
		}
		bucket.push(payload);
	}

	public beginAttack(totalHits: number): void {
		const normalizedTotal = math.max(totalHits, 0);
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.expectedTotalHits = normalizedTotal;
		this.attackFinalized = false;
		this.setActivePendingHits(normalizedTotal);
	}

	public clear(): void {
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.expectedTotalHits = 0;
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

		const deadline = os.clock() + HIT_RESULT_WAIT_SECONDS;
		while (this.hitResultsByIndex.get(hitIndex) === undefined && !isTargetDead() && os.clock() < deadline) {
			if (this.attackFinalized || !this.host.isAttackCurrent(attackToken)) return false;
			task.wait(HIT_WAIT_POLL_INTERVAL_SECONDS);
		}

		if (this.attackFinalized || this.consumedHitIndices.has(hitIndex) || !this.host.isAttackCurrent(attackToken)) {
			return false;
		}
		this.consumedHitIndices.add(hitIndex);

		const results = this.hitResultsByIndex.get(hitIndex) ?? [];
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
