import { Players, Workspace } from "@rbxts/services";
import { ARENA_CLIENT_REPLICATION_POLL_SECONDS } from "../../shared/Config";
import { ARENA_SIDE_ANCHOR_NAMES } from "../UI/CombatVisualConfig";
import { battleCleanupStep } from "./BattleCleanup";
import {
	collectFramingPointsInCameraSpace,
	computeAdaptiveCameraFrame,
	hasRelevantViewportChange,
	isValidViewportSize,
	type AdaptiveCameraFrame,
	type CameraFramingContext,
} from "./CombatCameraFraming";
import { buildCombatCameraArc } from "./CombatCameraIntro";

interface SavedCameraState {
	readonly camera: Camera;
	readonly cameraType: Enum.CameraType;
	readonly cframe: CFrame;
	readonly cameraSubject?: BasePart | Humanoid;
	readonly fieldOfView: number;
	readonly fieldOfViewMode: Enum.FieldOfViewMode;
}

export interface ArenaCameraResolutionResult {
	readonly ok: boolean;
	readonly camera?: BasePart;
	readonly fatal?: boolean;
	readonly diagnostics: readonly string[];
}

export function resolveSideCameraAnchor(folder: Instance, sideIndex: 0 | 1): ArenaCameraResolutionResult {
	const name = ARENA_SIDE_ANCHOR_NAMES[sideIndex].camera;
	const matches: Instance[] = [];
	for (const child of folder.GetChildren()) {
		if (child.Name === name) matches.push(child);
	}
	if (matches.size() === 0) {
		return {
			ok: false,
			fatal: false,
			diagnostics: [
				`[CombatCameraController] Referência ausente: BasePart "${name}" não encontrada em "${folder.GetFullName()}".`,
			],
		};
	}
	if (matches.size() > 1) {
		return {
			ok: false,
			fatal: true,
			diagnostics: [
				`[CombatCameraController] Referência duplicada/ambígua: encontradas ${matches.size()} instâncias "${name}" em "${folder.GetFullName()}".`,
			],
		};
	}
	const match = matches[0];
	if (!match.IsA("BasePart")) {
		return {
			ok: false,
			fatal: true,
			diagnostics: [
				`[CombatCameraController] Referência inválida: "${match.GetFullName()}" é ${match.ClassName}, esperado BasePart.`,
			],
		};
	}
	return { ok: true, camera: match, diagnostics: [] };
}

function isCameraPartValid(cameraPart: BasePart, context?: CameraFramingContext): boolean {
	const arena = context?.anchors.arenaInstance;
	return (
		cameraPart.Parent !== undefined &&
		(arena === undefined || (arena.Parent !== undefined && cameraPart.IsDescendantOf(arena)))
	);
}

/**
 * Gerencia o ciclo de vida da câmera de batalha no client:
 * valida Camera_A/Camera_B na arena exclusiva, salva o estado anterior (incluindo FOV e FieldOfViewMode),
 * ativa Scriptable com enquadramento adaptativo referenciado na Part e restaura tudo no encerramento.
 */
export class CombatCameraController {
	private savedState?: SavedCameraState;
	private activeCameraPart?: BasePart;
	private activeGeneration?: number;
	private activeIsCurrentBattle?: () => boolean;
	private framingContext?: CameraFramingContext;
	private lastAppliedViewportSize?: Vector2;
	private lastAppliedFrame?: AdaptiveCameraFrame;
	private cameraTypeGuard?: RBXScriptConnection;
	private viewportSizeConnection?: RBXScriptConnection;
	private introSide?: 0 | 1;
	private introProgress = 0;
	private introArc?: (progress: number) => CFrame;
	private lastDiagnostics: readonly string[] = [];

	public constructor(
		private readonly getCamera: () => Camera | undefined = () => Workspace.CurrentCamera,
		private readonly getViewportSize?: () => Vector2,
	) {}

	private disconnectGuards(): void {
		if (this.cameraTypeGuard !== undefined) {
			const conn = this.cameraTypeGuard;
			this.cameraTypeGuard = undefined;
			battleCleanupStep("camera type guard disconnect", () => conn.Disconnect());
		}
		if (this.viewportSizeConnection !== undefined) {
			const conn = this.viewportSizeConnection;
			this.viewportSizeConnection = undefined;
			battleCleanupStep("camera viewport listener disconnect", () => conn.Disconnect());
		}
	}

	private readViewportSize(camera: Camera): Vector2 {
		return this.getViewportSize !== undefined ? this.getViewportSize() : camera.ViewportSize;
	}

