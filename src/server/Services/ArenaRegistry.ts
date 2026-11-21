import { ServerStorage, Workspace } from "@rbxts/services";
import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
	ARENA_SESSION_ID_ATTRIBUTE,
	ARENA_SLOT_ID_ATTRIBUTE,
	ARENA_SLOTS_FOLDER_NAME,
	ARENA_TEMPLATES_FOLDER_NAME,
	type BattleEncounterKind,
} from "../../shared/Config";
import {
	discoverArenaSlots,
	discoverArenaTemplates,
	findDirectChildrenByName,
	resolveSlotCFrame,
	selectArenaTemplate,
	validateArenaStructure,
	type ArenaSlotRecord,
	type ArenaTemplateRecord,
} from "./ArenaCatalog";

export type { ArenaSlotRecord, ArenaTemplateRecord } from "./ArenaCatalog";

export interface ArenaReservation {
	readonly reservationId: string;
	readonly sessionId: string;
	readonly arenaId: string;
	readonly instanceId: string;
	readonly slotId: string;
	readonly instance: Model;
}

export type ArenaReserveFailureReason =
	| "invalid_session"
	| "duplicate_session"
	| "no_arena_available"
	| "no_slot_available"
	| "active_folder_error"
	| "clone_failed";

export interface ArenaReserveOptions {
	readonly participantKeys?: readonly string[];
	readonly avoidArenaIds?: readonly string[];
	readonly rng?: () => number;
}

export interface ArenaReserveResult {
	readonly ok: boolean;
	readonly reservation?: ArenaReservation;
	readonly reason?: ArenaReserveFailureReason;
	readonly detail?: string;
}

export interface ArenaRegistryOptions {
	readonly templatesContainer?: Instance;
	readonly slotsContainer?: Instance;
	readonly activeArenasParent?: Instance;
	readonly activeArenasFolderName?: string;
	readonly rng?: () => number;
	readonly cloneTemplate?: (template: Model) => Model;
	readonly onReleased?: (reservation: ArenaReservation) => void;
	readonly warnFn?: (message: string) => void;
}

interface InternalReservation extends ArenaReservation {
	released: boolean;
	destroyable: boolean;
}

/**
 * Serviço autoritativo de catálogo universal, seleção aleatória sem repetição imediata,
 * reserva atômica de espaço físico (`Workspace/ArenaSlots`), clonagem e liberação
 * de instâncias exclusivas de arenas em `Workspace/ActiveArenas` (L1.6).
 */
export class ArenaRegistry {
	private readonly templatesById = new Map<string, ArenaTemplateRecord>();
	private readonly templatesOrder: ArenaTemplateRecord[] = [];
	private readonly slotsById = new Map<string, ArenaSlotRecord>();
	private readonly slotsOrder: ArenaSlotRecord[] = [];
	private readonly reservedBySessionId = new Map<string, InternalReservation>();
	private readonly reservedByInstanceId = new Map<string, InternalReservation>();
	private readonly reservedBySlotId = new Map<string, InternalReservation>();
	private readonly lastArenaIdByParticipant = new Map<string, string>();
	private readonly templateDiagnostics: string[] = [];
	private readonly slotDiagnostics: string[] = [];

	private readonly templatesContainerOverride?: Instance;
	private readonly slotsContainerOverride?: Instance;
	private readonly activeArenasParent: Instance;
	private readonly activeArenasFolderName: string;
	private readonly rng: () => number;
	private readonly cloneTemplate: (template: Model) => Model;
	private readonly onReleased?: (reservation: ArenaReservation) => void;
	private readonly warnFn: (message: string) => void;

	private activeArenasFolder?: Folder;
	private nextReservationSeq = 0;
	private totalReleases = 0;
	private discovered = false;
	private slotsDiscovered = false;

	public constructor(options: ArenaRegistryOptions = {}) {
		this.templatesContainerOverride = options.templatesContainer;
		this.slotsContainerOverride = options.slotsContainer;
		this.activeArenasParent = options.activeArenasParent ?? Workspace;
		this.activeArenasFolderName = options.activeArenasFolderName ?? ACTIVE_ARENAS_FOLDER_NAME;
		this.rng = options.rng ?? (() => math.random());
		this.cloneTemplate = options.cloneTemplate ?? ((template) => template.Clone());
		this.onReleased = options.onReleased;
		this.warnFn = options.warnFn ?? ((message) => warn(message));
	}

	public start(): void {
		this.discoverTemplates();
		this.discoverSlots();
	}

