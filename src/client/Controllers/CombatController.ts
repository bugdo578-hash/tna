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
	DAMAGE_BILLBOARD_POOL_SIZE,
	DAMAGE_BILLBOARD_SIZE_CRIT,
	DAMAGE_BILLBOARD_SIZE_DOT,
	DAMAGE_BILLBOARD_SIZE_NORMAL,
	DAMAGE_POPUP_DURATION_SECONDS,
	DAMAGE_POPUP_RISE_STUDS,
	FIGHTER_ASSETS_FOLDER_NAME,
	HIT_RESULT_WAIT_SECONDS,
	HIT_WAIT_POLL_INTERVAL_SECONDS,
	PLACEHOLDER_ADVANCE_FRACTION,
	PLACEHOLDER_DODGE_OFFSET_STUDS,
	PLACEHOLDER_DODGE_TWEEN_SECONDS,
	PLACEHOLDER_HIT_KNOCKBACK_STUDS,
	PLACEHOLDER_HIT_REACT_TWEEN_SECONDS,
	PLACEHOLDER_KO_TWEEN_SECONDS,
	PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS,
	PLACEHOLDER_ORA_ADVANCE_FRACTION,
	PLACEHOLDER_STRIKE_TWEEN_SECONDS,
	PLACEHOLDER_STAND_STRIKE_STUDS,
	STAND_ATTACK_FRONT_STUDS,
	PLACEHOLDER_SWITCH_TWEEN_SECONDS,
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
	readonly standMotion: { readonly joint: Motor6D; readonly baseC1: CFrame; generation: number; tween?: Tween } | undefined;
	readonly attachments: RigAttachmentMap;
	readonly originalTransparency: Map<BasePart, number>;
	hp: number;
	hpMax: number;
	active: boolean;
	dead: boolean;
	homeCFrame: CFrame;
	readonly effectEmitters: Map<StatusEffect, ParticleEmitter>;
}

interface BillboardPoolItem {
	readonly billboard: BillboardGui;
	readonly label: TextLabel;
	inUse: boolean;
}

interface PendingDeathRecord {
	readonly payload: FighterDiedPayload;
}

export class CombatController {
	private readonly fightersByTargetId = new Map<string, FighterVisualEntry>();
	private readonly hitResultsByIndex = new Map<number, HitResolvedPayload[]>();
	private readonly consumedHitIndices = new Set<number>();
	private readonly pendingSwitches: SwitchPerformedPayload[] = [];
	private readonly pendingDeaths = new Map<string, PendingDeathRecord>();
	private readonly billboardPool: BillboardPoolItem[] = [];
	private readonly hpVisualListeners = new Set<(targetId: string, hp: number, hpMax: number) => void>();
	private readonly deathVisualListeners = new Set<(payload: FighterDiedPayload) => void>();
	private readonly battleTweens = new Set<Tween>();
	private readonly battleConnections = new Set<RBXScriptConnection>();
	private readonly battleTasks = new Set<thread>();
	private readonly battleTracks = new Set<AnimationTrack>();

	private stageFolder: Folder | undefined;
	private poolContainer: Folder | undefined;
	private sideIds: readonly [string, string] = ["", ""];
	private currentAttackToken = 0;
	private activePendingHits = 0;
	private followUpCancelledForCurrentAttack = false;
	private battleEnded = false;
	private started = false;

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
		const container = new Instance("Folder");
		container.Name = "CombatBillboardPool";
		container.Parent = Workspace;
		this.poolContainer = container;