	private applyFramingToCamera(camera: Camera, cameraPart: BasePart, force: boolean): void {
		const saved = this.savedState;
		if (saved === undefined || cameraPart.Parent === undefined) return;

		const viewportSize = this.readViewportSize(camera);
		const viewportChanged = hasRelevantViewportChange(this.lastAppliedViewportSize, viewportSize);
		if (!viewportChanged && !force) return;

		const validViewport = isValidViewportSize(viewportSize);
		const context = this.framingContext;
		const reference = cameraPart.CFrame;
		const points = validViewport && context !== undefined && this.introSide !== undefined
			? collectFramingPointsInCameraSpace(reference, context)
			: undefined;
		const frame = computeAdaptiveCameraFrame(
			reference,
			viewportSize,
			saved.fieldOfView,
			context,
			points,
		);

		this.lastAppliedFrame = frame;
		this.lastAppliedViewportSize = validViewport ? viewportSize : undefined;

		if (validViewport && context !== undefined) {
			if (camera.FieldOfViewMode !== frame.fieldOfViewMode) {
				camera.FieldOfViewMode = frame.fieldOfViewMode;
			}
			camera.FieldOfView = frame.fieldOfView;
			if (this.introSide !== undefined && points !== undefined) {
				this.introArc = buildCombatCameraArc(frame, reference, context, this.introSide, viewportSize.X / viewportSize.Y, points);
				if (this.introArc !== undefined) {
					camera.CFrame = this.introArc(this.introProgress);
					return;
				}
			}
		}
		camera.CFrame = frame.cframe;
	}

	private ownsCamera(camera: Camera, cameraPart: BasePart): boolean {
		return (
			this.savedState?.camera === camera &&
			this.activeCameraPart === cameraPart &&
			this.getCamera() === camera &&
			isCameraPartValid(cameraPart, this.framingContext) &&
			this.activeIsCurrentBattle?.() === true
		);
	}

	public setFramingContext(context?: CameraFramingContext): void {
		this.framingContext = context;
	}

	public refreshFraming(force = true): boolean {
		const part = this.activeCameraPart;
		const camera = this.savedState?.camera;
		if (camera === undefined || part === undefined || !this.ownsCamera(camera, part)) return false;
		this.applyFramingToCamera(camera, part, force);
		return true;
	}

	public prepareIntro(sideIndex: 0 | 1): boolean {
		if (this.introSide === sideIndex && this.introArc !== undefined) return true;
		this.introSide = sideIndex;
		this.introProgress = 0;
		return this.refreshFraming() && this.introArc !== undefined;
	}

	public setIntroProgress(progress: number): boolean {
		const part = this.activeCameraPart;
		const camera = this.savedState?.camera;
		if (part === undefined || camera === undefined || !this.ownsCamera(camera, part)) return false;
		const arc = this.introArc;
		if (arc !== undefined) {
			this.introProgress = progress;
			camera.CFrame = arc(progress);
			if (progress >= 1) {
				this.introSide = undefined;
				this.introArc = undefined;
			}
		}
		return true;
	}

	/** Capture the exploration camera before the server can move the character. */
	public capture(): boolean {
		if (this.savedState !== undefined) return true;
		const camera = this.getCamera();
		if (camera === undefined) return false;
		this.savedState = {
			camera,
			cameraType: camera.CameraType,
			cframe: camera.CFrame,
			cameraSubject: camera.CameraSubject,
			fieldOfView: camera.FieldOfView,
			fieldOfViewMode: camera.FieldOfViewMode,
		};
		return true;
	}

	public activateForArenaPart(
		cameraPart: BasePart,
		generation: number,
		isCurrentBattle: () => boolean,
		framingContext?: CameraFramingContext,
		introSide?: 0 | 1,
	): boolean {
		const context = framingContext ?? this.framingContext;
		if (!isCurrentBattle()) return false;
		if (!isCameraPartValid(cameraPart, context)) return false;

		const camera = this.getCamera();
		if (camera === undefined) return false;

		if (this.activeCameraPart !== undefined) this.restore();
		if (!this.capture()) return false;
		const saved = this.savedState;
		if (saved?.camera !== camera) return false;

		this.savedState = saved;
		this.framingContext = context;
		this.activeCameraPart = cameraPart;
		this.activeGeneration = generation;
		this.activeIsCurrentBattle = isCurrentBattle;
		this.lastAppliedViewportSize = undefined;
		this.lastDiagnostics = [];
		this.introSide = introSide;
		this.introProgress = 0;
		camera.CameraType = Enum.CameraType.Scriptable;
		this.applyFramingToCamera(camera, cameraPart, true);

		this.cameraTypeGuard = camera.GetPropertyChangedSignal("CameraType").Connect(() => {
			if (this.savedState !== saved || !this.ownsCamera(camera, cameraPart)) return;
			if (camera.CameraType === Enum.CameraType.Scriptable) return;
			camera.CameraType = Enum.CameraType.Scriptable;
			this.applyFramingToCamera(camera, cameraPart, true);
		});

		this.viewportSizeConnection = camera.GetPropertyChangedSignal("ViewportSize").Connect(() => {
			if (this.savedState !== saved || !this.ownsCamera(camera, cameraPart)) return;
			this.applyFramingToCamera(camera, cameraPart, false);
		});
		return true;
	}

