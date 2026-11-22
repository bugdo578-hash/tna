import { ReplicatedStorage, TweenService, Workspace } from "@rbxts/services";
import { ARENA_CLIENT_REPLICATION_TIMEOUT_SECONDS, ARENA_INSTANCE_ID_ATTRIBUTE, MIN_DAMAGE } from "../../shared/Config";
import {
	ASSETS_FOLDER_NAME,
	BENCH_FIGHTER_TRANSPARENCY,
	COMBAT_FEEDBACK_COLORS,
	DAMAGE_POPUP_DURATION_SECONDS,
	FIGHTER_ASSETS_FOLDER_NAME,
	HIT_RESULT_WAIT_SECONDS,
	PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS,
	PLACEHOLDER_STAND_STRIKE_STUDS,
	RIG_ATTACHMENT_NAMES,
	STAND_SUBMODEL_NAME,
	WORKSPACE_BATTLE_FOLDER_NAME,
} from "../UI/CombatVisualConfig";
import { FIGHTER_DATA, type RealFighterId } from "../../shared/FighterData";
import type {
	AttackStartedPayload,
	BattleFighterSnapshot,
	BattleStartedPayload,
	BattleTransitionPayload,
	StateChangedPayload,
	EffectAppliedPayload,
	EffectExpiredPayload,
	EffectTickPayload,
	FighterDiedPayload,
	HitResolvedPayload,
	SwitchPerformedPayload,
} from "../../shared/Remotes";
import { ANUBIS_SKILL_DATA, JOTARO_SKILL_DATA, type SkillData } from "../../shared/SkillData";
import type { SkillSlot, StatusEffect } from "../../shared/TypeDefs";
import { battleCleanupStep } from "./BattleCleanup";
import { CombatCameraController, resolveSideCameraAnchor } from "./CombatCameraController";
import type { AdaptiveCameraFrame, CameraFramingContext, FighterFramingSample } from "./CombatCameraFraming";
import { BattleIntroController } from "./BattleIntroController";
import { BattleRemotes } from "./BattleRemotes";
import { CombatArenaAnchorResolver, type ResolvedArenaAnchors } from "./CombatArenaAnchors";
import { CombatAttackFinalizer, type PendingDeathRecord } from "./CombatAttackFinalizer";
import { CombatDamagePool, type BillboardPoolItem } from "./CombatDamagePool";
import { resolveFighterGroundContact } from "./CombatFighterGrounding";
import { CombatHitQueue } from "./CombatHitQueue";
import { CombatStandMotion, type StandMotionState } from "./CombatStandMotion";
import { CombatVfxBridge, type PreloadedVfxEntry } from "./CombatVfxBridge";
import type { VFXController } from "./VFXController";

export interface RigAttachmentMap {
	readonly Peito: Attachment | BasePart;
	readonly MaoDireita: Attachment | BasePart;
	readonly MaoEsquerda: Attachment | BasePart;
	readonly Cabeca: Attachment | BasePart;
}

interface FighterVisualEntry {
	readonly targetId: string;
	readonly fighterId: string;
	readonly sideId: string;
	readonly sideIndex: 0 | 1;
	benchIndex: number;
	readonly groundContactOffset: Vector3;
	readonly model: Model;
	readonly rootPart: BasePart;
	readonly humanoid: Humanoid | undefined;
	readonly standModel: Model | undefined;
	readonly standMotion: StandMotionState | undefined;
	readonly attachments: RigAttachmentMap;
	readonly originalTransparency: Map<BasePart, number>;
	hp: number;
	hpMax: number;
	active: boolean;
	dead: boolean;
	homeCFrame: CFrame;
	readonly effectEmitters: Map<StatusEffect, ParticleEmitter>;
}

interface ActiveAttackState {
	readonly token: number;
	readonly attacker: FighterVisualEntry;
	readonly target: FighterVisualEntry;
	readonly timeline: SkillData;
	readonly slot: SkillSlot;
}

export class CombatController {
	private readonly fightersByTargetId = new Map<string, FighterVisualEntry>();
	private readonly arenaAnchors: CombatArenaAnchorResolver;
	private readonly cameraController: CombatCameraController;
	public readonly introduction: BattleIntroController;
	private recoverIntroHud?: () => void;
	private readonly hitQueue: CombatHitQueue;
	private readonly attackFinalizer: CombatAttackFinalizer<FighterVisualEntry>;
	private readonly hitResultsByIndex: Map<number, HitResolvedPayload[]>;
	private readonly consumedHitIndices: Set<number>;
	private readonly pendingSwitches: SwitchPerformedPayload[];
	private readonly pendingDeaths: Map<string, PendingDeathRecord>;
	private readonly damagePool: CombatDamagePool;
	private readonly vfxBridge: CombatVfxBridge;
	private readonly standMotion: CombatStandMotion;
	private readonly billboardPool: BillboardPoolItem[];
	private readonly hpVisualListeners = new Set<(targetId: string, hp: number, hpMax: number) => void>();
	private readonly deathVisualListeners = new Set<(payload: FighterDiedPayload) => void>();
	private readonly battleTweens = new Set<Tween>();
	private readonly battleConnections = new Set<RBXScriptConnection>();
	private readonly battleTasks = new Set<thread>();
	private readonly battleTracks = new Set<AnimationTrack>();
	private readonly preloadedVfxEntries: PreloadedVfxEntry[];
	private readonly battleVfxWorkingCopies: Map<string, Instance>;
	private readonly vfxCarrierParts: Map<Instance, BasePart>;

	private stageFolder: Folder | undefined;
	private poolContainer: Folder | undefined;
	private sideIds: readonly [string, string] = ["", ""];
	private physicalSideIds: readonly [string, string] = ["", ""];
	private activeArenaInstanceId: string | undefined;
	private currentAttackToken = 0;
	private activePendingHits = 0;
	private activeAttack: ActiveAttackState | undefined;
	private deferredAttack: ActiveAttackState | undefined;
	private followUpCancelledForCurrentAttack = false;
	private battleEnded = false;
	private battleVfxGeneration = 0;
	private started = false;

