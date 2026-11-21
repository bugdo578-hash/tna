// Testes de duelos PVP 1v1, convites, persistência v4, tetos diários de Tinyes/XP e regra de luta mínima.
import { Players, Workspace } from "@rbxts/services";
import {
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	MAX_LEVEL,
	MAX_SAVED_NUMBER,
	NPC_BATTLE_ACTIVE_ATTRIBUTE,
	PLAYER_DATA_SCHEMA_VERSION,
	PVP_DAILY_TINYES_CAP,
	PVP_DAILY_XP_CAP,
	PVP_DAY_SECONDS,
	PVP_DECLINE_WAIT_SECONDS,
	PVP_INVITE_EXPIRY_SECONDS,
	PVP_INVITE_INTERVAL_SECONDS,
	PVP_MAX_PAIR_ENTRIES,
	PVP_PAIR_WINDOW_SECONDS,
	PVP_PROMPT_MAX_DISTANCE,
	TINYES_WIN_BY_TIER,
} from "../../../shared/Config";
import { calcSkillSlotRoll } from "../../../shared/MathUtils";
import { calcBattleTotalXp, calcFighterSlotXp, calcPostBattleTeamXp } from "../../../shared/ProgressionMath";
import type {
	BattleEndedPayload,
	BattleStartedPayload,
	ChallengeReceivedPayload,
	ChallengeStatusPayload,
} from "../../../shared/Remotes";
import { calcAverageLevel, calcRewardBracket } from "../../../shared/RewardMath";
import type { FighterInventoryItem, SkillSlot } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { freezeBattleMovement } from "../../Services/BattleMovement";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { InventoryService } from "../../Services/InventoryService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import {
	InMemoryDataStore,
	migratePlayerData,
	validatePlayerSaveData,
	type DataStoreLike,
	type PlayerSaveData,
} from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { PvpService } from "../../Services/PvpService";
import { RemoteService } from "../../Services/RemoteService";
import { TinyesService } from "../../Services/TinyesService";
import { createDummySide, makeDummyFighter } from "../DummyFighters";
import {
	assertInvariant,
	assertStoredEqual,
	createSeededRng,
	createSurgicalMockAdapter,
	FIRST_SIMULATION_SEED,
	SIMULATION_DT,
	xpToReach,
} from "./testHelpers";

