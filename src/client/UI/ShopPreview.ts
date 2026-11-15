import type { ShopStatePayload } from "../../shared/Remotes";

/** Dados fixos de apresentação, exclusivamente Studio. Nenhum roll/cálculo de gameplay. */
export const SHOP_PREVIEW_BALANCE = 1000;
export const SHOP_PREVIEW: ShopStatePayload = {
	offers: [
		{ offerId: "preview-lv1", fighterId: "anubis", displayName: "Anubis", rarity: "Épica", className: "Menace", level: 1,
			baseStats: { hp: 14, atk: 10, dodge: 5, crit: 9 }, price: 800, slotCosts: [1.25, 5.5, 8.75] },
		{ offerId: "preview-lv3", fighterId: "jotaro", displayName: "Jotaro", rarity: "Lendária", className: "Fury", level: 3,
			baseStats: { hp: 16, atk: 11, dodge: 7, crit: 10 }, price: 950, slotCosts: [2.5, 6.25, 9.5] },
		{ offerId: "preview-expensive", fighterId: "jotaro", displayName: "Jotaro", rarity: "Lendária", className: "Fury", level: 1,
			baseStats: { hp: 15, atk: 9, dodge: 6, crit: 11 }, price: 14000, slotCosts: [.75, 4.25, 10] },
	],
};
