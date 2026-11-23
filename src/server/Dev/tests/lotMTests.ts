// Testes específicos do Lote M: A-05 (ATB na morte no banco), C-06 (rate limit só em entradas do cliente) e whitelist via FIGHTER_DATA.
import { Players } from "@rbxts/services";
import {
	ATB_MAX,
	ATB_MIN,
	BATTLE_REQUEST_BUCKET_CAPACITY,
	FLOAT_TOLERANCE,
	PVP_INVITE_INTERVAL_SECONDS,
	PVP_RESPONSE_BUCKET_CAPACITY,
	SHOP_RESET_WINDOW_SECONDS,
} from "../../../shared/Config";
import {
	FIGHTER_DATA,
	findFighterDefinition,
	getRegisteredFighterIds,
	isRegisteredFighterId,
	type FighterDefinition,
	type RealFighterId,
} from "../../../shared/FighterData";
import { calcSkillSlotRoll } from "../../../shared/MathUtils";
import type { ChallengeReceivedPayload, ChallengeStatusPayload, HitResolvedPayload } from "../../../shared/Remotes";
import type { FighterInventoryItem } from "../../../shared/TypeDefs";
import { BattleSide } from "../../Components/BattleSide";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { createPlayerInventorySide } from "../../Services/BattleTeamFactory";
import { InventoryService } from "../../Services/InventoryService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import { InMemoryDataStore, validateFighterInventoryItem } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { PvpService } from "../../Services/PvpService";
import { RemoteService } from "../../Services/RemoteService";
import { ShopService } from "../../Services/ShopService";
import { createDummySide, createJotaroVsAnubisSides, DUMMY_SKILL_DATA, makeDummyFighter, makeRealFighter } from "../DummyFighters";
import { assertInvariant, createSeededRng, createSurgicalMockAdapter } from "./testHelpers";

