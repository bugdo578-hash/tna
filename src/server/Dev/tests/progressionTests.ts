// Testes de progressão, curva e distribuição de XP, snapshots, desbloqueio de S3, inventário e economia de Tinyes.
import { Players } from "@rbxts/services";
import {
	AI_BRONZE_SKILL_DELAY_MAX_SECONDS,
	ALLOCATE_REQUEST_BUCKET_CAPACITY,
	ALLOCATE_REQUEST_REFILL_PER_SECOND,
	ATB_MAX,
	ATK_PER_POINT,
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	CRIT_POINTS_PER_POINT,
	DEFAULT_STARTER_FIGHTER_ID,
	DODGE_POINTS_PER_POINT,
	FLOAT_TOLERANCE,
	HP_PER_POINT,
	INITIAL_TINYES,
	MAX_LEVEL,
	MAX_SAVED_NUMBER,
	MIN_LEVEL,
	PLAYER_DATA_SCHEMA_VERSION,
	S3_UNLOCK_LEVEL,
	TINYES_MAX_ADD_PER_CALL,
	TINYES_WIN_BY_TIER,
	TOTAL_STAT_POINTS,
} from "../../../shared/Config";
import { FIGHTER_DATA } from "../../../shared/FighterData";
import { calcSkillSlotRoll } from "../../../shared/MathUtils";
import {
	calcAvailablePoints,
	calcBattleTotalXp,
	calcEffectiveStats,
	calcFighterSlotXp,
	calcLevelDiffXpMultiplier,
	calcMaxUsefulXp,
	calcPostBattleTeamXp,
	calcTeamXpShareFractions,
	calcTotalPointsForLevel,
	calcXpForNextLevel,
	resolveXpAndLevelUp,
} from "../../../shared/ProgressionMath";
import type { BattleEndedPayload, BattleStartedPayload } from "../../../shared/Remotes";
import type { FighterInventoryItem, SkillSlot, SkillSlots, StatBlock } from "../../../shared/TypeDefs";
import { BattleSide, type FighterIndex } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { AIService } from "../../Services/AIService";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { InventoryService } from "../../Services/InventoryService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import {
	InMemoryDataStore,
	validatePlayerSaveData,
	type DataStoreLike,
	type PlayerSaveData,
} from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { RemoteService, type BattleRemoteAdapter } from "../../Services/RemoteService";
import { TinyesService } from "../../Services/TinyesService";
import { createJotaroVsAnubisBattleSession } from "../DummyBattleSession";
import { createDummySide, makeDummyFighter, makeRealFighter } from "../DummyFighters";
import {
	assertInvariant,
	assertStoredEqual,
	createSeededRng,
	createSurgicalMockAdapter,
	FIRST_SIMULATION_SEED,
	SIMULATION_COUNT,
	SIMULATION_DT,
	SpyProgressionService,
	xpToReach,
} from "./testHelpers";