	/** Descobre e valida templates universais em `ServerStorage/ArenaTemplates` (ou container injetado). */
	public discoverTemplates(): readonly ArenaTemplateRecord[] {
		this.discovered = true;
		this.templatesById.clear();
		this.templatesOrder.clear();
		this.templateDiagnostics.clear();

		const container =
			this.templatesContainerOverride ?? ServerStorage.FindFirstChild(ARENA_TEMPLATES_FOLDER_NAME);
		const discovered = discoverArenaTemplates(container, (message) => {
			this.templateDiagnostics.push(message);
			this.warnFn(message);
		});
		for (const record of discovered.order) {
			this.templatesById.set(record.arenaId, record);
			this.templatesOrder.push(record);
		}
		return this.templatesOrder;
	}

	/** Descobre marcadores físicos de implantação em `Workspace/ArenaSlots` (ou container injetado). */
	public discoverSlots(): readonly ArenaSlotRecord[] {
		this.slotsDiscovered = true;
		this.slotsById.clear();
		this.slotsOrder.clear();
		this.slotDiagnostics.clear();

		const container =
			this.slotsContainerOverride ?? Workspace.FindFirstChild(ARENA_SLOTS_FOLDER_NAME);
		const discovered = discoverArenaSlots(container, (message) => {
			this.slotDiagnostics.push(message);
			this.warnFn(message);
		});
		for (const record of discovered.order) {
			this.slotsById.set(record.slotId, record);
			this.slotsOrder.push(record);
		}
		return this.slotsOrder;
	}

	/**
	 * Seleciona aleatoriamente um template do catálogo universal (evitando repetição imediata dos
	 * participantes quando houver outra opção), reserva atomicamente um espaço físico livre e cria
	 * um clone exclusivo para `sessionId` em `Workspace/ActiveArenas`.
	 */
	public reserveForSession(
		sessionId: string,
		_battleKind: BattleEncounterKind = "PVE",
		options: ArenaReserveOptions = {},
	): ArenaReserveResult {
		if (!this.discovered) this.discoverTemplates();
		if (!this.slotsDiscovered) this.discoverSlots();

		if (!typeIs(sessionId, "string") || sessionId.size() === 0) {
			return { ok: false, reason: "invalid_session", detail: "sessionId vazio ou inválido" };
		}
		if (this.reservedBySessionId.has(sessionId)) {
			return { ok: false, reason: "duplicate_session", detail: `sessão "${sessionId}" já possui arena reservada` };
		}

		const avoidArenaIds = new Set<string>();
		if (options.participantKeys !== undefined) {
			for (const participantKey of options.participantKeys) {
				const previous = this.lastArenaIdByParticipant.get(participantKey);
				if (previous !== undefined) avoidArenaIds.add(previous);
			}
		}
		if (options.avoidArenaIds !== undefined) {
			for (const arenaId of options.avoidArenaIds) avoidArenaIds.add(arenaId);
		}

		const selected = selectArenaTemplate(this.templatesOrder, avoidArenaIds, options.rng ?? this.rng);
		if (selected === undefined) {
			return {
				ok: false,
				reason: "no_arena_available",
				detail: `nenhum template de arena válido disponível para "${sessionId}"`,
			};
		}

		const selectedSlot = this.findAvailableSlot();
		if (selectedSlot === undefined) {
			return {
				ok: false,
				reason: "no_slot_available",
				detail: `capacidade física de arenas esgotada para "${sessionId}"`,
			};
		}

		const activeFolder = this.ensureActiveArenasFolder();
		if (activeFolder === undefined) {
			return {
				ok: false,
				reason: "active_folder_error",
				detail: `não foi possível resolver Folder "${this.activeArenasFolderName}"`,
			};
		}

		this.nextReservationSeq += 1;
		const reservationId = `res-${sessionId}-${this.nextReservationSeq}`;
		const instanceId = `Arena_${sessionId}_${this.nextReservationSeq}`;

		let cloned: Model | undefined;
		const placeholderReservation: InternalReservation = {
			reservationId,
			sessionId,
			arenaId: selected.arenaId,
			instanceId,
			slotId: selectedSlot.slotId,
			instance: selected.template,
			released: false,
			destroyable: false,
		};

		// Reserva atômica de sessão, instância e slot físico antes da clonagem impede dupla alocação.
		this.reservedBySessionId.set(sessionId, placeholderReservation);
		this.reservedByInstanceId.set(instanceId, placeholderReservation);
		this.reservedBySlotId.set(selectedSlot.slotId, placeholderReservation);

		const [cloneOk, cloneError] = pcall(() => {
			const slotCFrame = resolveSlotCFrame(selectedSlot.marker);
			if (slotCFrame === undefined) {
				error(`Marcador físico "${selectedSlot.slotId}" indisponível ou inválido`);
			}

			const result = this.cloneTemplate(selected.template);
			if (result === undefined || !result.IsA("Model") || result === selected.template) {
				error("Clone de template não retornou um Model novo válido");
			}
			cloned = result;

			const cloneErrors = validateArenaStructure(result);
			if (cloneErrors.size() > 0) {
				error(`Clone inválido: ${cloneErrors.join("; ")}`);
			}

			// Move o Model inteiro preservando layout interno, anchors, geometria e VFX.
			result.PivotTo(slotCFrame);
			result.Name = instanceId;
			result.SetAttribute(ARENA_ID_ATTRIBUTE, selected.arenaId);
			result.SetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE, instanceId);
			result.SetAttribute(ARENA_SESSION_ID_ATTRIBUTE, sessionId);
			result.SetAttribute(ARENA_SLOT_ID_ATTRIBUTE, selectedSlot.slotId);
			result.Parent = activeFolder;

			if (result.Parent !== activeFolder) {
				error(`Falha ao mover clone "${instanceId}" para "${activeFolder.GetFullName()}"`);
			}
		});

