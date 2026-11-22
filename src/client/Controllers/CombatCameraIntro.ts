import {
	CAMERA_INTRO_ARC_DEGREES,
	CAMERA_INTRO_DISTANCE_FRACTION,
	CAMERA_INTRO_HEIGHT_FRACTION,
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
	for (const sample of context.getFighterSamples?.() ?? []) {
		if (sample.anchor !== own && sample.anchor !== opposing) continue;
		const [bounds] = sample.model.GetBoundingBox();
		if (sample.anchor === own) ownCenter = bounds.Position;
		else opposingCenter = bounds.Position;
	}
	const target = ownCenter.Lerp(opposingCenter, 0.5);
	const final = frame.cframe;
	const depth = -final.PointToObjectSpace(target).Z;
	if (!(depth > 0 && depth < math.huge)) return undefined;
	const up = own.CFrame.UpVector;
	const radius = final.Position.sub(ownCenter);
	// Approach from the outside of the player's own side in the anchor's plane.
	const localOpponent = final.PointToObjectSpace(opposingCenter).X;
	const sweep = math.rad(CAMERA_INTRO_ARC_DEGREES) * (localOpponent < 0 ? 1 : -1);

	return (progress) => {
		if (progress >= 1) return final;
		const remaining = 0.5 + 0.5 * math.cos(math.pi * math.clamp(progress, 0, 1));
		const orbit = CFrame.fromAxisAngle(up, sweep * remaining).VectorToWorldSpace(radius);
		const position = ownCenter.add(orbit)
			.add(up.mul(depth * CAMERA_INTRO_HEIGHT_FRACTION * remaining))
			.sub(final.LookVector.mul(depth * CAMERA_INTRO_DISTANCE_FRACTION * remaining));
		const aimed = CFrame.lookAt(position, target, up);
		const composed = final.Rotation.add(position).Lerp(aimed, remaining);
		const pullback = computeRequiredPullback(worldPoints, aspect, frame.fieldOfView, composed);
		return composed.mul(new CFrame(0, 0, pullback));
	};
}
