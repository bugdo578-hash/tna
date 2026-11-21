import { HttpService, Players, RunService } from "@rbxts/services";
import {
	MAX_ITEM_UUID_LENGTH,
	PVP_DECLINE_WAIT_SECONDS,
	PVP_INVITE_EXPIRY_SECONDS,
	PVP_INVITE_INTERVAL_SECONDS,
	PVP_PROMPT_MAX_DISTANCE,
	PVP_RESPONSE_BUCKET_CAPACITY,
	PVP_RESPONSE_REFILL_PER_SECOND,
	PVP_SIDE_ALTERNATION_CHANCE,
	PVP_SIDE_FAIR_CHANCE,
} from "../../shared/Config";
import type { ChallengeReceivedPayload, ChallengeStatus, ChallengeStatusPayload } from "../../shared/Remotes";
import { freezeBattleMovement } from "./BattleMovement";
import { createPlayerInventorySide } from "./BattleTeamFactory";
import type { BattleSessionService } from "./BattleSessionService";
import type { PlayerDataService } from "./PlayerDataService";
import type { ProgressionService } from "./ProgressionService";

export type PvpPhysicalSide = "A" | "B";

interface Invite { id: string; challenger: Player; target: Player; expiresAt: number; }
interface Bucket { tokens: number; time: number; }

export class PvpService {
	private readonly pending = new Map<Player, Invite>();
	private readonly starting = new Set<Player>();
	private readonly lastPhysicalSide = new Map<Player, PvpPhysicalSide>();
	private readonly nextInvite = new Map<Player, number>();
	private readonly declined = new Map<Player, Map<Player, number>>();
	private readonly buckets = new Map<Player, Map<string, Bucket>>();
	private readonly bindings = new Map<Player, RBXScriptConnection[]>();
	private readonly prompts = new Map<Player, ProximityPrompt>();
	private readonly connections: RBXScriptConnection[] = [];
	public constructor(
		private readonly sessions: BattleSessionService,
		private readonly data: PlayerDataService,
		private readonly progression: ProgressionService,
		private readonly received: (player: Player, payload: ChallengeReceivedPayload) => void,
		private readonly status: (player: Player, payload: ChallengeStatusPayload) => void,
		private readonly clock: () => number = os.clock,
		private readonly rng: () => number = () => math.random(),
	) {}

	public start(): void {
		if (this.connections.size() > 0) return;
		this.connections.push(Players.PlayerAdded.Connect(p => this.bindPlayer(p)),
			Players.PlayerRemoving.Connect(p => this.forgetPlayer(p)), RunService.Heartbeat.Connect(() => this.step()));
		for (const player of Players.GetPlayers()) this.bindPlayer(player);
	}

	private bindPlayer(player: Player): void {
		if (this.bindings.has(player)) return;
		this.bindings.set(player, [player.CharacterAdded.Connect(character => this.bindCharacter(player, character))]);
		if (player.Character !== undefined) this.bindCharacter(player, player.Character);
	}

	private bindCharacter(player: Player, character: Model): void {
		task.spawn(() => {
			const root = character.WaitForChild("HumanoidRootPart", PVP_INVITE_EXPIRY_SECONDS);
			if (root === undefined || !root.IsA("BasePart") || player.Character !== character || player.Parent !== Players) return;
			this.prompts.get(player)?.Destroy();
			const prompt = new Instance("ProximityPrompt");
			prompt.ActionText = "Desafiar";
			prompt.ObjectText = player.Name;
			prompt.MaxActivationDistance = PVP_PROMPT_MAX_DISTANCE;
			prompt.Triggered.Connect(challenger => this.challenge(challenger, player));
			prompt.Parent = root;
			this.prompts.set(player, prompt);
		});
	}

	private available(player: Player): boolean {
		return player.Parent === Players && this.data.isSessionLoaded(player) && !this.sessions.hasActiveSession(player) && !this.starting.has(player);
	}

	/** Retorna o último lado físico PvP ("A" ou "B") registrado em memória para o jogador neste servidor. */
	public getLastPhysicalSide(player: Player): PvpPhysicalSide | undefined {
		return this.lastPhysicalSide.get(player);
	}

