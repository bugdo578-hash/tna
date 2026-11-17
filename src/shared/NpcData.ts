import type { RealFighterId } from "./FighterData";

export interface NpcDefinition {
	readonly npcId: string;
	readonly displayName: string;
	readonly aiTier: "Bronze";
	readonly team: readonly [{ readonly fighterId: RealFighterId; readonly level: number }, ...{ readonly fighterId: RealFighterId; readonly level: number }[]];
	readonly seed: number;
	readonly rematchCooldownSeconds: number;
}

// Nome, níveis, seed e cooldown provisórios. Bronze: 5–15 min; nível fixo.
export const NPC_DATA: Readonly<Record<string, NpcDefinition>> = {
	bronze_trainer: {
		npcId: "bronze_trainer",
		displayName: "Treinador Bronze",
		aiTier: "Bronze",
		team: [{ fighterId: "jotaro", level: 1 }, { fighterId: "anubis", level: 2 }],
		seed: 20261115,
		rematchCooldownSeconds: 300,
	},
};
