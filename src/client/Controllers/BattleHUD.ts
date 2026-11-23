import { battleCleanupStep } from "./BattleCleanup";
import { Players, RunService } from "@rbxts/services";
import { ATB_MAX, ATB_MIN, FLOAT_TOLERANCE } from "../../shared/Config";
import { findFighterDefinition } from "../../shared/FighterData";
import { clamp } from "../../shared/MathUtils";
import type {
	AtbSyncPayload,
	BattleEndedPayload,
	BattleFighterSnapshot,
	BattleSessionMode,
	BattleStartedPayload,
	ClientFighterIndex,
	EffectAppliedPayload,
	EffectExpiredPayload,
	EffectTickPayload,
	FighterDiedPayload,
	HitResolvedPayload,
	StateChangedPayload,
	SwitchPerformedPayload,
} from "../../shared/Remotes";
import { JOTARO_SKILL_DATA, resolveEquippedSkillSlots, type SkillDataSlots } from "../../shared/SkillData";
import type { BattleGlobalState, SkillSlot, StatusEffect } from "../../shared/TypeDefs";
import { HudBattleResult } from "../UI/HudBattleResult";
import { HudFighterStatus, type HudFighterState } from "../UI/HudFighterStatus";
import { HudSessionControls } from "../UI/HudSessionControls";
import { HudSkillsPanel } from "../UI/HudSkillsPanel";
import { HudTagPanel } from "../UI/HudTagPanel";
import { XpRewardCards } from "../UI/XpRewardCards";
import { GAME_FONT, UITheme } from "../UI/UITheme";
import { BattleHudQuitController } from "./BattleHudQuitController";
import { runBattleHudTeardown, type BattleHudTeardownHost } from "./BattleHudTeardown";
import { BattleRemotes } from "./BattleRemotes";
import type { CombatController } from "./CombatController";
import type { VFXController } from "./VFXController";

export class BattleHUD {
	private readonly fightersByTargetId = new Map<string, HudFighterState>();
	private readonly playerTeamOrder: string[] = [];
	private readonly opponentTeamOrder: string[] = [];

	private screenGui: ScreenGui | undefined;
	private mainContainer: Frame | undefined;
	private pauseButton: TextButton | undefined;
	private quitButton: TextButton | undefined;
	private stateBannerLabel: TextLabel | undefined;
	private pauseOverlay: Frame | undefined;
	private resultOverlay: Frame | undefined;
	private resultScreenGui?: ScreenGui;
	private quitStatusLabel?: TextLabel;
	private readonly battleDisconnectors: (() => void)[] = [];
	private xpCards = new XpRewardCards();
	private readonly fighterStatus: HudFighterStatus;
	private readonly tagPanel: HudTagPanel;
	private readonly skillsPanel: HudSkillsPanel;
	private readonly sessionControls: HudSessionControls;
	private hpTweens: Map<Frame, Tween>;
	private clearHpTweens(): void {
		this.fighterStatus.clearHpTweens();
	}
	private resultActionButton: TextButton | undefined;
	private readonly teardownHost: BattleHudTeardownHost;
	private readonly battleResult: HudBattleResult;
	private readonly quitController: BattleHudQuitController;

	private readonly lifetime: RBXScriptConnection[] = [];
	private sideIds: readonly [string, string] = ["", ""];
	private ownSideId = "";
	private opponentSideId = "";
	private battleMode: BattleSessionMode = "PVE";
	private battleState: BattleGlobalState = "IDLE";
	private introId?: number;
	private preparing = false;
	private pauseAllowedAfterIntro = false;
	private canPause = false;
	private isPaused = false;
	private lastPauseToggleClock = 0;
	private battleActive = false;
	private battleEnded = false;
	private battleVfxGeneration: number | undefined;

	private playerTargetAtb = 0;
	private opponentTargetAtb = 0;

	private started = false;
	private destroyed = false;

