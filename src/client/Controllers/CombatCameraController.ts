import { Workspace } from "@rbxts/services";

interface SavedCameraState {
	readonly cameraType: Enum.CameraType;
	readonly cframe: CFrame;
	readonly cameraSubject?: BasePart | Humanoid;
}

/**
 * Gerencia o ciclo de vida da câmera de batalha no client:
 * salva o estado anterior, ativa Camera_A/Camera_B da arena em Scriptable
 * e restaura o controle normal da câmera no encerramento.
 */
export class CombatCameraController {
	private savedState?: SavedCameraState;
	private activeCameraPart?: BasePart;
	private activeGeneration?: number;

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

		if (this.savedState === undefined) {
			this.savedState = {
				cameraType: camera.CameraType,
				cframe: camera.CFrame,
				cameraSubject: camera.CameraSubject,
			};
		}

		this.activeCameraPart = cameraPart;
		this.activeGeneration = generation;
		camera.CameraType = Enum.CameraType.Scriptable;
		camera.CFrame = cameraPart.CFrame;
		return true;
	}

	public restore(): void {
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
}
