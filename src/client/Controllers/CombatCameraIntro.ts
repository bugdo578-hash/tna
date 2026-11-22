import { Workspace } from "@rbxts/services";
import {
	CAMERA_INTRO_ARC_DEGREES,
	CAMERA_INTRO_DASH_IMPULSE,
	CAMERA_INTRO_HEIGHT_FRACTION,
	CAMERA_INTRO_RADIUS_FRACTION,
	CAMERA_INTRO_PATH_SAMPLES,
	CAMERA_OCCLUSION_TRANSPARENCY_THRESHOLD,
} from "../UI/CombatVisualConfig";
import {
	computeRequiredPullback,
	type collectFramingPointsInCameraSpace,
	type AdaptiveCameraFrame,
	type CameraFramingContext,
} from "./CombatCameraFraming";

const MAX_SAFE_DASH_IMPULSE = 6;
const MIN_ARC_DEGREES = 120;

/**
 * Converte o progresso normalizado [0, 1] da intro na fração restante [1, 0] do arco.
 * Mantém uma única curva C∞ contínua com impulso inicial sutil (~0,3–0,5s) e desaceleração final suave.
 */
export function evaluateIntroArcRemaining(progress: number, dashImpulse = CAMERA_INTRO_DASH_IMPULSE): number {
	const p = math.clamp(progress, 0, 1);
	if (p <= 0) return 1;
	if (p >= 1) return 0;
	const impulse = math.clamp(dashImpulse, 0, MAX_SAFE_DASH_IMPULSE);
	const oneMinusP = 1 - p;
	const oneMinusP2 = oneMinusP * oneMinusP;
	const dashTerm = impulse * p * p * oneMinusP2 * oneMinusP2;
	return math.clamp(0.5 + 0.5 * math.cos(math.pi * p) - dashTerm, 0, 1);
}