	public constructor(
		private readonly combatController?: CombatController,
		private readonly vfxController?: VFXController,
	) {
		this.teardownHost = {
			markBattleEnded: () => {
				this.battleActive = false;
				this.battleEnded = true;
				this.isPaused = false;
			},
			getScreenGui: () => this.screenGui,
			getResultScreenGui: () => this.resultScreenGui,
			getPauseOverlay: () => this.pauseOverlay,
			getResultOverlay: () => this.resultOverlay,
			resetQuitConfirmState: () => this.resetQuitConfirmState(),
			cancelQuitRetry: () => this.cancelQuitRetry(),
			clearHpTweens: () => this.clearHpTweens(),
			clearXpCards: () => this.xpCards.clear(),
			battleDisconnectors: this.battleDisconnectors,
			consumeBattleVfxGeneration: () => {
				const generation = this.battleVfxGeneration;
				this.battleVfxGeneration = undefined;
				return generation;
			},
			clearHudFighters: () => {
				this.fightersByTargetId.clear();
				this.playerTeamOrder.clear();
				this.opponentTeamOrder.clear();
			},
			getCombatController: () => this.combatController,
			getVfxController: () => this.vfxController,
		};
		this.battleResult = new HudBattleResult({
			getResultScreenGui: () => this.resultScreenGui,
			getOwnSideId: () => this.ownSideId,
			getBattleMode: () => this.battleMode,
			isBattleActive: () => this.battleActive,
			getXpCards: () => this.xpCards,
			registerLifetimeConnection: (connection) => {
				this.lifetime.push(connection);
			},
			teardownBattle: () => this.teardownBattle(),
			onCloseClicked: () => this.closeResultOverlay(),
			onActionClicked: () => this.handleResultCloseAndRestart(),
			createTextLabel: (parent, name, position, size, text, font, color, xAlign) =>
				this.createTextLabel(parent, name, position, size, text, font, color, xAlign),
			applyCorner: (parent, radius) => this.applyCorner(parent, radius),
			applyStroke: (parent, color, thickness) => this.applyStroke(parent, color, thickness),
			applyTextConstraint: (parent, minSize, maxSize) => this.applyTextConstraint(parent, minSize, maxSize),
		});
		this.quitController = new BattleHudQuitController({
			isBattleActive: () => this.battleActive,
			isBattleEnded: () => this.battleEnded,
			getScreenGui: () => this.screenGui,
			getResultScreenGui: () => this.resultScreenGui,
			getQuitButton: () => this.quitButton,
			getQuitStatusLabel: () => this.quitStatusLabel,
		});
		this.fighterStatus = new HudFighterStatus({
			createTextLabel: (parent, name, position, size, text, font, color, xAlign) =>
				this.createTextLabel(parent, name, position, size, text, font, color, xAlign),
			applyCorner: (parent, radius) => this.applyCorner(parent, radius),
			applyStroke: (parent, color, thickness) => this.applyStroke(parent, color, thickness),
			applyAspectRatio: (parent, ratio) => this.applyAspectRatio(parent, ratio),
		});
		this.tagPanel = new HudTagPanel({
			onSlotClicked: (index) => this.handleTagSlotClicked(index),
			registerLifetimeConnection: (connection) => {
				this.lifetime.push(connection);
			},
			createTextLabel: (parent, name, position, size, text, font, color, xAlign) =>
				this.createTextLabel(parent, name, position, size, text, font, color, xAlign),
			applyCorner: (parent, radius) => this.applyCorner(parent, radius),
			applyStroke: (parent, color, thickness) => this.applyStroke(parent, color, thickness),
			applyAspectRatio: (parent, ratio) => this.applyAspectRatio(parent, ratio),
		});
		this.skillsPanel = new HudSkillsPanel({
			onSkillClicked: (slot) => this.handleSkillButtonClicked(slot),
			registerLifetimeConnection: (connection) => {
				this.lifetime.push(connection);
			},
			createTextLabel: (parent, name, position, size, text, font, color, xAlign) =>
				this.createTextLabel(parent, name, position, size, text, font, color, xAlign),
			applyCorner: (parent, radius) => this.applyCorner(parent, radius),
			applyStroke: (parent, color, thickness) => this.applyStroke(parent, color, thickness),
			applyAspectRatio: (parent, ratio) => this.applyAspectRatio(parent, ratio),
		});
		this.sessionControls = new HudSessionControls({
			onPauseClicked: () => this.handlePauseClicked(),
			onQuitClicked: () => this.handleQuitClicked(),
			registerLifetimeConnection: (connection) => {
				this.lifetime.push(connection);
			},
			createTextLabel: (parent, name, position, size, text, font, color, xAlign) =>
				this.createTextLabel(parent, name, position, size, text, font, color, xAlign),
			applyCorner: (parent, radius) => this.applyCorner(parent, radius),
			applyStroke: (parent, color, thickness) => this.applyStroke(parent, color, thickness),
			applyAspectRatio: (parent, ratio) => this.applyAspectRatio(parent, ratio),
		});
		this.hpTweens = this.fighterStatus.getHpTweens();
	}

