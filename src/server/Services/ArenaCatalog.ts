// Descoberta e validação do catálogo universal de templates, marcadores físicos de implantação e seleção aleatória (L1.6).
import {
	ARENA_BASES_CONTAINER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_REQUIRED_ANCHOR_NAMES,
	ARENA_REQUIRED_TEAM_FOLDERS,
	ARENA_SLOT_ID_ATTRIBUTE,
	ARENA_SLOT_MIN_SEPARATION_STUDS,
	ARENA_SLOTS_FOLDER_NAME,
	ARENA_TEMPLATES_FOLDER_NAME,
	isValidArenaId,
} from "../../shared/Config";

export interface ArenaTemplateRecord {
	readonly arenaId: string;
	readonly template: Model;
}

export interface ArenaSlotRecord {
	readonly slotId: string;
	readonly marker: BasePart | Attachment;
}

export interface ArenaTemplateDiscoveryResult {
	readonly byId: Map<string, ArenaTemplateRecord>;
	readonly order: ArenaTemplateRecord[];
}

export interface ArenaSlotDiscoveryResult {
	readonly byId: Map<string, ArenaSlotRecord>;
	readonly order: ArenaSlotRecord[];
}

interface SlotCandidate {
	readonly slotId: string;
	readonly marker: BasePart | Attachment;
	readonly cframe: CFrame;
}

