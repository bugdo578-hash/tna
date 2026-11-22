import { Players, ReplicatedStorage, RunService } from "@rbxts/services";
import {
	ALLOCATE_REQUEST_BUCKET_CAPACITY,
	ALLOCATE_REQUEST_REFILL_PER_SECOND,
	BATTLE_REQUEST_BUCKET_CAPACITY,
	BATTLE_REQUEST_REFILL_PER_SECOND,
	QUIT_REQUEST_BUCKET_CAPACITY,
	QUIT_REQUEST_REFILL_PER_SECOND,
	FLOAT_TOLERANCE,
	MAX_CLIENT_FIGHTER_INDEX,
	MAX_ITEM_UUID_LENGTH,
	MAX_SKILL_SLOT,
	MIN_CLIENT_FIGHTER_INDEX,
	MIN_SKILL_SLOT,
	TOTAL_STAT_POINTS,
} from "../../shared/Config";
import {
	REMOTE_NAMES,
	REMOTES_FOLDER_NAME,
	type AttackStartedPayload,
	type AtbSyncPayload,
	type BattleEndedPayload,
	type BattleStartedPayload,
	type ClientFighterIndex,
	type EffectAppliedPayload,
	type EffectExpiredPayload,
	type EffectTickPayload,
	type FighterDiedPayload,
	type HitResolvedPayload,
	type RequestAllocatePayload,
	type RequestSkillPayload,
	type RequestSwitchPayload,
	type StateChangedPayload,
	type SwitchPerformedPayload,
} from "../../shared/Remotes";
import type { AllocatableStat, SkillSlot } from "../../shared/TypeDefs";
import type { BattleTransitionChannel } from "./BattlePreparation";

interface RequestBucket {
	tokens: number;
	lastRefillAt: number;
}

export interface BattleRemoteAdapter {
	readonly transition?: BattleTransitionChannel;
	bindRequests(
		onSkill: (player: Player, slot: SkillSlot) => void,
		onSwitch: (player: Player, index: ClientFighterIndex) => void,
		onPause: (player: Player) => void,
		onQuit: (player: Player) => void,
	): void;
	forgetPlayer(player: Player): void;
	sendBattleStarted(player: Player, payload: BattleStartedPayload): void;
	sendStateChanged(player: Player, payload: StateChangedPayload): void;
	sendSwitchPerformed(player: Player, payload: SwitchPerformedPayload): void;
	sendAttackStarted(player: Player, payload: AttackStartedPayload): void;
	sendHitResolved(player: Player, payload: HitResolvedPayload): void;
	sendEffectApplied(player: Player, payload: EffectAppliedPayload): void;
	sendEffectTick(player: Player, payload: EffectTickPayload): void;
	sendEffectExpired(player: Player, payload: EffectExpiredPayload): void;
	sendFighterDied(player: Player, payload: FighterDiedPayload): void;
	sendBattleEnded(player: Player, payload: BattleEndedPayload): void;
	sendAtbSync(player: Player, payload: AtbSyncPayload): void;
}

export class RemoteService implements BattleRemoteAdapter {
	readonly transition: BattleTransitionChannel;
	readonly challengeReceived: RemoteEvent;
	readonly requestChallengeResponse: RemoteEvent;
	readonly challengeStatus: RemoteEvent;
	readonly npcBattleNotice: RemoteEvent;
	readonly requestPurchase: RemoteEvent;
	readonly purchaseResult: RemoteEvent;
	readonly shopState: RemoteEvent;
	readonly inventoryState: RemoteEvent;
	readonly requestSetTeam: RemoteEvent;
	private readonly teamBuckets = new Map<Player, RequestBucket>();
	readonly tinyesChanged: RemoteEvent;
	readonly requestSkill: RemoteEvent;
	readonly requestSwitch: RemoteEvent;
	readonly requestPause: RemoteEvent;
	readonly requestQuit: RemoteEvent;
	readonly requestAllocate: RemoteEvent;
	readonly battleStarted: RemoteEvent;
	readonly stateChanged: RemoteEvent;
	readonly switchPerformed: RemoteEvent;
	readonly attackStarted: RemoteEvent;
	readonly hitResolved: RemoteEvent;
	readonly effectApplied: RemoteEvent;
	readonly effectTick: RemoteEvent;
	readonly effectExpired: RemoteEvent;
	readonly fighterDied: RemoteEvent;
	readonly battleEnded: RemoteEvent;
	readonly atbSync: RemoteEvent;

