import { Workspace } from "@rbxts/services";
import {
	BATTLE_CAMERA_ARC_SECONDS,
	BATTLE_COUNTDOWN_SECONDS,
	BATTLE_COVER_TIMEOUT_SECONDS,
	BATTLE_EXIT_COVER_TIMEOUT_SECONDS,
	BATTLE_INTRO_LEAD_SECONDS,
	BATTLE_LOADING_TIMEOUT_SECONDS,
} from "../../shared/configs/BattleIntro";
import type { BattleTransitionAck, BattleTransitionPayload } from "../../shared/Remotes";

export interface BattleTransitionChannel {
	readonly bind: (receive: (player: Player, id: number, ack: BattleTransitionAck) => void) => void;
	readonly send: (player: Player, payload: BattleTransitionPayload) => void;
}

export class BattlePreparation {
	private phase: "cover" | "loading" | "schedule" | "running" | "exit" = "cover";
	private readonly pending = new Set<Player>();
	private deadline: number;
	private goAt = 0;

	public constructor(
		private readonly id: number,
		private readonly channel: BattleTransitionChannel,
		private readonly players: readonly Player[],
		private readonly clock: () => number = () => Workspace.GetServerTimeNow(),
	) {
		this.deadline = this.clock() + BATTLE_COVER_TIMEOUT_SECONDS;
		this.resetPending();
	}

	public cover(): void {
		for (const player of this.players) this.channel.send(player, { id: this.id, phase: "cover" });
	}

	public isRunning(): boolean {
		return this.phase === "running";
	}

	public accept(player: Player, ack: BattleTransitionAck): boolean {
		if (this.clock() >= this.deadline || !this.pending.has(player)) return false;
		if (this.phase === "cover" && ack !== "covered") return false;
		if (this.phase === "loading" && ack !== "ready") return false;
		if (this.phase === "schedule" && ack !== "scheduled") return false;
		if (this.phase === "exit" && ack !== "exitCovered") return false;
		this.pending.delete(player);
		return true;
	}

	public step(): "wait" | "load" | "go" | "timeout" {
		const now = this.clock();
		if (this.phase === "running" || this.phase === "exit") return "wait";
		if (this.pending.size() > 0) return now >= this.deadline ? "timeout" : "wait";
		if (this.phase === "cover") {
			this.phase = "loading";
			this.deadline = now + BATTLE_LOADING_TIMEOUT_SECONDS;
			this.resetPending();
			return "load";
		}
		if (this.phase === "loading") {
			this.phase = "schedule";
			const arcAt = now + BATTLE_INTRO_LEAD_SECONDS;
			this.deadline = arcAt;
			this.goAt = arcAt + BATTLE_CAMERA_ARC_SECONDS + BATTLE_COUNTDOWN_SECONDS;
			this.resetPending();
			for (const player of this.players) {
				this.channel.send(player, { id: this.id, phase: "schedule", arcAt, goAt: this.goAt });
			}
			return "wait";
		}
		if (now < this.goAt) return "wait";
		this.phase = "running";
		return "go";
	}

	public beginExit(cageFrame: (player: Player) => CFrame | undefined): void {
		this.phase = "exit";
		this.deadline = this.clock() + BATTLE_EXIT_COVER_TIMEOUT_SECONDS;
		this.resetPending();
		for (const player of this.players) {
			const [ok, failure] = pcall(() => this.channel.send(player, {
				id: this.id,
				phase: "exit",
				cageFrame: cageFrame(player),
			}));
			if (!ok) {
				this.pending.delete(player);
				warn(`[BattlePreparation] saída: ${tostring(failure)}`);
			}
		}
	}

	public forget(player: Player): void {
		this.pending.delete(player);
	}

	public canFinish(): boolean {
		return this.pending.size() === 0 || this.clock() >= this.deadline;
	}

	private resetPending(): void {
		this.pending.clear();
		for (const player of this.players) this.pending.add(player);
	}
}
