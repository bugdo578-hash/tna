import { RunService } from "@rbxts/services";
import { BATTLE_EXIT_COVER_TIMEOUT_SECONDS } from "../../shared/configs/BattleIntro";
import type { BattleSessionService } from "../Services/BattleSessionService";
import type { PlayerDataService } from "../Services/PlayerDataService";
import type { ProgressionService } from "../Services/ProgressionService";
import { createDummySide, createDevOpponentSide, createPlayerInventorySide } from "./DummyFighters";

export function createDummyBattleSession(
	sessionService: BattleSessionService,
	player: Player,
	rng: () => number,
): boolean {
	return sessionService.createSession(player, undefined, createDummySide(rng), createDummySide(rng), rng);
}

/**
 * Cria sessão PVE activeTeam do inventário (lado 0) vs Anubis dev fixo (AI Bronze, lado 1).
 * O lado 0 fica 100% sob controle do jogador via BattleHUD; o lado 1 é controlado pelo AIService (Bronze).
 */
export function createJotaroVsAnubisBattleSession(
	sessionService: BattleSessionService,
	player: Player,
	progressionService: ProgressionService,
	playerDataService: PlayerDataService,
	rng: () => number,
	enableOpponentAI = true,
): boolean {
	const playerSide = createPlayerInventorySide(player, progressionService, playerDataService, rng);
	if (playerSide === undefined) return false;
	if (sessionService.hasActiveSession(player)) {
		sessionService.requestQuit(player);
		const deadline = os.clock() + 2 * BATTLE_EXIT_COVER_TIMEOUT_SECONDS;
		while (sessionService.hasActiveSession(player) && os.clock() < deadline) task.wait();
	}
	const created = sessionService.createSession(player, undefined, playerSide, createDevOpponentSide(rng), rng, "PVE");
	if (!created) return false;
	if (RunService.IsStudio()) {
		for (const fighter of playerSide.fighters) {
			print(`[testbattle] itemUuid=${fighter.itemUuid} level=${fighter.level} S1.t=${fighter.slots[0].t} S2.t=${fighter.slots[1].t} S3.t=${fighter.slots[2].t}`);
		}
	}

	if (enableOpponentAI) {
		sessionService.attachSideAI(player, 1, rng);
	}

	return true;
}
