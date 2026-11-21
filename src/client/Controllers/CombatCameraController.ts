import { Players, Workspace } from "@rbxts/services";
import { ARENA_CLIENT_REPLICATION_POLL_SECONDS } from "../../shared/Config";
import { ARENA_SIDE_ANCHOR_NAMES } from "../UI/CombatVisualConfig";
import { battleCleanupStep } from "./BattleCleanup";
import {
	computeAdaptiveCameraFrame,
	hasRelevantViewportChange,
	isValidViewportSize,
	type AdaptiveCameraFrame,
	type CameraFramingContext,
} from "./CombatCameraFraming";

interface SavedCameraState {
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
		if (!force && !hasRelevantViewportChange(this.lastAppliedViewportSize, viewportSize)) {
			return;
		}

		const validViewport = isValidViewportSize(viewportSize);
		const frame = computeAdaptiveCameraFrame(
			cameraPart.CFrame,
			viewportSize,
			saved.fieldOfView,
			this.framingContext,
		);

		this.lastAppliedFrame = frame;
		this.lastAppliedViewportSize = validViewport ? viewportSize : undefined;

		if (validViewport && this.framingContext !== undefined) {
			if (camera.FieldOfViewMode !== frame.fieldOfViewMode) {
				camera.FieldOfViewMode = frame.fieldOfViewMode;
			}
			camera.FieldOfView = frame.fieldOfView;
		}
		camera.CFrame = frame.cframe;
	}

	public setFramingContext(context?: CameraFramingContext): void {
		this.framingContext = context;
	}

	public refreshFraming(force = true): boolean {
		const part = this.activeCameraPart;
		const isCurrent = this.activeIsCurrentBattle;
		if (this.savedState === undefined || part === undefined || part.Parent === undefined) {
			return false;
		}
		if (isCurrent !== undefined && !isCurrent()) {
			return false;
		}
		const camera = this.getCamera();
		if (camera === undefined) return false;
		this.applyFramingToCamera(camera, part, force);
		return true;
	}

	public activateForArenaPart(
		cameraPart: BasePart,
		generation: number,
		isCurrentBattle: () => boolean,
		framingContext?: CameraFramingContext,
	): boolean {
		if (!isCurrentBattle()) return false;
		if (cameraPart.Parent === undefined) return false;

		const camera = this.getCamera();
		if (camera === undefined) return false;

		this.disconnectGuards();

		if (this.savedState === undefined) {
			this.savedState = {
				cameraType: camera.CameraType,
				cframe: camera.CFrame,
				cameraSubject: camera.CameraSubject,
				fieldOfView: camera.FieldOfView,
				fieldOfViewMode: camera.FieldOfViewMode,
			};
		}

		if (framingContext !== undefined) {
			this.framingContext = framingContext;
		}

		this.activeCameraPart = cameraPart;
		this.activeGeneration = generation;
		this.activeIsCurrentBattle = isCurrentBattle;
		this.lastAppliedViewportSize = undefined;
		this.lastDiagnostics = [];
		camera.CameraType = Enum.CameraType.Scriptable;
		this.applyFramingToCamera(camera, cameraPart, true);

		this.cameraTypeGuard = camera.GetPropertyChangedSignal("CameraType").Connect(() => {
			if (this.savedState === undefined || this.activeGeneration !== generation || !isCurrentBattle()) {
				return;
			}
			const part = this.activeCameraPart;
			if (part === undefined || part.Parent === undefined) return;
			if (camera.CameraType !== Enum.CameraType.Scriptable) {
				camera.CameraType = Enum.CameraType.Scriptable;
			}
			this.applyFramingToCamera(camera, part, true);
		});

		this.viewportSizeConnection = camera.GetPropertyChangedSignal("ViewportSize").Connect(() => {
			if (this.savedState === undefined || this.activeGeneration !== generation || !isCurrentBattle()) {
				return;
			}
			const part = this.activeCameraPart;
			if (part === undefined || part.Parent === undefined) return;
			this.applyFramingToCamera(camera, part, false);
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
	): ArenaCameraResolutionResult {
		if (framingContext !== undefined) {
			this.framingContext = framingContext;
		}
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
					this.framingContext,
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

		const camera = this.getCamera();
		if (camera === undefined) return;

		camera.CameraType =
			saved.cameraType === Enum.CameraType.Scriptable ? Enum.CameraType.Custom : saved.cameraType;
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
