import type { ClassName, NumericRange } from "./TypeDefs";

/** Ranges de atributos base gerados na criação da oferta para cada classe. */
export interface StatRangeBlock {
	readonly hp: NumericRange;
	readonly atk: NumericRange;
	readonly dodge: NumericRange;
	readonly crit: NumericRange;
}

/** Definição canônica de uma classe (ranges de baseStats e alvo de counter). */
export interface ClassDefinition {
	readonly baseStats: StatRangeBlock;
	/** Classe que recebe +17.5% de dano desta classe no triângulo de counter. */
	readonly counter: ClassName | undefined;
}

/** Multiplicador de dano quando a classe atacante countera a defensora (+17.5%). */
export const COUNTER_DAMAGE_MULTIPLIER = 1.175;

/** Triângulo de counter ativo no lançamento: Fury > Menace > Dominator > Fury. */
export const COUNTER_TRIANGLE: Readonly<Partial<Record<ClassName, ClassName>>> = {
	Fury: "Menace",
	Menace: "Dominator",
	Dominator: "Fury",
};

/**
 * Ranges de baseStats e relação de counter das 5 classes do Mundo 1.
 * Support e Controller possuem counter `undefined` no lançamento (soft counter previsto para o futuro).
 */
export const CLASS_DATA: Readonly<Record<ClassName, ClassDefinition>> = {
	Fury: {
		baseStats: {
			hp: { min: 13, max: 17 },
			atk: { min: 8, max: 12 },
			dodge: { min: 5, max: 8 },
			crit: { min: 8, max: 12 },
		},
		counter: "Menace",
	},
	Support: {
		baseStats: {
			hp: { min: 8, max: 15 },
			atk: { min: 4, max: 7 },
			dodge: { min: 8, max: 14 },
			crit: { min: 3, max: 6 },
		},
		counter: undefined,
	},
	Controller: {
		baseStats: {
			hp: { min: 16, max: 20 },
			atk: { min: 6, max: 10 },
			dodge: { min: 5, max: 8 },
			crit: { min: 5, max: 8 },
		},
		counter: undefined,
	},
	Dominator: {
		baseStats: {
			hp: { min: 14, max: 18 },
			atk: { min: 7, max: 11 },
			dodge: { min: 3, max: 6 },
			crit: { min: 6, max: 10 },
		},
		counter: "Fury",
	},
	Menace: {
		baseStats: {
			hp: { min: 12, max: 16 },
			atk: { min: 9, max: 13 },
			dodge: { min: 4, max: 7 },
			crit: { min: 7, max: 11 },
		},
		counter: "Dominator",
	},
};

/** Verifica se a classe atacante possui vantagem de counter sobre a classe defensora. */
export function doesClassCounter(attacker: ClassName, defender: ClassName): boolean {
	return CLASS_DATA[attacker].counter === defender;
}

/** Retorna 1.175 quando `attacker` countera `defender`; 1 caso contrário. */
export function getCounterMultiplier(attacker: ClassName, defender: ClassName): number {
	return doesClassCounter(attacker, defender) ? COUNTER_DAMAGE_MULTIPLIER : 1;
}