		if (!cloneOk || cloned === undefined) {
			if (this.reservedBySessionId.get(sessionId) === placeholderReservation) {
				this.reservedBySessionId.delete(sessionId);
			}
			if (this.reservedByInstanceId.get(instanceId) === placeholderReservation) {
				this.reservedByInstanceId.delete(instanceId);
			}
			if (this.reservedBySlotId.get(selectedSlot.slotId) === placeholderReservation) {
				this.reservedBySlotId.delete(selectedSlot.slotId);
			}
			if (cloned !== undefined) {
				pcall(() => cloned?.Destroy());
			}
			const detail = tostring(cloneError);
			this.warnFn(`[ArenaRegistry] rollback da reserva "${instanceId}" (${selected.arenaId}/${selectedSlot.slotId}): ${detail}`);
			return { ok: false, reason: "clone_failed", detail };
		}

		const finalReservation: InternalReservation = {
			reservationId,
			sessionId,
			arenaId: selected.arenaId,
			instanceId,
			slotId: selectedSlot.slotId,
			instance: cloned,
			released: false,
			destroyable: true,
		};
		this.reservedBySessionId.set(sessionId, finalReservation);
		this.reservedByInstanceId.set(instanceId, finalReservation);
		this.reservedBySlotId.set(selectedSlot.slotId, finalReservation);

		if (options.participantKeys !== undefined) {
			for (const participantKey of options.participantKeys) {
				this.lastArenaIdByParticipant.set(participantKey, selected.arenaId);
			}
		}

