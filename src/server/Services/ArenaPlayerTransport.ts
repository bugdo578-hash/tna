// Transporte físico autoritativo dos jogadores para as gaiolas da arena reservada e restauração segura (L3).
import { Players } from "@rbxts/services";
import {
	ARENA_BASES_CONTAINER_NAME, ARENA_INSTANCE_ID_ATTRIBUTE, ARENA_PLAYER_CAGE_FOLDER_NAME,
	ARENA_PLAYER_CAGE_MAX_DRIFT_STUDS, ARENA_PLAYER_SPAWN_NAMES,
} from "../../shared/Config";
import type { ArenaReservation } from "./ArenaRegistry";

export type ArenaPhysicalSide = "A" | "B";
export type ArenaPlayerTransportFailureReason =
	| "session_cancelled" | "missing_arena" | "missing_arena_bases" | "missing_cage_folder"
	| "missing_spawn_point" | "duplicate_spawn_point" | "invalid_spawn_point"
	| "invalid_player" | "invalid_character" | "invalid_humanoid" | "invalid_root_part" | "teleport_failed";

export interface ArenaTransportParticipantRequest {
	readonly player: Player;
	readonly physicalSideIndex: 0 | 1;
}

export interface ArenaParticipantTransportSnapshot {
	readonly player: Player;
	readonly sessionId: string;
	readonly arenaInstanceId: string;
	readonly physicalSide: ArenaPhysicalSide;
	readonly physicalSideIndex: 0 | 1;
	readonly originalCFrame: CFrame;
	readonly spawnCFrame: CFrame;
	readonly characterInvalidated: boolean;
	readonly restored: boolean;
	readonly restoreCount: number;
}

export interface ArenaSessionTransportResult {
	readonly ok: boolean;
	readonly sessionId: string;
	readonly generation: number;
	readonly reason?: ArenaPlayerTransportFailureReason;
	readonly cageMissing: boolean;
	readonly rolledBack: boolean;
	readonly diagnostics: readonly string[];
	readonly participants: readonly ArenaParticipantTransportSnapshot[];
}

export interface ArenaPlayerTransportOptions {
	readonly maxDriftStuds?: number;
	readonly warnOnMissingCageFolder?: boolean;
	readonly warnFn?: (message: string) => void;
	readonly onParticipantTeleported?: (player: Player, physicalSideIndex: 0 | 1, targetCFrame: CFrame) => void;
	readonly onParticipantRestored?: (player: Player, restoredCFrame: CFrame, arenaStillMounted: boolean) => void;
}

interface SavedHumanoidMovement {
	readonly walkSpeed: number;
	readonly jumpPower: number;
	readonly jumpHeight: number;
	readonly useJumpPower: boolean;
}

interface InternalParticipantTransportRecord {
	readonly player: Player;
	readonly sessionId: string;
	readonly generation: number;
	readonly arenaInstanceId: string;
	readonly arenaInstance: Model;
	readonly physicalSide: ArenaPhysicalSide;
	readonly physicalSideIndex: 0 | 1;
	readonly character: Model;
	readonly hadCharacterParent: boolean;
	readonly humanoid: Humanoid;
	readonly rootPart: BasePart;
	readonly originalCFrame: CFrame;
	readonly originalAnchored: boolean;
	readonly originArenaInstance?: Model;
	readonly spawnMarker: BasePart | Attachment;
	readonly spawnCFrame: CFrame;
	readonly savedMovement?: SavedHumanoidMovement;
	readonly disconnectors: (() => void)[];
	characterInvalidated: boolean;
	restored: boolean;
	restoreCount: number;
}

interface InternalSessionTransportRecord {
	readonly sessionId: string;
	readonly generation: number;
	readonly arenaInstanceId: string;
	readonly arenaInstance: Model;
	readonly participants: InternalParticipantTransportRecord[];
	readonly disconnectors: (() => void)[];
	restored: boolean;
}

