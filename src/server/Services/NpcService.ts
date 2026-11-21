import { freezeBattleMovement } from "./BattleMovement";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { BATTLE_NPC_TAG, NPC_PROMPT_DEBOUNCE_SECONDS, NPC_PROMPT_MAX_DISTANCE } from "../../shared/Config";
import { NPC_DATA, type NpcDefinition } from "../../shared/NpcData";
import type { NpcBattleNoticePayload, NpcBattleNoticeReason } from "../../shared/Remotes";
import { BattleSide } from "../Components/BattleSide";
import { createPlayerInventorySide, makeRealFighter } from "./BattleTeamFactory";
import type { BattleSessionService } from "./BattleSessionService";
import type { PlayerDataService } from "./PlayerDataService";
import type { ProgressionService } from "./ProgressionService";

/** Recria somente o estado de combate; nunca clona/constrói o modelo visual do NPC. */
export function createNpcSide(definition: NpcDefinition, rng: () => number): BattleSide {
	const rolls = new Random(definition.seed);
	const fighters = definition.team.map((entry) => makeRealFighter(entry.fighterId, () => rolls.NextNumber(), entry.level));
	return new BattleSide([fighters[0], ...fighters.filter((_, index) => index > 0)], rng);
}

function promptPosition(prompt: ProximityPrompt): Vector3 | undefined {
	const parent = prompt.Parent;
	if (parent?.IsA("Attachment")) return parent.WorldPosition;
	if (parent?.IsA("BasePart")) return parent.Position;
	if (parent?.IsA("Model")) return parent.PrimaryPart?.Position;
	return undefined;
}

export class NpcService {
	private readonly bindings = new Map<Instance, { prompt: ProximityPrompt; connection: RBXScriptConnection }>();
	private readonly lastTriggered = new Map<Player, number>();
	private readonly rematchCooldowns = new Map<Player, Map<string, number>>();
	private readonly connections: RBXScriptConnection[] = [];

	public constructor(
		private readonly sessions: BattleSessionService,
		private readonly data: PlayerDataService,
		private readonly progression: ProgressionService,
		private readonly notify: (player: Player, payload: NpcBattleNoticePayload) => void,
		private readonly clock: () => number = os.clock,
		private readonly rng: () => number = () => math.random(),
	) {}

	public start(): void {
		if (this.connections.size() > 0) return;
		this.connections.push(
			CollectionService.GetInstanceAddedSignal(BATTLE_NPC_TAG).Connect((npc) => this.bindNpc(npc)),
			CollectionService.GetInstanceRemovedSignal(BATTLE_NPC_TAG).Connect((npc) => this.unbindNpc(npc)),
			Workspace.ChildAdded.Connect((npc) => this.adoptLegacyNpc(npc)),
			Players.PlayerRemoving.Connect((player) => this.handlePlayerRemoving(player)),
		);
		const legacy = Workspace.FindFirstChild("Npc_Luta");
		if (legacy !== undefined) this.adoptLegacyNpc(legacy);
		else warn("[NpcService] Workspace.Npc_Luta não encontrado; nenhum modelo foi criado.");
		for (const npc of CollectionService.GetTagged(BATTLE_NPC_TAG)) this.bindNpc(npc);
	}

	private adoptLegacyNpc(npc: Instance): void {
		if (npc.Name !== "Npc_Luta") return;
		if (npc.GetAttribute("NpcId") === undefined) npc.SetAttribute("NpcId", "bronze_trainer");
		if (!CollectionService.HasTag(npc, BATTLE_NPC_TAG)) CollectionService.AddTag(npc, BATTLE_NPC_TAG);
		this.bindNpc(npc);
	}

	public bindNpc(npc: Instance): void {
		if (this.bindings.has(npc) || !npc.IsDescendantOf(Workspace) || !CollectionService.HasTag(npc, BATTLE_NPC_TAG)) return;
		const npcId = npc.GetAttribute("NpcId");
		const definition = typeIs(npcId, "string") ? NPC_DATA[npcId] : undefined;
		if (definition === undefined) { warn(`[NpcService] NpcId desconhecido em ${npc.GetFullName()}`); return; }
		let prompt = npc.FindFirstChildWhichIsA("ProximityPrompt", true);
		if (prompt === undefined) {
			const parent = npc.IsA("Model") ? npc.PrimaryPart ?? npc.FindFirstChildWhichIsA("BasePart", true) : npc;
			if (parent === undefined || (!parent.IsA("BasePart") && !parent.IsA("Attachment"))) {
				warn(`[NpcService] ${npc.GetFullName()} sem parte para ProximityPrompt`);
				return;
			}
			prompt = new Instance("ProximityPrompt");
			prompt.Parent = parent;
		}
		prompt.ActionText = "Batalhar";
		prompt.ObjectText = definition.displayName;
		prompt.MaxActivationDistance = NPC_PROMPT_MAX_DISTANCE;
		// O Interact existente usa Custom, mas não há UI própria para ele no client.
		prompt.Style = Enum.ProximityPromptStyle.Default;
		const connection = prompt.Triggered.Connect((player) => this.trigger(player, npc));
		this.bindings.set(npc, { prompt, connection });
	}

