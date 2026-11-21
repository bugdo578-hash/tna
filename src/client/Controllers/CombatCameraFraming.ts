import { Players, Workspace } from "@rbxts/services";
import {
	CAMERA_ACTIVE_ANIMATION_MARGIN_FRONT_STUDS,
	CAMERA_ACTIVE_ANIMATION_MARGIN_SIDE_STUDS,
	CAMERA_ACTIVE_ANIMATION_MARGIN_TOP_STUDS,
	CAMERA_ACTIVE_DODGE_MARGIN_FRACTION,
	CAMERA_ACTIVE_KNOCKBACK_CRIT_MULTIPLIER,
	CAMERA_ASPECT_CHANGE_EPSILON,
	CAMERA_BASE_FOV_MAX,
	CAMERA_BASE_FOV_MIN,
	CAMERA_BENCH_ANIMATION_MARGIN_SIDE_STUDS,
	CAMERA_BENCH_ANIMATION_MARGIN_TOP_STUDS,
	CAMERA_FRAME_PADDING_BOTTOM,
	CAMERA_FRAME_PADDING_HORIZONTAL,
	CAMERA_FRAME_PADDING_TOP,
	CAMERA_MAX_HORIZONTAL_FOV,
	CAMERA_MAX_PULLBACK_STUDS,
	CAMERA_MAX_VERTICAL_FOV,
	CAMERA_MIN_NEAR_DEPTH_STUDS,
	CAMERA_MIN_VALID_VIEWPORT_PX,
	CAMERA_NOMINAL_FIGHTER_MAX_LOCAL,
	CAMERA_NOMINAL_FIGHTER_MIN_LOCAL,
	CAMERA_OCCLUSION_MAX_RAY_STEPS,
	CAMERA_OCCLUSION_TRANSPARENCY_THRESHOLD,
	CAMERA_VIEWPORT_CHANGE_MIN_PIXELS,
	PLACEHOLDER_DODGE_OFFSET_STUDS,
	PLACEHOLDER_HIT_KNOCKBACK_STUDS,
} from "../UI/CombatVisualConfig";
import type { ResolvedArenaAnchors } from "./CombatArenaAnchors";
import { computeAnchorTopSurfaceCFrame } from "./CombatFighterGrounding";

export interface FighterFramingSample {
	readonly model: Model;
	readonly anchor: BasePart;
	readonly isActive: boolean;
}

export interface CameraFramingContext {
	readonly anchors: ResolvedArenaAnchors;
	readonly getFighterSamples?: () => readonly FighterFramingSample[];
	readonly getStageFolder?: () => Instance | undefined;
}

export interface AdaptiveCameraFrame {
	readonly cframe: CFrame;
	readonly fieldOfView: number;
	readonly fieldOfViewMode: Enum.FieldOfViewMode;
	readonly pullbackStuds: number;
	readonly adjusted: boolean;
	readonly includedSlotCount: number;
}

interface LocalBounds {
	readonly min: Vector3;
	readonly max: Vector3;
}

const SIGNS: readonly [number, number] = [-1, 1];
const OCCLUSION_HEIGHT_FRACTIONS: readonly [number, number, number] = [0.25, 0.6, 0.95];
const ADJUSTMENT_EPSILON = 1e-3;
const FOV_SEARCH_ITERATIONS = 16;

function isFiniteNumber(value: number): boolean {
	return value === value && value !== math.huge && value !== -math.huge;
}

function isFiniteVector3(v: Vector3): boolean {
	return isFiniteNumber(v.X) && isFiniteNumber(v.Y) && isFiniteNumber(v.Z);
}

export function isValidViewportSize(viewportSize: Vector2): boolean {
	return (
		isFiniteNumber(viewportSize.X) &&
		isFiniteNumber(viewportSize.Y) &&
		viewportSize.X >= CAMERA_MIN_VALID_VIEWPORT_PX &&
		viewportSize.Y >= CAMERA_MIN_VALID_VIEWPORT_PX
	);
}

export function hasRelevantViewportChange(previous: Vector2 | undefined, current: Vector2): boolean {
	if (!isValidViewportSize(current)) return false;
	if (previous === undefined || !isValidViewportSize(previous)) return true;

	const dx = math.abs(current.X - previous.X);
	const dy = math.abs(current.Y - previous.Y);
	if (dx >= CAMERA_VIEWPORT_CHANGE_MIN_PIXELS || dy >= CAMERA_VIEWPORT_CHANGE_MIN_PIXELS) {
		return true;
	}
	const prevAspect = previous.X / previous.Y;
	const currAspect = current.X / current.Y;
	return math.abs(currAspect - prevAspect) >= CAMERA_ASPECT_CHANGE_EPSILON;
}