	public start(): void {
		if (this.started || this.destroyed) return;
		this.started = true;

		this.buildGui();
		this.bindEvents();
		this.combatController?.setIntroRecovery(() => this.teardownBattle(true));
		if (this.screenGui !== undefined) {
			this.lifetime.push(this.screenGui.Destroying.Connect(() => {
				this.screenGui = undefined;
				this.destroy();
			}));
		}
        if (RunService.IsStudio()) {
            this.lifetime.push(Players.LocalPlayer.Chatted.Connect((message) => {
                const args = message.split(" ");
                if (args[0] !== UITheme.Xp.DevCommand || this.battleActive || !this.hasResultGui()) return;
                const count = tonumber(args[1]) ?? UITheme.Xp.MaxCards;
                if (count !== 1 && count !== 2 && count !== 3) return;
                const rewards = XpRewardCards.devRewards();
                const devOwnSide = this.ownSideId !== "" ? this.ownSideId : "dev-own-side";
                if (this.ownSideId === "") {
                    this.ownSideId = devOwnSide;
                    this.opponentSideId = "dev-opponent-side";
                    this.sideIds = [this.ownSideId, this.opponentSideId];
                }
                this.battleMode = "PVE";
                this.showBattleResult({ winnerSideId: devOwnSide, xpRewards: rewards.filter((_, index) => index < count) });
            }));
        }

	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.combatController?.setIntroRecovery(undefined);
		this.teardownBattle(true);
		for (const connection of this.lifetime) battleCleanupStep("HUD lifetime connection", () => connection.Disconnect());
		this.lifetime.clear();
		const gui = this.screenGui;
		this.screenGui = undefined;
		battleCleanupStep("HUD destroy", () => gui?.Destroy());
		battleCleanupStep("result GUI destroy", () => this.resultScreenGui?.Destroy());
		this.resultScreenGui = undefined;
	}

	private bindEvents(): void {
		this.lifetime.push(
			BattleRemotes.battleStarted.OnClientEvent.Connect((payload) => {
				this.onBattleStarted(payload as BattleStartedPayload);
			}),
			BattleRemotes.stateChanged.OnClientEvent.Connect((payload) => {
				this.onStateChanged(payload as StateChangedPayload);
			}),
			BattleRemotes.atbSync.OnClientEvent.Connect((payload) => {
				this.onAtbSync(payload as AtbSyncPayload);
			}),
			BattleRemotes.switchPerformed.OnClientEvent.Connect((payload) => {
				this.onSwitchPerformed(payload as SwitchPerformedPayload);
			}),
			BattleRemotes.effectApplied.OnClientEvent.Connect((payload) => {
				this.onEffectApplied(payload as EffectAppliedPayload);
			}),
			BattleRemotes.effectExpired.OnClientEvent.Connect((payload) => {
				this.onEffectExpired(payload as EffectExpiredPayload);
			}),
			BattleRemotes.battleEnded.OnClientEvent.Connect((payload) => {
				this.onBattleEnded(payload as BattleEndedPayload);
			}),
		);

		if (this.combatController === undefined) {
			this.lifetime.push(
				BattleRemotes.hitResolved.OnClientEvent.Connect((payload) => {
					const hit = payload as HitResolvedPayload;
					const isNoDamageHit = hit.noDamage === true || (hit.hit && hit.damage <= 0);
					if (!hit.hit || isNoDamageHit) return;
					const fighter = this.fightersByTargetId.get(hit.targetId);
					if (fighter !== undefined) {
						this.applyVisualHpUpdate(hit.targetId, math.max(fighter.hp - hit.damage, 0), fighter.hpMax);
					}
				}),
				BattleRemotes.effectTick.OnClientEvent.Connect((payload) => {
					const tick = payload as EffectTickPayload;
					const fighter = this.fightersByTargetId.get(tick.targetId);
					if (fighter !== undefined) {
						this.applyVisualHpUpdate(tick.targetId, math.max(fighter.hp - tick.damage, 0), fighter.hpMax);
					}
				}),
				BattleRemotes.fighterDied.OnClientEvent.Connect((payload) => {
					this.applyVisualDeathAndAutoSwitch(payload as FighterDiedPayload);
				}),
			);
		}
	}

