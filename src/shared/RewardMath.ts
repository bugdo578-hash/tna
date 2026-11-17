import { MAX_LEVEL, MIN_LEVEL, REWARD_BRACKET_MIN_LEVEL, TINYES_WIN_BY_TIER } from "./Config";

/** Apenas os participantes presentes, sem preencher vagas com zero. */
export function calcAverageLevel(levels: readonly number[]): number {
	assert(levels.size() > 0, "Lista de níveis vazia");
	let sum = 0;
	for (const level of levels) {
		assert(level === level && level >= MIN_LEVEL && level <= MAX_LEVEL, "Nível inválido");
		sum += level;
	}
	return sum / levels.size();
}

export function calcRewardBracket(averageLevel: number): { name: keyof typeof TINYES_WIN_BY_TIER; min: number; max: number } {
	assert(averageLevel === averageLevel && averageLevel >= MIN_LEVEL && averageLevel <= MAX_LEVEL, "Média inválida");
	const name = averageLevel >= REWARD_BRACKET_MIN_LEVEL.Ouro ? "Ouro" : averageLevel >= REWARD_BRACKET_MIN_LEVEL.Prata ? "Prata" : "Bronze";
	return { name, ...TINYES_WIN_BY_TIER[name] };
}