/** Curva de custo por nível e XP pós-batalha por slot (pool, divisão por tamanho do time, multiplicador por diferença de nível, level-ups). */
export function validateXpCurveAndTeamDistribution(): void {
	// a. Custo de nível = XP_LEVEL_PER_LEVEL * nível atual; no cap não há próximo nível
	assertInvariant(calcXpForNextLevel(1) === 100, "Nv.1 exige 100 XP");
	assertInvariant(calcXpForNextLevel(10) === 1000, "Nv.10 exige 1.000 XP");
	assertInvariant(calcXpForNextLevel(20) === 2000, "Nv.20 exige 2.000 XP");
	assertInvariant(calcXpForNextLevel(MAX_LEVEL) === 0, "no nível máximo não existe custo de próximo nível");

	// b. Pool total (somente vitória PvE) e divisão por quantidade de lutadores válidos
	assertInvariant(calcBattleTotalXp(20, true) === 375, "inimigo nível médio 20 gera 375 XP totais (75 + 15 * 20)");
	assertInvariant(
		calcBattleTotalXp(20, false) === 0 && calcBattleTotalXp(0 / 0, true) === 0 && calcBattleTotalXp(-1, true) === 0,
		"derrota/Quit/desconexão/timeout (sem vitória PvE) e nível médio inválido geram 0 XP",
	);
	const lv20 = (damageDealt: number) => ({ level: 20, damageDealt });
	const evenTeam = calcPostBattleTeamXp(20, true, [lv20(100), lv20(100), lv20(100)]);
	assertInvariant(
		evenTeam[0] === 187 && evenTeam[1] === 93 && evenTeam[2] === 93,
		"3 válidos com dano empatado: 50% (187) ao slot 0 e 25% (93) a cada outro (nível parelho, 1.00x)",
	);
	const defeatTeam = calcPostBattleTeamXp(20, false, [lv20(1), lv20(1), lv20(1)]);
	assertInvariant(defeatTeam[0] === 0 && defeatTeam[1] === 0 && defeatTeam[2] === 0, "derrota não paga XP");
	const emptyTeam = calcPostBattleTeamXp(20, true, [undefined, undefined, undefined]);
	assertInvariant(emptyTeam[0] === 0 && emptyTeam[1] === 0 && emptyTeam[2] === 0, "time sem lutador válido não gera XP");

	// c. 1 lutador válido: 100% do pool em qualquer slot; slots vazios não roubam fatia
	const solo0 = calcPostBattleTeamXp(20, true, [lv20(0), undefined, undefined]);
	assertInvariant(solo0[0] === 375 && solo0[1] === 0 && solo0[2] === 0, "[A, undefined, undefined]: A recebe 100% do pool (375)");
	const solo1 = calcPostBattleTeamXp(20, true, [undefined, lv20(7), undefined]);
	assertInvariant(solo1[0] === 0 && solo1[1] === 375 && solo1[2] === 0, "único válido no slot 1 recebe 100% do pool (375)");
	const solo2 = calcPostBattleTeamXp(20, true, [undefined, undefined, lv20(7)]);
	assertInvariant(solo2[0] === 0 && solo2[1] === 0 && solo2[2] === 375, "único válido no slot 2 recebe 100% do pool (375)");

	// c2. 2 lutadores válidos: 50% / 50% independentemente do dano causado (slot vazio não recebe nem rouba)
	const duoGap = calcPostBattleTeamXp(20, true, [lv20(900), undefined, lv20(0)]);
	assertInvariant(duoGap[0] === 187 && duoGap[1] === 0 && duoGap[2] === 187, "2 válidos (slots 0 e 2): 50% / 50% (187 / 187)");
	const duoTail = calcPostBattleTeamXp(20, true, [undefined, lv20(0), lv20(900)]);
	assertInvariant(duoTail[0] === 0 && duoTail[1] === 187 && duoTail[2] === 187, "2 válidos (slots 1 e 2): 50% / 50% (187 / 187)");

	// c3. 3 lutadores válidos: 50% ao maior dano causado, 25% / 25% aos demais
	const topSlot0 = calcPostBattleTeamXp(20, true, [lv20(50), lv20(30), lv20(10)]);
	assertInvariant(topSlot0[0] === 187 && topSlot0[1] === 93 && topSlot0[2] === 93, "maior dano no slot 0: 187 / 93 / 93");
	const topSlot1 = calcPostBattleTeamXp(20, true, [lv20(10), lv20(50), lv20(30)]);
	assertInvariant(topSlot1[0] === 93 && topSlot1[1] === 187 && topSlot1[2] === 93, "maior dano no slot 1: 93 / 187 / 93");
	const topSlot2 = calcPostBattleTeamXp(20, true, [lv20(10), lv20(30), lv20(50)]);
	assertInvariant(topSlot2[0] === 93 && topSlot2[1] === 93 && topSlot2[2] === 187, "maior dano no slot 2: 93 / 93 / 187");
	// Desempate determinístico no maior dano: menor índice de slot (0 > 1 > 2)
	const tieZero = calcPostBattleTeamXp(20, true, [lv20(0), lv20(0), lv20(0)]);
	assertInvariant(tieZero[0] === 187 && tieZero[1] === 93 && tieZero[2] === 93, "todos com dano 0: slot 0 leva 50%");
	const tieAll = calcPostBattleTeamXp(20, true, [lv20(9), lv20(9), lv20(9)]);
	assertInvariant(tieAll[0] === 187 && tieAll[1] === 93 && tieAll[2] === 93, "todos com mesmo dano: slot 0 leva 50%");
	const tieTopTwo12 = calcPostBattleTeamXp(20, true, [lv20(5), lv20(9), lv20(9)]);
	assertInvariant(tieTopTwo12[0] === 93 && tieTopTwo12[1] === 187 && tieTopTwo12[2] === 93, "empate no topo entre slots 1 e 2: slot 1 leva 50%");
	const tieTopTwo02 = calcPostBattleTeamXp(20, true, [lv20(9), lv20(5), lv20(9)]);
	assertInvariant(tieTopTwo02[0] === 187 && tieTopTwo02[1] === 93 && tieTopTwo02[2] === 93, "empate no topo entre slots 0 e 2: slot 0 leva 50%");
	const topLast = calcPostBattleTeamXp(20, true, [lv20(5), lv20(5), lv20(9)]);
	assertInvariant(topLast[0] === 93 && topLast[1] === 93 && topLast[2] === 187, "slot 2 com dano estritamente maior leva 50%");
	// Entradas de dano inválidas contam como 0
	const badDamage = calcPostBattleTeamXp(20, true, [lv20(0 / 0), lv20(-5), lv20(3)]);
	assertInvariant(badDamage[2] === 187 && badDamage[0] === 93 && badDamage[1] === 93, "dano NaN/negativo vale 0 e perde para dano positivo");

	// c4. 100% do pool sempre aproveitado: frações somam 1 para 1, 2 e 3 válidos
	const fractionSum = (team: readonly [{ level: number; damageDealt: number } | undefined, { level: number; damageDealt: number } | undefined, { level: number; damageDealt: number } | undefined]): number => {
		const fractions = calcTeamXpShareFractions(team);
		return fractions[0] + fractions[1] + fractions[2];
	};
	assertInvariant(
		math.abs(fractionSum([lv20(1), undefined, undefined]) - 1) <= FLOAT_TOLERANCE &&
			math.abs(fractionSum([lv20(1), lv20(2), undefined]) - 1) <= FLOAT_TOLERANCE &&
			math.abs(fractionSum([lv20(1), lv20(2), lv20(3)]) - 1) <= FLOAT_TOLERANCE,
		"frações de 1, 2 e 3 lutadores válidos somam 100% do pool",
	);

	// c5. Ordem: divisão do pool -> multiplicador de nível -> arredondamento só no fim
	// 375 * 0.50 = 187.5 * 1.35 = 253.125 -> 253 (arredondar antes da multiplicação daria 187 * 1.35 = 252)
	const cutBeforeMultiplier = calcPostBattleTeamXp(20, true, [{ level: 1, damageDealt: 10 }, lv20(0), lv20(0)]);
	assertInvariant(cutBeforeMultiplier[0] === 253, "fatia 50% e multiplicador 1.35x aplicados antes do arredondamento (253)");

	// c6. Tabela de multiplicadores por diferença de nível (fronteiras inclusivas)
	const expectedMultipliers: readonly (readonly [number, number])[] = [
		[-10, 1.35],
		[-3, 1.35],
		[-2, 1.15],
		[-1, 1.15],
		[0, 1],
		[1, 1],
		[2, 0.6],
		[3, 0.6],
		[4, 0.25],
		[5, 0.25],
		[6, 0.05],
		[29, 0.05],
	];
	for (const [diff, expected] of expectedMultipliers) {
		assertInvariant(
			math.abs(calcLevelDiffXpMultiplier(20 + diff, 20) - expected) <= FLOAT_TOLERANCE,
			`diff ${diff} deve usar multiplicador ${expected}`,
		);
	}

	// d. Catch-up individual: Nv.1 recebe 1.35x depois da divisão e não infla a XP dos aliados Nv.20 do mesmo time
	const catchUpTeam = calcPostBattleTeamXp(20, true, [{ level: 1, damageDealt: 10 }, lv20(5), lv20(5)]);
	assertInvariant(catchUpTeam[0] === 253, "Nv.1 (maior dano, 50%) contra inimigo Nv.20 recebe 375 * 0.50 * 1.35 = 253");
	assertInvariant(
		catchUpTeam[1] === evenTeam[1] && catchUpTeam[2] === evenTeam[2] && catchUpTeam[1] === 93,
		"aliado Nv.20 mantém 93 XP (25%) mesmo com um Nv.1 no time",
	);
	const catchUpOther = calcPostBattleTeamXp(20, true, [lv20(10), { level: 1, damageDealt: 5 }, lv20(5)]);
	assertInvariant(
		catchUpOther[0] === 187 && catchUpOther[1] === 126 && catchUpOther[2] === 93,
		"Nv.1 em fatia de 25%: 375 * 0.25 * 1.35 = 126; aliados mantêm 187 e 93",
	);
	const catchUpSolo = calcPostBattleTeamXp(20, true, [{ level: 1, damageDealt: 0 }, undefined, undefined]);
	assertInvariant(catchUpSolo[0] === 506 && catchUpSolo[1] === 0 && catchUpSolo[2] === 0, "Nv.1 sozinho: 375 * 1.00 * 1.35 = 506");

	// e. Overlevel: Nv.20 contra inimigo Nv.10 (diff 10) recebe 0.05x depois da divisão e nunca 0 (mínimo 1 XP inteira)
	const overlevelTeam = calcPostBattleTeamXp(10, true, [lv20(5), lv20(5), lv20(5)]);
	assertInvariant(
		overlevelTeam[0] === 5 && overlevelTeam[1] === 2 && overlevelTeam[2] === 2,
		"Nv.20 contra inimigo Nv.10 (pool 225): 112.5 * 0.05 = 5.6 -> 5 e 56.25 * 0.05 = 2.8 -> 2",
	);
	const overlevelSolo = calcPostBattleTeamXp(10, true, [lv20(0), undefined, undefined]);
	assertInvariant(overlevelSolo[0] === 11, "Nv.20 sozinho contra inimigo Nv.10: 225 * 0.05 = 11.25 -> 11");
	const tinyRawTeam = calcPostBattleTeamXp(1, true, [
		{ level: 30, damageDealt: 5 },
		{ level: 30, damageDealt: 1 },
		{ level: 30, damageDealt: 1 },
	]);
	assertInvariant(
		tinyRawTeam[0] === 2 && tinyRawTeam[1] === 1 && tinyRawTeam[2] === 1,
		"inimigo Nv.1: 90 * 0.50 * 0.05 = 2.25 -> 2 e 90 * 0.25 * 0.05 = 1.125 -> 1",
	);
	assertInvariant(
		calcFighterSlotXp(75, 0.25, { level: 30, damageDealt: 1 }, 1) === 1,
		"XP bruta positiva menor que 1 (75 * 0.25 * 0.05 = 0.9375) garante mínimo de 1 XP inteira no cálculo do slot",
	);

	// f. Múltiplos level-ups em uma única entrega e respeito ao level cap
	const resolvedMulti = resolveXpAndLevelUp(
		1,
		0,
		calcXpForNextLevel(1) + calcXpForNextLevel(2) + calcXpForNextLevel(3) + 50,
		{ hp: 0, atk: 0, dodge: 0, crit: 0 },
	);
	assertInvariant(
		resolvedMulti.level === 4 && resolvedMulti.xp === 50 && resolvedMulti.levelsGained === 3,
		"resolveXpAndLevelUp deve subir 3 níveis de uma vez e manter 50 XP residual",
	);
	const resolvedCap = resolveXpAndLevelUp(29, 0, 1_000_000, { hp: 0, atk: 0, dodge: 0, crit: 0 });
	assertInvariant(
		resolvedCap.level === MAX_LEVEL && resolvedCap.xp === 0 && resolvedCap.levelsGained === 1,
		"XP excedente no nível 29 deve parar no cap (Lv30) com XP residual 0",
	);

	const remoteService = new RemoteService();
	const progressionService = new ProgressionService(remoteService);
	const player = { Name: "XpCurveTestPlayer" } as unknown as Player;
	const skills: SkillSlots = [calcSkillSlotRoll(1, 0.25), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.75)];
	const createFighter = (): string =>
		progressionService.createInventoryFighter(player, {
			fighterId: "jotaro",
			rarity: "Comum",
			baseStats: { hp: 200, atk: 12, dodge: 5, crit: 6 },
			skills,
		}).itemUuid;
	const xpToReachLevel = (level: number): number => {
		let total = 0;
		for (const current of $range(MIN_LEVEL, level - 1)) total += calcXpForNextLevel(current);
		return total;
	};

	// f1. Entrega única pelo serviço: Nv.1 (maior dano, 50%) vs inimigo médio 30 => 525 * 0.50 * 1.35 = 354 XP => Lv3 com 54 residual
	const multiUuid = createFighter();
	const filler1 = createFighter();
	const filler2 = createFighter();
	const multiAward = progressionService.awardPostBattleTeamXp(player, 30, true, [
		{ itemUuid: multiUuid, damageDealt: 1 },
		{ itemUuid: filler1, damageDealt: 0 },
		{ itemUuid: filler2, damageDealt: 0 },
	]);
	assertInvariant(
		multiAward[0] !== undefined && multiAward[0].level === 3 && multiAward[0].xp === 54,
		"uma única entrega de XP deve processar múltiplos level-ups em loop (Lv1 -> Lv3, 54 XP residual)",
	);
	assertStoredEqual(progressionService.getFighter(player, multiUuid), multiAward[0], "múltiplos level-ups confirmados no inventário");

	// f2. Cap: nada passa de Lv30 e o XP residual no cap é 0
	const capUuid = createFighter();
	const lv29 = progressionService.addXp(player, capUuid, xpToReachLevel(29));
	assertInvariant(lv29 !== undefined && lv29.level === 29 && lv29.xp === 0, "XP acumulada exata deve levar ao Lv29 sem resíduo");
	const lv30 = progressionService.addXp(player, capUuid, calcXpForNextLevel(29) + 5000);
	assertInvariant(lv30 !== undefined && lv30.level === MAX_LEVEL && lv30.xp === 0, "XP excedente deve respeitar o level cap (Lv30, xp 0)");
	const afterCap = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: capUuid, damageDealt: 1 },
		{ itemUuid: filler1, damageDealt: 0 },
		{ itemUuid: filler2, damageDealt: 0 },
	]);
	assertInvariant(afterCap[0] !== undefined && afterCap[0].level === MAX_LEVEL && afterCap[0].xp === 0, "premiar XP no Lv30 mantém Lv30 e xp 0");

	// d2. Catch-up pelo serviço: Nv.1 (maior dano, 50%) ganha 253 e os Nv.20 do time ganham 93 (25%); nível lido do inventário
	const lowUuid = createFighter();
	const highA = createFighter();
	const highB = createFighter();
	progressionService.addXp(player, highA, xpToReachLevel(20));
	progressionService.addXp(player, highB, xpToReachLevel(20));
	const mixed = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: lowUuid, damageDealt: 1 },
		{ itemUuid: highA, damageDealt: 1 },
		{ itemUuid: highB, damageDealt: 1 },
	]);
	assertInvariant(
		mixed[0] !== undefined &&
			mixed[0].level === 2 &&
			mixed[0].xp === 153 &&
			mixed[1] !== undefined &&
			mixed[1].level === 20 &&
			mixed[1].xp === 93 &&
			mixed[2] !== undefined &&
			mixed[2].level === 20 &&
			mixed[2].xp === 93,
		"serviço aplica divisão e multiplicador individual: Nv.1 recebe 253 (Lv2, 153) e Nv.20 recebe 93",
	);

	// Derrota/Quit não altera XP
	const lossAward = progressionService.awardPostBattleTeamXp(player, 20, false, [
		{ itemUuid: lowUuid, damageDealt: 1 },
		{ itemUuid: highA, damageDealt: 1 },
		{ itemUuid: highB, damageDealt: 1 },
	]);
	assertInvariant(
		lossAward[0] !== undefined &&
			lossAward[0].level === 2 &&
			lossAward[0].xp === 153 &&
			lossAward[1] !== undefined &&
			lossAward[1].xp === 93,
		"sem vitória PvE o awardPostBattleTeamXp não altera nível nem XP",
	);

	// d3. Serviço com 1, 2 e 3 válidos (slots vazios não roubam percentual; desempate por índice de slot)
	const soloSvcUuid = createFighter();
	const soloSvcAward = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: soloSvcUuid, damageDealt: 0 },
		undefined,
		undefined,
	]);
	assertInvariant(
		soloSvcAward[0] !== undefined &&
			soloSvcAward[0].level === 3 &&
			soloSvcAward[0].xp === 206 &&
			soloSvcAward[1] === undefined &&
			soloSvcAward[2] === undefined,
		"serviço [fighterA, undefined, undefined]: A recebe 100% do pool (506 XP -> Lv3, 206)",
	);
	const duoSvcA = createFighter();
	const duoSvcB = createFighter();
	const duoSvcAward = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: duoSvcA, damageDealt: 999 },
		undefined,
		{ itemUuid: duoSvcB, damageDealt: 0 },
	]);
	assertInvariant(
		duoSvcAward[0] !== undefined &&
			duoSvcAward[0].level === 2 &&
			duoSvcAward[0].xp === 153 &&
			duoSvcAward[1] === undefined &&
			duoSvcAward[2] !== undefined &&
			duoSvcAward[2].level === 2 &&
			duoSvcAward[2].xp === 153,
		"serviço com 2 válidos divide 50% / 50% (253 XP cada -> Lv2, 153)",
	);
	const trioA = createFighter();
	const trioB = createFighter();
	const trioC = createFighter();
	progressionService.addXp(player, trioA, xpToReachLevel(20));
	progressionService.addXp(player, trioB, xpToReachLevel(20));
	progressionService.addXp(player, trioC, xpToReachLevel(20));
	const trioTop2 = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: trioA, damageDealt: 10 },
		{ itemUuid: trioB, damageDealt: 20 },
		{ itemUuid: trioC, damageDealt: 50 },
	]);
	assertInvariant(
		trioTop2[0]?.xp === 93 && trioTop2[1]?.xp === 93 && trioTop2[2]?.xp === 187,
		"serviço com 3 válidos entrega 50% (187) ao maior causador de dano (slot 2) e 25% (93) aos demais",
	);
	const trioTie12 = progressionService.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: trioA, damageDealt: 10 },
		{ itemUuid: trioB, damageDealt: 50 },
		{ itemUuid: trioC, damageDealt: 50 },
	]);
	assertInvariant(
		trioTie12[0]?.xp === 93 + 93 && trioTie12[1]?.xp === 93 + 187 && trioTie12[2]?.xp === 187 + 93,
		"serviço desempata maior dano entre slots 1 e 2 dando 50% (187) ao slot 1",
	);
	validateXpHardening();
	print("XP_CURVE_AND_TEAM_DISTRIBUTION_PASSED");
}


