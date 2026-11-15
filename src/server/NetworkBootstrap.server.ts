import { InventoryService } from "./Services/InventoryService";
import { ShopService } from "./Services/ShopService";
import { FIGHTER_DATA, rollClassBaseStats, type RealFighterId } from "../shared/FighterData";
import { calcSkillSlotRoll } from "../shared/MathUtils";
import { Players, RunService } from "@rbxts/services";
import {
	DEV_AUTO_START_DELAY_SECONDS,
	DEV_AUTO_START_TEST_BATTLE,
	DEV_TEST_BATTLE_CHAT_COMMAND,
	SHOP_REFRESH_INTERVAL_SECONDS,
} from "../shared/Config";
import { createJotaroVsAnubisBattleSession } from "./Dev/DummyBattleSession";
import { BattleSessionService } from "./Services/BattleSessionService";
import { PlayerDataService } from "./Services/PlayerDataService";
import { ProgressionService } from "./Services/ProgressionService";
import { RemoteService } from "./Services/RemoteService";
import { TinyesService } from "./Services/TinyesService";
import { NpcService } from "./Services/NpcService";
import { DayNightService } from "./Services/DayNightService";

const dayNightService = new DayNightService();
dayNightService.start();
const remoteService = new RemoteService();
const progressionService = new ProgressionService(remoteService);
const playerDataService = new PlayerDataService(progressionService);
const tinyesService = new TinyesService(playerDataService, (player, payload) => remoteService.tinyesChanged.FireClient(player, payload));
const battleSessionService = new BattleSessionService(remoteService, tinyesService, progressionService);
const inventoryService = new InventoryService(playerDataService, progressionService,
	(player) => battleSessionService.hasActiveSession(player),
	(player, payload) => remoteService.inventoryState.FireClient(player, payload));
remoteService.bindSetTeamRequest((player, uuids) => inventoryService.setTeam(player, uuids));
const shopService = new ShopService(playerDataService,
	(player) => battleSessionService.hasActiveSession(player),
	(player, payload) => remoteService.shopState.FireClient(player, payload),
	(player) => tinyesService.syncBalance(player),
	(player) => inventoryService.sync(player),
	(player, payload) => remoteService.purchaseResult.FireClient(player, payload));
remoteService.requestPurchase.OnServerEvent.Connect((player, payload) => shopService.requestPurchase(player, payload));
task.spawn(() => {
	while (true) {
		task.wait(SHOP_REFRESH_INTERVAL_SECONDS);
		for (const player of Players.GetPlayers()) shopService.refresh(player);
	}
});
battleSessionService.start();
playerDataService.start();
const npcService = new NpcService(battleSessionService, playerDataService, progressionService,
	(player, message) => remoteService.npcBattleNotice.FireClient(player, message));
npcService.start();

function handlePlayerAdded(player: Player): void {
	const loadResult = playerDataService.loadPlayer(player);
	if (!loadResult.ok) {
		return;
	}
	tinyesService.syncBalance(player);
	inventoryService.sync(player);
	shopService.sync(player);

	player.Chatted.Connect((message) => {
		if (RunService.IsStudio()) {
			const parts = message.split(" ");
			if (parts[0] === "/shop") print("[Shop]", shopService.getOffers(player));
			if (parts[0] === "/buy" && parts.size() === 2) {
				const index = tonumber(parts[1]);
				const offer = index !== undefined && math.floor(index) === index ? shopService.getOffers(player)?.[index - 1] : undefined;
				print("[Shop] compra", offer !== undefined && shopService.requestPurchase(player, { offerId: offer.offerId, requestId: `dev-${os.clock()}` }));
			}
			if (parts[0] === "/addtinyes" && parts.size() === 2) {
				const amount = tonumber(parts[1]);
				// Exceção dev ao teto de adição por chamada; continua usando o saldo único validado.
				print("[Shop] crédito dev", amount !== undefined && playerDataService.addTinyes(player, amount, "dev /addtinyes"));
			}
			if (parts[0] === "/give" && parts.size() === 2) {
				const definition = FIGHTER_DATA[parts[1] as RealFighterId];
				if (definition === undefined) { warn("fighterId inexistente: " + parts[1]); return; }
				progressionService.createInventoryFighter(player, {
					fighterId: definition.fighterId, rarity: definition.rarity,
					baseStats: rollClassBaseStats(definition.className, () => math.random()),
					skills: [calcSkillSlotRoll(1, math.random()), calcSkillSlotRoll(2, math.random()), calcSkillSlotRoll(3, math.random())],
				});
			}
		}
		if (RunService.IsStudio() && message.lower() === DEV_TEST_BATTLE_CHAT_COMMAND) {
			createJotaroVsAnubisBattleSession(battleSessionService, player, progressionService, playerDataService, () => math.random(), true);
		}
	});

	if (RunService.IsStudio() && DEV_AUTO_START_TEST_BATTLE) {
		task.delay(DEV_AUTO_START_DELAY_SECONDS, () => {
			if (player.Parent === Players && !battleSessionService.hasActiveSession(player)) {
				createJotaroVsAnubisBattleSession(battleSessionService, player, progressionService, playerDataService, () => math.random(), true);
			}
		});
	}
}

Players.PlayerAdded.Connect(handlePlayerAdded);
Players.PlayerRemoving.Connect((player) => {
	shopService.forgetPlayer(player);
	playerDataService.handlePlayerRemoving(player);
});
for (const player of Players.GetPlayers()) {
	task.spawn(handlePlayerAdded, player);
}

