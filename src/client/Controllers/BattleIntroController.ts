import { Players, RunService, Workspace } from "@rbxts/services";
import { ARENA_PLAYER_CAGE_MAX_DRIFT_STUDS } from "../../shared/Config";
import {
	BATTLE_CAMERA_ARC_SECONDS,
	BATTLE_COUNTDOWN_SECONDS,
	BATTLE_COVER_TIMEOUT_SECONDS,
	BATTLE_EXIT_COVER_TIMEOUT_SECONDS,
	BATTLE_LOADING_TIMEOUT_SECONDS,
} from "../../shared/configs/BattleIntro";
import type { BattleTransitionAck, BattleTransitionPayload } from "../../shared/Remotes";
import { BattleIntroOverlay } from "../UI/BattleIntroOverlay";
import {
	BATTLE_INTRO_EXIT_REPLICATION_SECONDS,
	BATTLE_INTRO_FADE_SECONDS,
	BATTLE_INTRO_GO_HOLD_SECONDS,
	BATTLE_INTRO_LOCAL_GRACE_SECONDS,
} from "../UI/CombatVisualConfig";
import { battleCleanupStep } from "./BattleCleanup";
import { BattleRemotes } from "./BattleRemotes";

type Schedule = Extract<BattleTransitionPayload, { phase: "schedule" }>;
type Exit = Extract<BattleTransitionPayload, { phase: "exit" }>;

interface IntroState {
	readonly id: number;
	readonly overlay: BattleIntroOverlay;
	deadline: number;
	covered: boolean;
	coverFramePending: boolean;
	ready: boolean;
	cancelled: boolean;
	released: boolean;
	cameraFinal: boolean;
	fadeFinished: boolean;
	exit?: Exit;
	exitCovered: boolean;
	finish?: () => void;
}

export class BattleIntroController {
	private current?: IntroState;
	private render?: RBXScriptConnection;
	private schedule?: Schedule;
	private lastId = -1;

	public constructor(
		private readonly captureCamera: () => boolean,
		private readonly moveCamera: (progress: number) => boolean,
		private readonly recover: () => void,
	) {}

	public receive(payload: BattleTransitionPayload): void {
		if (payload.phase === "cover") {
			if (payload.id > this.lastId) this.begin(payload.id);
			return;
		}
		const state = this.current;
		if (state === undefined || state.id !== payload.id) return;
		if (payload.phase === "exit") {
			this.coverExit(state, payload);
		} else if (!state.cancelled && state.exit === undefined && state.ready && this.schedule === undefined) {
			if (Workspace.GetServerTimeNow() >= payload.arcAt) {
				this.failed(state.id);
				return;
			}
			this.schedule = payload;
			state.deadline = payload.goAt + BATTLE_INTRO_LOCAL_GRACE_SECONDS;
			this.send(state.id, "scheduled");
		}
	}

	public owns(id: number): boolean {
		return this.current?.id === id && !this.current.cancelled && this.current.exit === undefined;
	}

	public ready(id: number): void {
		const state = this.current;
		if (state?.id !== id || !this.owns(id) || state.ready) return;
		state.ready = true;
		this.send(id, "ready");
	}

	public failed(id: number): void {
		const state = this.current;
		if (state?.id !== id || !this.owns(id)) return;
		state.cancelled = true;
		state.overlay.cover(false);
		this.send(id, "failed");
	}

	public release(id: number): void {
		if (this.current?.id === id) this.current.released = true;
	}

	public finish(id: number, finalize: () => void): void {
		const state = this.current;
		if (state?.id !== id) return;
		if (state.exit === undefined) this.coverExit(state, { id, phase: "exit" });
		state.finish = finalize;
		state.deadline = Workspace.GetServerTimeNow() + BATTLE_INTRO_EXIT_REPLICATION_SECONDS;
	}

	public reset(): void {
		this.render?.Disconnect();
		this.render = undefined;
		const overlay = this.current?.overlay;
		this.current = undefined;
		this.schedule = undefined;
		if (overlay !== undefined) battleCleanupStep("intro overlay", () => overlay.gui.Destroy());
	}