/** Endurecimento do XP: UUIDs repetidos/inexistentes, entradas inválidas, teto até Lv30 e bloqueio fora de vitória PvE. */
export function validateXpHardening(): void {
	const service = new SpyProgressionService();
	const player = { Name: "XpHardeningTestPlayer" } as unknown as Player;
	const skills: SkillSlots = [calcSkillSlotRoll(1, 0.25), calcSkillSlotRoll(2, 0.5), calcSkillSlotRoll(3, 0.75)];
	const create = (): string =>
		service.createInventoryFighter(player, {
			fighterId: "jotaro",
			rarity: "Comum",
			baseStats: { hp: 200, atk: 12, dodge: 5, crit: 6 },
			skills,
		}).itemUuid;
	const snapshot = (uuid: string): string => {
		const fighter = service.getFighter(player, uuid)!;
		return `${fighter.level}:${fighter.xp}`;
	};
	const allWin = (a: string, b: string, c: string) =>
		[
			{ itemUuid: a, damageDealt: 1 },
			{ itemUuid: b, damageDealt: 1 },
			{ itemUuid: c, damageDealt: 1 },
		] as const;

	// a. UUID repetido: só a 1ª ocorrência conta (1 válido = 100%: Nv.1 vs inimigo 20 = 375 * 1.35 = 506 => Lv3, 206), nunca 3x
	const dup = create();
	const dupAward = service.awardPostBattleTeamXp(player, 20, true, allWin(dup, dup, dup));
	assertInvariant(
		dupAward[0] !== undefined && dupAward[0].level === 3 && dupAward[0].xp === 206,
		"UUID repetido 3x recebe XP uma única vez, com 100% do pool (Lv3, 206 XP)",
	);
	assertInvariant(dupAward[1] === undefined && dupAward[2] === undefined, "slots duplicados são ignorados (undefined)");
	assertInvariant(snapshot(dup) === "3:206", "inventário do UUID repetido não acumulou XP extra");

	// a2. Repetido misturado: 2 válidos distintos dividem 50% / 50% e mantêm o multiplicador individual (Nv.1 => 253, Nv.20 => 187)
	const dupHigh = create();
	const dupLow = create();
	service.addXp(player, dupHigh, xpToReach(20));
	const mixedDup = service.awardPostBattleTeamXp(player, 20, true, allWin(dupLow, dupHigh, dupLow));
	assertInvariant(
		mixedDup[0] !== undefined &&
			mixedDup[0].level === 2 &&
			mixedDup[0].xp === 153 &&
			mixedDup[1] !== undefined &&
			mixedDup[1].level === 20 &&
			mixedDup[1].xp === 187 &&
			mixedDup[2] === undefined,
		"repetido misto: Nv.1 recebe 253 uma vez e Nv.20 recebe 187 (50% / 50%, multiplicador individual)",
	);

	// b. UUID inexistente é ignorado sem criar item nem afetar os demais
	const realA = create();
	const realB = create();
	const sizeBefore = service.getPlayerData(player)!.inventory.size();
	const missing = service.awardPostBattleTeamXp(player, 20, true, allWin(realA, "uuid-inexistente", realB));
	assertInvariant(
		missing[0] !== undefined && missing[0].xp === 153 && missing[1] === undefined && missing[2] !== undefined && missing[2].xp === 153,
		"UUID inexistente é ignorado e os 2 válidos dividem 50% / 50% (253 cada, Lv2 com 153)",
	);
	assertInvariant(service.getPlayerData(player)!.inventory.size() === sizeBefore, "UUID inexistente não cria item no inventário");
	const emptyUuid = service.awardPostBattleTeamXp(player, 20, true, allWin("", "", ""));
	assertInvariant(
		emptyUuid[0] === undefined && emptyUuid[1] === undefined && emptyUuid[2] === undefined,
		"UUIDs vazios não recebem XP",
	);
	assertInvariant(service.addXp(player, "uuid-inexistente", 10) === undefined, "addXp com UUID inexistente retorna undefined");
	assertInvariant(service.addXp(player, "", 10) === undefined, "addXp com UUID vazio retorna undefined");

	// c. Entradas inválidas em addXp: NaN, ±infinito, negativo e tipo errado não alteram nada
	const invalid = create();
	const invalidBefore = snapshot(invalid);
	const badAmounts: readonly unknown[] = [0 / 0, math.huge, -math.huge, -1, -0.5, "50", true, undefined];
	for (const bad of badAmounts) {
		assertInvariant(
			service.addXp(player, invalid, bad as number) === undefined,
			`addXp deve rejeitar entrada inválida (${tostring(bad)})`,
		);
	}
	assertInvariant(snapshot(invalid) === invalidBefore, "entradas inválidas não alteram nível nem XP");
	assertInvariant(service.addXp(player, invalid, 0) !== undefined && snapshot(invalid) === invalidBefore, "addXp(0) é válido e não altera nada");
	assertInvariant(
		calcBattleTotalXp(math.huge, true) === 0 && calcBattleTotalXp(-math.huge, true) === 0,
		"nível médio inimigo infinito gera 0 XP",
	);
	for (const enemyLevel of [1e300, 1e308, 0 / 0, -1, 0, 30.1, math.huge, -math.huge]) {
		assertInvariant(calcBattleTotalXp(enemyLevel, true) === 0, "nível inimigo inválido gera pool exatamente zero");
		const shares = calcPostBattleTeamXp(enemyLevel, true, [
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
		]);
		assertStoredEqual(shares, [0, 0, 0], "nível inimigo inválido gera exatamente zero XP por slot");
		const ids = [create(), create(), create()];
		service.awardPostBattleTeamXp(player, enemyLevel, true, allWin(ids[0], ids[1], ids[2]));
		for (const id of ids) assertInvariant(snapshot(id) === "1:0", "nível inimigo inválido preserva nível e XP no inventário");
	}
	for (const enemyLevel of [1, 30]) {
		assertInvariant(calcBattleTotalXp(enemyLevel, true) === (enemyLevel === 1 ? 90 : 525), "pool exato nos limites do nível inimigo");
		const shares = calcPostBattleTeamXp(enemyLevel, true, [
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
			{ level: 1, damageDealt: 1 },
		]);
		assertStoredEqual(shares, enemyLevel === 1 ? [45, 22, 22] : [354, 177, 177], "divisão, multiplicador e arredondamento exatos nos limites");
		const ids = [create(), create(), create()];
		service.awardPostBattleTeamXp(player, enemyLevel, true, allWin(ids[0], ids[1], ids[2]));
		assertStoredEqual(ids.map(snapshot), enemyLevel === 1 ? ["1:45", "1:22", "1:22"] : ["3:54", "2:77", "2:77"], "estado final exato após recompensa nos limites");
	}

	// d. Teto derivado da curva (soma Lv1..Lv29 = 43.500) e múltiplos level-ups até Lv30
	assertInvariant(calcMaxUsefulXp() === 43500, "teto de XP útil = soma de calcXpForNextLevel(1..29)");
	const climber = create();
	const stepped = service.addXp(player, climber, calcXpForNextLevel(1) + calcXpForNextLevel(2) + calcXpForNextLevel(3) + 7);
	assertInvariant(stepped !== undefined && stepped.level === 4 && stepped.xp === 7, "3 level-ups em uma chamada (Lv4, 7 XP)");
	const exactMax = create();
	const atMax = service.addXp(player, exactMax, calcMaxUsefulXp());
	assertInvariant(atMax !== undefined && atMax.level === MAX_LEVEL && atMax.xp === 0, "XP total da curva leva exatamente ao Lv30 (xp 0)");
	const absurd = create();
	const absurdResult = service.addXp(player, absurd, 1e308);
	assertInvariant(
		absurdResult !== undefined && absurdResult.level === MAX_LEVEL && absurdResult.xp === 0,
		"valor finito absurdo é limitado ao teto e resulta em Lv30, xp 0",
	);
	assertInvariant(
		service.addXp(player, absurd, 1e308)?.level === MAX_LEVEL,
		"XP repetido absurdo no Lv30 permanece Lv30 sem overflow",
	);
	const resolvedHuge = resolveXpAndLevelUp(1, 0, math.huge, { hp: 0, atk: 0, dodge: 0, crit: 0 });
	assertInvariant(resolvedHuge.level === 1 && resolvedHuge.xp === 0, "resolveXpAndLevelUp ignora XP infinito/NaN");

	// e. Sem vitória PvE (derrota ou fuga) não há XP nem chamada a addXp; retorno preserva o estado atual
	const lossA = create();
	const lossB = create();
	const lossC = create();
	const lossBefore = `${snapshot(lossA)}|${snapshot(lossB)}|${snapshot(lossC)}`;
	const callsBefore = service.addXpCalls;
	const lossResult = service.awardPostBattleTeamXp(player, 20, false, allWin(lossA, lossB, lossC));
	const pvpResult = service.awardPostBattleTeamXp(player, 20, false, allWin(lossA, lossA, "uuid-inexistente"));
	assertInvariant(service.addXpCalls === callsBefore, "derrota/fuga não chamam addXp");
	assertInvariant(
		`${snapshot(lossA)}|${snapshot(lossB)}|${snapshot(lossC)}` === lossBefore,
		"derrota/fuga não alteram nível nem XP",
	);
	assertInvariant(
		lossResult[0]?.itemUuid === lossA && lossResult[1]?.itemUuid === lossB && lossResult[2]?.itemUuid === lossC,
		"sem vitória PvE o retorno preserva os lutadores atuais",
	);
	assertInvariant(pvpResult[2] === undefined, "sem vitória PvE UUID inexistente retorna undefined");
	assertInvariant(pvpResult[1] === undefined, "PvP tambem preserva undefined no slot duplicado");
	service.awardPostBattleTeamXp(player, 20, false, allWin(lossA, lossB, lossC)); // fuga
	assertInvariant(`${snapshot(lossA)}|${snapshot(lossB)}|${snapshot(lossC)}` === lossBefore, "fuga preserva estado final");

	// Cada posicao invalida preserva as recompensas individuais e a ordem.
	for (const badUuid of ["", "missing", 42 as unknown as string]) {
		for (const badIndex of $range(0, 2)) {
			const ids = [create(), create(), create()];
			service.addXp(player, ids[1], xpToReach(20));
			const team = [
				{ itemUuid: badIndex === 0 ? badUuid : ids[0], damageDealt: 1 },
				{ itemUuid: badIndex === 1 ? badUuid : ids[1], damageDealt: 1 },
				{ itemUuid: badIndex === 2 ? badUuid : ids[2], damageDealt: 0 },
			] as const;
			const before = ids.map(snapshot);
			const result = service.awardPostBattleTeamXp(player, 20, true, team);
			const expected = ["2:153", "20:187", "2:153"];
			for (const index of $range(0, 2)) {
				assertInvariant(snapshot(ids[index]) === (index === badIndex ? before[index] : expected[index]), "slot invalido nao altera XP dos validos");
				assertInvariant(index === badIndex ? result[index] === undefined : result[index]?.itemUuid === ids[index], "posicoes preservadas");
			}
		}
	}
	const first = create();
	const other = create();
	service.awardPostBattleTeamXp(player, 20, true, [
		{ itemUuid: first, damageDealt: 0 },
		{ itemUuid: first, damageDealt: 1 },
		{ itemUuid: other, damageDealt: 1 },
	]);
	assertInvariant(snapshot(first) === "2:153" && snapshot(other) === "2:153", "primeira participacao prevalece: 2 validos dividem 50% / 50% sem duplicar XP");

	// Fronteira exata e excesso em todos os niveis, consultando o inventario final.
	for (const level of $range(1, MAX_LEVEL - 1)) {
		const uuid = create();
		service.addXp(player, uuid, xpToReach(level) + 7);
		const remaining = 43500 - xpToReach(level) - 7;
		service.addXp(player, uuid, remaining - 1);
		assertInvariant(snapshot(uuid) === "29:2899", "um XP antes do teto em qualquer nivel");
		service.addXp(player, uuid, 1);
		assertInvariant(snapshot(uuid) === "30:0", "teto exato zera residual");
		service.addXp(player, uuid, 1_000_000);
		assertInvariant(snapshot(uuid) === "30:0", "Lv30 nao acumula residual");
		const excess = create();
		service.addXp(player, excess, xpToReach(level) + 7);
		service.addXp(player, excess, 1_000_000);
		assertInvariant(snapshot(excess) === "30:0", "excesso em nivel intermediario limitado");
	}
	for (const bad of badAmounts) {
		const resolved = resolveXpAndLevelUp(10, 7, bad as number, { hp: 0, atk: 0, dodge: 0, crit: 0 });
		assertInvariant(resolved.level === 10 && resolved.xp === 7, "resolver ignora adicao invalida");
		const capped = resolveXpAndLevelUp(30, bad as number, 1_000_000, { hp: 0, atk: 0, dodge: 0, crit: 0 });
		assertInvariant(capped.level === 30 && capped.xp === 0, "resolver limpa residual invalido no Lv30");
	}
	const winCallsBefore = service.addXpCalls;
	service.awardPostBattleTeamXp(player, 20, true, allWin(lossA, lossB, lossC));
	assertInvariant(service.addXpCalls === winCallsBefore + 3, "vitória PvE ainda chama addXp uma vez por lutador único");
}

