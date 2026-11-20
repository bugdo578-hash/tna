import { GROUND_CONTACT_ATTACHMENT_NAME, STAND_SUBMODEL_NAME } from "../UI/CombatVisualConfig";

export type GroundContactSource = "attachment" | "visible_body" | "structural_body" | "fallback_invalid";

export interface FighterGroundContact {
	/** Posição do ponto físico de apoio no espaço local do `rootPart` do lutador. */
	readonly offset: Vector3;
	readonly source: GroundContactSource;
	readonly valid: boolean;
	readonly diagnostic?: string;
}

const EXCLUDED_CONTAINER_NAMES = new Set<string>([
	STAND_SUBMODEL_NAME.lower(),
	"star_platinum_luta",
	"animsaves",
	"vfx",
	"fx",
	"effect",
	"effects",
	"particle",
	"particles",
	"aura",
	"accessory",
	"accessories",
	"acessorio",
	"acessorios",
	"hitbox",
	"hitboxes",
	"hurtbox",
	"hurtboxes",
]);

const EXCLUDED_PART_SUBSTRINGS = [
	"hitbox",
	"hurtbox",
	"vfx",
	"particle",
	"aura",
	"collider",
	"trigger",
	"sensor",
	"accessory",
	"acessorio",
	"effect",
];

function isFiniteNumber(value: number): boolean {
	return value === value && value !== math.huge && value !== -math.huge;
}

function isFiniteVector3(vector: Vector3): boolean {
	return isFiniteNumber(vector.X) && isFiniteNumber(vector.Y) && isFiniteNumber(vector.Z);
}

function isFiniteCFrame(cf: CFrame): boolean {
	return (
		isFiniteVector3(cf.Position) &&
		isFiniteVector3(cf.RightVector) &&
		isFiniteVector3(cf.UpVector) &&
		isFiniteVector3(cf.LookVector)
	);
}

function hasValidPartGeometry(part: BasePart): boolean {
	return (
		isFiniteCFrame(part.CFrame) &&
		isFiniteVector3(part.Size) &&
		part.Size.X > 0 &&
		part.Size.Y > 0 &&
		part.Size.Z > 0
	);
}

function isExcludedPartName(name: string): boolean {
	const lower = name.lower();
	for (const token of EXCLUDED_PART_SUBSTRINGS) {
		if (lower.find(token, 1, true)[0] !== undefined) {
			return true;
		}
	}
	return false;
}

function hasParticleEmitterChild(part: BasePart): boolean {
	for (const child of part.GetChildren()) {
		if (
			child.IsA("ParticleEmitter") ||
			child.IsA("Trail") ||
			child.IsA("Beam") ||
			child.IsA("Fire") ||
			child.IsA("Smoke") ||
			child.IsA("Sparkles")
		) {
			return true;
		}
	}
	return false;
}

function isExcludedDescendant(instance: Instance, model: Model, standModel: Model | undefined): boolean {
	let current: Instance | undefined = instance;
	while (current !== undefined && current !== model) {
		if (standModel !== undefined && current === standModel) {
			return true;
		}
		if (current.GetAttribute("IgnoreGroundContact") === true) {
			return true;
		}
		if (current.IsA("Accoutrement") || current.IsA("Tool") || current.IsA("LayerCollector")) {
			return true;
		}
		if ((current.IsA("Model") || current.IsA("Folder")) && EXCLUDED_CONTAINER_NAMES.has(current.Name.lower())) {
			return true;
		}
		if (current.IsA("BasePart") && isExcludedPartName(current.Name)) {
			return true;
		}
		current = current.Parent;
	}
	return false;
}

function findBodyGroundContactAttachments(model: Model, standModel: Model | undefined): Attachment[] {
	const matches: Attachment[] = [];
	for (const descendant of model.GetDescendants()) {
		if (
			descendant.IsA("Attachment") &&
			descendant.Name === GROUND_CONTACT_ATTACHMENT_NAME &&
			!isExcludedDescendant(descendant, model, standModel)
		) {
			matches.push(descendant);
		}
	}
	return matches;
}

/**
 * Calcula a menor coordenada Y local (no referencial de `rootCFrame`) dos 8 vértices
 * da caixa orientada de `part`. Independente do eixo Y global.
 */
function computePartMinLocalY(rootCFrame: CFrame, part: BasePart): number {
	const relCF = rootCFrame.ToObjectSpace(part.CFrame);
	const half = part.Size.mul(0.5);
	const extentY =
		math.abs(relCF.RightVector.Y) * half.X +
		math.abs(relCF.UpVector.Y) * half.Y +
		math.abs(relCF.LookVector.Y) * half.Z;
	return relCF.Position.Y - extentY;
}

