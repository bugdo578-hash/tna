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
	BATTLE_INTRO_COVER_FADE_SECONDS,
	BATTLE_INTRO_EXIT_COVER_FADE_SECONDS,
	BATTLE_INTRO_EXIT_REPLICATION_SECONDS,
	BATTLE_INTRO_FADE_SECONDS,
	BATTLE_INTRO_GO_HOLD_SECONDS,
	BATTLE_INTRO_LOADING_CONTENT_FADE_IN_SECONDS,
	BATTLE_INTRO_LOADING_CONTENT_FADE_OUT_SECONDS,
	BATTLE_INTRO_LOCAL_GRACE_SECONDS,
} from "../UI/CombatVisualConfig";
import { battleCleanupStep } from "./BattleCleanup";
import { BattleRemotes } from "./BattleRemotes";
import type { BattleFighterMaterialization } from "./BattleFighterMaterialization";

type Schedule = Extract<BattleTransitionPayload, { phase: "schedule" }>;
type Exit = Extract<BattleTransitionPayload, { phase: "exit" }>;

interface IntroState {
	readonly id: number;
	readonly overlay: BattleIntroOverlay;
	deadline: number;
	coverStartedAt: number;
	loadingStartedAt?: number;
	covered: boolean;
	coverFramePending: boolean;
	ready: boolean;
	materialization?: BattleFighterMaterialization;
	cancelled: boolean;
	released: boolean;
	cameraFinal: boolean;
	fadeFinished: boolean;
	goShownAt?: number;
	exit?: Exit;
	exitStartedAt?: number;
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
		private readonly onCancelled?: (id: number) => void,
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

	public setMaterialization(id: number, materialization?: BattleFighterMaterialization): void {
		const state = this.current;
		if (state?.id !== id || !this.owns(id)) {
			materialization?.cancel();
			return;
		}
		this.cancelMaterialization(id);
		state.materialization = materialization;
	}

	public cancelMaterialization(id?: number): void {
		const state = this.current;
		if (state === undefined || (id !== undefined && state.id !== id)) return;
		const materialization = state.materialization;
		state.materialization = undefined;
		materialization?.cancel();
	}

	public failed(id: number): void {
		const state = this.current;
		if (state?.id !== id || !this.owns(id)) return;
		state.cancelled = true;
		this.cancelMaterialization(id);
		state.overlay.stopLoadingAnimation();
		state.overlay.cover(false, true);
		this.onCancelled?.(id);
		this.send(id, "failed");
	}

	public release(id: number): void {
		if (this.current?.id !== id) return;
		this.current.materialization?.finishReveal();
		this.current.released = true;
	}

	/**
	 * Verdadeiro enquanto o carregamento, cobertura, arco cinematográfico ou countdown (3–2–1–GO)
	 * ainda estiverem bloqueando a câmera de combate (prioridade 1 sobre cutscenes de habilidade).
	 */
	public isBlockingCutscenes(): boolean {
		const state = this.current;
		if (state === undefined) return false;
		if (state.cancelled || state.exit !== undefined || !state.released || !state.cameraFinal) return true;
		const schedule = this.schedule;
		return schedule !== undefined && Workspace.GetServerTimeNow() < schedule.goAt;
	}

	public finish(id: number, finalize: () => void): void {
		const state = this.current;
		if (state?.id !== id) return;
		if (state.exit === undefined) this.coverExit(state, { id, phase: "exit" });
		state.finish = finalize;
		state.deadline = Workspace.GetServerTimeNow() + BATTLE_INTRO_EXIT_REPLICATION_SECONDS;
	}