/**
 * Calcula a união das caixas locais (no referencial da face superior do anchor)
 * de todos os lutadores instanciados, preservando extensões assimétricas (ex.: arma/Stand).
 */
export function computeFighterLocalBounds(samples: readonly FighterFramingSample[]): LocalBounds {
	let minX = CAMERA_NOMINAL_FIGHTER_MIN_LOCAL.X;
	let minY = CAMERA_NOMINAL_FIGHTER_MIN_LOCAL.Y;
	let minZ = CAMERA_NOMINAL_FIGHTER_MIN_LOCAL.Z;
	let maxX = CAMERA_NOMINAL_FIGHTER_MAX_LOCAL.X;
	let maxY = CAMERA_NOMINAL_FIGHTER_MAX_LOCAL.Y;
	let maxZ = CAMERA_NOMINAL_FIGHTER_MAX_LOCAL.Z;

	for (const sample of samples) {
		if (sample.model.Parent === undefined || sample.anchor.Parent === undefined) continue;
		const [ok, bbCFrame, bbSize] = pcall(() => sample.model.GetBoundingBox());
		if (!ok || !isFiniteVector3(bbCFrame.Position) || !isFiniteVector3(bbSize)) continue;
		if (bbSize.X <= 0 || bbSize.Y <= 0 || bbSize.Z <= 0) continue;

		const anchorTop = computeAnchorTopSurfaceCFrame(sample.anchor);
		const half = bbSize.mul(0.5);
		for (const sx of SIGNS) {
			for (const sy of SIGNS) {
				for (const sz of SIGNS) {
					const worldCorner = bbCFrame.PointToWorldSpace(new Vector3(sx * half.X, sy * half.Y, sz * half.Z));
					const localCorner = anchorTop.PointToObjectSpace(worldCorner);
					if (!isFiniteVector3(localCorner)) continue;
					if (localCorner.X < minX) minX = localCorner.X;
					if (localCorner.Y < minY) minY = localCorner.Y;
					if (localCorner.Z < minZ) minZ = localCorner.Z;
					if (localCorner.X > maxX) maxX = localCorner.X;
					if (localCorner.Y > maxY) maxY = localCorner.Y;
					if (localCorner.Z > maxZ) maxZ = localCorner.Z;
				}
			}
		}
	}

	return {
		min: new Vector3(minX, math.min(minY, 0), minZ),
		max: new Vector3(maxX, maxY, maxZ),
	};
}

/**
 * Verifica via Workspace.Raycast se um anchor de espera está completamente oculto
 * atrás/abaixo de geometria opaca da própria arena (ex.: banco enterrado sob o piso).
 * Anchors fora do Workspace ou com ao menos um ponto visível não são considerados oclusos.
 */
function isWaitingAnchorOccluded(
	cameraPosition: Vector3,
	anchor: BasePart,
	arenaInstance: Model | undefined,
	arenaBasesRoot: Instance,
	fighterHeight: number,
	stageFolder?: Instance,
): boolean {
	if (arenaInstance === undefined || !arenaInstance.IsDescendantOf(Workspace)) {
		return false;
	}

	const anchorTop = computeAnchorTopSurfaceCFrame(anchor);
	const upVector = anchorTop.UpVector;
	const clampedHeight = math.max(fighterHeight, 1);

	const baseExcluded: Instance[] = [arenaBasesRoot];
	if (stageFolder !== undefined) {
		baseExcluded.push(stageFolder);
	}
	const localCharacter = Players.LocalPlayer?.Character;
	if (localCharacter !== undefined) {
		baseExcluded.push(localCharacter);
	}

	for (const fraction of OCCLUSION_HEIGHT_FRACTIONS) {
		const targetPos = anchorTop.Position.add(upVector.mul(clampedHeight * fraction));
		const delta = targetPos.sub(cameraPosition);
		if (delta.Magnitude <= 0.1) {
			return false;
		}

		const excluded: Instance[] = [...baseExcluded];
		let blockedByArena = false;
		for (const _ of $range(1, CAMERA_OCCLUSION_MAX_RAY_STEPS)) {
			const rayParams = new RaycastParams();
			rayParams.FilterType = Enum.RaycastFilterType.Exclude;
			rayParams.FilterDescendantsInstances = excluded;

			const hit = Workspace.Raycast(cameraPosition, delta, rayParams);
			if (hit === undefined) {
				blockedByArena = false;
				break;
			}
			const hitPart = hit.Instance;
			const isArenaGeometry = hitPart.IsDescendantOf(arenaInstance);
			const isOpaque = hitPart.Transparency < CAMERA_OCCLUSION_TRANSPARENCY_THRESHOLD;
			if (isArenaGeometry && isOpaque) {
				blockedByArena = true;
				break;
			}
			excluded.push(hitPart);
		}

		if (!blockedByArena) {
			return false;
		}
	}

	return true;
}

