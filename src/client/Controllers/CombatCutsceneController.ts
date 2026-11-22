import { RunService } from "@rbxts/services";
import type { SkillSlot } from "../../shared/TypeDefs";
import { CAMERA_CUTSCENE_DEFAULT_BLEND_OUT_SECONDS } from "../UI/CombatVisualConfig";
import { battleCleanupStep } from "./BattleCleanup";
import type { ResolvedArenaAnchors } from "./CombatArenaAnchors";
import type { CombatCameraController } from "./CombatCameraController";
import {
	clampCutsceneFov,
	computeArenaReferenceCFrame,
	evaluateCutsceneLocalPose,
	isFiniteCFrame,
	validateCutsceneDefinition,
} from "./CombatCutsceneFormat";
import type { CombatCutsceneRegistry } from "./CombatCutsceneRegistry";
import type {
	CameraCutsceneDefinition,
	CameraCutsceneKeyframe,
	CameraCutscenePose,
	CutsceneCancelReason,
	CutsceneFighterRef,
	CutscenePlaybackState,
	CutsceneReferenceSpace,
} from "./CombatCutsceneTypes";

export interface CutsceneStartRequest {
	readonly generation: number;
	readonly battleId: string;
	readonly attackToken: number;
	readonly fighterId: string;
	readonly slot: SkillSlot;
	readonly skillId?: string;
	readonly attacker: CutsceneFighterRef;
	readonly target: CutsceneFighterRef;
}

export interface CombatCutsceneHost {
	readonly isCurrentBattle: (generation: number, battleId: string) => boolean;
	readonly isIntroBlocking: () => boolean;
	readonly getCameraController: () => CombatCameraController;
	readonly getArenaAnchors: () => ResolvedArenaAnchors | undefined;
	readonly isFighterValid: (fighter: CutsceneFighterRef) => boolean;
}

interface ActiveCutsceneSession {
	readonly playbackToken: number;
	readonly generation: number;
	readonly battleId: string;
	readonly attackToken: number;
	readonly definition: CameraCutsceneDefinition;
	readonly keyframes: readonly CameraCutsceneKeyframe[];
	readonly attacker: CutsceneFighterRef;
	readonly target: CutsceneFighterRef;
	readonly followReference: boolean;
	readonly blendInDuration: number;
	readonly blendOutDuration: number;
	readonly cancelOnKo: boolean;
	readonly cancelOnSwitch: boolean;
	readonly initialReferenceCFrame: CFrame;
	readonly blendInStartPose: CameraCutscenePose;
	state: "playing" | "blending_out";
	elapsed: number;
	blendOutElapsed: number;
	lastWorldPose: CameraCutscenePose;
	blendOutStartPose?: CameraCutscenePose;
}

function shouldRestoreAdaptiveOnCancel(reason: CutsceneCancelReason): boolean {
	return (
		reason !== "battle_end" &&
		reason !== "teardown" &&
		reason !== "intro_active" &&
		reason !== "camera_lost"
	);
}

/**
 * Reproduz cutscenes cinematográficas de câmera em espaço relativo (atacante, alvo, arena ou câmera adaptativa)
 * exclusivamente no cliente local, respeitando a prioridade:
 * 1) Loading/Intro -> 2) Cutscene de habilidade -> 3) Câmera adaptativa L2.2.
 */
export class CombatCutsceneController {
	private active?: ActiveCutsceneSession;
	private renderConnection?: RBXScriptConnection;
	private playbackCounter = 0;
	private lastAttemptedBattleKey = "";
	private lastAttemptedAttackToken = -1;
	private lastCancelReason?: CutsceneCancelReason;

	public constructor(
		private readonly registry: CombatCutsceneRegistry,
		private readonly host: CombatCutsceneHost,
	) {}

	public getRegistry(): CombatCutsceneRegistry {
		return this.registry;
	}

	public isActive(): boolean {
		return this.active !== undefined;
	}

	public getState(): CutscenePlaybackState {
		return this.active?.state ?? "idle";
	}

	public getActiveCutsceneId(): string | undefined {
		return this.active?.definition.id;
	}

