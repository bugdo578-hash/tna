import {
	ATK_PER_POINT,
	CRIT_POINTS_PER_POINT,
	DODGE_POINTS_PER_POINT,
	HP_PER_POINT,
	MAX_LEVEL,
	MIN_LEVEL,
	STAT_POINTS_PER_LEVEL,
	TEAM_XP_SLOTS,
	XP_BATTLE_BASE,
	XP_BATTLE_PER_ENEMY_LEVEL,
	XP_LEVEL_DIFF_FLOOR_MULTIPLIER,
	XP_LEVEL_DIFF_TIERS,
	XP_LEVEL_PER_LEVEL,
	XP_MIN_AWARD,
	XP_SHARE_DUO_EACH,
	XP_SHARE_SOLO,
	XP_SHARE_TRIO_OTHER,
	XP_SHARE_TRIO_TOP_DAMAGE,
} from "./Config";
import { clamp, isValidStatAllocation } from "./MathUtils";
import type { AllocatableStat, StatBlock } from "./TypeDefs";

/** Participação individual de um lutador do time ao final da batalha. */
export interface FighterBattleParticipation {
	/** Dano total causado pelo lutador na batalha (usado só para achar o maior causador de dano). */
	readonly damageDealt: number;
}

/** Participação + nível atual do lutador (entrada da função pura de XP pós-batalha). */
export interface FighterXpInput extends FighterBattleParticipation {
	readonly level: number;
}

/** Resultado puro da adição de XP e resolução de subidas de nível. */
export interface XpResolutionResult {
	readonly level: number;
	readonly xp: number;
	readonly levelsGained: number;
	readonly availablePoints: number;
}

/**
 * Total acumulado de pontos de atributo desbloqueados em `level`:
 * - Lv1: 0 pontos
 * - +2 pontos por nível acima do 1 (58 pontos no Lv30)
 */
export function calcTotalPointsForLevel(level: number): number {
	const clampedLevel = clamp(math.floor(level), MIN_LEVEL, MAX_LEVEL);
	return (clampedLevel - MIN_LEVEL) * STAT_POINTS_PER_LEVEL;
}

/** Soma total dos pontos já alocados nos 4 atributos. */
export function calcAllocatedPointsSum(allocatedStats: StatBlock): number {
	return allocatedStats.hp + allocatedStats.atk + allocatedStats.dodge + allocatedStats.crit;
}

/** Quantidade de pontos disponíveis para distribuir dado o nível atual e os pontos já alocados. */
export function calcAvailablePoints(level: number, allocatedStats: StatBlock): number {
	return math.max(0, calcTotalPointsForLevel(level) - calcAllocatedPointsSum(allocatedStats));
}

/**
 * Curva provisória de XP necessária para subir de `level` para `level + 1`:
 * `XP_LEVEL_PER_LEVEL * level` (Nv.1 = 100, Nv.10 = 1.000, Nv.20 = 2.000).
 * Retorna `0` quando o lutador já atingiu `MAX_LEVEL` (30).
 */
export function calcXpForNextLevel(level: number): number {
	const clampedLevel = clamp(math.floor(level), MIN_LEVEL, MAX_LEVEL);
	if (clampedLevel >= MAX_LEVEL) return 0;
	return XP_LEVEL_PER_LEVEL * clampedLevel;
}

/**
 * Teto seguro de XP derivado da curva existente: soma de `calcXpForNextLevel` de `MIN_LEVEL` até `MAX_LEVEL - 1`
 * (XP necessária para ir do Lv1 ao Lv30). Qualquer XP acima disso não muda o resultado final (Lv30, xp 0).
 */
export function calcMaxUsefulXp(): number {
	let total = 0;
	for (const level of $range(MIN_LEVEL, MAX_LEVEL - 1)) {
		total += calcXpForNextLevel(level);
	}
	return total;
}

/** `true` apenas para número finito (não NaN, não ±infinito) e não negativo. */
export function isValidXpAmount(value: unknown): value is number {
	if (typeOf(value) !== "number") return false;
	const numeric = value as number;
	return numeric === numeric && numeric >= 0 && numeric < math.huge;
}

/** Normaliza XP: inválido (NaN, infinito, negativo, não numérico) vira 0 e o resto é limitado a `calcMaxUsefulXp()`. */
function sanitizeXp(value: number): number {
	if (!isValidXpAmount(value)) return 0;
	return math.min(value, calcMaxUsefulXp());
}