export interface ResolvedCageSpawnPoint {
	readonly ok: boolean;
	readonly marker?: BasePart | Attachment;
	readonly cframe?: CFrame;
	readonly reason?: ArenaPlayerTransportFailureReason;
	readonly diagnostics: readonly string[];
}

function isFiniteNumber(v: number): boolean { return v === v && math.abs(v) < math.huge; }
function isFiniteCFrame(cf: CFrame): boolean {
	const p = cf.Position;
	const look = cf.LookVector;
	const up = cf.UpVector;
	return (
		isFiniteNumber(p.X) && isFiniteNumber(p.Y) && isFiniteNumber(p.Z) &&
		isFiniteNumber(look.X) && isFiniteNumber(look.Y) && isFiniteNumber(look.Z) &&
		isFiniteNumber(up.X) && isFiniteNumber(up.Y) && isFiniteNumber(up.Z)
	);
}

function findDirectChildrenByName(parent: Instance, name: string): Instance[] {
	const matches: Instance[] = [];
	for (const child of parent.GetChildren()) if (child.Name === name) matches.push(child);
	return matches;
}

export function resolveMarkerWorldCFrame(marker: BasePart | Attachment): CFrame | undefined {
	if (marker.Parent === undefined) return undefined;
	if (marker.IsA("Attachment")) {
		if (!marker.Parent.IsA("BasePart")) return undefined;
		const cf = marker.WorldCFrame;
		return isFiniteCFrame(cf) ? cf : undefined;
	}
	const cf = marker.CFrame;
	return isFiniteCFrame(cf) ? cf : undefined;
}

/**
 * Resolve de forma inequívoca `PlayerSpawn_A` (Time A) ou `PlayerSpawn_B` (Time B)
 * dentro de `Arena_bases/Gaiola dos players`. Suporta `BasePart` direto na pasta ou
 * `Attachment` sob um `BasePart` filho (como `SpawnLocation`). Nunca usa índice de `GetChildren()`.
 */
export function resolveCageSpawnPoint(cageFolder: Instance, physicalSideIndex: 0 | 1): ResolvedCageSpawnPoint {
	const spawnName = ARENA_PLAYER_SPAWN_NAMES[physicalSideIndex];
	const candidates: Instance[] = [];
	for (const child of cageFolder.GetChildren()) {
		if (child.Name === spawnName) candidates.push(child);
		if (child.IsA("BasePart")) {
			for (const grandChild of child.GetChildren()) if (grandChild.Name === spawnName) candidates.push(grandChild);
		}
	}
	if (candidates.size() === 0) {
		return { ok: false, reason: "missing_spawn_point", diagnostics: [`[ArenaPlayerTransport] Ponto de destino "${spawnName}" ausente em "${cageFolder.GetFullName()}".`] };
	}
	if (candidates.size() > 1) {
		return { ok: false, reason: "duplicate_spawn_point", diagnostics: [`[ArenaPlayerTransport] Ponto de destino "${spawnName}" duplicado/ambíguo (${candidates.size()}x) em "${cageFolder.GetFullName()}".`] };
	}
	const candidate = candidates[0];
	const isDirectPart = candidate.IsA("BasePart") && candidate.Parent === cageFolder;
	const isChildAttachment = candidate.IsA("Attachment") && candidate.Parent !== undefined && candidate.Parent.IsA("BasePart") && candidate.Parent.Parent === cageFolder;
	if (isDirectPart || isChildAttachment) {
		const marker = candidate as BasePart | Attachment;
		const cframe = resolveMarkerWorldCFrame(marker);
		if (cframe === undefined) {
			return { ok: false, reason: "invalid_spawn_point", diagnostics: [`[ArenaPlayerTransport] Ponto de destino "${candidate.GetFullName()}" possui CFrame inválido.`] };
		}
		return { ok: true, marker, cframe, diagnostics: [] };
	}
	return { ok: false, reason: "invalid_spawn_point", diagnostics: [`[ArenaPlayerTransport] Ponto de destino "${candidate.GetFullName()}" é ${candidate.ClassName}, esperado BasePart ou Attachment sob BasePart.`] };
}