		return { ok: true, reservation: finalReservation };
	}

	/** Libera a reserva associada à sessão, devolve o slot físico e destrói o clone de forma idempotente. */
	public releaseSession(sessionId: string): boolean {
		const record = this.reservedBySessionId.get(sessionId);
		if (record === undefined) return false;
		return this.releaseInternal(record);
	}

	/** Libera uma reserva específica de forma idempotente (nunca afeta reservas posteriores da mesma arena/slot). */
	public releaseReservation(reservation: ArenaReservation): boolean {
		const record = this.reservedBySessionId.get(reservation.sessionId);
		if (
			record === undefined ||
			record.reservationId !== reservation.reservationId ||
			record.instanceId !== reservation.instanceId
		) {
			return false;
		}
		return this.releaseInternal(record);
	}

	/** Remove o histórico do último ArenaId usado por um participante (ex.: desconexão). */
	public forgetParticipant(participantKey: string): void {
		this.lastArenaIdByParticipant.delete(participantKey);
	}

	public getLastArenaIdForParticipant(participantKey: string): string | undefined {
		return this.lastArenaIdByParticipant.get(participantKey);
	}

	public getRegisteredTemplates(): readonly ArenaTemplateRecord[] {
		if (!this.discovered) this.discoverTemplates();
		return [...this.templatesOrder];
	}

	public getRegisteredSlots(): readonly ArenaSlotRecord[] {
		if (!this.slotsDiscovered) this.discoverSlots();
		return [...this.slotsOrder];
	}

	public getValidationDiagnostics(): readonly string[] {
		if (!this.discovered) this.discoverTemplates();
		if (!this.slotsDiscovered) this.discoverSlots();
		return [...this.templateDiagnostics, ...this.slotDiagnostics];
	}

	public getActiveReservations(): readonly ArenaReservation[] {
		const list: ArenaReservation[] = [];
		for (const [, record] of this.reservedBySessionId) if (!record.released) list.push(record);
		return list;
	}

	public getReservationBySession(sessionId: string): ArenaReservation | undefined {
		const record = this.reservedBySessionId.get(sessionId);
		return record !== undefined && !record.released ? record : undefined;
	}

	public getReservationByInstanceId(instanceId: string): ArenaReservation | undefined {
		const record = this.reservedByInstanceId.get(instanceId);
		return record !== undefined && !record.released ? record : undefined;
	}

	public getAvailableSlotCount(): number {
		if (!this.slotsDiscovered) this.discoverSlots();
		let count = 0;
		for (const slot of this.slotsOrder) {
			if (!this.reservedBySlotId.has(slot.slotId) && resolveSlotCFrame(slot.marker) !== undefined) {
				count += 1;
			}
		}
		return count;
	}

	public getAvailableCount(_battleKind?: BattleEncounterKind): number {
		if (!this.discovered) this.discoverTemplates();
		if (!this.slotsDiscovered) this.discoverSlots();
		let hasLiveTemplate = false;
		for (const record of this.templatesOrder) {
			if (record.template.Parent !== undefined && record.template.Archivable) {
				hasLiveTemplate = true;
				break;
			}
		}
		return hasLiveTemplate ? this.getAvailableSlotCount() : 0;
	}

	public getActiveArenasFolder(): Folder | undefined {
		if (this.activeArenasFolder !== undefined && this.activeArenasFolder.Parent === this.activeArenasParent) {
			return this.activeArenasFolder;
		}
		const existing = this.activeArenasParent.FindFirstChild(this.activeArenasFolderName);
		return existing !== undefined && existing.IsA("Folder") ? existing : undefined;
	}

	public getReleaseCount(): number { return this.totalReleases; }

	public destroy(): void {
		const active: InternalReservation[] = [];
		for (const [, record] of this.reservedBySessionId) active.push(record);
		for (const record of active) this.releaseInternal(record);
		this.reservedBySessionId.clear();
		this.reservedByInstanceId.clear();
		this.reservedBySlotId.clear();
		this.lastArenaIdByParticipant.clear();
	}

	private findAvailableSlot(): ArenaSlotRecord | undefined {
		for (const slot of this.slotsOrder) {
			if (this.reservedBySlotId.has(slot.slotId)) continue;
			if (resolveSlotCFrame(slot.marker) === undefined) continue;
			return slot;
		}
		return undefined;
	}

	private releaseInternal(record: InternalReservation): boolean {
		if (record.released) return false;
		record.released = true;
		if (this.reservedBySessionId.get(record.sessionId) === record) this.reservedBySessionId.delete(record.sessionId);
		if (this.reservedByInstanceId.get(record.instanceId) === record) this.reservedByInstanceId.delete(record.instanceId);
		if (this.reservedBySlotId.get(record.slotId) === record) this.reservedBySlotId.delete(record.slotId);

		// Destrói somente o clone desta sessão; scripts internos de VFX limpam via script.Destroying.
		if (record.destroyable) {
			const [destroyedOk, destroyErr] = pcall(() => { if (record.instance.Parent !== undefined) record.instance.Destroy(); });
			if (!destroyedOk) this.warnFn(`[ArenaRegistry] erro ao destruir clone "${record.instanceId}": ${tostring(destroyErr)}`);
		}

		this.totalReleases += 1;
		if (this.onReleased !== undefined) {
			const [cbOk, cbErr] = pcall(() => this.onReleased?.(record));
			if (!cbOk) this.warnFn(`[ArenaRegistry] erro em callback onReleased "${record.instanceId}": ${tostring(cbErr)}`);
		}
		return true;
	}

	private ensureActiveArenasFolder(): Folder | undefined {
		if (this.activeArenasFolder !== undefined && this.activeArenasFolder.Parent === this.activeArenasParent) {
			return this.activeArenasFolder;
		}
		const matches = findDirectChildrenByName(this.activeArenasParent, this.activeArenasFolderName);
		if (matches.size() > 1) {
			this.warnFn(`[ArenaRegistry] Múltiplas instâncias "${this.activeArenasFolderName}" em "${this.activeArenasParent.GetFullName()}".`);
			return undefined;
		}
		if (matches.size() === 1) {
			const existing = matches[0];
			if (!existing.IsA("Folder")) {
				this.warnFn(`[ArenaRegistry] "${existing.GetFullName()}" é ${existing.ClassName}, esperado Folder.`);
				return undefined;
			}
			this.activeArenasFolder = existing;
			return existing;
		}
		const folder = new Instance("Folder");
		folder.Name = this.activeArenasFolderName;
		folder.Parent = this.activeArenasParent;
		this.activeArenasFolder = folder;
		return folder;
	}
}
