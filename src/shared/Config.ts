import type { NumericRange, Rarity, SkillSlot, StatPointPair } from "./TypeDefs";

/** Limites da barra de ATB por lado da batalha. */
export const ATB_MIN = 0;
export const ATB_MAX = 10;

/** Velocidade base canônica da barra ATB (0 a 10), usada na calibração de dano. */
export const BASE_ATB_SPEED = 0.588;

/** Ranges de custo de ATB por slot de habilidade (S1, S2, S3). */
export const ATB_COST_RANGES: Readonly<Record<SkillSlot, NumericRange>> = {
	1: { min: 0.75, max: 3.0 },
	2: { min: 4.0, max: 7.0 },
	3: { min: 8.0, max: 10.0 },
};

/** Constantes D_slot canônicas para cálculo do multiplicador da skill. */
export const D_SLOT: Readonly<Record<SkillSlot, number>> = {
	1: 0.2145,
	2: 0.1373,
	3: 0.1825,
};

/** Configuração de cura híbrida por slot (multiplicador de ATK_cura e teto percentual de HP_MAX). */
export interface HybridHealConfig {
	readonly healMult: number;
	readonly capHP: number;
}

/** Tabela canônica de cura híbrida por slot (S1, S2, S3). */
export const HYBRID_HEAL: Readonly<Record<SkillSlot, HybridHealConfig>> = {
	1: { healMult: 0.55, capHP: 0.2 },
	2: { healMult: 1.1, capHP: 0.3 },
	3: { healMult: 1.4, capHP: 0.45 },
};

/** Constantes de progressão de nível e distribuição de pontos. */
export const MIN_LEVEL = 1;
/** Nível mínimo para usar a habilidade do slot 3. */
export const S3_UNLOCK_LEVEL = 5;
export const MAX_LEVEL = 30;
export const STAT_POINTS_PER_LEVEL = 2;
export const TOTAL_STAT_POINTS = (MAX_LEVEL - MIN_LEVEL) * STAT_POINTS_PER_LEVEL;

/** Ganhos por ponto de atributo alocado. */
export const HP_PER_POINT = 12.5;
export const ATK_PER_POINT = 1;
export const DODGE_POINTS_PER_POINT = 1;
export const CRIT_POINTS_PER_POINT = 1;
export const DODGE_PERCENT_PER_POINT = 1;
export const CRIT_PERCENT_PER_POINT = 1.5;

export const PLAYER_DATA_SCHEMA_VERSION = 2;

/** Loja: valores dev/provisórios, inclusive faixas de preço e distribuição de níveis. */
export const SHOP_SHELF_COUNT = 3;
export const SHOP_RESET_WINDOW_SECONDS = 3600;
export const SHOP_REFRESH_INTERVAL_SECONDS = 1;
export const SHOP_REQUEST_BUCKET_CAPACITY = 3;
export const SHOP_REQUEST_REFILL_PER_SECOND = 1;
export const SHOP_MAX_LEVEL = 3;
export const SHOP_PRICE_LEVEL_WEIGHT = 0.6;
export const SHOP_PRICE_QUALITY_WEIGHT = 0.4;
export const SHOP_LEVEL_WEIGHTS = [0.60, 0.30, 0.10] as const;
export const SHOP_PRICE_RANGES: Readonly<Record<Rarity, NumericRange>> = {
	Comum: { min: 150, max: 250 }, Rara: { min: 400, max: 950 },
	Épica: { min: 1500, max: 4000 }, Lendária: { min: 6000, max: 14000 },
};

/**
 * Curva de XP por nível e regras de XP pós-batalha por time (valores provisórios).
 * - `xpForNextLevel(level) = XP_LEVEL_PER_LEVEL * level` (Nv.1 = 100, Nv.10 = 1.000, Nv.20 = 2.000).
 * - `totalBattleXp = XP_BATTLE_BASE + XP_BATTLE_PER_ENEMY_LEVEL * avgEnemyLevel` (só vitória PvE).
 * - Divisão do pool pela quantidade de lutadores válidos (100% do pool sempre aproveitado), depois multiplicador
 *   individual por diferença de nível: 1 lutador = 100%; 2 = 50% / 50%; 3 = 50% ao maior dano causado, 25% / 25% aos demais.
 */
