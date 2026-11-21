import { ServerStorage, Workspace } from "@rbxts/services";
import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_BASES_CONTAINER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
	ARENA_REQUIRED_ANCHOR_NAMES,
	ARENA_REQUIRED_TEAM_FOLDERS,
	ARENA_SESSION_ID_ATTRIBUTE,
	ARENA_TEMPLATES_FOLDER_NAME,
	ARENA_TYPE_ATTRIBUTE,
	isValidArenaId,
	isValidArenaType,
	resolveRequiredArenaType,
	type ArenaType,
	type BattleEncounterKind,
} from "../../shared/Config";

export interface ArenaTemplateRecord {
	readonly arenaId: string;
	readonly arenaType: ArenaType;
	readonly template: Model;
}

export interface ArenaReservation {
	readonly reservationId: string;
	readonly sessionId: string;
	readonly arenaId: string;
	readonly arenaType: ArenaType;
	readonly instanceId: string;
	readonly instance: Model;
}

export type ArenaReserveFailureReason =
	| "invalid_session"
	| "duplicate_session"
	| "no_arena_available"
	| "active_folder_error"
	| "clone_failed";

export interface ArenaReserveResult {
	readonly ok: boolean;
	readonly reservation?: ArenaReservation;
	readonly reason?: ArenaReserveFailureReason;
	readonly detail?: string;
}

export interface ArenaRegistryOptions {
	readonly templatesContainer?: Instance;
	readonly activeArenasParent?: Instance;
	readonly activeArenasFolderName?: string;
	readonly cloneTemplate?: (template: Model) => Model;
	readonly onReleased?: (reservation: ArenaReservation) => void;
	readonly warnFn?: (message: string) => void;
}

interface InternalReservation extends ArenaReservation {
	released: boolean;
	destroyable: boolean;
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

function validateUniqueChild(
	parent: Instance,
	name: string,
	kindLabel: string,
	errors: string[],
): Instance | undefined {
	const matches = findDirectChildrenByName(parent, name);
	if (matches.size() === 0) {
		errors.push(`${kindLabel} "${name}" ausente em "${parent.GetFullName()}"`);
		return undefined;
	}
	if (matches.size() > 1) {
		errors.push(`${kindLabel} "${name}" duplicado (${matches.size()}x) em "${parent.GetFullName()}"`);
		return undefined;
	}
	return matches[0];
}

function validateArenaStructure(model: Model): readonly string[] {
	const errors: string[] = [];
	const bases = validateUniqueChild(model, ARENA_BASES_CONTAINER_NAME, "Container", errors);
	if (bases === undefined) return errors;

	for (const sideIndex of [0, 1] as const) {
		const folderName = ARENA_REQUIRED_TEAM_FOLDERS[sideIndex];
		const folder = validateUniqueChild(bases, folderName, "Pasta de equipe", errors);
		if (folder === undefined) continue;

		const names = ARENA_REQUIRED_ANCHOR_NAMES[sideIndex];
		const requiredParts = [names.active, names.waiting[0], names.waiting[1]];
		for (const partName of requiredParts) {
			const child = validateUniqueChild(folder, partName, "Anchor", errors);
			if (child !== undefined && !child.IsA("BasePart")) {
				errors.push(`Anchor "${partName}" em "${folder.GetFullName()}" é ${child.ClassName}, esperado BasePart`);
			}
		}
	}
	return errors;
}

/**
 * Serviço autoritativo de descoberta, validação, reserva, clonagem e liberação
 * de instâncias físicas de arenas em `Workspace/ActiveArenas`.
 */
export class ArenaRegistry {
	private readonly templatesById = new Map<string, ArenaTemplateRecord>();
	private readonly templatesOrder: ArenaTemplateRecord[] = [];
	private readonly reservedByArenaId = new Map<string, InternalReservation>();
	private readonly reservedBySessionId = new Map<string, InternalReservation>();
	private readonly validationDiagnostics: string[] = [];

	private readonly templatesContainerOverride?: Instance;
	private readonly activeArenasParent: Instance;
	private readonly activeArenasFolderName: string;
	private readonly cloneTemplate: (template: Model) => Model;
	private readonly onReleased?: (reservation: ArenaReservation) => void;
	private readonly warnFn: (message: string) => void;

	private activeArenasFolder?: Folder;
	private nextReservationSeq = 0;
	private totalReleases = 0;
	private discovered = false;

	public constructor(options: ArenaRegistryOptions = {}) {
		this.templatesContainerOverride = options.templatesContainer;
		this.activeArenasParent = options.activeArenasParent ?? Workspace;
		this.activeArenasFolderName = options.activeArenasFolderName ?? ACTIVE_ARENAS_FOLDER_NAME;
		this.cloneTemplate = options.cloneTemplate ?? ((template) => template.Clone());
		this.onReleased = options.onReleased;
		this.warnFn = options.warnFn ?? ((message) => warn(message));
	}