/**
 * Resolve ganho de XP e potenciais múltiplos level-ups até `MAX_LEVEL` (30).
 * No nível máximo, o XP residual é fixado em `0`.
 * Pré-condição: `currentLevel` deve ser finito e estar em [MIN_LEVEL, MAX_LEVEL].
 */
export function resolveXpAndLevelUp(
	currentLevel: number,
	currentXp: number,
	addedXp: number,
	allocatedStats: StatBlock,
): XpResolutionResult {
	let level = clamp(math.floor(currentLevel), MIN_LEVEL, MAX_LEVEL);
	let xp = sanitizeXp(currentXp) + sanitizeXp(addedXp);
	let levelsGained = 0;

	while (level < MAX_LEVEL) {
		const requiredXp = calcXpForNextLevel(level);
		if (xp < requiredXp) break;
		xp -= requiredXp;
		level += 1;
		levelsGained += 1;
	}

	if (level >= MAX_LEVEL) {
		level = MAX_LEVEL;
		xp = 0;
	}

	return {
		level,
		xp,
		levelsGained,
		availablePoints: calcAvailablePoints(level, allocatedStats),
	};
}

/**
 * Calcula os stats efetivos do lutador somando os `baseStats` (imutáveis) aos pontos alocados:
 * - HP: +12.5 por ponto
 * - ATK: +1 por ponto
 * - Dodge: +1 por ponto (1 pt = 1%)
 * - Crit: +1 por ponto (1 pt = 1.5%)
 */
export function calcEffectiveStats(baseStats: StatBlock, allocatedStats: StatBlock): StatBlock {
	return {
		hp: baseStats.hp + allocatedStats.hp * HP_PER_POINT,
		atk: baseStats.atk + allocatedStats.atk * ATK_PER_POINT,
		dodge: baseStats.dodge + allocatedStats.dodge * DODGE_POINTS_PER_POINT,
		crit: baseStats.crit + allocatedStats.crit * CRIT_POINTS_PER_POINT,
	};
}

/**
 * Retorna um novo `StatBlock` com `+amount` pontos adicionados em `stat`, ou `undefined` se violar
 * qualquer regra do GDD (inteiro >= 1, cap por nível, total disponível ou trava de pares <= 5).
 */
export function tryAllocateStatPoints(
	allocatedStats: StatBlock,
	level: number,
	stat: AllocatableStat,
	amount: number,
): StatBlock | undefined {
	if (typeOf(amount) !== "number" || math.floor(amount) !== amount || amount < 1) {
		return undefined;
	}
	const nextAllocated: StatBlock = {
		hp: allocatedStats.hp + (stat === "hp" ? amount : 0),
		atk: allocatedStats.atk + (stat === "atk" ? amount : 0),
		dodge: allocatedStats.dodge + (stat === "dodge" ? amount : 0),
		crit: allocatedStats.crit + (stat === "crit" ? amount : 0),
	};
	if (!isValidStatAllocation(nextAllocated, level)) {
		return undefined;
	}
	return nextAllocated;
}

/**
 * Pool total de XP da batalha (Passo 0): `XP_BATTLE_BASE + XP_BATTLE_PER_ENEMY_LEVEL * avgEnemyLevel`.
 * Só vitória PvE paga; derrota, Quit, desconexão, timeout ou nível médio inválido retornam 0.
 */
export function calcBattleTotalXp(avgEnemyLevel: number, rewardEligible: boolean): number {
	if (!rewardEligible) return 0;
	if (!isValidXpAmount(avgEnemyLevel) || avgEnemyLevel < MIN_LEVEL || avgEnemyLevel > MAX_LEVEL) return 0;
	return XP_BATTLE_BASE + XP_BATTLE_PER_ENEMY_LEVEL * avgEnemyLevel;
}

/**
 * Multiplicador individual de XP por diferença de nível (`diff = charLevel - avgEnemyLevel`).
 * Percorre `XP_LEVEL_DIFF_TIERS` em ordem crescente; acima da última faixa vale o piso anti-farm.
 */