		for (const index of $range(1, DAMAGE_BILLBOARD_POOL_SIZE)) {
			const billboard = new Instance("BillboardGui");
			billboard.Name = `DamagePopup_${index}`;
			billboard.Size = DAMAGE_BILLBOARD_SIZE_NORMAL;
			billboard.AlwaysOnTop = true;
			billboard.Enabled = false;
			billboard.Parent = container;

			const label = new Instance("TextLabel");
			label.Name = "Text";
			label.Size = UDim2.fromScale(1, 1);
			label.BackgroundTransparency = 1;
			label.Font = Enum.Font.GothamBlack;
			label.TextScaled = true;
			label.TextStrokeTransparency = 0.15;
			label.TextColor3 = COMBAT_FEEDBACK_COLORS.normalHit;
			label.Text = "";
			label.Parent = billboard;

			this.billboardPool.push({ billboard, label, inUse: false });
		}
	}

	private acquireBillboard(): BillboardPoolItem {
		for (const item of this.billboardPool) {
			if (!item.inUse) {
				item.inUse = true;
				return item;
			}
		}
		const fallback = this.billboardPool[0];
		fallback.inUse = true;
		return fallback;
	}

	private showFloatingText(
		adornee: Attachment | BasePart,
		text: string,
		color: Color3,
		size: UDim2,
		duration = DAMAGE_POPUP_DURATION_SECONDS,
	): void {
		const item = this.acquireBillboard();
		const { billboard, label } = item;
		billboard.Adornee = adornee;
		billboard.Size = size;
		billboard.StudsOffset = new Vector3(0, 1.2, 0);
		billboard.Enabled = true;

		label.Text = text;
		label.TextColor3 = color;
		label.TextTransparency = 0;
		label.TextStrokeTransparency = 0.15;

		const moveTween = this.createBattleTween(
			billboard,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ StudsOffset: new Vector3(0, 1.2 + DAMAGE_POPUP_RISE_STUDS, 0) },
		);
		const fadeTween = this.createBattleTween(
			label,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
			{ TextTransparency: 1, TextStrokeTransparency: 1 },
		);
		moveTween.Play();
		fadeTween.Play();

		this.delayBattle(duration, () => {
			billboard.Enabled = false;
			billboard.Adornee = undefined;
			item.inUse = false;
		});
	}

	private onBattleStarted(payload: BattleStartedPayload): void {
		this.cleanupStage();
		this.battleEnded = false;
		this.sideIds = payload.sides;
		this.currentAttackToken += 1;
		this.activePendingHits = 0;
		this.followUpCancelledForCurrentAttack = false;
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.pendingDeaths.clear();

		const folder = new Instance("Folder");
		folder.Name = WORKSPACE_BATTLE_FOLDER_NAME;
		folder.Parent = Workspace;
		this.stageFolder = folder;

		const benchCounterBySide: [number, number] = [0, 0];

		for (const snapshot of payload.fighters) {
			const sideIndex: 0 | 1 = snapshot.sideId === payload.sides[0] ? 0 : 1;
			const benchSlot = benchCounterBySide[sideIndex];
			benchCounterBySide[sideIndex] += 1;

			const clonedModel = this.cloneFighterAsset(snapshot.fighterId);
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
	}

	private cloneFighterAsset(fighterId: string): Model {
		const assetsFolder = ReplicatedStorage.FindFirstChild(ASSETS_FOLDER_NAME);
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
		if (this.battleEnded) return;
		let bucket = this.hitResultsByIndex.get(payload.hitIndex);
		if (bucket === undefined) {
			bucket = [];
			this.hitResultsByIndex.set(payload.hitIndex, bucket);
		}
		bucket.push(payload);
	}

	private onAttackStarted(payload: AttackStartedPayload): void {
		if (this.battleEnded) return;
		const attacker = this.fightersByTargetId.get(payload.attackerId);
		const target = this.fightersByTargetId.get(payload.targetId);
		if (attacker === undefined || target === undefined) return;

		this.currentAttackToken += 1;
		const attackToken = this.currentAttackToken;
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.followUpCancelledForCurrentAttack = false;

		const timeline = this.resolveSkillTimeline(attacker.fighterId, payload.slot);
		const totalHits = timeline.hits.size();
		this.activePendingHits = totalHits;
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
				if (this.consumedHitIndices.has(index) || this.followUpCancelledForCurrentAttack) return;
				this.pulseStandStrike(attacker, PLACEHOLDER_STAND_STRIKE_STUDS +
					(attacker.fighterId.lower() === "jotaro" && slot === 2 ? PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS : 0));
				this.spawnBattle(() => {
					this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken);
				});
			}));

			// Fallback se o marker não disparar na AnimationTrack: usa o tempo de SkillData + HIT_RESULT_WAIT_SECONDS
			const scheduledHit = timeline.hits[index - 1];
			this.delayBattle(scheduledHit.time + HIT_RESULT_WAIT_SECONDS, () => {
				if (this.currentAttackToken !== attackToken || this.battleEnded) return;
				if (!this.consumedHitIndices.has(index)) {
					this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken);
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
		const startCFrame = attacker.homeCFrame;
		const targetPos = target.homeCFrame.Position;
		const advanceFraction = attacker.fighterId.lower() === "jotaro" && slot === 2
			? PLACEHOLDER_ORA_ADVANCE_FRACTION
			: PLACEHOLDER_ADVANCE_FRACTION;
		const approachPos = startCFrame.Position.Lerp(targetPos, advanceFraction);
		const strikeBaseCFrame = CFrame.lookAt(approachPos, targetPos);

		const firstHitTime = timeline.hits.size() > 0 ? math.max(timeline.hits[0].time, 0.05) : 0.1;
		this.tweenModelTo(attacker.model, strikeBaseCFrame, firstHitTime * 0.8);

		const totalHits = timeline.hits.size();
		for (const index of $range(1, totalHits)) {
			const hitSpec = timeline.hits[index - 1];
			this.delayBattle(hitSpec.time, () => {
				if (this.currentAttackToken !== attackToken || this.battleEnded) return;
				if (this.followUpCancelledForCurrentAttack && index > 1) return;

				// Pequeno avanço/soco a cada hit do slot (inclusive multi-hit como Barragem_estelar)
				const punchOffset = strikeBaseCFrame.LookVector.mul(index % 2 === 1 ? 0.55 : 0.35);
				const punchCFrame = strikeBaseCFrame.add(punchOffset);
				this.tweenModelTo(attacker.model, punchCFrame, PLACEHOLDER_STRIKE_TWEEN_SECONDS);

				// Se tiver Stand (ex.: Star Platinum), projeta o Stand levemente à frente no golpe
				const extraAdvance = attacker.fighterId.lower() === "jotaro" && slot === 2
					? PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS
					: 0;
				this.pulseStandStrike(attacker, PLACEHOLDER_STAND_STRIKE_STUDS + extraAdvance);

				this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken);
			});
		}
	}

	/** Resolve a pose no eixo do dono, removendo o desvio lateral da pose de descanso. */
	private standAttackC1(attacker: FighterVisualEntry, advanceStuds = 0): CFrame | undefined {
		const motion = attacker.standMotion;
		const part0 = motion?.joint.Part0;
		if (motion === undefined || part0 === undefined) return undefined;
		const jointFrame = attacker.rootPart.CFrame.ToObjectSpace(part0.CFrame).mul(motion.joint.C0);
		const restFrame = jointFrame.mul(motion.baseC1.Inverse());
		const frontFrame = new CFrame(0, restFrame.Y, -STAND_ATTACK_FRONT_STUDS - advanceStuds);
		return frontFrame.Inverse().mul(jointFrame);
	}

	private positionStandForAttack(attacker: FighterVisualEntry, duration: number): void {
		const motion = attacker.standMotion;
		const frontC1 = this.standAttackC1(attacker);
		if (motion === undefined || frontC1 === undefined) return;
		motion.generation += 1;
		motion.tween?.Cancel();
		motion.tween = this.createBattleTween(motion.joint,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { C1: frontC1 });
		motion.tween.Play();
	}

	private pulseStandStrike(attacker: FighterVisualEntry, advanceStuds = PLACEHOLDER_STAND_STRIKE_STUDS): void {
		const motion = attacker.standMotion;
		if (attacker.standModel === undefined || motion === undefined) return;
		const standJoint = motion.joint;
		if (standJoint.Parent !== undefined) {
			motion.generation += 1;
			const generation = motion.generation;
			motion.tween?.Cancel();
			const forwardC1 = this.standAttackC1(attacker, advanceStuds);
			const frontC1 = this.standAttackC1(attacker);
			if (forwardC1 === undefined || frontC1 === undefined) return;
			const punchIn = this.createBattleTween(
				standJoint,
				new TweenInfo(PLACEHOLDER_STRIKE_TWEEN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
				{ C1: forwardC1 },
			);
			motion.tween = punchIn;
			punchIn.Play();
			this.delayBattle(PLACEHOLDER_STRIKE_TWEEN_SECONDS, () => {
				if (standJoint.Parent && motion.generation === generation) {
					motion.tween = this.createBattleTween(
						standJoint,
						new TweenInfo(PLACEHOLDER_STRIKE_TWEEN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
						{ C1: frontC1 },
					);
					motion.tween.Play();
				}
			});
		}
	}

	private restoreStandBase(entry: FighterVisualEntry, duration = 0): void {
		const motion = entry.standMotion;
		if (motion === undefined) return;
		// Invalida também recuos atrasados: Cancel sozinho preserva o deslocamento parcial.
		motion.generation += 1;
		motion.tween?.Cancel();
		motion.tween = undefined;
		if (duration > 0 && motion.joint.Parent !== undefined) {
			motion.tween = this.createBattleTween(motion.joint,
				new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { C1: motion.baseC1 });
			motion.tween.Play();
			return;
		}
		motion.joint.C1 = motion.baseC1;
	}

	private waitForAndConsumeHitIndex(
		hitIndex: number,
		attacker: FighterVisualEntry,
		defaultTarget: FighterVisualEntry,
		timeline: SkillData,
		attackToken: number,
	): void {
		if (this.consumedHitIndices.has(hitIndex)) return;

		const deadline = os.clock() + HIT_RESULT_WAIT_SECONDS;
		while (this.hitResultsByIndex.get(hitIndex) === undefined && !defaultTarget.dead && os.clock() < deadline) {
			if (this.currentAttackToken !== attackToken || this.battleEnded) return;
			task.wait(HIT_WAIT_POLL_INTERVAL_SECONDS);
		}

		if (this.consumedHitIndices.has(hitIndex) || this.currentAttackToken !== attackToken || this.battleEnded) {
			return;
		}
		this.consumedHitIndices.add(hitIndex);

		const results = this.hitResultsByIndex.get(hitIndex) ?? [];
		for (const result of results) {
			this.presentHitResult(result, defaultTarget);
			if (result.followUpCancelled) {
				this.followUpCancelledForCurrentAttack = true;
			}
		}

		this.activePendingHits = math.max(this.activePendingHits - 1, 0);
		const isLastHit = hitIndex >= timeline.hits.size() || this.followUpCancelledForCurrentAttack;
		if (isLastHit) {
			this.activePendingHits = 0;
			const returnDuration = this.followUpCancelledForCurrentAttack
				? timeline.dodgeReturnTime
				: timeline.returnTime;
			this.restoreStandBase(attacker, math.max(returnDuration, 0.08));
			this.tweenModelTo(attacker.model, attacker.homeCFrame, math.max(returnDuration, 0.08));
			this.flushPendingDeaths();
			for (const pending of this.pendingSwitches) this.onSwitchPerformed(pending);
			this.pendingSwitches.clear();
		}
	}

	private presentHitResult(result: HitResolvedPayload, fallbackTarget: FighterVisualEntry): void {
		const target = this.fightersByTargetId.get(result.targetId) ?? fallbackTarget;

		if (!result.hit) {
			// Miss / Dodge: movimento lateral de esquiva + "DODGE" no BillboardGui, sem número e sem reduzir HP
			this.showFloatingText(
				target.attachments.Cabeca,
				"DODGE",
				COMBAT_FEEDBACK_COLORS.dodgeText,
				DAMAGE_BILLBOARD_SIZE_NORMAL,
			);
			this.playDodgeReaction(target);
			return;
		}

		// Hit conectou: atualiza HP visual com base no dano enviado pelo servidor
		target.hp = math.max(target.hp - result.damage, 0);
		if (target.humanoid !== undefined) {
			target.humanoid.Health = math.max(target.hp, 1);
		}
		this.notifyHpVisualChanged(target.targetId, target.hp, target.hpMax);

		const displayDamage = math.max(result.damage, MIN_DAMAGE);
		const text = result.crit ? `${displayDamage}!` : `${displayDamage}`;
		const color = result.crit ? COMBAT_FEEDBACK_COLORS.critHit : COMBAT_FEEDBACK_COLORS.normalHit;
		const size = result.crit ? DAMAGE_BILLBOARD_SIZE_CRIT : DAMAGE_BILLBOARD_SIZE_NORMAL;

		this.showFloatingText(target.attachments.Peito, text, color, size);
		if (!target.dead) this.playHitReaction(target, result.crit);
	}

	private playHitReaction(target: FighterVisualEntry, isCrit: boolean): void {
		const baseCF = target.homeCFrame;
		const knockbackDist = isCrit ? PLACEHOLDER_HIT_KNOCKBACK_STUDS * 1.4 : PLACEHOLDER_HIT_KNOCKBACK_STUDS;
		const knockedCF = baseCF.add(baseCF.LookVector.mul(-knockbackDist));

		this.tweenModelTo(target.model, knockedCF, PLACEHOLDER_HIT_REACT_TWEEN_SECONDS);
		this.delayBattle(PLACEHOLDER_HIT_REACT_TWEEN_SECONDS, () => {
			if (!target.dead && target.model.Parent !== undefined) {
				this.tweenModelTo(target.model, target.homeCFrame, PLACEHOLDER_HIT_REACT_TWEEN_SECONDS);
			}
		});
	}

	private playDodgeReaction(target: FighterVisualEntry): void {
		const baseCF = target.homeCFrame;
		const dodgeCF = baseCF.add(baseCF.RightVector.mul(PLACEHOLDER_DODGE_OFFSET_STUDS));

		this.tweenModelTo(target.model, dodgeCF, PLACEHOLDER_DODGE_TWEEN_SECONDS);
		this.delayBattle(PLACEHOLDER_DODGE_TWEEN_SECONDS, () => {
			if (!target.dead && target.model.Parent !== undefined) {
				this.tweenModelTo(target.model, target.homeCFrame, PLACEHOLDER_DODGE_TWEEN_SECONDS);
			}
		});
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

		const color =
			payload.effect === "Burn" ? COMBAT_FEEDBACK_COLORS.burnTick : COMBAT_FEEDBACK_COLORS.bleedTick;
		this.showFloatingText(target.attachments.Cabeca, `${displayTickDamage}`, color, DAMAGE_BILLBOARD_SIZE_DOT);
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
		if (this.battleEnded) return;
		this.pendingDeaths.set(payload.fighterId, { payload });
		// Provis?rio: KO imediato; a troca chega separadamente ao fim de ATTACK.
		this.flushPendingDeaths();
	}

	private flushPendingDeaths(): void {
		for (const [deadTargetId, record] of this.pendingDeaths) {
			const deadFighter = this.fightersByTargetId.get(deadTargetId);
			if (deadFighter !== undefined && !deadFighter.dead) {
				this.restoreStandBase(deadFighter);
				deadFighter.dead = true;
				deadFighter.active = false;
				deadFighter.hp = 0;
				this.notifyHpVisualChanged(deadTargetId, 0, deadFighter.hpMax);

				// Limpa VFX de status ativos no lutador derrotado
				for (const [, emitter] of deadFighter.effectEmitters) {
					emitter.Enabled = false;
					emitter.Destroy();
				}
				deadFighter.effectEmitters.clear();

				// Animação placeholder de KO (tomba para trás)
				const koCFrame = deadFighter.homeCFrame
					.add(new Vector3(0, -0.6, 0))
					.mul(CFrame.Angles(math.rad(-80), 0, 0));
				this.tweenModelTo(deadFighter.model, koCFrame, PLACEHOLDER_KO_TWEEN_SECONDS);
				this.delayBattle(PLACEHOLDER_KO_TWEEN_SECONDS, () => {
					if (deadFighter.model.Parent !== undefined && record.payload.nextActive !== undefined) {
						deadFighter.homeCFrame = this.computeBenchSlotCFrame(
							deadFighter.sideIndex,
							deadFighter.benchIndex,
						);
						deadFighter.model.PivotTo(deadFighter.homeCFrame);
						this.applyActiveVisualState(deadFighter);
					}
				});
			}

			// Se houve troca automática por morte (nextActive), traz o substituto para o centro
			if (record.payload.nextActive !== undefined) {
				const nextFighter = this.fightersByTargetId.get(record.payload.nextActive);
				if (nextFighter !== undefined && !nextFighter.dead) {
					nextFighter.active = true;
					nextFighter.homeCFrame = this.computeActiveSlotCFrame(nextFighter.sideIndex);
					this.applyActiveVisualState(nextFighter);
					this.tweenModelTo(nextFighter.model, nextFighter.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
				}
			}
			this.notifyDeathVisualFlushed(record.payload);
		}
		this.pendingDeaths.clear();
	}

	private onSwitchPerformed(payload: SwitchPerformedPayload): void {
		if (this.battleEnded) return;
		if (this.activePendingHits > 0) {
			this.pendingSwitches.push(payload);
			return;
		}
		const previous = this.fightersByTargetId.get(payload.previousFighterId);
		const nextActive = this.fightersByTargetId.get(payload.activeFighterId);

		if (previous !== undefined) {
			previous.active = false;
			previous.homeCFrame = this.computeBenchSlotCFrame(previous.sideIndex, previous.benchIndex);
			this.applyActiveVisualState(previous);
			this.tweenModelTo(previous.model, previous.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
		}

		if (nextActive !== undefined) {
			nextActive.active = true;
			nextActive.homeCFrame = this.computeActiveSlotCFrame(nextActive.sideIndex);
			this.applyActiveVisualState(nextActive);
			this.tweenModelTo(nextActive.model, nextActive.homeCFrame, PLACEHOLDER_SWITCH_TWEEN_SECONDS);
		}
	}

	private tweenModelTo(model: Model, targetCFrame: CFrame, duration: number): void {
		const root = model.PrimaryPart;
		if (root === undefined || !model.Parent) return;
		if (duration <= 0.01) {
			model.PivotTo(targetCFrame);
			return;
		}
		const tween = this.createBattleTween(
			root,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ CFrame: targetCFrame },
		);
		tween.Play();
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
	public cleanupStage(): void {
		this.battleEnded = true;
		this.currentAttackToken += 1;
		this.activePendingHits = 0;
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
		for (const item of this.billboardPool) {
			battleCleanupStep("damage popup", () => {
				item.billboard.Enabled = false;
				item.billboard.Adornee = undefined;
				item.inUse = false;
			});
		}
		battleCleanupStep("stage destroy", () => this.stageFolder?.Destroy());
		this.stageFolder = undefined;
		this.pendingSwitches.clear();
		this.fightersByTargetId.clear();
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.pendingDeaths.clear();
	}
}