	private buildGui(): void {
		const localPlayer = Players.LocalPlayer;
		const playerGui = localPlayer.WaitForChild("PlayerGui") as PlayerGui;

		const existing = playerGui.FindFirstChild(UITheme.ScreenGuiName);
		if (existing !== undefined) {
			existing.Destroy();
		}

		const screenGui = new Instance("ScreenGui");
		screenGui.Name = UITheme.ScreenGuiName;
		screenGui.DisplayOrder = UITheme.DisplayOrder;
		screenGui.IgnoreGuiInset = false;
		screenGui.ResetOnSpawn = false;
		screenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
		screenGui.Enabled = false;
		screenGui.Parent = playerGui;
		this.screenGui = screenGui;

		const main = new Instance("Frame");
		main.Name = "MainContainer";
		main.Size = UITheme.Layout.FullSize;
		main.Position = UITheme.Layout.OriginPosition;
		main.BackgroundTransparency = UITheme.Transparency.Hidden;
		main.Parent = screenGui;
		this.mainContainer = main;

		this.fighterStatus.buildCards(main);

		const controls = this.sessionControls.createControls(main);
		this.pauseButton = controls.pauseButton;
		this.quitButton = controls.quitButton;
		this.stateBannerLabel = controls.stateBannerLabel;
		this.tagPanel.createPanel(main);
		this.skillsPanel.createPanel(main);
		this.pauseOverlay = this.sessionControls.createPauseOverlay(screenGui);
		const resultGui = new Instance("ScreenGui");
		resultGui.Name = UITheme.ResultScreenGuiName;
		resultGui.DisplayOrder = UITheme.Xp.ResultDisplayOrder;
		resultGui.IgnoreGuiInset = screenGui.IgnoreGuiInset;
		resultGui.ResetOnSpawn = false;
		resultGui.ZIndexBehavior = screenGui.ZIndexBehavior;
		resultGui.Enabled = false;
		resultGui.Parent = playerGui;
		this.resultScreenGui = resultGui;
		this.createResultOverlay(resultGui);
		this.quitStatusLabel = this.quitController.createQuitStatusLabel(resultGui);
	}

	private createResultOverlay(parent: ScreenGui): void {
		const created = this.battleResult.createResultOverlay(parent);
		this.resultOverlay = created.overlay;
		this.resultActionButton = created.actionButton;
	}