	/** Entrada única do Triggered no servidor; não existe remote de pedido de luta NPC. */
	public trigger(player: Player, npc: Instance): boolean {
		if (player.Parent !== Players) return false;
		if (this.sessions.hasActiveSession(player)) return this.reject(player, "em_batalha");
		if (!this.data.isSessionLoaded(player)) return this.reject(player, "carregando");
		const now = this.clock();
		const npcId = npc.GetAttribute("NpcId");
		if (typeIs(npcId, "string")) {
			const remaining = (this.rematchCooldowns.get(player)?.get(npcId) ?? now) - now;
			if (remaining > 0) {
				this.notify(player, { reason: "cooldown", npcId, remainingSeconds: math.ceil(remaining) });
				return false;
			}
		}
		const last = this.lastTriggered.get(player);
		if (last !== undefined && now - last < NPC_PROMPT_DEBOUNCE_SECONDS) return false;
		this.lastTriggered.set(player, now);
		const binding = this.bindings.get(npc);
		const definition = typeIs(npcId, "string") ? NPC_DATA[npcId] : undefined;
		if (binding === undefined || definition === undefined || !npc.IsDescendantOf(Workspace) ||
			!CollectionService.HasTag(npc, BATTLE_NPC_TAG) || !binding.prompt.IsDescendantOf(npc) || !binding.prompt.Enabled) return false;
		const character = player.Character;
		const root = character?.FindFirstChild("HumanoidRootPart");
		const humanoid = character?.FindFirstChildOfClass("Humanoid");
		const position = promptPosition(binding.prompt);
		if (root === undefined || !root.IsA("BasePart") || humanoid === undefined || humanoid.Health <= 0 || position === undefined) return false;
		const distance = root.Position.sub(position).Magnitude;
		if (!(distance <= NPC_PROMPT_MAX_DISTANCE)) return this.reject(player, "distancia");
		const playerSide = createPlayerInventorySide(player, this.progression, this.data, this.rng);
		if (playerSide === undefined) return this.reject(player, "time_invalido");

		const cooldowns = this.rematchCooldowns.get(player) ?? new Map<string, number>();
		this.rematchCooldowns.set(player, cooldowns);
		let release = () => {};
		const onFinished = (playerWon: boolean) => {
			// A identidade impede callback tardio de recriar estado após saída/destroy.
			if (playerWon && this.rematchCooldowns.get(player) === cooldowns) {
				cooldowns.set(definition.npcId, this.clock() + definition.rematchCooldownSeconds);
			}
			release();
		};

		const [ok, created] = pcall(() => {
			release = freezeBattleMovement(player, humanoid, () => this.sessions.destroySessionForPlayer(player));
			if (!this.sessions.createSession(player, undefined, playerSide, createNpcSide(definition, this.rng), this.rng, "PVE", onFinished)) return false;
			return this.sessions.attachSideAI(player, 1, this.rng) !== undefined;
		});
		if (!ok || !created) {
			const failureReason = ok ? this.sessions.getLastCreateFailureReason() : undefined;
			this.sessions.destroySessionForPlayer(player);
			release();
			if (!ok) warn(`[NpcService] erro ao iniciar batalha: ${tostring(created)}`);
			if (failureReason === "no_arena_available" || failureReason === "no_slot_available") {
				return this.reject(player, "arena_indisponivel");
			}
			return this.reject(player, "erro");
		}
		return true;
	}

	private reject(player: Player, reason: NpcBattleNoticeReason): false {
		this.notify(player, { reason });
		return false;
	}

	public handlePlayerRemoving(player: Player): void {
		this.lastTriggered.delete(player);
		this.rematchCooldowns.delete(player);
	}

	private unbindNpc(npc: Instance): void {
		this.bindings.get(npc)?.connection.Disconnect();
		this.bindings.delete(npc);
	}

	public destroy(): void {
		for (const connection of this.connections) connection.Disconnect();
		this.connections.clear();
		for (const [npc] of this.bindings) this.unbindNpc(npc);
		this.lastTriggered.clear();
		this.rematchCooldowns.clear();
	}
}
