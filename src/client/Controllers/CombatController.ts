import { ReplicatedStorage, TweenService, Workspace } from "@rbxts/services";
import { MIN_DAMAGE } from "../../shared/Config";
import {
	ASSETS_FOLDER_NAME,
	BENCH_FIGHTER_TRANSPARENCY,
	COMBAT_ACTIVE_SEPARATION_STUDS,
	COMBAT_BENCH_LATERAL_SPACING_STUDS,
	COMBAT_BENCH_RETREAT_STUDS,
	COMBAT_FEEDBACK_COLORS,
	COMBAT_STAGE_ORIGIN,
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
import { BattleRemotes } from "./BattleRemotes";
import { CombatAttackFinalizer, type PendingDeathRecord } from "./CombatAttackFinalizer";
import { CombatDamagePool, type BillboardPoolItem } from "./CombatDamagePool";
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
	readonly benchIndex: number;
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
	private currentAttackToken = 0;
	private activePendingHits = 0;
	private activeAttack: ActiveAttackState | undefined;
	private followUpCancelledForCurrentAttack = false;
	private battleEnded = false;
	private battleVfxGeneration = 0;
	private started = false;

	public constructor(
		private readonly vfxController?: VFXController,
		private readonly assetsRoot: Instance = ReplicatedStorage,
	) {
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
			isFollowUpCancelled: () => this.followUpCancelledForCurrentAttack,
			hasPendingHits: () => this.hitQueue.hasPendingHits(),
			hasUnconsumedHitForTarget: (targetId) => this.hitQueue.hasUnconsumedHitForTarget(targetId),
			getFighter: (targetId) => this.fightersByTargetId.get(targetId),
			restoreStandBase: (entry, duration) => this.restoreStandBase(entry, duration),
			tweenModelTo: (model, targetCFrame, duration) => this.tweenModelTo(model, targetCFrame, duration),
			delayBattle: (seconds, callback) => this.delayBattle(seconds, callback),
			computeActiveSlotCFrame: (sideIndex) => this.computeActiveSlotCFrame(sideIndex),
			computeBenchSlotCFrame: (sideIndex, benchSlot) => this.computeBenchSlotCFrame(sideIndex, benchSlot),
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
		BattleRemotes.stateChanged.OnClientEvent.Connect(() => {});
		BattleRemotes.atbSync.OnClientEvent.Connect(() => {});
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
		const generation = this.cleanupStage();
		if (generation !== this.battleVfxGeneration) return;
		this.battleEnded = false;
		this.sideIds = payload.sides;
		this.currentAttackToken += 1;
		this.activeAttack = undefined;
		this.followUpCancelledForCurrentAttack = false;
		this.hitQueue.clear();
		this.attackFinalizer.clear();

		const folder = new Instance("Folder");
		folder.Name = WORKSPACE_BATTLE_FOLDER_NAME;
		this.stageFolder = folder;

		const benchCounterBySide: [number, number] = [0, 0];

		for (const snapshot of payload.fighters) {
			const sideIndex: 0 | 1 = snapshot.sideId === payload.sides[0] ? 0 : 1;
			const benchSlot = benchCounterBySide[sideIndex];
			benchCounterBySide[sideIndex] += 1;

			const clonedModel = this.cloneFighterAsset(snapshot.fighterId);
			if (!this.isCurrentBattle(generation)) {
				battleCleanupStep("stale fighter clone", () => clonedModel.Destroy());
				return;
			}
			clonedModel.Name = `${snapshot.targetId}_${snapshot.fighterId}`;
			clonedModel.Parent = folder;

			const rootPart = this.resolveRootPart(clonedModel);
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

			const homeCFrame = snapshot.active
				? this.computeActiveSlotCFrame(sideIndex)
				: this.computeBenchSlotCFrame(sideIndex, benchSlot);

			this.prepareModelPhysics(clonedModel, rootPart);
			clonedModel.PivotTo(homeCFrame);

			const entry: FighterVisualEntry = {
				targetId: snapshot.targetId,
				fighterId: snapshot.fighterId,
				sideId: snapshot.sideId,
				sideIndex,
				benchIndex: benchSlot,
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

		this.preloadBattleVfx(payload, generation);
		if (this.isCurrentBattle(generation)) folder.Parent = Workspace;
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

	private computeActiveSlotCFrame(sideIndex: 0 | 1): CFrame {
		const halfSep = COMBAT_ACTIVE_SEPARATION_STUDS * 0.5;
		const xOffset = sideIndex === 0 ? -halfSep : halfSep;
		const position = COMBAT_STAGE_ORIGIN.add(new Vector3(xOffset, 0, 0));
		const lookTarget = COMBAT_STAGE_ORIGIN.add(new Vector3(-xOffset, 0, 0));
		return CFrame.lookAt(position, lookTarget);
	}

	private computeBenchSlotCFrame(sideIndex: 0 | 1, benchSlot: number): CFrame {
		const halfSep = COMBAT_ACTIVE_SEPARATION_STUDS * 0.5 + COMBAT_BENCH_RETREAT_STUDS;
		const xOffset = sideIndex === 0 ? -halfSep : halfSep;
		const zOffset = (benchSlot - 1) * COMBAT_BENCH_LATERAL_SPACING_STUDS;
		const position = COMBAT_STAGE_ORIGIN.add(new Vector3(xOffset, 0, zOffset));
		const lookTarget = COMBAT_STAGE_ORIGIN.add(new Vector3(0, 0, zOffset));
		return CFrame.lookAt(position, lookTarget);
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
		this.activeAttack = { token: attackToken, attacker, target, timeline, slot: payload.slot };
		this.hitQueue.beginAttack(totalHits);
		this.positionStandForAttack(attacker, math.max(timeline.hits[0]?.time ?? 0.1, 0.05) * 0.8);

		const track = this.tryPlaySlotAnimation(attacker, payload.slot, timeline);
		if (track !== undefined) {
			this.bindAnimationMarkers(track, attacker, target, timeline, attackToken, payload.slot);
		} else {
			this.runPlaceholderAttackSequence(attacker, target, timeline, attackToken, payload.slot);
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

	private tweenModelTo(model: Model, targetCFrame: CFrame, duration: number): void {
		this.standMotion.tweenModelTo(model, targetCFrame, duration);
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

	private delayBattle(seconds: number, callback: () => void): void {
		const pending = task.delay(seconds, () => {
			callback();
			this.battleTasks.delete(pending);
		});
		this.battleTasks.add(pending);
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
	public cleanupStage(expectedVfxGeneration?: number): number {
		if (!this.vfxBridge.ownsGeneration(expectedVfxGeneration)) {
			return this.vfxBridge.getBattleGeneration();
		}
		const generation = this.vfxBridge.advanceGeneration();
		this.battleVfxGeneration = generation;
		this.battleEnded = true;
		this.currentAttackToken += 1;
		this.activeAttack = undefined;
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
		battleCleanupStep("stage destroy", () => this.stageFolder?.Destroy());
		this.stageFolder = undefined;
		this.fightersByTargetId.clear();
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