	private hasResultGui(): boolean {
		return this.battleResult.hasResultGui();
	}
	private onBattleStarted(payload: BattleStartedPayload): void {
		if (payload.transitionId !== undefined && this.combatController !== undefined &&
			!this.combatController.introduction.owns(payload.transitionId)) return;
		battleCleanupStep("previous HP tweens", () => this.clearHpTweens());
		battleCleanupStep("previous XP cards", () => this.xpCards.clear());
		if (this.screenGui) this.screenGui.DisplayOrder = UITheme.DisplayOrder;
		this.fightersByTargetId.clear();
		this.playerTeamOrder.clear();
		this.opponentTeamOrder.clear();

		this.sideIds = payload.sides;
		this.ownSideId = payload.sides[0];
		this.opponentSideId = payload.sides[1];
		this.battleMode = payload.mode ?? "PVE";
		this.battleState = "IDLE";
		this.introId = payload.transitionId;
		this.preparing = this.introId !== undefined;
		this.pauseAllowedAfterIntro = payload.canPause === true || payload.mode === "PVE";
		this.canPause = !this.preparing && this.pauseAllowedAfterIntro;
		this.isPaused = false;
		this.lastPauseToggleClock = 0;
		this.battleActive = true;
		this.battleEnded = false;
		this.quitController.resetForNewBattle();
		this.battleVfxGeneration = this.combatController?.getBattleGeneration();
		for (const disconnect of this.battleDisconnectors) battleCleanupStep("previous HUD connection", disconnect);
		this.battleDisconnectors.clear();
		if (this.combatController !== undefined) {
			this.battleDisconnectors.push(
				this.combatController.onFighterHpVisualChanged((id, hp, max) => this.applyVisualHpUpdate(id, hp, max)),
				this.combatController.onFighterDeathVisualFlushed((death) => this.applyVisualDeathAndAutoSwitch(death)),
			);
		}
		const heartbeat = RunService.Heartbeat.Connect((dt) => this.stepAtbInterpolation(dt));
		this.battleDisconnectors.push(() => heartbeat.Disconnect());

		this.playerTargetAtb = 0;
		this.opponentTargetAtb = 0;
		this.fighterStatus.resetAtbDisplay();

		let playerSlotCounter = 0;
		let opponentSlotCounter = 0;

		for (const snapshot of payload.fighters) {
			const isPlayerSide = snapshot.sideId === this.ownSideId;
			const sideIndex: 0 | 1 = isPlayerSide ? 0 : 1;
			if (isPlayerSide) {
				playerSlotCounter += 1;
			} else {
				opponentSlotCounter += 1;
			}
			const teamSlotIndex = clamp(
				isPlayerSide ? playerSlotCounter : opponentSlotCounter,
				1,
				3,
			) as ClientFighterIndex;

			const hudFighter = this.buildHudFighterState(snapshot, sideIndex, teamSlotIndex);
			this.fightersByTargetId.set(snapshot.targetId, hudFighter);
			if (isPlayerSide) {
				this.playerTeamOrder.push(snapshot.targetId);
			} else {
				this.opponentTeamOrder.push(snapshot.targetId);
			}
		}

		if (this.screenGui !== undefined) {
			this.screenGui.Enabled = true;
		}
		if (this.pauseOverlay !== undefined) {
			this.pauseOverlay.Visible = false;
		}
		if (this.resultOverlay !== undefined) {
			this.resultOverlay.Visible = false;
		}

		this.refreshSessionControlsLayout();
		this.refreshAllVisuals();
	}

	private buildHudFighterState(
		snapshot: BattleFighterSnapshot,
		sideIndex: 0 | 1,
		teamSlotIndex: ClientFighterIndex,
	): HudFighterState {
		const def = findFighterDefinition(snapshot.fighterId) ?? findFighterDefinition(snapshot.fighterId.lower());
		let displayName = snapshot.fighterId;
		let skillTemplates: SkillDataSlots = JOTARO_SKILL_DATA;

		if (def !== undefined) {
			displayName = def.name;
			skillTemplates = def.skills;
		} else if (snapshot.fighterId.size() > 0) {
			displayName = snapshot.fighterId.sub(1, 1).upper() + snapshot.fighterId.sub(2);
		}
		skillTemplates = resolveEquippedSkillSlots(skillTemplates, snapshot.skillIds);

		const iconText = displayName.sub(1, 2).upper();
		const slotCosts: readonly [number, number, number] = snapshot.slotCosts ?? UITheme.Numbers.DefaultSlotCosts;
		const skillNames: readonly [string, string, string] = [
			skillTemplates[0].name ?? "Skill 1",
			skillTemplates[1].name ?? "Skill 2",
			skillTemplates[2].name ?? "Skill 3",
		];

		return {
			targetId: snapshot.targetId,
			fighterId: snapshot.fighterId,
			sideId: snapshot.sideId,
			sideIndex,
			teamSlotIndex,
			displayName,
			iconText,
			className: snapshot.className,
			level: snapshot.level,
			s3Unlocked: snapshot.s3Unlocked,
			slotCosts,
			skillNames,
			hp: snapshot.hp,
			hpMax: snapshot.hpMax,
			active: snapshot.active,
			dead: snapshot.hp <= 0,
			effects: new Set<StatusEffect>(),
			effectMeta: new Map(),
		};
	}