	private begin(id: number): void {
		this.lastId = id;
		this.reset();
		const playerGui = Players.LocalPlayer.FindFirstChildOfClass("PlayerGui");
		if (playerGui === undefined) {
			this.send(id, "failed");
			return;
		}
		const overlay = new BattleIntroOverlay(playerGui, () => {
			const state = this.current;
			if (state?.id !== id || !this.owns(id)) return;
			state.cancelled = true;
			overlay.cover(false);
			this.send(id, "cancel");
		});
		const state: IntroState = {
			id, overlay, covered: false, coverFramePending: true, ready: false, cancelled: false, released: false,
			cameraFinal: false, fadeFinished: false, exitCovered: false,
			deadline: Workspace.GetServerTimeNow() + BATTLE_COVER_TIMEOUT_SECONDS + BATTLE_INTRO_LOCAL_GRACE_SECONDS,
		};
		this.current = state;
		overlay.cover(true);
		this.ensureRender();
		const [ok, captured] = pcall(this.captureCamera);
		if (!ok || !captured) this.failed(id);
	}

	private ensureRender(): void {
		if (this.render !== undefined) return;
		this.render = RunService.PreRender.Connect(() => {
			const state = this.current;
			if (state === undefined) return;
			const [ok, failure] = pcall(() => this.step(state, Workspace.GetServerTimeNow()));
			if (!ok) {
				warn(`[BattleIntro] ${tostring(failure)}`);
				if (this.owns(state.id)) this.failed(state.id);
				else this.recover();
			}
		});
	}

	private step(state: IntroState, now: number): void {
		if (state.coverFramePending) {
			state.coverFramePending = false;
			return;
		}
		if (state.exit !== undefined) {
			if (!state.exitCovered) {
				state.exitCovered = true;
				this.send(state.id, "exitCovered");
				return;
			}
			if (state.finish !== undefined && (now >= state.deadline || !this.isNearCage(state.exit.cageFrame))) {
				const finish = state.finish;
				state.finish = undefined;
				finish();
			} else if (now >= state.deadline) {
				this.recover();
			}
			return;
		}
		if (now >= state.deadline && (!state.released || state.cancelled)) {
			this.failed(state.id);
			this.recover();
			return;
		}
		if (state.cancelled) return;
		if (!state.covered) {
			state.covered = true;
			state.deadline = now + BATTLE_LOADING_TIMEOUT_SECONDS + BATTLE_INTRO_LOCAL_GRACE_SECONDS;
			this.send(state.id, "covered");
		}
		const schedule = this.schedule;
		if (schedule === undefined || now < schedule.arcAt) return;
		const progress = math.clamp((now - schedule.arcAt) / BATTLE_CAMERA_ARC_SECONDS, 0, 1);
		if (!state.cameraFinal) {
			if (!this.moveCamera(progress)) {
				this.failed(state.id);
				return;
			}
			state.cameraFinal = progress === 1;
		}
		if (!state.fadeFinished) {
			const fade = math.clamp((now - schedule.arcAt) / BATTLE_INTRO_FADE_SECONDS, 0, 1);
			state.overlay.reveal(fade);
			state.fadeFinished = fade === 1;
		}
		const remaining = schedule.goAt - now;
		if (remaining > 0 && remaining <= BATTLE_COUNTDOWN_SECONDS) {
			const number = math.ceil(remaining);
			state.overlay.showCountdown(tostring(number), number - remaining);
		} else if (remaining <= 0 && remaining > -BATTLE_INTRO_GO_HOLD_SECONDS) {
			state.overlay.showCountdown("GO!", -remaining / BATTLE_INTRO_GO_HOLD_SECONDS);
		} else if (remaining <= -BATTLE_INTRO_GO_HOLD_SECONDS && state.released) {
			state.overlay.gui.Enabled = false;
			this.render?.Disconnect();
			this.render = undefined;
		}
	}

	private coverExit(state: IntroState, payload: Exit): void {
		state.exit = payload;
		state.coverFramePending = true;
		state.overlay.gui.Enabled = true;
		state.overlay.cover(false);
		state.deadline = Workspace.GetServerTimeNow() + BATTLE_EXIT_COVER_TIMEOUT_SECONDS + BATTLE_INTRO_LOCAL_GRACE_SECONDS;
		this.ensureRender();
	}

	private isNearCage(cageFrame?: CFrame): boolean {
		const root = Players.LocalPlayer.Character?.FindFirstChild("HumanoidRootPart");
		return cageFrame !== undefined && root?.IsA("BasePart") === true &&
			root.Position.sub(cageFrame.Position).Magnitude <= ARENA_PLAYER_CAGE_MAX_DRIFT_STUDS;
	}

	private send(id: number, ack: BattleTransitionAck): void {
		BattleRemotes.battleTransition.FireServer(id, ack);
	}
}
