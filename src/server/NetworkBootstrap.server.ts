import { Players } from "@rbxts/services";
import {
	DEV_AUTO_START_DELAY_SECONDS,
	DEV_AUTO_START_TEST_BATTLE,
	DEV_TEST_BATTLE_CHAT_COMMAND,
} from "../shared/Config";
import { createJotaroVsAnubisBattleSession } from "./Dev/DummyBattleSession";
import { BattleSessionService } from "./Services/BattleSessionService";
import { PlayerDataService } from "./Services/PlayerDataService";
import { ProgressionService } from "./Services/ProgressionService";
import { RemoteService } from "./Services/RemoteService";
import { TinyesService } from "./Services/TinyesService";

const remoteService = new RemoteService();
const progressionService = new ProgressionService(remoteService);
const playerDataService = new PlayerDataService(progressionService);
const tinyesService = new TinyesService(playerDataService, (player, payload) => remoteService.tinyesChanged.FireClient(player, payload));
const battleSessionService = new BattleSessionService(remoteService, tinyesService, progressionService);
battleSessionService.start();
playerDataService.start();

function handlePlayerAdded(player: Player): void {
	const loadResult = playerDataService.loadPlayer(player);
	if (!loadResult.ok) {
		return;
	}
	tinyesService.syncBalance(player);

	player.Chatted.Connect((message) => {
		if (message.lower() === DEV_TEST_BATTLE_CHAT_COMMAND) {
			createJotaroVsAnubisBattleSession(battleSessionService, player, progressionService, playerDataService, () => math.random(), true);
		}
	});

	if (DEV_AUTO_START_TEST_BATTLE) {
		task.delay(DEV_AUTO_START_DELAY_SECONDS, () => {
			if (player.Parent === Players && !battleSessionService.hasActiveSession(player)) {
				createJotaroVsAnubisBattleSession(battleSessionService, player, progressionService, playerDataService, () => math.random(), true);
			}
		});
	}
}

Players.PlayerAdded.Connect(handlePlayerAdded);
Players.PlayerRemoving.Connect((player) => {
	playerDataService.handlePlayerRemoving(player);
});
for (const player of Players.GetPlayers()) {
	task.spawn(handlePlayerAdded, player);
}