/** Tetos independentes, migração v3 -> v4 e dano mínimo com hits reais, sem DataStore real. */
export function validatePvpDailyXpAndMinimumFight(): void {
	let userId = 994000;
	for (const outcome of ["partial", "partialThird", "full", "tinyesFull", "bothFull", "cap", "nearCap", "notifyError",
		"quitBelow", "quitExact", "disconnectBelow", "disconnectExact", "quitFew", "overkill", "opponentDamage"] as const) {
		const a = { Parent: Players, Name: outcome, UserId: userId++ } as unknown as Player;
		const b = { Parent: Players as Players | undefined, Name: "Opponent", UserId: userId++ };
		let now = PVP_DAY_SECONDS + 100;
		const store = new InMemoryDataStore();
		const progression = new ProgressionService();
		const options = { dataStore: store, serverId: "DailyXp", now: () => now, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true };
		let data = new PlayerDataService(progression, options);
		assertInvariant(data.loadPlayer(a).ok && data.loadPlayer(b as unknown as Player).ok, "load teto XP");
		const original = data.getPlayerSaveSnapshot(a)!;
		const inventory = [0, 1, 2].map(index => ({ ...original.inventory[0], itemUuid: `daily-${index}`,
			level: outcome === "cap" || outcome === "nearCap" ? (outcome === "nearCap" && index === 0 ? 29 : 30) : 1,
			xp: outcome === "nearCap" && index === 0 ? 2899 : 0 }));
		progression.loadValidatedPlayerData(a, { version: PLAYER_DATA_SCHEMA_VERSION, inventory });
		data.setActiveTeam(a, inventory.map(item => item.itemUuid));
		const state = (data as unknown as { sessions: Map<Player, { pvp: NonNullable<PlayerSaveData["pvp"]> }> }).sessions.get(a)!.pvp;
		const budget = outcome === "partial" ? 60 : outcome === "partialThird" ? 75 : outcome === "full" || outcome === "bothFull" ? 0 : PVP_DAILY_XP_CAP;
		state.dailyXp = PVP_DAILY_XP_CAP - budget;
		if (outcome === "tinyesFull" || outcome === "bothFull") state.dailyTinyes = PVP_DAILY_TINYES_CAP;
		const xpBefore = state.dailyXp;
		const before = data.getPlayerSaveSnapshot(a)!;
		const roll = { t: 0.5, cost: 1.875, mult: 1 };
		const timeline = { prepareTime: 0.1, hits: [0.1, 0.2, 0.3].map(time => ({ time, damageShare: 1, followUp: false })), returnTime: 0.1, dodgeReturnTime: 0.1 };
		const makeFighter = (item: FighterInventoryItem, atk: number) => new Fighter({ itemUuid: item.itemUuid, fighterId: item.fighterId,
			hp: 100, hpMax: 100, stats: { hp: 100, atk, crit: 0, dodge: 0 }, level: item.level, className: "Fury",
			slots: [roll, roll, roll], skillData: [timeline, timeline, timeline], currentAtbSpeed: 0 });
		const own = new BattleSide([makeFighter(inventory[0], outcome === "quitBelow" || outcome === "disconnectBelow" ? 48 : 50),
			makeFighter(inventory[1], 50), makeFighter(inventory[2], 50)], () => 0.5);
		const enemy = new BattleSide([makeFighter(original.inventory[0], 50), makeFighter(original.inventory[0], 50), makeFighter(original.inventory[0], 50)], () => 0.5);
		const ends = new Map<Player, BattleEndedPayload>();
		const sessions = new BattleSessionService(createSurgicalMockAdapter({ onBattleEnded: (player, payload) => { ends.set(player, payload); } }), new TinyesService(data, () => {}), progression);
		assertInvariant(sessions.createSession(a, b as unknown as Player, own, enemy, () => 0.5, "PVP"), "sessao teto XP");
		const record = (sessions as unknown as { activeSessions: { battle: BattleService; resolvedHits: number }[] }).activeSessions[0];
		const quitting = outcome === "quitBelow" || outcome === "quitExact" || outcome === "disconnectBelow" || outcome === "disconnectExact" || outcome === "quitFew" || outcome === "overkill" || outcome === "opponentDamage";
		if (quitting) {
			if (outcome === "overkill") enemy.fighters[0].hp = 1;
			const attacking = outcome === "opponentDamage" ? enemy : own;
			attacking.setAtb(10);
			assertInvariant(record.battle.requestSkill(attacking, 1), `${outcome}: inicia tres hits reais`);
			for (let step = 0; step < 30; step++) record.battle.step(SIMULATION_DT);
			assertInvariant(record.resolvedHits === (outcome === "overkill" ? 1 : 3), "somente hits realmente resolvidos");
			const realDamage = record.battle.getDamageDealt(own, inventory[0].itemUuid);
			if (outcome === "quitBelow" || outcome === "disconnectBelow") assertInvariant(realDamage === 72, "24% do HP total");
			if (outcome === "quitExact" || outcome === "disconnectExact") assertInvariant(realDamage === 75, "25% exatos do HP total");
			if (outcome === "overkill") assertInvariant(realDamage === 1, "overkill e hits ignorados excluidos do dano acumulado");
			if (outcome === "opponentDamage") assertInvariant(realDamage === 0, "dano do oponente nao conta para vencedor");
			if (outcome === "quitFew") record.resolvedHits = 2;
			if (outcome === "disconnectBelow" || outcome === "disconnectExact") { b.Parent = undefined; sessions.destroySessionForPlayer(b as unknown as Player); }
			else sessions.requestQuit(b as unknown as Player);
		} else {
			record.resolvedHits = 3;
			if (outcome === "notifyError") progression.onInventoryChanged = () => error("falha intencional apos commit XP");
			record.battle.events.battleEnd.fire(own);
		}
		const after = data.getPlayerSaveSnapshot(a)!;
		const pvpEnd = ends.get(a)!;
		const short = outcome === "quitBelow" || outcome === "disconnectBelow" || outcome === "quitFew" || outcome === "overkill" || outcome === "opponentDamage";
		if (short) {
			assertInvariant(pvpEnd.rewardBlockedReason === "luta_curta" && pvpEnd.tinyesReward === 0 && pvpEnd.xpRewards === undefined, `${outcome}: bloqueia ambas recompensas`);
			assertStoredEqual(after.inventory, before.inventory, "luta curta preserva inventario");
			assertStoredEqual(after.pvp, before.pvp, "luta curta preserva contadores");
		} else {
			const expectedXp = outcome === "partial" ? [45, 15, 0] : outcome === "partialThird" ? [45, 22, 8] :
				outcome === "cap" || budget === 0 ? [0, 0, 0] : outcome === "nearCap" ? [1, 0, 0] : outcome === "notifyError" ? [45, 0, 0] : [45, 22, 22];
			const total = expectedXp.reduce((sum, xp) => sum + xp, 0);
			assertInvariant(after.pvp!.dailyXp === xpBefore + total, `${outcome}: contabiliza somente XP util`);
			if (budget === 0) assertInvariant(pvpEnd.xpRewards === undefined && pvpEnd.rewardBlockedReason === "limite_diario_xp", "corte total explica limite XP");
			else if (outcome !== "notifyError") assertStoredEqual(pvpEnd.xpRewards!.map(reward => reward.xpGained), expectedXp, `${outcome}: corte deterministico por slot`);
			assertInvariant((pvpEnd.tinyesReward ?? 0) === (outcome === "tinyesFull" || outcome === "bothFull" ? 0 : 100), "teto XP nao bloqueia Tinyes");
			if (outcome === "tinyesFull") assertInvariant(pvpEnd.rewardBlockedReason === "limite_diario", "teto Tinyes permite XP");
		}
		record.battle.events.battleEnd.fire(own);
		assertStoredEqual(data.getPlayerSaveSnapshot(a), after, "recompensas e dailyXp pagos uma vez");
		progression.onInventoryChanged = undefined;
		assertInvariant(data.savePlayer(a).ok, "salva dailyXp");
		data.handlePlayerRemoving(a);
		data.handlePlayerRemoving(b as unknown as Player);
		data = new PlayerDataService(progression, options);
		assertInvariant(data.loadPlayer(a).ok, "carrega dailyXp em novo servico");
		assertStoredEqual(data.getPlayerSaveSnapshot(a)!.pvp, after.pvp, "dailyXp persiste apos save/load");
		assertStoredEqual(data.getPlayerSaveSnapshot(a)!.inventory, after.inventory, "inventario persiste junto com dailyXp");
		now = (math.floor(now / PVP_DAY_SECONDS) + 1) * PVP_DAY_SECONDS;
		assertInvariant(data.getRemainingPvpXp(a) === PVP_DAILY_XP_CAP && data.getPlayerSaveSnapshot(a)!.pvp!.dailyXp === 0, "virada do dia zera dailyXp");
		data.handlePlayerRemoving(a);
	}

	const legacyFighter: FighterInventoryItem = { itemUuid: "legacy-v3", fighterId: "jotaro", rarity: "Lendária", level: 4, xp: 80,
		baseStats: { hp: 16, atk: 11, dodge: 7, crit: 10 }, allocatedStats: { hp: 2, atk: 2, dodge: 1, crit: 1 },
		skills: [calcSkillSlotRoll(1, 0.33), calcSkillSlotRoll(2, 0.44), calcSkillSlotRoll(3, 0.55)] };
	const legacy = { version: 3, tinyes: 123, inventory: [legacyFighter], activeTeam: [legacyFighter.itemUuid], shopRestockCounts: [3, 4, 5],
		pvp: { pairs: { opponent: { count: 2, windowStart: 123 } }, dailyTinyes: 456, dayKey: 7 },
		sessionLock: { serverId: "legacy", sessionId: "legacy-session", timestamp: 124 } };
	assertInvariant(validatePlayerSaveData(legacy, 3).valid && !validatePlayerSaveData({ ...legacy, version: 4 }).valid, "v4 exige dailyXp");
	const migrated = migratePlayerData(legacy)!;
	assertInvariant(validatePlayerSaveData(migrated, 4).valid, "migração v3 -> v4 validada");
	assertStoredEqual(migrated, { ...legacy, version: 4, pvp: { ...legacy.pvp, dailyXp: 0 } }, "migração acrescenta somente dailyXp e versao");
	assertInvariant(!("dailyXp" in legacy.pvp), "migração nao altera origem");
	for (const dailyXp of [-1, 0.5, math.huge, -math.huge, 0 / 0, MAX_SAVED_NUMBER + 1, "0"]) {
		assertInvariant(!validatePlayerSaveData({ ...migrated, pvp: { ...legacy.pvp, dailyXp } }).valid, "dailyXp invalido rejeitado");
	}
	assertInvariant(validatePlayerSaveData({ ...migrated, pvp: { ...legacy.pvp, dailyXp: MAX_SAVED_NUMBER } }).valid, "dailyXp aceita MAX_SAVED_NUMBER");
	assertStoredEqual(migratePlayerData({ ...legacy, pvp: { ...legacy.pvp, dailyXp: 321 } })!.pvp, { ...legacy.pvp, dailyXp: 321 }, "migração preserva dailyXp existente");
	assertInvariant(migratePlayerData({ ...legacy, pvp: { ...legacy.pvp, dailyXp: -1 } }) === undefined, "migração valida novo campo");
	print("PVP_DAILY_XP_AND_MINIMUM_FIGHT_PASSED");
}

