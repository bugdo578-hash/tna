// Constantes de rede, buckets de rate limit, validação e timeouts de sessão.
export const BATTLE_REQUEST_BUCKET_CAPACITY = 10;
export const BATTLE_REQUEST_REFILL_PER_SECOND = 10;
// Provisório: Quit tem um bucket por jogador, separado das ações de combate.
export const QUIT_REQUEST_BUCKET_CAPACITY = 2;
export const QUIT_REQUEST_REFILL_PER_SECOND = 2;
export const ALLOCATE_REQUEST_BUCKET_CAPACITY = 5;
export const ALLOCATE_REQUEST_REFILL_PER_SECOND = 2;
export const SHOP_REQUEST_BUCKET_CAPACITY = 3;
export const SHOP_REQUEST_REFILL_PER_SECOND = 1;

export const MIN_SKILL_SLOT = 1;
export const MAX_SKILL_SLOT = 3;
export const MAX_ITEM_UUID_LENGTH = 64;
export const ATB_SYNC_INTERVAL_SECONDS = 0.1;
export const BATTLE_STALL_TIMEOUT_SECONDS = 30;
export const BATTLE_INACTIVITY_TIMEOUT_SECONDS = 90;
export const PVE_PAUSE_MAX_SECONDS = 120;
export const MIN_CLIENT_FIGHTER_INDEX = 1;
export const MAX_CLIENT_FIGHTER_INDEX = 3;
export const FLOAT_TOLERANCE = 1e-6;
