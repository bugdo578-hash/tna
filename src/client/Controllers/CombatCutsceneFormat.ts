import { TweenService } from "@rbxts/services";
import {
	CAMERA_CUTSCENE_DEFAULT_BLEND_OUT_SECONDS,
	CAMERA_CUTSCENE_MAX_FOV,
	CAMERA_CUTSCENE_MIN_FOV,
} from "../UI/CombatVisualConfig";
import type { ResolvedArenaAnchors } from "./CombatArenaAnchors";
import type {
	CameraCutsceneDefinition,
	CameraCutsceneKeyframe,
	CameraCutscenePose,
	CutsceneReferenceSpace,
	WorldCameraSample,
} from "./CombatCutsceneTypes";

export interface CutsceneValidationResult {
	readonly ok: boolean;
	readonly reason?: string;
	readonly keyframes?: readonly CameraCutsceneKeyframe[];
}

export interface KeyframeSequenceConversionOptions {
	readonly id?: string;
	readonly referenceSpace: CutsceneReferenceSpace;
	/** Nome do Pose dentro de cada Keyframe que representa a câmera (padrão `"Camera"`). */
	readonly cameraPoseName?: string;
	/** Transformação de referência opcional para converter o espaço do rig do Studio ao referencial da cutscene. */
	readonly rigReferenceCFrame?: CFrame;
	readonly blendInDuration?: number;
	readonly blendOutDuration?: number;
	readonly followReference?: boolean;
	readonly cancelOnKo?: boolean;
	readonly cancelOnSwitch?: boolean;
	readonly fieldOfViewMode?: Enum.FieldOfViewMode;
}

export interface SampleConversionOptions {
	readonly id?: string;
	readonly referenceSpace: CutsceneReferenceSpace;
	readonly duration?: number;
	readonly blendInDuration?: number;
	readonly blendOutDuration?: number;
	readonly followReference?: boolean;
	readonly cancelOnKo?: boolean;
	readonly cancelOnSwitch?: boolean;
	readonly fieldOfViewMode?: Enum.FieldOfViewMode;
}

function isFiniteNumber(value: number): boolean {
	return value === value && value !== math.huge && value !== -math.huge;
}

export function isFiniteVector3(v: Vector3): boolean {
	return isFiniteNumber(v.X) && isFiniteNumber(v.Y) && isFiniteNumber(v.Z);
}

export function isFiniteCFrame(cf: CFrame): boolean {
	return (
		isFiniteVector3(cf.Position) &&
		isFiniteVector3(cf.RightVector) &&
		isFiniteVector3(cf.UpVector) &&
		isFiniteVector3(cf.LookVector)
	);
}

export function clampCutsceneFov(fov: number): number {
	return math.clamp(fov, CAMERA_CUTSCENE_MIN_FOV, CAMERA_CUTSCENE_MAX_FOV);
}

