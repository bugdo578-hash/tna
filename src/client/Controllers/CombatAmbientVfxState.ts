import type { BattleFighterSnapshot } from "../../shared/Remotes";
import { AMBIENT_VFX_ATTRIBUTES, AMBIENT_VFX_STATE_NODE_NAME } from "../UI/CombatVisualConfig";

export type AmbientVfxLocalSide = "" | "A" | "B";
export type AmbientVfxLocalSideIndex = 0 | 1 | 2;

export interface AmbientVfxStateSnapshot {
	readonly active: boolean;
	readonly battleId: string;
	readonly generation: number;
	readonly transitionId: number;
	readonly arenaInstanceId: string;
	readonly localSide: AmbientVfxLocalSide;
	readonly localSideIndex: AmbientVfxLocalSideIndex;
	readonly fightersReady: boolean;
	readonly goOccurred: boolean;
	readonly revision: number;
}

export interface AmbientVfxBeginBattleParams {
	readonly generation: number;
	readonly battleId: string;
	readonly transitionId?: number;
	readonly arenaInstanceId?: string;
	readonly ownSideId: string;
	readonly physicalSides: readonly [string, string];
}

export interface AmbientVfxFighterEntry {
	readonly sideIndex: 0 | 1;
	readonly model: Model;
	readonly rootPart: BasePart;
}

/**
 * Resolve o lado físico do jogador local estritamente a partir dos sideIds autoritativos
 * (`ownSideId` vs `physicalSides = [Time A, Time B]`), nunca por posição de câmera.
 */
export function resolveLocalPhysicalSide(
	ownSideId: string,
	physicalSides: readonly [string, string],
): { readonly side: "A" | "B"; readonly sideIndex: 1 | 2 } | undefined {
	if (ownSideId.size() === 0) return undefined;
	if (physicalSides[0].size() === 0 || physicalSides[1].size() === 0) return undefined;
	if (physicalSides[0] === physicalSides[1]) return undefined;
	if (ownSideId === physicalSides[0]) return { side: "A", sideIndex: 1 };
	if (ownSideId === physicalSides[1]) return { side: "B", sideIndex: 2 };
	return undefined;
}

/**
 * Verifica se todos os lutadores exigidos pela batalha foram carregados e montados no palco,
 * garantindo presença e titular ativo nos dois lados físicos.
 */
export function areRequiredFightersReady(
	expectedFighters: readonly BattleFighterSnapshot[],
	loadedFighters: ReadonlyMap<string, AmbientVfxFighterEntry>,
	stageFolder: Folder | undefined,
	physicalSides: readonly [string, string],
): boolean {
	if (stageFolder === undefined || stageFolder.Parent === undefined) return false;
	if (expectedFighters.size() < 2 || loadedFighters.size() !== expectedFighters.size()) return false;
	if (physicalSides[0].size() === 0 || physicalSides[1].size() === 0 || physicalSides[0] === physicalSides[1]) {
		return false;
	}

	const countBySide: [number, number] = [0, 0];
	const activeBySide: [boolean, boolean] = [false, false];

	for (const snapshot of expectedFighters) {
		const expectedSideIndex: 0 | 1 | undefined =
			snapshot.sideId === physicalSides[0] ? 0 : snapshot.sideId === physicalSides[1] ? 1 : undefined;
		if (expectedSideIndex === undefined) return false;

		const entry = loadedFighters.get(snapshot.targetId);
		if (entry === undefined || entry.sideIndex !== expectedSideIndex) return false;
		if (entry.model.Parent === undefined || !entry.model.IsDescendantOf(stageFolder)) return false;
		if (entry.rootPart.Parent === undefined || !entry.rootPart.IsDescendantOf(entry.model)) return false;

		countBySide[expectedSideIndex] += 1;
		if (snapshot.active) {
			activeBySide[expectedSideIndex] = true;
		}
	}

	return countBySide[0] > 0 && countBySide[1] > 0 && activeBySide[0] && activeBySide[1];
}

function getOrCreateStateNode(host?: Instance): Configuration {
	if (host !== undefined) {
		const existing = host.FindFirstChild(AMBIENT_VFX_STATE_NODE_NAME);
		if (existing !== undefined) {
			if (existing.IsA("Configuration")) return existing;
			existing.Destroy();
		}
	}
	const node = new Instance("Configuration");
	node.Name = AMBIENT_VFX_STATE_NODE_NAME;
	if (host !== undefined) {
		node.Parent = host;
	}
	return node;
}

/**
 * Publicador cliente-local do estado autoritativo consumido pelo LocalScript manual `ArenaAmbientVFX`.
 * Protegido por `battleId`, `generation` e `transitionId`, com commits atômicos via atributo `Revision`.
 */
export class CombatAmbientVfxState {
	private readonly stateNode: Configuration;
	private readonly ownedInternally: boolean;