	public constructor(
		private readonly vfxController?: VFXController,
		private readonly assetsRoot: Instance = ReplicatedStorage,
		arenaSearchRoot: Instance = Workspace,
		private readonly arenaReplicationTimeoutSeconds?: number,
		getCamera?: () => Camera | undefined,
		getViewportSize?: () => Vector2,
	) {
		this.arenaAnchors = new CombatArenaAnchorResolver(arenaSearchRoot);
		this.cameraController = new CombatCameraController(getCamera, getViewportSize);
		this.introduction = new BattleIntroController(
			() => {
				this.cleanupStage(undefined, true);
				return this.cameraController.capture();
			},
			(progress) => this.cameraController.setIntroProgress(progress),
			() => {
				if (this.recoverIntroHud !== undefined) this.recoverIntroHud();
				else this.cleanupStage();
			},
		);
		this.damagePool = new CombatDamagePool({
			createBattleTween: (object, info, goal) => this.createBattleTween(object, info, goal),
			delayBattle: (seconds, callback) => this.delayBattle(seconds, callback),
		});
		this.vfxBridge = new CombatVfxBridge({
			getVfxController: () => this.vfxController,
			getAssetsRoot: () => this.assetsRoot,
			getGlobalVfxRoot: () => this.getGlobalVfxRoot(),
			getStageFolder: () => this.stageFolder,
			isBattleEnded: () => this.battleEnded,
		});
		this.standMotion = new CombatStandMotion({
			createBattleTween: (object, info, goal) => this.createBattleTween(object, info, goal),
			delayBattle: (seconds, callback) => this.delayBattle(seconds, callback),
			isAttackCurrent: (attackToken) => this.currentAttackToken === attackToken && !this.battleEnded,
			isFollowUpCancelled: () => this.followUpCancelledForCurrentAttack,
		});
		this.hitQueue = new CombatHitQueue({
			isBattleEnded: () => this.battleEnded,
			isAttackCurrent: (attackToken) => this.currentAttackToken === attackToken && !this.battleEnded,
			isFollowUpCancelled: () => this.followUpCancelledForCurrentAttack,
			onPendingHitsChanged: (pendingHits) => {
				this.activePendingHits = pendingHits;
			},
		});
		this.attackFinalizer = new CombatAttackFinalizer<FighterVisualEntry>({
			isBattleEnded: () => this.battleEnded,
			isCurrentBattle: (generation) => this.isCurrentBattle(generation),
			getBattleGeneration: () => this.getBattleGeneration(),
			isFollowUpCancelled: () => this.followUpCancelledForCurrentAttack,
			hasPendingHits: () => this.deferredAttack === undefined && this.hitQueue.hasPendingHits(),
			hasUnconsumedHitForTarget: (targetId) => this.hitQueue.hasUnconsumedHitForTarget(targetId),
			getFighter: (targetId) => this.fightersByTargetId.get(targetId),
			restoreStandBase: (entry, duration) => this.restoreStandBase(entry, duration),
			tweenModelTo: (model, targetCFrame, duration) => this.tweenModelTo(model, targetCFrame, duration),
			delayBattle: (seconds, callback) => this.delayBattle(seconds, callback),
			cancelBattleTask: (taskThread) => this.cancelBattleTask(taskThread),
			trackBattleConnection: (connection) => this.trackBattleConnection(connection),
			untrackBattleConnection: (connection) => this.untrackBattleConnection(connection),
			onKoAndSwitchesIdle: () => this.launchDeferredAttackIfReady(),
			computeActiveSlotCFrame: (sideIndex, groundContactOffset) =>
				this.computeActiveSlotCFrame(sideIndex, groundContactOffset),
			computeBenchSlotCFrame: (sideIndex, benchSlot, groundContactOffset) =>
				this.computeBenchSlotCFrame(sideIndex, benchSlot, groundContactOffset),
			applyActiveVisualState: (entry) => this.applyActiveVisualState(entry),
			notifyHpVisualChanged: (targetId, hp, hpMax) => this.notifyHpVisualChanged(targetId, hp, hpMax),
			notifyDeathVisualFlushed: (payload) => this.notifyDeathVisualFlushed(payload),
			emitKoVfx: (deadFighter) => this.emitKoVfx(deadFighter),
		});
		this.hitResultsByIndex = this.hitQueue.hitResultsByIndex;
		this.consumedHitIndices = this.hitQueue.consumedHitIndices;
		this.pendingSwitches = this.attackFinalizer.pendingSwitches;
		this.pendingDeaths = this.attackFinalizer.pendingDeaths;
		this.billboardPool = this.damagePool.billboardPool;
		this.preloadedVfxEntries = this.vfxBridge.preloadedVfxEntries;
		this.battleVfxWorkingCopies = this.vfxBridge.battleVfxWorkingCopies;
		this.vfxCarrierParts = this.vfxBridge.vfxCarrierParts;
	}

	public start(): void {
		if (this.started) return;
		this.started = true;
		this.initBillboardPool();

		BattleRemotes.battleTransition.OnClientEvent.Connect((payload) => {
			this.introduction.receive(payload as BattleTransitionPayload);
		});
		BattleRemotes.battleStarted.OnClientEvent.Connect((payload) => {
			this.onBattleStarted(payload as BattleStartedPayload);
		});
		BattleRemotes.attackStarted.OnClientEvent.Connect((payload) => {
			this.onAttackStarted(payload as AttackStartedPayload);
		});
		BattleRemotes.hitResolved.OnClientEvent.Connect((payload) => {
			this.onHitResolved(payload as HitResolvedPayload);
		});
		BattleRemotes.effectApplied.OnClientEvent.Connect((payload) => {
			this.onEffectApplied(payload as EffectAppliedPayload);
		});
		BattleRemotes.effectTick.OnClientEvent.Connect((payload) => {
			this.onEffectTick(payload as EffectTickPayload);
		});
		BattleRemotes.effectExpired.OnClientEvent.Connect((payload) => {
			this.onEffectExpired(payload as EffectExpiredPayload);
		});
		BattleRemotes.fighterDied.OnClientEvent.Connect((payload) => {
			this.onFighterDied(payload as FighterDiedPayload);
		});
		BattleRemotes.switchPerformed.OnClientEvent.Connect((payload) => {
			this.onSwitchPerformed(payload as SwitchPerformedPayload);
		});
		BattleRemotes.stateChanged.OnClientEvent.Connect((payload: StateChangedPayload) => {
			if (payload.battleReleased !== undefined) this.introduction.release(payload.battleReleased);
		});
	}