export function findDirectChildrenByName(parent: Instance, name: string): Instance[] {
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

export function validateArenaStructure(model: Model): readonly string[] {
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

function isFiniteNumber(value: number): boolean {
	return value === value && math.abs(value) < math.huge;
}

function isFiniteCFrame(cf: CFrame): boolean {
	const p = cf.Position;
	const look = cf.LookVector;
	const up = cf.UpVector;
	return (
		isFiniteNumber(p.X) &&
		isFiniteNumber(p.Y) &&
		isFiniteNumber(p.Z) &&
		isFiniteNumber(look.X) &&
		isFiniteNumber(look.Y) &&
		isFiniteNumber(look.Z) &&
		isFiniteNumber(up.X) &&
		isFiniteNumber(up.Y) &&
		isFiniteNumber(up.Z)
	);
}

/** Resolve o CFrame físico de um marcador de implantação (`BasePart` ou `Attachment` sob `BasePart`). */
export function resolveSlotCFrame(marker: BasePart | Attachment): CFrame | undefined {
	if (marker.Parent === undefined) return undefined;
	let cf: CFrame;
	if (marker.IsA("Attachment")) {
		if (!marker.Parent.IsA("BasePart")) return undefined;
		cf = marker.WorldCFrame;
	} else {
		cf = marker.CFrame;
	}
	return isFiniteCFrame(cf) ? cf : undefined;
}

function collectTemplateModels(
	parent: Instance,
	output: Model[],
	onDiagnostic: (message: string) => void,
): void {
	for (const child of parent.GetChildren()) {
		if (child.IsA("Model")) {
			output.push(child);
		} else if (child.IsA("Folder")) {
			collectTemplateModels(child, output, onDiagnostic);
		} else {
			onDiagnostic(
				`[ArenaRegistry] Item ignorado em "${parent.GetFullName()}": "${child.Name}" é ${child.ClassName}, esperado Model ou Folder.`,
			);
		}
	}
}

/**
 * Descobre e valida automaticamente todos os templates de `ServerStorage/ArenaTemplates`.
 * Catálogo universal: `ArenaType` não é requisito de elegibilidade e `Model.Name` não define tipo nem ID.
 */
export function discoverArenaTemplates(
	container: Instance | undefined,
	onDiagnostic: (message: string) => void,
): ArenaTemplateDiscoveryResult {
	const byId = new Map<string, ArenaTemplateRecord>();
	const order: ArenaTemplateRecord[] = [];
	if (container === undefined) {
		onDiagnostic(
			`[ArenaRegistry] Container "${ARENA_TEMPLATES_FOLDER_NAME}" não encontrado em ServerStorage; nenhuma arena registrada.`,
		);
		return { byId, order };
	}

	const candidates: Model[] = [];
	collectTemplateModels(container, candidates, onDiagnostic);

	const groupedById = new Map<string, Model[]>();
	const idOrder: string[] = [];

	for (const candidate of candidates) {
		const rawId = candidate.GetAttribute(ARENA_ID_ATTRIBUTE);
		if (!isValidArenaId(rawId)) {
			onDiagnostic(
				`[ArenaRegistry] Template "${candidate.GetFullName()}" rejeitado: atributo ${ARENA_ID_ATTRIBUTE} inválido (${tostring(rawId)}).`,
			);
			continue;
		}
		if (!candidate.Archivable) {
			onDiagnostic(
				`[ArenaRegistry] Template "${candidate.GetFullName()}" (${rawId}) rejeitado: Archivable = false.`,
			);
			continue;
		}
		const structureErrors = validateArenaStructure(candidate);
		if (structureErrors.size() > 0) {
			onDiagnostic(
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
		entries.push(candidate);
	}

	for (const arenaId of idOrder) {
		const entries = groupedById.get(arenaId);
		if (entries === undefined || entries.size() === 0) continue;
		if (entries.size() > 1) {
			const paths = entries.map((model) => model.GetFullName()).join(", ");
			onDiagnostic(
				`[ArenaRegistry] ${ARENA_ID_ATTRIBUTE} duplicado "${arenaId}" rejeitado (${entries.size()} templates: ${paths}).`,
			);
			continue;
		}
		const record: ArenaTemplateRecord = { arenaId, template: entries[0] };
		byId.set(arenaId, record);
		order.push(record);
	}

	return { byId, order };
}

function resolveSlotIdForMarker(
	marker: BasePart | Attachment,
	relativePath: string,
	onDiagnostic: (message: string) => void,
): string | undefined {
	const rawAttr = marker.GetAttribute(ARENA_SLOT_ID_ATTRIBUTE);
	if (rawAttr !== undefined) {
		if (!isValidArenaId(rawAttr)) {
			onDiagnostic(
				`[ArenaRegistry] Marcador "${marker.GetFullName()}" rejeitado: atributo ${ARENA_SLOT_ID_ATTRIBUTE} inválido (${tostring(rawAttr)}).`,
			);
			return undefined;
		}
		return rawAttr;
	}
	return relativePath;
}

function collectSlotMarkers(
	parent: Instance,
	prefix: string,
	output: { readonly marker: BasePart | Attachment; readonly relativePath: string }[],
	onDiagnostic: (message: string) => void,
): void {
	for (const child of parent.GetChildren()) {
		const childPath = prefix.size() > 0 ? `${prefix}/${child.Name}` : child.Name;
		if (child.IsA("Folder")) {
			collectSlotMarkers(child, childPath, output, onDiagnostic);
		} else if (child.IsA("BasePart")) {
			const attachments: Attachment[] = [];
			for (const grandChild of child.GetChildren()) {
				if (grandChild.IsA("Attachment")) {
					attachments.push(grandChild);
				}
			}
			if (attachments.size() > 0) {
				for (const attachment of attachments) {
					output.push({ marker: attachment, relativePath: `${childPath}/${attachment.Name}` });
				}
			} else {
				output.push({ marker: child, relativePath: childPath });
			}
		} else if (child.IsA("Attachment")) {
			onDiagnostic(
				`[ArenaRegistry] Marcador Attachment "${child.GetFullName()}" rejeitado: Attachment precisa estar dentro de um BasePart.`,
			);
		} else {
			onDiagnostic(
				`[ArenaRegistry] Item ignorado em "${parent.GetFullName()}": "${child.Name}" é ${child.ClassName}, esperado BasePart ou Folder.`,
			);
		}
	}
}

/**
 * Descobre marcadores físicos de implantação configurados em `Workspace/ArenaSlots`.
 * Suporta `BasePart`s diretos (ou em subpastas) e `Attachment`s dentro de um `BasePart` suporte.
 * Nunca inventa posições nem coordenadas absolutas quando o container ou os marcadores estão ausentes.
 */
export function discoverArenaSlots(
	container: Instance | undefined,
	onDiagnostic: (message: string) => void,
): ArenaSlotDiscoveryResult {
	const byId = new Map<string, ArenaSlotRecord>();
	const order: ArenaSlotRecord[] = [];
	if (container === undefined) {
		onDiagnostic(
			`[ArenaRegistry] Container de implantação "${ARENA_SLOTS_FOLDER_NAME}" não encontrado em Workspace; nenhuma posição física de arena registrada.`,
		);
		return { byId, order };
	}

	const rawMarkers: { readonly marker: BasePart | Attachment; readonly relativePath: string }[] = [];
	collectSlotMarkers(container, "", rawMarkers, onDiagnostic);

	const groupedById = new Map<string, SlotCandidate[]>();
	const idOrder: string[] = [];

	for (const item of rawMarkers) {
		const slotId = resolveSlotIdForMarker(item.marker, item.relativePath, onDiagnostic);
		if (slotId === undefined) continue;
		const cframe = resolveSlotCFrame(item.marker);
		if (cframe === undefined) {
			onDiagnostic(
				`[ArenaRegistry] Marcador "${item.marker.GetFullName()}" (${slotId}) rejeitado: CFrame inválido ou não finito.`,
			);
			continue;
		}
		let entries = groupedById.get(slotId);
		if (entries === undefined) {
			entries = [];
			groupedById.set(slotId, entries);
			idOrder.push(slotId);
		}
		entries.push({ slotId, marker: item.marker, cframe });
	}

	const acceptedPositions: { readonly slotId: string; readonly position: Vector3 }[] = [];
	for (const slotId of idOrder) {
		const entries = groupedById.get(slotId);
		if (entries === undefined || entries.size() === 0) continue;
		if (entries.size() > 1) {
			const paths = entries.map((entry) => entry.marker.GetFullName()).join(", ");
			onDiagnostic(
				`[ArenaRegistry] Marcador duplicado "${slotId}" rejeitado (${entries.size()} marcadores: ${paths}).`,
			);
			continue;
		}
		const only = entries[0];
		let coincidentWith: string | undefined;
		for (const accepted of acceptedPositions) {
			if (only.cframe.Position.sub(accepted.position).Magnitude <= ARENA_SLOT_MIN_SEPARATION_STUDS) {
				coincidentWith = accepted.slotId;
				break;
			}
		}
		if (coincidentWith !== undefined) {
			onDiagnostic(
				`[ArenaRegistry] Marcador "${only.marker.GetFullName()}" (${slotId}) rejeitado: coincide fisicamente com o slot "${coincidentWith}".`,
			);
			continue;
		}

		acceptedPositions.push({ slotId, position: only.cframe.Position });
		const record: ArenaSlotRecord = { slotId, marker: only.marker };
		byId.set(slotId, record);
		order.push(record);
	}

	if (order.size() === 0) {
		onDiagnostic(
			`[ArenaRegistry] Nenhum marcador físico válido encontrado em "${container.GetFullName()}".`,
		);
	}

	return { byId, order };
}

/**
 * Seleciona aleatoriamente um template válido no servidor, evitando repetir imediatamente
 * os `ArenaId`s em `avoidArenaIds` sempre que houver ao menos uma outra opção válida.
 * Quando resta apenas um template (ou todos estão em `avoidArenaIds`), seleciona do catálogo completo.
 */
export function selectArenaTemplate(
	templates: readonly ArenaTemplateRecord[],
	avoidArenaIds: ReadonlySet<string>,
	rng: () => number,
): ArenaTemplateRecord | undefined {
	const live: ArenaTemplateRecord[] = [];
	for (const record of templates) {
		if (record.template.Parent !== undefined && record.template.Archivable) {
			live.push(record);
		}
	}
	if (live.size() === 0) return undefined;
	if (live.size() === 1) return live[0];

	const preferred: ArenaTemplateRecord[] = [];
	for (const record of live) {
		if (!avoidArenaIds.has(record.arenaId)) {
			preferred.push(record);
		}
	}
	const pool = preferred.size() > 0 ? preferred : live;
	const raw = rng();
	const clamped = raw !== raw || raw < 0 ? 0 : raw >= 1 ? 0.999999999 : raw;
	const index = math.floor(clamped * pool.size());
	return pool[index];
}
