import { Players, Workspace } from "@rbxts/services";
import { ARENA_CLIENT_REPLICATION_POLL_SECONDS } from "../../shared/Config";
import { ARENA_SIDE_ANCHOR_NAMES, CAMERA_INTRO_SETTLE_FOV_DEGREES, CAMERA_INTRO_SETTLE_START } from "../UI/CombatVisualConfig";
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
import type { CameraCutscenePose, CombatCameraMode } from "./CombatCutsceneTypes";

interface SavedCameraState {
	readonly camera: Camera;
	readonly cameraType: Enum.CameraType;
	readonly cframe: CFrame;
	readonly cameraSubject?: BasePart | Humanoid;
	readonly subjectCharacter?: Model;
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
	private activeBattleId?: string;
	private activeIsCurrentBattle?: () => boolean;
	private framingContext?: CameraFramingContext;
	private lastAppliedViewportSize?: Vector2;
	private lastAppliedFrame?: AdaptiveCameraFrame;
	private cameraTypeGuard?: RBXScriptConnection;
	private viewportSizeConnection?: RBXScriptConnection;
	private introSide?: 0 | 1;
	private introProgress = 0;
	private introArc?: (progress: number) => CFrame;
	private cutsceneActive = false;
	private lastCutscenePose?: CameraCutscenePose;
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
		if (!validViewport && this.introArc !== undefined) return;
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

		// Prioridade 2 (cutscene) impede o enquadramento adaptativo (prioridade 3) de sobrescrever a câmera,
		// mantendo `lastAppliedFrame` atualizado caso o viewport mude durante a animação.
		if (this.introSide === undefined && this.cutsceneActive) {
			if (force && this.lastCutscenePose !== undefined) {
				this.writePoseToCamera(camera, this.lastCutscenePose);
			}
			return;
		}