	public setIntroRecovery(recover?: () => void): void {
		this.recoverIntroHud = recover;
	}

	/** Retorna a geração atual da batalha para proteger o deload contra teardowns atrasados. */
	public getBattleGeneration(): number {
		return this.vfxBridge.getBattleGeneration();
	}

	/** Descarrega as pastas de VFX pré-carregadas desta batalha, ignorando gerações já substituídas. */
	public deloadBattleVfx(expectedGeneration?: number): void {
		this.vfxBridge.deloadBattleVfx(expectedGeneration);
	}

	/** Retorna o modelo instanciado para `targetId` (útil para câmera e HUD). */
	public getFighterModel(targetId: string): Model | undefined {
		return this.fightersByTargetId.get(targetId)?.model;
	}

	/** Retorna as referências de `Arena_bases` resolvidas para a batalha atual, se válidas. */
	public getResolvedArenaAnchors(): ResolvedArenaAnchors | undefined {
		return this.arenaAnchors.getResolvedAnchors();
	}

	/** Retorna a instância física de arena resolvida em `ActiveArenas` para a batalha atual, se houver. */
	public getActiveArenaInstance(): Model | undefined {
		return this.arenaAnchors.getActiveArenaInstance();
	}

	/** Retorna o `instanceId` da arena reservada da batalha atual, se houver. */
	public getActiveArenaInstanceId(): string | undefined {
		return this.activeArenaInstanceId;
	}

	/** Retorna os lados físicos canônicos `[Time A, Time B]` da batalha atual. */
	public getPhysicalSideIds(): readonly [string, string] {
		return this.physicalSideIds;
	}

	/** Retorna os diagnósticos da última resolução de `Arena_bases`. */
	public getArenaAnchorDiagnostics(): readonly string[] {
		return this.arenaAnchors.getLastDiagnostics();
	}

	/** Retorna a Part de câmera ativa da arena na batalha atual, se houver. */
	public getActiveCameraPart(): BasePart | undefined {
		return this.cameraController.getActiveCameraPart();
	}

	/** Retorna os diagnósticos da última tentativa de resolução de câmera da arena. */
	public getLastCameraDiagnostics(): readonly string[] {
		return this.cameraController.getLastDiagnostics();
	}

	/** Retorna o último enquadramento adaptativo aplicado à câmera de batalha, se houver. */
	public getLastAppliedCameraFrame(): AdaptiveCameraFrame | undefined {
		return this.cameraController.getLastAppliedFrame();
	}

	/** Recalcula o enquadramento adaptativo da câmera para o ViewportSize atual. */
	public refreshCameraFraming(force = false): boolean {
		return this.cameraController.refreshFraming(force);
	}

	/** Registra callback disparado quando o HP visual é atualizado após consumir hit/tick/KO. */
	public onFighterHpVisualChanged(listener: (targetId: string, hp: number, hpMax: number) => void): () => void {
		this.hpVisualListeners.add(listener);
		return () => { this.hpVisualListeners.delete(listener); };
	}

	/** Registra callback disparado quando um KO e eventual troca automática são efetivados visualmente. */
	public onFighterDeathVisualFlushed(listener: (payload: FighterDiedPayload) => void): () => void {
		this.deathVisualListeners.add(listener);
		return () => { this.deathVisualListeners.delete(listener); };
	}

	private notifyHpVisualChanged(targetId: string, hp: number, hpMax: number): void {
		for (const listener of this.hpVisualListeners) {
			listener(targetId, hp, hpMax);
		}
	}

	private notifyDeathVisualFlushed(payload: FighterDiedPayload): void {
		for (const listener of this.deathVisualListeners) {
			listener(payload);
		}
	}

	private initBillboardPool(): void {
		this.poolContainer = this.damagePool.initBillboardPool();
	}

	private acquireBillboard(): BillboardPoolItem {
		return this.damagePool.acquireBillboard();
	}

	private showFloatingText(
		adornee: Attachment | BasePart,
		text: string,
		color: Color3,
		size: UDim2,
		duration = DAMAGE_POPUP_DURATION_SECONDS,
	): void {
		this.damagePool.showFloatingText(adornee, text, color, size, duration);
	}

	private onBattleStarted(payload: BattleStartedPayload): void {
		const transitionId = payload.transitionId;
		if (transitionId === undefined) {
			this.buildBattleStage(payload, this.cleanupStage());
			return;
		}
		if (!this.introduction.owns(transitionId)) return;
		const [ok, failure] = pcall(() => this.buildBattleStage(payload, this.battleVfxGeneration));
		if (!ok) {
			warn("[CombatController] prepara??o da batalha", failure);
			this.introduction.failed(transitionId);
		}
	}

