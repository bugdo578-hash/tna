import { Workspace } from "@rbxts/services";
import {
	CAMERA_INTRO_ARC_DEGREES,
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

export function buildCombatCameraArc(
	frame: AdaptiveCameraFrame,
	reference: CFrame,
	context: CameraFramingContext,
	sideIndex: 0 | 1,
	aspect: number,
	pointSet: ReturnType<typeof collectFramingPointsInCameraSpace>,
): ((progress: number) => CFrame) | undefined {
	const own = context.anchors.sides[sideIndex].active;
	const opposing = context.anchors.sides[sideIndex === 0 ? 1 : 0].active;
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

	// Rotate from the adaptive side camera back behind the player's own team
	// around the arena's local up axis, producing a clean, mirrored circular arc.
	const cross = finalDir.Cross(rearDir);
	const sign = cross.Dot(up) >= 0 ? 1 : -1;
	const angleToRear = math.acos(math.clamp(finalDir.Dot(rearDir), -1, 1));
	const maxSweep = math.min(math.rad(CAMERA_INTRO_ARC_DEGREES), math.max(angleToRear - math.rad(4), math.rad(18)));
	const sweep = sign * maxSweep;

	let rearExtent = 0;
	for (const point of worldPoints) rearExtent = math.max(rearExtent, point.sub(target).Dot(rearDir));
	const minStartRadius = math.max(finalRadius * (1 + CAMERA_INTRO_RADIUS_FRACTION), rearExtent + finalRadius * 0.65);
	let extraRadius = math.max(0, minStartRadius - finalRadius);
	const extraHeight = math.max(finalRadius, depth) * CAMERA_INTRO_HEIGHT_FRACTION;
	const finalTarget = final.Position.add(final.LookVector.mul(depth));

	const arcWithExtra = (radiusBoost: number) => (remaining: number) => {
		if (remaining <= 0) return final;
		const radialDir = CFrame.fromAxisAngle(up, sweep * remaining).VectorToWorldSpace(finalDir);
		const radius = finalRadius + radiusBoost * remaining;
		const height = finalHeight + extraHeight * remaining;
		const position = target.add(radialDir.mul(radius)).add(up.mul(height));
		return CFrame.lookAt(position, finalTarget.Lerp(target, remaining), final.UpVector.Lerp(up, remaining));
	};

	const finalMargin = computeRequiredPullback(worldPoints, aspect, frame.fieldOfView, final);
	let pose = arcWithExtra(extraRadius);
	// Fit every sample along the circular arc by expanding the start radius once,
	// keeping the entire trajectory a single smooth circular curve with zero wobble.
	for (const _pass of $range(1, 2)) {
		let radiusIncrease = 0;
		for (const i of $range(1, CAMERA_INTRO_PATH_SAMPLES)) {
			const fraction = i / CAMERA_INTRO_PATH_SAMPLES;
			const needed = computeRequiredPullback(worldPoints, aspect, frame.fieldOfView, pose(fraction));
			if (needed > finalMargin + 0.01) {
				radiusIncrease = math.max(radiusIncrease, (needed - finalMargin) / fraction);
			}
		}
		if (radiusIncrease <= 0.01) break;
		extraRadius += radiusIncrease;
		pose = arcWithExtra(extraRadius);
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
	return (progress) => pose(amplitude * (0.5 + 0.5 * math.cos(math.pi * math.clamp(progress, 0, 1))));
}
