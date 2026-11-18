// Testes de batalhas contra NPCs do mundo, validação de proximidade/prompts e cooldown de reencontro pós-vitória.
import { CollectionService, Players, Workspace } from "@rbxts/services";
import {
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	BATTLE_NPC_TAG,
	FLOAT_TOLERANCE,
	NPC_BATTLE_ACTIVE_ATTRIBUTE,
	NPC_PROMPT_DEBOUNCE_SECONDS,
	NPC_PROMPT_MAX_DISTANCE,
	PLAYER_DATA_SCHEMA_VERSION,
	TINYES_WIN_BY_TIER,
} from "../../../shared/Config";
import { FIGHTER_DATA } from "../../../shared/FighterData";
import { NPC_DATA, type NpcDefinition } from "../../../shared/NpcData";
import { calcBattleTotalXp, calcEffectiveStats } from "../../../shared/ProgressionMath";
import type { BattleEndedPayload, NpcBattleNoticePayload } from "../../../shared/Remotes";
import type { SkillSlot } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { AIService } from "../../Services/AIService";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { InventoryService } from "../../Services/InventoryService";
import { createNpcSide, NpcService } from "../../Services/NpcService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import { InMemoryDataStore } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { RemoteService, type BattleRemoteAdapter } from "../../Services/RemoteService";
import { TinyesService } from "../../Services/TinyesService";
import {
	assertInvariant,
	assertStoredEqual,
	createSeededRng,
	createSurgicalMockAdapter,
	SIMULATION_DT,
} from "./testHelpers";