	private onStateChanged(payload: StateChangedPayload): void {
		if (!this.battleActive || this.battleEnded) return;
		if (payload.battleReleased !== undefined && payload.battleReleased !== this.introId) return;
		if (this.preparing) {
			if (payload.battleReleased === undefined) return;
			this.preparing = false;
			this.canPause = this.pauseAllowedAfterIntro;
			this.refreshSessionControlsLayout();
			this.refreshPauseVisuals();
		}
		this.clearPauseIfServerProgressed();
		this.battleState = payload.state;
		this.refreshStateBanner();
		this.refreshSkillButtons();
		this.refreshTagSlots();
	}

	private onAtbSync(payload: AtbSyncPayload): void {
		if (!this.battleActive || this.battleEnded || this.preparing) return;
		this.clearPauseIfServerProgressed();
		const clampedAtb = clamp(payload.atb, ATB_MIN, ATB_MAX);
		if (payload.sideId === this.ownSideId) {
			this.playerTargetAtb = clampedAtb;
			this.refreshPlayerAtbMarkersAndSkills();
		} else if (payload.sideId === this.opponentSideId) {
			this.opponentTargetAtb = clampedAtb;
		}
	}

	private onSwitchPerformed(payload: SwitchPerformedPayload): void {
		if (!this.battleActive || this.battleEnded) return;
		const prev = this.fightersByTargetId.get(payload.previousFighterId);
		const nextActive = this.fightersByTargetId.get(payload.activeFighterId);
		if (prev !== undefined) {
			prev.active = false;
		}
		if (nextActive !== undefined) {
			nextActive.active = true;
		}
		this.refreshAllVisuals();
	}

	private onEffectApplied(payload: EffectAppliedPayload): void {
		if (!this.battleActive || this.battleEnded) return;
		const fighter = this.fightersByTargetId.get(payload.targetId);
		if (fighter === undefined || fighter.dead) return;
		fighter.effects.add(payload.effect);
		fighter.effectMeta?.set(payload.effect, {
			duration: payload.duration,
			remainingDuration: payload.remainingDuration ?? payload.duration,
			charges: payload.charges,
			maxCharges: payload.maxCharges,
		});
		this.refreshActiveStatusCards();
		this.refreshTagSlots();
	}

	private onEffectExpired(payload: EffectExpiredPayload): void {
		if (!this.battleActive) return;
		const fighter = this.fightersByTargetId.get(payload.targetId);
		if (fighter === undefined) return;
		fighter.effects.delete(payload.effect);
		fighter.effectMeta?.delete(payload.effect);
		this.refreshActiveStatusCards();
		this.refreshTagSlots();
	}

	private applyVisualHpUpdate(targetId: string, hp: number, hpMax: number): void {
		if (!this.battleActive || this.battleEnded) return;
		const fighter = this.fightersByTargetId.get(targetId);
		if (fighter === undefined) return;
		fighter.hp = clamp(hp, 0, hpMax);
		fighter.hpMax = hpMax;
		this.refreshActiveStatusCards();
		this.refreshTagSlots();
	}

	private applyVisualDeathAndAutoSwitch(payload: FighterDiedPayload): void {
		if (!this.battleActive || this.battleEnded) return;
		const deadFighter = this.fightersByTargetId.get(payload.fighterId);
		const wasActive = deadFighter?.active === true;
		if (deadFighter !== undefined) {
			deadFighter.dead = true;
			deadFighter.active = false;
			deadFighter.hp = 0;
			deadFighter.effects.clear();
			deadFighter.effectMeta?.clear();
		}

		// Regra do jogo: morte do ativo zera ATB do lado; morte no banco preserva o ATB do ativo.
		if (deadFighter === undefined || wasActive || payload.nextActive !== undefined) {
			if (payload.sideId === this.ownSideId) {
				this.playerTargetAtb = 0;
				this.fighterStatus.resetSideAtbDisplay(true);
			} else if (payload.sideId === this.opponentSideId) {
				this.opponentTargetAtb = 0;
				this.fighterStatus.resetSideAtbDisplay(false);
			}
		}

		if (payload.nextActive !== undefined) {
			const nextFighter = this.fightersByTargetId.get(payload.nextActive);
			if (nextFighter !== undefined && !nextFighter.dead) {
				nextFighter.active = true;
			}
		}

		this.refreshAllVisuals();
	}