	public getLastCancelReason(): CutsceneCancelReason | undefined {
		return this.lastCancelReason;
	}

	/**
	 * Tenta iniciar a cutscene cadastrada para um ataque.
	 * Retorna `false` sem tocar na câmera se nenhuma cutscene estiver cadastrada, se a intro/loading
	 * ainda estiver ativa (antes do GO), se o mesmo ataque já foi processado (proteção multi-hit)
	 * ou se a geração/referência não for válida.
	 */
	public tryStartForAttack(request: CutsceneStartRequest): boolean {
		const { generation, battleId, attackToken } = request;
		if (!this.host.isCurrentBattle(generation, battleId)) return false;

		const cameraController = this.host.getCameraController();
		if (this.host.isIntroBlocking() || cameraController.isIntroActive()) {
			return false;
		}

		// Protege contra múltiplos disparos para o mesmo ataque (ex.: eventos multi-hit).
		const battleKey = `${generation}|${battleId}`;
		if (this.lastAttemptedBattleKey === battleKey && this.lastAttemptedAttackToken === attackToken) {
			return false;
		}
		this.lastAttemptedBattleKey = battleKey;
		this.lastAttemptedAttackToken = attackToken;

		const definition = this.registry.resolve({
			fighterId: request.fighterId,
			slot: request.slot,
			skillId: request.skillId,
		});
		if (definition === undefined) return false;

		const validation = validateCutsceneDefinition(definition);
		if (!validation.ok || validation.keyframes === undefined) return false;

		if (!this.host.isFighterValid(request.attacker) || !this.host.isFighterValid(request.target)) {
			return false;
		}

		const adaptiveFrame = cameraController.getLastAppliedFrame();
		if (adaptiveFrame === undefined) return false;

		const initialReference = this.resolveReferenceCFrame(
			definition.referenceSpace,
			request.attacker,
			request.target,
			adaptiveFrame.cframe,
		);
		if (initialReference === undefined) return false;

		if (this.active !== undefined) {
			this.cancel("attack_replaced");
		}

		if (!cameraController.beginCutscene(generation, battleId)) {
			return false;
		}

		const blendInStartPose: CameraCutscenePose = {
			cframe: adaptiveFrame.cframe,
			fieldOfView: clampCutsceneFov(adaptiveFrame.fieldOfView),
			fieldOfViewMode: adaptiveFrame.fieldOfViewMode,
		};

		this.playbackCounter += 1;
		const session: ActiveCutsceneSession = {
			playbackToken: this.playbackCounter,
			generation,
			battleId,
			attackToken,
			definition,
			keyframes: validation.keyframes,
			attacker: request.attacker,
			target: request.target,
			followReference: definition.followReference !== false,
			blendInDuration: math.max(definition.blendInDuration ?? 0, 0),
			blendOutDuration: math.max(definition.blendOutDuration ?? CAMERA_CUTSCENE_DEFAULT_BLEND_OUT_SECONDS, 0),
			cancelOnKo: definition.cancelOnKo !== false,
			cancelOnSwitch: definition.cancelOnSwitch !== false,
			initialReferenceCFrame: initialReference,
			blendInStartPose,
			state: "playing",
			elapsed: 0,
			blendOutElapsed: 0,
			lastWorldPose: blendInStartPose,
		};

		this.active = session;
		this.lastCancelReason = undefined;

		if (!this.applySessionFrame(session)) {
			return false;
		}

		if (this.active === session) {
			this.ensureRenderLoop();
		}
		return true;
	}