export function validateProgressionAndInventory(): void {
	const remoteService = new RemoteService();
	const progressionService = new ProgressionService(remoteService);
	const fakePlayer = { Name: "ProgressionTestPlayer" } as unknown as Player;

	// 2. Schema versionado, itemUuid permanente gerado no server e imutabilidade de baseStats / rolls de skills
	const initialBaseStats: StatBlock = { hp: 200, atk: 12, dodge: 5, crit: 6 };
	const initialSkills: SkillSlots = [
		calcSkillSlotRoll(1, 0.25),
		calcSkillSlotRoll(2, 0.5),
		calcSkillSlotRoll(3, 0.75),
	];
	const fighterA = progressionService.createInventoryFighter(fakePlayer, {
		fighterId: "jotaro",
		rarity: "Lendária",
		baseStats: initialBaseStats,
		skills: initialSkills,
	});
	const fighterB = progressionService.createInventoryFighter(fakePlayer, {
		fighterId: "anubis",
		rarity: "Épica",
		baseStats: { hp: 175, atk: 11, dodge: 6, crit: 7 },
		skills: initialSkills,
	});
	const fighterC = progressionService.createInventoryFighter(fakePlayer, {
		fighterId: "jotaro",
		rarity: "Comum",
		baseStats: initialBaseStats,
		skills: initialSkills,
	});

	const playerData = progressionService.getPlayerData(fakePlayer);
	assertInvariant(
		playerData !== undefined &&
			playerData.version === PLAYER_DATA_SCHEMA_VERSION &&
			playerData.inventory.size() === 3,
		"estado em memória deve usar schema versionado com os 3 lutadores criados",
	);
	assertInvariant(
		fighterA.itemUuid.size() >= 32 &&
			fighterA.itemUuid !== fighterB.itemUuid &&
			fighterA.itemUuid !== fighterC.itemUuid,
		"itemUuid deve ser gerado no servidor via HttpService:GenerateGUID e único por instância",
	);
	assertInvariant(
		fighterA.level === 1 &&
			calcTotalPointsForLevel(1) === 0 &&
			progressionService.getAvailablePoints(fakePlayer, fighterA.itemUuid) === 0,
		"Lv1 deve começar sem pontos disponíveis (0)",
	);
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 1),
		"não deve permitir alocar pontos no Lv1 (0 pontos disponíveis)",
	);

	// Award XP pós-batalha para a equipe no ProgressionService (inimigo nível médio 20: pool 375, 50% / 25% / 25%, catch-up 1.35x)
	const awarded = progressionService.awardPostBattleTeamXp(fakePlayer, 20, true, [
		{ itemUuid: fighterA.itemUuid, damageDealt: 1 },
		{ itemUuid: fighterB.itemUuid, damageDealt: 1 },
		{ itemUuid: fighterC.itemUuid, damageDealt: 0 },
	]);
	assertInvariant(
		awarded[0] !== undefined &&
			awarded[0].level === 2 &&
			awarded[0].xp === 253 - calcXpForNextLevel(1) &&
			awarded[1] !== undefined &&
			awarded[1].level === 2 &&
			awarded[1].xp === 26 &&
			awarded[2] !== undefined &&
			awarded[2].level === 2 &&
			awarded[2].xp === 26,
		"awardPostBattleTeamXp deve aplicar divisão 50% / 25% / 25%, multiplicador por nível e subir de nível quando atingir a curva",
	);

	// 3. Cap por nível (cap por stat = nível atual) e trava de pares (|ATK - Dodge| <= 5 e |HP - Crit| <= 5)
	// Sobe fighterA até o Lv4 (total 6 pontos disponíveis)
	while ((progressionService.getFighter(fakePlayer, fighterA.itemUuid)?.level ?? 1) < 4) {
		const currentLvl = progressionService.getFighter(fakePlayer, fighterA.itemUuid)!.level;
		progressionService.addXp(fakePlayer, fighterA.itemUuid, calcXpForNextLevel(currentLvl));
	}
	assertInvariant(
		progressionService.getFighter(fakePlayer, fighterA.itemUuid)?.level === 4 &&
			progressionService.getAvailablePoints(fakePlayer, fighterA.itemUuid) === 6,
		"no Lv4 o lutador deve ter 6 pontos disponíveis ((4 - 1) * 2)",
	);
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 5),
		"deve rejeitar alocação que excede o cap por atributo igual ao nível atual (5 > Lv4)",
	);
	assertInvariant(
		progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 4),
		"deve permitir alocar 4 pontos em ATK no Lv4 (cap = 4, |4 - 0| <= 5)",
	);

	// Sobe fighterA até o Lv7 (total 12 pontos, 8 disponíveis, ATK já está em 4 e Dodge em 0)
	while ((progressionService.getFighter(fakePlayer, fighterA.itemUuid)?.level ?? 1) < 7) {
		const currentLvl = progressionService.getFighter(fakePlayer, fighterA.itemUuid)!.level;
		progressionService.addXp(fakePlayer, fighterA.itemUuid, calcXpForNextLevel(currentLvl));
	}
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 2),
		"deve rejeitar ATK=6 com Dodge=0 por violar a trava de par |ATK - Dodge| <= 5",
	);
	assertInvariant(
		progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "dodge", 2) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 2),
		"após subir Dodge para 2, deve permitir subir ATK para 6 (|6 - 2| = 4 <= 5 e 6 <= Lv7)",
	);
	assertInvariant(
		!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 6),
		"deve rejeitar HP=6 com Crit=0 por violar a trava de par |HP - Crit| <= 5",
	);

	// 4. Lv30 máximo, 58 pontos totais no Lv30, ganhos por ponto e imutabilidade de itemUuid/baseStats/skills
	const lv30Fighter = progressionService.addXp(fakePlayer, fighterA.itemUuid, 1_000_000);
	assertInvariant(
		lv30Fighter !== undefined &&
			lv30Fighter.level === MAX_LEVEL &&
			lv30Fighter.xp === 0 &&
			calcTotalPointsForLevel(lv30Fighter.level) === TOTAL_STAT_POINTS &&
			TOTAL_STAT_POINTS === 58,
		"no Lv30 (nível máximo) o lutador deve ter exatamente 58 pontos totais e XP zerado",
	);

	// Já alocou 6 em ATK e 2 em Dodge (8 pontos). Aloca os 50 pontos restantes respeitando pares e cap <= 30:
	// Alvo final: ATK=15 (+9), Dodge=14 (+12), HP=15 (+15), Crit=14 (+14) -> soma = 58
	assertInvariant(
		progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "dodge", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "dodge", 7) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "atk", 4) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "hp", 5) &&
			progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 4),
		"deve permitir distribuir todos os 58 pontos no Lv30 respeitando |ATK-Dodge|<=5 e |HP-Crit|<=5",
	);
	assertInvariant(
		progressionService.getAvailablePoints(fakePlayer, fighterA.itemUuid) === 0 &&
			!progressionService.allocatePoints(fakePlayer, fighterA.itemUuid, "crit", 1),
		"após alocar os 58 pontos no Lv30, deve restar 0 disponíveis e rejeitar pontos extras",
	);

	const finalFighterA = progressionService.getFighter(fakePlayer, fighterA.itemUuid)!;
	const effectiveStats = progressionService.getEffectiveStats(fakePlayer, fighterA.itemUuid)!;
	assertInvariant(
		math.abs(effectiveStats.hp - (initialBaseStats.hp + 15 * HP_PER_POINT)) <= FLOAT_TOLERANCE &&
			effectiveStats.atk === initialBaseStats.atk + 15 * ATK_PER_POINT &&
			effectiveStats.dodge === initialBaseStats.dodge + 14 * DODGE_POINTS_PER_POINT &&
			effectiveStats.crit === initialBaseStats.crit + 14 * CRIT_POINTS_PER_POINT,
		"stats efetivos devem somar +12.5 HP/pt e +1 ATK, Dodge e Crit/pt sobre os baseStats",
	);
	assertInvariant(
		finalFighterA.itemUuid === fighterA.itemUuid &&
			finalFighterA.baseStats.hp === initialBaseStats.hp &&
			finalFighterA.baseStats.atk === initialBaseStats.atk &&
			finalFighterA.baseStats.dodge === initialBaseStats.dodge &&
			finalFighterA.baseStats.crit === initialBaseStats.crit &&
			finalFighterA.skills[0].t === initialSkills[0].t &&
			finalFighterA.skills[0].cost === initialSkills[0].cost &&
			finalFighterA.skills[0].mult === initialSkills[0].mult &&
			finalFighterA.skills[1].t === initialSkills[1].t &&
			finalFighterA.skills[2].t === initialSkills[2].t,
		"itemUuid, baseStats e rolls de custo/mult nunca podem ser rerrolados",
	);

	// 5. Rejeição de payloads inválidos no Remote RequestAllocate { itemUuid, stat, amount }
	progressionService.addXp(fakePlayer, fighterB.itemUuid, calcXpForNextLevel(1)); // fighterB já está no Lv2 (2 pts) após o XP pós-batalha
	assertInvariant(
		remoteService.readAllocatePayload(undefined) === undefined &&
			remoteService.readAllocatePayload("invalido") === undefined &&
			remoteService.readAllocatePayload({}) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: "", stat: "atk", amount: 1 }) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "velocidade", amount: 1 }) ===
				undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "atk", amount: 0 }) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "atk", amount: -1 }) === undefined &&
			remoteService.readAllocatePayload({ itemUuid: fighterB.itemUuid, stat: "atk", amount: 1.5 }) ===
				undefined &&
			remoteService.readAllocatePayload({
				itemUuid: fighterB.itemUuid,
				stat: "atk",
				amount: TOTAL_STAT_POINTS + 1,
			}) === undefined &&
			remoteService.readAllocatePayload({
				itemUuid: fighterB.itemUuid,
				stat: "atk",
				amount: 1,
				hack: true,
			}) === undefined,
		"RequestAllocate deve rejeitar qualquer payload malformado ou fora dos limites",
	);

	assertInvariant(
		remoteService.processAllocateEvent(fakePlayer, {
			itemUuid: fighterB.itemUuid,
			stat: "hp",
			amount: 1,
		}) && progressionService.getFighter(fakePlayer, fighterB.itemUuid)?.allocatedStats.hp === 1,
		"RequestAllocate válido dentro do rate limit deve alocar o ponto no ProgressionService",
	);

	// Rate limit (bucket próprio do RequestAllocate): após ALLOCATE_REQUEST_BUCKET_CAPACITY requisições seguidas, a próxima é barrada
	const rateLimitPlayer = { Name: "RateLimitAllocatePlayer" } as unknown as Player;
	const fighterRate = progressionService.createInventoryFighter(rateLimitPlayer, {
		fighterId: "jotaro",
		baseStats: initialBaseStats,
		skills: initialSkills,
	});
	progressionService.addXp(rateLimitPlayer, fighterRate.itemUuid, 1_000_000); // Lv30 (58 pontos)
	for (const reqIndex of $range(1, ALLOCATE_REQUEST_BUCKET_CAPACITY)) {
		assertInvariant(
			remoteService.processAllocateEvent(rateLimitPlayer, {
				itemUuid: fighterRate.itemUuid,
				stat: reqIndex % 2 === 1 ? "hp" : "crit",
				amount: 1,
			}),
			"requisições de RequestAllocate até a capacidade do bucket devem passar pelo rate limit",
		);
	}
	assertInvariant(
		!remoteService.processAllocateEvent(rateLimitPlayer, {
			itemUuid: fighterRate.itemUuid,
			stat: "hp",
			amount: 1,
		}),
		"requisição de RequestAllocate além da capacidade do bucket deve ser bloqueada pelo rate limit",
	);

	progressionService.forgetPlayer(rateLimitPlayer);
	remoteService.forgetPlayer(rateLimitPlayer);
	progressionService.forgetPlayer(fakePlayer);
	remoteService.forgetPlayer(fakePlayer);
}