/** PVP: snapshots finais, dois destinatarios e estado persistido, sem DataStore real. */
export function validatePvpBattles(): void {
	assertInvariant(calcAverageLevel([1, 2, 3]) === 2 && calcAverageLevel([25, 26, 27, 28, 29, 30]) === 27.5, "media 3 contra 6");
	assertInvariant(calcAverageLevel([30]) === 30 && calcAverageLevel([1, 1, 1]) === 1, "media 1 contra 3 sem zeros");
	assertInvariant(calcRewardBracket(30).name === "Ouro" && calcRewardBracket(1).name === "Bronze" && calcRewardBracket(19.9).name === "Prata", "faixa do perdedor e limites fracionarios");
	let userId = 992100;
	const makePlayer = () => {
		const character = new Instance("Model");
		const root = new Instance("Part"); root.Name = "HumanoidRootPart"; root.Anchored = true; root.Parent = character;
		const humanoid = new Instance("Humanoid"); humanoid.WalkSpeed = 23; humanoid.JumpPower = 61; humanoid.JumpHeight = 9;
		humanoid.UseJumpPower = userId % 2 === 0; humanoid.Parent = character;
		const removing = new Instance("BindableEvent");
		const attributes = new Map<string, AttributeValue>();
		const mock = { Parent: Players as Players | undefined, Name: `PvpTest${userId}`, UserId: userId++, Character: character,
			CharacterRemoving: removing.Event, SetAttribute(name: string, value: AttributeValue): void { attributes.set(name, value); } };
		return { player: mock as unknown as Player, mock, root, humanoid, removing, attributes, character,
			usePower: humanoid.UseJumpPower };
	};
	const restored = (p: ReturnType<typeof makePlayer>) => assertInvariant(p.humanoid.WalkSpeed === 23 && p.humanoid.JumpPower === 61 &&
		p.humanoid.JumpHeight === 9 && p.humanoid.UseJumpPower === p.usePower, "movimento original restaurado");
	for (const roll of [0.1, 0.9]) {
		for (const outcome of ["victory", "quit", "disconnect", "timeout", "error", "short", "daily", "partial", "startError", "respawn", "endError"] as const) {
			const a = makePlayer(); const b = makePlayer();
			let now = 1000;
			const progression = new ProgressionService();
			const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(), serverId: "PvpTest", now: () => now,
				waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true });
			assertInvariant(data.loadPlayer(a.player).ok && data.loadPlayer(b.player).ok, "load dois jogadores");
			const original = progression.getPlayerData(b.player)!.inventory[0];
			progression.loadValidatedPlayerData(b.player, { version: PLAYER_DATA_SCHEMA_VERSION, inventory: [{ ...original, level: 30 }] });
			const starts = new Map<Player, BattleStartedPayload>();
			const ends = new Map<Player, BattleEndedPayload>();
			const sessions = new BattleSessionService(createSurgicalMockAdapter({
				onBattleStarted: (player, payload) => { if (outcome === "startError") error("PVP start intencional"); starts.set(player, payload); },
				onBattleEnded: (player, payload) => { if (outcome === "endError" && player === b.player) error("PVP end intencional"); ends.set(player, payload); },
			}), new TinyesService(data, () => {}), progression);
			let invite: ChallengeReceivedPayload | undefined;
			const statuses: ChallengeStatusPayload[] = [];
			const pvp = new PvpService(sessions, data, progression, (player, payload) => { assertInvariant(player === b.player, "convite privado"); invite = payload; },
				(_, payload) => statuses.push(payload), () => now, () => roll);
			assertInvariant(!pvp.challenge(a.player, a.player), "recusa si mesmo"); now += PVP_INVITE_INTERVAL_SECONDS;
			b.root.Position = new Vector3(PVP_PROMPT_MAX_DISTANCE + 1, 0, 0);
			assertInvariant(!pvp.challenge(a.player, b.player), "recusa longe"); now += PVP_INVITE_INTERVAL_SECONDS;
			b.root.Position = a.root.Position;
			const raw = data as unknown as { sessions: Map<Player, { activeTeam: string[] }> };
			const team = [...data.getActiveTeam(a.player)!]; raw.sessions.get(a.player)!.activeTeam = [];
			assertInvariant(!pvp.challenge(a.player, b.player), "recusa time vazio"); now += PVP_INVITE_INTERVAL_SECONDS;
			raw.sessions.get(a.player)!.activeTeam = team;
			const beforeA = data.getPlayerSaveSnapshot(a.player)!; const beforeB = data.getPlayerSaveSnapshot(b.player)!;
			assertInvariant(pvp.challenge(a.player, b.player) && invite !== undefined, "convite valido");
			assertInvariant(!pvp.challenge(b.player, a.player), "convite cruzado duplicado recusado");
			assertInvariant(!pvp.respond(a.player, { inviteId: invite!.inviteId, accept: true }), "desafiante nao pode aceitar");
			const accepted = pvp.respond(b.player, { inviteId: invite!.inviteId, accept: true });
			if (outcome !== "startError") {
				assertInvariant(accepted && sessions.hasActiveSession(a.player) && sessions.hasActiveSession(b.player), "dois jogadores na sessao");
				const record = (sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide]; resolvedHits: number; reason?: string }[] }).activeSessions[0];
				const ai = roll < 0.5 ? 0 : 1; const bi = ai === 0 ? 1 : 0;
				const own = record.sides[ai]; const enemy = record.sides[bi];
				assertStoredEqual(own.fighters.map(f => f.itemUuid), beforeA.activeTeam, "time A vem do inventario");
				assertStoredEqual(enemy.fighters.map(f => f.itemUuid), beforeB.activeTeam, "time B vem do inventario");
				assertStoredEqual(own.fighters[0].slots, beforeA.inventory[0].skills, "rolls sem alteracao");
				const ap = starts.get(a.player)!; const bp = starts.get(b.player)!;
				assertInvariant(ap.sides[0] === bp.sides[1] && ap.sides[1] === bp.sides[0] && ap.canPause === false && bp.canPause === false, "IDs reais com ordem privada");
				assertInvariant(ap.fighters.find(f => f.sideId === ap.sides[0])!.level === 1 && bp.fighters.find(f => f.sideId === bp.sides[0])!.level === 30, "cada client ve proprio time nos dois sorteios");
				assertInvariant(!sessions.requestPause(a.player), "PVP sem pause");
				// Pedidos usam o mapeamento Player -> BattleSide, nunca o ?ndice visual.
				const requests = sessions as unknown as { handleSkillRequest(player: Player, slot: SkillSlot): void };
				own.setAtb(10); enemy.setAtb(10);
				for (const fighter of [...own.fighters, ...enemy.fighters]) { fighter.hp = 100000; }
				requests.handleSkillRequest(b.player, 2);
				assertInvariant(enemy.atb < 10 && own.atb === 10, "B controla seu proprio lado");
				for (let i = 0; i < 150; i++) sessions.step(SIMULATION_DT);
				own.setAtb(10); requests.handleSkillRequest(a.player, 2);
				assertInvariant(own.atb < 10, "A controla seu proprio lado");
				for (let i = 0; i < 150; i++) sessions.step(SIMULATION_DT);
				assertInvariant(record.resolvedHits >= 3, "hits resolvidos reais contabilizados");
				// Nova captura nao pode substituir valores originais pelo zero.
				const releaseAgain = freezeBattleMovement(a.player, a.humanoid, () => {});
				if (outcome === "short") record.resolvedHits = 2;
				if (outcome === "daily" || outcome === "partial") {
					const state = (data as unknown as { sessions: Map<Player, { pvp: { dailyTinyes: number; dayKey: number } }> }).sessions.get(a.player)!;
					state.pvp.dailyTinyes = PVP_DAILY_TINYES_CAP - (outcome === "partial" ? 25 : 0);
					state.pvp.dayKey = math.floor(now / PVP_DAY_SECONDS);
				}
				if (outcome === "victory" || outcome === "short" || outcome === "daily" || outcome === "partial" || outcome === "endError") { record.battle.events.battleEnd.fire(own); sessions.step(0); }
				else if (outcome === "quit") sessions.requestQuit(b.player);
				else if (outcome === "disconnect") { b.mock.Parent = undefined; sessions.destroySessionForPlayer(b.player); }
				else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
				else if (outcome === "error") { record.battle.step = () => error("PVP step intencional"); sessions.step(SIMULATION_DT); }
				else { b.removing.Fire(b.character); task.wait(); }
				const after = data.getPlayerSaveSnapshot(a.player)!;
				const paid = outcome === "partial" || outcome === "victory" || outcome === "quit" || outcome === "disconnect" || outcome === "respawn" || outcome === "endError";
				const expected = outcome === "partial" ? 25 : paid ? 170 + math.floor(roll * 181) : 0;
				assertInvariant(after.tinyes - beforeA.tinyes === expected, `${outcome}: premio da faixa Ouro do perdedor`);
				assertInvariant(data.getTinyes(b.player) === beforeB.tinyes, "perdedor zero");
				const xpPaid = paid || outcome === "daily";
				if (!xpPaid) assertStoredEqual(after.inventory, beforeA.inventory, "PVP bloqueado nao paga XP");
				assertStoredEqual(data.getPlayerSaveSnapshot(b.player)!.inventory, beforeB.inventory, "perdedor nao recebe XP");
				assertInvariant(ends.get(b.player)?.xpRewards === undefined, "XP privado do vencedor");
				if (xpPaid) {
					assertInvariant(ends.get(a.player)?.xpRewards?.[0].xpGained === 708, "Lv1 vence Lv30: floor(525 * 1.35) = 708");
					assertInvariant(data.savePlayer(a.player).ok && data.loadPlayer(a.player).ok, "save/load XP PVP");
					assertStoredEqual(data.getPlayerSaveSnapshot(a.player)!.inventory, after.inventory, "XP PVP persiste");
					assertInvariant(data.getPlayerSaveSnapshot(a.player)!.pvp!.dailyXp === 708, "dailyXp PVP persiste");
				}
				assertInvariant((ends.get(a.player)?.tinyesReward ?? 0) === expected && (xpPaid || ends.get(a.player)?.xpRewards === undefined), "resultado privado XP");
				if (outcome === "short") assertInvariant(ends.get(a.player)?.rewardBlockedReason === "luta_curta", "bloqueio luta curta");
				assertInvariant(record.reason === (outcome === "short" || outcome === "daily" || outcome === "partial" || outcome === "endError" ? "victory" : outcome === "respawn" ? "disconnect" : outcome), "motivo registrado");
				record.battle.events.battleEnd.fire(own); sessions.requestQuit(b.player);
				assertStoredEqual(data.getPlayerSaveSnapshot(a.player), after, "pagamento unico");
				restored(a); restored(b);
				a.humanoid.WalkSpeed = 29; releaseAgain(); assertInvariant(a.humanoid.WalkSpeed === 29, "restauracao nunca roda duas vezes");
				if (outcome === "victory") {
					a.humanoid.WalkSpeed = 23;
					for (const win of [2, 3, 4]) {
						now += PVP_INVITE_INTERVAL_SECONDS;
						assertInvariant(pvp.challenge(a.player, b.player) && pvp.respond(b.player, { inviteId: invite!.inviteId, accept: true }), "revanche permitida mesmo sem premio");
						const rematch = (sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide]; resolvedHits: number }[] }).activeSessions[0];
						const rematchPlayerSessions = (sessions as unknown as { playerSessions: Map<Player, { side: BattleSide }> }).playerSessions;
						// Fixture da duracao: hits reais ja foram exercitados acima.
						rematch.resolvedHits = 3;
						rematch.battle.events.battleEnd.fire(rematchPlayerSessions.get(win === 4 ? b.player : a.player)!.side);
						sessions.step(0);
						if (win === 2) assertInvariant(ends.get(a.player)?.tinyesReward === expected, "segunda vitoria paga");
						if (win === 3) assertInvariant(ends.get(a.player)?.tinyesReward === 0 && ends.get(a.player)?.rewardBlockedReason === "limite_par" && ends.get(a.player)?.xpRewards === undefined, "terceira vitoria bloqueada no BattleEnded");
						if (win === 4) assertInvariant(ends.get(b.player)?.xpRewards?.[0].xpGained === 0, "Lv30 no cap recebe zero XP util");
						if (win === 4) assertInvariant(data.getPlayerSaveSnapshot(b.player)!.pvp!.dailyXp === 0, "Lv30 nao consome teto diario XP");
						if (win === 4) assertInvariant(ends.get(b.player)?.tinyesReward === 50 + math.floor(roll * 101) && ends.get(a.player)?.tinyesReward === undefined, "Lv30 vence Lv1: Bronze e direcao independente");
						restored(a); restored(b);
					}
					assertInvariant(data.getTinyes(a.player) === beforeA.tinyes + expected * 2, "saldo final de tres vitorias limitado a dois premios");
				}
			} else assertInvariant(!accepted, "erro de criacao rejeita");
			assertInvariant(!sessions.hasActiveSession(a.player) && !sessions.hasActiveSession(b.player), "sessoes liberadas");
			if (outcome === "startError") { restored(a); restored(b); }
			assertInvariant(a.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false && b.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false, "atributos liberados");
			b.mock.Parent = Players;
			pvp.forgetPlayer(a.player); pvp.forgetPlayer(b.player);
			data.handlePlayerRemoving(a.player); data.handlePlayerRemoving(b.player);
			a.character.Destroy(); b.character.Destroy(); a.removing.Destroy(); b.removing.Destroy();
		}
	}
	assertInvariant(calcPostBattleTeamXp(1, true, [{ level: 30, damageDealt: 1 }])[0] === 4, "Lv30 contra Lv1: floor(90 * 0.05) = 4 antes do cap");
	print("PVP_BATTLES_PASSED");

	const a = makePlayer(); const b = makePlayer();
	let now = 1000;
	const store = new InMemoryDataStore(); const progression = new ProgressionService();
	const options = { dataStore: store, serverId: "PvpPersistence", now: () => now, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true };
	let data = new PlayerDataService(progression, options);
	assertInvariant(data.loadPlayer(a.player).ok && data.loadPlayer(b.player).ok, "load anti-farm");
	const sessions = new BattleSessionService(createSurgicalMockAdapter({}));
	let inviteId = "";
	const statuses: ChallengeStatusPayload[] = [];
	const pvp = new PvpService(sessions, data, progression, (_, p) => inviteId = p.inviteId, (_, p) => statuses.push(p), () => now);
	assertInvariant(pvp.challenge(a.player, b.player) && pvp.respond(b.player, { inviteId, accept: false }), "recusa convite");
	restored(a); restored(b); now += PVP_INVITE_INTERVAL_SECONDS;
	assertInvariant(!pvp.challenge(a.player, b.player), "espera apos recusa do mesmo par");
	now += PVP_DECLINE_WAIT_SECONDS;
	assertInvariant(pvp.challenge(a.player, b.player), "recusa libera ambos");
	now += PVP_INVITE_EXPIRY_SECONDS;
	assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }) && statuses.some(p => p.status === "expirado"), "aceite expirado recusado");
	restored(a); restored(b);
	assertInvariant(pvp.challenge(a.player, b.player), "expiracao libera ambos");
	b.root.Position = new Vector3(PVP_PROMPT_MAX_DISTANCE + 1, 0, 0);
	assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }), "aceite revalida distancia");
	restored(a); restored(b);
	b.root.Position = a.root.Position;
	for (const invalid of ["unavailable", "battle", "unloaded", "outside"] as const) {
		now += PVP_INVITE_EXPIRY_SECONDS;
		assertInvariant(pvp.challenge(a.player, b.player), "convite antes da mudanca de estado");
		const savedInventory = progression.getPlayerData(b.player)!;
		const dataInternals = data as unknown as { sessions: Map<Player, unknown> };
		const loadedSession = dataInternals.sessions.get(b.player);
		if (invalid === "unavailable") progression.loadValidatedPlayerData(b.player, { ...savedInventory, inventory: savedInventory.inventory.map(item => ({ ...item, unavailable: true })) });
		if (invalid === "battle") sessions.createSession(b.player, undefined, createDummySide(() => 0.5), createDummySide(() => 0.5), () => 0.5);
		if (invalid === "unloaded") dataInternals.sessions.delete(b.player);
		if (invalid === "outside") b.mock.Parent = undefined;
		assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }), `${invalid}: aceite revalida estado`);
		now += PVP_INVITE_EXPIRY_SECONDS; pvp.step();
		assertInvariant(!pvp.challenge(a.player, b.player), `${invalid}: convite tambem rejeita estado`);
		b.mock.Parent = Players;
		dataInternals.sessions.set(b.player, loadedSession);
		progression.loadValidatedPlayerData(b.player, savedInventory);
		// A reconciliacao remove unavailable de activeTeam; restaura somente a fixture.
		data.setActiveTeam(b.player, savedInventory.inventory.map(item => item.itemUuid));
		sessions.requestQuit(b.player);
		restored(a); restored(b);
	}
	now += PVP_INVITE_EXPIRY_SECONDS;
	assertInvariant(pvp.challenge(a.player, b.player), "convite para teste do bucket");
	for (let i = 0; i < 3; i++) assertInvariant(!pvp.respond(b.player, { inviteId, accept: "true" }), "boolean estrito");
	assertInvariant(!pvp.respond(b.player, { inviteId, accept: true }) && !sessions.hasActiveSession(b.player), "rate limit proprio bloqueia resposta");
	now += 1;
	assertInvariant(pvp.respond(b.player, { inviteId, accept: false }), "bucket repoe e recusa libera ambos");
	const original = data.getPlayerSaveSnapshot(a.player)!;
	const legacy = { ...original, version: 2, pvp: undefined };
	const migrated = migratePlayerData(legacy, 3)!;
	assertInvariant(migrated.version === 3 && validatePlayerSaveData(migrated, 3).valid, "migracao uma versao v2 -> v3");
	assertStoredEqual(migrated.inventory, original.inventory, "migracao preserva inventario");
	assertStoredEqual(migrated.activeTeam, original.activeTeam, "migracao preserva time");
	assertStoredEqual(migrated.pvp, { pairs: {}, dailyTinyes: 0, dayKey: 0 }, "migracao zera apenas PVP");
	for (const invalid of [{ pairs: { x: { count: -1, windowStart: 0 } }, dailyTinyes: 0, dailyXp: 0, dayKey: 0 },
		{ pairs: {}, dailyTinyes: 0.5, dayKey: 0 }, { pairs: {}, dailyTinyes: 0, dayKey: -1 },
		{ pairs: [{ count: 1, windowStart: 0 }], dailyTinyes: 0, dailyXp: 0, dayKey: 0 }]) {
		assertInvariant(!validatePlayerSaveData({ ...original, pvp: invalid }).valid, "validacao PVP estrita");
	}
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).amount === 100, "primeira paga");
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).amount === 100, "segunda paga");
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).blockedReason === "limite_par", "terceira bloqueada");
	assertInvariant(data.awardPvpWin(b.player, a.player.UserId, 100).amount === 100, "direcao independente");
	assertInvariant(data.awardPvpWin(a.player, 1, 100).amount === 100, "outro oponente paga");
	assertInvariant(data.savePlayer(a.player).ok, "save cooldown");
	data.handlePlayerRemoving(a.player); data.handlePlayerRemoving(b.player);
	data = new PlayerDataService(progression, options);
	assertInvariant(data.loadPlayer(a.player).ok && data.awardPvpWin(a.player, b.player.UserId, 100).amount === 0, "reentrada preserva cooldown");
	now += PVP_PAIR_WINDOW_SECONDS;
	assertInvariant(data.awardPvpWin(a.player, b.player.UserId, 100).amount === 100, "janela vencida volta a pagar");
	const raw = data as unknown as { sessions: Map<Player, { pvp: NonNullable<PlayerSaveData["pvp"]> }> };
	const state = raw.sessions.get(a.player)!.pvp;
	state.dailyTinyes = PVP_DAILY_TINYES_CAP - 25;
	assertInvariant(data.awardPvpWin(a.player, 2, 100).amount === 25 && data.getPlayerSaveSnapshot(a.player)!.pvp!.dailyTinyes === PVP_DAILY_TINYES_CAP, "teto corta premio");
	assertInvariant(data.awardPvpWin(a.player, 3, 100).blockedReason === "limite_diario", "teto bloqueia");
	now = (math.floor(now / PVP_DAY_SECONDS) + 1) * PVP_DAY_SECONDS;
	assertInvariant(data.awardPvpWin(a.player, 3, 100).amount === 100 && data.getPlayerSaveSnapshot(a.player)!.pvp!.dailyTinyes === 100, "novo dia zera");
	const full = raw.sessions.get(a.player)!.pvp;
	full.pairs = {};
	for (let i = 0; i < PVP_MAX_PAIR_ENTRIES; i++) full.pairs[tostring(i)] = { count: 1, windowStart: now };
	assertInvariant(data.awardPvpWin(a.player, 999999, 100).blockedReason === "limite_par", "limite de entradas nao remove janelas ativas");
	now += PVP_PAIR_WINDOW_SECONDS;
	assertInvariant(data.savePlayer(a.player).ok, "limpeza na escrita");
	assertStoredEqual(data.getPlayerSaveSnapshot(a.player)!.pvp!.pairs, {}, "janelas vencidas limpas");
	pvp.forgetPlayer(a.player); pvp.forgetPlayer(b.player); data.handlePlayerRemoving(a.player);
	a.character.Destroy(); b.character.Destroy(); a.removing.Destroy(); b.removing.Destroy();
	print("PVP_INVITES_AND_PERSISTENCE_PASSED");
}

