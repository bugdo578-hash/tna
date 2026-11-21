// Constantes de convite, rate limit e regras econômicas do PVP casual.
export const PVP_PROMPT_MAX_DISTANCE = 12;
export const PVP_INVITE_EXPIRY_SECONDS = 15;
export const PVP_INVITE_INTERVAL_SECONDS = 5;
export const PVP_DECLINE_WAIT_SECONDS = 15;
export const PVP_RESPONSE_BUCKET_CAPACITY = 3;
export const PVP_RESPONSE_REFILL_PER_SECOND = 1;

export const PVP_REWARD_FACTOR = 1.0;
export const PVP_MIN_RESOLVED_HITS = 3;
export const PVP_MIN_QUIT_DAMAGE_FRACTION = 0.25;
export const PVP_PAIR_MAX_REWARDED_WINS = 2;
export const PVP_PAIR_WINDOW_SECONDS = 3600;
export const PVP_DAILY_TINYES_CAP = 2000;
export const PVP_DAILY_XP_CAP = 2000;
export const PVP_MAX_PAIR_ENTRIES = 200;
export const PVP_DAY_SECONDS = 86400;

/** Probabilidade neutra (50/50) usada sem histórico ou em conflito de mesmo lado no PvP. */
export const PVP_SIDE_FAIR_CHANCE = 0.5;
/** Preferência (90%) de alternar o lado físico A/B em relação ao último PvP do jogador. */
export const PVP_SIDE_ALTERNATION_CHANCE = 0.9;