	/** Avança a cutscene ativa por `dt` segundos (chamado pelo `PreRender` ou determinísticamente em QA). */
	public step(dt: number): boolean {
		const session = this.active;
		if (session === undefined) return false;

		const cameraController = this.host.getCameraController();
		if (!this.host.isCurrentBattle(session.generation, session.battleId)) {
			this.stopSession(session, "battle_end", false);
			return false;
		}
		if (this.host.isIntroBlocking() || cameraController.isIntroActive()) {
			this.stopSession(session, "intro_active", false);
			return false;
		}
		if (!cameraController.isCutsceneActiveFor(session.generation, session.battleId)) {
			this.stopSession(session, "camera_lost", false);
			return false;
		}
		if (!this.host.isFighterValid(session.attacker) || !this.host.isFighterValid(session.target)) {
			this.stopSession(session, "reference_invalid", true);
			return false;
		}

		const safeDt = dt === dt && dt > 0 && dt < math.huge ? dt : 0;

		if (session.state === "playing") {
			session.elapsed += safeDt;
			if (!this.applySessionFrame(session)) return false;

			if (session.elapsed >= session.definition.duration) {
				if (session.blendOutDuration > 0) {
					session.state = "blending_out";
					session.blendOutElapsed = 0;
					session.blendOutStartPose = session.lastWorldPose;
				} else {
					this.finishToAdaptive(session);
					return false;
				}
			}
			return true;
		}

		// Retorno suave ao enquadramento adaptativo L2.2
		const adaptiveFrame = cameraController.getLastAppliedFrame();
		if (adaptiveFrame === undefined) {
			this.stopSession(session, "camera_lost", false);
			return false;
		}

		session.blendOutElapsed += safeDt;
		const alpha = session.blendOutDuration > 0
			? math.clamp(session.blendOutElapsed / session.blendOutDuration, 0, 1)
			: 1;
		const smooth = alpha * alpha * (3 - 2 * alpha);
		const startPose = session.blendOutStartPose ?? session.lastWorldPose;

		const blendedPose: CameraCutscenePose = {
			cframe: startPose.cframe.Lerp(adaptiveFrame.cframe, smooth),
			fieldOfView: clampCutsceneFov(startPose.fieldOfView + (adaptiveFrame.fieldOfView - startPose.fieldOfView) * smooth),
			fieldOfViewMode: adaptiveFrame.fieldOfViewMode,
		};

		if (!isFiniteCFrame(blendedPose.cframe)) {
			this.stopSession(session, "reference_invalid", true);
			return false;
		}

		if (!cameraController.applyCutscenePose(session.generation, session.battleId, blendedPose)) {
			this.stopSession(session, "camera_lost", false);
			return false;
		}
		session.lastWorldPose = blendedPose;

		if (alpha >= 1) {
			this.finishToAdaptive(session);
			return false;
		}
		return true;
	}

	/** Cancela a cutscene ativa imediatamente. */
	public cancel(reason: CutsceneCancelReason): boolean {
		const session = this.active;
		if (session === undefined) return false;
		this.stopSession(session, reason, shouldRestoreAdaptiveOnCancel(reason));
		return true;
	}

	/** Notifica KO de um lutador da batalha atual, cancelando a cutscene se configurado. */
	public notifyKo(generation: number, battleId: string): boolean {
		const session = this.active;
		if (session === undefined || !session.cancelOnKo) return false;
		if (session.generation !== generation || session.battleId !== battleId) return false;
		return this.cancel("ko");
	}

	/** Notifica troca de lutador da batalha atual, cancelando a cutscene se configurado. */
	public notifySwitch(generation: number, battleId: string): boolean {
		const session = this.active;
		if (session === undefined || !session.cancelOnSwitch) return false;
		if (session.generation !== generation || session.battleId !== battleId) return false;
		return this.cancel("switch");
	}

	/** Limpa estado de deduplicação entre batalhas (chamado no teardown). */
	public resetForBattle(): void {
		this.cancel("teardown");
		this.lastAttemptedBattleKey = "";
		this.lastAttemptedAttackToken = -1;
	}