export function calcLevelDiffXpMultiplier(charLevel: number, avgEnemyLevel: number): number {
	const diff = charLevel - avgEnemyLevel;
	for (const tier of XP_LEVEL_DIFF_TIERS) {
		if (diff <= tier.maxDiff) return tier.multiplier;
	}
	return XP_LEVEL_DIFF_FLOOR_MULTIPLIER;
}

/**
 * Fração do pool total de XP de cada slot do time, conforme a quantidade de lutadores válidos
 * (slots `undefined` não contam e não roubam fatia; 100% do pool sempre é aproveitado):
 * - 1 válido: 100% (`XP_SHARE_SOLO`)
 * - 2 válidos: 50% / 50% (`XP_SHARE_DUO_EACH`)
 * - 3 válidos: 50% ao maior `damageDealt` (`XP_SHARE_TRIO_TOP_DAMAGE`), 25% / 25% aos demais (`XP_SHARE_TRIO_OTHER`);
 *   empate no maior dano (inclusive 0) vai para o menor índice de slot.
 */
export function calcTeamXpShareFractions(
	team: readonly [(FighterXpInput | undefined)?, (FighterXpInput | undefined)?, (FighterXpInput | undefined)?],
): readonly [number, number, number] {
	const fractions: [number, number, number] = [0, 0, 0];
	let validCount = 0;
	for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
		if (team[index] !== undefined) validCount += 1;
	}
	if (validCount === 1) {
		for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
			if (team[index] !== undefined) fractions[index] = XP_SHARE_SOLO;
		}
	} else if (validCount === 2) {
		for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
			if (team[index] !== undefined) fractions[index] = XP_SHARE_DUO_EACH;
		}
	} else if (validCount === TEAM_XP_SLOTS) {
		let topIndex = 0;
		let topDamage = isValidXpAmount(team[0]!.damageDealt) ? team[0]!.damageDealt : 0;
		for (const index of $range(1, TEAM_XP_SLOTS - 1)) {
			const damage = isValidXpAmount(team[index]!.damageDealt) ? team[index]!.damageDealt : 0;
			// Estritamente maior: em empate vence o menor índice de slot.
			if (damage > topDamage) {
				topIndex = index;
				topDamage = damage;
			}
		}
		for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
			fractions[index] = index === topIndex ? XP_SHARE_TRIO_TOP_DAMAGE : XP_SHARE_TRIO_OTHER;
		}
	}
	return [fractions[0], fractions[1], fractions[2]];
}

/**
 * XP inteira de um slot do time, na ordem exata:
 * A) `totalBattleXp * shareFraction` (divisão por tamanho do time); B) multiplicador por diferença de nível do
 * próprio lutador; C) `max(1, floor(raw))` se `raw > 0`, limitado ao teto útil da curva.
 */
export function calcFighterSlotXp(
	totalBattleXp: number,
	shareFraction: number,
	member: FighterXpInput,
	avgEnemyLevel: number,
): number {
	const baseSlotXp = totalBattleXp * shareFraction;
	const rawXp = baseSlotXp * calcLevelDiffXpMultiplier(member.level, avgEnemyLevel);
	if (!isValidXpAmount(rawXp) || rawXp <= 0) return 0;
	return math.min(calcMaxUsefulXp(), math.max(XP_MIN_AWARD, math.floor(rawXp)));
}

/**
 * Função pura (sem Players/DataStore) do XP pós-batalha por slot do time.
 * Pipeline: pool total (só vitória PvE) → fração por quantidade de lutadores válidos → multiplicador individual
 * de nível → arredondamento. Slots `undefined` recebem 0 e não participam da divisão.
 */
export function calcPostBattleTeamXp(
	avgEnemyLevel: number,
	rewardEligible: boolean,
	team: readonly [(FighterXpInput | undefined)?, (FighterXpInput | undefined)?, (FighterXpInput | undefined)?],
): readonly [number, number, number] {
	const totalBattleXp = calcBattleTotalXp(avgEnemyLevel, rewardEligible);
	const fractions = calcTeamXpShareFractions(team);
	const shares: [number, number, number] = [0, 0, 0];
	for (const index of $range(0, TEAM_XP_SLOTS - 1)) {
		const member = team[index];
		shares[index] = member !== undefined ? calcFighterSlotXp(totalBattleXp, fractions[index], member, avgEnemyLevel) : 0;
	}
	return [shares[0], shares[1], shares[2]];
}