function resolveArenaCageContainer(arenaInstance: Model | undefined, expectedInstanceId: string) {
	if (arenaInstance === undefined || !arenaInstance.IsA("Model") || arenaInstance.Parent === undefined) {
		return { ok: false, reason: "missing_arena" as const, cageMissing: false, diagnostics: [`[ArenaPlayerTransport] Instância de arena "${expectedInstanceId}" ausente ou já destruída.`] };
	}
	const attrId = arenaInstance.GetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE);
	if ((attrId !== undefined && attrId !== expectedInstanceId) || (attrId === undefined && arenaInstance.Name !== expectedInstanceId)) {
		return { ok: false, reason: "missing_arena" as const, cageMissing: false, diagnostics: [`[ArenaPlayerTransport] Divergência de ArenaInstanceId em "${arenaInstance.GetFullName()}": esperado "${expectedInstanceId}".`] };
	}
	const basesMatches = findDirectChildrenByName(arenaInstance, ARENA_BASES_CONTAINER_NAME);
	if (basesMatches.size() !== 1) {
		return { ok: false, reason: "missing_arena_bases" as const, cageMissing: false, diagnostics: [`[ArenaPlayerTransport] Container "${ARENA_BASES_CONTAINER_NAME}" ausente ou duplicado (${basesMatches.size()}x) em "${arenaInstance.GetFullName()}".`] };
	}
	const cageMatches = findDirectChildrenByName(basesMatches[0], ARENA_PLAYER_CAGE_FOLDER_NAME);
	if (cageMatches.size() === 0) {
		return { ok: false, reason: "missing_cage_folder" as const, cageMissing: true, diagnostics: [`[ArenaPlayerTransport] Pasta "${ARENA_PLAYER_CAGE_FOLDER_NAME}" ausente em "${basesMatches[0].GetFullName()}".`] };
	}
	if (cageMatches.size() > 1) {
		return { ok: false, reason: "missing_cage_folder" as const, cageMissing: false, diagnostics: [`[ArenaPlayerTransport] Pasta "${ARENA_PLAYER_CAGE_FOLDER_NAME}" duplicada (${cageMatches.size()}x) em "${basesMatches[0].GetFullName()}".`] };
	}
	return { ok: true, cageFolder: cageMatches[0], cageMissing: false, diagnostics: [] as readonly string[] };
}

function toSnapshot(r: InternalParticipantTransportRecord): ArenaParticipantTransportSnapshot {
	return {
		player: r.player, sessionId: r.sessionId, arenaInstanceId: r.arenaInstanceId,
		physicalSide: r.physicalSide, physicalSideIndex: r.physicalSideIndex,
		originalCFrame: r.originalCFrame, spawnCFrame: r.spawnCFrame,
		characterInvalidated: r.characterInvalidated, restored: r.restored, restoreCount: r.restoreCount,
	};
}

export class ArenaPlayerTransportService {
	private readonly activeBySessionId = new Map<string, InternalSessionTransportRecord>();
	private readonly activeByPlayer = new Map<Player, InternalParticipantTransportRecord>();
	private readonly maxDriftStuds: number;
	private readonly warnOnMissingCageFolder: boolean;
	private readonly warnFn: (message: string) => void;
	private readonly onParticipantTeleported?: (player: Player, physicalSideIndex: 0 | 1, targetCFrame: CFrame) => void;
	private readonly onParticipantRestored?: (player: Player, restoredCFrame: CFrame, arenaStillMounted: boolean) => void;
	private nextGeneration = 0;
	private totalRestores = 0;
	private lastDiagnostics: readonly string[] = [];

