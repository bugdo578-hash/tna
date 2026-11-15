import { Workspace } from "@rbxts/services";
import {
	DAY_NIGHT_ATTRIBUTES,
	DAY_NIGHT_DEFAULT_DURATION_SECONDS,
	DAY_NIGHT_DEFAULT_START_HOUR,
} from "../../shared/Config";

export interface DayNightServerWorkspaceLike {
	GetAttribute(name: string): AttributeValue | undefined;
	SetAttribute(name: string, value: AttributeValue): void;
}

/** Publica a âncora solar e os atributos replicáveis de controle do ciclo no Workspace. */
export class DayNightService {
	public constructor(
		private readonly workspaceTarget: DayNightServerWorkspaceLike = Workspace,
		private readonly getServerTimeNow: () => number = () => Workspace.GetServerTimeNow(),
	) {}

	public start(): void {
		if (this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.duration) === undefined) {
			this.workspaceTarget.SetAttribute(DAY_NIGHT_ATTRIBUTES.duration, DAY_NIGHT_DEFAULT_DURATION_SECONDS);
		}
		if (this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.startHour) === undefined) {
			this.workspaceTarget.SetAttribute(DAY_NIGHT_ATTRIBUTES.startHour, DAY_NIGHT_DEFAULT_START_HOUR);
		}
		if (this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.paused) === undefined) {
			this.workspaceTarget.SetAttribute(DAY_NIGHT_ATTRIBUTES.paused, false);
		}
		if (this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.startTime) === undefined) {
			this.workspaceTarget.SetAttribute(DAY_NIGHT_ATTRIBUTES.startTime, this.getServerTimeNow());
		}
	}
}
