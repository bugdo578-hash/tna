import {
	SHOP_MAX_LEVEL, SHOP_PRICE_LEVEL_WEIGHT, SHOP_PRICE_QUALITY_WEIGHT, SHOP_PRICE_RANGES,
	ATB_COST_RANGES,
	BASE_ATB_SPEED,
	CRIT_MULTIPLIER,
	D_SLOT,
	HYBRID_HEAL,
	MAX_LEVEL,
	MAX_MODIFIER_STACKS,
	MAX_STAT_POINT_DIFFERENCE,
	MIN_DAMAGE,
	MIN_LEVEL,
	STAT_POINT_PAIRS,
	STAT_POINTS_PER_LEVEL,
} from "./Config";
import { CLASS_DATA, getCounterMultiplier } from "./ClassData";
import type { ClassName, Rarity, SkillSlot, SkillSlotRoll, StatBlock } from "./TypeDefs";

/** Qualidade média dos quatro atributos; skills não participam do preço. */
export function calcStatQuality(className: ClassName, stats: StatBlock): number {
	const ranges = CLASS_DATA[className].baseStats;
	let total = 0;
	for (const stat of ["hp", "atk", "dodge", "crit"] as const) {
		const range = ranges[stat];
		total += clamp((stats[stat] - range.min) / (range.max - range.min), 0, 1);
	}
	return total / 4;
}

/** Função pura: preço por raridade, qualidade dos atributos e nível da oferta. */
export function calcOfferPrice(rarity: Rarity, statQuality: number, level: number): number {
	const range = SHOP_PRICE_RANGES[rarity];
	const fraction = clamp((level - 1) / (SHOP_MAX_LEVEL - 1), 0, 1);
	const score = SHOP_PRICE_LEVEL_WEIGHT * fraction + SHOP_PRICE_QUALITY_WEIGHT * clamp(statQuality, 0, 1);
	return math.round(range.min + (range.max - range.min) * score);
}

const MIN_ALLIES = 1;
const LEVEL_SCALE_BASE = 0.5;
const LEVEL_SCALE_RANGE = 0.5;

/** Restringe `value` ao intervalo `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
	return math.min(math.max(value, min), max);
}

/** Interpolação linear entre `a` e `b` pelo fator `t`. */
export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** Calcula o custo de ATB do slot a partir do roll `t` (restrito a `[0, 1]`). */
export function calcCusto(slot: SkillSlot, t: number): number {
	const range = ATB_COST_RANGES[slot];
	return lerp(range.min, range.max, clamp(t, 0, 1));
}

/** Calcula o multiplicador de dano do slot em função do seu custo ATB. */
export function calcMult(slot: SkillSlot, custo: number): number {
	return D_SLOT[slot] * (custo / BASE_ATB_SPEED);
}

/**
 * Gera o `SkillSlotRoll` completo (`t`, `cost`, `mult`) a partir de um único roll `t` (0 a 1).
 * Garante que custo e multiplicador sejam sempre derivados do mesmo `t`.
 */
export function calcSkillSlotRoll(slot: SkillSlot, t: number): SkillSlotRoll {
	const normalizedT = clamp(t, 0, 1);
	const cost = calcCusto(slot, normalizedT);
	const mult = calcMult(slot, cost);
	return { t: normalizedT, cost, mult };
}

/**
 * Escala linear de nível do GDD:
 * `levelScale = 0.5 + ((level - 1) / 29) * 0.5` (0.5 no Lv1 até 1.0 no Lv30).
 */
export function calcLevelScale(level: number): number {
	const clampedLevel = clamp(level, MIN_LEVEL, MAX_LEVEL);
	return LEVEL_SCALE_BASE + ((clampedLevel - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL)) * LEVEL_SCALE_RANGE;
}

/**
 * Dano base da skill:
 * `dano = round(ATK_final * mult * levelScale)`
 * (Tempos de animação nunca entram na fórmula de dano).
 */
export function calcDano(atkFinal: number, mult: number, level: number): number {
	return math.round(atkFinal * mult * calcLevelScale(level));
}

/**
 * Aplica o multiplicador de Hamon sobre o dano já arredondado do slot (`D_slot`),
 * convertendo o resultado para dano inteiro com a política padrão (`math.round`).
 */
export function calcHamonDamage(slotDamage: number, hamonMultiplier = 1): number {
	const safeSlotDamage = math.max(math.round(slotDamage), 0);
	if (safeSlotDamage <= 0 || hamonMultiplier === 1) return safeSlotDamage;
	return math.max(math.round(safeSlotDamage * hamonMultiplier), 0);
}

/**
 * Distribui um total inteiro de dano entre hits usando `damageShares` pelo método
 * determinístico de maiores resíduos (desempate pela ordem dos hits: índice menor primeiro).
 * Garante `sum(resultado) === totalDamage`, inclusive para totais menores que o número de hits,
 * sem inventar piso mínimo de 1 por hit.
 */