	/** All authoritative ends and result dismissal converge here; every step can fail independently. */
	private teardownBattle(clearCurrentVfx = false): void {
		runBattleHudTeardown(this.teardownHost, clearCurrentVfx);
	}

	private onBattleEnded(payload: BattleEndedPayload): void {
		if (payload.transitionId !== undefined && this.combatController !== undefined) {
			this.combatController.introduction.finish(payload.transitionId, () => this.finishBattle(payload));
			return;
		}
		this.finishBattle(payload);
	}

	private finishBattle(payload: BattleEndedPayload): void {
		if (!this.battleActive) {
			battleCleanupStep("combat resources", () => this.combatController?.cleanupStage());
			return;
		}
		const suppressResult = this.quitController.shouldSuppressResult(payload, this.ownSideId);
		this.teardownBattle(true);
		if (suppressResult) return;
		const [ok, failure] = pcall(() => this.showBattleResult(payload));
		if (!ok) {
			warn(`[BattleHUD] resultado: ${tostring(failure)}`);
			this.teardownBattle();
		}
	}

	private showBattleResult(payload: BattleEndedPayload): void {
		this.battleResult.showBattleResult(payload);
	}

	private closeResultOverlay(): void {
		this.battleResult.closeResultOverlay();
	}

	private handleSkillButtonClicked(slot: SkillSlot): void {
		if (!this.battleActive || this.battleEnded || this.isPaused || this.preparing) return;
		if (this.battleState !== "IDLE") return;
		const activePlayerFighter = this.getActiveFighterForSide(0);
		if (activePlayerFighter === undefined || activePlayerFighter.dead) return;
		if (slot === 3 && !activePlayerFighter.s3Unlocked) return;

		const cost = activePlayerFighter.slotCosts[slot - 1];
		if (this.playerTargetAtb + FLOAT_TOLERANCE < cost) return;

		BattleRemotes.requestSkill.FireServer({ slot });
	}

	private handleTagSlotClicked(index: ClientFighterIndex): void {
		if (!this.battleActive || this.battleEnded || this.isPaused || this.preparing) return;
		if (this.battleState !== "IDLE") return;

		const activePlayerFighter = this.getActiveFighterForSide(0);
		if (activePlayerFighter !== undefined && activePlayerFighter.effects.has("Root")) {
			return;
		}

		const targetId = this.playerTeamOrder[index - 1];
		if (targetId === undefined) return;
		const candidate = this.fightersByTargetId.get(targetId);
		if (candidate === undefined || candidate.dead || candidate.active) return;

		BattleRemotes.requestSwitch.FireServer({ index });
	}

	private handlePauseClicked(): void {
		if (!this.battleActive || this.battleEnded || !this.canPause) return;
		this.isPaused = !this.isPaused;
		this.lastPauseToggleClock = os.clock();
		BattleRemotes.requestPause.FireServer();
		this.refreshPauseVisuals();
		this.refreshSkillButtons();
		this.refreshTagSlots();
	}

	private handleQuitClicked(): void {
		this.quitController.handleQuitClicked();
	}

	private cancelQuitRetry(): void {
		this.quitController.cancelQuitRetry();
	}

	private handleResultCloseAndRestart(): void {
		this.battleResult.handleResultCloseAndRestart();
	}

	private resetQuitConfirmState(): void {
		this.quitController.resetQuitConfirmState();
	}

	private clearPauseIfServerProgressed(): void {
		// Se o servidor voltou a emitir ticks/estados (ex.: estourou os 120s de pause), sincroniza o client
		if (this.isPaused && os.clock() - this.lastPauseToggleClock > 0.35) {
			this.isPaused = false;
			this.refreshPauseVisuals();
			this.refreshSkillButtons();
			this.refreshTagSlots();
		}
	}

	private refreshSessionControlsLayout(): void {
		this.sessionControls.refreshLayout({
			canPause: this.canPause,
			isPaused: this.isPaused,
			battleEnded: this.battleEnded,
		});
	}

	private refreshPauseVisuals(): void {
		this.sessionControls.refreshPauseVisuals({
			canPause: this.canPause,
			isPaused: this.isPaused,
			battleEnded: this.battleEnded,
		});
	}