/** Valida e normaliza uma definição de cutscene, garantindo duração positiva e keyframes ordenados. */
export function validateCutsceneDefinition(definition: CameraCutsceneDefinition): CutsceneValidationResult {
	if (!isFiniteNumber(definition.duration) || definition.duration <= 0) {
		return { ok: false, reason: "Duração da cutscene deve ser um número finito maior que zero." };
	}
	if (definition.blendInDuration !== undefined && (!isFiniteNumber(definition.blendInDuration) || definition.blendInDuration < 0)) {
		return { ok: false, reason: "blendInDuration deve ser um número finito não negativo." };
	}
	if (definition.blendOutDuration !== undefined && (!isFiniteNumber(definition.blendOutDuration) || definition.blendOutDuration < 0)) {
		return { ok: false, reason: "blendOutDuration deve ser um número finito não negativo." };
	}
	if (definition.keyframes.size() === 0) {
		return { ok: false, reason: "Cutscene precisa conter ao menos um keyframe." };
	}

	const indexed: { readonly keyframe: CameraCutsceneKeyframe; readonly index: number }[] = [];
	for (const i of $range(0, definition.keyframes.size() - 1)) {
		const kf = definition.keyframes[i];
		if (!isFiniteNumber(kf.time) || kf.time < 0) {
			return { ok: false, reason: `Keyframe ${i + 1} possui tempo inválido (${tostring(kf.time)}).` };
		}
		if (!isFiniteCFrame(kf.cframe)) {
			return { ok: false, reason: `Keyframe ${i + 1} possui CFrame não finito.` };
		}
		if (kf.fieldOfView !== undefined && (!isFiniteNumber(kf.fieldOfView) || kf.fieldOfView <= 0)) {
			return { ok: false, reason: `Keyframe ${i + 1} possui fieldOfView inválido (${tostring(kf.fieldOfView)}).` };
		}
		indexed.push({ keyframe: kf, index: i });
	}

	indexed.sort((a, b) => {
		if (a.keyframe.time !== b.keyframe.time) return a.keyframe.time < b.keyframe.time;
		return a.index < b.index;
	});

	const normalized: CameraCutsceneKeyframe[] = [];
	for (const entry of indexed) {
		const kf = entry.keyframe;
		normalized.push({
			...kf,
			time: math.clamp(kf.time, 0, definition.duration),
			fieldOfView: kf.fieldOfView !== undefined ? clampCutsceneFov(kf.fieldOfView) : undefined,
		});
	}

	return { ok: true, keyframes: normalized };
}

/** Avalia a pose local (relativa à referência espacial) e o FOV interpolado em `elapsed` segundos. */
export function evaluateCutsceneLocalPose(
	keyframes: readonly CameraCutsceneKeyframe[],
	elapsed: number,
	defaultFov: number,
	defaultFovMode: Enum.FieldOfViewMode,
	overrideFovMode?: Enum.FieldOfViewMode,
): CameraCutscenePose {
	const fovMode = overrideFovMode ?? defaultFovMode;
	const fallbackFov = clampCutsceneFov(defaultFov);
	const count = keyframes.size();
	const first = keyframes[0];
	if (count === 1 || elapsed <= first.time) {
		return {
			cframe: first.cframe,
			fieldOfView: first.fieldOfView ?? fallbackFov,
			fieldOfViewMode: fovMode,
		};
	}

	const last = keyframes[count - 1];
	if (elapsed >= last.time) {
		return {
			cframe: last.cframe,
			fieldOfView: last.fieldOfView ?? fallbackFov,
			fieldOfViewMode: fovMode,
		};
	}

	let k0 = first;
	let k1 = last;
	for (const i of $range(0, count - 2)) {
		const current = keyframes[i];
		const following = keyframes[i + 1];
		if (elapsed >= current.time && elapsed <= following.time) {
			k0 = current;
			k1 = following;
			break;
		}
	}

	const span = k1.time - k0.time;
	if (span <= 1e-6 || k0.hold === true) {
		return {
			cframe: k0.cframe,
			fieldOfView: k0.fieldOfView ?? fallbackFov,
			fieldOfViewMode: fovMode,
		};
	}

	const rawAlpha = math.clamp((elapsed - k0.time) / span, 0, 1);
	const style = k0.easingStyle ?? Enum.EasingStyle.Linear;
	const direction = k0.easingDirection ?? Enum.EasingDirection.InOut;
	const easedAlpha = style === Enum.EasingStyle.Linear
		? rawAlpha
		: TweenService.GetValue(rawAlpha, style, direction);

	const fov0 = k0.fieldOfView ?? fallbackFov;
	const fov1 = k1.fieldOfView ?? fallbackFov;
	const fov = clampCutsceneFov(fov0 + (fov1 - fov0) * easedAlpha);

	return {
		cframe: k0.cframe.Lerp(k1.cframe, easedAlpha),
		fieldOfView: fov,
		fieldOfViewMode: fovMode,
	};
}

/**
 * Calcula o referencial espacial estável da arena atual a partir dos anchors ativos (`Time A` -> `Time B`),
 * preservando translação e rotação 3D de clones em `ActiveArenas` sem depender de coordenadas mundiais fixas.
 */
