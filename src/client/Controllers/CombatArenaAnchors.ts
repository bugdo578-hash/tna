import { Workspace } from "@rbxts/services";
import {
	ARENA_BASES_NAME,
	ARENA_SIDE_ANCHOR_NAMES,
	ARENA_TEAM_FOLDER_NAMES,
} from "../UI/CombatVisualConfig";
import { alignFighterCFrameToAnchor } from "./CombatFighterGrounding";

export interface ResolvedArenaSideAnchors {
	readonly folder: Instance;
	readonly active: BasePart;
	readonly waiting: readonly [BasePart, BasePart];
}

export interface ResolvedArenaAnchors {
	readonly root: Instance;
	readonly sides: readonly [ResolvedArenaSideAnchors, ResolvedArenaSideAnchors];
}

export interface ArenaAnchorResolutionResult {
	readonly ok: boolean;
	readonly anchors?: ResolvedArenaAnchors;
	readonly diagnostics: readonly string[];
}

function findDirectChildrenByName(parent: Instance, name: string): Instance[] {
	const matches: Instance[] = [];
	for (const child of parent.GetChildren()) {
		if (child.Name === name) {
			matches.push(child);
		}
	}
	return matches;
}

function resolveUniqueChild(
	parent: Instance,
	name: string,
	kindLabel: string,
	diagnostics: string[],
): Instance | undefined {
	const matches = findDirectChildrenByName(parent, name);
	if (matches.size() === 0) {
		diagnostics.push(
			`[CombatArenaAnchors] Referência ausente: ${kindLabel} "${name}" não encontrada em "${parent.GetFullName()}".`,
		);
		return undefined;
	}
	if (matches.size() > 1) {
		diagnostics.push(
			`[CombatArenaAnchors] Referência duplicada/ambígua: encontradas ${matches.size()} instâncias "${name}" em "${parent.GetFullName()}".`,
		);
		return undefined;
	}
	return matches[0];
}

function resolveUniqueAnchorPart(
	parent: Instance,
	name: string,
	diagnostics: string[],
): BasePart | undefined {
	const match = resolveUniqueChild(parent, name, "BasePart", diagnostics);
	if (match === undefined) return undefined;
	if (!match.IsA("BasePart")) {
		diagnostics.push(
			`[CombatArenaAnchors] Referência inválida: "${match.GetFullName()}" é ${match.ClassName}, esperado BasePart.`,
		);
		return undefined;
	}
	return match;
}

function resolveSideAnchors(
	arenaRoot: Instance,
	sideIndex: 0 | 1,
	diagnostics: string[],
): ResolvedArenaSideAnchors | undefined {
	const folderName = ARENA_TEAM_FOLDER_NAMES[sideIndex];
	const folder = resolveUniqueChild(arenaRoot, folderName, "Pasta de equipe", diagnostics);
	if (folder === undefined) return undefined;

	const anchorNames = ARENA_SIDE_ANCHOR_NAMES[sideIndex];
	const active = resolveUniqueAnchorPart(folder, anchorNames.active, diagnostics);
	const waiting0 = resolveUniqueAnchorPart(folder, anchorNames.waiting[0], diagnostics);
	const waiting1 = resolveUniqueAnchorPart(folder, anchorNames.waiting[1], diagnostics);

	if (active === undefined || waiting0 === undefined || waiting1 === undefined) {
		return undefined;
	}
	return {
		folder,
		active,
		waiting: [waiting0, waiting1],
	};
}

/**
 * Resolve e valida todas as referências de posicionamento de lutadores em `Arena_bases`.
 * Não cria Parts substitutas nem inventa posições de fallback em caso de ausência, duplicidade ou tipo inválido.
 */