	private refreshAllVisuals(): void {
		this.refreshStateBanner();
		this.refreshActiveStatusCards();
		this.refreshPlayerAtbMarkersAndSkills();
		this.refreshTagSlots();
		this.refreshPauseVisuals();
	}

	private refreshStateBanner(): void {
		this.sessionControls.refreshStateBanner(this.battleState);
	}

	private refreshActiveStatusCards(): void {
		this.fighterStatus.refreshActiveStatusCards(
			this.getActiveFighterForSide(0),
			this.getActiveFighterForSide(1),
		);
	}

	private refreshPlayerAtbMarkersAndSkills(): void {
		this.fighterStatus.refreshPlayerAtbMarkers(this.getActiveFighterForSide(0), this.playerTargetAtb);
		this.refreshSkillButtons();
	}

	private refreshSkillButtons(): void {
		this.skillsPanel.refresh({
			activePlayer: this.getActiveFighterForSide(0),
			playerAtb: this.playerTargetAtb,
			canUseSkillsInCurrentPhase:
				this.battleState === "IDLE" && !this.isPaused && this.battleActive && !this.battleEnded && !this.preparing,
		});
	}

	private refreshTagSlots(): void {
		this.tagPanel.refresh({
			activePlayer: this.getActiveFighterForSide(0),
			playerTeamOrder: this.playerTeamOrder,
			fightersByTargetId: this.fightersByTargetId,
			canSwitchInCurrentPhase:
				this.battleActive && !this.battleEnded && !this.isPaused && this.battleState === "IDLE" && !this.preparing,
		});
	}

	private stepAtbInterpolation(dt: number): void {
		if (!this.battleActive || this.preparing) return;
		this.fighterStatus.stepAtbInterpolation(dt, this.playerTargetAtb, this.opponentTargetAtb);
	}

	private getActiveFighterForSide(sideIndex: 0 | 1): HudFighterState | undefined {
		const order = sideIndex === 0 ? this.playerTeamOrder : this.opponentTeamOrder;
		for (const targetId of order) {
			const fighter = this.fightersByTargetId.get(targetId);
			if (fighter !== undefined && fighter.active) {
				return fighter;
			}
		}
		for (const targetId of order) {
			const fighter = this.fightersByTargetId.get(targetId);
			if (fighter !== undefined) {
				return fighter;
			}
		}
		return undefined;
	}

	private createTextLabel(
		parent: Instance,
		name: string,
		position: UDim2,
		size: UDim2,
		text: string,
		font: Enum.Font,
		color: Color3,
		xAlign: Enum.TextXAlignment,
	): TextLabel {
		const label = new Instance("TextLabel");
		label.Name = name;
		label.Position = position;
		label.Size = size;
		label.BackgroundTransparency = UITheme.Transparency.Hidden;
		label.Font = font;
		label.FontFace = GAME_FONT;
		label.TextColor3 = color;
		label.TextScaled = true;
		label.TextXAlignment = xAlign;
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.Text = text;
		label.Parent = parent;
		return label;
	}

	private applyCorner(parent: GuiObject, radius: UDim): UICorner {
		const corner = new Instance("UICorner");
		corner.CornerRadius = radius;
		corner.Parent = parent;
		return corner;
	}

	private applyStroke(parent: GuiObject, color: Color3, thickness: number): UIStroke {
		const stroke = new Instance("UIStroke");
		stroke.Color = color;
		stroke.Thickness = thickness;
		stroke.Transparency = UITheme.Transparency.StrokeDefault;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = parent;
		return stroke;
	}

	private applyAspectRatio(parent: GuiObject, ratio: number): UIAspectRatioConstraint {
		const aspect = new Instance("UIAspectRatioConstraint");
		aspect.AspectRatio = ratio;
		aspect.AspectType = Enum.AspectType.FitWithinMaxSize;
		aspect.DominantAxis = Enum.DominantAxis.Width;
		aspect.Parent = parent;
		return aspect;
	}

	private applyTextConstraint(parent: GuiObject, minSize: number, maxSize: number): UITextSizeConstraint {
		const constraint = new Instance("UITextSizeConstraint");
		constraint.MinTextSize = minSize;
		constraint.MaxTextSize = maxSize;
		constraint.Parent = parent;
		return constraint;
	}
}