	public constructor(options: ArenaPlayerTransportOptions = {}) {
		this.maxDriftStuds = options.maxDriftStuds ?? ARENA_PLAYER_CAGE_MAX_DRIFT_STUDS;
		this.warnOnMissingCageFolder = options.warnOnMissingCageFolder ?? false;
		this.warnFn = options.warnFn ?? ((message) => warn(message));
		this.onParticipantTeleported = options.onParticipantTeleported;
		this.onParticipantRestored = options.onParticipantRestored;
	}

	public transportSessionParticipants(
		sessionId: string,
		reservation: ArenaReservation,
		participants: readonly ArenaTransportParticipantRequest[],
		shouldContinue?: () => boolean,
	): ArenaSessionTransportResult {
		this.nextGeneration += 1;
		const generation = this.nextGeneration;

		if (shouldContinue !== undefined && !shouldContinue()) {
			const diagnostics = [`[ArenaPlayerTransport] Sessão "${sessionId}" encerrada antes de iniciar o transporte.`];
			this.lastDiagnostics = diagnostics;
			return { ok: false, sessionId, generation, reason: "session_cancelled", cageMissing: false, rolledBack: false, diagnostics, participants: [] };
		}

		if (this.activeBySessionId.has(sessionId)) this.restoreSession(sessionId);

		const cageContainer = resolveArenaCageContainer(reservation?.instance, reservation?.instanceId ?? "");
		if (!cageContainer.ok || cageContainer.cageFolder === undefined) {
			this.lastDiagnostics = cageContainer.diagnostics;
			if (!cageContainer.cageMissing || this.warnOnMissingCageFolder) {
				for (const msg of cageContainer.diagnostics) this.warnFn(msg);
			}
			return { ok: false, sessionId, generation, reason: cageContainer.reason, cageMissing: cageContainer.cageMissing, rolledBack: false, diagnostics: cageContainer.diagnostics, participants: [] };
		}

		const cageFolder = cageContainer.cageFolder;
		const transported: InternalParticipantTransportRecord[] = [];
		const failAndRollback = (reason: ArenaPlayerTransportFailureReason, diagnostics: readonly string[]): ArenaSessionTransportResult => {
			const hadTransported = transported.size() > 0;
			for (let i = transported.size() - 1; i >= 0; i--) this.restoreParticipantRecord(transported[i]);
			this.lastDiagnostics = diagnostics;
			for (const msg of diagnostics) this.warnFn(msg);
			return { ok: false, sessionId, generation, reason, cageMissing: false, rolledBack: hadTransported, diagnostics, participants: [] };
		};

		for (const req of participants) {
			if (shouldContinue !== undefined && !shouldContinue()) {
				return failAndRollback("session_cancelled", [`[ArenaPlayerTransport] Sessão "${sessionId}" encerrada antes de concluir o transporte.`]);
			}
			const existingRecord = this.activeByPlayer.get(req.player);
			if (existingRecord !== undefined) this.restoreSession(existingRecord.sessionId, existingRecord.generation);

			const player = req.player;
			if (player === undefined || player.Parent !== Players) {
				return failAndRollback("invalid_player", [`[ArenaPlayerTransport] Jogador inválido ou desconectado na sessão "${sessionId}".`]);
			}
			const character = player.Character;
			if (character === undefined || !character.IsA("Model")) {
				return failAndRollback("invalid_character", [`[ArenaPlayerTransport] Character ausente ou inválido para "${player.Name}" na sessão "${sessionId}".`]);
			}
			const humanoid = character.FindFirstChildOfClass("Humanoid");
			if (humanoid === undefined || humanoid.Parent !== character || humanoid.Health <= 0) {
				return failAndRollback("invalid_humanoid", [`[ArenaPlayerTransport] Humanoid ausente ou sem vida para "${player.Name}" na sessão "${sessionId}".`]);
			}
			const rootPart = character.FindFirstChild("HumanoidRootPart");
			if (rootPart === undefined || !rootPart.IsA("BasePart") || rootPart.Parent !== character || !isFiniteCFrame(rootPart.CFrame)) {
				return failAndRollback("invalid_root_part", [`[ArenaPlayerTransport] HumanoidRootPart ausente ou inválido para "${player.Name}" na sessão "${sessionId}".`]);
			}

			const spawnRes = resolveCageSpawnPoint(cageFolder, req.physicalSideIndex);
			if (!spawnRes.ok || spawnRes.marker === undefined || spawnRes.cframe === undefined) {
				return failAndRollback(spawnRes.reason ?? "invalid_spawn_point", spawnRes.diagnostics);
			}

			const originalCFrame = rootPart.CFrame;
			const originalAnchored = rootPart.Anchored;
			const originArenaInstance = this.detectContainingArena(character, originalCFrame.Position, reservation.instance);
			const savedMovement: SavedHumanoidMovement | undefined =
				humanoid.WalkSpeed !== 0 || humanoid.JumpPower !== 0 || humanoid.JumpHeight !== 0
					? { walkSpeed: humanoid.WalkSpeed, jumpPower: humanoid.JumpPower, jumpHeight: humanoid.JumpHeight, useJumpPower: humanoid.UseJumpPower }
					: undefined;

			const record: InternalParticipantTransportRecord = {
				player, sessionId, generation,
				arenaInstanceId: reservation.instanceId, arenaInstance: reservation.instance,
				physicalSide: req.physicalSideIndex === 0 ? "A" : "B", physicalSideIndex: req.physicalSideIndex,
				character, hadCharacterParent: character.Parent !== undefined, humanoid, rootPart, originalCFrame, originalAnchored, originArenaInstance,
				spawnMarker: spawnRes.marker, spawnCFrame: spawnRes.cframe, savedMovement,
				disconnectors: [], characterInvalidated: false, restored: false, restoreCount: 0,
			};

			this.bindParticipantLifecycle(record);
			transported.push(record);
			this.activeByPlayer.set(player, record);

			const [moveOk, moveErr] = pcall(() => {
				this.applyCharacterCFrame(character, rootPart, spawnRes.cframe!);
				if (savedMovement !== undefined) {
					humanoid.WalkSpeed = 0;
					humanoid.JumpPower = 0;
					humanoid.JumpHeight = 0;
				}
				this.onParticipantTeleported?.(player, req.physicalSideIndex, spawnRes.cframe!);
			});
			if (!moveOk) {
				return failAndRollback("teleport_failed", [`[ArenaPlayerTransport] Falha ao transportar "${player.Name}" em "${sessionId}": ${tostring(moveErr)}`]);
			}
			if (shouldContinue !== undefined && !shouldContinue()) {
				return failAndRollback("session_cancelled", [`[ArenaPlayerTransport] Sessão "${sessionId}" encerrada durante transporte de "${player.Name}".`]);
			}
		}

		const sessionRecord: InternalSessionTransportRecord = {
			sessionId, generation, arenaInstanceId: reservation.instanceId, arenaInstance: reservation.instance,
			participants: transported, disconnectors: [], restored: false,
		};

		const [ancestryOk, ancestryConn] = pcall(() =>
			reservation.instance.AncestryChanged.Connect((_, newParent) => {
				if (newParent === undefined && !sessionRecord.restored) this.restoreSession(sessionId, generation);
			}),
		);
		if (ancestryOk && ancestryConn !== undefined) sessionRecord.disconnectors.push(() => ancestryConn.Disconnect());

		this.activeBySessionId.set(sessionId, sessionRecord);
		this.lastDiagnostics = [];
		return { ok: true, sessionId, generation, cageMissing: false, rolledBack: false, diagnostics: [], participants: transported.map((item) => toSnapshot(item)) };
	}

