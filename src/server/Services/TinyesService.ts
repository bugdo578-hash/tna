import { Players, RunService } from "@rbxts/services";
import { MAX_SAVED_NUMBER, TINYES_MAX_ADD_PER_CALL } from "../../shared/Config";
import type { TinyesChangedPayload } from "../../shared/Remotes";
import type { PlayerDataService } from "./PlayerDataService";

export interface TinyesResult {
	readonly ok: boolean;
	readonly balance: number;
	readonly errorMessage?: string;
}

export class TinyesService {
	public constructor(
		private readonly data: PlayerDataService,
		private readonly sendChanged: (player: Player, payload: TinyesChangedPayload) => void,
	) {
		data.onTinyesChanged = (player, balance, amount, reason) => this.publish(player, balance, amount, reason);
	}

	public getBalance(player: Player): TinyesResult {
		const balance = this.data.getTinyes(player);
		return { ok: balance !== undefined, balance: balance ?? 0, errorMessage: balance === undefined ? "Dados não carregados" : undefined };
	}

	public syncBalance(player: Player): void {
		const result = this.getBalance(player);
		if (result.ok) this.publish(player, result.balance, 0, "load");
	}

	public addTinyes(player: Player, amount: number, reason: string): TinyesResult {
		return this.change(player, amount, reason, true);
	}

	public spendTinyes(player: Player, amount: number, reason: string): TinyesResult {
		return this.change(player, amount, reason, false);
	}

	private change(player: Player, amount: number, reason: string, add: boolean): TinyesResult {
		const current = this.getBalance(player);
		if (!current.ok) return current;
		if (typeOf(amount) !== "number" || amount !== amount || amount <= 0 ||
			amount > (add ? TINYES_MAX_ADD_PER_CALL : MAX_SAVED_NUMBER) || math.floor(amount) !== amount) {
			return { ok: false, balance: current.balance, errorMessage: "Valor inválido" };
		}
		const ok = add ? this.data.addTinyes(player, amount, reason) : this.data.trySpendTinyes(player, amount, reason);
		return { ok, balance: this.getBalance(player).balance, errorMessage: ok ? undefined : "Saldo insuficiente ou limite de armazenamento" };
	}

	private publish(player: Player, balance: number, amount: number, reason: string): void {
		if (RunService.IsStudio()) {
			print(`[Tinyes] saldo=${balance} reason=${reason} valor=${amount} armazenamento=${this.data.isUsingMemoryFallback() ? "FALLBACK EM MEMÓRIA" : "DataStore real"}`);
		}
		if (player.Parent === Players) this.sendChanged(player, { balance });
	}
}
