import type { SkillSlot } from "../../shared/TypeDefs";

/** Referência espacial relativa usada para transformar keyframes de cutscene em coordenadas da batalha atual. */
export type CutsceneReferenceSpace = "attacker" | "target" | "arena" | "adaptiveCamera";

/** Modo ativo de controle da câmera de batalha, em ordem de prioridade: intro > cutscene > adaptive. */
export type CombatCameraMode = "inactive" | "intro" | "cutscene" | "adaptive";

/** Estado interno da reprodução da cutscene local. */
export type CutscenePlaybackState = "idle" | "playing" | "blending_out";

/** Motivos de cancelamento de uma cutscene de câmera. */
export type CutsceneCancelReason =
	| "battle_end"
	| "teardown"
	| "ko"
	| "switch"
	| "attack_replaced"
	| "reference_invalid"
	| "camera_lost"
	| "intro_active"
	| "manual";

/** Keyframe de câmera em espaço relativo à referência escolhida (nunca coordenadas mundiais fixas). */
export interface CameraCutsceneKeyframe {
	/** Instante em segundos a partir do início da cutscene (`0 <= time <= duration`). */
	readonly time: number;
	/** Posição e orientação relativas ao `CFrame` da referência espacial (`referenceCFrame * cframe`). */
	readonly cframe: CFrame;
	/** Campo de visão vertical opcional em graus; quando omitido, herda o FOV do enquadramento adaptativo. */
	readonly fieldOfView?: number;
	/** Estilo de interpolação até o próximo keyframe (padrão `Enum.EasingStyle.Linear`). */
	readonly easingStyle?: Enum.EasingStyle;
	/** Direção do easing até o próximo keyframe (padrão `Enum.EasingDirection.InOut`). */
	readonly easingDirection?: Enum.EasingDirection;
	/** Quando `true`, mantém esta pose fixa até o instante exato do próximo keyframe (corte seco). */
	readonly hold?: boolean;
}

/** Contrato de definição de uma cutscene cinematográfica de habilidade no client. */
export interface CameraCutsceneDefinition {
	/** Identificador descritivo opcional para diagnóstico e telemetria local. */
	readonly id?: string;
	/** Duração total da trajetória de keyframes em segundos (`> 0`). */
	readonly duration: number;
	/** Referência espacial estável da animação (`attacker`, `target`, `arena` ou `adaptiveCamera`). */
	readonly referenceSpace: CutsceneReferenceSpace;
	/** Sequência de keyframes relativos ordenados por tempo. */
	readonly keyframes: readonly CameraCutsceneKeyframe[];
	/** Modo de FOV opcional durante a cutscene (padrão: modo do enquadramento adaptativo). */
	readonly fieldOfViewMode?: Enum.FieldOfViewMode;
	/** Tempo opcional de transição suave da câmera adaptativa para a abertura da cutscene (padrão `0`). */
	readonly blendInDuration?: number;
	/** Tempo de retorno suave para o enquadramento adaptativo L2.2 ao final (padrão em `CombatVisualConfig`). */
	readonly blendOutDuration?: number;
	/** Se `true` (padrão), recalcula a referência a cada frame; se `false`, fixa a referência no início. */
	readonly followReference?: boolean;
	/** Se `true` (padrão), cancela imediatamente ao ocorrer KO durante a cutscene. */
	readonly cancelOnKo?: boolean;
	/** Se `true` (padrão), cancela imediatamente ao ocorrer troca durante a cutscene. */
	readonly cancelOnSwitch?: boolean;
}

/** Chave de busca de cutscene opcional para um ataque iniciado. */
export interface CutsceneSkillLookup {
	readonly fighterId: string;
	readonly slot: SkillSlot;
	/** Identificador estável opcional da habilidade (ex.: `timeline.name` ou ID dedicado). */
	readonly skillId?: string;
}

/** Pose final já avaliada em espaço de mundo pronta para ser aplicada pelo `CombatCameraController`. */
export interface CameraCutscenePose {
	readonly cframe: CFrame;
	readonly fieldOfView: number;
	readonly fieldOfViewMode: Enum.FieldOfViewMode;
}

/** Referência mínima de lutador necessária para avaliar espaço relativo e validar destruição. */
export interface CutsceneFighterRef {
	readonly targetId: string;
	readonly model: Model;
	readonly rootPart: BasePart;
}

/** Amostra de câmera em coordenadas de mundo para conversão offline/Studio em keyframes relativos. */
export interface WorldCameraSample {
	readonly time: number;
	readonly cameraCFrame: CFrame;
	readonly referenceCFrame: CFrame;
	readonly fieldOfView?: number;
	readonly easingStyle?: Enum.EasingStyle;
	readonly easingDirection?: Enum.EasingDirection;
	readonly hold?: boolean;
}
