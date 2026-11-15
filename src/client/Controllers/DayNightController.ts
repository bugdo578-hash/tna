import { Lighting, MaterialService, RunService, Workspace } from "@rbxts/services";
import { DAY_NIGHT_DAY_PROFILE_NAME, DAY_NIGHT_NIGHT_PROFILE_NAME } from "../../shared/Config";
import { DayNightCycleApplier, type DayNightLightingLike, type DayNightWorkspaceLike } from "../../shared/DayNightCycle";

export interface DayNightControllerDeps {
	readonly lighting?: DayNightLightingLike;
	readonly materialService?: Instance;
	readonly workspaceTarget?: DayNightWorkspaceLike;
	readonly heartbeat?: RBXScriptSignal<(dt: number) => void>;
	readonly getServerTimeNow?: () => number;
}

/** Controlador visual do ciclo dia/noite no client em 60+ FPS via Heartbeat. */
export class DayNightController {
	private readonly lighting: DayNightLightingLike;
	private readonly materialService: Instance;
	private readonly workspaceTarget: DayNightWorkspaceLike;
	private readonly heartbeat: RBXScriptSignal<(dt: number) => void>;
	private readonly getServerTimeNow: () => number;
	private applier: DayNightCycleApplier | undefined;
	private heartbeatConnection: RBXScriptConnection | undefined;
	private started = false;
	private destroyed = false;

	public constructor(deps?: DayNightControllerDeps) {
		this.lighting = deps?.lighting ?? Lighting;
		this.materialService = deps?.materialService ?? MaterialService;
		this.workspaceTarget = deps?.workspaceTarget ?? Workspace;
		this.heartbeat = deps?.heartbeat ?? RunService.Heartbeat;
		this.getServerTimeNow = deps?.getServerTimeNow ?? (() => Workspace.GetServerTimeNow());
	}

	public start(): void {
		if (this.started || this.destroyed) return;
		this.started = true;

		const immediateDay = this.materialService.FindFirstChild(DAY_NIGHT_DAY_PROFILE_NAME);
		const immediateNight = this.materialService.FindFirstChild(DAY_NIGHT_NIGHT_PROFILE_NAME);
		if (immediateDay !== undefined && immediateNight !== undefined) {
			this.initializeProfiles(immediateDay, immediateNight);
			return;
		}

		// Aguarda em paralelo para não travar a inicialização dos demais controllers em main.client
		task.spawn(() => {
			const dayProfile = this.materialService.WaitForChild(DAY_NIGHT_DAY_PROFILE_NAME);
			if (this.destroyed) return;
			const nightProfile = this.materialService.WaitForChild(DAY_NIGHT_NIGHT_PROFILE_NAME);
			if (this.destroyed) return;
			this.initializeProfiles(dayProfile, nightProfile);
		});
	}

	private initializeProfiles(dayProfile: Instance, nightProfile: Instance): void {
		if (this.destroyed || this.applier !== undefined) return;
		this.applier = new DayNightCycleApplier(
			this.lighting,
			dayProfile,
			nightProfile,
			this.workspaceTarget,
			this.getServerTimeNow,
		);
		this.applier.update();
		this.heartbeatConnection = this.heartbeat.Connect(() => {
			if (this.destroyed) return;
			this.applier?.update();
		});
	}

	public getApplier(): DayNightCycleApplier | undefined {
		return this.applier;
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.heartbeatConnection?.Disconnect();
		this.heartbeatConnection = undefined;
		this.applier = undefined;
	}
}