	private readonly requestBuckets = new Map<Player, RequestBucket>();
	private readonly quitBuckets = new Map<Player, RequestBucket>();
	private readonly transitionBuckets = new Map<Player, RequestBucket>();
	private readonly allocateBuckets = new Map<Player, RequestBucket>();
	private requestHandlersBound = false;
	private allocateHandlerBound = false;
	private onAllocateCallback?: (player: Player, payload: RequestAllocatePayload) => void;
	private onAllocateRejected?: (player: Player) => void;

	public constructor(private readonly clock: () => number = os.clock) {
		const remotesFolder = this.getOrCreateRemotesFolder();
		this.challengeReceived = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.ChallengeReceived);
		this.requestChallengeResponse = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestChallengeResponse);
		this.challengeStatus = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.ChallengeStatus);
		this.npcBattleNotice = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.NpcBattleNotice);
		this.requestPurchase = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestPurchase);
		this.purchaseResult = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.PurchaseResult);
		this.shopState = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.ShopState);
		this.inventoryState = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.InventoryState);
		this.requestSetTeam = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestSetTeam);
		this.tinyesChanged = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.TinyesChanged);
		this.requestSkill = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestSkill);
		this.requestSwitch = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestSwitch);
		this.requestPause = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestPause);
		this.requestQuit = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestQuit);
		this.requestAllocate = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.RequestAllocate);
		this.battleStarted = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.BattleStarted);
		const transition = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.BattleTransition);
		this.transition = {
			bind: (receive) => {
				transition.OnServerEvent.Connect((player, id: unknown, ack: unknown) => {
					if (!this.consumeToken(this.transitionBuckets, player, BATTLE_REQUEST_BUCKET_CAPACITY, BATTLE_REQUEST_REFILL_PER_SECOND)) return;
					if (!typeIs(id, "number") || id < 0 || id >= math.huge || id !== math.floor(id)) return;
					if (ack === "covered" || ack === "ready" || ack === "scheduled" || ack === "exitCovered" || ack === "failed" || ack === "cancel") {
						receive(player, id, ack);
					}
				});
			},
			send: (player, payload) => transition.FireClient(player, payload),
		};
		this.stateChanged = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.StateChanged);
		this.switchPerformed = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.SwitchPerformed);
		this.attackStarted = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.AttackStarted);
		this.hitResolved = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.HitResolved);
		this.effectApplied = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.EffectApplied);
		this.effectTick = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.EffectTick);
		this.effectExpired = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.EffectExpired);
		this.fighterDied = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.FighterDied);
		this.battleEnded = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.BattleEnded);
		this.atbSync = this.getOrCreateRemote(remotesFolder, REMOTE_NAMES.AtbSync);

		Players.PlayerRemoving.Connect((player) => this.forgetPlayer(player));
	}

	public bindRequests(
		onSkill: (player: Player, slot: SkillSlot) => void,
		onSwitch: (player: Player, index: ClientFighterIndex) => void,
		onPause: (player: Player) => void,
		onQuit: (player: Player) => void,
	): void {
		if (this.requestHandlersBound) return;
		this.requestHandlersBound = true;

		this.requestSkill.OnServerEvent.Connect((player, payload) => {
			if (!this.consumeRequest(player)) return;
			const slot = this.readSkillSlot(payload);
			if (slot === undefined) return;
			onSkill(player, slot);
		});

		this.requestSwitch.OnServerEvent.Connect((player, payload) => {
			if (!this.consumeRequest(player)) return;
			const index = this.readFighterIndex(payload);
			if (index === undefined) return;
			onSwitch(player, index);
		});

		this.requestPause.OnServerEvent.Connect((player, payload) => {
			if (!this.consumeRequest(player)) return;
			if (!this.isEmptyPayload(payload)) return;
			onPause(player);
		});

		this.requestQuit.OnServerEvent.Connect((player, payload) => {
			if (!this.consumeToken(this.quitBuckets, player, QUIT_REQUEST_BUCKET_CAPACITY, QUIT_REQUEST_REFILL_PER_SECOND)) return;
			if (!this.isEmptyPayload(payload)) return;
			onQuit(player);
		});
	}

	public bindSetTeamRequest(callback: (player: Player, uuids: string[]) => void): void {
		this.requestSetTeam.OnServerEvent.Connect((player, payload) => {
			if (!this.consumeToken(this.teamBuckets, player, ALLOCATE_REQUEST_BUCKET_CAPACITY, ALLOCATE_REQUEST_REFILL_PER_SECOND)) return;
			const uuids = this.readSetTeamPayload(payload);
			if (uuids !== undefined) callback(player, uuids);
		});
	}

	public readSetTeamPayload(payload: unknown): string[] | undefined {
		if (!typeIs(payload, "table")) return undefined;
		const record = payload as Record<string, unknown>;
		for (const [key] of pairs(record)) if (key !== "uuids") return undefined;
		if (!typeIs(record.uuids, "table")) return undefined;
		const values = record.uuids as defined[];
		let count = 0;
		const seen = new Set<string>();
		for (const [key, value] of pairs(values)) {
			if (!typeIs(key, "number") || key !== math.floor(key) || key < 1 || key > 3) return undefined;
			if (!typeIs(value, "string") || value.size() === 0 || value.size() > MAX_ITEM_UUID_LENGTH || seen.has(value)) return undefined;
			seen.add(value);
			count += 1;
		}
		if (count < 1 || count > 3 || values.size() !== count) return undefined;
		const result: string[] = [];
		for (const i of $range(0, count - 1)) {
			if (!typeIs(values[i], "string")) return undefined;
			result.push(values[i] as string);
		}
		return result;
	}

	public bindAllocateRequest(onAllocate: (player: Player, payload: RequestAllocatePayload) => void, onRejected?: (player: Player) => void): void {
		this.onAllocateCallback = onAllocate;
		this.onAllocateRejected = onRejected;
		if (this.allocateHandlerBound) return;
		this.allocateHandlerBound = true;

		if (RunService.IsServer() && RunService.IsRunning()) {
			this.requestAllocate.OnServerEvent.Connect((player, payload) => {
				this.processAllocateEvent(player, payload);
			});
		}
	}

	public processAllocateEvent(player: Player, payload: unknown): boolean {
		if (!this.consumeAllocateRequest(player)) {
			this.onAllocateRejected?.(player);
			return false;
		}
		const parsed = this.readAllocatePayload(payload);
		if (parsed === undefined) {
			this.onAllocateRejected?.(player);
			return false;
		}
		if (this.onAllocateCallback !== undefined) {
			this.onAllocateCallback(player, parsed);
		}
		return true;
	}

	public forgetPlayer(player: Player): void {
		this.requestBuckets.delete(player);
		this.quitBuckets.delete(player);
		this.transitionBuckets.delete(player);
		this.allocateBuckets.delete(player);
		this.teamBuckets.delete(player);
	}

	public sendBattleStarted(player: Player, payload: BattleStartedPayload): void {
		this.battleStarted.FireClient(player, payload);
	}

	public sendStateChanged(player: Player, payload: StateChangedPayload): void {
		this.stateChanged.FireClient(player, payload);
	}

	public sendSwitchPerformed(player: Player, payload: SwitchPerformedPayload): void {
		this.switchPerformed.FireClient(player, payload);
	}

	public sendAttackStarted(player: Player, payload: AttackStartedPayload): void {
		this.attackStarted.FireClient(player, payload);
	}

	public sendHitResolved(player: Player, payload: HitResolvedPayload): void {
		this.hitResolved.FireClient(player, payload);
	}

	public sendEffectApplied(player: Player, payload: EffectAppliedPayload): void {
		this.effectApplied.FireClient(player, payload);
	}

	public sendEffectTick(player: Player, payload: EffectTickPayload): void {
		this.effectTick.FireClient(player, payload);
	}

	public sendEffectExpired(player: Player, payload: EffectExpiredPayload): void {
		this.effectExpired.FireClient(player, payload);
	}

	public sendFighterDied(player: Player, payload: FighterDiedPayload): void {
		this.fighterDied.FireClient(player, payload);
	}

	public sendBattleEnded(player: Player, payload: BattleEndedPayload): void {
		this.battleEnded.FireClient(player, payload);
	}

	public sendAtbSync(player: Player, payload: AtbSyncPayload): void {
		this.atbSync.FireClient(player, payload);
	}

	private getOrCreateRemotesFolder(): Folder {
		const existing = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (existing?.IsA("Folder")) return existing;
		if (existing !== undefined) existing.Destroy();

		const folder = new Instance("Folder");
		folder.Name = REMOTES_FOLDER_NAME;
		folder.Parent = ReplicatedStorage;
		return folder;
	}

	private getOrCreateRemote(folder: Folder, name: string): RemoteEvent {
		const existing = folder.FindFirstChild(name);
		if (existing?.IsA("RemoteEvent")) return existing;
		if (existing !== undefined) existing.Destroy();

		const remote = new Instance("RemoteEvent");
		remote.Name = name;
		remote.Parent = folder;
		return remote;
	}

	private readSkillSlot(payload: unknown): SkillSlot | undefined {
		if (typeOf(payload) !== "table") return undefined;
		const slot = (payload as RequestSkillPayload).slot as number;
		if (typeOf(slot) !== "number" || math.floor(slot) !== slot) return undefined;
		if (slot < MIN_SKILL_SLOT || slot > MAX_SKILL_SLOT) return undefined;
		return slot as SkillSlot;
	}

	private readFighterIndex(payload: unknown): ClientFighterIndex | undefined {
		if (typeOf(payload) !== "table") return undefined;
		const index = (payload as RequestSwitchPayload).index as number;
		if (typeOf(index) !== "number" || math.floor(index) !== index) return undefined;
		if (index < MIN_CLIENT_FIGHTER_INDEX || index > MAX_CLIENT_FIGHTER_INDEX) return undefined;
		return index as ClientFighterIndex;
	}

	private isEmptyPayload(payload: unknown): boolean {
		return payload === undefined;
	}

	public readAllocatePayload(payload: unknown): RequestAllocatePayload | undefined {
		if (typeOf(payload) !== "table") return undefined;
		const record = payload as Record<string, unknown>;
		for (const [key] of pairs(record)) {
			if (key !== "itemUuid" && key !== "stat" && key !== "amount") {
				return undefined;
			}
		}

		const itemUuid = record.itemUuid;
		if (
			typeOf(itemUuid) !== "string" ||
			(itemUuid as string).size() === 0 ||
			(itemUuid as string).size() > MAX_ITEM_UUID_LENGTH
		) {
			return undefined;
		}

		const stat = record.stat;
		if (stat !== "hp" && stat !== "atk" && stat !== "dodge" && stat !== "crit") {
			return undefined;
		}

		const amount = record.amount;
		if (typeOf(amount) !== "number") return undefined;
		const numericAmount = amount as number;
		if (
			numericAmount !== numericAmount ||
			math.floor(numericAmount) !== numericAmount ||
			numericAmount < 1 ||
			numericAmount > TOTAL_STAT_POINTS
		) {
			return undefined;
		}

		return {
			itemUuid: itemUuid as string,
			stat: stat as AllocatableStat,
			amount: numericAmount,
		};
	}

	private consumeRequest(player: Player): boolean {
		return this.consumeToken(
			this.requestBuckets,
			player,
			BATTLE_REQUEST_BUCKET_CAPACITY,
			BATTLE_REQUEST_REFILL_PER_SECOND,
		);
	}

	private consumeAllocateRequest(player: Player): boolean {
		return this.consumeToken(
			this.allocateBuckets,
			player,
			ALLOCATE_REQUEST_BUCKET_CAPACITY,
			ALLOCATE_REQUEST_REFILL_PER_SECOND,
		);
	}

	private consumeToken(
		buckets: Map<Player, RequestBucket>,
		player: Player,
		capacity: number,
		refillPerSecond: number,
	): boolean {
		const now = this.clock();
		let bucket = buckets.get(player);
		if (bucket === undefined) {
			bucket = { tokens: capacity, lastRefillAt: now };
			buckets.set(player, bucket);
		} else {
			const elapsed = math.max(now - bucket.lastRefillAt, 0);
			bucket.tokens = math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
			bucket.lastRefillAt = now;
		}
		if (bucket.tokens + FLOAT_TOLERANCE < 1) return false;
		bucket.tokens = math.max(bucket.tokens - 1, 0);
		return true;
	}
}