/** Fluxo real do Triggered, com inventário/DataStore isolados e Instances descartáveis. */
export function validateNpcBattles(): void {
	const npc = new Instance("Model");
	npc.Name = "BattleSimulatorNpc";
	const part = new Instance("Part");
	part.Anchored = true;
	part.Transparency = 1;
	part.CanCollide = false;
	part.Parent = npc;
	npc.PrimaryPart = part;
	const prompt = new Instance("ProximityPrompt");
	prompt.Name = "ExistingPrompt";
	prompt.Style = Enum.ProximityPromptStyle.Custom;
	prompt.Parent = npc;
	npc.SetAttribute("NpcId", "bronze_trainer");
	CollectionService.AddTag(npc, BATTLE_NPC_TAG);
	npc.Parent = Workspace;
	const definition = NPC_DATA.bronze_trainer;
	const describe = (side: BattleSide) => side.fighters.map((fighter) => ({
		fighterId: fighter.fighterId, level: fighter.level, stats: fighter.stats, slots: fighter.slots,
	}));
	const fixedTeam = describe(createNpcSide(definition, () => 0));
	assertStoredEqual(describe(createNpcSide(definition, () => 1)), fixedTeam, "rolls NPC independem do RNG de combate");

	for (const outcome of ["win", "loss", "quit", "disconnect", "error", "startError", "endError", "requestError", "respawn", "timeout"] as const) {
		const character = new Instance("Model");
		const root = new Instance("Part");
		root.Name = "HumanoidRootPart";
		root.Anchored = true;
		root.Parent = character;
		const humanoid = new Instance("Humanoid");
		humanoid.WalkSpeed = 23;
		humanoid.JumpPower = 61;
		humanoid.JumpHeight = 9;
		humanoid.UseJumpPower = outcome !== "win" && outcome !== "disconnect";
		humanoid.Parent = character;
		const usePower = humanoid.UseJumpPower;
		const removing = new Instance("BindableEvent");
		const attributes = new Map<string, AttributeValue>();
		const mock = {
			Parent: Players as Players | undefined, Name: "NpcTest", UserId: 991994,
			Character: character, CharacterRemoving: removing.Event,
			SetAttribute(name: string, value: AttributeValue): void { attributes.set(name, value); },
		};
		const player = mock as unknown as Player;
		const progression = new ProgressionService();
		const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(),
			serverId: "NpcTest", now: () => 1000, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true });
		const tinyes = new TinyesService(data, () => {});
		let started = 0;
		const ended: BattleEndedPayload[] = [];
		const adapter = createSurgicalMockAdapter({
			onBattleStarted: () => { if (outcome === "startError") error("NPC start error intencional"); started++; },
			onBattleEnded: (_, payload) => { if (outcome === "endError") error("NPC end error intencional"); ended.push(payload); },
		});
		const sessions = new BattleSessionService(adapter, tinyes, progression);
		let now = 0;
		const notices: NpcBattleNoticePayload[] = [];
		const service = new NpcService(sessions, data, progression, (_, message) => notices.push(message), () => now, () => 0.5);
		service.bindNpc(npc);
		service.bindNpc(npc);
		assertInvariant(npc.FindFirstChildWhichIsA("ProximityPrompt", true) === prompt && npc.GetDescendants().filter((x) => x.IsA("ProximityPrompt")).size() === 1,
			"reutiliza prompt sem duplicar");
		assertInvariant(prompt.ActionText === "Batalhar" && prompt.ObjectText === definition.displayName && prompt.MaxActivationDistance === NPC_PROMPT_MAX_DISTANCE,
			"configura prompt existente");
		assertInvariant((prompt.Style as Enum.ProximityPromptStyle) === Enum.ProximityPromptStyle.Default, "prompt Custom existente passa a mostrar a interface padrão com E");
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "recusa sem sessão carregada");
		assertInvariant(data.loadPlayer(player).ok, "load NPC");
		const item = progression.getPlayerData(player)!.inventory[0];
		const second = progression.createInventoryFighter(player, { fighterId: "anubis", baseStats: item.baseStats, skills: item.skills });
		assertInvariant(data.setActiveTeam(player, [second.itemUuid, item.itemUuid]), "time salvo personalizado");
		const selected = [second, item];
		const recordData = data as unknown as { sessions: Map<Player, { activeTeam: string[] }> };
		const saved = recordData.sessions.get(player)!;
		saved.activeTeam = [];
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "time vazio recusa sem sessão");
		assertInvariant(notices[notices.size() - 1].reason === "time_invalido", "aviso curto para time inválido");
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		progression.loadValidatedPlayerData(player, { version: PLAYER_DATA_SCHEMA_VERSION, inventory: [{ ...item, unavailable: true }] });
		saved.activeTeam = [item.itemUuid];
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "só unavailable recusa");
		progression.loadValidatedPlayerData(player, { version: PLAYER_DATA_SCHEMA_VERSION, inventory: [item, second] });
		data.setActiveTeam(player, [second.itemUuid, item.itemUuid]);
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		root.Position = part.Position.add(new Vector3(NPC_PROMPT_MAX_DISTANCE + 1, 0, 0));
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), "longe recusa no servidor");
		root.Position = part.Position;
		assertInvariant(!service.trigger(player, npc), "debounce também limita tentativas recusadas");
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		mock.Parent = undefined;
		assertInvariant(!service.trigger(player, npc), "fora de Players recusa");
		mock.Parent = Players;
		const before = data.getPlayerSaveSnapshot(player)!;
		const created = service.trigger(player, npc);
		if (outcome !== "startError") {
			assertInvariant(created && sessions.hasActiveSession(player) && started === 1, "disparo válido cria uma sessão");
			assertInvariant(!service.trigger(player, npc) && started === 1, "disparo duplo não cria segunda sessão");
			now += NPC_PROMPT_DEBOUNCE_SECONDS;
			assertInvariant(!service.trigger(player, npc) && started === 1, "em batalha recusa mesmo após debounce");
			assertInvariant(humanoid.WalkSpeed === 0 && humanoid.JumpPower === 0 && humanoid.JumpHeight === 0 && attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === true,
				"movimento congelado para ambos os modos de salto");
			assertInvariant(prompt.Enabled, "prompt permanece habilitado no servidor");
			const record = (sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide]; aiControllers: AIService[] }[] }).activeSessions[0];
			assertInvariant(record.aiControllers.size() === 1, "IA Bronze anexada");
			for (let index = 0; index < selected.size(); index++) {
				const fighter = record.sides[0].fighters[index];
				assertInvariant(fighter.itemUuid === selected[index].itemUuid && fighter.level === selected[index].level, "UUID/nível e ordem do time salvo");
				assertStoredEqual(fighter.stats, calcEffectiveStats(selected[index].baseStats, selected[index].allocatedStats), "stats salvos usados na batalha");
				assertStoredEqual(fighter.slots, selected[index].skills, "rolls salvos sem rerrolar");
			}
			assertStoredEqual(describe(record.sides[1]), fixedTeam, "NPC idêntico entre sessões");
			if (outcome === "win") {
				const otherCharacter = character.Clone();
				const otherHumanoid = otherCharacter.FindFirstChildOfClass("Humanoid")!;
				otherHumanoid.WalkSpeed = 19;
				const otherRemoving = new Instance("BindableEvent");
				const other = { Parent: Players, Name: "OtherNpcTest", UserId: 991995,
					Character: otherCharacter, CharacterRemoving: otherRemoving.Event,
					SetAttribute(_name: string, _value: AttributeValue) {},
				} as unknown as Player;
				assertInvariant(data.loadPlayer(other).ok && service.trigger(other, npc), "mesmo NPC aceita segundo jogador durante batalha");
				const records = (sessions as unknown as { activeSessions: { sides: [BattleSide, BattleSide] }[] }).activeSessions;
				assertInvariant(records.size() === 2 && records[1].sides[1] !== record.sides[1], "sessões pessoais com instâncias de combate independentes");
				assertStoredEqual(describe(records[1].sides[1]), fixedTeam, "mesmos rolls para os dois jogadores");
				sessions.requestQuit(other);
				assertInvariant(otherHumanoid.WalkSpeed === 19 && sessions.hasActiveSession(player) && !sessions.hasActiveSession(other), "Quit alheio restaura somente o respectivo jogador");
				assertInvariant(prompt.Enabled && humanoid.WalkSpeed === 0, "NPC e primeira sessão continuam disponíveis/isolados");
				ended.clear(); // Resultado do segundo jogador não pertence à verificação de recompensa abaixo.
				data.handlePlayerRemoving(other);
				otherCharacter.Destroy();
				otherRemoving.Destroy();
			}
			// A batalha dura mais que o cooldown: a contagem deve começar somente no fim.
			now += definition.rematchCooldownSeconds * 2;
			if (outcome === "quit" || outcome === "disconnect") {
				const side = record.sides[0];
				const attacker = side.getActiveFighter();
				side.setAtb(10);
				assertInvariant(record.battle.requestSkill(side, 1), `${outcome}: ataque antes de sair`);
				for (let step = 0; step < 200 && record.battle.getDamageDealt(side, attacker.itemUuid!) === 0; step++) {
					sessions.step(SIMULATION_DT);
				}
				assertInvariant(record.battle.getDamageDealt(side, attacker.itemUuid!) > 0 && sessions.hasActiveSession(player),
					`${outcome}: causou dano real sem vencer antes de sair`);
			}
			if (outcome === "win" || outcome === "loss") {
				const winningSide = record.sides[outcome === "win" ? 0 : 1];
				const losingSide = record.sides[outcome === "win" ? 1 : 0];
				for (const fighter of losingSide.fighters) fighter.hp = 1;
				for (let step = 0; step < 200 && sessions.hasActiveSession(player); step++) {
					winningSide.setAtb(10);
					record.battle.requestSkill(winningSide, 1);
					sessions.step(SIMULATION_DT);
				}
				assertInvariant(!sessions.hasActiveSession(player), "fim natural pela morte de todo o time");
			} else if (outcome === "disconnect") {
				mock.Parent = undefined;
				sessions.destroySessionForPlayer(player);
			} else if (outcome === "error") {
				record.battle.step = () => error("NPC step error intencional");
				sessions.step(SIMULATION_DT);
			} else if (outcome === "requestError") {
				record.battle.requestSkill = () => error("NPC request error intencional");
				(sessions as unknown as { handleSkillRequest(player: Player, slot: SkillSlot): void }).handleSkillRequest(player, 1);
			} else if (outcome === "respawn") {
				removing.Fire(character);
				task.wait();
			} else if (outcome === "timeout") {
				for (const ai of record.aiControllers) ai.destroy();
				sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
			}
			else sessions.requestQuit(player);
			const after = data.getPlayerSaveSnapshot(player)!;
			record.battle.events.battleEnd.fire(record.sides[0]);
			sessions.requestQuit(player);
			assertStoredEqual(data.getPlayerSaveSnapshot(player), after, `${outcome}: segundo fim não paga novamente`);
			if (outcome === "win") {
				assertInvariant(after.tinyes - before.tinyes === 100 && ended.size() === 1 && ended[0].tinyesReward === 100,
					`vitória Bronze paga Tinyes uma vez (saldo=${after.tinyes - before.tinyes}, eventos=${ended.size()}, recompensa=${ended[0]?.tinyesReward}, vencedor=${ended[0]?.winnerSideId})`);
				assertInvariant(ended[0].xpRewards?.size() === 2, "vitória paga XP aos dois selecionados");
				for (const reward of ended[0].xpRewards!) assertInvariant(reward.xpGained === 48 && progression.getFighter(player, reward.itemUuid)?.xp === 48, "XP final usa média NPC 1,5 e divisão dupla");
			} else {
				assertInvariant(after.tinyes === before.tinyes, "sem vitória não paga Tinyes");
				assertStoredEqual(after.inventory, before.inventory, "sem vitória não paga XP");
			}
		} else assertInvariant(!created && started === 0, "falha no BattleStarted não deixa sessão parcial");
		assertInvariant(!sessions.hasActiveSession(player) && humanoid.WalkSpeed === 23 && humanoid.JumpPower === 61 && humanoid.JumpHeight === 9 && humanoid.UseJumpPower === usePower,
			`${outcome}: estado final restaura movimento original`);
		assertInvariant(attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false, `${outcome}: client liberado mesmo se remote falhar`);
		mock.Parent = Players;
		if (outcome === "win") {
			assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player), `${outcome}: cooldown recusa sem criar sessão`);
			const cooldownNotice = notices[notices.size() - 1];
			assertInvariant(cooldownNotice.reason === "cooldown" && cooldownNotice.npcId === definition.npcId &&
				cooldownNotice.remainingSeconds === definition.rematchCooldownSeconds, `${outcome}: cooldown completo contado do fim`);
		} else {
			now += NPC_PROMPT_DEBOUNCE_SECONDS;
			const retried = service.trigger(player, npc);
			assertInvariant(notices[notices.size() - 1].reason !== "cooldown", `${outcome}: não gera cooldown`);
			assertInvariant(outcome === "startError" ? !retried : retried, `${outcome}: reencontro liberado sem vitória`);
			sessions.destroySessionForPlayer(player);
		}
		service.destroy();
		mock.Parent = Players;
		data.handlePlayerRemoving(player);
		character.Destroy();
		removing.Destroy();
	}
	npc.Destroy();
	print("NPC_BATTLES_PASSED");
}