export function computeArenaReferenceCFrame(anchors: ResolvedArenaAnchors): CFrame | undefined {
	const sideA = anchors.sides[0].active;
	const sideB = anchors.sides[1].active;
	if (sideA.Parent === undefined || sideB.Parent === undefined) return undefined;
	if (anchors.arenaInstance !== undefined && anchors.arenaInstance.Parent === undefined) return undefined;

	const posA = sideA.Position;
	const posB = sideB.Position;
	const center = posA.Lerp(posB, 0.5);
	const up = sideA.CFrame.UpVector;
	if (!isFiniteVector3(center) || !isFiniteVector3(up) || up.Magnitude < 1e-4) return undefined;

	const upUnit = up.Unit;
	const axis = posB.sub(posA);
	let horizontal = axis.sub(upUnit.mul(axis.Dot(upUnit)));
	if (horizontal.Magnitude < 1e-4) {
		const look = sideA.CFrame.LookVector;
		horizontal = look.sub(upUnit.mul(look.Dot(upUnit)));
	}
	if (horizontal.Magnitude < 1e-4) {
		return new CFrame(center).mul(sideA.CFrame.Rotation);
	}

	const forward = horizontal.Unit;
	const reference = CFrame.lookAt(center, center.add(forward), upUnit);
	return isFiniteCFrame(reference) ? reference : undefined;
}

/**
 * Converte amostras de câmera capturadas no Studio em coordenadas de mundo para keyframes relativos
 * (`referenceCFrame:ToObjectSpace(cameraCFrame)`), eliminando qualquer dependência da posição do mapa.
 */
export function sampleWorldCameraCFramesToCutscene(
	samples: readonly WorldCameraSample[],
	options: SampleConversionOptions,
): CameraCutsceneDefinition | undefined {
	if (samples.size() === 0) return undefined;

	const keyframes: CameraCutsceneKeyframe[] = [];
	let maxTime = 0;
	for (const sample of samples) {
		if (!isFiniteNumber(sample.time) || sample.time < 0) continue;
		if (!isFiniteCFrame(sample.cameraCFrame) || !isFiniteCFrame(sample.referenceCFrame)) continue;
		if (sample.time > maxTime) maxTime = sample.time;
		keyframes.push({
			time: sample.time,
			cframe: sample.referenceCFrame.ToObjectSpace(sample.cameraCFrame),
			fieldOfView: sample.fieldOfView,
			easingStyle: sample.easingStyle,
			easingDirection: sample.easingDirection,
			hold: sample.hold,
		});
	}
	if (keyframes.size() === 0) return undefined;

	const duration = options.duration ?? math.max(maxTime, 0.05);
	const definition: CameraCutsceneDefinition = {
		id: options.id,
		duration,
		referenceSpace: options.referenceSpace,
		keyframes,
		fieldOfViewMode: options.fieldOfViewMode,
		blendInDuration: options.blendInDuration,
		blendOutDuration: options.blendOutDuration ?? CAMERA_CUTSCENE_DEFAULT_BLEND_OUT_SECONDS,
		followReference: options.followReference,
		cancelOnKo: options.cancelOnKo,
		cancelOnSwitch: options.cancelOnSwitch,
	};
	return validateCutsceneDefinition(definition).ok ? definition : undefined;
}

