// Constantes econômicas de Tinyes, faixas de recompensa e loja.
import type { NumericRange, Rarity } from "../TypeDefs";

export const INITIAL_TINYES = 0;
export const TINYES_WIN_BY_TIER = {
	Bronze: { min: 50, max: 150 },
	Prata: { min: 150, max: 250 },
	Ouro: { min: 170, max: 350 },
} as const;
export const TINYES_MAX_ADD_PER_CALL = 1000;
export const REWARD_BRACKET_MIN_LEVEL = { Bronze: 1, Prata: 10, Ouro: 20 } as const;

export const SHOP_SHELF_COUNT = 3;
export const SHOP_RESET_WINDOW_SECONDS = 3600;
export const SHOP_REFRESH_INTERVAL_SECONDS = 1;
export const SHOP_MAX_LEVEL = 3;
export const SHOP_PRICE_LEVEL_WEIGHT = 0.6;
export const SHOP_PRICE_QUALITY_WEIGHT = 0.4;
export const SHOP_LEVEL_WEIGHTS = [0.60, 0.30, 0.10] as const;
export const SHOP_PRICE_RANGES: Readonly<Record<Rarity, NumericRange>> = {
	Comum: { min: 150, max: 250 }, Rara: { min: 400, max: 950 },
	Épica: { min: 1500, max: 4000 }, Lendária: { min: 6000, max: 14000 },
};