	/**
	 * Resolve o lado físico preferido para o desafiante buscando alternância de 90% em relação ao último PvP.
	 * - Ambos sem histórico: retorna `undefined` (sorteio justo 50/50).
	 * - Apenas um jogador com histórico: prefere colocá-lo no lado oposto.
	 * - Históricos em lados opostos: uma única inversão atende ambos simultaneamente.
	 * - Exceção de conflito (ambos no mesmo lado): é impossível alternar ambos ao mesmo tempo;
	 *   retorna `undefined` para aplicar sorteio justo 50/50 sem favorecer desafiante ou desafiado.
	 */
	private resolvePreferredChallengerSide(challenger: Player, target: Player): PvpPhysicalSide | undefined {
		const lastChallenger = this.lastPhysicalSide.get(challenger);
		const lastTarget = this.lastPhysicalSide.get(target);
		if (lastChallenger === undefined && lastTarget === undefined) return undefined;
		if (lastChallenger !== undefined && lastTarget !== undefined) {
			if (lastChallenger === lastTarget) return undefined;
			return lastChallenger === "A" ? "B" : "A";
		}
		if (lastChallenger !== undefined) return lastChallenger === "A" ? "B" : "A";
		return lastTarget === "A" ? "A" : "B";
	}

	private shouldPlaceChallengerOnSideA(challenger: Player, target: Player): boolean {
		const preferred = this.resolvePreferredChallengerSide(challenger, target);
		if (preferred === undefined) return this.rng() < PVP_SIDE_FAIR_CHANCE;
		const followPreference = this.rng() < PVP_SIDE_ALTERNATION_CHANCE;
		return followPreference ? preferred === "A" : preferred === "B";
	}

	private humanoid(player: Player): Humanoid | undefined {
		const humanoid = player.Character?.FindFirstChildOfClass("Humanoid");
		return humanoid !== undefined && humanoid.Health > 0 ? humanoid : undefined;
	}

	private inRange(a: Player, b: Player): boolean {
		const ar = a.Character?.FindFirstChild("HumanoidRootPart");
		const br = b.Character?.FindFirstChild("HumanoidRootPart");
		return ar !== undefined && ar.IsA("BasePart") && br !== undefined && br.IsA("BasePart") &&
			this.humanoid(a) !== undefined && this.humanoid(b) !== undefined && ar.Position.sub(br.Position).Magnitude <= PVP_PROMPT_MAX_DISTANCE;
	}

	/** Entrada do ProximityPrompt; nenhum remote recebe alvo ou time. */
	public challenge(challenger: Player, target: Player): boolean {
		this.step();
		if (challenger.Parent !== Players) return false;
		const now = this.clock();
		if (now < (this.nextInvite.get(challenger) ?? 0)) return false;
		this.nextInvite.set(challenger, now + PVP_INVITE_INTERVAL_SECONDS);
		if (challenger === target || !this.available(challenger) || !this.available(target) ||
			this.pending.has(challenger) || this.pending.has(target) || !this.inRange(challenger, target) ||
			now < (this.declined.get(challenger)?.get(target) ?? 0) ||
			createPlayerInventorySide(challenger, this.progression, this.data, this.rng) === undefined ||
			createPlayerInventorySide(target, this.progression, this.data, this.rng) === undefined) {
			this.sendStatus(challenger, "", "indisponivel");
			return false;
		}
		const invite: Invite = { id: HttpService.GenerateGUID(false), challenger, target, expiresAt: now + PVP_INVITE_EXPIRY_SECONDS };
		this.pending.set(challenger, invite);
		this.pending.set(target, invite);
		this.sendStatus(challenger, invite.id, "enviado");
		if (this.consume(target, "received")) pcall(() => this.received(target, { inviteId: invite.id, challengerName: challenger.Name, expiresIn: PVP_INVITE_EXPIRY_SECONDS }));
		return true;
	}

