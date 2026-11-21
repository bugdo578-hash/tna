import { Workspace } from "@rbxts/services";
import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_CLIENT_REPLICATION_POLL_SECONDS,
	ARENA_CLIENT_REPLICATION_TIMEOUT_SECONDS,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
	ARENA_TYPE_ATTRIBUTE,
	isValidArenaId,
	isValidArenaType,
} from "../../shared/Config";
import type { BattleArenaPayload } from "../../shared/Remotes";
import {
	ARENA_BASES_NAME,
	ARENA_SIDE_ANCHOR_NAMES,
	ARENA_TEAM_FOLDER_NAMES,
} from "../UI/CombatVisualConfig";
import { alignFighterCFrameToAnchor } from "./CombatFighterGrounding";
import { resolveSideCameraAnchor } from "./CombatCameraController";

export interface ResolvedArenaSideAnchors {
	readonly folder: Instance;
	readonly active: BasePart;
	readonly waiting: readonly [BasePart, BasePart];
	readonly camera?: BasePart;
}

export interface ResolvedArenaAnchors {
	readonly root: Instance;
	readonly arenaInstance?: Model;
	readonly sides: readonly [ResolvedArenaSideAnchors, ResolvedArenaSideAnchors];
}

export interface ArenaAnchorResolutionResult {
	readonly ok: boolean;
	readonly anchors?: ResolvedArenaAnchors;
	readonly arenaInstance?: Model;
	readonly diagnostics: readonly string[];
}

interface ReservedInstanceLookup {
	readonly instance?: Model;
	readonly fatal?: string;
	readonly waiting?: string;
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
	const cameraResult = resolveSideCameraAnchor(folder, sideIndex);
	return {
		folder,
		active,
		waiting: [waiting0, waiting1],
		camera: cameraResult.camera,
	};
}

function lookupReservedArenaInstance(searchRoot: Instance, arena: BattleArenaPayload): ReservedInstanceLookup {
	const activeFolders = findDirectChildrenByName(searchRoot, ACTIVE_ARENAS_FOLDER_NAME);
	if (activeFolders.size() === 0) {
		return {
			waiting: `[CombatArenaAnchors] Pasta "${ACTIVE_ARENAS_FOLDER_NAME}" ainda não replicada em "${searchRoot.GetFullName()}".`,
		};
	}
	if (activeFolders.size() > 1) {
		return {
			fatal: `[CombatArenaAnchors] Pasta "${ACTIVE_ARENAS_FOLDER_NAME}" duplicada (${activeFolders.size()}x) em "${searchRoot.GetFullName()}".`,
		};
	}
	const activeFolder = activeFolders[0];
	if (!activeFolder.IsA("Folder")) {
		return {
			fatal: `[CombatArenaAnchors] "${activeFolder.GetFullName()}" é ${activeFolder.ClassName}, esperado Folder.`,
		};
	}

	const matches: Instance[] = [];
	for (const child of activeFolder.GetChildren()) {
		if (child.Name === arena.instanceId || child.GetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE) === arena.instanceId) {
			matches.push(child);
		}
	}
	if (matches.size() === 0) {
		return {
			waiting: `[CombatArenaAnchors] Instância reservada "${arena.instanceId}" ainda não replicada em "${activeFolder.GetFullName()}".`,
		};
	}
	if (matches.size() > 1) {
		return {
			fatal: `[CombatArenaAnchors] Instância reservada "${arena.instanceId}" duplicada/ambígua (${matches.size()}x) em "${activeFolder.GetFullName()}".`,
		};
	}

	const instance = matches[0];
	if (!instance.IsA("Model")) {
		return {
			fatal: `[CombatArenaAnchors] Instância reservada "${instance.GetFullName()}" é ${instance.ClassName}, esperado Model.`,
		};
	}

	const instanceIdAttr = instance.GetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE);
	const arenaIdAttr = instance.GetAttribute(ARENA_ID_ATTRIBUTE);
	if (instanceIdAttr === undefined || arenaIdAttr === undefined) {
		return {
			waiting: `[CombatArenaAnchors] Atributos da instância reservada "${arena.instanceId}" ainda não replicados.`,
		};
	}
	if (instanceIdAttr !== arena.instanceId || arenaIdAttr !== arena.arenaId) {
		return {
			fatal: `[CombatArenaAnchors] Divergência na instância "${instance.GetFullName()}": esperado (${arena.instanceId}, ${arena.arenaId}), encontrado (${tostring(instanceIdAttr)}, ${tostring(arenaIdAttr)}).`,
		};
	}
	if (arena.arenaType !== undefined) {
		const arenaTypeAttr = instance.GetAttribute(ARENA_TYPE_ATTRIBUTE);
		if (arenaTypeAttr === undefined) {
			return {
				waiting: `[CombatArenaAnchors] Atributo legado ${ARENA_TYPE_ATTRIBUTE} da instância "${arena.instanceId}" ainda não replicado.`,
			};
		}
		if (arenaTypeAttr !== arena.arenaType) {
			return {
				fatal: `[CombatArenaAnchors] Divergência de ${ARENA_TYPE_ATTRIBUTE} na instância "${instance.GetFullName()}": esperado ${arena.arenaType}, encontrado ${tostring(arenaTypeAttr)}.`,
			};
		}
	}

	return { instance };
}