function mapPoseEasing(
	poseStyle: Enum.PoseEasingStyle,
	poseDirection: Enum.PoseEasingDirection,
): { readonly easingStyle: Enum.EasingStyle; readonly easingDirection: Enum.EasingDirection; readonly hold?: boolean } {
	let easingDirection: Enum.EasingDirection = Enum.EasingDirection.InOut;
	if (poseDirection === Enum.PoseEasingDirection.In) {
		easingDirection = Enum.EasingDirection.In;
	} else if (poseDirection === Enum.PoseEasingDirection.Out) {
		easingDirection = Enum.EasingDirection.Out;
	}

	if (poseStyle === Enum.PoseEasingStyle.Constant) {
		return { easingStyle: Enum.EasingStyle.Linear, easingDirection, hold: true };
	}
	if (poseStyle === Enum.PoseEasingStyle.Cubic || poseStyle === Enum.PoseEasingStyle.CubicV2) {
		return { easingStyle: Enum.EasingStyle.Cubic, easingDirection };
	}
	if (poseStyle === Enum.PoseEasingStyle.Elastic) {
		return { easingStyle: Enum.EasingStyle.Elastic, easingDirection };
	}
	if (poseStyle === Enum.PoseEasingStyle.Bounce) {
		return { easingStyle: Enum.EasingStyle.Bounce, easingDirection };
	}
	return { easingStyle: Enum.EasingStyle.Linear, easingDirection };
}

function readOptionalFovFromInstances(pose: Pose, keyframe: Keyframe): number | undefined {
	const attr = pose.GetAttribute("FieldOfView") ?? keyframe.GetAttribute("FieldOfView");
	if (typeIs(attr, "number") && isFiniteNumber(attr) && attr > 0) {
		return clampCutsceneFov(attr);
	}
	const valueObj = pose.FindFirstChild("FieldOfView") ?? keyframe.FindFirstChild("FieldOfView");
	if (valueObj !== undefined && valueObj.IsA("NumberValue") && isFiniteNumber(valueObj.Value) && valueObj.Value > 0) {
		return clampCutsceneFov(valueObj.Value);
	}
	return undefined;
}

/**
 * Converte um `KeyframeSequence` criado no Animation Editor do Roblox Studio (animando um bone/part
 * chamado `cameraPoseName`, padrão `"Camera"`) em uma `CameraCutsceneDefinition` de keyframes relativos.
 * Não depende de `Humanoid`/`AnimationTrack` para mover `Workspace.CurrentCamera`.
 */
export function convertKeyframeSequenceToCutscene(
	sequence: KeyframeSequence,
	options: KeyframeSequenceConversionOptions,
): CameraCutsceneDefinition | undefined {
	const poseName = options.cameraPoseName ?? "Camera";
	const rigRef = options.rigReferenceCFrame;
	const keyframes: CameraCutsceneKeyframe[] = [];
	let maxTime = 0;

	for (const inst of sequence.GetKeyframes()) {
		if (!inst.IsA("Keyframe")) continue;
		const pose = inst.FindFirstChild(poseName, true);
		if (pose === undefined || !pose.IsA("Pose")) continue;
		if (!isFiniteNumber(inst.Time) || inst.Time < 0) continue;

		const rawCFrame = pose.CFrame;
		const relativeCFrame = rigRef !== undefined ? rigRef.ToObjectSpace(rawCFrame) : rawCFrame;
		if (!isFiniteCFrame(relativeCFrame)) continue;

		const easing = mapPoseEasing(pose.EasingStyle, pose.EasingDirection);
		const fieldOfView = readOptionalFovFromInstances(pose, inst);
		if (inst.Time > maxTime) maxTime = inst.Time;

		keyframes.push({
			time: inst.Time,
			cframe: relativeCFrame,
			fieldOfView,
			easingStyle: easing.easingStyle,
			easingDirection: easing.easingDirection,
			hold: easing.hold,
		});
	}

	if (keyframes.size() === 0) return undefined;

	const definition: CameraCutsceneDefinition = {
		id: options.id ?? sequence.Name,
		duration: math.max(maxTime, 0.05),
		referenceSpace: options.referenceSpace,
		keyframes,
		fieldOfViewMode: options.fieldOfViewMode,
		blendInDuration: options.blendInDuration,
		blendOutDuration: options.blendOutDuration ?? CAMERA_CUTSCENE_DEFAULT_BLEND_OUT_SECONDS,
		followReference: options.followReference,
		cancelOnKo: options.cancelOnKo,
		cancelOnSwitch: options.cancelOnSwitch,
	};
	return validateCutsceneDefinition(definition).ok ? definition : undefined;
}