		if (validViewport && context !== undefined) {
			if (camera.FieldOfViewMode !== frame.fieldOfViewMode) {
				camera.FieldOfViewMode = frame.fieldOfViewMode;
			}
			camera.FieldOfView = frame.fieldOfView;
			if (this.introSide !== undefined && points !== undefined) {
				this.introArc = buildCombatCameraArc(frame, reference, context, this.introSide, viewportSize.X / viewportSize.Y, points);
				if (this.introArc !== undefined) {
					this.applyIntroPose(camera, frame, this.introArc);
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
		// Prioridade 1 (intro) prevalece sobre qualquer cutscene ativa.
		this.cutsceneActive = false;
		this.lastCutscenePose = undefined;
		this.introSide = sideIndex;
		this.introProgress = 0;
		return this.refreshFraming() && this.introArc !== undefined;
	}

	public isIntroActive(): boolean {
		return this.introSide !== undefined || this.introArc !== undefined;
	}

	public getMode(): CombatCameraMode {
		if (this.savedState === undefined || this.activeCameraPart === undefined) return "inactive";
		if (this.isIntroActive()) return "intro";
		if (this.cutsceneActive) return "cutscene";
		return "adaptive";
	}

	private writePoseToCamera(camera: Camera, pose: CameraCutscenePose): void {
		if (camera.FieldOfViewMode !== pose.fieldOfViewMode) {
			camera.FieldOfViewMode = pose.fieldOfViewMode;
		}
		camera.FieldOfView = pose.fieldOfView;
		camera.CFrame = pose.cframe;
	}

	public beginCutscene(generation: number, battleId: string): boolean {
		const part = this.activeCameraPart;
		const camera = this.savedState?.camera;
		if (
			part === undefined ||
			camera === undefined ||
			this.isIntroActive() ||
			this.activeGeneration !== generation ||
			this.activeBattleId !== battleId ||
			!this.ownsCamera(camera, part)
		) {
			return false;
		}
		this.cutsceneActive = true;
		this.lastCutscenePose = undefined;
		return true;
	}

	public isCutsceneActiveFor(generation: number, battleId: string): boolean {
		const part = this.activeCameraPart;
		const camera = this.savedState?.camera;
		return (
			this.cutsceneActive &&
			!this.isIntroActive() &&
			part !== undefined &&
			camera !== undefined &&
			this.activeGeneration === generation &&
			this.activeBattleId === battleId &&
			this.ownsCamera(camera, part)
		);
	}

	public applyCutscenePose(generation: number, battleId: string, pose: CameraCutscenePose): boolean {
		if (!this.isCutsceneActiveFor(generation, battleId)) return false;
		const camera = this.savedState?.camera;
		if (camera === undefined) return false;
		this.lastCutscenePose = pose;
		this.writePoseToCamera(camera, pose);
		return true;
	}

	public endCutscene(generation: number, battleId: string, restoreAdaptive: boolean): boolean {
		if (!this.cutsceneActive || this.activeGeneration !== generation || this.activeBattleId !== battleId) {
			return false;
		}
		this.cutsceneActive = false;
		this.lastCutscenePose = undefined;
		if (restoreAdaptive && !this.isIntroActive()) {
			this.refreshFraming(true);
		}
		return true;
	}

	private applyIntroPose(camera: Camera, frame: AdaptiveCameraFrame, arc: (progress: number) => CFrame): void {
		const t = math.clamp((this.introProgress - CAMERA_INTRO_SETTLE_START) / (1 - CAMERA_INTRO_SETTLE_START), 0, 1);
		const extraFov = CAMERA_INTRO_SETTLE_FOV_DEGREES * (1 - t * t * (3 - 2 * t));
		camera.FieldOfView = frame.fieldOfView + extraFov;
		camera.CFrame = arc(this.introProgress);
	}

	public setIntroProgress(progress: number): boolean {
		const part = this.activeCameraPart;
		const camera = this.savedState?.camera;
		if (part === undefined || camera === undefined || !this.ownsCamera(camera, part)) return false;
		const arc = this.introArc;
		const frame = this.lastAppliedFrame;
		if (arc !== undefined && frame !== undefined) {
			this.introProgress = progress;
			this.applyIntroPose(camera, frame, arc);
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
		const character = Players.LocalPlayer?.Character;
		const subject = camera.CameraSubject;
		this.savedState = {
			camera,
			cameraType: camera.CameraType,
			cframe: camera.CFrame,
			cameraSubject: subject,
			subjectCharacter: character !== undefined && subject?.IsDescendantOf(character) ? character : undefined,
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
		battleId?: string,
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
		this.activeBattleId = battleId ?? tostring(generation);
		this.activeIsCurrentBattle = isCurrentBattle;
		this.lastAppliedViewportSize = undefined;
		this.lastDiagnostics = [];
		this.introSide = introSide;
		this.introProgress = 0;
		this.cutsceneActive = false;
		this.lastCutscenePose = undefined;
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
		battleId?: string,
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
					battleId,
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
		this.cutsceneActive = false;
		this.lastCutscenePose = undefined;
		this.disconnectGuards();

		const saved = this.savedState;
		this.savedState = undefined;
		this.activeCameraPart = undefined;
		this.activeGeneration = undefined;
		this.activeBattleId = undefined;
		this.activeIsCurrentBattle = undefined;
		this.framingContext = undefined;
		this.lastAppliedViewportSize = undefined;
		this.lastAppliedFrame = undefined;

		if (saved === undefined) return;

		const camera = saved.camera;

		camera.CameraType = saved.cameraType;
		const character = Players.LocalPlayer?.Character;
		const originalCharacterValid = saved.subjectCharacter === undefined ||
			(saved.subjectCharacter === character && character.IsDescendantOf(Workspace));
		if (originalCharacterValid && saved.cameraSubject !== undefined && saved.cameraSubject.Parent !== undefined) {
			camera.CameraSubject = saved.cameraSubject;
		} else if (camera === Workspace.CurrentCamera) {
			const humanoid = character?.FindFirstChildOfClass("Humanoid");
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