	public enforceContainment(sessionId?: string): void {
		if (sessionId !== undefined) {
			const sessionRecord = this.activeBySessionId.get(sessionId);
			if (sessionRecord !== undefined) this.enforceSessionContainment(sessionRecord);
			return;
		}
		for (const [, sessionRecord] of this.activeBySessionId) this.enforceSessionContainment(sessionRecord);
	}

	public restoreSession(sessionId: string, expectedGeneration?: number): boolean {
		const sessionRecord = this.activeBySessionId.get(sessionId);
		if (sessionRecord === undefined || sessionRecord.restored) return false;
		if (expectedGeneration !== undefined && sessionRecord.generation !== expectedGeneration) return false;
		sessionRecord.restored = true;
		this.activeBySessionId.delete(sessionId);
		for (const disconnect of sessionRecord.disconnectors) pcall(disconnect);
		sessionRecord.disconnectors.clear();
		for (const participantRecord of sessionRecord.participants) this.restoreParticipantRecord(participantRecord);
		return true;
	}

	public forgetPlayer(player: Player): void {
		const record = this.activeByPlayer.get(player);
		if (record === undefined) return;
		record.characterInvalidated = true;
		record.restored = true;
		this.activeByPlayer.delete(player);
		for (const disconnect of record.disconnectors) pcall(disconnect);
		record.disconnectors.clear();
	}

