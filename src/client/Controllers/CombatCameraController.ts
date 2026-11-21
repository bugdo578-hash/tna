import { Players, Workspace } from "@rbxts/services";
import { ARENA_CLIENT_REPLICATION_POLL_SECONDS } from "../../shared/Config";
import { ARENA_SIDE_ANCHOR_NAMES } from "../UI/CombatVisualConfig";

interface SavedCameraState {
	readonly cameraType: Enum.CameraType;
	readonly cframe: CFrame;
	readonly cameraSubject?: BasePart | Humanoid;
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
 * valida Camera_A/Camera_B na arena exclusiva, salva o estado anterior,
 * ativa Scriptable com o CFrame completo da Part e restaura no encerramento.
 */
export class CombatCameraController {
	private savedState?: SavedCameraState;
	private activeCameraPart?: BasePart;
	private activeGeneration?: number;
	private cameraTypeGuard?: RBXScriptConnection;
	private lastDiagnostics: readonly string[] = [];

	public constructor(private readonly getCamera: () => Camera | undefined = () => Workspace.CurrentCamera) {}

	public activateForArenaPart(
		cameraPart: BasePart,
		generation: number,
		isCurrentBattle: () => boolean,
	): boolean {
		if (!isCurrentBattle()) return false;
		if (cameraPart.Parent === undefined) return false;

		const camera = this.getCamera();
		if (camera === undefined) return false;

		this.cameraTypeGuard?.Disconnect();
		this.cameraTypeGuard = undefined;

		if (this.savedState === undefined) {
			this.savedState = {
				cameraType: camera.CameraType,
				cframe: camera.CFrame,
				cameraSubject: camera.CameraSubject,
			};
		}

		this.activeCameraPart = cameraPart;
		this.activeGeneration = generation;
		this.lastDiagnostics = [];
		camera.CameraType = Enum.CameraType.Scriptable;
		camera.CFrame = cameraPart.CFrame;

		this.cameraTypeGuard = camera.GetPropertyChangedSignal("CameraType").Connect(() => {
			if (this.savedState === undefined || this.activeGeneration !== generation || !isCurrentBattle()) {
				return;
			}
			const part = this.activeCameraPart;
			if (part === undefined || part.Parent === undefined) return;
			if (camera.CameraType !== Enum.CameraType.Scriptable) {
				camera.CameraType = Enum.CameraType.Scriptable;
			}
			camera.CFrame = part.CFrame;
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
				const activated = this.activateForArenaPart(lastResult.camera, generation, isCurrentBattle);
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
		this.cameraTypeGuard?.Disconnect();
		this.cameraTypeGuard = undefined;

		const saved = this.savedState;
		this.savedState = undefined;
		this.activeCameraPart = undefined;
		this.activeGeneration = undefined;

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

	public getLastDiagnostics(): readonly string[] {
		return this.lastDiagnostics;
	}
}
