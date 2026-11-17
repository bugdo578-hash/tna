import { Players, Workspace } from "@rbxts/services";
import { NPC_BATTLE_ACTIVE_ATTRIBUTE } from "../../shared/Config";

const CHALLENGE_PROMPT_NAME = "ProximityPrompt";
const CHALLENGE_PROMPT_ATTRIBUTE = "PvpChallenge";
const CHALLENGE_ACTION_TEXT = "Desafiar";

export class ChallengePromptController {
	private readonly connections: RBXScriptConnection[] = [];
	private readonly prompts = new Map<ProximityPrompt, RBXScriptConnection[]>();
	private readonly original = new Map<ProximityPrompt, { enabled: boolean; requiresLineOfSight: boolean }>();
	private readonly characterConnections = new Map<Player, RBXScriptConnection>();
	private destroyed = false;

	public start(): void {
		if (this.destroyed || !this.connections.isEmpty()) return;
		this.connections.push(
			Workspace.DescendantAdded.Connect(instance => this.observe(instance)),
			Workspace.DescendantRemoving.Connect(instance => {
				if (instance.IsA("ProximityPrompt")) this.forget(instance);
			}),
			Players.LocalPlayer.GetAttributeChangedSignal(NPC_BATTLE_ACTIVE_ATTRIBUTE).Connect(() => {
				this.refresh();
			}),
			Players.PlayerAdded.Connect(player => this.bindPlayer(player)),
			Players.PlayerRemoving.Connect(player => {
				this.characterConnections.get(player)?.Disconnect();
				this.characterConnections.delete(player);
			}),
		);
		for (const player of Players.GetPlayers()) this.bindPlayer(player);
		for (const instance of Workspace.GetDescendants()) this.observe(instance);
	}

	private bindPlayer(player: Player): void {
		if (this.characterConnections.has(player)) return;
		this.characterConnections.set(player, player.CharacterAdded.Connect(() => {
			// Aguarda a associação Player.Character antes de resolver o dono dos prompts já replicados.
			task.defer(() => { if (!this.destroyed) this.refresh(); });
		}));
		this.refresh();
	}

	private refresh(): void {
		for (const [prompt] of this.prompts) this.update(prompt);
	}

	private observe(instance: Instance): void {
		if (!instance.IsA("ProximityPrompt") || this.prompts.has(instance)) return;
		const update = () => this.update(instance);
		this.prompts.set(instance, [
			instance.GetPropertyChangedSignal("Name").Connect(update),
			instance.GetPropertyChangedSignal("ActionText").Connect(update),
			instance.GetPropertyChangedSignal("ObjectText").Connect(update),
			instance.GetPropertyChangedSignal("Enabled").Connect(update),
			instance.GetAttributeChangedSignal(CHALLENGE_PROMPT_ATTRIBUTE).Connect(update),
			instance.AncestryChanged.Connect(update),
		]);
		this.update(instance);
	}

	private update(prompt: ProximityPrompt): void {
		const root = prompt.Parent;
		const character = root?.Parent;
		const owner = character?.IsA("Model") ? Players.GetPlayerFromCharacter(character) : undefined;
		// PvpService não define atributo identificador hoje; preservar seu contrato exato como fallback.
		const isChallenge = owner !== undefined && root?.Name === "HumanoidRootPart" &&
			prompt.Name === CHALLENGE_PROMPT_NAME &&
			(prompt.GetAttribute(CHALLENGE_PROMPT_ATTRIBUTE) === true ||
				(prompt.ActionText === CHALLENGE_ACTION_TEXT && prompt.ObjectText === owner.Name));
		if (!isChallenge) {
			this.restore(prompt);
			return;
		}
		if (!this.original.has(prompt)) this.original.set(prompt, {
			enabled: prompt.Enabled,
			requiresLineOfSight: prompt.RequiresLineOfSight,
		});
		// O prompt fica dentro do corpo (HRP); a própria geometria do alvo pode encobri-lo.
		prompt.RequiresLineOfSight = false;
		const enabled = owner !== Players.LocalPlayer &&
			Players.LocalPlayer.GetAttribute(NPC_BATTLE_ACTIVE_ATTRIBUTE) !== true;
		if (prompt.Enabled !== enabled) prompt.Enabled = enabled;
	}

	private restore(prompt: ProximityPrompt): void {
		const original = this.original.get(prompt);
		if (original === undefined) return;
		this.original.delete(prompt);
		prompt.Enabled = original.enabled;
		prompt.RequiresLineOfSight = original.requiresLineOfSight;
	}

	private forget(prompt: ProximityPrompt): void {
		for (const connection of this.prompts.get(prompt) ?? []) connection.Disconnect();
		this.prompts.delete(prompt);
		this.restore(prompt);
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const connection of this.connections) connection.Disconnect();
		this.connections.clear();
		for (const [, connection] of this.characterConnections) connection.Disconnect();
		this.characterConnections.clear();
		for (const [prompt] of this.prompts) this.forget(prompt);
	}
}