export const TEAM_XP_SLOTS = 3;
/** 1 lutador válido no time: recebe todo o pool. */
export const XP_SHARE_SOLO = 1.0;
/** 2 lutadores válidos: cada um recebe esta fração do pool. */
export const XP_SHARE_DUO_EACH = 0.5;
/** 3 lutadores válidos: fração do lutador que causou mais dano (empate: menor índice de slot). */
export const XP_SHARE_TRIO_TOP_DAMAGE = 0.5;
/** 3 lutadores válidos: fração de cada um dos outros dois. */
export const XP_SHARE_TRIO_OTHER = 0.25;
export const XP_LEVEL_PER_LEVEL = 100;
export const XP_BATTLE_BASE = 75;
export const XP_BATTLE_PER_ENEMY_LEVEL = 15;
/** Mínimo de XP inteira entregue quando o XP bruto do slot é maior que zero. */
export const XP_MIN_AWARD = 1;

/** Faixa de diferença de nível (`charLevel - avgEnemyLevel`) com seu multiplicador individual de XP. */
export interface XpLevelDiffTier {
	/** Faixa vale quando `diff <= maxDiff` (tabela avaliada em ordem crescente). */
	readonly maxDiff: number;
	readonly multiplier: number;
}

/** Multiplicadores por diferença de nível, em ordem crescente de `maxDiff`. */
export const XP_LEVEL_DIFF_TIERS: readonly XpLevelDiffTier[] = [
	{ maxDiff: -3, multiplier: 1.35 },
	{ maxDiff: -1, multiplier: 1.15 },
	{ maxDiff: 1, multiplier: 1 },
	{ maxDiff: 3, multiplier: 0.6 },
	{ maxDiff: 5, multiplier: 0.25 },
];
/** Piso anti-farm / overlevel (diff acima da última faixa): nunca zera a XP se a participação for maior que 0. */
export const XP_LEVEL_DIFF_FLOOR_MULTIPLIER = 0.05;

/**
 * Constantes de persistência de dados do jogador e DataStore (T7.2 — valores provisórios).
 */
export const INITIAL_TINYES = 0;
/** Maior inteiro exato: evita perda de precisão nos contadores persistidos. */
export const MAX_SAVED_NUMBER = 9007199254740991;
/** Economia provisória. Somente Bronze é consumido pelas sessões atuais. */
export const TINYES_WIN_BY_TIER = {
	Bronze: { min: 50, max: 150 },
	Prata: { min: 150, max: 250 },
	Ouro: { min: 170, max: 350 },
} as const;
export const TINYES_MAX_ADD_PER_CALL = 1000; // Provisório; gastos não usam este teto.
export const DEFAULT_STARTER_FIGHTER_ID = "jotaro";
export const MAX_ACTIVE_TEAM_SIZE = 3;
export const PLAYER_DATASTORE_NAME = "TinyAdventures_PlayerData_v1";
export const PLAYER_DATA_KEY_PREFIX = "Player_";
export const DATASTORE_MAX_RETRIES = 3;
export const DATASTORE_RETRY_BASE_DELAY_SECONDS = 0.5;
export const DATASTORE_RETRY_BACKOFF_FACTOR = 2;
export const DATASTORE_RETRY_MAX_DELAY_SECONDS = 4.0;
export const LOGOUT_RETRY_MAX_BACKOFF_SECONDS = 30;
export const SESSION_LOCK_EXPIRATION_SECONDS = 120;
export const SESSION_LOCK_WAIT_ATTEMPTS = 2;
export const SESSION_LOCK_WAIT_DELAY_SECONDS = 1.0;
export const SESSION_LOCK_KICK_MESSAGE =
	"Seus dados ainda estão ativos em outro servidor. Aguarde alguns instantes e tente novamente.";
export const SESSION_LOCK_LOST_KICK_MESSAGE =
	"Sua sessão foi encerrada porque seus dados foram assumidos por outro servidor.";
export const PLAYER_DATA_AUTOSAVE_INTERVAL_SECONDS = 60;
export const SAVE_WAIT_TIMEOUT_SECONDS = 10;
export const BIND_TO_CLOSE_TIMEOUT_SECONDS = 25;
export const BIND_TO_CLOSE_POLL_INTERVAL_SECONDS = 0.05;

/** Diferença máxima permitida entre os atributos de cada par vinculado. */
export const MAX_STAT_POINT_DIFFERENCE = 5;