/** A-05: ATB do ativo preservado na morte no banco, zerado na morte do ativo (normal, multi-hit, troca, último). */
export function validateLotMA05AtbBenchDeath(): void {
	const alwaysHitRng = () => 0.99;

	// 1. Morte no banco por DoT em IDLE preserva ATB do ativo e não dispara troca indevida
	const sideA = createDummySide(alwaysHitRng);
	const sideB = new BattleSide(
		[makeDummyFighter("Fury"), makeDummyFighter("Menace"), makeDummyFighter("Dominator")],
		alwaysHitRng,
	);
	const battle = new BattleService(sideA, sideB, alwaysHitRng);
	const activeBefore = sideB.getActiveFighter();
	const benchVictim = sideB.fighters[1];
	benchVictim.hp = 1;
	benchVictim.applyStatusEffect("Burn", 1, 15);
	sideB.setAtb(6.0);

	let benchDeaths = 0;
	let switchesOnBenchDeath = 0;
	battle.events.death.connect(({ side, fighter, nextActive }) => {
		if (side === sideB && fighter === benchVictim) {
			benchDeaths += 1;
			assertInvariant(nextActive === undefined, "morte no banco não deve emitir nextActive");
			assertInvariant(sideB.getActiveFighter() === activeBefore, "morte no banco não pode trocar o ativo");
			assertInvariant(sideB.atb >= 6.0, `ATB do ativo deve ser preservado na morte no banco (atual=${sideB.atb})`);
		}
	});
	battle.events.switchPerformed.connect(({ side }) => {
		if (side === sideB) switchesOnBenchDeath += 1;
	});

	const expectedAtbAfterTick = math.min(6.0 + activeBefore.currentAtbSpeed * 1.0, ATB_MAX);
	battle.step(1.0);
	assertInvariant(benchDeaths === 1, "morte no banco por DoT deveria ter ocorrido");
	assertInvariant(switchesOnBenchDeath === 0, "morte no banco não pode disparar SwitchPerformed");
	assertInvariant(!benchVictim.isAlive() && activeBefore.isAlive(), "apenas lutador do banco deve morrer");
	assertInvariant(
		math.abs(sideB.atb - expectedAtbAfterTick) <= FLOAT_TOLERANCE,
		`ATB do ativo deve avançar normalmente sem reset/aceleração (esperado=${expectedAtbAfterTick}, atual=${sideB.atb})`,
	);

	// 2. Troca voluntária levando lutador com Bleed ao banco -> morte no banco preserva ATB do novo ativo
	const activeNow = sideB.getActiveFighter();
	activeNow.hp = 1;
	activeNow.applyStatusEffect("Bleed", 1, 15);
	sideB.setAtb(7.25);
	assertInvariant(battle.requestSwitch(sideB, 2), "troca voluntária para fighters[2] deveria funcionar");
	assertInvariant(math.abs(sideB.atb - 7.25) <= FLOAT_TOLERANCE, "troca voluntária deve preservar ATB");
	const newActive = sideB.getActiveFighter();
	assertInvariant(newActive === sideB.fighters[2], "fighters[2] deveria ser o ativo");
	battle.step(1.0);
	const expectedAfterSwitchBenchDeath = math.min(7.25 + newActive.currentAtbSpeed * 1.0, ATB_MAX);
	assertInvariant(!activeNow.isAlive() && newActive.isAlive(), "antigo ativo no banco morre por Bleed, novo ativo segue vivo");
	assertInvariant(
		math.abs(sideB.atb - expectedAfterSwitchBenchDeath) <= FLOAT_TOLERANCE,
		"ATB do novo ativo após troca deve ser preservado quando antigo ativo morre no banco",
	);
	assertInvariant(battle.requestSkill(sideB, 1), "novo ativo deve conseguir usar skill com o ATB preservado");

	// 3. Morte do ativo por golpe normal (1-hit): zera ATB do defensor, preserva ATB do atacante e entra reserva com ATB 0
	const [normalAttackerSide, normalDefenderSide] = createJotaroVsAnubisSides(alwaysHitRng);
	const normalBattle = new BattleService(normalAttackerSide, normalDefenderSide, alwaysHitRng);
	normalDefenderSide.getActiveFighter().hp = 1;
	normalDefenderSide.setAtb(8.5);
	normalAttackerSide.setAtb(ATB_MAX);
	const s1Cost = normalAttackerSide.getActiveFighter().slots[0].cost;
	let normalAutoSwitchTo: unknown;
	normalBattle.events.switchPerformed.connect(({ side, activeFighter }) => {
		if (side === normalDefenderSide) normalAutoSwitchTo = activeFighter;
	});
	assertInvariant(normalBattle.requestSkill(normalAttackerSide, 1), "Jotaro S1 (1-hit) deveria iniciar");
	normalBattle.step(2.0); // PREPARE + ATTACK + RETURN completos
	assertInvariant(normalAutoSwitchTo === normalDefenderSide.getActiveFighter(), "reserva deveria entrar após golpe normal letal");
	assertInvariant(normalDefenderSide.getActiveFighter().isAlive(), "próximo ativo deve estar vivo");
	assertInvariant(normalDefenderSide.atb < 2.0, "defensor deve ter zerado ATB no KO (acumulando apenas o IDLE pós-RETURN)");
	assertInvariant(
		normalAttackerSide.atb >= ATB_MAX - s1Cost - FLOAT_TOLERANCE,
		"atacante deve manter saldo de ATB após pagar custo da skill",
	);

	// 4. Morte do ativo em multi-hit (Jotaro S2 ORA ORA 5 hits): morre no hit 1, hits 2..5 ignorados, próximo entra com ATB 0 e HP cheio
	const [multiAttackerSide, multiDefenderSide] = createJotaroVsAnubisSides(alwaysHitRng);
	const multiBattle = new BattleService(multiAttackerSide, multiDefenderSide, alwaysHitRng);
	const firstDefender = multiDefenderSide.getActiveFighter();
	firstDefender.hp = 1;
	const benchHpBefore = [multiDefenderSide.fighters[1].hp, multiDefenderSide.fighters[2].hp];
	multiDefenderSide.setAtb(9.0);
	multiAttackerSide.setAtb(ATB_MAX);
	let multiHitsResolved = 0;
	let multiSwitchFired = false;
	multiBattle.events.hitResolved.connect(() => { multiHitsResolved += 1; });
	multiBattle.events.switchPerformed.connect(({ side, activeFighter }) => {
		if (side === multiDefenderSide) {
			multiSwitchFired = true;
			assertInvariant(side.atb === ATB_MIN, "próximo lutador após KO em multi-hit deve entrar com ATB 0");
			assertInvariant(activeFighter.hp === activeFighter.hpMax, "próximo lutador deve entrar com HP intacto");
		}
	});
	assertInvariant(multiBattle.requestSkill(multiAttackerSide, 2), "Jotaro S2 (5 hits) deveria iniciar");
	multiBattle.step(2.0);
	assertInvariant(multiHitsResolved === 1, `hits restantes após KO em multi-hit devem ser ignorados (recebidos=${multiHitsResolved})`);
	assertInvariant(multiSwitchFired, "troca automática após multi-hit deveria disparar");
	assertInvariant(
		multiDefenderSide.fighters[1].hp === benchHpBefore[0] && multiDefenderSide.fighters[2].hp === benchHpBefore[1],
		"lutadores do banco não devem sofrer dano de hits sobressalentes",
	);

	// 5. Morte do último fighter (golpe normal + DoT) encerra batalha com nextActive = undefined e ATB = 0
	const lastSideA = new BattleSide([makeRealFighter("jotaro", alwaysHitRng)], alwaysHitRng);
	const lastSideB = new BattleSide([makeRealFighter("anubis", alwaysHitRng)], alwaysHitRng);
	const lastBattle = new BattleService(lastSideA, lastSideB, alwaysHitRng);
	lastSideB.getActiveFighter().hp = 1;
	lastSideB.setAtb(7.0);
	lastSideA.setAtb(ATB_MAX);
	let lastDeathNextActive: unknown = "unset";
	let lastWinner: unknown;
	lastBattle.events.death.connect(({ side, nextActive }) => {
		if (side === lastSideB) {
			lastDeathNextActive = nextActive;
			assertInvariant(side.atb === ATB_MIN, "morte do último fighter deve zerar ATB");
		}
	});
	lastBattle.events.battleEnd.connect((winner) => { lastWinner = winner; });
	assertInvariant(lastBattle.requestSkill(lastSideA, 1), "ataque ao último fighter deveria iniciar");
	lastBattle.step(2.0);
	assertInvariant(lastDeathNextActive === undefined && lastWinner === lastSideA, "morte do último fighter deve encerrar luta sem nextActive");

	print("LOT_M_A05_ATB_BENCH_DEATH_PASSED");
}