	public getActiveParticipantSnapshot(player: Player): ArenaParticipantTransportSnapshot | undefined {
		const record = this.activeByPlayer.get(player);
		return record !== undefined && !record.restored ? toSnapshot(record) : undefined;
	}
	public getSessionParticipantSnapshots(sessionId: string): readonly ArenaParticipantTransportSnapshot[] {
		const sessionRecord = this.activeBySessionId.get(sessionId);
		return sessionRecord === undefined || sessionRecord.restored ? [] : sessionRecord.participants.map((item) => toSnapshot(item));
	}
	public hasActiveSessionTransport(sessionId: string): boolean {
		const record = this.activeBySessionId.get(sessionId);
		return record !== undefined && !record.restored;
	}
	public getTotalRestoreCount(): number { return this.totalRestores; }
	public getLastDiagnostics(): readonly string[] { return this.lastDiagnostics; }

	private enforceSessionContainment(sessionRecord: InternalSessionTransportRecord): void {
		if (sessionRecord.restored || sessionRecord.arenaInstance.Parent === undefined) return;
		for (const record of sessionRecord.participants) {
			if (record.restored || record.characterInvalidated || this.activeByPlayer.get(record.player) !== record) continue;
			if (
				record.player.Parent !== Players || record.player.Character !== record.character ||
				(record.hadCharacterParent && record.character.Parent === undefined) ||
				record.humanoid.Parent !== record.character || record.humanoid.Health <= 0 || record.rootPart.Parent !== record.character
			) {
				record.characterInvalidated = true;
				continue;
			}
			const liveTargetCFrame = record.spawnMarker.IsDescendantOf(record.arenaInstance)
				? (resolveMarkerWorldCFrame(record.spawnMarker) ?? record.spawnCFrame)
				: record.spawnCFrame;
			if (record.rootPart.Position.sub(liveTargetCFrame.Position).Magnitude > this.maxDriftStuds) {
				pcall(() => this.applyCharacterCFrame(record.character, record.rootPart, liveTargetCFrame));
			}
		}
	}

	private bindParticipantLifecycle(record: InternalParticipantTransportRecord): void {
		const player = record.player;
		const [removingOk, removingConn] = pcall(() =>
			player.CharacterRemoving.Connect((c) => { if (c === undefined || c === record.character) record.characterInvalidated = true; }),
		);
		if (removingOk && removingConn !== undefined) record.disconnectors.push(() => removingConn.Disconnect());
		const maybeCharAdded = (player as unknown as { CharacterAdded?: RBXScriptSignal<(char: Model) => void> }).CharacterAdded;
		if (maybeCharAdded !== undefined) {
			const [addedOk, addedConn] = pcall(() => maybeCharAdded.Connect((c) => { if (c !== record.character) record.characterInvalidated = true; }));
			if (addedOk && addedConn !== undefined) record.disconnectors.push(() => addedConn.Disconnect());
		}
		const [diedOk, diedConn] = pcall(() => record.humanoid.Died.Connect(() => { record.characterInvalidated = true; }));
		if (diedOk && diedConn !== undefined) record.disconnectors.push(() => diedConn.Disconnect());
	}