	private buildBattleStage(payload: BattleStartedPayload, generation: number): void {
		if (generation !== this.battleVfxGeneration) return;
		const physicalSides = payload.arena?.physicalSides ?? payload.sides;
		this.sideIds = payload.sides;
		this.physicalSideIds = physicalSides;
		this.activeArenaInstanceId = payload.arena?.instanceId;
		this.currentAttackToken += 1;
		this.activeAttack = undefined;
		this.deferredAttack = undefined;
		this.followUpCancelledForCurrentAttack = false;
		this.hitQueue.clear();
		this.attackFinalizer.clear();
		this.battleEnded = false;

		const anchorResolution =
			payload.arena !== undefined
				? this.arenaAnchors.resolveForReservedArena(
						payload.arena,
						() => this.isCurrentBattle(generation),
						this.arenaReplicationTimeoutSeconds,
					)
				: this.arenaAnchors.resolveForBattle();
		if (!this.isCurrentBattle(generation)) {
			return;
		}
		if (!anchorResolution.ok) {
			this.battleEnded = true;
			this.activeArenaInstanceId = undefined;
			if (payload.transitionId !== undefined) this.introduction.failed(payload.transitionId);
			return;
		}

		const folder = new Instance("Folder");
		folder.Name =
			payload.arena !== undefined
				? `${WORKSPACE_BATTLE_FOLDER_NAME}_${payload.arena.instanceId}`
				: WORKSPACE_BATTLE_FOLDER_NAME;
		if (payload.arena !== undefined) {
			folder.SetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE, payload.arena.instanceId);
		}
		this.stageFolder = folder;

		const waitingSlotCounterBySide: [number, number] = [0, 0];

		for (const snapshot of payload.fighters) {
			let sideIndex: 0 | 1;
			if (snapshot.sideId === physicalSides[0]) {
				sideIndex = 0;
			} else if (snapshot.sideId === physicalSides[1]) {
				sideIndex = 1;
			} else {
				warn(`[CombatController] sideId "${snapshot.sideId}" não pertence aos lados físicos da arena.`);
				continue;
			}
			const benchSlot = snapshot.active ? 0 : waitingSlotCounterBySide[sideIndex];
			if (!snapshot.active) {
				waitingSlotCounterBySide[sideIndex] += 1;
			}

			const slotAnchor = snapshot.active
				? this.arenaAnchors.getActiveAnchorPart(sideIndex)
				: this.arenaAnchors.getBenchAnchorPart(sideIndex, benchSlot);
			if (slotAnchor === undefined) {
				continue;
			}

			const clonedModel = this.cloneFighterAsset(snapshot.fighterId);
			if (!this.isCurrentBattle(generation)) {
				battleCleanupStep("stale fighter clone", () => clonedModel.Destroy());
				return;
			}
			clonedModel.Name = `${snapshot.targetId}_${snapshot.fighterId}`;
			clonedModel.Parent = folder;

			const rootPart = this.resolveRootPart(clonedModel);
			rootPart.PivotOffset = new CFrame();
			const humanoid = clonedModel.FindFirstChildOfClass("Humanoid");
			if (humanoid !== undefined) {
				humanoid.MaxHealth = snapshot.hpMax;
				humanoid.Health = snapshot.hp;
				humanoid.DisplayDistanceType = Enum.HumanoidDisplayDistanceType.Viewer;
			}

			const standModel = this.resolveStandSubmodel(clonedModel);
			const standJoint = rootPart.FindFirstChild("StandJoint");
			const attachments = this.resolveAttachments(clonedModel, rootPart);
			const originalTransparency = this.captureBaseTransparency(clonedModel);
			const groundContact = resolveFighterGroundContact(clonedModel, rootPart, standModel);

			const homeCFrame = snapshot.active
				? this.computeActiveSlotCFrame(sideIndex, groundContact.offset)
				: this.computeBenchSlotCFrame(sideIndex, benchSlot, groundContact.offset);
			if (homeCFrame === undefined) {
				battleCleanupStep("unplaced fighter clone", () => clonedModel.Destroy());
				continue;
			}

			this.prepareModelPhysics(clonedModel, rootPart);
			clonedModel.PivotTo(homeCFrame);

			const entry: FighterVisualEntry = {
				targetId: snapshot.targetId,
				fighterId: snapshot.fighterId,
				sideId: snapshot.sideId,
				sideIndex,
				benchIndex: benchSlot,
				groundContactOffset: groundContact.offset,
				model: clonedModel,
				rootPart,
				humanoid,
				standModel,
				standMotion: standJoint?.IsA("Motor6D")
					? { joint: standJoint, baseC1: standJoint.C1, generation: 0 }
					: undefined,
				attachments,
				originalTransparency,
				hp: snapshot.hp,
				hpMax: snapshot.hpMax,
				active: snapshot.active,
				dead: snapshot.hp <= 0,
				homeCFrame,
				effectEmitters: new Map<StatusEffect, ParticleEmitter>(),
			};

			this.fightersByTargetId.set(snapshot.targetId, entry);
			this.applyActiveVisualState(entry);
		}

		if (!this.isCurrentBattle(generation)) return;
		folder.Parent = Workspace;

		const transitionId = payload.transitionId;
		const isCurrent = () => this.isCurrentBattle(generation) && (transitionId === undefined || this.introduction.owns(transitionId));
		const prepare = () => {
			const [ok, cameraReady] = pcall(() => this.resolveBattleCamera(
				payload.sides[0], generation, isCurrent, payload.arena !== undefined, transitionId !== undefined,
			));
			if (transitionId === undefined || !isCurrent()) return;
			if (ok && cameraReady && this.fightersByTargetId.size() === payload.fighters.size()) this.introduction.ready(transitionId);
			else this.introduction.failed(transitionId);
		};

