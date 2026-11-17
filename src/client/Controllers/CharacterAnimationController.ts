import { ContentProvider, Players, RunService } from "@rbxts/services";
import {
	PLAYER_WALK_ANIMATION_ID, PLAYER_WALK_SPEED_MULTIPLIER, PLAYER_WALK_MIN_SPEED,
	PLAYER_WALK_FADE_IN_SECONDS, PLAYER_WALK_FADE_OUT_SECONDS, PLAYER_ANIMATE_WAIT_SECONDS,
	PLAYER_CHARACTER_WAIT_SECONDS, PLAYER_WALK_REFERENCE_SPEED, PLAYER_WALK_MIN_RATE, PLAYER_WALK_MAX_RATE,
} from "shared/Config";

export class CharacterAnimationController {
	private readonly animation = new Instance("Animation");
	private cleanupCharacter?: () => void;
	private character?: Model;

	public start(): void {
		this.animation.AnimationId = PLAYER_WALK_ANIMATION_ID;
		task.spawn(() => {
			const [ok, err] = pcall(() => ContentProvider.PreloadAsync([this.animation]));
			if (!ok) warn("Falha ao pré-carregar animação de caminhada:", err);
		});
		const player = Players.LocalPlayer;
		player.CharacterAdded.Connect((character) => this.bindCharacter(character));
		if (player.Character) this.bindCharacter(player.Character);
	}

	private bindCharacter(character: Model): void {
		this.cleanupCharacter?.();
		this.character = character;
		let active = true;
		let track: AnimationTrack | undefined;
		const connections: RBXScriptConnection[] = [];
		const animateConnections: RBXScriptConnection[] = [];
		const cleanup = () => {
			if (!active) return;
			active = false;
			if (this.character === character) this.character = undefined;
			for (const connection of connections) connection.Disconnect();
			for (const connection of animateConnections) connection.Disconnect();
			if (track) {
				track.Stop(0);
				track.Destroy();
			}
		};
		this.cleanupCharacter = cleanup;
		connections.push(Players.LocalPlayer.CharacterRemoving.Connect((removed) => {
			if (removed === character) cleanup();
		}));
		connections.push(character.AncestryChanged.Connect((_child, parent) => { if (!parent) cleanup(); }));
		task.spawn(() => {
			const humanoid = character.WaitForChild("Humanoid", PLAYER_CHARACTER_WAIT_SECONDS);
			if (!active) return;
			if (!humanoid?.IsA("Humanoid")) { cleanup(); return; }
			connections.push(humanoid.Died.Connect(cleanup));
			if (humanoid.Health <= 0) { cleanup(); return; }
			const animator = humanoid.WaitForChild("Animator", PLAYER_CHARACTER_WAIT_SECONDS);
			if (!active) return;
			if (!animator?.IsA("Animator")) { cleanup(); return; }
			let nativeAnimate: Instance | undefined;
			const bindAnimate = (animate: Instance) => {
				if (nativeAnimate === animate) return;
				nativeAnimate = animate;
				if (track) { track.Stop(0); track.Destroy(); track = undefined; }
				for (const connection of animateConnections) connection.Disconnect();
				animateConnections.clear();
				const folders = new Map<string, RBXScriptConnection>();
				const bindFolder = (folder: Instance) => {
					if (folder.Name !== "walk" && folder.Name !== "run") return;
					folders.get(folder.Name)?.Disconnect();
					const name = folder.Name === "walk" ? "WalkAnim" : "RunAnim";
					const apply = (child: Instance) => {
						if (child.Name === name && child.IsA("Animation")) child.AnimationId = PLAYER_WALK_ANIMATION_ID;
					};
					const connection = folder.ChildAdded.Connect(apply);
					folders.set(folder.Name, connection);
					animateConnections.push(connection);
					for (const child of folder.GetChildren()) apply(child);
				};
				animateConnections.push(animate.ChildAdded.Connect(bindFolder));
				for (const folder of animate.GetChildren()) bindFolder(folder);
			};
			connections.push(character.ChildAdded.Connect((child) => {
				if (child.Name === "Animate") bindAnimate(child);
			}));
			const animate = character.WaitForChild("Animate", PLAYER_ANIMATE_WAIT_SECONDS);
			if (!active) return;
			if (animate) bindAnimate(animate);
			if (!nativeAnimate) {
				const [ok, result] = pcall(() => animator.LoadAnimation(this.animation));
				if (!ok) { warn("Falha ao carregar animação de caminhada:", result); cleanup(); return; }
				track = result;
				track.Priority = Enum.AnimationPriority.Movement;
				track.Looped = true;
			}
			let speed = humanoid.MoveDirection.Magnitude * humanoid.WalkSpeed;
			const rate = () => math.clamp(speed / PLAYER_WALK_REFERENCE_SPEED, PLAYER_WALK_MIN_RATE,
				PLAYER_WALK_MAX_RATE) * PLAYER_WALK_SPEED_MULTIPLIER;
			// Ajusta somente tracks nativas existentes; Animate mantém a reprodução e as transições.
			connections.push(RunService.PreAnimation.Connect(() => {
					if (!nativeAnimate) return;
					for (const playing of animator.GetPlayingAnimationTracks()) {
						if (playing.Animation?.AnimationId === PLAYER_WALK_ANIMATION_ID) playing.AdjustSpeed(rate());
					}
				}));
			const update = () => {
				if (!track) return;
				const state = humanoid.GetState();
				if (humanoid.FloorMaterial === Enum.Material.Air || state === Enum.HumanoidStateType.Jumping ||
					state === Enum.HumanoidStateType.Freefall || state === Enum.HumanoidStateType.FallingDown) {
					if (track.IsPlaying) track.Stop(PLAYER_WALK_FADE_OUT_SECONDS);
					return;
				}
				if (speed > PLAYER_WALK_MIN_SPEED && humanoid.WalkSpeed > 0) {
					if (!track.IsPlaying) track.Play(PLAYER_WALK_FADE_IN_SECONDS);
					track.AdjustSpeed(rate());
				} else if (track.IsPlaying) track.Stop(PLAYER_WALK_FADE_OUT_SECONDS);
			};
			connections.push(humanoid.Running.Connect((value) => { speed = value; update(); }));
			connections.push(humanoid.StateChanged.Connect(() => update()));
			connections.push(humanoid.GetPropertyChangedSignal("FloorMaterial").Connect(update));
			connections.push(humanoid.GetPropertyChangedSignal("WalkSpeed").Connect(() => {
				if (humanoid.WalkSpeed <= 0) speed = 0;
				else speed = humanoid.MoveDirection.Magnitude * humanoid.WalkSpeed;
				update();
			}));
			update();
		});
	}
}
