// Constantes de persistência, DataStore, locks de sessão e autosave.
export const PLAYER_DATA_SCHEMA_VERSION = 4;
export const MAX_SAVED_NUMBER = 9007199254740991;
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