/** Anti-farm PvP: teto diário de Tinyes não contorna limite por par para XP; sem contagem dupla, sem gasto quando inelegível e PvE inalterado. */
export function validatePvpPairAntiFarmWithTinyesCap(): void {
	let now = PVP_DAY_SECONDS + 500;
	const store = new InMemoryDataStore();
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, {
		dataStore: store,
		serverId: "PairAntiFarm",
		now: () => now,
		waitFn: () => {},
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	const tinyes = new TinyesService(data, () => {});
	const ends = new Map<Player, BattleEndedPayload>();
	const sessions = new BattleSessionService(
		createSurgicalMockAdapter({ onBattleEnded: (player, payload) => ends.set(player, payload) }),
		tinyes,
		progression,
	);

	const a = { Parent: Players, Name: "AntiFarmWinner", UserId: 995001 } as unknown as Player;
	const b = { Parent: Players, Name: "AntiFarmOppB", UserId: 995002 } as unknown as Player;
	const c = { Parent: Players, Name: "AntiFarmOppC", UserId: 995003 } as unknown as Player;
	const d = { Parent: Players, Name: "AntiFarmOppD", UserId: 995004 } as unknown as Player;
	const e = { Parent: Players, Name: "AntiFarmOppE", UserId: 995005 } as unknown as Player;
	const f = { Parent: Players, Name: "AntiFarmOppF", UserId: 995006 } as unknown as Player;
	for (const p of [a, b, c, d, e, f]) {
		assertInvariant(data.loadPlayer(p).ok, `load ${p.Name}`);
	}

	const original = data.getPlayerSaveSnapshot(a)!;
	const setTeamLevel = (level: number) => {
		const inv = [0, 1, 2].map((index) => ({
			...original.inventory[0],
			itemUuid: `antifarm-${index}`,
			level,
			xp: 0,
		}));
		progression.loadValidatedPlayerData(a, { version: PLAYER_DATA_SCHEMA_VERSION, inventory: inv });
		data.setActiveTeam(a, inv.map((item) => item.itemUuid));
	};
	setTeamLevel(1);

	const roll = { t: 0.5, cost: 1.875, mult: 1 };
	const timeline = {
		prepareTime: 0.1,
		hits: [0.1, 0.2, 0.3].map((time) => ({ time, damageShare: 1, followUp: false })),
		returnTime: 0.1,
		dodgeReturnTime: 0.1,
	};
	const makeFighter = (item: FighterInventoryItem) =>
		new Fighter({
			itemUuid: item.itemUuid,
			fighterId: item.fighterId,
			hp: 100,
			hpMax: 100,
			stats: { hp: 100, atk: 50, crit: 0, dodge: 0 },
			level: item.level,
			className: "Fury",
			slots: [roll, roll, roll],
			skillData: [timeline, timeline, timeline],
			currentAtbSpeed: 0,
		});

	const runWin = (opponent?: Player): BattleEndedPayload => {
		ends.delete(a);
		const snap = data.getPlayerSaveSnapshot(a)!;
		const own = new BattleSide(
			[makeFighter(snap.inventory[0]), makeFighter(snap.inventory[1]), makeFighter(snap.inventory[2])],
			() => 0.5,
		);
		const enemy = new BattleSide(
			[makeFighter(original.inventory[0]), makeFighter(original.inventory[0]), makeFighter(original.inventory[0])],
			() => 0.5,
		);
		const mode = opponent === undefined ? "PVE" : "PVP";
		assertInvariant(sessions.createSession(a, opponent, own, enemy, () => 0.5, mode), `cria sessao ${mode}`);
		const record = (sessions as unknown as { activeSessions: { battle: BattleService; resolvedHits: number }[] }).activeSessions[0];
		record.resolvedHits = 3;
		record.battle.events.battleEnd.fire(own);
		sessions.step(0);
		return ends.get(a)!;
	};

	const getLivePvp = () =>
		(data as unknown as { sessions: Map<Player, { pvp: NonNullable<PlayerSaveData["pvp"]> }> }).sessions.get(a)!.pvp;
	getLivePvp().dailyTinyes = PVP_DAILY_TINYES_CAP;
	getLivePvp().dailyXp = 0;

	// 1) Teto diário de Tinyes atingido: 2 primeiras vitórias contra B concedem XP e contam no par; 3ª retorna limite_par sem XP
	const win1B = runWin(b);
	const xpAfter1 = data.getPlayerSaveSnapshot(a)!.pvp!.dailyXp;
	assertInvariant(
		win1B.tinyesReward === 0 &&
			win1B.rewardBlockedReason === "limite_diario" &&
			win1B.xpRewards !== undefined &&
			xpAfter1 > 0 &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(b.UserId)]?.count === 1,
		"1ª vitória contra B no teto de Tinyes concede XP e incrementa par para 1",
	);

	const win2B = runWin(b);
	const xpAfter2 = data.getPlayerSaveSnapshot(a)!.pvp!.dailyXp;
	assertInvariant(
		win2B.tinyesReward === 0 &&
			win2B.rewardBlockedReason === "limite_diario" &&
			win2B.xpRewards !== undefined &&
			xpAfter2 > xpAfter1 &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(b.UserId)]?.count === 2,
		"2ª vitória contra B no teto de Tinyes concede XP e incrementa par para 2",
	);

	const win3B = runWin(b);
	const xpAfter3 = data.getPlayerSaveSnapshot(a)!.pvp!.dailyXp;
	assertInvariant(
		win3B.tinyesReward === 0 &&
			win3B.rewardBlockedReason === "limite_par" &&
			win3B.xpRewards === undefined &&
			xpAfter3 === xpAfter2 &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(b.UserId)]?.count === 2,
		`3ª vitória contra B no teto de Tinyes deve retornar limite_par e não conceder XP (reason=${tostring(win3B.rewardBlockedReason)}, xpDelta=${xpAfter3 - xpAfter2})`,
	);

	// 2) Adversário independente C na mesma janela ainda é elegível para XP (e conta separado)
	const win1C = runWin(c);
	assertInvariant(
		win1C.tinyesReward === 0 &&
			win1C.rewardBlockedReason === "limite_diario" &&
			win1C.xpRewards !== undefined &&
			data.getPlayerSaveSnapshot(a)!.pvp!.dailyXp > xpAfter3 &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(c.UserId)]?.count === 1,
		"adversário independente C deve continuar concedendo XP quando par B atingiu limite",
	);

	// 3) Sem contagem dupla quando Tinyes e XP são elegíveis simultaneamente
	getLivePvp().dailyTinyes = 0;
	getLivePvp().dailyXp = 0;
	const win1D = runWin(d);
	assertInvariant(
		(win1D.tinyesReward ?? 0) > 0 &&
			win1D.xpRewards !== undefined &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(d.UserId)]?.count === 1,
		"vitória com Tinyes e XP elegíveis deve contar apenas 1 oportunidade no par",
	);
	const win2D = runWin(d);
	assertInvariant(
		(win2D.tinyesReward ?? 0) > 0 &&
			win2D.xpRewards !== undefined &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(d.UserId)]?.count === 2,
		"2ª vitória com Tinyes e XP deve contar 2 no par",
	);
	const win3D = runWin(d);
	assertInvariant(
		win3D.tinyesReward === 0 && win3D.rewardBlockedReason === "limite_par" && win3D.xpRewards === undefined,
		"3ª vitória contra D bloqueada por limite_par sem dupla contagem antecipada",
	);

	// 4) Sem consumir oportunidade do par quando nenhuma recompensa é elegível (ambos tetos ou Lv máximo + teto Tinyes)
	getLivePvp().dailyTinyes = PVP_DAILY_TINYES_CAP;
	getLivePvp().dailyXp = PVP_DAILY_XP_CAP;
	const win1E = runWin(e);
	assertInvariant(
		win1E.tinyesReward === 0 &&
			win1E.xpRewards === undefined &&
			win1E.rewardBlockedReason === "limite_diario_xp" &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(e.UserId)] === undefined,
		"vitória com ambos tetos esgotados não deve consumir oportunidade do par",
	);

	setTeamLevel(MAX_LEVEL);
	getLivePvp().dailyTinyes = PVP_DAILY_TINYES_CAP;
	getLivePvp().dailyXp = 0;
	const win1F = runWin(f);
	assertInvariant(
		win1F.tinyesReward === 0 &&
			data.getPlayerSaveSnapshot(a)!.pvp!.dailyXp === 0 &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(f.UserId)] === undefined,
		"vitória sem Tinyes e com 0 XP útil (nível máximo) não deve consumir oportunidade do par",
	);

	// 5) PvE permanece inalterado mesmo com tetos e pares PvP preenchidos
	setTeamLevel(1);
	getLivePvp().dailyTinyes = PVP_DAILY_TINYES_CAP;
	getLivePvp().dailyXp = PVP_DAILY_XP_CAP;
	const tinyesBeforePve = data.getTinyes(a)!;
	const xpBeforePve = progression.getFighter(a, "antifarm-0")!.xp;
	const pveEnd = runWin(undefined);
	assertInvariant(
		(pveEnd.tinyesReward ?? 0) > 0 &&
			pveEnd.rewardBlockedReason === undefined &&
			pveEnd.xpRewards !== undefined &&
			data.getTinyes(a)! > tinyesBeforePve &&
			progression.getFighter(a, "antifarm-0")!.xp > xpBeforePve &&
			data.getPlayerSaveSnapshot(a)!.pvp!.pairs[tostring(b.UserId)]?.count === 2,
		"PvE deve continuar pagando Tinyes e XP normalmente sem ser afetado pelos limites PvP",
	);

	for (const p of [a, b, c, d, e, f]) {
		data.handlePlayerRemoving(p);
	}
	print("PVP_PAIR_ANTIFARM_TINYES_CAP_PASSED");
}