/**
 * Resolve e valida todas as referências de posicionamento de lutadores em `Arena_bases`
 * sob a raiz informada (instância específica em `ActiveArenas` ou `Workspace` em testes legados).
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
			arenaInstance: searchRoot.IsA("Model") ? searchRoot : undefined,
			sides: [sideA, sideB],
		},
		arenaInstance: searchRoot.IsA("Model") ? searchRoot : undefined,
		diagnostics: [],
	};
}

/** Cache por batalha das referências de `Arena_bases`, lendo o `CFrame` completo dos anchors resolvidos. */
export class CombatArenaAnchorResolver {
	private resolved: ResolvedArenaAnchors | undefined;
	private activeRoot: Instance;
	private lastDiagnostics: readonly string[] = [];

	public constructor(private readonly searchRoot: Instance = Workspace) {
		this.activeRoot = searchRoot;
	}

	public resolveForBattle(arenaRoot?: Instance): ArenaAnchorResolutionResult {
		const targetRoot = arenaRoot ?? this.searchRoot;
		const result = resolveArenaAnchors(targetRoot);
		this.lastDiagnostics = result.diagnostics;
		if (!result.ok || result.anchors === undefined) {
			this.resolved = undefined;
			this.activeRoot = this.searchRoot;
			for (const message of result.diagnostics) {
				warn(message);
			}
			return result;
		}
		this.resolved = result.anchors;
		this.activeRoot = targetRoot;
		return result;
	}

	/**
	 * Aguarda de maneira limitada a replicação da instância exata reservada em `ActiveArenas`
	 * e resolve seus anchors internos. Nunca faz fallback para `Workspace.Arena_bases` ou outra arena.
	 */
	public resolveForReservedArena(
		arena: BattleArenaPayload,
		shouldContinue?: () => boolean,
		timeoutSeconds = ARENA_CLIENT_REPLICATION_TIMEOUT_SECONDS,
		pollSeconds = ARENA_CLIENT_REPLICATION_POLL_SECONDS,
	): ArenaAnchorResolutionResult {
		const validationErrors: string[] = [];
		if (!typeIs(arena.instanceId, "string") || arena.instanceId.size() === 0) {
			validationErrors.push("[CombatArenaAnchors] Payload de arena inválido: instanceId ausente.");
		}
		if (!isValidArenaId(arena.arenaId)) {
			validationErrors.push(`[CombatArenaAnchors] Payload de arena inválido: arenaId (${tostring(arena.arenaId)}).`);
		}
		if (arena.arenaType !== undefined && !isValidArenaType(arena.arenaType)) {
			validationErrors.push(`[CombatArenaAnchors] Payload de arena inválido: arenaType (${tostring(arena.arenaType)}).`);
		}
		if (validationErrors.size() > 0) {
			if (shouldContinue === undefined || shouldContinue()) {
				this.resolved = undefined;
				this.activeRoot = this.searchRoot;
				this.lastDiagnostics = validationErrors;
				for (const message of validationErrors) warn(message);
			}
			return { ok: false, diagnostics: validationErrors };
		}

		const clampedTimeout = math.max(timeoutSeconds, 0);
		const clampedPoll = math.max(pollSeconds, 0.01);
		const deadline = os.clock() + clampedTimeout;
		let lastDiagnostics: readonly string[] = [];

		while (true) {
			if (shouldContinue !== undefined && !shouldContinue()) {
				return { ok: false, diagnostics: [] };
			}

			const lookup = lookupReservedArenaInstance(this.searchRoot, arena);
			if (lookup.fatal !== undefined) {
				const fatalDiagnostics = [lookup.fatal];
				if (shouldContinue === undefined || shouldContinue()) {
					this.resolved = undefined;
					this.activeRoot = this.searchRoot;
					this.lastDiagnostics = fatalDiagnostics;
					warn(lookup.fatal);
				}
				return { ok: false, diagnostics: fatalDiagnostics };
			}

			if (lookup.instance !== undefined) {
				const anchorResult = resolveArenaAnchors(lookup.instance);
				if (anchorResult.ok && anchorResult.anchors !== undefined) {
					if (shouldContinue !== undefined && !shouldContinue()) {
						return { ok: false, diagnostics: [] };
					}
					const anchorsWithInstance: ResolvedArenaAnchors = {
						root: anchorResult.anchors.root,
						arenaInstance: lookup.instance,
						sides: anchorResult.anchors.sides,
					};
					this.resolved = anchorsWithInstance;
					this.activeRoot = lookup.instance;
					this.lastDiagnostics = [];
					return {
						ok: true,
						anchors: anchorsWithInstance,
						arenaInstance: lookup.instance,
						diagnostics: [],
					};
				}
				lastDiagnostics = anchorResult.diagnostics;
			} else if (lookup.waiting !== undefined) {
				lastDiagnostics = [lookup.waiting];
			}

			const remaining = deadline - os.clock();
			if (remaining <= 0) {
				break;
			}
			task.wait(math.min(clampedPoll, remaining));
		}

		if (shouldContinue !== undefined && !shouldContinue()) {
			return { ok: false, diagnostics: [] };
		}

		const arenaLabel = arena.arenaType !== undefined ? `${arena.arenaId}/${arena.arenaType}` : arena.arenaId;
		const finalDiagnostics: string[] = [
			`[CombatArenaAnchors] Timeout (${clampedTimeout}s) aguardando replicação da arena reservada "${arena.instanceId}" (${arenaLabel}).`,
		];
		for (const detail of lastDiagnostics) {
			finalDiagnostics.push(detail);
		}
		this.resolved = undefined;
		this.activeRoot = this.searchRoot;
		this.lastDiagnostics = finalDiagnostics;
		for (const message of finalDiagnostics) {
			warn(message);
		}
		return { ok: false, diagnostics: finalDiagnostics };
	}