	private restoreParticipantRecord(record: InternalParticipantTransportRecord): void {
		if (record.restored) return;
		record.restored = true;
		for (const disconnect of record.disconnectors) pcall(disconnect);
		record.disconnectors.clear();

		if (this.activeByPlayer.get(record.player) !== record) return;
		this.activeByPlayer.delete(record.player);

		if (record.player.Parent !== Players || record.characterInvalidated) return;
		if (record.player.Character !== record.character || (record.hadCharacterParent && record.character.Parent === undefined)) return;
		if (record.rootPart.Parent !== record.character) return;
		if (record.humanoid.Parent !== record.character || record.humanoid.Health <= 0) return;
		if (!isFiniteCFrame(record.originalCFrame)) return;

		if (record.originArenaInstance !== undefined && record.originArenaInstance.Parent === undefined) {
			this.warnFn(`[ArenaPlayerTransport] Restauração abortada para "${record.player.Name}": arena de origem já foi destruída.`);
			return;
		}

		const arenaStillMounted = record.arenaInstance.Parent !== undefined;
		const [restoreOk, restoreErr] = pcall(() => {
			record.rootPart.Anchored = record.originalAnchored;
			record.humanoid.PlatformStand = false;
			record.humanoid.Sit = false;
			if (record.savedMovement !== undefined) {
				record.humanoid.WalkSpeed = record.savedMovement.walkSpeed;
				record.humanoid.JumpPower = record.savedMovement.jumpPower;
				record.humanoid.JumpHeight = record.savedMovement.jumpHeight;
				record.humanoid.UseJumpPower = record.savedMovement.useJumpPower;
			}
			this.applyCharacterCFrame(record.character, record.rootPart, record.originalCFrame);
			record.restoreCount += 1;
			this.totalRestores += 1;
			this.onParticipantRestored?.(record.player, record.originalCFrame, arenaStillMounted);
		});
		if (!restoreOk) {
			this.warnFn(`[ArenaPlayerTransport] Erro ao restaurar "${record.player.Name}" em "${record.sessionId}": ${tostring(restoreErr)}`);
		}
	}

	private applyCharacterCFrame(character: Model, rootPart: BasePart, targetCFrame: CFrame): void {
		pcall(() => {
			rootPart.AssemblyLinearVelocity = Vector3.zero;
			rootPart.AssemblyAngularVelocity = Vector3.zero;
		});
		if (character.PrimaryPart === rootPart) character.PivotTo(targetCFrame);
		rootPart.CFrame = targetCFrame;
	}

	private detectContainingArena(character: Model, position: Vector3, currentArena: Model): Model | undefined {
		const activeFolder = currentArena.Parent;
		if (activeFolder === undefined) return undefined;
		for (const sibling of activeFolder.GetChildren()) {
			if (sibling === currentArena || !sibling.IsA("Model")) continue;
			if (character.IsDescendantOf(sibling)) return sibling;
			const [ok, boxCf, boxSize] = pcall(() => sibling.GetBoundingBox());
			if (!ok) continue;
			const localPos = boxCf.PointToObjectSpace(position);
			if (math.abs(localPos.X) <= boxSize.X * 0.5 + 2 && math.abs(localPos.Y) <= boxSize.Y * 0.5 + 15 && math.abs(localPos.Z) <= boxSize.Z * 0.5 + 2) {
				return sibling;
			}
		}
		return undefined;
	}
}
