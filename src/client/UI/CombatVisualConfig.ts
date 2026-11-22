// Constantes visuais de palco, animações placeholder, billboards e cores de feedback do combate no client.
export const ASSETS_FOLDER_NAME = "Assets";
export const FIGHTER_ASSETS_FOLDER_NAME = "Fighters";
export const WORKSPACE_BATTLE_FOLDER_NAME = "ClientBattleStage";
export const STAND_SUBMODEL_NAME = "Stand";

export const RIG_ATTACHMENT_NAMES = {
	Peito: "Peito",
	MaoDireita: "MaoDireita",
	MaoEsquerda: "MaoEsquerda",
	Cabeca: "Cabeca",
} as const;

export const GROUND_CONTACT_ATTACHMENT_NAME = "GroundContact";

export const FIGHTER_MATERIALIZATION_SECONDS = 1.5;
export const FIGHTER_MATERIALIZATION_START_SECONDS = [0, 0.75, 1.1] as const;
export const FIGHTER_MATERIALIZATION_GO_MARGIN_SECONDS = 0.2;

export const HIT_RESULT_WAIT_SECONDS = 0.25;
export const HIT_WAIT_POLL_INTERVAL_SECONDS = 0.02;

export const ARENA_BASES_NAME = "Arena_bases";
export const ARENA_TEAM_FOLDER_NAMES = ["Time A", "Time B"] as const;
export const ARENA_SIDE_ANCHOR_NAMES = [
	{
		active: "Current_Fighter_A",
		waiting: ["Waiting_Fighter_A", "Waiting_Fighter_A_2"] as const,
		camera: "Camera_A",
	},
	{
		active: "Current_Fighter_B",
		waiting: ["Waiting_Fighter_B", "Waiting_Fighter_B_2"] as const,
		camera: "Camera_B",
	},
] as const;

export const PLACEHOLDER_ADVANCE_FRACTION = 0.65;
export const PLACEHOLDER_ORA_ADVANCE_FRACTION = 0.5;
export const PLACEHOLDER_STRIKE_TWEEN_SECONDS = 0.07;
export const PLACEHOLDER_STAND_STRIKE_STUDS = 1.1;
export const STAND_ATTACK_FRONT_STUDS = 1.5;
export const PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS = 0;
export const COMBAT_POSITION_TOLERANCE_STUDS = 1e-4;
export const PLACEHOLDER_HIT_REACT_TWEEN_SECONDS = 0.09;
export const PLACEHOLDER_DODGE_TWEEN_SECONDS = 0.12;
export const PLACEHOLDER_SWITCH_TWEEN_SECONDS = 0.18;
export const PLACEHOLDER_KO_TWEEN_SECONDS = 0.35;
export const PLACEHOLDER_DODGE_OFFSET_STUDS = 2.2;
export const PLACEHOLDER_HIT_KNOCKBACK_STUDS = 0.7;
export const BENCH_FIGHTER_TRANSPARENCY = 0.55;

export const DAMAGE_BILLBOARD_POOL_SIZE = 16;
export const DAMAGE_POPUP_DURATION_SECONDS = 0.65;
export const DAMAGE_POPUP_RISE_STUDS = 2.0;
export const DAMAGE_BILLBOARD_SIZE_NORMAL = new UDim2(0, 90, 0, 36);
export const DAMAGE_BILLBOARD_SIZE_CRIT = new UDim2(0, 130, 0, 52);
export const DAMAGE_BILLBOARD_SIZE_DOT = new UDim2(0, 68, 0, 26);
export const DAMAGE_BILLBOARD_SIZE_BANNER = new UDim2(0, 220, 0, 64); // sem uso hoje

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

export const BATTLE_END_CLEANUP_DELAY_SECONDS = 2.0;