export function buildCombatCameraArc(
	frame: AdaptiveCameraFrame,
	reference: CFrame,
	context: CameraFramingContext,
	sideIndex: 0 | 1,
	aspect: number,
	pointSet: ReturnType<typeof collectFramingPointsInCameraSpace>,
): ((progress: number) => CFrame) | undefined {
	const opposingSideIndex: 0 | 1 = sideIndex === 0 ? 1 : 0;
	const own = context.anchors.sides[sideIndex].active;
	const opposing = context.anchors.sides[opposingSideIndex].active;
	const opposingCamera = context.anchors.sides[opposingSideIndex].camera;
	const { points, hasFrontAnchor } = pointSet;
	if (!hasFrontAnchor || points.size() === 0) return undefined;
	const worldPoints = points.map((point) => reference.PointToWorldSpace(point));
	let ownCenter = own.Position;
	let opposingCenter = opposing.Position;
	const fighterCenters: Vector3[] = [];
	for (const sample of context.getFighterSamples?.() ?? []) {
		const [bounds] = sample.model.GetBoundingBox();
		fighterCenters.push(bounds.Position);
		if (sample.anchor === own) ownCenter = bounds.Position;
		if (sample.anchor === opposing) opposingCenter = bounds.Position;
	}
	const target = ownCenter.Lerp(opposingCenter, 0.5);
	const final = frame.cframe;
	const depth = -final.PointToObjectSpace(target).Z;
	if (!(depth > 0 && depth < math.huge)) return undefined;
	const up = own.CFrame.UpVector;
	const axis = opposing.Position.sub(own.Position);
	const horizontal = axis.sub(up.mul(axis.Dot(up)));
	if (horizontal.Magnitude < 0.001) return () => final;
	const forward = horizontal.Unit;
	const rearDir = forward.mul(-1);

	const finalOffset = final.Position.sub(target);
	const finalHeight = finalOffset.Dot(up);
	const finalHorizontal = finalOffset.sub(up.mul(finalHeight));
	const finalRadius = finalHorizontal.Magnitude;
	if (finalRadius < 0.001) return () => final;
	const finalDir = finalHorizontal.Unit;

	// Determine the opposing-side opening direction from physical anchors (never absolute coordinates).
	let startDir = finalDir.mul(-1);
	let startHeightDelta = 0;
	let startBaseRadius = finalRadius;
	if (opposingCamera !== undefined && opposingCamera.Parent !== undefined) {
		const opposingOffset = opposingCamera.Position.sub(target);
		const opposingHeight = opposingOffset.Dot(up);
		const opposingHorizontal = opposingOffset.sub(up.mul(opposingHeight));
		if (opposingHorizontal.Magnitude >= 0.001) {
			startDir = opposingHorizontal.Unit;
			startHeightDelta = opposingHeight - finalHeight;
			startBaseRadius = math.max(finalRadius, opposingHorizontal.Magnitude);
		}
	}

	// Preserve the L4.1.2 circular arc direction (passing around the player's own flank into Camera_A/B)
	// while starting from the opposing side (~semicircle, never a full orbit).
	const cross = finalDir.Cross(rearDir);
	const sign = cross.Dot(up) >= 0 ? 1 : -1;
	const cosToStart = math.clamp(finalDir.Dot(startDir), -1, 1);
	const sinToStart = finalDir.Cross(startDir).Dot(up) * sign;
	let angleToStart: number;
	if (cosToStart <= -0.9999) {
		angleToStart = math.pi;
	} else {
		angleToStart = math.atan2(sinToStart, cosToStart);
		if (angleToStart < 0) angleToStart += math.pi * 2;
	}
	const maxSweep = math.clamp(angleToStart, math.rad(MIN_ARC_DEGREES), math.rad(CAMERA_INTRO_ARC_DEGREES));
	const sweep = sign * maxSweep;

	const referenceOffset = reference.Position.sub(target);
	const referenceHorizontal = referenceOffset.sub(up.mul(referenceOffset.Dot(up)));
	const referenceRadius = math.max(referenceHorizontal.Magnitude, 0.001);
	let rearExtent = 0;
	for (const point of worldPoints) rearExtent = math.max(rearExtent, point.sub(target).Dot(rearDir));
	const minArchRadius = math.max(
		finalRadius,
		referenceRadius * (1 + CAMERA_INTRO_RADIUS_FRACTION),
		rearExtent + math.min(finalRadius, referenceRadius * 1.6) * 0.65,
	);
	let startRadiusBoost = math.max(0, startBaseRadius - finalRadius);
	let archRadiusBoost = math.max(0, minArchRadius - finalRadius);
	const extraHeight = math.max(finalRadius, depth) * CAMERA_INTRO_HEIGHT_FRACTION;
	const finalTarget = final.Position.add(final.LookVector.mul(depth));

	const arcWithExtra = (startBoost: number, archBoost: number) => (remaining: number) => {
		if (remaining <= 0) return final;
		const arch = math.sin(math.pi * remaining);
		const radialDir = CFrame.fromAxisAngle(up, sweep * remaining).VectorToWorldSpace(finalDir);
		const radius = finalRadius + startBoost * remaining + archBoost * arch;
		const height = finalHeight + startHeightDelta * remaining + extraHeight * arch;
		const position = target.add(radialDir.mul(radius)).add(up.mul(height));
		return CFrame.lookAt(position, finalTarget.Lerp(target, remaining), final.UpVector.Lerp(up, remaining));
	};

	const finalMargin = computeRequiredPullback(worldPoints, aspect, frame.fieldOfView, final);
	let pose = arcWithExtra(startRadiusBoost, archRadiusBoost);
	// Fit every sample along the semicircular arc by expanding start/arch radii once,
	// keeping the entire trajectory a single smooth curve with zero wobble or fighter clipping.
	for (const _pass of $range(1, 3)) {
		let startIncrease = 0;
		let archIncrease = 0;
		for (const i of $range(1, CAMERA_INTRO_PATH_SAMPLES)) {
			const fraction = i / CAMERA_INTRO_PATH_SAMPLES;
			const needed = computeRequiredPullback(worldPoints, aspect, frame.fieldOfView, pose(fraction));
			if (needed > finalMargin + 0.01) {
				const deficit = needed - finalMargin;
				const arch = math.sin(math.pi * fraction);
				if (arch < 0.25 && fraction > 0.5) {
					startIncrease = math.max(startIncrease, deficit / fraction);
				} else {
					archIncrease = math.max(archIncrease, deficit / math.max(arch, 0.15));
				}
			}
		}
		if (startIncrease <= 0.01 && archIncrease <= 0.01) break;
		startRadiusBoost += startIncrease;
		archRadiusBoost += archIncrease;
		pose = arcWithExtra(startRadiusBoost, archRadiusBoost);
	}

	// Walk outward from the known L2.2 shot once during preparation/resize.
	// Keep only the contiguous portion with clear travel and fighter sightlines.
	let amplitude = 1;
	const arena = context.anchors.arenaInstance;
	if (arena?.IsDescendantOf(Workspace)) {
		const params = new RaycastParams();
		params.FilterType = Enum.RaycastFilterType.Include;
		const [a, b] = context.anchors.sides;
		params.FilterDescendantsInstances = arena.GetDescendants().filter((part) =>
			part.IsA("BasePart") && part.CanQuery && part.Transparency < CAMERA_OCCLUSION_TRANSPARENCY_THRESHOLD &&
			!part.IsDescendantOf(a.folder) && !part.IsDescendantOf(b.folder));
		const blocked = (a: Vector3, b: Vector3) => Workspace.Raycast(a, b.sub(a), params) !== undefined;
		const visible = fighterCenters.filter((center) => !blocked(final.Position, center));
		let previous = final.Position;
		for (const i of $range(1, CAMERA_INTRO_PATH_SAMPLES)) {
			const sample = pose(i / CAMERA_INTRO_PATH_SAMPLES);
			const samplePosition = sample.Position;
			if (computeRequiredPullback(worldPoints, aspect, frame.fieldOfView, sample) > finalMargin + 0.01 ||
				blocked(previous, samplePosition) || visible.some((center) => blocked(samplePosition, center))) {
				amplitude = (i - 1) / CAMERA_INTRO_PATH_SAMPLES;
				break;
			}
			previous = samplePosition;
		}
	}
	return (progress) => pose(amplitude * evaluateIntroArcRemaining(progress));
}
