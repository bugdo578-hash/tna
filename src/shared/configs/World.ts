// Constantes de mundo, ciclo dia/noite e interação com NPCs.
export const NPC_PROMPT_MAX_DISTANCE = 7;
export const NPC_PROMPT_DEBOUNCE_SECONDS = 1;
export const BATTLE_NPC_TAG = "BattleNpc";
export const NPC_BATTLE_ACTIVE_ATTRIBUTE = "NpcBattleActive";

export const DAY_NIGHT_DEFAULT_DURATION_SECONDS = 1440;
export const DAY_NIGHT_MIN_DURATION_SECONDS = 1;
export const DAY_NIGHT_DEFAULT_START_HOUR = 8;
export const DAY_NIGHT_EPSILON = 0.0005;
export const DAY_NIGHT_DAY_PROFILE_NAME = "mundo 1 dia";
export const DAY_NIGHT_NIGHT_PROFILE_NAME = "mundo 1 noite";

export const DAY_NIGHT_ATTRIBUTES = {
	startTime: "InicioCicloSolar",
	duration: "DuracaoCiclo",
	startHour: "HoraInicial",
	paused: "Pausado",
} as const;

export const DAY_NIGHT_LIGHTING_PROPERTIES = [
	"Brightness",
	"ExposureCompensation",
	"EnvironmentDiffuseScale",
	"EnvironmentSpecularScale",
	"Ambient",
	"OutdoorAmbient",
	"ColorShift_Top",
	"ColorShift_Bottom",
	"ShadowSoftness",
	"FogColor",
	"FogStart",
	"FogEnd",
	"GeographicLatitude",
] as const;

export const DAY_NIGHT_EFFECT_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
	Atmosphere: ["Density", "Offset", "Color", "Decay", "Haze", "Glare"],
	BloomEffect: ["Intensity", "Size", "Threshold"],
	ColorCorrectionEffect: ["Brightness", "Contrast", "Saturation", "TintColor"],
	SunRaysEffect: ["Intensity", "Spread"],
	DepthOfFieldEffect: ["FarIntensity", "FocusDistance", "InFocusRadius", "NearIntensity"],
};

export const DAY_NIGHT_SKY_FACE_PROPERTIES = [
	"SkyboxBk",
	"SkyboxDn",
	"SkyboxFt",
	"SkyboxLf",
	"SkyboxRt",
	"SkyboxUp",
	"SunTextureId",
	"MoonTextureId",
] as const;

export const DAY_NIGHT_SKY_NUMBER_PROPERTIES = ["SunAngularSize", "MoonAngularSize", "StarCount"] as const;