	public start(): void {
		this.discoverTemplates();
	}

	/** Descobre e valida templates em `ServerStorage/ArenaTemplates` (ou container injetado). */
	public discoverTemplates(): readonly ArenaTemplateRecord[] {
		this.discovered = true;
		this.templatesById.clear();
		this.templatesOrder.clear();
		this.validationDiagnostics.clear();

		const container =
			this.templatesContainerOverride ?? ServerStorage.FindFirstChild(ARENA_TEMPLATES_FOLDER_NAME);
		if (container === undefined) {
			this.recordDiagnostic(
				`[ArenaRegistry] Container "${ARENA_TEMPLATES_FOLDER_NAME}" não encontrado em ServerStorage; nenhuma arena registrada.`,
			);
			return this.templatesOrder;
		}

		const candidates: Model[] = [];
		this.collectTemplateModels(container, candidates);

		const groupedById = new Map<string, { readonly arenaType: ArenaType; readonly model: Model }[]>();
		const idOrder: string[] = [];

		for (const candidate of candidates) {
			const rawId = candidate.GetAttribute(ARENA_ID_ATTRIBUTE);
			if (!isValidArenaId(rawId)) {
				this.recordDiagnostic(
					`[ArenaRegistry] Template "${candidate.GetFullName()}" rejeitado: atributo ${ARENA_ID_ATTRIBUTE} inválido (${tostring(rawId)}).`,
				);
				continue;
			}

			const rawType = candidate.GetAttribute(ARENA_TYPE_ATTRIBUTE);
			if (!isValidArenaType(rawType)) {
				this.recordDiagnostic(
					`[ArenaRegistry] Template "${candidate.GetFullName()}" (${rawId}) rejeitado: atributo ${ARENA_TYPE_ATTRIBUTE} inválido (${tostring(rawType)}); esperado "PVE" ou "PVP".`,
				);
				continue;
			}

			if (!candidate.Archivable) {
				this.recordDiagnostic(
					`[ArenaRegistry] Template "${candidate.GetFullName()}" (${rawId}) rejeitado: Archivable = false.`,
				);
				continue;
			}

			const structureErrors = validateArenaStructure(candidate);
			if (structureErrors.size() > 0) {
				this.recordDiagnostic(
					`[ArenaRegistry] Template "${candidate.GetFullName()}" (${rawId}) rejeitado: ${structureErrors.join("; ")}.`,
				);
				continue;
			}

			let entries = groupedById.get(rawId);
			if (entries === undefined) {
				entries = [];
				groupedById.set(rawId, entries);
				idOrder.push(rawId);
			}
			entries.push({ arenaType: rawType, model: candidate });
		}

		for (const arenaId of idOrder) {
			const entries = groupedById.get(arenaId);
			if (entries === undefined || entries.size() === 0) continue;
			if (entries.size() > 1) {
				const paths = entries.map((entry) => entry.model.GetFullName()).join(", ");
				this.recordDiagnostic(
					`[ArenaRegistry] ${ARENA_ID_ATTRIBUTE} duplicado "${arenaId}" rejeitado (${entries.size()} templates: ${paths}).`,
				);
				continue;
			}
			const only = entries[0];
			const record: ArenaTemplateRecord = {
				arenaId,
				arenaType: only.arenaType,
				template: only.model,
			};
			this.templatesById.set(arenaId, record);
			this.templatesOrder.push(record);
		}

		return this.templatesOrder;
	}

