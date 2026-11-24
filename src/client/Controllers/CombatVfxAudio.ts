import type { PartIclesSoundRuntime } from "../types/Part_Icles";
import { battleCleanupStep } from "./BattleCleanup";

/** Controla os sons diretos e as cópias emitidas a partir dos efeitos do ataque. */
export class CombatVfxAudio {
	private readonly pausedSounds = new Set<Sound>();
	private readonly pausedSources = new Set<Instance>();

	public constructor(private readonly getRuntime: () => PartIclesSoundRuntime | undefined) {}

	public interrupt(effects: ReadonlySet<Instance>): void {
		for (const [sound, source] of this.collectSounds(effects)) {
			battleCleanupStep("attack sound", () => sound.Stop());
			if (source !== sound) battleCleanupStep("emitted attack sound", () => sound.Destroy());
		}
		this.clearPausedSources();
		this.pausedSounds.clear();
	}

	public setPaused(effects: ReadonlySet<Instance>, paused: boolean): void {
		if (!paused) {
			this.clearPausedSources();
			for (const sound of this.pausedSounds) {
				if (sound.Parent !== undefined) sound.Resume();
			}
			this.pausedSounds.clear();
			return;
		}

		const runtime = this.getRuntime();
		for (const [sound, source] of this.collectSounds(effects)) {
			if (source !== sound && runtime?.SetTimescale !== undefined && runtime.ClearTimescale !== undefined) {
				if (this.pausedSources.has(source)) continue;
				runtime.SetTimescale(source, 0, undefined, true);
				this.pausedSources.add(source);
			} else if (sound.IsPlaying) {
				sound.Pause();
				this.pausedSounds.add(sound);
			}
		}
	}

	private clearPausedSources(): void {
		const runtime = this.getRuntime();
		for (const source of this.pausedSources) {
			if (source.Parent !== undefined) runtime?.ClearTimescale?.(source);
		}
		this.pausedSources.clear();
	}

	private collectSounds(effects: ReadonlySet<Instance>): Map<Sound, Instance> {
		const sounds = new Map<Sound, Instance>();
		if (effects.size() === 0) return sounds;
		for (const effect of effects) {
			if (effect.IsA("Sound")) sounds.set(effect, effect);
			for (const child of effect.GetDescendants()) {
				if (child.IsA("Sound")) sounds.set(child, child);
			}
		}
		// O Part_Icles pode hospedar a cópia tocada fora do palco. A posse vem da fonte.
		for (const emission of this.getRuntime()?.ActiveEmits ?? []) {
			const source = emission._sourceItem;
			const sound = emission.VisualPart;
			if (source === undefined || !sound?.IsA("Sound") || sound.Parent === undefined) continue;
			let ancestor: Instance | undefined = source;
			while (ancestor !== undefined && !effects.has(ancestor)) ancestor = ancestor.Parent;
			if (ancestor !== undefined) sounds.set(sound, source);
		}
		return sounds;
	}
}