export function validateTinyesEconomy(): void {
	const mock = { Parent: Players as Players | undefined, Name: "TinyesTest", UserId: 991987 };
	const player = mock as Player;
	const data = new PlayerDataService(new ProgressionService(), { forceStudioFallback: true, serverId: "TinyesTest" });
	const notifications: number[] = [];
	const tinyes = new TinyesService(data, (recipient, payload) => {
		assertInvariant(recipient === player, "TinyesChanged isolado por jogador");
		notifications.push(payload.balance);
	});
	assertInvariant(data.loadPlayer(player).ok, "load Tinyes");
	tinyes.syncBalance(player);
	assertInvariant(notifications[0] === INITIAL_TINYES, "notificação inicial após load");
	assertInvariant(!tinyes.spendTinyes(player, 1, "sem saldo").ok && data.getTinyes(player) === INITIAL_TINYES, "spend sem saldo não muda estado");
	for (const amount of [0, -1, 0.5, 0 / 0, math.huge, -math.huge, MAX_SAVED_NUMBER + 1]) {
		assertInvariant(!tinyes.addTinyes(player, amount, "inválido").ok, "add recusa inválido");
		assertInvariant(!tinyes.spendTinyes(player, amount, "inválido").ok, "spend recusa inválido");
		assertInvariant(data.getTinyes(player) === INITIAL_TINYES, "inválido preserva saldo");
	}
	assertInvariant(!tinyes.addTinyes(player, TINYES_MAX_ADD_PER_CALL + 1, "teto").ok, "teto add");
	for (const _ of $range(1, 6)) assertInvariant(tinyes.addTinyes(player, TINYES_MAX_ADD_PER_CALL, "crédito").ok, "add válido");
	assertInvariant(tinyes.spendTinyes(player, 5000, "loja").ok && data.getTinyes(player) === 1000, "spend acima do teto add");
	assertInvariant(!tinyes.spendTinyes(player, 1001, "insuficiente").ok && data.getTinyes(player) === 1000, "saldo insuficiente preservado");
	assertInvariant(tinyes.spendTinyes(player, 1000, "zerar").ok && data.getTinyes(player) === 0, "saldo nunca negativo");
	const range = TINYES_WIN_BY_TIER.Bronze;
	for (const outcome of ["win", "loss", "quit", "disconnect", "timeout", "error", "outside", "pvp"] as const) {
		const before = tinyes.getBalance(player).balance;
		const rng = createSeededRng(FIRST_SIMULATION_SEED);
		const expected = range.min + math.floor(createSeededRng(FIRST_SIMULATION_SEED)() * (range.max - range.min + 1));
		const ended: BattleEndedPayload[] = [];
		const sessions = new BattleSessionService(createSurgicalMockAdapter({ onBattleEnded: (_, payload) => ended.push(payload) }), tinyes);
		const side = createDummySide(() => 0.5);
		const enemy = createDummySide(() => 0.5);
		assertInvariant(sessions.createSession(player, undefined, side, enemy, rng, outcome === "pvp" ? "PVP" : "PVE"), "cria sessão Tinyes");
		const internal = sessions as unknown as { activeSessions: { battle: BattleService; rewardPaid: boolean }[] };
		const record = internal.activeSessions[0];
		if (outcome === "quit") sessions.requestQuit(player);
		else if (outcome === "disconnect") sessions.destroySessionForPlayer(player);
		else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
		else if (outcome === "error") {
			record.battle.step = () => error("erro intencional Tinyes");
			sessions.step(SIMULATION_DT);
		} else {
			if (outcome === "outside") mock.Parent = undefined;
			record.battle.events.battleEnd.fire(outcome === "loss" ? enemy : side);
			record.battle.events.battleEnd.fire(side);
		}
		const reward = outcome === "win" ? expected : 0;
		assertInvariant(data.getTinyes(player) === before + reward, `${outcome}: saldo final correto`);
		if (outcome === "win") {
			assertInvariant(record.rewardPaid && reward >= range.min && reward <= range.max, "prêmio único e dentro do range");
			assertInvariant(ended.size() === 1 && ended[0].tinyesReward === reward, "BattleEnded duplicado paga e notifica uma vez");
		}
		mock.Parent = Players;
		sessions.requestQuit(player);
		assertInvariant(data.savePlayer(player).ok, "save Tinyes");
		assertInvariant(data.getLastPersistedSnapshot(player.UserId)?.tinyes === before + reward, `${outcome}: snapshot confirmado contém saldo final`);
	}
	assertInvariant(notifications[notifications.size() - 1] === data.getTinyes(player), "último remote corresponde ao saldo");
	const previous = tinyes.getBalance(player).balance;
	assertInvariant(data.addTinyes(player, MAX_SAVED_NUMBER - previous), "saldo no limite de precisão");
	assertInvariant(!tinyes.addTinyes(player, 1, "overflow").ok && data.getTinyes(player) === MAX_SAVED_NUMBER, "overflow não altera saldo");
	assertInvariant(tinyes.spendTinyes(player, MAX_SAVED_NUMBER, "limite").ok && data.getTinyes(player) === 0, "spend aceita limite seguro e zera");
	assertInvariant(data.savePlayer(player).ok && data.getLastPersistedSnapshot(player.UserId)?.tinyes === 0, "snapshot final zero confirmado");
	print("TINYES_ECONOMY_PASSED");
}