/**
 * Resolve o ponto físico de apoio do lutador no espaço local de `rootPart`.
 * 1) Prefere o Attachment opcional `GroundContact` no corpo físico do lutador.
 * 2) Caso ausente (ou inválido/duplicado), calcula o menor ponto físico das partes relevantes
 *    do corpo (ignorando Stand, acessórios, ferramentas, VFX, partículas e hitboxes).
 * 3) Se não houver geometria válida, registra diagnóstico via `warn` e retorna offset nulo.
 */
export function resolveFighterGroundContact(
	model: Model,
	rootPart: BasePart,
	standModel: Model | undefined,
): FighterGroundContact {
	if (!isFiniteCFrame(rootPart.CFrame)) {
		const diagnostic = `[CombatFighterGrounding] rootPart "${rootPart.GetFullName()}" possui CFrame inválido; usando offset nulo.`;
		warn(diagnostic);
		return { offset: Vector3.zero, source: "fallback_invalid", valid: false, diagnostic };
	}

	const rootCFrame = rootPart.CFrame;
	const attachments = findBodyGroundContactAttachments(model, standModel);
	if (attachments.size() === 1) {
		const contactAttachment = attachments[0];
		const worldPos = contactAttachment.WorldPosition;
		if (isFiniteVector3(worldPos)) {
			const localOffset = rootCFrame.PointToObjectSpace(worldPos);
			if (isFiniteVector3(localOffset)) {
				return { offset: localOffset, source: "attachment", valid: true };
			}
		}
		warn(
			`[CombatFighterGrounding] Attachment "${contactAttachment.GetFullName()}" possui posição inválida; recalculando pelas partes do corpo.`,
		);
	} else if (attachments.size() > 1) {
		warn(
			`[CombatFighterGrounding] Encontrados ${attachments.size()} Attachments "${GROUND_CONTACT_ATTACHMENT_NAME}" em "${model.Name}"; recalculando pelas partes do corpo.`,
		);
	}

	let visibleMinY = math.huge;
	let visibleCount = 0;
	let structuralMinY = math.huge;
	let structuralCount = 0;

	for (const descendant of model.GetDescendants()) {
		if (!descendant.IsA("BasePart")) continue;
		if (isExcludedDescendant(descendant, model, standModel)) continue;
		if (!hasValidPartGeometry(descendant)) continue;

		const isInvisible = descendant.Transparency >= 0.99;
		if (isInvisible && hasParticleEmitterChild(descendant)) continue;

		const minLocalY = computePartMinLocalY(rootCFrame, descendant);
		if (!isFiniteNumber(minLocalY)) continue;

		if (!isInvisible) {
			visibleCount += 1;
			if (minLocalY < visibleMinY) {
				visibleMinY = minLocalY;
			}
		}

		structuralCount += 1;
		if (minLocalY < structuralMinY) {
			structuralMinY = minLocalY;
		}
	}

	if (visibleCount > 0 && isFiniteNumber(visibleMinY)) {
		return {
			offset: new Vector3(0, visibleMinY, 0),
			source: "visible_body",
			valid: true,
		};
	}

	if (structuralCount > 0 && isFiniteNumber(structuralMinY)) {
		return {
			offset: new Vector3(0, structuralMinY, 0),
			source: "structural_body",
			valid: true,
		};
	}

	const diagnostic = `[CombatFighterGrounding] Nenhuma geometria física válida encontrada em "${model.Name}" (após ignorar Stand/VFX/acessórios/hitboxes); usando offset nulo no plano superior do anchor.`;
	warn(diagnostic);
	return { offset: Vector3.zero, source: "fallback_invalid", valid: false, diagnostic };
}

/** Retorna o CFrame do centro da face superior (+Y local) do anchor, preservando sua orientação completa. */
export function computeAnchorTopSurfaceCFrame(anchor: BasePart): CFrame {
	const halfY = isFiniteNumber(anchor.Size.Y) ? anchor.Size.Y * 0.5 : 0;
	return anchor.CFrame.mul(new CFrame(0, halfY, 0));
}

/**
 * Calcula o CFrame final do `rootPart` do lutador para que seu ponto físico de apoio (`groundContactOffset`)
 * coincida com o centro da face superior do anchor, preservando a orientação do anchor em qualquer rotação 3D.
 */
export function alignFighterCFrameToAnchor(
	anchor: BasePart,
	groundContactOffset: Vector3 = Vector3.zero,
): CFrame {
	const topSurfaceCFrame = computeAnchorTopSurfaceCFrame(anchor);
	if (!isFiniteVector3(groundContactOffset)) {
		warn("[CombatFighterGrounding] Offset de apoio inválido (não finito); alinhando ao plano superior sem deslocamento.");
		return topSurfaceCFrame;
	}
	return topSurfaceCFrame.mul(new CFrame(groundContactOffset.mul(-1)));
}