/** C-06: Rate limit apenas nas entradas cliente -> servidor; eventos legítimos do servidor não são descartados. */
export function validateLotMC06RateLimitBoundaries(): void {
	let clock = 1000;
	const store = new InMemoryDataStore();
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, {
		dataStore: store,
		serverId: "LotMC06",
		now: () => clock,
		waitFn: () => {},
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	const sessions = new BattleSessionService(createSurgicalMockAdapter({}));

	const makeMockPlayer = (id: number) => {
		const model = new Instance("Model");
		const root = new Instance("Part");
		root.Name = "HumanoidRootPart";
		root.Position = new Vector3(0, 5, 0);
		root.Parent = model;
		const hum = new Instance("Humanoid");
		hum.Health = 100;
		hum.Parent = model;
		const mock = { Parent: Players as Players | undefined, Name: `C06P${id}`, UserId: id, Character: model };
		const player = mock as unknown as Player;
		assertInvariant(data.loadPlayer(player).ok, `load jogador ${id}`);
		return { player, model };
	};

	const target = makeMockPlayer(996001);
	const challengers = [
		makeMockPlayer(996002),
		makeMockPlayer(996003),
		makeMockPlayer(996004),
		makeMockPlayer(996005),
		makeMockPlayer(996006),
	];

	const receivedByTarget: ChallengeReceivedPayload[] = [];
	const statusesByTarget: ChallengeStatusPayload[] = [];
	const statusesByChallenger: ChallengeStatusPayload[] = [];

	const pvp = new PvpService(
		sessions,
		data,
		progression,
		(recipient, payload) => {
			if (recipient === target.player) receivedByTarget.push(payload);
		},
		(recipient, payload) => {
			if (recipient === target.player) statusesByTarget.push(payload);
			else statusesByChallenger.push(payload);
		},
		() => clock,
		() => 0.25,
	);

	// 1. Múltiplos eventos legítimos servidor -> cliente consecutivos (acima de PVP_RESPONSE_BUCKET_CAPACITY = 3)
	// Sem avançar o relógio entre convites de desafiantes diferentes (com recusa legítima após reposição):
	// nenhum ChallengeReceived nem ChallengeStatus pode ser descartado pelo servidor!
	const totalSequentialChallenges = PVP_RESPONSE_BUCKET_CAPACITY + 2; // 5 > 3
	for (let i = 0; i < totalSequentialChallenges; i++) {
		const challenger = challengers[i];
		assertInvariant(pvp.challenge(challenger.player, target.player), `convite legítimo ${i + 1} deveria ser aceito`);
		const latest = receivedByTarget[receivedByTarget.size() - 1];
		assertInvariant(latest !== undefined && latest.challengerName === challenger.player.Name, `ChallengeReceived ${i + 1} não pode sofrer rate limit`);
		// Recusa pelo alvo (respeitando bucket de resposta do cliente) ou expiração por desconexão do desafiante
		if (i < PVP_RESPONSE_BUCKET_CAPACITY) {
			assertInvariant(pvp.respond(target.player, { inviteId: latest.inviteId, accept: false }), `recusa ${i + 1} dentro do bucket`);
		} else {
			// Fecha via evento interno do servidor (forgetPlayer) sem avançar clock -> dispara status no mesmo instante!
			pvp.forgetPlayer(challenger.player);
		}
	}
	assertInvariant(
		receivedByTarget.size() === totalSequentialChallenges,
		`todos os ${totalSequentialChallenges} ChallengeReceived legítimos devem ser entregues (recebidos=${receivedByTarget.size()})`,
	);
	assertInvariant(
		statusesByTarget.size() === totalSequentialChallenges,
		`todos os ${totalSequentialChallenges} ChallengeStatus para target devem ser entregues sem rate limit (recebidos=${statusesByTarget.size()})`,
	);
	assertInvariant(
		statusesByChallenger.size() >= totalSequentialChallenges * 2 - 2,
		"ChallengeStatus dos desafiantes não podem ser descartados por rate limit",
	);

	// 2. Spam de respond (entrada cliente -> servidor) continua bloqueado e isolado por jogador (multiplayer)
	clock += PVP_INVITE_INTERVAL_SECONDS + 10;
	const pA = challengers[0];
	const pB = challengers[1];
	const pC = challengers[2];
	assertInvariant(pvp.challenge(pA.player, target.player), "convite para teste de spam");
	const activeInviteId = receivedByTarget[receivedByTarget.size() - 1].inviteId;
	for (let i = 0; i < PVP_RESPONSE_BUCKET_CAPACITY; i++) {
		assertInvariant(!pvp.respond(target.player, { inviteId: "fake", accept: true }), "inviteId inválido recusado e consome bucket");
	}
	assertInvariant(!pvp.respond(target.player, { inviteId: activeInviteId, accept: true }), "spam no bucket do cliente bloqueia respond");
	// Outro jogador (pB/pC) não é afetado pelo spam de target
	assertInvariant(pvp.challenge(pB.player, pC.player), "outro par PvP funciona normalmente durante spam alheio");

	// 3. Chamadas internas confiáveis do servidor (IA / hits / timers) nunca são bloqueadas pelo bucket do cliente
	const remotes = new RemoteService(() => clock);
	const hitPayloads: HitResolvedPayload[] = [];
	const mockBattleAdapter = {
		...createSurgicalMockAdapter({}),
		sendHitResolved: (_player: Player, payload: HitResolvedPayload) => {
			hitPayloads.push(payload);
		},
	};
	const battleSessions = new BattleSessionService(mockBattleAdapter);
	const [sideP, sideAi] = createJotaroVsAnubisSides(() => 0.99);
	assertInvariant(battleSessions.createSession(pA.player, undefined, sideP, sideAi, () => 0.99, "PVE"), "sessão PvE criada");

	// Satura o bucket de batalha do cliente pA em RemoteService
	const remoteInternals = remotes as unknown as { consumeRequest(player: Player): boolean };
	for (let i = 0; i < BATTLE_REQUEST_BUCKET_CAPACITY; i++) {
		assertInvariant(remoteInternals.consumeRequest(pA.player), "consumo dentro da capacidade");
	}
	assertInvariant(!remoteInternals.consumeRequest(pA.player), "spam do cliente pA barrado");
	assertInvariant(remoteInternals.consumeRequest(pB.player), "multiplayer: spam de pA não afeta pB");

	// Mesmo com bucket de pA saturado, chamadas internas confiáveis do servidor (IA + multi-hit) funcionam integralmente
	sideAi.setAtb(ATB_MAX);
	sideP.setAtb(ATB_MAX);
	assertInvariant(battleSessions.triggerSideSkill(pA.player, 1, 1), "chamada interna da IA não sofre rate limit");
	battleSessions.step(2.0);
	assertInvariant(hitPayloads.size() >= 1, "resolução de hits e envio servidor -> cliente não sofrem rate limit");

	battleSessions.destroySessionForPlayer(pA.player);
	pvp.forgetPlayer(target.player);
	for (const c of challengers) {
		pvp.forgetPlayer(c.player);
		data.handlePlayerRemoving(c.player);
		c.model.Destroy();
	}
	data.handlePlayerRemoving(target.player);
	target.model.Destroy();
	remotes.forgetPlayer(pA.player);
	remotes.forgetPlayer(pB.player);

	print("LOT_M_C06_RATE_LIMIT_BOUNDARIES_PASSED");
}

/** Whitelist de fighters substituída por FIGHTER_DATA como fonte única de verdade. */
export function validateLotMFighterRegistry(): void {
	// 1. Estado base: Jotaro e Anubis válidos; strings arbitrárias e valores inválidos rejeitados
	const baseIds = getRegisteredFighterIds();
	assertInvariant(
		baseIds.size() === 2 && baseIds.includes("jotaro") && baseIds.includes("anubis"),
		"FIGHTER_DATA base deve conter jotaro e anubis",
	);
	assertInvariant(isRegisteredFighterId("jotaro") && isRegisteredFighterId("anubis"), "jotaro e anubis válidos");
	for (const invalid of ["", "dio", "Jotaro", "ANUBIS", "__index", "toString", 123, undefined, {}] as unknown[]) {
		assertInvariant(!isRegisteredFighterId(invalid), `ID inválido deve ser rejeitado: ${tostring(invalid)}`);
		assertInvariant(findFighterDefinition(invalid) === undefined, `findFighterDefinition deve rejeitar: ${tostring(invalid)}`);
	}

	// 2. Validação real de preparação para 3º fighter exclusivamente via FIGHTER_DATA (fixture isolada e restaurada)
	const registry = FIGHTER_DATA as unknown as Record<string, unknown>;
	const syntheticId = "__lot_m_third_fighter__";
	const malformedId = "__lot_m_malformed_fighter__";
	const syntheticDef: FighterDefinition = {
		fighterId: syntheticId as RealFighterId,
		name: "Third Test",
		className: "Controller",
		rarity: "Rara",
		skills: DUMMY_SKILL_DATA,
	};

	const [ok, err] = pcall(() => {
		registry[syntheticId] = syntheticDef;
		registry[malformedId] = { fighterId: malformedId, name: "", className: "InvalidClass", rarity: "Comum", skills: [] };

		assertInvariant(isRegisteredFighterId(syntheticId), "3º fighter válido em FIGHTER_DATA deve ser aceito dinamicamente");
		assertInvariant(findFighterDefinition(syntheticId) === syntheticDef, "findFighterDefinition deve retornar definição do 3º fighter");
		assertInvariant(!isRegisteredFighterId(malformedId), "entrada malformada em FIGHTER_DATA deve ser rejeitada");

		const expandedIds = getRegisteredFighterIds();
		assertInvariant(expandedIds.size() === 3 && expandedIds.includes(syntheticId as RealFighterId), "getRegisteredFighterIds inclui 3º fighter válido e ignora malformado");

		// Validação de persistência (PlayerDataValidation)
		const baseRoll = [calcSkillSlotRoll(1, 0.5), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.5)] as const;
		const makeRawItem = (fighterId: string, uuid: string): FighterInventoryItem => ({
			itemUuid: uuid,
			fighterId,
			level: 1,
			xp: 0,
			baseStats: { hp: 16, atk: 8, dodge: 6, crit: 6 },
			allocatedStats: { hp: 0, atk: 0, dodge: 0, crit: 0 },
			skills: baseRoll,
		});
		const validThird = validateFighterInventoryItem(makeRawItem(syntheticId, "u-third"), () => {});
		assertInvariant(validThird.valid && validThird.item?.unavailable === undefined, "3º fighter deve carregar disponível");
		const unknownItem = validateFighterInventoryItem(makeRawItem("ghost_id", "u-ghost"), () => {});
		assertInvariant(unknownItem.valid && unknownItem.item?.unavailable === true, "ID desconhecido deve ficar unavailable");
		const malformedItem = validateFighterInventoryItem(makeRawItem(malformedId, "u-bad"), () => {});
		assertInvariant(malformedItem.valid && malformedItem.item?.unavailable === true, "entrada malformada em FIGHTER_DATA deve ficar unavailable");

		// Validação de BattleTeamFactory, PlayerDataService.setActiveTeam, InventoryService e ShopService
		let now = SHOP_RESET_WINDOW_SECONDS * 30;
		const player = { Parent: Players, Name: "LotMRegistryPlayer", UserId: 996099 } as unknown as Player;
		const progression = new ProgressionService();
		const data = new PlayerDataService(progression, {
			dataStore: new InMemoryDataStore(),
			serverId: "LotMRegistry",
			now: () => now,
			waitFn: () => {},
			warnFn: () => {},
			disableStudioAutoFallbackOnInjectedStore: true,
		});
		assertInvariant(data.loadPlayer(player).ok, "load jogador para teste de registro");

		const thirdItem = progression.createInventoryFighter(player, {
			fighterId: syntheticId,
			rarity: syntheticDef.rarity,
			baseStats: { hp: 16, atk: 8, dodge: 6, crit: 6 },
			skills: baseRoll,
		});
		const invalidItem = progression.createInventoryFighter(player, {
			fighterId: "arbitrary_string_fighter",
			rarity: "Comum",
			baseStats: { hp: 16, atk: 8, dodge: 6, crit: 6 },
			skills: baseRoll,
		});

		// setActiveTeam aceita o 3º fighter e rejeita string arbitrária
		assertInvariant(!data.setActiveTeam(player, [invalidItem.itemUuid]), "setActiveTeam deve rejeitar fighterId não registrado");
		assertInvariant(data.setActiveTeam(player, [thirdItem.itemUuid]), "setActiveTeam deve aceitar 3º fighter registrado em FIGHTER_DATA");

		// BattleTeamFactory monta lado com o 3º fighter sem whitelist manual
		const side = createPlayerInventorySide(player, progression, data, createSeededRng(42));
		assert(side !== undefined && side.fighters.size() === 1, "BattleTeamFactory deve aceitar 3º fighter via FIGHTER_DATA");
		assertInvariant(
			side.fighters[0].fighterId === syntheticId && side.fighters[0].className === "Controller",
			"BattleTeamFactory deve usar definição do 3º fighter",
		);
		const opponent = createDummySide(() => 0.99);
		const registryBattle = new BattleService(side, opponent, () => 0.99);
		for (const [slot, effect] of [[1, "Bleed"], [2, "Burn"]] as const) {
			side.setAtb(ATB_MAX);
			assertInvariant(registryBattle.requestSkill(side, slot), "3º fighter pode atacar com a skill registrada");
			registryBattle.step(1);
			assertInvariant(opponent.getActiveFighter().hasStatusEffect(effect), `skill do 3º fighter deve aplicar ${effect}`);
		}

		// InventoryService marca 3º fighter como disponível e string arbitrária como unavailable
		const invService = new InventoryService(data, progression, () => false, () => {});
		const invState = invService.getState(player)!;
		const thirdView = invState.fighters.find((f) => f.itemUuid === thirdItem.itemUuid);
		const invalidView = invState.fighters.find((f) => f.itemUuid === invalidItem.itemUuid);
		assertInvariant(thirdView !== undefined && !thirdView.unavailable && thirdView.displayName === "Third Test", "InventoryService reconhece 3º fighter");
		assertInvariant(invalidView !== undefined && invalidView.unavailable === true, "InventoryService marca string arbitrária como unavailable");

		// ShopService sorteia e publica 3º fighter automaticamente sem cast manual
		let sawThirdInShop = false;
		const shop = new ShopService(data, () => false, (_, payload) => {
			if (payload.offers.some((o) => o.fighterId === syntheticId && o.displayName === "Third Test")) {
				sawThirdInShop = true;
			}
		}, () => {}, () => {}, () => {}, () => now, () => 0);
		for (let w = 0; w < 20 && !sawThirdInShop; w++) {
			now += SHOP_RESET_WINDOW_SECONDS;
			shop.sync(player);
		}
		assertInvariant(sawThirdInShop, "ShopService deve incluir 3º fighter automaticamente a partir de FIGHTER_DATA");

		data.handlePlayerRemoving(player);
		shop.forgetPlayer(player);
	});

	delete registry[syntheticId];
	delete registry[malformedId];
	assertInvariant(ok, `falha no teste de registro de fighters: ${tostring(err)}`);

	// Confirma restauração limpa: apenas jotaro e anubis
	const afterIds = getRegisteredFighterIds();
	assertInvariant(
		afterIds.size() === 2 && !isRegisteredFighterId(syntheticId) && isRegisteredFighterId("jotaro") && isRegisteredFighterId("anubis"),
		"FIGHTER_DATA deve restaurar estado limpo com Jotaro e Anubis",
	);

	print("LOT_M_FIGHTER_REGISTRY_PASSED");
}