function collectFramingPointsInCameraSpace(
	cameraCFrame: CFrame,
	context: CameraFramingContext,
): { readonly points: Vector3[]; readonly includedSlotCount: number; readonly hasFrontAnchor: boolean } {
	const samples = context.getFighterSamples?.() ?? [];
	const baseBounds = computeFighterLocalBounds(samples);
	const fighterHeight = math.max(baseBounds.max.Y - baseBounds.min.Y, CAMERA_NOMINAL_FIGHTER_MAX_LOCAL.Y);
	const stageFolder = context.getStageFolder?.();

	const knockbackBack = PLACEHOLDER_HIT_KNOCKBACK_STUDS * CAMERA_ACTIVE_KNOCKBACK_CRIT_MULTIPLIER;
	const dodgeSide = PLACEHOLDER_DODGE_OFFSET_STUDS * CAMERA_ACTIVE_DODGE_MARGIN_FRACTION;

	const activeMin = new Vector3(
		baseBounds.min.X - CAMERA_ACTIVE_ANIMATION_MARGIN_SIDE_STUDS,
		baseBounds.min.Y,
		baseBounds.min.Z - CAMERA_ACTIVE_ANIMATION_MARGIN_FRONT_STUDS,
	);
	const activeMax = new Vector3(
		baseBounds.max.X + math.max(CAMERA_ACTIVE_ANIMATION_MARGIN_SIDE_STUDS, dodgeSide),
		baseBounds.max.Y + CAMERA_ACTIVE_ANIMATION_MARGIN_TOP_STUDS,
		baseBounds.max.Z + knockbackBack,
	);

	const benchMin = new Vector3(
		baseBounds.min.X - CAMERA_BENCH_ANIMATION_MARGIN_SIDE_STUDS,
		baseBounds.min.Y,
		baseBounds.min.Z - CAMERA_BENCH_ANIMATION_MARGIN_SIDE_STUDS,
	);
	const benchMax = new Vector3(
		baseBounds.max.X + CAMERA_BENCH_ANIMATION_MARGIN_SIDE_STUDS,
		baseBounds.max.Y + CAMERA_BENCH_ANIMATION_MARGIN_TOP_STUDS,
		baseBounds.max.Z + CAMERA_BENCH_ANIMATION_MARGIN_SIDE_STUDS,
	);

	const points: Vector3[] = [];
	let includedSlotCount = 0;
	let hasFrontAnchor = false;

	for (const side of context.anchors.sides) {
		const sideSlots: readonly { readonly anchor: BasePart; readonly isActive: boolean }[] = [
			{ anchor: side.active, isActive: true },
			{ anchor: side.waiting[0], isActive: false },
			{ anchor: side.waiting[1], isActive: false },
		];

		for (const slot of sideSlots) {
			if (slot.anchor.Parent === undefined) continue;
			if (
				!slot.isActive &&
				isWaitingAnchorOccluded(
					cameraCFrame.Position,
					slot.anchor,
					context.anchors.arenaInstance,
					context.anchors.root,
					fighterHeight,
					stageFolder,
				)
			) {
				continue;
			}

			const anchorTop = computeAnchorTopSurfaceCFrame(slot.anchor);
			const centerInCam = cameraCFrame.PointToObjectSpace(anchorTop.Position);
			if (!isFiniteVector3(centerInCam)) continue;
			if (-centerInCam.Z > 0) {
				hasFrontAnchor = true;
			}

			const lo = slot.isActive ? activeMin : benchMin;
			const hi = slot.isActive ? activeMax : benchMax;
			const xs: readonly [number, number] = [lo.X, hi.X];
			const ys: readonly [number, number] = [lo.Y, hi.Y];
			const zs: readonly [number, number] = [lo.Z, hi.Z];

			for (const lx of xs) {
				for (const ly of ys) {
					for (const lz of zs) {
						const worldPoint = anchorTop.PointToWorldSpace(new Vector3(lx, ly, lz));
						const camPoint = cameraCFrame.PointToObjectSpace(worldPoint);
						if (isFiniteVector3(camPoint)) {
							points.push(camPoint);
						}
					}
				}
			}
			includedSlotCount += 1;
		}
	}

	return { points, includedSlotCount, hasFrontAnchor };
}

function computeRequiredPullback(points: readonly Vector3[], aspect: number, verticalFovDegrees: number): number {
	const tanV = math.tan(math.rad(verticalFovDegrees * 0.5));
	const tanH = tanV * aspect;
	const usableH = (1 - CAMERA_FRAME_PADDING_HORIZONTAL) * tanH;
	const usableTop = (1 - CAMERA_FRAME_PADDING_TOP) * tanV;
	const usableBot = (1 - CAMERA_FRAME_PADDING_BOTTOM) * tanV;

	if (usableH <= 1e-4 || usableTop <= 1e-4 || usableBot <= 1e-4) {
		return 0;
	}

	let required = 0;
	for (const pt of points) {
		const depth = -pt.Z;
		const dNear = CAMERA_MIN_NEAR_DEPTH_STUDS - depth;
		const dX = math.abs(pt.X) / usableH - depth;
		const dY = pt.Y >= 0 ? pt.Y / usableTop - depth : -pt.Y / usableBot - depth;
		const needed = math.max(dNear, dX, dY);
		if (needed > required) {
			required = needed;
		}
	}
	return required;
}