export function resolveArenaAnchors(searchRoot: Instance = Workspace): ArenaAnchorResolutionResult {
	const diagnostics: string[] = [];
	const arenaRoot = resolveUniqueChild(searchRoot, ARENA_BASES_NAME, "Arena", diagnostics);
	if (arenaRoot === undefined) {
		return { ok: false, diagnostics };
	}

	const sideA = resolveSideAnchors(arenaRoot, 0, diagnostics);
	const sideB = resolveSideAnchors(arenaRoot, 1, diagnostics);
	if (diagnostics.size() > 0 || sideA === undefined || sideB === undefined) {
		return { ok: false, diagnostics };
	}

	return {
		ok: true,
		anchors: {
			root: arenaRoot,
			sides: [sideA, sideB],
		},
		diagnostics: [],
	};
}

/** Cache por batalha das referências de `Arena_bases`, lendo o `CFrame` completo dos anchors resolvidos. */
export class CombatArenaAnchorResolver {
	private resolved: ResolvedArenaAnchors | undefined;
	private lastDiagnostics: readonly string[] = [];

	public constructor(private readonly searchRoot: Instance = Workspace) {}

	public resolveForBattle(): ArenaAnchorResolutionResult {
		const result = resolveArenaAnchors(this.searchRoot);
		this.lastDiagnostics = result.diagnostics;
		if (!result.ok || result.anchors === undefined) {
			this.resolved = undefined;
			for (const message of result.diagnostics) {
				warn(message);
			}
			return result;
		}
		this.resolved = result.anchors;
		return result;
	}

	public clear(): void {
		this.resolved = undefined;
	}

	public getResolvedAnchors(): ResolvedArenaAnchors | undefined {
		return this.resolved;
	}

	public getLastDiagnostics(): readonly string[] {
		return this.lastDiagnostics;
	}

	public getActiveAnchorPart(sideIndex: 0 | 1): BasePart | undefined {
		const anchors = this.resolved;
		if (anchors === undefined) {
			warn(
				`[CombatArenaAnchors] Ponto ativo indisponível para lado ${sideIndex}: referências da arena não resolvidas.`,
			);
			return undefined;
		}
		const anchor = anchors.sides[sideIndex].active;
		if (!anchor.IsDescendantOf(this.searchRoot)) {
			warn(
				`[CombatArenaAnchors] Referência inválida em tempo de batalha: ponto ativo "${anchor.Name}" não está mais em "${this.searchRoot.GetFullName()}".`,
			);
			return undefined;
		}
		return anchor;
	}

	public getBenchAnchorPart(sideIndex: 0 | 1, benchSlot: number): BasePart | undefined {
		const anchors = this.resolved;
		if (anchors === undefined) {
			warn(
				`[CombatArenaAnchors] Ponto de espera indisponível para lado ${sideIndex} (slot ${benchSlot}): referências da arena não resolvidas.`,
			);
			return undefined;
		}
		const waitingSlots = anchors.sides[sideIndex].waiting;
		if (benchSlot < 0 || benchSlot >= waitingSlots.size() || math.floor(benchSlot) !== benchSlot) {
			warn(
				`[CombatArenaAnchors] Índice de espera inválido (${benchSlot}) para lado ${sideIndex}; esperado 0 ou ${waitingSlots.size() - 1}.`,
			);
			return undefined;
		}
		const anchor = waitingSlots[benchSlot];
		if (!anchor.IsDescendantOf(this.searchRoot)) {
			warn(
				`[CombatArenaAnchors] Referência inválida em tempo de batalha: ponto de espera "${anchor.Name}" não está mais em "${this.searchRoot.GetFullName()}".`,
			);
			return undefined;
		}
		return anchor;
	}

	public getActiveSlotCFrame(sideIndex: 0 | 1, groundContactOffset?: Vector3): CFrame | undefined {
		const anchor = this.getActiveAnchorPart(sideIndex);
		if (anchor === undefined) return undefined;
		return alignFighterCFrameToAnchor(anchor, groundContactOffset);
	}

	public getBenchSlotCFrame(sideIndex: 0 | 1, benchSlot: number, groundContactOffset?: Vector3): CFrame | undefined {
		const anchor = this.getBenchAnchorPart(sideIndex, benchSlot);
		if (anchor === undefined) return undefined;
		return alignFighterCFrameToAnchor(anchor, groundContactOffset);
	}
}