/** Pares de atributos vinculados: |ATK - Dodge| <= 5 e |HP - Crit| <= 5. */
export const STAT_POINT_PAIRS: readonly [StatPointPair, StatPointPair] = [
	["atk", "dodge"],
	["hp", "crit"],
];

/** Limites e multiplicadores de combate. */
export const MIN_DAMAGE = 1;
export const MAX_MODIFIER_STACKS = 4;
export const CHARGE_DAMAGE_MULTIPLIER = 1.5;
/** Multiplicador crítico provisório (sujeito a calibração em playtest). */
export const CRIT_MULTIPLIER = 1.5;
export const CRIT_DAMAGE_MULTIPLIER = CRIT_MULTIPLIER;

/** Constantes canônicas da dupla Bruford & Tarkus. */
export const DUO_PARTNER_DAMAGE_SHARE = 0.34;
export const DUO_SURVIVOR_HP_MAX_FACTOR = 1 / 3;
export const DUO_SURVIVOR_DAMAGE_MULTIPLIER = 1.1;

/** Percentual do dano real aplicado convertido em DoT total (Bleed=25%, Burn=20%). */
export const BLEED_DAMAGE_SHARE = 0.25;
export const BURN_DAMAGE_SHARE = 0.2;

export const DOT_DAMAGE_SHARE: Readonly<Record<"Bleed" | "Burn", number>> = {
	Bleed: BLEED_DAMAGE_SHARE,
	Burn: BURN_DAMAGE_SHARE,
};

/**
 * Cadência provisória de DoT (Bleed/Burn): 3 ticks, 1 por segundo (3s totais).
 * Marcada como provisória conforme GDD (pendente decisão final 3s vs 9s).
 */
export const DOT_TICKS = 3;
export const DOT_TICK_INTERVAL_SECONDS = 1;

/** Duração de Root em segundos por slot de habilidade (S1=5s, S2=8s, S3=12s). */
export const ROOT_DURATION_BY_SLOT: Readonly<Record<SkillSlot, number>> = {
	1: 5,
	2: 8,
	3: 12,
};

/** Limites de rede, sessão e validação no servidor. */
/** Token bucket por jogador para os remotes de batalha (capacidade de rajada e recarga em tokens/s). */
export const BATTLE_REQUEST_BUCKET_CAPACITY = 10;
export const BATTLE_REQUEST_REFILL_PER_SECOND = 10;
/** Token bucket próprio e mais restrito do RequestAllocate (valores provisórios). */
export const ALLOCATE_REQUEST_BUCKET_CAPACITY = 5;
export const ALLOCATE_REQUEST_REFILL_PER_SECOND = 2;
/** Slots de skill aceitos no RequestSkill. */
export const MIN_SKILL_SLOT = 1;
export const MAX_SKILL_SLOT = 3;
/** Tamanho máximo aceito para itemUuid vindo do client. */
export const MAX_ITEM_UUID_LENGTH = 64;
export const ATB_SYNC_INTERVAL_SECONDS = 0.1;
export const BATTLE_STALL_TIMEOUT_SECONDS = 30;
export const BATTLE_INACTIVITY_TIMEOUT_SECONDS = 90;
export const PVE_PAUSE_MAX_SECONDS = 120;
export const MIN_CLIENT_FIGHTER_INDEX = 1;
export const MAX_CLIENT_FIGHTER_INDEX = 3;
export const FLOAT_TOLERANCE = 1e-6;

/**
 * Constantes de apresentação de combate no client (T2) — valores provisórios para playtest.
 */
export const ASSETS_FOLDER_NAME = "Assets";
export const FIGHTER_ASSETS_FOLDER_NAME = "Fighters";
export const WORKSPACE_BATTLE_FOLDER_NAME = "ClientBattleStage";
export const STAND_SUBMODEL_NAME = "Stand";

/** Nomes padronizados dos Attachments obrigatórios em cada rig. */
export const RIG_ATTACHMENT_NAMES = {
	Peito: "Peito",
	MaoDireita: "MaoDireita",
	MaoEsquerda: "MaoEsquerda",
	Cabeca: "Cabeca",
} as const;

/** Tempo máximo (provisório) que o client aguarda um HitResolved atrasado após o marker/tempo do hit. */
export const HIT_RESULT_WAIT_SECONDS = 0.25;
export const HIT_WAIT_POLL_INTERVAL_SECONDS = 0.02;