		if (transitionId !== undefined) {
			this.preloadBattleVfx(payload, generation);
			this.spawnBattle(prepare);
		} else {
			prepare();
			this.preloadBattleVfx(payload, generation);
		}
	}

	private resolveBattleCamera(
		ownSideId: string, generation: number, isCurrent: () => boolean, reserved: boolean, withIntro: boolean,
	): boolean {
		const sideIndex = this.physicalSideIds[0] === ownSideId ? 0 : this.physicalSideIds[1] === ownSideId ? 1 : undefined;
		if (sideIndex === undefined) return false;
		const sideFolder = this.arenaAnchors.getSideFolder(sideIndex);
		if (sideFolder === undefined) return false;
		const isInActiveRoot = (instance: Instance) => this.arenaAnchors.isDescendantInActiveRoot(instance);
		const context = this.buildCameraFramingContext();
		const timeout = reserved ? (this.arenaReplicationTimeoutSeconds ?? ARENA_CLIENT_REPLICATION_TIMEOUT_SECONDS) : 0;
		const resolve = () => this.cameraController.resolveAndActivateForSide(
			sideFolder, isInActiveRoot, sideIndex, generation, isCurrent, timeout, undefined, context, withIntro,
		);
		if (!withIntro) {
			const initial = resolveSideCameraAnchor(sideFolder, sideIndex);
			if (reserved && !initial.ok && !initial.fatal) this.spawnBattle(() => { resolve(); });
			else resolve();
			return true;
		}

		if (!resolve().ok) return false;
		const deadline = os.clock() + timeout;
		while (isCurrent()) {
			if (this.cameraController.prepareIntro(sideIndex)) return true;
			if (os.clock() >= deadline) break;
			task.wait();
		}
		return false;
	}

	private buildCameraFramingContext(): CameraFramingContext | undefined {
		const anchors = this.arenaAnchors.getResolvedAnchors();
		if (anchors === undefined) return undefined;
		return {
			anchors,
			getFighterSamples: () => {
				const samples: FighterFramingSample[] = [];
				for (const [, entry] of this.fightersByTargetId) {
					const anchor = entry.active
						? this.arenaAnchors.getActiveAnchorPart(entry.sideIndex)
						: this.arenaAnchors.getBenchAnchorPart(entry.sideIndex, entry.benchIndex);
					if (anchor !== undefined) {
						samples.push({ model: entry.model, anchor, isActive: entry.active });
					}
				}
				return samples;
			},
			getStageFolder: () => this.stageFolder,
		};
	}

	private isCurrentBattle(generation: number): boolean {
		return this.vfxBridge.isCurrentBattle(generation);
	}

	private cloneFighterAsset(fighterId: string): Model {
		const assetsFolder = this.assetsRoot.FindFirstChild(ASSETS_FOLDER_NAME);
		const fightersFolder = assetsFolder?.FindFirstChild(FIGHTER_ASSETS_FOLDER_NAME);
		const template = fightersFolder?.FindFirstChild(fighterId) ?? fightersFolder?.FindFirstChild(fighterId.lower());
		if (template !== undefined && template.IsA("Model")) {
			return template.Clone();
		}

		// Fallback caso um fighterId de teste (ex.: dummy "fury") não exista na pasta Assets/Fighters
		const fallbackTemplate = fightersFolder?.FindFirstChild("jotaro");
		if (fallbackTemplate !== undefined && fallbackTemplate.IsA("Model")) {
			return fallbackTemplate.Clone();
		}

		const placeholderModel = new Instance("Model");
		const part = new Instance("Part");
		part.Name = "HumanoidRootPart";
		part.Size = new Vector3(1, 2, 1);
		part.Anchored = true;
		part.CanCollide = false;
		part.Parent = placeholderModel;
		placeholderModel.PrimaryPart = part;
		return placeholderModel;
	}

	private resolveRootPart(model: Model): BasePart {
		const hrp = model.FindFirstChild("HumanoidRootPart");
		if (hrp !== undefined && hrp.IsA("BasePart")) {
			model.PrimaryPart = hrp;
			return hrp;
		}
		if (model.PrimaryPart !== undefined) return model.PrimaryPart;
		for (const descendant of model.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				model.PrimaryPart = descendant;
				return descendant;
			}
		}
		const fallback = new Instance("Part");
		fallback.Name = "HumanoidRootPart";
		fallback.Size = new Vector3(1, 2, 1);
		fallback.Anchored = true;
		fallback.CanCollide = false;
		fallback.Parent = model;
		model.PrimaryPart = fallback;
		return fallback;
	}

	private resolveStandSubmodel(model: Model): Model | undefined {
		const directStand = model.FindFirstChild(STAND_SUBMODEL_NAME) ?? model.FindFirstChild("Star_platinum_Luta");
		if (directStand !== undefined && directStand.IsA("Model")) {
			directStand.Name = STAND_SUBMODEL_NAME;
			return directStand;
		}
		return undefined;
	}

	private resolveAttachments(model: Model, fallbackPart: BasePart): RigAttachmentMap {
		const findAtt = (name: string): Attachment | BasePart => {
			for (const descendant of model.GetDescendants()) {
				if (descendant.IsA("Attachment") && descendant.Name === name) {
					return descendant;
				}
			}
			return fallbackPart;
		};

		return {
			Peito: findAtt(RIG_ATTACHMENT_NAMES.Peito),
			MaoDireita: findAtt(RIG_ATTACHMENT_NAMES.MaoDireita),
			MaoEsquerda: findAtt(RIG_ATTACHMENT_NAMES.MaoEsquerda),
			Cabeca: findAtt(RIG_ATTACHMENT_NAMES.Cabeca),
		};
	}

	private captureBaseTransparency(model: Model): Map<BasePart, number> {
		const map = new Map<BasePart, number>();
		for (const descendant of model.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				map.set(descendant, descendant.Transparency);
			}
		}
		return map;
	}

	private prepareModelPhysics(model: Model, rootPart: BasePart): void {
		for (const descendant of model.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				descendant.CanCollide = false;
				if (descendant === rootPart) {
					descendant.Anchored = true;
				} else {
					descendant.Anchored = false;
					descendant.Massless = true;
				}
			}
		}
	}

	private computeActiveSlotCFrame(sideIndex: 0 | 1, groundContactOffset?: Vector3): CFrame | undefined {
		return this.arenaAnchors.getActiveSlotCFrame(sideIndex, groundContactOffset);
	}

	private computeBenchSlotCFrame(
		sideIndex: 0 | 1,
		benchSlot: number,
		groundContactOffset?: Vector3,
	): CFrame | undefined {
		return this.arenaAnchors.getBenchSlotCFrame(sideIndex, benchSlot, groundContactOffset);
	}

	private applyActiveVisualState(entry: FighterVisualEntry): void {
		for (const [part, baseTransparency] of entry.originalTransparency) {
			if (!part.Parent) continue;
			if (baseTransparency >= 0.99) {
				part.Transparency = baseTransparency;
				continue;
			}
			if (entry.dead) {
				part.Transparency = 0.75;
			} else if (entry.active) {
				part.Transparency = baseTransparency;
			} else {
				// No banco: recuado e semi-oculto; Stand do banco fica oculto até entrar em campo
				const isStandPart = entry.standModel !== undefined && part.IsDescendantOf(entry.standModel);
				part.Transparency = isStandPart ? 1 : math.max(baseTransparency, BENCH_FIGHTER_TRANSPARENCY);
			}
		}
	}

	private resolveSkillTimeline(fighterId: string, slot: SkillSlot): SkillData {
		const lowerId = fighterId.lower() as RealFighterId;
		if (lowerId in FIGHTER_DATA) {
			return FIGHTER_DATA[lowerId].skills[slot - 1];
		}
		if (lowerId === "anubis") return ANUBIS_SKILL_DATA[slot - 1];
		return JOTARO_SKILL_DATA[slot - 1];
	}

	private onHitResolved(payload: HitResolvedPayload): void {
		this.hitQueue.recordHitResult(payload);
	}

	private finalizeActiveAttackBeforeNext(): void {
		const previousAttack = this.activeAttack;
		this.activeAttack = undefined;
		this.deferredAttack = undefined;
		const hadPendingHits = this.hitQueue.hasPendingHits();

		if (previousAttack !== undefined || hadPendingHits) {
			this.currentAttackToken += 1;
		}
		if (hadPendingHits) {
			this.hitQueue.drainUnconsumedResults((results) => {
				for (const result of results) {
					const fallbackTarget = previousAttack?.target ?? this.fightersByTargetId.get(result.targetId);
					if (fallbackTarget !== undefined) {
						this.presentHitResult(
							result,
							fallbackTarget,
							previousAttack?.attacker,
							previousAttack?.timeline,
							previousAttack?.slot,
						);
					}
					if (result.followUpCancelled) {
						this.followUpCancelledForCurrentAttack = true;
					}
				}
				this.attackFinalizer.flushReadyPendingDeaths();
			});
		}
		if (previousAttack !== undefined) {
			this.attackFinalizer.finalizeAttack(previousAttack.attacker, previousAttack.timeline);
		}
		this.attackFinalizer.forceCompletePendingForNextAttack();
	}

	private onAttackStarted(payload: AttackStartedPayload): void {
		if (this.battleEnded) return;
		const attacker = this.fightersByTargetId.get(payload.attackerId);
		const target = this.fightersByTargetId.get(payload.targetId);
		if (attacker === undefined || target === undefined) return;

		this.finalizeActiveAttackBeforeNext();

		this.currentAttackToken += 1;
		const attackToken = this.currentAttackToken;
		this.followUpCancelledForCurrentAttack = false;

		const timeline = this.resolveSkillTimeline(attacker.fighterId, payload.slot);
		const totalHits = timeline.hits.size();
		const attackState: ActiveAttackState = { token: attackToken, attacker, target, timeline, slot: payload.slot };
		this.activeAttack = attackState;
		this.hitQueue.beginAttack(totalHits);

		if (this.attackFinalizer.hasActiveKoAnimations()) {
			this.deferredAttack = attackState;
			return;
		}

		this.startAttackPresentation(attackState);
	}

	private launchDeferredAttackIfReady(): void {
		const pending = this.deferredAttack;
		if (pending === undefined) return;
		if (this.battleEnded || this.attackFinalizer.hasActiveKoAnimations()) return;
		if (this.currentAttackToken !== pending.token || this.activeAttack !== pending) {
			this.deferredAttack = undefined;
			return;
		}
		this.deferredAttack = undefined;
		this.startAttackPresentation(pending);
	}

	private startAttackPresentation(attackState: ActiveAttackState): void {
		const { attacker, target, timeline, token, slot } = attackState;
		this.positionStandForAttack(attacker, math.max(timeline.hits[0]?.time ?? 0.1, 0.05) * 0.8);

		const track = this.tryPlaySlotAnimation(attacker, slot, timeline);
		if (track !== undefined) {
			this.bindAnimationMarkers(track, attacker, target, timeline, token, slot);
		} else {
			this.runPlaceholderAttackSequence(attacker, target, timeline, token, slot);
		}
	}

	private tryPlaySlotAnimation(
		attacker: FighterVisualEntry,
		slot: SkillSlot,
		timeline: SkillData,
	): AnimationTrack | undefined {
		const animName = timeline.name ?? `S${slot}`;
		const findAnimationInstance = (root: Instance): Animation | undefined => {
			for (const child of root.GetDescendants()) {
				if (child.IsA("Animation") && (child.Name === animName || child.Name === `S${slot}`)) {
					if (child.AnimationId.size() > 0) return child;
				}
			}
			return undefined;
		};

		const fighterAnim = findAnimationInstance(attacker.model);
		if (fighterAnim === undefined) return undefined;

		const humanoid = attacker.humanoid;
		const animator = humanoid?.FindFirstChildOfClass("Animator");
		if (animator === undefined) return undefined;

		const [ok, loadedTrack] = pcall(() => animator.LoadAnimation(fighterAnim));
		if (!ok || loadedTrack === undefined) return undefined;

		this.battleTracks.add(loadedTrack);
		loadedTrack.Play(0.1, 1, 1);

		// Se o modelo tiver sub-modelo "Stand" com Animator e Animation correspondente, toca sincronizado
		if (attacker.standModel !== undefined) {
			const standHumanoid = attacker.standModel.FindFirstChildOfClass("Humanoid");
			const standAnimator = standHumanoid?.FindFirstChildOfClass("Animator");
			const standAnim = findAnimationInstance(attacker.standModel) ?? fighterAnim;
			if (standAnimator !== undefined) {
				pcall(() => {
					const standTrack = standAnimator.LoadAnimation(standAnim);
					this.battleTracks.add(standTrack);
					standTrack.Play(0.1, 1, 1);
				});
			}
		}

		return loadedTrack;
	}

	private bindAnimationMarkers(
		track: AnimationTrack,
		attacker: FighterVisualEntry,
		target: FighterVisualEntry,
		timeline: SkillData,
		attackToken: number,
		slot: SkillSlot,
	): void {
		const totalHits = timeline.hits.size();
		for (const index of $range(1, totalHits)) {
			const markerName = `Hit${index}`;
			this.battleConnections.add(track.GetMarkerReachedSignal(markerName).Connect(() => {
				if (this.currentAttackToken !== attackToken || this.battleEnded) return;
				if (this.hitQueue.isHitConsumed(index) || this.followUpCancelledForCurrentAttack) return;
				if (!target.dead) {
					this.pulseStandStrike(attacker, PLACEHOLDER_STAND_STRIKE_STUDS +
						(attacker.fighterId.lower() === "jotaro" && slot === 2 ? PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS : 0));
				}
				this.spawnBattle(() => {
					this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken, slot);
				});
			}));

			// Fallback se o marker não disparar na AnimationTrack: usa o tempo de SkillData + HIT_RESULT_WAIT_SECONDS
			const scheduledHit = timeline.hits[index - 1];
			this.delayBattle(scheduledHit.time + HIT_RESULT_WAIT_SECONDS, () => {
				if (this.currentAttackToken !== attackToken || this.battleEnded) return;
				if (!this.hitQueue.isHitConsumed(index)) {
					this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken, slot);
				}
			});
		}
	}

	private runPlaceholderAttackSequence(
		attacker: FighterVisualEntry,
		target: FighterVisualEntry,
		timeline: SkillData,
		attackToken: number,
		slot: SkillSlot,
	): void {
		this.standMotion.runPlaceholderAttackSequence(attacker, target, timeline, attackToken, slot, (index) => {
			this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken, slot);
		});
	}

	// Delegadores preservados: os QAs Luau chamam pulseStandStrike/restoreStandBase na instância.
	private positionStandForAttack(attacker: FighterVisualEntry, duration: number): void {
		this.standMotion.positionStandForAttack(attacker, duration);
	}

	private pulseStandStrike(attacker: FighterVisualEntry, advanceStuds = PLACEHOLDER_STAND_STRIKE_STUDS): void {
		this.standMotion.pulseStandStrike(attacker, advanceStuds);
	}

	private restoreStandBase(entry: FighterVisualEntry, duration = 0): void {
		this.standMotion.restoreStandBase(entry, duration);
	}

	private waitForAndConsumeHitIndex(
		hitIndex: number,
		attacker: FighterVisualEntry,
		defaultTarget: FighterVisualEntry,
		timeline: SkillData,
		attackToken: number,
		slot: SkillSlot,
	): void {
		const isLastHit = this.hitQueue.waitForAndConsumeHitIndex(
			hitIndex,
			timeline.hits.size(),
			attackToken,
			() => defaultTarget.dead,
			(results) => {
				for (const result of results) {
					this.presentHitResult(result, defaultTarget, attacker, timeline, slot);
					if (result.followUpCancelled) {
						this.followUpCancelledForCurrentAttack = true;
					}
				}
				this.attackFinalizer.flushReadyPendingDeaths();
			},
		);
		if (isLastHit) {
			if (this.activeAttack?.token === attackToken) {
				this.activeAttack = undefined;
			}
			this.attackFinalizer.finalizeAttack(attacker, timeline);
		}
	}

	private presentHitResult(
		result: HitResolvedPayload,
		fallbackTarget: FighterVisualEntry,
		attacker?: FighterVisualEntry,
		timeline?: SkillData,
		slot?: SkillSlot,
	): void {
		const target = this.fightersByTargetId.get(result.targetId) ?? fallbackTarget;

		if (!result.hit) {
			// Miss / Dodge: movimento lateral de esquiva + "DODGE" no BillboardGui, sem número e sem reduzir HP
			this.damagePool.showDodge(target.attachments.Cabeca);
			this.playDodgeReaction(target);
			return;
		}

		// Hit conectou: atualiza HP visual com base no dano enviado pelo servidor
		target.hp = math.max(target.hp - result.damage, 0);
		if (target.humanoid !== undefined) {
			target.humanoid.Health = math.max(target.hp, 1);
		}
		this.notifyHpVisualChanged(target.targetId, target.hp, target.hpMax);

		this.damagePool.showHitDamage(target.attachments.Peito, result.damage, result.crit);
		if (attacker !== undefined && timeline !== undefined && slot !== undefined) {
			this.emitHitVfx(attacker, target, timeline, slot, result.crit);
		}
		if (!target.dead && !this.attackFinalizer.hasPendingDeath(target.targetId)) {
			this.playHitReaction(target, result.crit);
		}
	}

	private playHitReaction(target: FighterVisualEntry, isCrit: boolean): void {
		this.standMotion.playHitReaction(target, isCrit);
	}

	private playDodgeReaction(target: FighterVisualEntry): void {
		this.standMotion.playDodgeReaction(target);
	}

	private onEffectApplied(payload: EffectAppliedPayload): void {
		if (this.battleEnded) return;
		const target = this.fightersByTargetId.get(payload.targetId);
		if (target === undefined) return;

		let emitter = target.effectEmitters.get(payload.effect);
		if (emitter === undefined) {
			emitter = new Instance("ParticleEmitter");
			emitter.Name = `StatusVFX_${payload.effect}`;
			emitter.Rate = 14;
			emitter.Lifetime = new NumberRange(0.35, 0.65);
			emitter.Speed = new NumberRange(1.5, 3.0);
			emitter.SpreadAngle = new Vector2(180, 180);
			emitter.Size = new NumberSequence(0.25, 0);

			if (payload.effect === "Burn") {
				emitter.Color = new ColorSequence(COMBAT_FEEDBACK_COLORS.burnTick);
			} else if (payload.effect === "Bleed") {
				emitter.Color = new ColorSequence(COMBAT_FEEDBACK_COLORS.bleedTick);
			} else {
				emitter.Color = new ColorSequence(COMBAT_FEEDBACK_COLORS.rootVfx);
			}

			emitter.Parent = target.attachments.Peito;
			target.effectEmitters.set(payload.effect, emitter);
		}
		emitter.Enabled = true;
	}

	private onEffectTick(payload: EffectTickPayload): void {
		if (this.battleEnded) return;
		const target = this.fightersByTargetId.get(payload.targetId);
		if (target === undefined) return;

		// Nunca exibir "0" em tick de DoT
		const displayTickDamage = math.max(payload.damage, MIN_DAMAGE);
		target.hp = math.max(target.hp - displayTickDamage, 0);
		if (target.humanoid !== undefined) {
			target.humanoid.Health = math.max(target.hp, 1);
		}
		this.notifyHpVisualChanged(target.targetId, target.hp, target.hpMax);

		this.damagePool.showDotTick(target.attachments.Cabeca, displayTickDamage, payload.effect);
	}

	private onEffectExpired(payload: EffectExpiredPayload): void {
		const target = this.fightersByTargetId.get(payload.targetId);
		if (target === undefined) return;
		const emitter = target.effectEmitters.get(payload.effect);
		if (emitter !== undefined) {
			emitter.Enabled = false;
			emitter.Destroy();
			target.effectEmitters.delete(payload.effect);
		}
	}

	private onFighterDied(payload: FighterDiedPayload): void {
		this.attackFinalizer.handleFighterDied(payload);
	}

	private flushPendingDeaths(): void {
		this.attackFinalizer.flushPendingDeaths();
	}

	private onSwitchPerformed(payload: SwitchPerformedPayload): void {
		this.attackFinalizer.handleSwitchPerformed(payload);
	}

	private tweenModelTo(model: Model, targetCFrame: CFrame, duration: number): Tween | undefined {
		return this.standMotion.tweenModelTo(model, targetCFrame, duration);
	}

	private createBattleTween<T extends Instance>(object: T, info: TweenInfo, goal: Partial<ExtractMembers<T, Tweenable>>): Tween {
		const tween = TweenService.Create(object, info, goal);
		this.battleTweens.add(tween);
		const connection = tween.Completed.Connect(() => {
			connection.Disconnect();
			this.battleConnections.delete(connection);
			this.battleTweens.delete(tween);
		});
		this.battleConnections.add(connection);
		return tween;
	}

	private trackBattleConnection(connection: RBXScriptConnection): void {
		this.battleConnections.add(connection);
	}

	private untrackBattleConnection(connection: RBXScriptConnection): void {
		this.battleConnections.delete(connection);
	}

	private delayBattle(seconds: number, callback: () => void): thread {
		const pending = task.delay(seconds, () => {
			this.battleTasks.delete(pending);
			callback();
		});
		this.battleTasks.add(pending);
		return pending;
	}

	private cancelBattleTask(pending: thread): void {
		if (!this.battleTasks.has(pending)) return;
		this.battleTasks.delete(pending);
		pcall(() => task.cancel(pending));
	}

	private spawnBattle(callback: () => void): void {
		// defer registers the thread before it can yield waiting for a hit.
		const pending = task.defer(() => {
			callback();
			this.battleTasks.delete(pending);
		});
		this.battleTasks.add(pending);
	}

	/** Called only by the client teardown, or before replacing a stage on BattleStarted. */
	public cleanupStage(expectedVfxGeneration?: number, keepIntro = false): number {
		if (!this.vfxBridge.ownsGeneration(expectedVfxGeneration)) {
			return this.vfxBridge.getBattleGeneration();
		}
		const generation = this.vfxBridge.advanceGeneration();
		this.battleVfxGeneration = generation;
		if (!keepIntro) this.introduction.reset();
		this.battleEnded = true;
		this.currentAttackToken += 1;
		this.activeAttack = undefined;
		this.deferredAttack = undefined;
		this.hitQueue.clear();
		for (const connection of this.battleConnections) battleCleanupStep("combat connection", () => connection.Disconnect());
		this.battleConnections.clear();
		for (const pending of this.battleTasks) battleCleanupStep("combat task", () => task.cancel(pending));
		this.battleTasks.clear();
		for (const tween of this.battleTweens) battleCleanupStep("combat tween", () => tween.Cancel());
		this.battleTweens.clear();
		for (const track of this.battleTracks) {
			battleCleanupStep("animation stop", () => track.Stop(0));
			battleCleanupStep("animation destroy", () => track.Destroy());
		}
		this.battleTracks.clear();
		for (const [, entry] of this.fightersByTargetId) {
			battleCleanupStep("stand base", () => this.restoreStandBase(entry));
			battleCleanupStep("fighter base", () => entry.model.PivotTo(entry.homeCFrame));
		}
		this.damagePool.clear();
		battleCleanupStep("camera restore", () => this.cameraController.restore());
		battleCleanupStep("stage destroy", () => this.stageFolder?.Destroy());
		this.stageFolder = undefined;
		this.fightersByTargetId.clear();
		this.arenaAnchors.clear();
		this.activeArenaInstanceId = undefined;
		this.physicalSideIds = ["", ""];
		this.attackFinalizer.clear();
		this.vfxBridge.clearWorkingCopies();
		this.vfxBridge.clearActiveVfx();
		battleCleanupStep("vfx deload", () => this.deloadBattleVfx(generation));
		return generation;
	}

	private getGlobalVfxRoot(): Instance | undefined {
		return this.vfxBridge.resolveGlobalVfxRoot();
	}

	private preloadBattleVfx(payload: BattleStartedPayload, generation: number): void {
		this.vfxBridge.preloadBattleVfx(payload, generation, this.fightersByTargetId);
	}

	private emitHitVfx(
		attacker: FighterVisualEntry,
		target: FighterVisualEntry,
		timeline: SkillData,
		slot: SkillSlot,
		isCrit: boolean,
	): void {
		this.vfxBridge.emitHitVfx(attacker, target, timeline, slot, isCrit);
	}

	private emitKoVfx(deadFighter: FighterVisualEntry): void {
		this.vfxBridge.emitKoVfx(deadFighter);
	}
}