	public reset(): void {
		this.cancelMaterialization();
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
			this.cancelMaterialization(id);
			overlay.stopLoadingAnimation();
			overlay.cover(false, true);
			this.onCancelled?.(id);
			this.send(id, "cancel");
		});
		const now = Workspace.GetServerTimeNow();
		const state: IntroState = {
			id, overlay, covered: false, coverFramePending: true, ready: false, cancelled: false, released: false,
			cameraFinal: false, fadeFinished: false, exitCovered: false,
			coverStartedAt: now,
			deadline: now + BATTLE_COVER_TIMEOUT_SECONDS + BATTLE_INTRO_LOCAL_GRACE_SECONDS,
		};
		this.current = state;
		overlay.cover(true, false);
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
				if (state.exitStartedAt === undefined) state.exitStartedAt = now;
				const exitElapsed = math.max(now - state.exitStartedAt, 0);
				const exitCover = math.clamp(exitElapsed / BATTLE_INTRO_EXIT_COVER_FADE_SECONDS, 0, 1);
				const easedExitCover = exitCover * exitCover * (3 - 2 * exitCover);
				state.overlay.setCurtainTransparency(1 - easedExitCover);
				if (exitCover < 1) return;
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
			const coverElapsed = math.max(now - state.coverStartedAt, 0);
			const coverProgress = math.clamp(coverElapsed / BATTLE_INTRO_COVER_FADE_SECONDS, 0, 1);
			const easedCover = coverProgress * coverProgress * (3 - 2 * coverProgress);
			state.overlay.setCurtainTransparency(1 - easedCover);
			if (coverProgress < 1) return;
			state.covered = true;
			state.loadingStartedAt = now;
			state.deadline = now + BATTLE_LOADING_TIMEOUT_SECONDS + BATTLE_INTRO_LOCAL_GRACE_SECONDS;
			state.overlay.startLoadingAnimation();
			this.send(state.id, "covered");
		}
		const schedule = this.schedule;
		const loadingElapsed = math.max(now - (state.loadingStartedAt ?? now), 0);
		const contentFadeIn = math.clamp(loadingElapsed / BATTLE_INTRO_LOADING_CONTENT_FADE_IN_SECONDS, 0, 1);
		if (schedule === undefined) {
			state.overlay.updateLoading(loadingElapsed, 1 - contentFadeIn);
			return;
		}
		const curtainFade = math.clamp(1 + (now - schedule.arcAt) / BATTLE_INTRO_FADE_SECONDS, 0, 1);
		const fadeOutStart = schedule.arcAt - BATTLE_INTRO_FADE_SECONDS - BATTLE_INTRO_LOADING_CONTENT_FADE_OUT_SECONDS * 0.6;
		const rawFadeOut = math.clamp((now - fadeOutStart) / BATTLE_INTRO_LOADING_CONTENT_FADE_OUT_SECONDS, 0, 1);
		const contentFadeOut = math.max(rawFadeOut * rawFadeOut * (3 - 2 * rawFadeOut), curtainFade);
		if (contentFadeOut < 1) {
			state.overlay.updateLoading(loadingElapsed, math.max(1 - contentFadeIn, contentFadeOut));
		} else {
			state.overlay.stopLoadingAnimation();
		}
		if (!state.fadeFinished) {
			if (curtainFade === 0) return;
			state.overlay.reveal(curtainFade * curtainFade * (3 - 2 * curtainFade));
			state.fadeFinished = curtainFade === 1;
		}
		if (now < schedule.arcAt) return;
		const progress = math.clamp((now - schedule.arcAt) / BATTLE_CAMERA_ARC_SECONDS, 0, 1);
		if (!state.cameraFinal) {
			if (!this.moveCamera(progress)) {
				this.failed(state.id);
				return;
			}
			state.cameraFinal = progress === 1;
		}
		const remaining = schedule.goAt - now;
		const materialization = state.materialization;
		if (materialization !== undefined) {
			const [ok, failure] = pcall(() => materialization.step(now, schedule.goAt));
			if (!ok) {
				this.cancelMaterialization(state.id);
				warn(`[BattleIntro] Materialização: ${tostring(failure)}`);
			}
		}
		if (remaining > 0 && remaining <= BATTLE_COUNTDOWN_SECONDS) {
			const number = math.ceil(remaining);
			state.overlay.showCountdown(tostring(number), number - remaining);
		} else if (remaining <= 0) {
			const goSince = state.goShownAt ?? now;
			if (state.goShownAt === undefined) state.goShownAt = goSince;
			const goAge = now - goSince;
			if (goAge < BATTLE_INTRO_GO_HOLD_SECONDS) {
				state.overlay.showCountdown("GO!", goAge / BATTLE_INTRO_GO_HOLD_SECONDS);
			} else if (state.released) {
				state.overlay.gui.Enabled = false;
				this.render?.Disconnect();
				this.render = undefined;
			}
		}
	}

	private coverExit(state: IntroState, payload: Exit): void {
		this.cancelMaterialization(state.id);
		state.exit = payload;
		state.exitStartedAt = undefined;
		state.coverFramePending = true;
		state.overlay.stopLoadingAnimation();
		state.overlay.gui.Enabled = true;
		state.overlay.cover(false, false);
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