	public resolveAndActivateForSide(
		sideFolder: Instance,
		isInActiveRoot: (inst: Instance) => boolean,
		sideIndex: 0 | 1,
		generation: number,
		isCurrentBattle: () => boolean,
		timeoutSeconds = 0,
		pollSeconds = ARENA_CLIENT_REPLICATION_POLL_SECONDS,
		framingContext?: CameraFramingContext,
		withIntro = false,
	): ArenaCameraResolutionResult {
		const clampedTimeout = math.max(timeoutSeconds, 0);
		const clampedPoll = math.max(pollSeconds, 0.01);
		const deadline = os.clock() + clampedTimeout;
		let lastResult: ArenaCameraResolutionResult = { ok: false, fatal: false, diagnostics: [] };

		while (true) {
			if (!isCurrentBattle()) {
				return { ok: false, fatal: false, diagnostics: [] };
			}
			if (!isInActiveRoot(sideFolder)) {
				const diagnostics = [
					`[CombatCameraController] Pasta de equipe "${sideFolder.Name}" não pertence mais à arena ativa.`,
				];
				this.lastDiagnostics = diagnostics;
				warn(diagnostics[0]);
				return { ok: false, fatal: true, diagnostics };
			}
			lastResult = resolveSideCameraAnchor(sideFolder, sideIndex);
			if (lastResult.ok && lastResult.camera !== undefined && isInActiveRoot(lastResult.camera)) {
				if (!isCurrentBattle()) {
					return { ok: false, fatal: false, diagnostics: [] };
				}
				const activated = this.activateForArenaPart(
					lastResult.camera,
					generation,
					isCurrentBattle,
					framingContext,
					withIntro ? sideIndex : undefined,
				);
				if (activated) {
					return lastResult;
				}
				const diagnostics = [
					`[CombatCameraController] Câmera indisponível ao ativar "${lastResult.camera.GetFullName()}".`,
				];
				this.lastDiagnostics = diagnostics;
				warn(diagnostics[0]);
				return { ok: false, fatal: true, diagnostics };
			}
			if (lastResult.fatal) break;
			const remaining = deadline - os.clock();
			if (remaining <= 0) break;
			task.wait(math.min(clampedPoll, remaining));
		}

		if (!isCurrentBattle()) {
			return { ok: false, fatal: false, diagnostics: [] };
		}
		this.lastDiagnostics = lastResult.diagnostics;
		for (const message of lastResult.diagnostics) warn(message);
		return lastResult;
	}

	public restore(): void {
		this.introSide = undefined;
		this.introArc = undefined;
		this.disconnectGuards();

		const saved = this.savedState;
		this.savedState = undefined;
		this.activeCameraPart = undefined;
		this.activeGeneration = undefined;
		this.activeIsCurrentBattle = undefined;
		this.framingContext = undefined;
		this.lastAppliedViewportSize = undefined;
		this.lastAppliedFrame = undefined;

		if (saved === undefined) return;

		const camera = saved.camera;

		camera.CameraType = saved.cameraType;
		if (saved.cameraSubject !== undefined && saved.cameraSubject.Parent !== undefined) {
			camera.CameraSubject = saved.cameraSubject;
		} else if (camera === Workspace.CurrentCamera) {
			const humanoid = Players.LocalPlayer?.Character?.FindFirstChildOfClass("Humanoid");
			if (humanoid !== undefined) {
				camera.CameraSubject = humanoid;
			}
		}
		camera.FieldOfViewMode = saved.fieldOfViewMode;
		camera.FieldOfView = saved.fieldOfView;
		camera.CFrame = saved.cframe;
	}

	public isActive(): boolean {
		return this.savedState !== undefined;
	}

	public getActiveCameraPart(): BasePart | undefined {
		return this.activeCameraPart;
	}

	public getActiveGeneration(): number | undefined {
		return this.activeGeneration;
	}

	public getLastAppliedFrame(): AdaptiveCameraFrame | undefined {
		return this.lastAppliedFrame;
	}

	public getLastDiagnostics(): readonly string[] {
		return this.lastDiagnostics;
	}
}