/** Posicionamento provisório da arena temporária de combate no Workspace. */
export const COMBAT_STAGE_ORIGIN = new Vector3(0, 3, 45);
export const COMBAT_ACTIVE_SEPARATION_STUDS = 10;
export const COMBAT_BENCH_RETREAT_STUDS = 6;
export const COMBAT_BENCH_LATERAL_SPACING_STUDS = 3.5;

/** Tempos provisórios de Tween/animação placeholder no client. */
export const PLACEHOLDER_ADVANCE_FRACTION = 0.65;
export const PLACEHOLDER_STRIKE_TWEEN_SECONDS = 0.07;
export const PLACEHOLDER_HIT_REACT_TWEEN_SECONDS = 0.09;
export const PLACEHOLDER_DODGE_TWEEN_SECONDS = 0.12;
export const PLACEHOLDER_SWITCH_TWEEN_SECONDS = 0.18;
export const PLACEHOLDER_KO_TWEEN_SECONDS = 0.35;
export const PLACEHOLDER_DODGE_OFFSET_STUDS = 2.2;
export const PLACEHOLDER_HIT_KNOCKBACK_STUDS = 0.7;
export const BENCH_FIGHTER_TRANSPARENCY = 0.55;

/** Pool de BillboardGui para números de dano, crítico, DODGE e ticks de DoT (provisório). */
export const DAMAGE_BILLBOARD_POOL_SIZE = 16;
export const DAMAGE_POPUP_DURATION_SECONDS = 0.65;
export const DAMAGE_POPUP_RISE_STUDS = 2.0;
export const DAMAGE_BILLBOARD_SIZE_NORMAL = new UDim2(0, 90, 0, 36);
export const DAMAGE_BILLBOARD_SIZE_CRIT = new UDim2(0, 130, 0, 52);
export const DAMAGE_BILLBOARD_SIZE_DOT = new UDim2(0, 68, 0, 26);
export const DAMAGE_BILLBOARD_SIZE_BANNER = new UDim2(0, 220, 0, 64);

/** Cores provisórias de feedback visual de combate. */
export const COMBAT_FEEDBACK_COLORS = {
	normalHit: Color3.fromRGB(255, 255, 255),
	critHit: Color3.fromRGB(255, 215, 45),
	dodgeText: Color3.fromRGB(110, 220, 255),
	bleedTick: Color3.fromRGB(235, 55, 55),
	burnTick: Color3.fromRGB(255, 140, 40),
	rootVfx: Color3.fromRGB(190, 135, 255),
	victoryBanner: Color3.fromRGB(95, 255, 130),
	defeatBanner: Color3.fromRGB(255, 85, 85),
} as const;

/** Duração provisória da exibição de resultado antes de limpar a arena temporária. */
export const BATTLE_END_CLEANUP_DELAY_SECONDS = 2.0;

/** Modo de teste no Studio (F5): comando de chat e início automático dev (provisório). */
export const DEV_TEST_BATTLE_CHAT_COMMAND = "/testbattle";
/** dev: seed dos rolls permanentes do oponente de teste; reiniciada a cada montagem. */
export const DEV_OPPONENT_SEED = 20261114;
export const DEV_AUTO_START_TEST_BATTLE = true;
export const DEV_AUTO_START_DELAY_SECONDS = 2.0;
export const DEV_AUTO_BATTLE_STEP_INTERVAL_SECONDS = 0.25;

/**
 * Constantes da AI Bronze (T5 — Marco Jogável PVE) — valores provisórios para playtest.
 */
export const AI_BRONZE_SKILL_DELAY_MIN_SECONDS = 1.5;
export const AI_BRONZE_SKILL_DELAY_MAX_SECONDS = 3.0;
export const AI_BRONZE_ULTIMATE_DELAY_MIN_SECONDS = 2.0;
export const AI_BRONZE_ULTIMATE_DELAY_MAX_SECONDS = 4.0;
export const AI_BRONZE_MISTAKE_CHANCE = 0.3;
export const AI_BRONZE_LOW_HP_THRESHOLD = 0.25;
export const AI_BRONZE_LOW_HP_SWITCH_CHANCE = 0.5;
export const AI_BRONZE_TIMED_SWITCH_MIN_SECONDS = 20.0;
export const AI_BRONZE_TIMED_SWITCH_MAX_SECONDS = 30.0;