/** Valida os lutadores reais entregues à sessão, incluindo persistência e equipes incompletas. */
export function validateInventoryTestBattles(): void {
	const player = { Parent: Players, Name: "InventoryBattleTest", UserId: 991988 } as unknown as Player;
	const backing = new InMemoryDataStore();
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, {
		dataStore: backing, serverId: "InventoryBattle_A", now: () => 1000,
		waitFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true,
		rng: createSeededRng(FIRST_SIMULATION_SEED),
	});
	let started: BattleStartedPayload | undefined;
	const sessions = new BattleSessionService(createSurgicalMockAdapter({
		onBattleStarted: (_, payload) => started = payload,
	}));
	assertInvariant(!createJotaroVsAnubisBattleSession(sessions, player, progression, data, () => 0.1), "sem load não cria time nem rolls");
	assertInvariant(data.loadPlayer(player).ok, "load para batalha do inventário");
	const starter = progression.getPlayerData(player)!.inventory[0];
	let inventoryBattle = false;
	let inventorySends = 0;
	const inventoryNetwork = new InventoryService(data, progression, () => inventoryBattle, () => inventorySends++);
	for (const team of [[], [starter.itemUuid, starter.itemUuid], ["foreign"], ["a", "b", "c", "d"]]) {
		assertInvariant(!inventoryNetwork.setTeam(player, team), "invalid inventory team");
	}
	inventoryBattle = true;
	assertInvariant(!inventoryNetwork.setTeam(player, [starter.itemUuid]), "team rejected during battle");
	inventoryBattle = false;
	const savedProgression = progression.getPlayerData(player)!;
	progression.loadValidatedPlayerData(player, { ...savedProgression, inventory: [{ ...starter, unavailable: true }] });
	assertInvariant(!inventoryNetwork.setTeam(player, [starter.itemUuid]), "unavailable inventory team");
	progression.loadValidatedPlayerData(player, savedProgression);
	assertInvariant(inventoryNetwork.setTeam(player, [starter.itemUuid]), "valid inventory team");
	progression.addXp(player, starter.itemUuid, 100);
	const sendsBeforeAllocate = inventorySends;
	assertInvariant(progression.allocatePoints(player, starter.itemUuid, "atk", 1), "inventory allocate");
	assertInvariant(inventorySends === sendsBeforeAllocate + 1, "allocate sends inventory");
	assertInvariant(inventoryNetwork.getState(player)!.fighters[0].allocatedStats.atk === 1, "inventory snapshot");

	const jotaro = progression.createInventoryFighter(player, {
		fighterId: "jotaro", baseStats: { hp: 17, atk: 11, dodge: 6, crit: 9 },
		skills: [calcSkillSlotRoll(1, 0.17), calcSkillSlotRoll(2, 0.41), calcSkillSlotRoll(3, 0.83)],
	});
	const anubis = progression.createInventoryFighter(player, {
		fighterId: "anubis", baseStats: { hp: 14, atk: 12, dodge: 5, crit: 10 },
		skills: [calcSkillSlotRoll(1, 0.91), calcSkillSlotRoll(2, 0.28), calcSkillSlotRoll(3, 0.62)],
	});
	assertInvariant(data.setActiveTeam(player, [anubis.itemUuid, jotaro.itemUuid]), "seleciona dois itens fora da ordem do inventário");
	const permanentRolls = (item: typeof jotaro) => ({
		itemUuid: item.itemUuid, baseStats: { ...item.baseStats },
		skills: item.skills.map((roll) => ({ ...roll })),
	});
	const initialJotaro = permanentRolls(jotaro);
	const initialAnubis = permanentRolls(anubis);
	const snapshot = (side: BattleSide) => side.fighters.map((fighter) => ({
		itemUuid: fighter.itemUuid, fighterId: fighter.fighterId, level: fighter.level,
		stats: { ...fighter.stats }, hp: fighter.hp, hpMax: fighter.hpMax,
		slots: fighter.slots.map((roll) => ({ ...roll })),
	}));
	let battleSeed = FIRST_SIMULATION_SEED;
	const start = (p = progression, d = data): readonly [BattleSide, BattleSide] => {
		assertInvariant(createJotaroVsAnubisBattleSession(sessions, player, p, d, createSeededRng(battleSeed++)), "cria batalha do inventário");
		const internal = sessions as unknown as { activeSessions: { sides: readonly [BattleSide, BattleSide] }[] };
		assertInvariant(internal.activeSessions.size() === 1, "substitui a sessão anterior");
		const sides = internal.activeSessions[0].sides;
		assertInvariant(started !== undefined && started.fighters.size() === sides[0].fighters.size() + 3, "payload contém somente integrantes existentes e os três oponentes");
		for (let i = 0; i < sides[0].fighters.size(); i++) {
			const fighter = sides[0].fighters[i];
			const payload = started!.fighters[i];
			assertInvariant(payload.level === fighter.level && payload.hpMax === fighter.hpMax, "HUD recebe level e HP salvos");
			assertStoredEqual(payload.slotCosts, fighter.slots.map((roll) => roll.cost), "HUD recebe custos salvos");
		}
		return sides;
	};
	const [firstPlayer, firstAI] = start();
	const firstSnapshot = snapshot(firstPlayer);
	const aiSnapshot = snapshot(firstAI);
	assertStoredEqual(firstPlayer.fighters.map((f) => f.itemUuid), [anubis.itemUuid, jotaro.itemUuid], "time segue activeTeam, sem starter extra");
	assertStoredEqual(firstPlayer.fighters[0].stats, anubis.baseStats, "Anubis usa seus baseStats salvos");
	assertStoredEqual(firstPlayer.fighters[1].stats, jotaro.baseStats, "Jotaro usa seus baseStats salvos");
	assertStoredEqual(firstPlayer.fighters[0].slots, anubis.skills, "Anubis preserva t/cost/mult dos três slots");
	assertStoredEqual(firstPlayer.fighters[1].slots, jotaro.skills, "Jotaro preserva t/cost/mult dos três slots");
	const [secondPlayer, secondAI] = start();
	assertStoredEqual(snapshot(secondPlayer), firstSnapshot, "duas batalhas: UUID, level, stats, HP e custos idênticos");
	assertStoredEqual(snapshot(secondAI), aiSnapshot, "IA idêntica com outro RNG de combate");
	assertInvariant(firstPlayer.fighters[0] !== secondPlayer.fighters[0] && firstPlayer.fighters[0].slots[0] !== anubis.skills[0], "sessões e inventário possuem cópias independentes");
	secondPlayer.fighters[0].takeDamage(1);
	secondPlayer.fighters[0].applyStatusEffect("Burn", 1, 10);
	const [freshPlayer] = start();
	assertStoredEqual(snapshot(freshPlayer), firstSnapshot, "dano e efeitos da luta anterior não contaminam o inventário");
	assertInvariant(freshPlayer.fighters[0].statusEffects.size() === 0, "nova luta sem efeitos antigos");

	const xpToLevel4 = calcXpForNextLevel(1) + calcXpForNextLevel(2) + calcXpForNextLevel(3);
	assertInvariant(progression.addXp(player, jotaro.itemUuid, xpToLevel4)?.level === 4, "XP eleva Jotaro ao Lv4");
	const [leveledPlayer] = start();
	assertInvariant(leveledPlayer.fighters[1].level === 4, "nova batalha usa nível atualizado");
	assertStoredEqual(leveledPlayer.fighters[1].stats, jotaro.baseStats, "nível libera pontos, sem bônus automático de stats");
	assertStoredEqual(leveledPlayer.fighters[1].slots, initialJotaro.skills, "subir nível preserva os rolls");
	for (const stat of ["hp", "atk", "dodge", "crit"] as const) {
		assertInvariant(progression.allocatePoints(player, jotaro.itemUuid, stat, 1), "aloca ponto para batalha");
	}
	const [allocatedPlayer, allocatedAI] = start();
	assertStoredEqual(allocatedPlayer.fighters[1].stats, {
		hp: jotaro.baseStats.hp + HP_PER_POINT, atk: jotaro.baseStats.atk + ATK_PER_POINT,
		dodge: jotaro.baseStats.dodge + DODGE_POINTS_PER_POINT, crit: jotaro.baseStats.crit + CRIT_POINTS_PER_POINT,
	}, "stats finais usam base mais os quatro atributos alocados");
	assertInvariant(allocatedPlayer.fighters[1].hpMax === jotaro.baseStats.hp + HP_PER_POINT, "HP máximo usa HP efetivo");
	assertStoredEqual(allocatedPlayer.fighters[1].slots, initialJotaro.skills, "alocar pontos preserva t/cost/mult");
	assertStoredEqual(permanentRolls(progression.getFighter(player, jotaro.itemUuid)!), initialJotaro, "progressão preserva UUID/base/rolls");
	assertStoredEqual(permanentRolls(progression.getFighter(player, anubis.itemUuid)!), initialAnubis, "Anubis permanece inalterado");
	assertStoredEqual(snapshot(allocatedAI), aiSnapshot, "progressão do jogador não altera IA");
	const beforeReload = snapshot(allocatedPlayer);
	sessions.requestQuit(player);
	assertInvariant(data.savePlayer(player, true).ok, "salva e libera lock antes do reload");
	const reloadedProgression = new ProgressionService();
	const reloadedData = new PlayerDataService(reloadedProgression, {
		dataStore: backing, serverId: "InventoryBattle_B", now: () => 1001,
		waitFn: () => {}, disableStudioAutoFallbackOnInjectedStore: true,
	});
	assertInvariant(reloadedData.loadPlayer(player).ok, "load em novo serviço");
	const [reloadedPlayer, reloadedAI] = start(reloadedProgression, reloadedData);
	assertStoredEqual(snapshot(reloadedPlayer), beforeReload, "save/load e batalha preservam lutador completo");
	assertStoredEqual(snapshot(reloadedAI), aiSnapshot, "save/load não altera a IA");
	assertStoredEqual(permanentRolls(reloadedProgression.getFighter(player, jotaro.itemUuid)!), initialJotaro, "base/rolls persistidos intactos");

	// Três UUIDs, inclusive dois Jotaros distintos, continuam sendo itens independentes.
	assertInvariant(reloadedData.setActiveTeam(player, [jotaro.itemUuid, anubis.itemUuid, starter.itemUuid]), "seleciona três itens");
	const [fullPlayer, fullAI] = start(reloadedProgression, reloadedData);
	assertStoredEqual(fullPlayer.fighters.map((f) => f.itemUuid), [jotaro.itemUuid, anubis.itemUuid, starter.itemUuid], "três integrantes na ordem selecionada");
	assertStoredEqual(snapshot(fullAI), aiSnapshot, "tamanho do time não altera IA");
	for (const uuids of [[anubis.itemUuid], [jotaro.itemUuid, anubis.itemUuid]]) {
		assertInvariant(reloadedData.setActiveTeam(player, uuids), "seleciona equipe incompleta");
		const [partial] = start(reloadedProgression, reloadedData);
		assertStoredEqual(partial.fighters.map((f) => f.itemUuid), uuids, "sem completar ou duplicar vagas");
		assertInvariant(!partial.trocar(2), "vaga vazia não aceita troca");
		for (const fighter of partial.fighters) {
			fighter.hp = 1;
			fighter.applyStatusEffect("Bleed", 1, 12);
		}
		sessions.step(1.0);
		assertInvariant(partial.isDefeated(), "morte percorre somente integrantes existentes");
		assertInvariant(!sessions.hasActiveSession(player), "último integrante morto encerra sessão incompleta");
	}
	reloadedProgression.forgetPlayer(player);
	reloadedProgression.getOrCreatePlayerData(player);
	assertInvariant(!createJotaroVsAnubisBattleSession(sessions, player, reloadedProgression, reloadedData, () => 0.5), "inventário vazio não gera substitutos");
	assertInvariant(!sessions.hasActiveSession(player), "sem lutadores não cria sessão");
	print("INVENTORY_TEST_BATTLES_PASSED");
}