// Enquadramento adaptativo da câmera de batalha (L2.2).
export const CAMERA_MIN_VALID_VIEWPORT_PX = 16;
export const CAMERA_VIEWPORT_CHANGE_MIN_PIXELS = 2;
export const CAMERA_ASPECT_CHANGE_EPSILON = 0.005;
export const CAMERA_BASE_FOV_MIN = 40;
export const CAMERA_BASE_FOV_MAX = 90;
// Provisório: limites de FOV para evitar recuo excessivo em retrato (9:16) e distorção olho-de-peixe em telas largas.
export const CAMERA_MAX_VERTICAL_FOV = 92;
export const CAMERA_MAX_HORIZONTAL_FOV = 104;
export const CAMERA_MIN_NEAR_DEPTH_STUDS = 1.5;
export const CAMERA_MAX_PULLBACK_STUDS = 40;
export const CAMERA_FRAME_PADDING_HORIZONTAL = 0.06;
export const CAMERA_FRAME_PADDING_TOP = 0.10;
export const CAMERA_FRAME_PADDING_BOTTOM = 0.10;
export const CAMERA_NOMINAL_FIGHTER_MIN_LOCAL = new Vector3(-0.9, 0, -1.0);
export const CAMERA_NOMINAL_FIGHTER_MAX_LOCAL = new Vector3(0.9, 3.0, 1.2);
export const CAMERA_ACTIVE_ANIMATION_MARGIN_SIDE_STUDS = 0.4;
export const CAMERA_ACTIVE_ANIMATION_MARGIN_TOP_STUDS = 0.45;
export const CAMERA_ACTIVE_ANIMATION_MARGIN_FRONT_STUDS = 0.35;
export const CAMERA_ACTIVE_DODGE_MARGIN_FRACTION = 0.4;
export const CAMERA_ACTIVE_KNOCKBACK_CRIT_MULTIPLIER = 1.4;
export const CAMERA_BENCH_ANIMATION_MARGIN_SIDE_STUDS = 0.25;
export const CAMERA_BENCH_ANIMATION_MARGIN_TOP_STUDS = 0.3;
export const CAMERA_OCCLUSION_TRANSPARENCY_THRESHOLD = 0.95;
export const CAMERA_OCCLUSION_MAX_RAY_STEPS = 10;
export const CAMERA_INTRO_ARC_DEGREES = 180;
export const CAMERA_INTRO_PATH_SAMPLES = 24;
export const CAMERA_INTRO_HEIGHT_FRACTION = 0.58;
export const CAMERA_INTRO_RADIUS_FRACTION = 0.58;
export const CAMERA_INTRO_DASH_IMPULSE = 3.5;
export const BATTLE_INTRO_FADE_SECONDS = 0.45;
export const BATTLE_INTRO_GO_HOLD_SECONDS = 0.45;
export const CAMERA_INTRO_SETTLE_FOV_DEGREES = 1.25;
export const CAMERA_INTRO_SETTLE_START = 0.75;
export const BATTLE_INTRO_LOCAL_GRACE_SECONDS = 3;
export const BATTLE_INTRO_EXIT_REPLICATION_SECONDS = 1.5;

// Infraestrutura de cutscenes cinematográficas de câmera (L4.2).
export const CAMERA_CUTSCENE_DEFAULT_BLEND_OUT_SECONDS = 0.25;
export const CAMERA_CUTSCENE_MIN_FOV = 20;
export const CAMERA_CUTSCENE_MAX_FOV = 120;

// Estado cliente-local de prontidão e lado físico para VFX ambientais de arena (L4.1.4).
export const AMBIENT_VFX_STATE_NODE_NAME = "BattleAmbientVfxState";
export const AMBIENT_VFX_ATTRIBUTES = {
	active: "Active",
	battleId: "BattleId",
	generation: "Generation",
	transitionId: "TransitionId",
	arenaInstanceId: "ArenaInstanceId",
	localSide: "LocalSide",
	localSideIndex: "LocalSideIndex",
	fightersReady: "FightersReady",
	goOccurred: "GoOccurred",
	revision: "Revision",
} as const;