/** Relógio manual: limites, isolamento e ambas as ordens de limpeza de PlayerRemoving. */
export function validateNpcRematchCooldown(): void {
	const primary = NPC_DATA.bronze_trainer;
	const secondaryId = "simulator_rematch_npc";
	const catalog = NPC_DATA as Record<string, NpcDefinition | undefined>;
	catalog[secondaryId] = { ...primary, npcId: secondaryId };
	const npcs = [primary.npcId, secondaryId].map((npcId) => {
		const part = new Instance("Part");
		part.Anchored = true;
		part.CanCollide = false;
		part.Transparency = 1;
		part.SetAttribute("NpcId", npcId);
		CollectionService.AddTag(part, BATTLE_NPC_TAG);
		part.Parent = Workspace;
		return part;
	});
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, { dataStore: new InMemoryDataStore(), serverId: "NpcCooldown",
		now: () => 1000, waitFn: () => {}, warnFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true });
	let started = 0;
	const sessions = new BattleSessionService(createSurgicalMockAdapter({ onBattleStarted: () => { started++; } }));
	let now = 0;
	const notices: { player: Player; payload: NpcBattleNoticePayload }[] = [];
	const service = new NpcService(sessions, data, progression,
		(player, payload) => notices.push({ player, payload }), () => now, () => 0.5);
	for (const npc of npcs) service.bindNpc(npc);
	const participants = [0, 1].map((index) => {
		const character = new Instance("Model");
		const root = new Instance("Part");
		root.Name = "HumanoidRootPart";
		root.Anchored = true;
		root.Position = npcs[0].Position;
		root.Parent = character;
		const humanoid = new Instance("Humanoid");
		humanoid.Parent = character;
		const removing = new Instance("BindableEvent");
		const mock = { Parent: Players as Players | undefined, Name: `Cooldown${index}`, UserId: 995100 + index,
			Character: character, CharacterRemoving: removing.Event,
			SetAttribute(_name: string, _value: AttributeValue): void {},
		};
		const player = mock as unknown as Player;
		assertInvariant(data.loadPlayer(player).ok, "load cooldown");
		return { mock, player, character, removing };
	});
	const a = participants[0].player;
	const b = participants[1].player;
	const expectBlocked = (player: Player, npc: Instance, remaining: number) => {
		const before = started;
		assertInvariant(!service.trigger(player, npc) && !sessions.hasActiveSession(player) && started === before,
			`cooldown recusa sem BattleStarted/sessão: now=${now}, npc=${npc.GetAttribute("NpcId")}, jogador=${player.Name}`);
		const notice = notices[notices.size() - 1];
		assertInvariant(notice.player === player && notice.payload.reason === "cooldown" &&
			notice.payload.npcId === npc.GetAttribute("NpcId") && notice.payload.remainingSeconds === remaining,
			"aviso privado informa NPC e segundos restantes arredondados para cima");
	};
	const win = (player: Player) => {
		const record = (sessions as unknown as { activeSessions: { participants: { player: Player }[]; battle: BattleService; sides: [BattleSide, BattleSide] }[] })
			.activeSessions.find((session) => session.participants.some((participant) => participant.player === player))!;
		record.battle.events.battleEnd.fire(record.sides[0]);
		sessions.step(0);
	};
	try {
		assertInvariant(service.trigger(a, npcs[0]), "primeiro encontro liberado");
		now += primary.rematchCooldownSeconds * 2;
		win(a);
		const firstEnd = now;
		expectBlocked(a, npcs[0], primary.rematchCooldownSeconds);
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		assertInvariant(service.trigger(a, npcs[1]), "cooldown de um NPC não bloqueia outro");
		assertInvariant(service.trigger(b, npcs[0]), "cooldown de um jogador não bloqueia outro");
		win(a);
		win(b);
		now = firstEnd + primary.rematchCooldownSeconds - 0.25;
		expectBlocked(a, npcs[0], 1);
		now = firstEnd + primary.rematchCooldownSeconds;
		assertInvariant(service.trigger(a, npcs[0]), "libera exatamente ao vencer cooldown, sem wait");
		expectBlocked(b, npcs[0], NPC_PROMPT_DEBOUNCE_SECONDS);
		win(a);
		expectBlocked(a, npcs[0], primary.rematchCooldownSeconds);
		now += NPC_PROMPT_DEBOUNCE_SECONDS;
		assertInvariant(service.trigger(a, npcs[1]), "segundo NPC expira independentemente do novo cooldown do primeiro");
		win(a);

		// Callback de sessão antes da limpeza: saída apaga os dois NPCs e o debounce.
		service.handlePlayerRemoving(a);
		assertInvariant(service.trigger(a, npcs[0]), "reentrada zera cooldown do primeiro NPC e debounce");
		win(a);
		service.handlePlayerRemoving(a);
		assertInvariant(service.trigger(a, npcs[1]), "saída também apaga cooldown do segundo NPC");

		// Limpeza antes do callback: fim tardio não recria cooldown na reentrada.
		service.handlePlayerRemoving(a);
		participants[0].mock.Parent = undefined;
		sessions.destroySessionForPlayer(a);
		participants[0].mock.Parent = Players;
		assertInvariant(service.trigger(a, npcs[1]), "fim de desconexão após limpeza não repõe cooldown");
		win(a);
	} finally {
		for (const participant of participants) {
			sessions.destroySessionForPlayer(participant.player);
			service.handlePlayerRemoving(participant.player);
			data.handlePlayerRemoving(participant.player);
			participant.character.Destroy();
			participant.removing.Destroy();
		}
		service.destroy();
		for (const npc of npcs) npc.Destroy();
		catalog[secondaryId] = undefined;
	}
	print("NPC_REMATCH_COOLDOWN_PASSED");
}