/**
 * Calcula CFrame, FieldOfView e FieldOfViewMode adaptativos a partir da Part de referência
 * (Camera_A ou Camera_B), preservando sua orientação e eixo de visão e ajustando FOV ou
 * recuo ao longo de -LookVector somente quando necessário para manter os lutadores enquadrados.
 */
export function computeAdaptiveCameraFrame(
	referenceCFrame: CFrame,
	viewportSize: Vector2,
	baseVerticalFov: number,
	context?: CameraFramingContext,
): AdaptiveCameraFrame {
	const clampedBaseFov = isFiniteNumber(baseVerticalFov)
		? math.clamp(baseVerticalFov, CAMERA_BASE_FOV_MIN, CAMERA_BASE_FOV_MAX)
		: 70;

	if (context === undefined || !isValidViewportSize(viewportSize)) {
		return {
			cframe: referenceCFrame,
			fieldOfView: clampedBaseFov,
			fieldOfViewMode: Enum.FieldOfViewMode.Vertical,
			pullbackStuds: 0,
			adjusted: false,
			includedSlotCount: 0,
		};
	}

	const { points, includedSlotCount, hasFrontAnchor } = collectFramingPointsInCameraSpace(referenceCFrame, context);
	if (points.size() === 0 || !hasFrontAnchor) {
		return {
			cframe: referenceCFrame,
			fieldOfView: clampedBaseFov,
			fieldOfViewMode: Enum.FieldOfViewMode.Vertical,
			pullbackStuds: 0,
			adjusted: false,
			includedSlotCount,
		};
	}

	const aspect = viewportSize.X / viewportSize.Y;
	const pullbackAtBase = computeRequiredPullback(points, aspect, clampedBaseFov);
	if (pullbackAtBase <= ADJUSTMENT_EPSILON) {
		return {
			cframe: referenceCFrame,
			fieldOfView: clampedBaseFov,
			fieldOfViewMode: Enum.FieldOfViewMode.Vertical,
			pullbackStuds: 0,
			adjusted: false,
			includedSlotCount,
		};
	}

	// Limita o aumento de FOV vertical respeitando o teto horizontal (sem olho-de-peixe em telas largas)
	// e o teto vertical (reduzindo recuo excessivo em retratos 9:16).
	const maxFovByHorizontalCap = math.deg(2 * math.atan(math.tan(math.rad(CAMERA_MAX_HORIZONTAL_FOV * 0.5)) / aspect));
	const allowedMaxFov = math.clamp(maxFovByHorizontalCap, clampedBaseFov, CAMERA_MAX_VERTICAL_FOV);

	if (allowedMaxFov > clampedBaseFov + ADJUSTMENT_EPSILON) {
		const pullbackAtMaxFov = computeRequiredPullback(points, aspect, allowedMaxFov);
		if (pullbackAtMaxFov <= ADJUSTMENT_EPSILON) {
			let lo = clampedBaseFov;
			let hi = allowedMaxFov;
			for (const _ of $range(1, FOV_SEARCH_ITERATIONS)) {
				const mid = (lo + hi) * 0.5;
				if (computeRequiredPullback(points, aspect, mid) <= ADJUSTMENT_EPSILON) {
					hi = mid;
				} else {
					lo = mid;
				}
			}
			return {
				cframe: referenceCFrame,
				fieldOfView: hi,
				fieldOfViewMode: Enum.FieldOfViewMode.Vertical,
				pullbackStuds: 0,
				adjusted: true,
				includedSlotCount,
			};
		}
	}

	const chosenFov = allowedMaxFov;
	const pullback = math.clamp(computeRequiredPullback(points, aspect, chosenFov), 0, CAMERA_MAX_PULLBACK_STUDS);
	const adjustedCFrame = pullback > ADJUSTMENT_EPSILON ? referenceCFrame.mul(new CFrame(0, 0, pullback)) : referenceCFrame;

	return {
		cframe: adjustedCFrame,
		fieldOfView: chosenFov,
		fieldOfViewMode: Enum.FieldOfViewMode.Vertical,
		pullbackStuds: pullback,
		adjusted: pullback > ADJUSTMENT_EPSILON || math.abs(chosenFov - clampedBaseFov) > ADJUSTMENT_EPSILON,
		includedSlotCount,
	};
}