	private applySessionFrame(session: ActiveCutsceneSession): boolean {
		const cameraController = this.host.getCameraController();
		const adaptiveFrame = cameraController.getLastAppliedFrame();
		if (adaptiveFrame === undefined) {
			this.stopSession(session, "camera_lost", false);
			return false;
		}

		const referenceCFrame = session.followReference
			? this.resolveReferenceCFrame(
					session.definition.referenceSpace,
					session.attacker,
					session.target,
					adaptiveFrame.cframe,
				)
			: session.initialReferenceCFrame;
		if (referenceCFrame === undefined || !isFiniteCFrame(referenceCFrame)) {
			this.stopSession(session, "reference_invalid", true);
			return false;
		}

		const clampedElapsed = math.clamp(session.elapsed, 0, session.definition.duration);
		const localPose = evaluateCutsceneLocalPose(
			session.keyframes,
			clampedElapsed,
			adaptiveFrame.fieldOfView,
			adaptiveFrame.fieldOfViewMode,
			session.definition.fieldOfViewMode,
		);

		let worldCFrame = referenceCFrame.mul(localPose.cframe);
		let worldFov = localPose.fieldOfView;
		if (!isFiniteCFrame(worldCFrame)) {
			this.stopSession(session, "reference_invalid", true);
			return false;
		}

		if (session.blendInDuration > 0 && clampedElapsed < session.blendInDuration) {
			const alpha = math.clamp(clampedElapsed / session.blendInDuration, 0, 1);
			const smooth = alpha * alpha * (3 - 2 * alpha);
			worldCFrame = session.blendInStartPose.cframe.Lerp(worldCFrame, smooth);
			worldFov = clampCutsceneFov(
				session.blendInStartPose.fieldOfView + (worldFov - session.blendInStartPose.fieldOfView) * smooth,
			);
		}

		const pose: CameraCutscenePose = {
			cframe: worldCFrame,
			fieldOfView: worldFov,
			fieldOfViewMode: localPose.fieldOfViewMode,
		};

		if (!cameraController.applyCutscenePose(session.generation, session.battleId, pose)) {
			this.stopSession(session, "camera_lost", false);
			return false;
		}
		session.lastWorldPose = pose;
		return true;
	}

	private resolveReferenceCFrame(
		space: CutsceneReferenceSpace,
		attacker: CutsceneFighterRef,
		target: CutsceneFighterRef,
		adaptiveCFrame: CFrame,
	): CFrame | undefined {
		if (space === "attacker") {
			if (!this.host.isFighterValid(attacker)) return undefined;
			const pivot = attacker.model.GetPivot();
			return isFiniteCFrame(pivot) ? pivot : undefined;
		}
		if (space === "target") {
			if (!this.host.isFighterValid(target)) return undefined;
			const pivot = target.model.GetPivot();
			return isFiniteCFrame(pivot) ? pivot : undefined;
		}
		if (space === "arena") {
			const anchors = this.host.getArenaAnchors();
			if (anchors === undefined) return undefined;
			return computeArenaReferenceCFrame(anchors);
		}
		return isFiniteCFrame(adaptiveCFrame) ? adaptiveCFrame : undefined;
	}

	private finishToAdaptive(session: ActiveCutsceneSession): void {
		if (this.active !== session) return;
		this.active = undefined;
		this.disconnectRenderLoop();
		this.host.getCameraController().endCutscene(session.generation, session.battleId, true);
	}

	private stopSession(
		session: ActiveCutsceneSession,
		reason: CutsceneCancelReason,
		restoreAdaptive: boolean,
	): void {
		if (this.active !== session) return;
		this.active = undefined;
		this.lastCancelReason = reason;
		this.disconnectRenderLoop();
		this.host.getCameraController().endCutscene(session.generation, session.battleId, restoreAdaptive);
	}

	private ensureRenderLoop(): void {
		if (this.renderConnection !== undefined) return;
		this.renderConnection = RunService.PreRender.Connect((dt) => {
			const session = this.active;
			if (session === undefined) {
				this.disconnectRenderLoop();
				return;
			}
			const [ok, err] = pcall(() => this.step(dt));
			if (!ok) {
				warn(`[CombatCutsceneController] Erro na reprodução da cutscene: ${tostring(err)}`);
				this.stopSession(session, "reference_invalid", true);
			}
		});
	}

	private disconnectRenderLoop(): void {
		if (this.renderConnection === undefined) return;
		const conn = this.renderConnection;
		this.renderConnection = undefined;
		battleCleanupStep("cutscene render disconnect", () => conn.Disconnect());
	}
}