export function validateProgressionSnapshots(): void {
	const service = new ProgressionService();
	const player = { UserId: 991989 } as Player;
	const created = service.createInventoryFighter(player, {
		fighterId: "jotaro", rarity: "Lendária", equippedChip: "test-chip",
		duo: { activeMember: "Tarkus", partnerHp: 9, partnerHpMax: 17, isSurvivor: false }, baseStats: { hp: 17, atk: 12, dodge: 5, crit: 8 },
		skills: [calcSkillSlotRoll(1, 0.2), calcSkillSlotRoll(2, 0.4), calcSkillSlotRoll(3, 0.6)],
	});
	service.addXp(player, created.itemUuid, 4507);
	const expected = service.getFighter(player, created.itemUuid)!;
	for (const snapshot of [service.getPlayerData(player)!, service.getOrCreatePlayerData(player)]) {
		snapshot.inventory.clear();
		assertInvariant(service.getPlayerData(player)!.inventory.size() === 1, "inventory snapshot isolated");
	}
	for (const item of [created, service.getOrCreatePlayerData(player).inventory[0], service.getPlayerData(player)!.inventory[0], service.getFighter(player, created.itemUuid)!, service.levelUp(player, created.itemUuid)!, service.addXp(player, created.itemUuid, 0)!]) {
		const mutable = item as unknown as { duo: { partnerHp: number }; level: number; xp: number; baseStats: { hp: number }; allocatedStats: { atk: number; hp: number }; skills: { t: number; cost: number; mult: number }[] };
		mutable.duo.partnerHp = 999;
		mutable.level = 30;
		mutable.xp = 99999;
		mutable.baseStats.hp = 99999;
		mutable.allocatedStats.atk = 30;
		mutable.allocatedStats.hp = 30;
		for (const roll of mutable.skills) { roll.t = 1; roll.cost = 999; roll.mult = 999; }
		assertStoredEqual(service.getFighter(player, created.itemUuid), expected, "external mutation isolated");
	}
	assertInvariant(!service.allocatePoints(player, created.itemUuid, "atk", 6), "ATK/Dodge guard");
	assertInvariant(!service.allocatePoints(player, created.itemUuid, "hp", 6), "HP/Crit guard");
	assertInvariant(service.allocatePoints(player, created.itemUuid, "atk", 5), "valid allocation");
	// Percorre o validador real e a entrada da persistencia, sem rerrolar campos.
	const source = service.getPlayerData(player)!;
	const validated = validatePlayerSaveData({ ...source, tinyes: 123, activeTeam: [created.itemUuid], pvp: { pairs: {}, dailyTinyes: 0, dailyXp: 0, dayKey: 0 }, shopRestockCounts: [0, 0, 0] });
	assertInvariant(validated.valid && validated.data !== undefined, "fixture passa pelo validador real");
	const loaded = new ProgressionService();
	loaded.loadValidatedPlayerData(player, validated.data!);
	assertStoredEqual(loaded.getPlayerData(player), source, "load preserva todos os campos, chip, duo e rolls");
	const inputItem = validated.data!.inventory[0] as unknown as { baseStats: { hp: number }; allocatedStats: { atk: number }; skills: { t: number }[]; duo: { partnerHp: number } };
	inputItem.baseStats.hp = 999;
	inputItem.allocatedStats.atk = 999;
	for (const roll of inputItem.skills) roll.t = 999;
	inputItem.duo.partnerHp = 999;
	validated.data!.inventory.clear();
	assertStoredEqual(loaded.getPlayerData(player), source, "load copia profundamente a entrada validada");
	// Item indisponível preserva todos os metadados nas duas reconstruções.
	const unavailableService = new ProgressionService();
	const unavailableItem = { ...expected, unavailable: true };
	unavailableService.loadValidatedPlayerData(player, { version: source.version, inventory: [unavailableItem] });
	const afterXp = { ...unavailableItem, level: expected.level + 1, xp: 0 };
	assertStoredEqual(
		unavailableService.addXp(player, created.itemUuid, calcXpForNextLevel(expected.level) - expected.xp),
		afterXp,
		"addXp retorna item com unavailable, metadados e nível atualizado",
	);
	assertStoredEqual(unavailableService.getFighter(player, created.itemUuid), afterXp, "addXp preserva unavailable e todos os campos no inventário");
	assertStoredEqual(unavailableService.levelUp(player, created.itemUuid), afterXp, "levelUp direto preserva unavailable e metadados");
	assertInvariant(unavailableService.allocatePoints(player, created.itemUuid, "atk", 1), "alocação válida no item indisponível");
	assertStoredEqual(
		unavailableService.getPlayerData(player)!.inventory[0],
		{ ...afterXp, allocatedStats: { ...afterXp.allocatedStats, atk: afterXp.allocatedStats.atk + 1 } },
		"allocatePoints preserva unavailable e todos os demais campos no estado final",
	);
	print("PROGRESSION_SNAPSHOTS_PASSED");
}

