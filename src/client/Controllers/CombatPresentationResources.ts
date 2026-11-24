import { TweenService } from "@rbxts/services";
import { battleCleanupStep } from "./BattleCleanup";

interface PresentationDelay {
	readonly callback: () => void;
	readonly owner?: number;
	readonly order: number;
	remaining: number;
	startedAt: number;
	scheduled?: thread;
}

/** Recursos do palco. O token do ataque limita a vida de markers, tracks e callbacks da habilidade. */
export class CombatPresentationResources {
	public readonly tweens = new Set<Tween>();
	public readonly connections = new Set<RBXScriptConnection>();
	public readonly tasks = new Set<thread>();
	public readonly tracks = new Set<AnimationTrack>();
	private readonly delays = new Map<thread, PresentationDelay>();
	private readonly markerOwners = new Map<RBXScriptConnection, number>();
	private readonly trackOwners = new Map<AnimationTrack, number>();
	private readonly disposals = new Map<number, (() => void)[]>();
	private readonly runningOwners = new Map<thread, number>();
	private readonly pausedTweens = new Set<Tween>();
	private readonly pausedTracks = new Map<AnimationTrack, number>();
	private pauseStarted?: number;
	private pausedTime = 0;
	private delayOrder = 0;
	private resumeSignal?: BindableEvent;

	public isPaused(): boolean {
		return this.pauseStarted !== undefined;
	}

	public now(): number {
		return (this.pauseStarted ?? os.clock()) - this.pausedTime;
	}

	public awaitResume(): void {
		while (this.isPaused()) {
			this.resumeSignal ??= new Instance("BindableEvent");
			this.resumeSignal.Event.Wait();
		}
	}

	public setPaused(paused: boolean): void {
		if (paused === this.isPaused()) return;
		const now = os.clock();
		if (paused) {
			this.pauseStarted = now;
			for (const [, delay] of this.delays) {
				if (delay.scheduled === undefined) continue;
				delay.remaining = math.max(0, delay.remaining - (now - delay.startedAt));
				task.cancel(delay.scheduled);
				delay.scheduled = undefined;
			}
			for (const tween of this.tweens) {
				if (tween.PlaybackState === Enum.PlaybackState.Playing || tween.PlaybackState === Enum.PlaybackState.Delayed) {
					tween.Pause();
					this.pausedTweens.add(tween);
				}
			}
			for (const track of this.tracks) {
				if (track.IsPlaying) {
					this.pausedTracks.set(track, track.Speed);
					track.AdjustSpeed(0);
				}
			}
			return;
		}
		this.pausedTime += now - this.pauseStarted!;
		this.pauseStarted = undefined;
		const waiting = [...this.delays];
		waiting.sort(([, a], [, b]) => a.remaining === b.remaining ? a.order < b.order : a.remaining < b.remaining);
		for (const [key, delay] of waiting) this.schedule(key, delay);
		for (const tween of this.pausedTweens) {
			if (tween.PlaybackState === Enum.PlaybackState.Paused) tween.Play();
		}
		this.pausedTweens.clear();
		for (const [track, speed] of this.pausedTracks) {
			if (track.IsPlaying) track.AdjustSpeed(speed);
		}
		this.pausedTracks.clear();
		this.resumeSignal?.Fire();
	}

	public delay(seconds: number, callback: () => void, owner?: number): thread {
		const key = coroutine.create(callback);
		const delay = { callback, owner, order: this.delayOrder++, remaining: seconds, startedAt: 0 };
		this.delays.set(key, delay);
		this.tasks.add(key);
		if (!this.isPaused()) this.schedule(key, delay);
		return key;
	}

	private schedule(key: thread, delay: PresentationDelay): void {
		delay.startedAt = os.clock();
		const scheduled = task.delay(delay.remaining, () => {
			if (this.delays.get(key) !== delay || delay.scheduled !== scheduled) return;
			delay.scheduled = undefined;
			this.delays.delete(key);
			this.tasks.delete(key);
			const running = coroutine.running();
			this.tasks.add(running);
			if (delay.owner !== undefined) this.runningOwners.set(running, delay.owner);
			battleCleanupStep("presentation callback", delay.callback);
			this.runningOwners.delete(running);
			this.tasks.delete(running);
		});
		delay.scheduled = scheduled;
	}