	public clear(): void {
		this.resolved = undefined;
		this.activeRoot = this.searchRoot;
	}

	public getResolvedAnchors(): ResolvedArenaAnchors | undefined {
		return this.resolved;
	}

	public getActiveArenaInstance(): Model | undefined {
		return this.resolved?.arenaInstance;
	}

	public getLastDiagnostics(): readonly string[] {
		return this.lastDiagnostics;
	}

	public isDescendantInActiveRoot(instance: Instance): boolean {
		if (!instance.IsDescendantOf(this.activeRoot)) {
			return false;
		}
		if (this.activeRoot !== this.searchRoot && !this.activeRoot.IsDescendantOf(this.searchRoot)) {
			return false;
		}
		return true;
	}

	public getSideFolder(sideIndex: 0 | 1): Instance | undefined {
		const folder = this.resolved?.sides[sideIndex].folder;
		if (folder === undefined || !this.isDescendantInActiveRoot(folder)) return undefined;
		return folder;
	}

	private isAnchorValidInActiveRoot(anchor: BasePart): boolean {
		if (!anchor.IsDescendantOf(this.activeRoot)) {
			return false;
		}
		if (this.activeRoot !== this.searchRoot && !this.activeRoot.IsDescendantOf(this.searchRoot)) {
			return false;
		}
		return true;
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
		if (!this.isAnchorValidInActiveRoot(anchor)) {
			warn(
				`[CombatArenaAnchors] Referência inválida em tempo de batalha: ponto ativo "${anchor.Name}" não está mais em "${this.activeRoot.GetFullName()}".`,
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
		if (!this.isAnchorValidInActiveRoot(anchor)) {
			warn(
				`[CombatArenaAnchors] Referência inválida em tempo de batalha: ponto de espera "${anchor.Name}" não está mais em "${this.activeRoot.GetFullName()}".`,
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

	public getCameraAnchorPart(sideIndex: 0 | 1): BasePart | undefined {
		const sideFolder = this.getSideFolder(sideIndex);
		if (sideFolder === undefined) return undefined;
		const result = resolveSideCameraAnchor(sideFolder, sideIndex);
		if (!result.ok || result.camera === undefined || !this.isDescendantInActiveRoot(result.camera)) {
			for (const message of result.diagnostics) warn(message);
			return undefined;
		}
		return result.camera;
	}

	public getCameraCFrame(sideIndex: 0 | 1): CFrame | undefined {
		return this.getCameraAnchorPart(sideIndex)?.CFrame;
	}
}
