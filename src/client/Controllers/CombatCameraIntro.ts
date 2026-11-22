import { RunService, TweenService } from "@rbxts/services";
import {
	CAMERA_INTRO_DEPTH_FRACTION,
	CAMERA_INTRO_DURATION_SECONDS,
	CAMERA_INTRO_MAX_PULLBACK_STUDS,
} from "../UI/CombatVisualConfig";
import type { AdaptiveCameraFrame, CameraFramingContext } from "./CombatCameraFraming";

/** Recuo no eixo da Camera_A/Camera_B, mantendo a orientação e o FOV do quadro adaptativo. */
export function playCombatCameraIntro(
	frame: AdaptiveCameraFrame,
	context: CameraFramingContext,
	applyCFrame: (cframe: CFrame) => boolean,
): RBXScriptConnection | undefined {
	const [sideA, sideB] = context.anchors.sides;
	if (frame.includedSlotCount === 0 || sideA.active.Parent === undefined || sideB.active.Parent === undefined) return;

	const center = sideA.active.Position.Lerp(sideB.active.Position, 0.5);
	const depth = -frame.cframe.PointToObjectSpace(center).Z;
	if (!(depth > 0 && depth < math.huge)) return;
	const pullback = math.min(depth * CAMERA_INTRO_DEPTH_FRACTION, CAMERA_INTRO_MAX_PULLBACK_STUDS);

	if (!applyCFrame(frame.cframe.mul(new CFrame(0, 0, pullback)))) return;
	let elapsed = 0;
	const connection = RunService.PreRender.Connect((deltaTime) => {
		if (!connection.Connected) return;
		elapsed += deltaTime;
		const progress = math.min(elapsed / CAMERA_INTRO_DURATION_SECONDS, 1);
		const eased = TweenService.GetValue(progress, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut);
		const cframe = progress === 1 ? frame.cframe : frame.cframe.mul(new CFrame(0, 0, pullback * (1 - eased)));
		if (!applyCFrame(cframe) || progress === 1) connection.Disconnect();
	});
	return connection;
}