	public cancelTask(key: thread): void {
		if (!this.tasks.delete(key)) return;
		const delay = this.delays.get(key);
		this.delays.delete(key);
		this.runningOwners.delete(key);
		const scheduled = delay !== undefined ? delay.scheduled : key;
		if (scheduled !== undefined && scheduled !== coroutine.running()) pcall(() => task.cancel(scheduled));
	}

	public createTween<T extends Instance>(object: T, info: TweenInfo, goal: Partial<ExtractMembers<T, Tweenable>>): Tween {
		const tween = TweenService.Create(object, info, goal);
		this.tweens.add(tween);
		const connection = tween.Completed.Once(() => {
			this.connections.delete(connection);
			this.tweens.delete(tween);
			this.pausedTweens.delete(tween);
		});
		this.connections.add(connection);
		return tween;
	}

	public bindMarker(track: AnimationTrack, marker: string, owner: number, callback: () => void): void {
		const connection = track.GetMarkerReachedSignal(marker).Once(() => {
			if (this.markerOwners.delete(connection)) this.delay(0, callback, owner);
			this.connections.delete(connection);
		});
		this.connections.add(connection);
		this.markerOwners.set(connection, owner);
	}

	/** Registra a liberação de um recurso de fase, como som, transparência ou objeto auxiliar. */
	public own(owner: number, dispose: () => void): void {
		const callbacks = this.disposals.get(owner) ?? [];
		callbacks.push(dispose);
		this.disposals.set(owner, callbacks);
	}

	public playAnimation(animator: Animator, animation: Animation, owner: number): AnimationTrack | undefined {
		const [loaded, track] = pcall(() => animator.LoadAnimation(animation));
		if (!loaded) return undefined;
		this.tracks.add(track);
		this.trackOwners.set(track, owner);
		const [playing] = pcall(() => track.Play(0.1, 1, 1));
		if (playing) {
			if (this.isPaused()) {
				this.pausedTracks.set(track, track.Speed);
				track.AdjustSpeed(0);
			}
			return track;
		}
		this.disposeTrack(track);
		return undefined;
	}

	public finishMarkers(owner: number): void {
		for (const [connection, token] of this.markerOwners) {
			if (token !== owner) continue;
			this.markerOwners.delete(connection);
			this.connections.delete(connection);
			battleCleanupStep("attack marker", () => connection.Disconnect());
		}
	}

	public cancelAttack(owner: number): void {
		this.finishMarkers(owner);
		for (const [key, delay] of this.delays) if (delay.owner === owner) this.cancelTask(key);
		for (const [key, token] of this.runningOwners) if (token === owner) this.cancelTask(key);
		this.finishReturn(owner);
	}

	public finishReturn(owner: number): void {
		for (const [track, token] of this.trackOwners) if (token === owner) this.disposeTrack(track);
		const disposals = this.disposals.get(owner);
		this.disposals.delete(owner);
		if (disposals !== undefined) {
			for (const dispose of disposals) battleCleanupStep("attack resource", dispose);
		}
	}

	private disposeTrack(track: AnimationTrack): void {
		this.tracks.delete(track);
		this.trackOwners.delete(track);
		this.pausedTracks.delete(track);
		battleCleanupStep("animation stop", () => track.Stop(0));
		battleCleanupStep("animation destroy", () => track.Destroy());
	}

	public clear(): void {
		for (const connection of this.connections) battleCleanupStep("combat connection", () => connection.Disconnect());
		this.connections.clear();
		this.markerOwners.clear();
		for (const pending of this.tasks) this.cancelTask(pending);
		for (const tween of this.tweens) battleCleanupStep("combat tween", () => tween.Cancel());
		this.tweens.clear();
		this.pausedTweens.clear();
		for (const track of this.tracks) this.disposeTrack(track);
		for (const [owner] of this.disposals) this.finishReturn(owner);
		this.pauseStarted = undefined;
		this.pausedTime = 0;
		this.resumeSignal?.Destroy();
		this.resumeSignal = undefined;
	}
}