	public respond(player: Player, payload: unknown): boolean {
		if (player.Parent !== Players || !this.data.isSessionLoaded(player) || !this.consume(player, "response")) return false;
		if (!typeIs(payload, "table")) return false;
		const request = payload as { inviteId?: unknown; accept?: unknown };
		for (const [key] of pairs(payload)) if (key !== "inviteId" && key !== "accept") return false;
		if (!typeIs(request.inviteId, "string") || request.inviteId.size() === 0 || request.inviteId.size() > MAX_ITEM_UUID_LENGTH || !typeIs(request.accept, "boolean")) return false;
		this.step();
		const invite = this.pending.get(player);
		if (invite === undefined || invite.target !== player || invite.id !== request.inviteId) return false;
		if (!request.accept) {
			let targets = this.declined.get(invite.challenger);
			if (targets === undefined) { targets = new Map(); this.declined.set(invite.challenger, targets); }
			targets.set(player, this.clock() + PVP_DECLINE_WAIT_SECONDS);
			this.close(invite, "recusado");
			return true;
		}
		const a = invite.challenger;
		const b = invite.target;
		if (a === b || this.pending.get(a) !== invite || !this.available(a) || !this.available(b) || !this.inRange(a, b)) {
			this.close(invite, "indisponivel"); return false;
		}
		const first = createPlayerInventorySide(a, this.progression, this.data, this.rng);
		const second = createPlayerInventorySide(b, this.progression, this.data, this.rng);
		const ah = this.humanoid(a);
		const bh = this.humanoid(b);
		if (first === undefined || second === undefined || ah === undefined || bh === undefined) { this.close(invite, "indisponivel"); return false; }
		const releases: (() => void)[] = [];
		const release = () => { for (const restore of releases) restore(); };
		let challengerOnSideA = true;
		this.starting.add(a);
		this.starting.add(b);
		const [ok, created] = pcall(() => {
			releases.push(freezeBattleMovement(a, ah, () => this.sessions.destroySessionForPlayer(a)));
			releases.push(freezeBattleMovement(b, bh, () => this.sessions.destroySessionForPlayer(b)));
			challengerOnSideA = this.shouldPlaceChallengerOnSideA(a, b);
			return challengerOnSideA
				? this.sessions.createSession(a, b, first, second, this.rng, "PVP", release)
				: this.sessions.createSession(b, a, second, first, this.rng, "PVP", release);
		});
		this.starting.delete(a);
		this.starting.delete(b);
		if (!ok || !created) { release(); this.close(invite, "indisponivel"); return false; }
		if (a.Parent === Players) this.lastPhysicalSide.set(a, challengerOnSideA ? "A" : "B");
		if (b.Parent === Players) this.lastPhysicalSide.set(b, challengerOnSideA ? "B" : "A");
		this.close(invite, "aceito");
		return true;
	}

	public step(): void {
		const now = this.clock();
		for (const [player, invite] of this.pending) {
			if (player !== invite.challenger) continue;
			if (now >= invite.expiresAt) this.close(invite, "expirado");
			else if (!this.available(invite.challenger) || !this.available(invite.target)) this.close(invite, "indisponivel");
		}
		for (const [player, targets] of this.declined) {
			for (const [target, expiresAt] of targets) if (now >= expiresAt) targets.delete(target);
			if (targets.isEmpty()) this.declined.delete(player);
		}
	}

	private close(invite: Invite, status: ChallengeStatus): void {
		this.pending.delete(invite.challenger);
		this.pending.delete(invite.target);
		this.sendStatus(invite.challenger, invite.id, status);
		this.sendStatus(invite.target, invite.id, status);
	}

	private sendStatus(player: Player, inviteId: string, status: ChallengeStatus): void {
		if (player.Parent === Players && this.consume(player, "status")) pcall(() => this.status(player, { inviteId, status }));
	}

	private consume(player: Player, channel: string): boolean {
		let channels = this.buckets.get(player);
		if (channels === undefined) { channels = new Map(); this.buckets.set(player, channels); }
		const now = this.clock();
		let bucket = channels.get(channel);
		if (bucket === undefined) { bucket = { tokens: PVP_RESPONSE_BUCKET_CAPACITY, time: now }; channels.set(channel, bucket); }
		bucket.tokens = math.min(PVP_RESPONSE_BUCKET_CAPACITY, bucket.tokens + math.max(0, now - bucket.time) * PVP_RESPONSE_REFILL_PER_SECOND);
		bucket.time = now;
		if (bucket.tokens < 1) return false;
		bucket.tokens--;
		return true;
	}

	public forgetPlayer(player: Player): void {
		const invite = this.pending.get(player);
		if (invite !== undefined) this.close(invite, "indisponivel");
		this.sessions.destroySessionForPlayer(player);
		for (const connection of this.bindings.get(player) ?? []) connection.Disconnect();
		this.bindings.delete(player);
		this.prompts.get(player)?.Destroy();
		this.prompts.delete(player);
		this.nextInvite.delete(player);
		this.starting.delete(player);
		this.lastPhysicalSide.delete(player);
		this.declined.delete(player);
		for (const [, targets] of this.declined) targets.delete(player);
		this.buckets.delete(player);
	}
}

