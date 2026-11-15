/** Classes jogáveis disponíveis no Mundo 1. */
export type ClassName = "Fury" | "Support" | "Controller" | "Dominator" | "Menace";

/** Raridades das ofertas e dos lutadores. */
export type Rarity = "Comum" | "Rara" | "Épica" | "Lendária";

/** Fase global da sequência de batalha. */
export type BattleGlobalState = "IDLE" | "PREPARE" | "ATTACK" | "RETURN";

/** Estado local de um lutador em combate. */
export type FighterLocalState = "NORMAL" | "CARREGANDO" | "CAIDO";

/** Efeitos de status ativos no lançamento do Mundo 1. */
export type StatusEffect = "Burn" | "Bleed" | "Root";

/** Índice de slot de habilidade (S1, S2, S3). */
export type SkillSlot = 1 | 2 | 3;

/** Intervalo numérico inclusivo [min, max]. */
export interface NumericRange {
	readonly min: number;
	readonly max: number;
}

/**
 * Roll permanente de um slot de skill gerado na oferta.
 * O roll único `t` (0 a 1) define simultaneamente o custo ATB e o multiplicador.
 */
export interface SkillSlotRoll {
	readonly t: number;
	readonly cost: number;
	readonly mult: number;
}

/** Tupla estrita com os rolls dos slots S1, S2 e S3. */
export type SkillSlots = readonly [SkillSlotRoll, SkillSlotRoll, SkillSlotRoll];

/** Bloco de atributos (valores base da classe, pontos alocados ou totais). */
export interface StatBlock {
	readonly hp: number;
	readonly atk: number;
	readonly dodge: number;
	readonly crit: number;
}

/** Nome de atributo alocável na progressão de nível. */
export type AllocatableStat = keyof StatBlock;

/** Par de atributos vinculados pela trava de diferença máxima. */
export type StatPointPair = readonly [AllocatableStat, AllocatableStat];

/** Membros da dupla especial Bruford & Tarkus. */
export type DuoMember = "Bruford" | "Tarkus";

/**
 * Estado especial da dupla Bruford & Tarkus (ocupa 1 slot de equipe com HPs separados).
 * - Membro ativo recebe 100% do dano; parceiro inativo recebe 34%.
 * - Quando um cai, o sobrevivente tem seu HP_MAX reduzido a 1/3 e recebe +10% de dano final.
 */
export interface DuoState {
	readonly activeMember: DuoMember;
	readonly partnerHp: number;
	readonly partnerHpMax?: number;
	readonly isSurvivor?: boolean;
}

/** Oferta temporária gerada na loja antes da compra. */
export interface ShopOffer {
	readonly offerId: string;
	readonly fighterId: string;
	readonly rarity: Rarity;
	readonly baseStats: StatBlock;
	readonly skills: SkillSlots;
}

/** Instância permanente de um lutador no inventário do jogador. */
export interface FighterInventoryItem {
	/** Catalog entry missing; keep ownership and rolls until the definition returns. */
	readonly unavailable?: boolean;
	readonly itemUuid: string;
	readonly fighterId: string;
	readonly rarity?: Rarity;
	readonly level: number;
	readonly xp: number;
	readonly baseStats: StatBlock;
	readonly allocatedStats: StatBlock;
	readonly skills: SkillSlots;
	readonly equippedChip?: string;
	readonly duo?: DuoState;
}

/** Lutador da dupla Bruford/Tarkus com estado de dupla obrigatório. */
export interface DuoFighterInventoryItem extends FighterInventoryItem {
	readonly duo: DuoState;
}

/** Resultado privado de XP, calculado integralmente no servidor. */
export interface FighterXpReward {
	readonly itemUuid: string;
	readonly fighterId: string;
	readonly displayName: string;
	readonly className: ClassName;
	readonly xpGained: number;
	readonly previousLevel: number;
	readonly previousXp: number;
	readonly previousXpToNext: number;
	readonly newLevel: number;
	readonly newXp: number;
	readonly newXpToNext: number;
	readonly leveledUp: boolean;
}

/** Metadados de session lock por servidor e sessão salvos junto ao registro do jogador no DataStore. */
export interface SessionLockInfo {
	readonly serverId: string;
	readonly timestamp: number;
	readonly sessionId?: string;
}

/** Schema versionado de persistência de dados do jogador no DataStore (T7.2). */
export interface PlayerSaveData {
	readonly version: number;
	readonly tinyes: number;
	readonly inventory: FighterInventoryItem[];
	readonly activeTeam: string[];
	readonly sessionLock?: SessionLockInfo;
}