/** Trava autoritativa, payload por lutador, troca e seleção/reação da IA. */
export function validateS3Unlock(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	for (const level of $range(MIN_LEVEL, S3_UNLOCK_LEVEL)) {
		const side = new BattleSide([
			makeRealFighter("jotaro", rng, level),
			makeRealFighter("jotaro", rng, level),
			makeRealFighter("jotaro", rng, level),
		], rng);
		const enemy = createDummySide(rng);
		const battle = new BattleService(side, enemy, rng);
		side.setAtb(ATB_MAX);
		const unlocked = level >= S3_UNLOCK_LEVEL;
		assertInvariant(battle.requestSkill(side, 3) === unlocked, `S3 no nível ${level}`);
		assertInvariant(side.atb === (unlocked ? ATB_MAX - side.fighters[0].slots[2].cost : ATB_MAX), "recusa não consome ATB");
		assertInvariant(battle.state === (unlocked ? "PREPARE" : "IDLE"), "estado final após pedido de S3");
		if (!unlocked) {
			const decisions: SkillSlot[] = [];
			const ai = new AIService(battle, side, rng, { requestSkill: (slot) => { decisions.push(slot); return true; }, requestSwitch: () => false });
			for (let decision = 0; decision < SIMULATION_COUNT; decision++) {
				assertInvariant(ai.chooseSkillSlot([1, 2, 3]) !== 3, "IA não escolhe S3 bloqueado");
				ai.step(AI_BRONZE_SKILL_DELAY_MAX_SECONDS);
			}
			assertInvariant(decisions.size() === SIMULATION_COUNT && decisions.every((slot) => slot !== 3), "1000 intenções usam reação normal e nunca S3 bloqueado");
			ai.destroy();
		}
	}
	const low = makeRealFighter("jotaro", rng, S3_UNLOCK_LEVEL - 1);
	const high = makeRealFighter("anubis", rng, S3_UNLOCK_LEVEL);
	const side = new BattleSide([low, high], rng);
	const enemy = createDummySide(rng);
	const player = { Parent: Players, Name: "S3UnlockTest", UserId: 991987 } as unknown as Player;
	let started: BattleStartedPayload | undefined;
	let request: ((player: Player, slot: SkillSlot) => void) | undefined;
	const sessions = new BattleSessionService({
		...createSurgicalMockAdapter({ onBattleStarted: (_, payload) => started = payload }),
		bindRequests(onSkill) { request = onSkill; },
	});
	sessions.start();
	assertInvariant(sessions.createSession(player, undefined, side, enemy, rng, "PVE"), "sessão para pedido forçado");
	assertInvariant(started !== undefined && request !== undefined, "payload e handler registrados");
	const snapshots = started!.fighters.filter((fighter) => fighter.sideId === started!.sides[0]);
	assertInvariant(snapshots[0].s3Unlocked === false && snapshots[1].s3Unlocked === true, "BattleStarted envia trava individual pelo nível do servidor");
	side.setAtb(ATB_MAX);
	request!(player, 3);
	const internal = sessions as unknown as { activeSessions: { battle: BattleService }[] };
	const battle = internal.activeSessions[0].battle;
	assertInvariant(side.atb === ATB_MAX && battle.state === "IDLE", "client forçando S3 é recusado sem alterar estado");
	assertInvariant(battle.requestSwitch(side, 1), "troca para nível liberado");
	assertInvariant(side.getActiveFighter() === high && snapshots[1].s3Unlocked, "ativo usa snapshot liberado");
	assertInvariant(battle.requestSwitch(side, 0), "volta ao nível bloqueado");
	assertInvariant(!battle.requestSkill(side, 3) && !snapshots[0].s3Unlocked, "troca reaplica bloqueio");
	assertInvariant(battle.requestSwitch(side, 1) && battle.requestSkill(side, 3), "S3 aceita após trocar para Lv de desbloqueio");
	sessions.requestQuit(player);
	print("S3_UNLOCK_PASSED");
}

export function validatePostBattleXp(): void {
	const mock = { Parent: Players as Players | undefined, Name: "XpBattle", UserId: 991989 };
	const player = mock as Player;
	const rng = () => 0.5;
	for (const outcome of ["win", "tie", "dot", "invalid", "last", "multi", "cap", "loss", "quit", "disconnect", "timeout", "stall", "error", "outside", "pvp"] as const) {
		const progression = new ProgressionService();
		const template = makeDummyFighter("Fury");
		const items = [0, 1, 2].map(() => progression.createInventoryFighter(player, {
			fighterId: "jotaro", baseStats: template.stats, skills: template.slots,
		}));
		const solo = outcome === "multi" || outcome === "cap";
		if (outcome === "cap") progression.addXp(player, items[0].itemUuid, calcMaxUsefulXp() - 1);
		const before = items.map((item) => progression.getFighter(player, item.itemUuid)!);
		const fighters = before.map((item) => new Fighter({
			itemUuid: item.itemUuid, fighterId: item.fighterId, level: item.level,
			hp: 100, hpMax: 100, stats: template.stats, className: "Fury",
			slots: item.skills, skillData: template.skillData, currentAtbSpeed: template.currentAtbSpeed,
		}));
		const side = new BattleSide(solo ? [fighters[0]] : [fighters[0], fighters[1], fighters[2]], rng);
		const enemyFighter = new Fighter({
			fighterId: "anubis", level: solo ? 30 : 1, hp: 100, hpMax: 100,
			stats: template.stats, className: "Fury", slots: template.slots,
			skillData: template.skillData, currentAtbSpeed: template.currentAtbSpeed,
		});
		const enemy = new BattleSide(outcome === "multi" ? [enemyFighter, new Fighter({ ...enemyFighter, level: 20 })] : [enemyFighter], rng);
		const ended: BattleEndedPayload[] = [];
		const sessions = new BattleSessionService(createSurgicalMockAdapter({
			onBattleEnded: (recipient, payload) => {
				assertInvariant(recipient === player, "XP privado do participante");
				ended.push(payload);
			},
		}), undefined, progression);
		assertInvariant(sessions.createSession(player, undefined, side, enemy, rng, outcome === "pvp" ? "PVP" : "PVE"), "sessão XP");
		const record = (sessions as unknown as { activeSessions: { battle: BattleService; rewardPaid: boolean }[] }).activeSessions[0];
		const battle = record.battle;
		const hit = (index: FighterIndex) => {
			if (side.activeIndex !== index) assertInvariant(battle.requestSwitch(side, index), "troca para causador");
			side.setAtb(10);
			assertInvariant(battle.requestSkill(side, 1), "hit real autorizado");
			battle.step(0.6);
		};
		if (outcome === "win") {
			hit(1);
			const direct = battle.getDamageDealt(side, items[1].itemUuid);
			assertInvariant(direct === 100 - enemyFighter.hp, "dano direto contabiliza HP realmente removido");
			enemyFighter.statusEffects.clear();
			enemyFighter.hp = 1;
			hit(1); // overkill deve contar somente 1, inclusive antes do BattleEnded.
			assertInvariant(battle.getDamageDealt(side, items[1].itemUuid) === direct + 1, "overkill direto conta somente HP restante");
		} else if (outcome === "dot") {
			hit(1);
			const direct = battle.getDamageDealt(side, items[1].itemUuid);
			assertInvariant(enemyFighter.statusEffects.get("Bleed")?.kind === "dot", "hit cria DoT");
			hit(2); // renovação transfere autoria para o novo aplicador.
			const effect = enemyFighter.statusEffects.get("Bleed");
			assertInvariant(effect?.kind === "dot" && effect.source === fighters[2], "renovação guarda causador");
			const secondDirect = battle.getDamageDealt(side, items[2].itemUuid);
			battle.requestSwitch(side, 0);
			enemyFighter.hp = 1;
			battle.step(3); // DoT letal do lutador no banco, limitado ao HP real.
			assertInvariant(battle.getDamageDealt(side, items[1].itemUuid) === direct, "DoT renovado não credita causador antigo");
			assertInvariant(battle.getDamageDealt(side, items[2].itemUuid) === secondDirect + 1, "DoT credita 1 real ao causador no banco");
			assertInvariant(battle.getDamageDealt(side, items[0].itemUuid) === 0, "ativo não rouba DoT");
		} else if (outcome === "quit") sessions.requestQuit(player);
		else if (outcome === "disconnect") sessions.destroySessionForPlayer(player);
		else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
		else if (outcome === "stall") {
			side.setAtb(10);
			battle.requestSkill(side, 1);
			battle.step = () => {};
			sessions.step(31);
		} else if (outcome === "error") {
			battle.step = () => error("erro intencional XP");
			sessions.step(SIMULATION_DT);
		} else {
			if (outcome === "invalid") progression.loadValidatedPlayerData(player, {
				version: PLAYER_DATA_SCHEMA_VERSION, inventory: [items[0], { ...items[2], unavailable: true }],
			});
			if (outcome === "last") progression.loadValidatedPlayerData(player, {
				version: PLAYER_DATA_SCHEMA_VERSION, inventory: [{ ...items[0], unavailable: true }, items[2]],
			});
			if (outcome === "outside") mock.Parent = undefined;
			battle.events.battleEnd.fire(outcome === "loss" ? enemy : side);
		}
		const eligible = ["win", "tie", "dot", "invalid", "last", "multi", "cap"].includes(outcome);
		const finalSnapshot = progression.getPlayerData(player);
		battle.events.battleEnd.fire(side);
		assertStoredEqual(progression.getPlayerData(player), finalSnapshot, "segundo fim não paga XP novamente");
		if (eligible) {
			assertInvariant(record.rewardPaid && ended.size() === 1, "vitória paga e notifica uma vez");
			const rewards = ended[0].xpRewards!;
			assertInvariant(rewards !== undefined && rewards.size() === (solo || outcome === "invalid" || outcome === "last" ? 1 : 3), "somente itens válidos recebem XP");
			for (const reward of rewards) {
				const index = before.findIndex((item) => item.itemUuid === reward.itemUuid);
				const initial = before[index];
				const final = progression.getFighter(player, reward.itemUuid)!;
				assertInvariant(reward.previousLevel === initial.level && reward.previousXp === initial.xp &&
					reward.previousXpToNext === calcXpForNextLevel(initial.level), "previous vem do snapshot anterior");
				assertInvariant(reward.newLevel === final.level && reward.newXp === final.xp &&
					reward.newXpToNext === calcXpForNextLevel(final.level) &&
					reward.leveledUp === (final.level > initial.level), "payload bate com inventário final");
				assertInvariant(reward.fighterId === "jotaro" && reward.displayName === "Jotaro" && reward.className === "Fury", "identidade servidor");
			}
			if (outcome === "win" || outcome === "tie" || outcome === "dot") {
				const top = outcome === "win" ? 1 : outcome === "dot" ? 2 : 0;
				for (const index of $range(0, 2)) assertInvariant(rewards[index].xpGained === (index === top ? 45 : 22), "maior dano/desempate recebe maior fração");
			}
			if (outcome === "invalid") assertInvariant(rewards[0].xpGained === 90 && progression.getFighter(player, items[2].itemUuid)?.xp === 0, "removido/unavailable não roubam fatia");
			if (outcome === "last") assertInvariant(rewards[0].xpGained === 90 && rewards[0].itemUuid === items[2].itemUuid, "vagas inválidas anteriores não ocultam recompensa do último slot");
			if (outcome === "multi") assertInvariant(rewards[0].newLevel === 4 && rewards[0].newXp === 7 && rewards[0].xpGained === 607, "média inimiga 25 da sessão e múltiplos níveis corretos");
			if (outcome === "cap") assertInvariant(rewards[0].newLevel === MAX_LEVEL && rewards[0].newXp === 0 && rewards[0].xpGained === 1, "XP útil no cap");
		} else {
			assertStoredEqual(progression.getPlayerData(player)!.inventory, before, "sem vitória elegível preserva inventário");
			for (const payload of ended) assertInvariant(payload.xpRewards === undefined, "sem xpRewards fora de vitória PVE");
		}
		mock.Parent = Players;
		sessions.requestQuit(player);
	}
	print("POST_BATTLE_XP_PASSED");
}