export function distributeDamageAcrossHits(totalDamage: number, damageShares: readonly number[]): number[] {
	const count = damageShares.size();
	if (count === 0) return [];
	const safeTotal = math.max(math.round(totalDamage), 0);
	if (safeTotal <= 0) {
		const zeros: number[] = [];
		for (const _ of $range(1, count)) zeros.push(0);
		return zeros;
	}

	let weightSum = 0;
	for (const share of damageShares) {
		weightSum += math.max(share, 0);
	}
	const useUniform = weightSum <= 0;
	const denom = useUniform ? count : weightSum;
	const targetTotal = useUniform || math.abs(weightSum - 1) <= 1e-6
		? safeTotal
		: math.max(math.round(safeTotal * weightSum), 0);

	const allocations: number[] = [];
	const entries: Array<{ readonly index: number; readonly remainder: number }> = [];
	let allocatedSum = 0;
	for (const i of $range(0, count - 1)) {
		const weight = useUniform ? 1 : math.max(damageShares[i], 0);
		const exact = targetTotal * (weight / denom);
		const base = math.floor(exact);
		allocations.push(base);
		allocatedSum += base;
		entries.push({ index: i, remainder: exact - base });
	}

	const leftover = targetTotal - allocatedSum;
	if (leftover > 0) {
		table.sort(entries, (a, b) => {
			if (math.abs(a.remainder - b.remainder) > 1e-9) return a.remainder > b.remainder;
			return a.index < b.index;
		});
		for (const i of $range(0, math.min(leftover, count) - 1)) {
			allocations[entries[i].index] += 1;
		}
	}
	return allocations;
}

/**
 * Calcula o `ATK_cura` usado exclusivamente na fórmula de cura híbrida:
 * `ATK_cura = base + alocado + chips` (sem buffs temporários e sem levelScale).
 */
export function calcAtkCura(baseAtk: number, allocatedAtk: number, chipAtk = 0): number {
	return baseAtk + allocatedAtk + chipAtk;
}

/**
 * Cura híbrida single-target:
 * `cura = round(min(ATK_cura * healMult, HP_MAX * capHP))`
 */
export function calcCura(atkCura: number, slot: SkillSlot, hpMax: number): number {
	const healConfig = HYBRID_HEAL[slot];
	return math.round(math.min(atkCura * healConfig.healMult, hpMax * healConfig.capHP));
}

/**
 * Cura em área (AoE):
 * `curaAoE = round(curaSingle / aliadosVivos)`
 */
export function calcCuraAoE(curaSingle: number, aliadosVivos: number): number {
	return math.round(curaSingle / math.max(aliadosVivos, MIN_ALLIES));
}

/**
 * Calcula o fator `BuffMulti`:
 * `BuffMulti = capFinal * min(aplicações, 4) / 4`
 */
export function calcBuffMulti(capFinal: number, applications: number): number {
	const stacks = clamp(math.floor(applications), 0, MAX_MODIFIER_STACKS);
	return math.max(capFinal, 0) * (stacks / MAX_MODIFIER_STACKS);
}

/**
 * Aplica `BuffMulti` ao dano:
 * `dano += dano * BuffMulti` (arredondado).
 */
export function applyBuffMulti(damage: number, capFinal: number, applications: number): number {
	const buffMulti = calcBuffMulti(capFinal, applications);
	return math.round(damage + damage * buffMulti);
}

/**
 * Calcula a fração de redução do `WeakMulti`:
 * `WeakMulti = capFinal * min(aplicações, 4) / 4`
 */
export function calcWeakMulti(capFinal: number, applications: number): number {
	const stacks = clamp(math.floor(applications), 0, MAX_MODIFIER_STACKS);
	return clamp(capFinal, 0, 1) * (stacks / MAX_MODIFIER_STACKS);
}

/**
 * Aplica `WeakMulti` ao dano com piso mínimo de 1:
 * `dano *= (1 - capFinal * min(aplicações, 4) / 4)`
 */
export function applyWeakMulti(damage: number, capFinal: number, applications: number): number {
	const weakMulti = calcWeakMulti(capFinal, applications);
	return math.max(math.round(damage * (1 - weakMulti)), MIN_DAMAGE);
}

/** Retorna o multiplicador de counter de classe (1.175 se `atacante` countera `defensor`, senão 1). */
export function calcCounterMult(atacante: ClassName, defensor: ClassName): number {
	return getCounterMultiplier(atacante, defensor);
}

/**
 * Aplica o multiplicador de crítico (`CRIT_MULTIPLIER = 1.5`) sobre o dano normal do hit
 * (já com piso mínimo `MIN_DAMAGE`), evitando empates de arredondamento entre acerto normal e crítico.
 */
export function applyCritMultiplier(normalHitDamage: number, crit = true): number {
	const clampedNormal = math.max(math.round(normalHitDamage), MIN_DAMAGE);
	if (!crit) return clampedNormal;
	return math.max(math.round(clampedNormal * CRIT_MULTIPLIER), MIN_DAMAGE);
}

/**
 * Valida se um bloco de pontos alocados respeita as regras de progressão do GDD:
 * - Nenhum atributo negativo ou acima do nível atual (`cap por stat = level`).
 * - Total de pontos alocados não excede `(level - 1) * 2`.
 * - Diferença máxima de 5 pontos nos pares `|atk - dodge| <= 5` e `|hp - crit| <= 5`.
 */
export function isValidStatAllocation(allocated: StatBlock, level: number): boolean {
	const clampedLevel = clamp(math.floor(level), MIN_LEVEL, MAX_LEVEL);
	const stats = [allocated.hp, allocated.atk, allocated.dodge, allocated.crit];
	for (const value of stats) {
		if (value < 0 || math.floor(value) !== value || value > clampedLevel) return false;
	}

	const totalAllocated = allocated.hp + allocated.atk + allocated.dodge + allocated.crit;
	const maxPointsForLevel = (clampedLevel - MIN_LEVEL) * STAT_POINTS_PER_LEVEL;
	if (totalAllocated > maxPointsForLevel) return false;

	for (const [firstStat, secondStat] of STAT_POINT_PAIRS) {
		if (math.abs(allocated[firstStat] - allocated[secondStat]) > MAX_STAT_POINT_DIFFERENCE) {
			return false;
		}
	}

	return true;
}