	/**
	 * Reserva uma arena compatível com `battleKind` (`PVE`/`BOSS` -> `PVE`; `PVP` -> `PVP`),
	 * clona o template para `Workspace/ActiveArenas` e associa a instância ao `sessionId`.
	 */
	public reserveForSession(sessionId: string, battleKind: BattleEncounterKind): ArenaReserveResult {
		if (!this.discovered) {
			this.discoverTemplates();
		}
		if (!typeIs(sessionId, "string") || sessionId.size() === 0) {
			return { ok: false, reason: "invalid_session", detail: "sessionId vazio ou inválido" };
		}
		if (this.reservedBySessionId.has(sessionId)) {
			return { ok: false, reason: "duplicate_session", detail: `sessão "${sessionId}" já possui arena reservada` };
		}

		const requiredType = resolveRequiredArenaType(battleKind);
		let selected: ArenaTemplateRecord | undefined;
		for (const record of this.templatesOrder) {
			if (record.arenaType !== requiredType) continue;
			if (this.reservedByArenaId.has(record.arenaId)) continue;
			if (record.template.Parent === undefined || !record.template.Archivable) continue;
			selected = record;
			break;
		}
		if (selected === undefined) {
			return {
				ok: false,
				reason: "no_arena_available",
				detail: `nenhuma arena ${requiredType} disponível para "${sessionId}"`,
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
			arenaType: selected.arenaType,
			instanceId,
			instance: selected.template,
			released: false,
			destroyable: false,
		};

		// Reserva síncrona antes da clonagem impede dupla alocação na mesma arena/sessão.
		this.reservedByArenaId.set(selected.arenaId, placeholderReservation);
		this.reservedBySessionId.set(sessionId, placeholderReservation);

		const [cloneOk, cloneError] = pcall(() => {
			const result = this.cloneTemplate(selected.template);
			if (result === undefined || !result.IsA("Model")) {
				error("Clone de template não retornou um Model válido");
			}
			cloned = result;

			const cloneErrors = validateArenaStructure(result);
			if (cloneErrors.size() > 0) {
				error(`Clone inválido: ${cloneErrors.join("; ")}`);
			}

			result.Name = instanceId;
			result.SetAttribute(ARENA_ID_ATTRIBUTE, selected.arenaId);
			result.SetAttribute(ARENA_TYPE_ATTRIBUTE, selected.arenaType);
			result.SetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE, instanceId);
			result.SetAttribute(ARENA_SESSION_ID_ATTRIBUTE, sessionId);
			result.Parent = activeFolder;

			if (result.Parent !== activeFolder) {
				error(`Falha ao mover clone "${instanceId}" para "${activeFolder.GetFullName()}"`);
			}
		});

		if (!cloneOk || cloned === undefined) {
			if (this.reservedByArenaId.get(selected.arenaId) === placeholderReservation) {
				this.reservedByArenaId.delete(selected.arenaId);
			}
			if (this.reservedBySessionId.get(sessionId) === placeholderReservation) {
				this.reservedBySessionId.delete(sessionId);
			}
			if (cloned !== undefined) {
				pcall(() => cloned?.Destroy());
			}
			const detail = tostring(cloneError);
			this.warnFn(`[ArenaRegistry] rollback da reserva "${instanceId}" (${selected.arenaId}): ${detail}`);
			return { ok: false, reason: "clone_failed", detail };
		}

		const finalReservation: InternalReservation = {
			reservationId,
			sessionId,
			arenaId: selected.arenaId,
			arenaType: selected.arenaType,
			instanceId,
			instance: cloned,
			released: false,
			destroyable: true,
		};
		this.reservedByArenaId.set(selected.arenaId, finalReservation);
		this.reservedBySessionId.set(sessionId, finalReservation);

		return { ok: true, reservation: finalReservation };
	}

	/** Libera a reserva associada à sessão e destrói o clone de forma idempotente. */
	public releaseSession(sessionId: string): boolean {
		const record = this.reservedBySessionId.get(sessionId);
		if (record === undefined) return false;
		return this.releaseInternal(record);
	}

	/** Libera uma reserva específica de forma idempotente (nunca afeta reservas posteriores da mesma arena). */
	public releaseReservation(reservation: ArenaReservation): boolean {
		const record = this.reservedBySessionId.get(reservation.sessionId);
		if (record === undefined || record.reservationId !== reservation.reservationId) {
			return false;
		}
		return this.releaseInternal(record);
	}

	public getRegisteredTemplates(): readonly ArenaTemplateRecord[] {
		if (!this.discovered) this.discoverTemplates();
		return [...this.templatesOrder];
	}

	public getValidationDiagnostics(): readonly string[] {
		if (!this.discovered) this.discoverTemplates();
		return [...this.validationDiagnostics];
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

	public getAvailableCount(battleKind: BattleEncounterKind): number {
		if (!this.discovered) this.discoverTemplates();
		const requiredType = resolveRequiredArenaType(battleKind);
		let count = 0;
		for (const record of this.templatesOrder) {
			if (record.arenaType === requiredType && !this.reservedByArenaId.has(record.arenaId) &&
				record.template.Parent !== undefined && record.template.Archivable) {
				count += 1;
			}
		}
		return count;
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
		this.reservedByArenaId.clear();
		this.reservedBySessionId.clear();
	}

	private releaseInternal(record: InternalReservation): boolean {
		if (record.released) return false;
		record.released = true;
		if (this.reservedBySessionId.get(record.sessionId) === record) this.reservedBySessionId.delete(record.sessionId);
		if (this.reservedByArenaId.get(record.arenaId) === record) this.reservedByArenaId.delete(record.arenaId);

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

	private collectTemplateModels(parent: Instance, output: Model[]): void {
		for (const child of parent.GetChildren()) {
			if (child.IsA("Model")) output.push(child);
			else if (child.IsA("Folder")) this.collectTemplateModels(child, output);
			else this.recordDiagnostic(`[ArenaRegistry] Item ignorado em "${parent.GetFullName()}": "${child.Name}" é ${child.ClassName}, esperado Model ou Folder.`);
		}
	}

	private recordDiagnostic(message: string): void {
		this.validationDiagnostics.push(message);
		this.warnFn(message);
	}
}