	private active = false;
	private ended = true;
	private battleId = "";
	private generation = 0;
	private transitionId = -1;
	private arenaInstanceId = "";
	private localSide: AmbientVfxLocalSide = "";
	private localSideIndex: AmbientVfxLocalSideIndex = 0;
	private fightersReady = false;
	private goOccurred = false;
	private revision = 0;

	public constructor(host?: Instance) {
		this.stateNode = getOrCreateStateNode(host);
		this.ownedInternally = host === undefined;
		this.publish();
	}

	public beginBattle(params: AmbientVfxBeginBattleParams): boolean {
		if (params.generation < this.generation || params.generation <= 0 || params.battleId.size() === 0) {
			return false;
		}

		const resolvedSide = resolveLocalPhysicalSide(params.ownSideId, params.physicalSides);
		const instanceId = params.arenaInstanceId ?? "";

		this.ended = false;
		this.generation = params.generation;
		this.battleId = params.battleId;
		this.transitionId = params.transitionId ?? -1;
		this.arenaInstanceId = instanceId;
		this.localSide = resolvedSide?.side ?? "";
		this.localSideIndex = resolvedSide?.sideIndex ?? 0;
		this.fightersReady = false;
		this.goOccurred = false;
		this.active = false;
		this.publish();

		return resolvedSide !== undefined && instanceId.size() > 0;
	}

	public markFightersReady(generation: number, battleId: string, ready: boolean): boolean {
		if (!this.matchesActiveBattle(generation, battleId)) return false;
		if (this.fightersReady === ready) {
			return this.active;
		}
		this.fightersReady = ready;
		this.recomputeActive();
		this.publish();
		return this.active;
	}

	public markGoOccurred(generation: number, battleId: string, transitionId?: number): boolean {
		if (!this.matchesActiveBattle(generation, battleId)) return false;
		if (this.transitionId >= 0 && transitionId !== this.transitionId) return false;
		if (this.goOccurred) {
			return this.active;
		}
		this.goOccurred = true;
		this.recomputeActive();
		this.publish();
		return this.active;
	}

	public deactivateForBattleEnd(expectedTransitionId?: number): void {
		if (expectedTransitionId !== undefined && this.transitionId >= 0 && this.transitionId !== expectedTransitionId) {
			return;
		}
		this.ended = true;
		this.active = false;
		this.fightersReady = false;
		this.goOccurred = false;
		this.arenaInstanceId = "";
		this.localSide = "";
		this.localSideIndex = 0;
		this.publish();
	}

	public clear(nextGeneration?: number): void {
		if (nextGeneration !== undefined && nextGeneration > this.generation) {
			this.generation = nextGeneration;
		}
		this.ended = true;
		this.active = false;
		this.battleId = "";
		this.transitionId = -1;
		this.arenaInstanceId = "";
		this.localSide = "";
		this.localSideIndex = 0;
		this.fightersReady = false;
		this.goOccurred = false;
		this.publish();
	}

	public getSnapshot(): AmbientVfxStateSnapshot {
		return {
			active: this.active,
			battleId: this.battleId,
			generation: this.generation,
			transitionId: this.transitionId,
			arenaInstanceId: this.arenaInstanceId,
			localSide: this.localSide,
			localSideIndex: this.localSideIndex,
			fightersReady: this.fightersReady,
			goOccurred: this.goOccurred,
			revision: this.revision,
		};
	}

	public getStateInstance(): Configuration {
		return this.stateNode;
	}

	public destroy(): void {
		this.clear();
		if (this.ownedInternally && this.stateNode.Parent === undefined) {
			this.stateNode.Destroy();
		}
	}

	private matchesActiveBattle(generation: number, battleId: string): boolean {
		return !this.ended && generation > 0 && this.generation === generation && this.battleId.size() > 0 && this.battleId === battleId;
	}

	private recomputeActive(): void {
		this.active =
			!this.ended &&
			this.generation > 0 &&
			this.battleId.size() > 0 &&
			this.arenaInstanceId.size() > 0 &&
			(this.localSide === "A" || this.localSide === "B") &&
			(this.localSideIndex === 1 || this.localSideIndex === 2) &&
			this.fightersReady &&
			this.goOccurred;
	}

	private publish(): void {
		const attrs = AMBIENT_VFX_ATTRIBUTES;
		const node = this.stateNode;
		if (!this.active) {
			node.SetAttribute(attrs.active, false);
		}
		node.SetAttribute(attrs.battleId, this.battleId);
		node.SetAttribute(attrs.generation, this.generation);
		node.SetAttribute(attrs.transitionId, this.transitionId);
		node.SetAttribute(attrs.arenaInstanceId, this.arenaInstanceId);
		node.SetAttribute(attrs.localSide, this.localSide);
		node.SetAttribute(attrs.localSideIndex, this.localSideIndex);
		node.SetAttribute(attrs.fightersReady, this.fightersReady);
		node.SetAttribute(attrs.goOccurred, this.goOccurred);
		if (this.active) {
			node.SetAttribute(attrs.active, true);
		}
		this.revision += 1;
		node.SetAttribute(attrs.revision, this.revision);
	}
}
