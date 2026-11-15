import { ReplicatedStorage, TweenService, Workspace } from "@rbxts/services";
import {
	ASSETS_FOLDER_NAME,
	BATTLE_END_CLEANUP_DELAY_SECONDS,
	BENCH_FIGHTER_TRANSPARENCY,
	COMBAT_ACTIVE_SEPARATION_STUDS,
	COMBAT_BENCH_LATERAL_SPACING_STUDS,
	COMBAT_BENCH_RETREAT_STUDS,
	COMBAT_FEEDBACK_COLORS,
	COMBAT_STAGE_ORIGIN,
	DAMAGE_BILLBOARD_POOL_SIZE,
	DAMAGE_BILLBOARD_SIZE_BANNER,
	DAMAGE_BILLBOARD_SIZE_CRIT,
	DAMAGE_BILLBOARD_SIZE_DOT,
	DAMAGE_BILLBOARD_SIZE_NORMAL,
	DAMAGE_POPUP_DURATION_SECONDS,
	DAMAGE_POPUP_RISE_STUDS,
	FIGHTER_ASSETS_FOLDER_NAME,
	HIT_RESULT_WAIT_SECONDS,
	HIT_WAIT_POLL_INTERVAL_SECONDS,
	MIN_DAMAGE,
	PLACEHOLDER_ADVANCE_FRACTION,
	PLACEHOLDER_DODGE_OFFSET_STUDS,
	PLACEHOLDER_DODGE_TWEEN_SECONDS,
	PLACEHOLDER_HIT_KNOCKBACK_STUDS,
	PLACEHOLDER_HIT_REACT_TWEEN_SECONDS,
	PLACEHOLDER_KO_TWEEN_SECONDS,
	PLACEHOLDER_STRIKE_TWEEN_SECONDS,
	PLACEHOLDER_SWITCH_TWEEN_SECONDS,
	RIG_ATTACHMENT_NAMES,
	STAND_SUBMODEL_NAME,
	WORKSPACE_BATTLE_FOLDER_NAME,
} from "../../shared/Config";
import { FIGHTER_DATA, type RealFighterId } from "../../shared/FighterData";
import type {
	AttackStartedPayload,
	BattleEndedPayload,
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
	private readonly pendingDeaths = new Map<string, PendingDeathRecord>();
	private readonly billboardPool: BillboardPoolItem[] = [];
	private readonly hpVisualListeners: ((targetId: string, hp: number, hpMax: number) => void)[] = [];
	private readonly deathVisualListeners: ((payload: FighterDiedPayload) => void)[] = [];

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
		BattleRemotes.battleEnded.OnClientEvent.Connect((payload) => {
			this.onBattleEnded(payload as BattleEndedPayload);
		});
		BattleRemotes.stateChanged.OnClientEvent.Connect(() => {});
		BattleRemotes.atbSync.OnClientEvent.Connect(() => {});
	}

	/** Retorna o modelo instanciado para `targetId` (útil para câmera e HUD). */
	public getFighterModel(targetId: string): Model | undefined {
		return this.fightersByTargetId.get(targetId)?.model;
	}

	/** Registra callback disparado quando o HP visual é atualizado após consumir hit/tick/KO. */
	public onFighterHpVisualChanged(listener: (targetId: string, hp: number, hpMax: number) => void): void {
		this.hpVisualListeners.push(listener);
	}

	/** Registra callback disparado quando um KO e eventual troca automática são efetivados visualmente. */
	public onFighterDeathVisualFlushed(listener: (payload: FighterDiedPayload) => void): void {
		this.deathVisualListeners.push(listener);
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

		const moveTween = TweenService.Create(
			billboard,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ StudsOffset: new Vector3(0, 1.2 + DAMAGE_POPUP_RISE_STUDS, 0) },
		);
		const fadeTween = TweenService.Create(
			label,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
			{ TextTransparency: 1, TextStrokeTransparency: 1 },
		);
		moveTween.Play();
		fadeTween.Play();

		task.delay(duration, () => {
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

		const track = this.tryPlaySlotAnimation(attacker, payload.slot, timeline);
		if (track !== undefined) {
			this.bindAnimationMarkers(track, attacker, target, timeline, attackToken);
		} else {
			this.runPlaceholderAttackSequence(attacker, target, timeline, attackToken);
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

		loadedTrack.Play(0.1, 1, 1);

		// Se o modelo tiver sub-modelo "Stand" com Animator e Animation correspondente, toca sincronizado
		if (attacker.standModel !== undefined) {
			const standHumanoid = attacker.standModel.FindFirstChildOfClass("Humanoid");
			const standAnimator = standHumanoid?.FindFirstChildOfClass("Animator");
			const standAnim = findAnimationInstance(attacker.standModel) ?? fighterAnim;
			if (standAnimator !== undefined) {
				pcall(() => {
					const standTrack = standAnimator.LoadAnimation(standAnim);
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
	): void {
		const totalHits = timeline.hits.size();
		for (const index of $range(1, totalHits)) {
			const markerName = `Hit${index}`;
			track.GetMarkerReachedSignal(markerName).Connect(() => {
				if (this.currentAttackToken !== attackToken || this.battleEnded) return;
				task.spawn(() => {
					this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken);
				});
			});

			// Fallback se o marker não disparar na AnimationTrack: usa o tempo de SkillData + HIT_RESULT_WAIT_SECONDS
			const scheduledHit = timeline.hits[index - 1];
			task.delay(scheduledHit.time + HIT_RESULT_WAIT_SECONDS, () => {
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
	): void {
		const startCFrame = attacker.homeCFrame;
		const targetPos = target.homeCFrame.Position;
		const approachPos = startCFrame.Position.Lerp(targetPos, PLACEHOLDER_ADVANCE_FRACTION);
		const strikeBaseCFrame = CFrame.lookAt(approachPos, targetPos);

		const firstHitTime = timeline.hits.size() > 0 ? math.max(timeline.hits[0].time, 0.05) : 0.1;
		this.tweenModelTo(attacker.model, strikeBaseCFrame, firstHitTime * 0.8);

		const totalHits = timeline.hits.size();
		for (const index of $range(1, totalHits)) {
			const hitSpec = timeline.hits[index - 1];
			task.delay(hitSpec.time, () => {
				if (this.currentAttackToken !== attackToken || this.battleEnded) return;
				if (this.followUpCancelledForCurrentAttack && index > 1) return;

				// Pequeno avanço/soco a cada hit do slot (inclusive multi-hit como Barragem_estelar)
				const punchOffset = strikeBaseCFrame.LookVector.mul(index % 2 === 1 ? 0.55 : 0.35);
				const punchCFrame = strikeBaseCFrame.add(punchOffset);
				this.tweenModelTo(attacker.model, punchCFrame, PLACEHOLDER_STRIKE_TWEEN_SECONDS);

				// Se tiver Stand (ex.: Star Platinum), projeta o Stand levemente à frente no golpe
				this.pulseStandStrike(attacker);

				this.waitForAndConsumeHitIndex(index, attacker, target, timeline, attackToken);
			});
		}
	}

	private pulseStandStrike(attacker: FighterVisualEntry): void {
		if (attacker.standModel === undefined) return;
		const standJoint = attacker.rootPart.FindFirstChild("StandJoint");
		if (standJoint !== undefined && standJoint.IsA("Motor6D")) {
			const originalC1 = standJoint.C1;
			const forwardC1 = originalC1.mul(new CFrame(0, 0, 1.1));
			const punchIn = TweenService.Create(
				standJoint,
				new TweenInfo(PLACEHOLDER_STRIKE_TWEEN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
				{ C1: forwardC1 },
			);
			punchIn.Play();
			task.delay(PLACEHOLDER_STRIKE_TWEEN_SECONDS, () => {
				if (standJoint.Parent) {
					TweenService.Create(
						standJoint,
						new TweenInfo(PLACEHOLDER_STRIKE_TWEEN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
						{ C1: originalC1 },
					).Play();
				}
			});
		}
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
		while (this.hitResultsByIndex.get(hitIndex) === undefined && os.clock() < deadline) {
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
			this.tweenModelTo(attacker.model, attacker.homeCFrame, math.max(returnDuration, 0.08));
			this.flushPendingDeaths();
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
		this.playHitReaction(target, result.crit);
	}

	private playHitReaction(target: FighterVisualEntry, isCrit: boolean): void {
		const baseCF = target.homeCFrame;
		const knockbackDist = isCrit ? PLACEHOLDER_HIT_KNOCKBACK_STUDS * 1.4 : PLACEHOLDER_HIT_KNOCKBACK_STUDS;
		const knockedCF = baseCF.add(baseCF.LookVector.mul(-knockbackDist));

		this.tweenModelTo(target.model, knockedCF, PLACEHOLDER_HIT_REACT_TWEEN_SECONDS);
		task.delay(PLACEHOLDER_HIT_REACT_TWEEN_SECONDS, () => {
			if (!target.dead && target.model.Parent !== undefined) {
				this.tweenModelTo(target.model, target.homeCFrame, PLACEHOLDER_HIT_REACT_TWEEN_SECONDS);
			}
		});
	}

	private playDodgeReaction(target: FighterVisualEntry): void {
		const baseCF = target.homeCFrame;
		const dodgeCF = baseCF.add(baseCF.RightVector.mul(PLACEHOLDER_DODGE_OFFSET_STUDS));

		this.tweenModelTo(target.model, dodgeCF, PLACEHOLDER_DODGE_TWEEN_SECONDS);
		task.delay(PLACEHOLDER_DODGE_TWEEN_SECONDS, () => {
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
		if (this.activePendingHits <= 0) {
			this.flushPendingDeaths();
		}
	}

	private flushPendingDeaths(): void {
		for (const [deadTargetId, record] of this.pendingDeaths) {
			const deadFighter = this.fightersByTargetId.get(deadTargetId);
			if (deadFighter !== undefined && !deadFighter.dead) {
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
				task.delay(PLACEHOLDER_KO_TWEEN_SECONDS, () => {
					if (deadFighter.model.Parent !== undefined) {
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

	private onBattleEnded(payload: BattleEndedPayload): void {
		// Não espera RETURN nem IDLE: encerra imediatamente
		this.battleEnded = true;
		this.currentAttackToken += 1;
		this.activePendingHits = 0;
		this.flushPendingDeaths();

		const playerSideId = this.sideIds[0];
		const isVictory = payload.winnerSideId !== undefined && payload.winnerSideId === playerSideId;
		const bannerText = isVictory ? "VICTORY" : "DEFEAT";
		const bannerColor = isVictory
			? COMBAT_FEEDBACK_COLORS.victoryBanner
			: COMBAT_FEEDBACK_COLORS.defeatBanner;

		// Exibe resultado sobre o lutador ativo vencedor (ou primeiro disponível)
		for (const [, entry] of this.fightersByTargetId) {
			if (entry.active || entry.sideId === payload.winnerSideId) {
				this.showFloatingText(
					entry.attachments.Cabeca,
					bannerText,
					bannerColor,
					DAMAGE_BILLBOARD_SIZE_BANNER,
					BATTLE_END_CLEANUP_DELAY_SECONDS,
				);
				break;
			}
		}

		task.delay(BATTLE_END_CLEANUP_DELAY_SECONDS, () => {
			if (this.battleEnded) {
				this.cleanupStage();
			}
		});
	}

	private tweenModelTo(model: Model, targetCFrame: CFrame, duration: number): void {
		const root = model.PrimaryPart;
		if (root === undefined || !model.Parent) return;
		if (duration <= 0.01) {
			model.PivotTo(targetCFrame);
			return;
		}
		const tween = TweenService.Create(
			root,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ CFrame: targetCFrame },
		);
		tween.Play();
	}

	private cleanupStage(): void {
		for (const [, entry] of this.fightersByTargetId) {
			for (const [, emitter] of entry.effectEmitters) {
				emitter.Enabled = false;
				emitter.Destroy();
			}
			entry.effectEmitters.clear();
		}
		this.fightersByTargetId.clear();
		this.hitResultsByIndex.clear();
		this.consumedHitIndices.clear();
		this.pendingDeaths.clear();

		if (this.stageFolder !== undefined) {
			this.stageFolder.Destroy();
			this.stageFolder = undefined;
		}
	}
}
