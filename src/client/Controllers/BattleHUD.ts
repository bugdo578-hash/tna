import { Players, ReplicatedStorage, RunService, TextChatService, TweenService } from "@rbxts/services";
import { ATB_MAX, ATB_MIN, DEV_TEST_BATTLE_CHAT_COMMAND, FLOAT_TOLERANCE } from "../../shared/Config";
import { FIGHTER_DATA, type RealFighterId } from "../../shared/FighterData";
import { clamp } from "../../shared/MathUtils";
import type {
	AtbSyncPayload,
	BattleEndedPayload,
	BattleFighterSnapshot,
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
import { ANUBIS_SKILL_DATA, JOTARO_SKILL_DATA, type SkillDataSlots } from "../../shared/SkillData";
import type { BattleGlobalState, ClassName, SkillSlot, StatusEffect } from "../../shared/TypeDefs";
import { XpRewardCards } from "../UI/XpRewardCards";
import { UITheme } from "../UI/UITheme";
import { BattleRemotes } from "./BattleRemotes";
import type { CombatController } from "./CombatController";

interface HudFighterState {
	readonly targetId: string;
	readonly fighterId: string;
	readonly sideId: string;
	readonly sideIndex: 0 | 1;
	readonly teamSlotIndex: ClientFighterIndex;
	readonly displayName: string;
	readonly iconText: string;
	readonly className: ClassName;
	readonly level: number;
	readonly s3Unlocked: boolean;
	readonly slotCosts: readonly [number, number, number];
	readonly skillNames: readonly [string, string, string];
	hp: number;
	hpMax: number;
	active: boolean;
	dead: boolean;
	readonly effects: Set<StatusEffect>;
}

interface StatusCardWidgets {
	readonly root: Frame;
	readonly iconBadge: Frame;
	readonly iconLabel: TextLabel;
	readonly nameLabel: TextLabel;
	readonly metaLabel: TextLabel;
	readonly hpFill: Frame;
	readonly hpValueLabel: TextLabel;
	readonly atbFill: Frame;
	readonly atbValueLabel: TextLabel;
	readonly statusBadges: Readonly<Record<StatusEffect, TextLabel>>;
	readonly atbMarkers: readonly {
		readonly root: Frame;
		readonly line: Frame;
		readonly label: TextLabel;
	}[];
}

interface TagSlotWidgets {
	readonly index: ClientFighterIndex;
	readonly button: TextButton;
	readonly stroke: UIStroke;
	readonly badge: Frame;
	readonly badgeLabel: TextLabel;
	readonly nameLabel: TextLabel;
	readonly hpFill: Frame;
	readonly statusLabel: TextLabel;
	readonly deadCrossLabel: TextLabel;
}

interface SkillButtonWidgets {
	readonly slot: SkillSlot;
	readonly button: TextButton;
	readonly stroke: UIStroke;
	readonly slotTag: TextLabel;
	readonly costLabel: TextLabel;
	readonly nameLabel: TextLabel;
	readonly stateLabel: TextLabel;
}

export class BattleHUD {
	private readonly fightersByTargetId = new Map<string, HudFighterState>();
	private readonly playerTeamOrder: string[] = [];
	private readonly opponentTeamOrder: string[] = [];

	private screenGui: ScreenGui | undefined;
	private mainContainer: Frame | undefined;
	private playerCard: StatusCardWidgets | undefined;
	private opponentCard: StatusCardWidgets | undefined;
	private pauseButton: TextButton | undefined;
	private quitButton: TextButton | undefined;
	private stateBannerLabel: TextLabel | undefined;
	private rootLockBanner: TextLabel | undefined;
	private readonly tagSlotWidgets: TagSlotWidgets[] = [];
	private readonly skillButtonWidgets: SkillButtonWidgets[] = [];
	private pauseOverlay: Frame | undefined;
	private resultOverlay: Frame | undefined;
	private xpCards = new XpRewardCards();
    private hpTweens = new Map<Frame, Tween>();
    private clearHpTweens(): void {
        for (const [, tween] of this.hpTweens) tween.Cancel();
        this.hpTweens.clear();
    }
	private resultCardStroke: UIStroke | undefined;
	private resultTitleLabel: TextLabel | undefined;
	private resultRewardLabel: TextLabel | undefined;

	private sideIds: readonly [string, string] = ["", ""];
	private battleState: BattleGlobalState = "IDLE";
	private canPause = false;
	private isPaused = false;
	private lastPauseToggleClock = 0;
	private quitConfirmPending = false;
	private quitConfirmToken = 0;
	private battleActive = false;
	private battleEnded = false;

	private playerTargetAtb = 0;
	private playerDisplayAtb = 0;
	private opponentTargetAtb = 0;
	private opponentDisplayAtb = 0;

	private started = false;

	public constructor(private readonly combatController?: CombatController) {}

	public start(): void {
		if (this.started) return;
		this.started = true;

		this.buildGui();
		this.bindEvents();
        this.screenGui?.Destroying.Connect(() => {
            this.quitConfirmToken++;
            this.clearHpTweens(); this.xpCards.clear();
        });
        if (RunService.IsStudio()) {
            Players.LocalPlayer.Chatted.Connect((message) => {
                const args = message.split(" ");
                if (args[0] !== UITheme.Xp.DevCommand || !this.hasResultGui()) return;
                const count = tonumber(args[1]) ?? UITheme.Xp.MaxCards;
                if (count !== 1 && count !== 2 && count !== 3) return;
                const rewards = XpRewardCards.devRewards();
                if (this.screenGui !== undefined && this.screenGui.Parent !== undefined) this.screenGui.Enabled = true;
                this.onBattleEnded({ winnerSideId: this.sideIds[0], xpRewards: rewards.filter((_, index) => index < count) });
            });
        }

		RunService.Heartbeat.Connect((dt) => {
			this.stepAtbInterpolation(dt);
		});
	}

	private bindEvents(): void {
		BattleRemotes.battleStarted.OnClientEvent.Connect((payload) => {
			this.onBattleStarted(payload as BattleStartedPayload);
		});
		BattleRemotes.stateChanged.OnClientEvent.Connect((payload) => {
			this.onStateChanged(payload as StateChangedPayload);
		});
		BattleRemotes.atbSync.OnClientEvent.Connect((payload) => {
			this.onAtbSync(payload as AtbSyncPayload);
		});
		BattleRemotes.switchPerformed.OnClientEvent.Connect((payload) => {
			this.onSwitchPerformed(payload as SwitchPerformedPayload);
		});
		BattleRemotes.effectApplied.OnClientEvent.Connect((payload) => {
			this.onEffectApplied(payload as EffectAppliedPayload);
		});
		BattleRemotes.effectExpired.OnClientEvent.Connect((payload) => {
			this.onEffectExpired(payload as EffectExpiredPayload);
		});
		BattleRemotes.battleEnded.OnClientEvent.Connect((payload) => {
			this.onBattleEnded(payload as BattleEndedPayload);
		});

		if (this.combatController !== undefined) {
			// Sincroniza visualmente HP e KO no exato instante em que o CombatController consome o hit/tick
			this.combatController.onFighterHpVisualChanged((targetId, hp, hpMax) => {
				this.applyVisualHpUpdate(targetId, hp, hpMax);
			});
			this.combatController.onFighterDeathVisualFlushed((payload) => {
				this.applyVisualDeathAndAutoSwitch(payload);
			});
		} else {
			BattleRemotes.hitResolved.OnClientEvent.Connect((payload) => {
				const hit = payload as HitResolvedPayload;
				if (!hit.hit) return;
				const fighter = this.fightersByTargetId.get(hit.targetId);
				if (fighter !== undefined) {
					this.applyVisualHpUpdate(hit.targetId, math.max(fighter.hp - hit.damage, 0), fighter.hpMax);
				}
			});
			BattleRemotes.effectTick.OnClientEvent.Connect((payload) => {
				const tick = payload as EffectTickPayload;
				const fighter = this.fightersByTargetId.get(tick.targetId);
				if (fighter !== undefined) {
					this.applyVisualHpUpdate(tick.targetId, math.max(fighter.hp - tick.damage, 0), fighter.hpMax);
				}
			});
			BattleRemotes.fighterDied.OnClientEvent.Connect((payload) => {
				this.applyVisualDeathAndAutoSwitch(payload as FighterDiedPayload);
			});
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

		this.playerCard = this.createStatusCard(
			main,
			"PlayerStatusCard",
			UITheme.Layout.TopLeftAnchor,
			UITheme.Layout.PlayerCardPos,
			true,
		);
		this.opponentCard = this.createStatusCard(
			main,
			"OpponentStatusCard",
			UITheme.Layout.TopRightAnchor,
			UITheme.Layout.OpponentCardPos,
			false,
		);

		this.createSessionControls(main);
		this.createTagPanel(main);
		this.createSkillsPanel(main);
		this.createPauseOverlay(screenGui);
		this.createResultOverlay(screenGui);
	}

	private createStatusCard(
		parent: GuiObject,
		name: string,
		anchorPoint: Vector2,
		position: UDim2,
		isPlayer: boolean,
	): StatusCardWidgets {
		const card = new Instance("Frame");
		card.Name = name;
		card.AnchorPoint = anchorPoint;
		card.Position = position;
		card.Size = UITheme.Layout.StatusCardSize;
		card.BackgroundColor3 = UITheme.Colors.PanelBackground;
		card.BackgroundTransparency = UITheme.Transparency.Panel;
		card.Parent = parent;

		this.applyCorner(card, UITheme.CornerRadius.Panel);
		this.applyStroke(card, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);
		this.applyAspectRatio(card, UITheme.AspectRatios.StatusCard);

		const header = new Instance("Frame");
		header.Name = "Header";
		header.Position = UITheme.Layout.CardHeaderPos;
		header.Size = UITheme.Layout.CardHeaderSize;
		header.BackgroundTransparency = UITheme.Transparency.Hidden;
		header.Parent = card;

		const iconBadge = new Instance("Frame");
		iconBadge.Name = "IconBadge";
		iconBadge.Position = UITheme.Layout.FighterIconPos;
		iconBadge.Size = UITheme.Layout.FighterIconSize;
		iconBadge.BackgroundColor3 = UITheme.Colors.PanelSecondary;
		iconBadge.Parent = header;
		this.applyCorner(iconBadge, UITheme.CornerRadius.Badge);
		this.applyAspectRatio(iconBadge, UITheme.AspectRatios.IconBadge);

		const iconLabel = this.createTextLabel(
			iconBadge,
			"IconLabel",
			UITheme.Layout.OriginPosition,
			UITheme.Layout.FullSize,
			"?",
			UITheme.Fonts.Title,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Center,
		);

		const nameLabel = this.createTextLabel(
			header,
			"FighterName",
			UITheme.Layout.FighterNamePos,
			UITheme.Layout.FighterNameSize,
			isPlayer ? UITheme.Texts.PlayerSideTag : UITheme.Texts.OpponentSideTag,
			UITheme.Fonts.Title,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Left,
		);

		const metaLabel = this.createTextLabel(
			header,
			"FighterMeta",
			UITheme.Layout.FighterMetaPos,
			UITheme.Layout.FighterMetaSize,
			"",
			UITheme.Fonts.Medium,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Left,
		);

		const badgeRow = new Instance("Frame");
		badgeRow.Name = "StatusBadges";
		badgeRow.Position = UITheme.Layout.StatusBadgeRowPos;
		badgeRow.Size = UITheme.Layout.StatusBadgeRowSize;
		badgeRow.BackgroundTransparency = UITheme.Transparency.Hidden;
		badgeRow.Parent = header;

		const effectsOrder: readonly StatusEffect[] = ["Burn", "Bleed", "Root"];
		const statusBadges = {} as Record<StatusEffect, TextLabel>;
		for (const idx of $range(0, effectsOrder.size() - 1)) {
			const effect = effectsOrder[idx];
			const badge = this.createTextLabel(
				badgeRow,
				`Badge_${effect}`,
				UDim2.fromScale(idx * 0.34, 0),
				UITheme.Layout.StatusBadgeItemSize,
				UITheme.Texts.StatusShortLabels[effect],
				UITheme.Fonts.Bold,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Center,
			);
			badge.BackgroundColor3 = UITheme.StatusColors[effect];
			badge.BackgroundTransparency = UITheme.Transparency.Opaque;
			badge.Visible = false;
			this.applyCorner(badge, UITheme.CornerRadius.Badge);
			statusBadges[effect] = badge;
		}

		// Barra de HP
		const hpTrack = new Instance("Frame");
		hpTrack.Name = "HpBarTrack";
		hpTrack.Position = UITheme.Layout.HpBarPos;
		hpTrack.Size = UITheme.Layout.HpBarSize;
		hpTrack.BackgroundColor3 = UITheme.Colors.BarTrack;
		hpTrack.BackgroundTransparency = UITheme.Transparency.BarTrack;
		hpTrack.Parent = card;
		this.applyCorner(hpTrack, UITheme.CornerRadius.Bar);
		this.applyStroke(hpTrack, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);

		const hpFill = new Instance("Frame");
		hpFill.Name = "HpFill";
		hpFill.Position = UITheme.Layout.OriginPosition;
		hpFill.Size = UITheme.Layout.FullSize;
		hpFill.BackgroundColor3 = UITheme.Colors.HpFillHigh;
		hpFill.BorderSizePixel = 0;
		hpFill.Parent = hpTrack;
		this.applyCorner(hpFill, UITheme.CornerRadius.Bar);

		this.createTextLabel(
			hpTrack,
			"HpTitle",
			UITheme.Layout.BarLabelPos,
			UITheme.Layout.BarLabelSize,
			UITheme.Texts.HpLabel,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Left,
		);

		const hpValueLabel = this.createTextLabel(
			hpTrack,
			"HpValue",
			UITheme.Layout.BarValuePos,
			UITheme.Layout.BarValueSize,
			"0 / 0",
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Right,
		);

		// Barra de ATB (0 a 10)
		const atbTrack = new Instance("Frame");
		atbTrack.Name = "AtbBarTrack";
		atbTrack.Position = UITheme.Layout.AtbBarPos;
		atbTrack.Size = UITheme.Layout.AtbBarSize;
		atbTrack.BackgroundColor3 = UITheme.Colors.BarTrack;
		atbTrack.BackgroundTransparency = UITheme.Transparency.BarTrack;
		atbTrack.Parent = card;
		this.applyCorner(atbTrack, UITheme.CornerRadius.Bar);
		this.applyStroke(atbTrack, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);

		const atbFill = new Instance("Frame");
		atbFill.Name = "AtbFill";
		atbFill.Position = UITheme.Layout.OriginPosition;
		atbFill.Size = UDim2.fromScale(0, 1);
		atbFill.BackgroundColor3 = isPlayer ? UITheme.Colors.AtbFillPlayer : UITheme.Colors.AtbFillOpponent;
		atbFill.BorderSizePixel = 0;
		atbFill.Parent = atbTrack;
		this.applyCorner(atbFill, UITheme.CornerRadius.Bar);

		this.createTextLabel(
			atbTrack,
			"AtbTitle",
			UITheme.Layout.BarLabelPos,
			UITheme.Layout.BarLabelSize,
			UITheme.Texts.AtbLabel,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Left,
		);

		const atbValueLabel = this.createTextLabel(
			atbTrack,
			"AtbValue",
			UITheme.Layout.BarValuePos,
			UITheme.Layout.BarValueSize,
			UITheme.Texts.FormatAtb(0, ATB_MAX),
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Right,
		);

		// Marcas visuais de custo de ATB (S1, S2, S3) na barra do player
		const atbMarkers: {
			readonly root: Frame;
			readonly line: Frame;
			readonly label: TextLabel;
		}[] = [];

		if (isPlayer) {
			for (const slot of [1, 2, 3] as const) {
				const defaultCost = UITheme.Numbers.DefaultSlotCosts[slot - 1];
				const markerRoot = new Instance("Frame");
				markerRoot.Name = `CostMarker_S${slot}`;
				markerRoot.AnchorPoint = UITheme.Layout.AtbMarkerLineAnchor;
				markerRoot.Position = UDim2.fromScale(clamp(defaultCost / ATB_MAX, 0.05, 0.95), 0.5);
				markerRoot.Size = UITheme.Layout.AtbMarkerLineSize;
				markerRoot.BackgroundTransparency = UITheme.Transparency.Hidden;
				markerRoot.ZIndex = 4;
				markerRoot.Parent = atbTrack;

				const markerLine = new Instance("Frame");
				markerLine.Name = "Line";
				markerLine.Size = UITheme.Layout.FullSize;
				markerLine.BackgroundColor3 = UITheme.Colors.AtbMarkerPending;
				markerLine.BorderSizePixel = 0;
				markerLine.ZIndex = 4;
				markerLine.Parent = markerRoot;

				const markerLabel = this.createTextLabel(
					markerRoot,
					"SlotLabel",
					UITheme.Layout.AtbMarkerLabelPos,
					UITheme.Layout.AtbMarkerLabelSize,
					`S${slot}`,
					UITheme.Fonts.Bold,
					UITheme.Colors.AtbMarkerPending,
					Enum.TextXAlignment.Center,
				);
				markerLabel.AnchorPoint = new Vector2(0.5, 0);
				markerLabel.ZIndex = 5;

				atbMarkers.push({ root: markerRoot, line: markerLine, label: markerLabel });
			}
		}

		return {
			root: card,
			iconBadge,
			iconLabel,
			nameLabel,
			metaLabel,
			hpFill,
			hpValueLabel,
			atbFill,
			atbValueLabel,
			statusBadges,
			atbMarkers,
		};
	}

	private createSessionControls(parent: GuiObject): void {
		const container = new Instance("Frame");
		container.Name = "SessionControls";
		container.AnchorPoint = UITheme.Layout.TopCenterAnchor;
		container.Position = UITheme.Layout.SessionControlsPos;
		container.Size = UITheme.Layout.SessionControlsSize;
		container.BackgroundTransparency = UITheme.Transparency.Hidden;
		container.Parent = parent;
		this.applyAspectRatio(container, UITheme.AspectRatios.SessionControls);

		const buttonsRow = new Instance("Frame");
		buttonsRow.Name = "ButtonsRow";
		buttonsRow.Position = UITheme.Layout.SessionButtonsRowPos;
		buttonsRow.Size = UITheme.Layout.SessionButtonsRowSize;
		buttonsRow.BackgroundTransparency = UITheme.Transparency.Hidden;
		buttonsRow.Parent = container;

		const pauseBtn = new Instance("TextButton");
		pauseBtn.Name = "PauseButton";
		pauseBtn.Position = UITheme.Layout.PauseButtonPos;
		pauseBtn.Size = UITheme.Layout.PauseButtonSize;
		pauseBtn.BackgroundColor3 = UITheme.Colors.PauseButtonBg;
		pauseBtn.Font = UITheme.Fonts.Bold;
		pauseBtn.TextColor3 = UITheme.Colors.TextPrimary;
		pauseBtn.TextScaled = true;
		pauseBtn.Text = UITheme.Texts.PauseButton;
		pauseBtn.AutoButtonColor = true;
		pauseBtn.Parent = buttonsRow;
		this.applyCorner(pauseBtn, UITheme.CornerRadius.Button);
		this.applyStroke(pauseBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);
		this.pauseButton = pauseBtn;

		pauseBtn.Activated.Connect(() => {
			this.handlePauseClicked();
		});

		const quitBtn = new Instance("TextButton");
		quitBtn.Name = "QuitButton";
		quitBtn.Position = UITheme.Layout.QuitButtonWithPausePos;
		quitBtn.Size = UITheme.Layout.QuitButtonWithPauseSize;
		quitBtn.BackgroundColor3 = UITheme.Colors.QuitButtonBg;
		quitBtn.Font = UITheme.Fonts.Bold;
		quitBtn.TextColor3 = UITheme.Colors.TextPrimary;
		quitBtn.TextScaled = true;
		quitBtn.Text = UITheme.Texts.QuitButton;
		quitBtn.AutoButtonColor = true;
		quitBtn.Parent = buttonsRow;
		this.applyCorner(quitBtn, UITheme.CornerRadius.Button);
		this.applyStroke(quitBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);
		this.quitButton = quitBtn;

		quitBtn.Activated.Connect(() => {
			this.handleQuitClicked();
		});

		const stateBanner = this.createTextLabel(
			container,
			"StateBanner",
			UITheme.Layout.StateBannerPos,
			UITheme.Layout.StateBannerSize,
			`${UITheme.Texts.StatePrefix}IDLE`,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Center,
		);
		stateBanner.BackgroundColor3 = UITheme.Colors.PanelBackground;
		stateBanner.BackgroundTransparency = UITheme.Transparency.SecondaryPanel;
		this.applyCorner(stateBanner, UITheme.CornerRadius.Badge);
		this.stateBannerLabel = stateBanner;
	}

	private createTagPanel(parent: GuiObject): void {
		const panel = new Instance("Frame");
		panel.Name = "TagPanel";
		panel.AnchorPoint = UITheme.Layout.BottomLeftAnchor;
		panel.Position = UITheme.Layout.TagPanelPos;
		panel.Size = UITheme.Layout.TagPanelSize;
		panel.BackgroundColor3 = UITheme.Colors.PanelBackground;
		panel.BackgroundTransparency = UITheme.Transparency.Panel;
		panel.Parent = parent;
		this.applyCorner(panel, UITheme.CornerRadius.Panel);
		this.applyStroke(panel, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);
		this.applyAspectRatio(panel, UITheme.AspectRatios.TagPanel);

		this.createTextLabel(
			panel,
			"TagHeader",
			UITheme.Layout.TagHeaderPos,
			UITheme.Layout.TagHeaderSize,
			UITheme.Texts.TagHeader,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Left,
		);

		const rootBanner = this.createTextLabel(
			panel,
			"RootLockBanner",
			UITheme.Layout.RootLockBannerPos,
			UITheme.Layout.RootLockBannerSize,
			UITheme.Texts.RootLockedBanner,
			UITheme.Fonts.Bold,
			UITheme.Colors.TagRootLockText,
			Enum.TextXAlignment.Center,
		);
		rootBanner.BackgroundColor3 = UITheme.Colors.TagRootLockBg;
		rootBanner.BackgroundTransparency = UITheme.Transparency.Opaque;
		rootBanner.Visible = false;
		this.applyCorner(rootBanner, UITheme.CornerRadius.Badge);
		this.rootLockBanner = rootBanner;

		const slotsContainer = new Instance("Frame");
		slotsContainer.Name = "SlotsContainer";
		slotsContainer.Position = UITheme.Layout.TagSlotsContainerPos;
		slotsContainer.Size = UITheme.Layout.TagSlotsContainerSize;
		slotsContainer.BackgroundTransparency = UITheme.Transparency.Hidden;
		slotsContainer.Parent = panel;

		for (const slotIdx of [1, 2, 3] as const) {
			const xPos = (slotIdx - 1) * (UITheme.Layout.TagSlotWidthScale + UITheme.Layout.TagSlotGapScale);
			const btn = new Instance("TextButton");
			btn.Name = `TagSlot_${slotIdx}`;
			btn.Position = UDim2.fromScale(xPos, 0);
			btn.Size = UDim2.fromScale(UITheme.Layout.TagSlotWidthScale, 1);
			btn.BackgroundColor3 = UITheme.Colors.TagReadyBg;
			btn.Text = "";
			btn.AutoButtonColor = false;
			btn.Parent = slotsContainer;
			this.applyCorner(btn, UITheme.CornerRadius.Button);
			const stroke = this.applyStroke(btn, UITheme.Colors.TagReadyStroke, UITheme.StrokeThickness.Normal);

			const badge = new Instance("Frame");
			badge.Name = "SlotBadge";
			badge.Position = UITheme.Layout.TagSlotBadgePos;
			badge.Size = UITheme.Layout.TagSlotBadgeSize;
			badge.BackgroundColor3 = UITheme.Colors.PanelSecondary;
			badge.Parent = btn;
			this.applyCorner(badge, UITheme.CornerRadius.Badge);
			this.applyAspectRatio(badge, UITheme.AspectRatios.IconBadge);

			const badgeLabel = this.createTextLabel(
				badge,
				"IndexLabel",
				UITheme.Layout.OriginPosition,
				UITheme.Layout.FullSize,
				`${slotIdx}`,
				UITheme.Fonts.Bold,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Center,
			);

			const nameLabel = this.createTextLabel(
				btn,
				"FighterName",
				UITheme.Layout.TagSlotNamePos,
				UITheme.Layout.TagSlotNameSize,
				`#${slotIdx}`,
				UITheme.Fonts.Bold,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Left,
			);

			const hpTrack = new Instance("Frame");
			hpTrack.Name = "MiniHpTrack";
			hpTrack.Position = UITheme.Layout.TagSlotHpBarPos;
			hpTrack.Size = UITheme.Layout.TagSlotHpBarSize;
			hpTrack.BackgroundColor3 = UITheme.Colors.BarTrack;
			hpTrack.BorderSizePixel = 0;
			hpTrack.Parent = btn;
			this.applyCorner(hpTrack, UITheme.CornerRadius.Bar);

			const hpFill = new Instance("Frame");
			hpFill.Name = "MiniHpFill";
			hpFill.Position = UITheme.Layout.OriginPosition;
			hpFill.Size = UITheme.Layout.FullSize;
			hpFill.BackgroundColor3 = UITheme.Colors.HpFillHigh;
			hpFill.BorderSizePixel = 0;
			hpFill.Parent = hpTrack;
			this.applyCorner(hpFill, UITheme.CornerRadius.Bar);

			const statusLabel = this.createTextLabel(
				btn,
				"StatusText",
				UITheme.Layout.TagSlotStatusPos,
				UITheme.Layout.TagSlotStatusSize,
				UITheme.Texts.TagReadyStatus,
				UITheme.Fonts.Bold,
				UITheme.Colors.TextSecondary,
				Enum.TextXAlignment.Center,
			);

			const deadCrossLabel = this.createTextLabel(
				btn,
				"DeadCross",
				UITheme.Layout.TagDeadCrossPos,
				UITheme.Layout.TagDeadCrossSize,
				UITheme.Texts.TagDeadCross,
				UITheme.Fonts.Title,
				UITheme.Colors.TagDeadCross,
				Enum.TextXAlignment.Center,
			);
			deadCrossLabel.AnchorPoint = UITheme.Layout.CenterAnchor;
			deadCrossLabel.Visible = false;
			deadCrossLabel.ZIndex = 6;

			btn.Activated.Connect(() => {
				this.handleTagSlotClicked(slotIdx);
			});

			this.tagSlotWidgets.push({
				index: slotIdx,
				button: btn,
				stroke,
				badge,
				badgeLabel,
				nameLabel,
				hpFill,
				statusLabel,
				deadCrossLabel,
			});
		}
	}

	private createSkillsPanel(parent: GuiObject): void {
		const panel = new Instance("Frame");
		panel.Name = "SkillsPanel";
		panel.AnchorPoint = UITheme.Layout.BottomRightAnchor;
		panel.Position = UITheme.Layout.SkillsPanelPos;
		panel.Size = UITheme.Layout.SkillsPanelSize;
		panel.BackgroundColor3 = UITheme.Colors.PanelBackground;
		panel.BackgroundTransparency = UITheme.Transparency.Panel;
		panel.Parent = parent;
		this.applyCorner(panel, UITheme.CornerRadius.Panel);
		this.applyStroke(panel, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);
		this.applyAspectRatio(panel, UITheme.AspectRatios.SkillsPanel);

		this.createTextLabel(
			panel,
			"SkillsHeader",
			UITheme.Layout.SkillsHeaderPos,
			UITheme.Layout.SkillsHeaderSize,
			UITheme.Texts.SkillsHeader,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Left,
		);

		const buttonsContainer = new Instance("Frame");
		buttonsContainer.Name = "ButtonsContainer";
		buttonsContainer.Position = UITheme.Layout.SkillButtonsContainerPos;
		buttonsContainer.Size = UITheme.Layout.SkillButtonsContainerSize;
		buttonsContainer.BackgroundTransparency = UITheme.Transparency.Hidden;
		buttonsContainer.Parent = panel;

		for (const slot of [1, 2, 3] as const) {
			const xPos = (slot - 1) * (UITheme.Layout.SkillButtonWidthScale + UITheme.Layout.SkillButtonGapScale);
			const btn = new Instance("TextButton");
			btn.Name = `SkillButton_S${slot}`;
			btn.Position = UDim2.fromScale(xPos, 0);
			btn.Size = UDim2.fromScale(UITheme.Layout.SkillButtonWidthScale, 1);
			btn.BackgroundColor3 = UITheme.Colors.SkillDisabledBg;
			btn.Text = "";
			btn.AutoButtonColor = false;
			btn.Parent = buttonsContainer;
			this.applyCorner(btn, UITheme.CornerRadius.Button);
			const stroke = this.applyStroke(btn, UITheme.Colors.SkillDisabledStroke, UITheme.StrokeThickness.Thick);

			const slotTag = this.createTextLabel(
				btn,
				"SlotTag",
				UITheme.Layout.SkillSlotTagPos,
				UITheme.Layout.SkillSlotTagSize,
				`S${slot}`,
				UITheme.Fonts.Title,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Left,
			);

			const costLabel = this.createTextLabel(
				btn,
				"CostLabel",
				UITheme.Layout.SkillCostTagPos,
				UITheme.Layout.SkillCostTagSize,
				UITheme.Texts.FormatCost(UITheme.Numbers.DefaultSlotCosts[slot - 1]),
				UITheme.Fonts.Bold,
				UITheme.Colors.AtbMarkerReached,
				Enum.TextXAlignment.Right,
			);

			const nameLabel = this.createTextLabel(
				btn,
				"SkillName",
				UITheme.Layout.SkillNamePos,
				UITheme.Layout.SkillNameSize,
				`Skill ${slot}`,
				UITheme.Fonts.Bold,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Center,
			);

			const stateLabel = this.createTextLabel(
				btn,
				"SkillState",
				UITheme.Layout.SkillStatePos,
				UITheme.Layout.SkillStateSize,
				UITheme.Texts.SkillNoAtbState,
				UITheme.Fonts.Medium,
				UITheme.Colors.TextSecondary,
				Enum.TextXAlignment.Center,
			);

			btn.Activated.Connect(() => {
				this.handleSkillButtonClicked(slot);
			});

			this.skillButtonWidgets.push({
				slot,
				button: btn,
				stroke,
				slotTag,
				costLabel,
				nameLabel,
				stateLabel,
			});
		}
	}

	private createPauseOverlay(parent: ScreenGui): void {
		const backdrop = new Instance("Frame");
		backdrop.Name = "PauseOverlay";
		backdrop.Position = UITheme.Layout.OriginPosition;
		backdrop.Size = UITheme.Layout.FullSize;
		backdrop.BackgroundColor3 = UITheme.Colors.OverlayBackdrop;
		backdrop.BackgroundTransparency = UITheme.Transparency.ModalBackdrop;
		backdrop.Visible = false;
		backdrop.ZIndex = 20;
		backdrop.Parent = parent;
		this.pauseOverlay = backdrop;

		const card = new Instance("Frame");
		card.Name = "PauseModalCard";
		card.AnchorPoint = UITheme.Layout.CenterAnchor;
		card.Position = UITheme.Layout.CenterPosition;
		card.Size = UITheme.Layout.ModalCardSize;
		card.BackgroundColor3 = UITheme.Colors.PanelBackground;
		card.ZIndex = 21;
		card.Parent = backdrop;
		this.applyCorner(card, UITheme.CornerRadius.Modal);
		this.applyStroke(card, UITheme.Colors.PauseActiveBg, UITheme.StrokeThickness.Thick);
		this.applyAspectRatio(card, UITheme.AspectRatios.ModalCard);

		const title = this.createTextLabel(
			card,
			"PausedTitle",
			UITheme.Layout.ModalTitlePos,
			UITheme.Layout.ModalTitleSize,
			UITheme.Texts.PausedOverlayTitle,
			UITheme.Fonts.Title,
			UITheme.Colors.PauseActiveBg,
			Enum.TextXAlignment.Center,
		);
		title.ZIndex = 22;

		const subtitle = this.createTextLabel(
			card,
			"PausedSubtitle",
			UITheme.Layout.ModalSubtitlePos,
			UITheme.Layout.ModalSubtitleSize,
			UITheme.Texts.PausedOverlaySubtitle,
			UITheme.Fonts.Medium,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Center,
		);
		subtitle.ZIndex = 22;

		const resumeBtn = new Instance("TextButton");
		resumeBtn.Name = "ResumeButton";
		resumeBtn.Position = UITheme.Layout.ModalPrimaryButtonPos;
		resumeBtn.Size = UITheme.Layout.ModalPrimaryButtonSize;
		resumeBtn.BackgroundColor3 = UITheme.Colors.ActionButtonPrimary;
		resumeBtn.Font = UITheme.Fonts.Bold;
		resumeBtn.TextColor3 = UITheme.Colors.TextPrimary;
		resumeBtn.TextScaled = true;
		resumeBtn.Text = UITheme.Texts.PausedOverlayResumeButton;
		resumeBtn.ZIndex = 22;
		resumeBtn.Parent = card;
		this.applyCorner(resumeBtn, UITheme.CornerRadius.Button);
		this.applyStroke(resumeBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);

		resumeBtn.Activated.Connect(() => {
			this.handlePauseClicked();
		});
	}

	private createResultOverlay(parent: ScreenGui): void {
		const backdrop = new Instance("Frame");
		backdrop.Name = "ResultOverlay";
		backdrop.Position = UITheme.Layout.OriginPosition;
		backdrop.Size = UITheme.Layout.FullSize;
		backdrop.BackgroundColor3 = UITheme.Colors.OverlayBackdrop;
		backdrop.BackgroundTransparency = UITheme.Transparency.ModalBackdrop;
		backdrop.Visible = false;
		backdrop.ZIndex = 30;
		backdrop.Parent = parent;
		this.resultOverlay = backdrop;

		const card = new Instance("Frame");
		card.Name = "ResultModalCard";
		card.AnchorPoint = UITheme.Layout.CenterAnchor;
		card.Position = UITheme.Layout.CenterPosition;
		card.Size = UITheme.Xp.ModalSize;
		card.BackgroundColor3 = UITheme.Colors.PanelBackground;
		card.ZIndex = 31;
		card.Parent = backdrop;
		this.applyCorner(card, UITheme.CornerRadius.Modal);
		this.resultCardStroke = this.applyStroke(card, UITheme.Colors.VictoryAccent, UITheme.StrokeThickness.Thick);


		const titleLabel = this.createTextLabel(
			card,
			"ResultTitle",
			UITheme.Xp.TitlePos,
			UITheme.Xp.TitleSize,
			UITheme.Texts.VictoryTitle,
			UITheme.Fonts.Title,
			UITheme.Colors.VictoryAccent,
			Enum.TextXAlignment.Center,
		);
		titleLabel.ZIndex = 32;
		this.resultTitleLabel = titleLabel;

		const rewardLabel = this.createTextLabel(
			card,
			"RewardText",
			UITheme.Xp.RewardPos,
			UITheme.Xp.RewardSize,
			UITheme.Texts.FormatReward(0),
			UITheme.Fonts.Bold,
			UITheme.Colors.RewardGold,
			Enum.TextXAlignment.Center,
		);
		rewardLabel.ZIndex = 32;
		this.resultRewardLabel = rewardLabel;

		const actionBtn = new Instance("TextButton");
		actionBtn.Name = "CloseRestartButton";
		actionBtn.Position = UITheme.Xp.ButtonPos;
		actionBtn.Size = UITheme.Xp.ButtonSize;
		actionBtn.BackgroundColor3 = UITheme.Colors.ActionButtonPrimary;
		actionBtn.Font = UITheme.Fonts.Bold;
		actionBtn.TextColor3 = UITheme.Colors.TextPrimary;
		actionBtn.TextScaled = true;
		actionBtn.Text = UITheme.Texts.ResultCloseAndRestartButton;
		actionBtn.ZIndex = 32;
		actionBtn.Parent = card;
		this.applyCorner(actionBtn, UITheme.CornerRadius.Button);
		this.applyStroke(actionBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);

        const close = actionBtn.Clone();
        close.Name = "ExitResultButton";
        close.Text = "X";
        close.Position = UITheme.Xp.ClosePos;
        close.Size = UITheme.Xp.CloseSize;
        close.Parent = card;
        close.Activated.Connect(() => {
            if (!this.hasResultGui()) return;
            this.clearHpTweens();
            this.xpCards.clear();
            backdrop.Visible = false;
            if (this.screenGui) this.screenGui.Enabled = false;
        });
		actionBtn.Activated.Connect(() => {
			this.handleResultCloseAndRestart();
		});
	}

    private hasResultGui(): boolean {
        const gui = this.screenGui;
        const overlay = this.resultOverlay;
        if (gui === undefined || gui.Parent === undefined || overlay === undefined || overlay.Parent !== gui) return false;
        const modal = overlay.FindFirstChild("ResultModalCard");
        return modal !== undefined && modal.IsA("Frame") && modal.Parent === overlay;
    }
	private onBattleStarted(payload: BattleStartedPayload): void {
        if (!this.hasResultGui()) { this.clearHpTweens(); this.xpCards.clear(); return; }
		this.clearHpTweens();
            this.xpCards.clear();
        if (this.screenGui) this.screenGui.DisplayOrder = UITheme.DisplayOrder;
		this.fightersByTargetId.clear();
		this.playerTeamOrder.clear();
		this.opponentTeamOrder.clear();

		this.sideIds = payload.sides;
		this.battleState = "IDLE";
		this.canPause = payload.canPause === true || payload.mode === "PVE";
		this.isPaused = false;
		this.lastPauseToggleClock = 0;
		this.resetQuitConfirmState();
		this.battleActive = true;
		this.battleEnded = false;

		this.playerTargetAtb = 0;
		this.playerDisplayAtb = 0;
		this.opponentTargetAtb = 0;
		this.opponentDisplayAtb = 0;

		let playerSlotCounter = 0;
		let opponentSlotCounter = 0;

		for (const snapshot of payload.fighters) {
			const isPlayerSide = snapshot.sideId === payload.sides[0];
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
		const lowerId = snapshot.fighterId.lower() as RealFighterId;
		let displayName = snapshot.fighterId;
		let skillTemplates: SkillDataSlots = JOTARO_SKILL_DATA;

		if (lowerId in FIGHTER_DATA) {
			const def = FIGHTER_DATA[lowerId];
			displayName = def.name;
			skillTemplates = def.skills;
		} else if (lowerId === "anubis") {
			displayName = "Anubis";
			skillTemplates = ANUBIS_SKILL_DATA;
		} else if (snapshot.fighterId.size() > 0) {
			displayName = snapshot.fighterId.sub(1, 1).upper() + snapshot.fighterId.sub(2);
		}

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
		};
	}

	private onStateChanged(payload: StateChangedPayload): void {
		if (!this.battleActive || this.battleEnded) return;
		this.clearPauseIfServerProgressed();
		this.battleState = payload.state;
		this.refreshStateBanner();
		this.refreshSkillButtons();
		this.refreshTagSlots();
	}

	private onAtbSync(payload: AtbSyncPayload): void {
		if (!this.battleActive || this.battleEnded) return;
		this.clearPauseIfServerProgressed();
		const clampedAtb = clamp(payload.atb, ATB_MIN, ATB_MAX);
		if (payload.sideId === this.sideIds[0]) {
			this.playerTargetAtb = clampedAtb;
			this.refreshPlayerAtbMarkersAndSkills();
		} else if (payload.sideId === this.sideIds[1]) {
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
		this.refreshActiveStatusCards();
		this.refreshTagSlots();
	}

	private onEffectExpired(payload: EffectExpiredPayload): void {
		if (!this.battleActive) return;
		const fighter = this.fightersByTargetId.get(payload.targetId);
		if (fighter === undefined) return;
		fighter.effects.delete(payload.effect);
		this.refreshActiveStatusCards();
		this.refreshTagSlots();
	}

	private applyVisualHpUpdate(targetId: string, hp: number, hpMax: number): void {
		const fighter = this.fightersByTargetId.get(targetId);
		if (fighter === undefined) return;
		fighter.hp = clamp(hp, 0, hpMax);
		fighter.hpMax = hpMax;
		this.refreshActiveStatusCards();
		this.refreshTagSlots();
	}

	private applyVisualDeathAndAutoSwitch(payload: FighterDiedPayload): void {
		const deadFighter = this.fightersByTargetId.get(payload.fighterId);
		if (deadFighter !== undefined) {
			deadFighter.dead = true;
			deadFighter.active = false;
			deadFighter.hp = 0;
			deadFighter.effects.clear();
		}

		// Regra do jogo: morte zera ATB do lado e troca automaticamente para nextActive
		if (payload.sideId === this.sideIds[0]) {
			this.playerTargetAtb = 0;
			this.playerDisplayAtb = 0;
		} else if (payload.sideId === this.sideIds[1]) {
			this.opponentTargetAtb = 0;
			this.opponentDisplayAtb = 0;
		}

		if (payload.nextActive !== undefined) {
			const nextFighter = this.fightersByTargetId.get(payload.nextActive);
			if (nextFighter !== undefined && !nextFighter.dead) {
				nextFighter.active = true;
			}
		}

		this.refreshAllVisuals();
	}

	private onBattleEnded(payload: BattleEndedPayload): void {
        if (!this.hasResultGui()) { this.clearHpTweens(); this.xpCards.clear(); return; }
		this.clearHpTweens();
        if (this.screenGui) this.screenGui.DisplayOrder = UITheme.Xp.ResultDisplayOrder;
		this.xpCards.show(this.resultOverlay, payload.xpRewards);
		this.battleEnded = true;
		this.battleActive = false;
		this.isPaused = false;
		this.resetQuitConfirmState();

		if (this.pauseOverlay !== undefined) {
			this.pauseOverlay.Visible = false;
		}

		const isVictory = payload.winnerSideId !== undefined && payload.winnerSideId === this.sideIds[0];
		if (this.resultTitleLabel !== undefined) {
			this.resultTitleLabel.Text = isVictory ? UITheme.Texts.VictoryTitle : UITheme.Texts.DefeatTitle;
			this.resultTitleLabel.TextColor3 = isVictory
				? UITheme.Colors.VictoryAccent
				: UITheme.Colors.DefeatAccent;
		}
		if (this.resultCardStroke !== undefined) {
			this.resultCardStroke.Color = isVictory
				? UITheme.Colors.VictoryAccent
				: UITheme.Colors.DefeatAccent;
		}
		if (this.resultRewardLabel !== undefined) {
			this.resultRewardLabel.Text = UITheme.Texts.FormatReward(payload.tinyesReward ?? 0);
		}
		if (this.resultOverlay !== undefined) {
			this.resultOverlay.Visible = true;
		}

		this.refreshSkillButtons();
		this.refreshTagSlots();
	}

	private handleSkillButtonClicked(slot: SkillSlot): void {
		if (!this.battleActive || this.battleEnded || this.isPaused) return;
		if (this.battleState !== "IDLE") return;
		const activePlayerFighter = this.getActiveFighterForSide(0);
		if (activePlayerFighter === undefined || activePlayerFighter.dead) return;
		if (slot === 3 && !activePlayerFighter.s3Unlocked) return;

		const cost = activePlayerFighter.slotCosts[slot - 1];
		if (this.playerTargetAtb + FLOAT_TOLERANCE < cost) return;

		BattleRemotes.requestSkill.FireServer({ slot });
	}

	private handleTagSlotClicked(index: ClientFighterIndex): void {
		if (!this.battleActive || this.battleEnded || this.isPaused) return;
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
		if (!this.battleActive || this.battleEnded) return;

		if (!this.quitConfirmPending) {
			this.quitConfirmPending = true;
			this.quitConfirmToken += 1;
			const token = this.quitConfirmToken;
			if (this.quitButton !== undefined) {
				this.quitButton.Text = UITheme.Texts.QuitConfirmButton;
				this.quitButton.BackgroundColor3 = UITheme.Colors.QuitConfirmBg;
			}
			task.delay(UITheme.Numbers.QuitConfirmTimeoutSeconds, () => {
				if (this.quitConfirmToken === token && this.quitConfirmPending && this.quitButton !== undefined && this.quitButton.Parent !== undefined) {
					this.resetQuitConfirmState();
				}
			});
			return;
		}

		this.resetQuitConfirmState();
		BattleRemotes.requestQuit.FireServer();
	}

	private handleResultCloseAndRestart(): void {
		this.clearHpTweens();
            this.xpCards.clear();
		if (this.resultOverlay !== undefined) {
			this.resultOverlay.Visible = false;
		}
		// Tenta disparar o comando dev /testbattle no Studio (TextChatService ou LegacyChatService)
		pcall(() => {
			const textChannels = TextChatService.FindFirstChild("TextChannels");
			const general = textChannels?.FindFirstChild("RBXGeneral") as TextChannel | undefined;
			if (general !== undefined) {
				general.SendAsync(DEV_TEST_BATTLE_CHAT_COMMAND);
				return;
			}
			const legacyEvents = ReplicatedStorage.FindFirstChild("DefaultChatSystemChatEvents");
			const sayMessage = legacyEvents?.FindFirstChild("SayMessageRequest") as RemoteEvent | undefined;
			if (sayMessage !== undefined) {
				sayMessage.FireServer(DEV_TEST_BATTLE_CHAT_COMMAND, "All");
			}
		});
	}

	private resetQuitConfirmState(): void {
		this.quitConfirmPending = false;
		this.quitConfirmToken += 1;
		if (this.quitButton !== undefined) {
			this.quitButton.Text = UITheme.Texts.QuitButton;
			this.quitButton.BackgroundColor3 = UITheme.Colors.QuitButtonBg;
		}
	}

	private clearPauseIfServerProgressed(): void {
		// Se o servidor voltou a emitir ticks/estados (ex.: estourou os 120s de pause), sincroniza o client
		if (this.isPaused && os.clock() - this.lastPauseToggleClock > 0.35) {
			this.isPaused = false;
			this.refreshPauseVisuals();
		}
	}

	private refreshSessionControlsLayout(): void {
		if (this.pauseButton === undefined || this.quitButton === undefined) return;
		if (this.canPause) {
			this.pauseButton.Visible = true;
			this.quitButton.Position = UITheme.Layout.QuitButtonWithPausePos;
			this.quitButton.Size = UITheme.Layout.QuitButtonWithPauseSize;
		} else {
			this.pauseButton.Visible = false;
			this.quitButton.Position = UITheme.Layout.QuitButtonSoloPos;
			this.quitButton.Size = UITheme.Layout.QuitButtonSoloSize;
		}
		this.refreshPauseVisuals();
	}

	private refreshPauseVisuals(): void {
		if (this.pauseOverlay !== undefined) {
			this.pauseOverlay.Visible = this.canPause && this.isPaused && !this.battleEnded;
		}
		if (this.pauseButton !== undefined) {
			this.pauseButton.Text = this.isPaused ? UITheme.Texts.ResumeButton : UITheme.Texts.PauseButton;
			this.pauseButton.BackgroundColor3 = this.isPaused
				? UITheme.Colors.PauseActiveBg
				: UITheme.Colors.PauseButtonBg;
		}
	}

	private refreshAllVisuals(): void {
		this.refreshStateBanner();
		this.refreshActiveStatusCards();
		this.refreshPlayerAtbMarkersAndSkills();
		this.refreshTagSlots();
		this.refreshPauseVisuals();
	}

	private refreshStateBanner(): void {
		if (this.stateBannerLabel === undefined) return;
		this.stateBannerLabel.Text = `${UITheme.Texts.StatePrefix}${this.battleState}`;
	}

	private refreshActiveStatusCards(): void {
		const activePlayer = this.getActiveFighterForSide(0);
		const activeOpponent = this.getActiveFighterForSide(1);
		if (this.playerCard !== undefined && activePlayer !== undefined) {
			this.populateStatusCard(this.playerCard, activePlayer, true);
		}
		if (this.opponentCard !== undefined && activeOpponent !== undefined) {
			this.populateStatusCard(this.opponentCard, activeOpponent, false);
		}
	}

	private populateStatusCard(card: StatusCardWidgets, fighter: HudFighterState, isPlayer: boolean): void {
		card.iconBadge.BackgroundColor3 = UITheme.ClassColors[fighter.className];
		card.iconLabel.Text = fighter.iconText;
		card.nameLabel.Text = fighter.displayName;
		const sideTag = isPlayer ? UITheme.Texts.PlayerSideTag : UITheme.Texts.OpponentSideTag;
		card.metaLabel.Text = `${sideTag} • ${fighter.className} ${UITheme.Texts.LevelPrefix}${fighter.level}`;

		const hpRatio = fighter.hpMax > 0 ? clamp(fighter.hp / fighter.hpMax, 0, 1) : 0;
		const hpColor = this.resolveHpColor(hpRatio);
		card.hpFill.BackgroundColor3 = hpColor;
		this.hpTweens.get(card.hpFill)?.Cancel();
        const hpTween = TweenService.Create(
			card.hpFill,
			new TweenInfo(UITheme.Numbers.HpTweenSeconds, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ Size: UDim2.fromScale(hpRatio, 1) },
		);
        this.hpTweens.set(card.hpFill, hpTween);
        hpTween.Play();
		card.hpValueLabel.Text = UITheme.Texts.FormatHp(fighter.hp, fighter.hpMax);

		for (const effect of ["Burn", "Bleed", "Root"] as const) {
			card.statusBadges[effect].Visible = fighter.effects.has(effect);
		}

		if (isPlayer) {
			for (const slot of [1, 2, 3] as const) {
				const marker = card.atbMarkers[slot - 1];
				const cost = fighter.slotCosts[slot - 1];
				const ratio = clamp(cost / ATB_MAX, 0.04, 0.96);
				marker.root.Position = UDim2.fromScale(ratio, 0.5);
				marker.label.Text = `S${slot}`;
			}
		}
	}

	private refreshPlayerAtbMarkersAndSkills(): void {
		const activePlayer = this.getActiveFighterForSide(0);
		if (this.playerCard !== undefined && activePlayer !== undefined) {
			for (const slot of [1, 2, 3] as const) {
				const marker = this.playerCard.atbMarkers[slot - 1];
				const cost = activePlayer.slotCosts[slot - 1];
				const reached = this.playerTargetAtb + FLOAT_TOLERANCE >= cost;
				const locked = slot === 3 && !activePlayer.s3Unlocked;
				const color = locked ? UITheme.Colors.TextMuted : reached ? UITheme.Colors.AtbMarkerReached : UITheme.Colors.AtbMarkerPending;
				const transparency = locked ? UITheme.Transparency.LockedSkillMarker : UITheme.Transparency.Opaque;
				marker.line.BackgroundTransparency = transparency;
				marker.label.TextTransparency = transparency;
				marker.line.BackgroundColor3 = color;
				marker.label.TextColor3 = color;
			}
		}
		this.refreshSkillButtons();
	}

	private refreshSkillButtons(): void {
		const activePlayer = this.getActiveFighterForSide(0);
		for (const widget of this.skillButtonWidgets) {
			const slotIndex = widget.slot - 1;
			const skillName = activePlayer?.skillNames[slotIndex] ?? `Skill ${widget.slot}`;
			const cost = activePlayer?.slotCosts[slotIndex] ?? UITheme.Numbers.DefaultSlotCosts[slotIndex];

			widget.nameLabel.Text = skillName;
			widget.costLabel.Text = UITheme.Texts.FormatCost(cost);

			const isIdle = this.battleState === "IDLE" && !this.isPaused && this.battleActive && !this.battleEnded;
			const hasAtb = this.playerTargetAtb + FLOAT_TOLERANCE >= cost;
			const locked = widget.slot === 3 && activePlayer?.s3Unlocked !== true;
			const isEnabled = !locked && isIdle && hasAtb && activePlayer !== undefined && !activePlayer.dead;

			widget.button.Active = isEnabled;
			widget.costLabel.TextColor3 = locked ? UITheme.Colors.TextMuted : UITheme.Colors.AtbMarkerReached;
			widget.slotTag.TextColor3 = locked ? UITheme.Colors.TextMuted : UITheme.Colors.TextPrimary;
			if (isEnabled) {
				widget.button.BackgroundColor3 = UITheme.Colors.SkillSlotAccents[widget.slot];
				widget.button.BackgroundTransparency = UITheme.Transparency.Opaque;
				widget.stroke.Color = UITheme.Colors.TextPrimary;
				widget.nameLabel.TextColor3 = UITheme.Colors.TextPrimary;
				widget.stateLabel.Text = UITheme.Texts.SkillReadyState;
				widget.stateLabel.TextColor3 = UITheme.Colors.TextPrimary;
			} else {
				widget.button.BackgroundColor3 = UITheme.Colors.SkillDisabledBg;
				widget.button.BackgroundTransparency = UITheme.Transparency.DisabledButton;
				widget.stroke.Color = UITheme.Colors.SkillDisabledStroke;
				widget.nameLabel.TextColor3 = UITheme.Colors.TextSecondary;
				widget.stateLabel.Text = locked ? UITheme.Texts.SkillLockedState : !hasAtb ? UITheme.Texts.SkillNoAtbState : UITheme.Texts.SkillBusyState;
				widget.stateLabel.TextColor3 = UITheme.Colors.TextMuted;
			}
		}
	}

	private refreshTagSlots(): void {
		const activePlayer = this.getActiveFighterForSide(0);
		const isActiveRooted = activePlayer !== undefined && activePlayer.effects.has("Root");

		if (this.rootLockBanner !== undefined) {
			this.rootLockBanner.Visible = isActiveRooted;
		}

		for (const widget of this.tagSlotWidgets) {
			const targetId = this.playerTeamOrder[widget.index - 1];
			const fighter = targetId !== undefined ? this.fightersByTargetId.get(targetId) : undefined;
			if (fighter === undefined) {
				widget.button.Visible = false;
				continue;
			}
			widget.button.Visible = true;
			widget.nameLabel.Text = fighter.displayName;
			widget.badge.BackgroundColor3 = fighter.dead
				? UITheme.Colors.TagDeadBg
				: UITheme.ClassColors[fighter.className];

			const hpRatio = fighter.hpMax > 0 ? clamp(fighter.hp / fighter.hpMax, 0, 1) : 0;
			widget.hpFill.Size = UDim2.fromScale(hpRatio, 1);
			widget.hpFill.BackgroundColor3 = this.resolveHpColor(hpRatio);

			if (fighter.dead) {
				widget.button.Active = false;
				widget.button.BackgroundColor3 = UITheme.Colors.TagDeadBg;
				widget.button.BackgroundTransparency = UITheme.Transparency.DeadSlot;
				widget.stroke.Color = UITheme.Colors.TagDeadStroke;
				widget.nameLabel.TextColor3 = UITheme.Colors.TextMuted;
				widget.statusLabel.Text = UITheme.Texts.TagDeadStatus;
				widget.statusLabel.TextColor3 = UITheme.Colors.TagDeadCross;
				widget.deadCrossLabel.Visible = true;
				continue;
			}

			widget.deadCrossLabel.Visible = false;

			if (fighter.active) {
				widget.button.Active = false;
				widget.button.BackgroundColor3 = UITheme.Colors.TagActiveBg;
				widget.button.BackgroundTransparency = UITheme.Transparency.Opaque;
				widget.stroke.Color = UITheme.Colors.TagActiveStroke;
				widget.nameLabel.TextColor3 = UITheme.Colors.TextPrimary;
				widget.statusLabel.Text = UITheme.Texts.TagActiveStatus;
				widget.statusLabel.TextColor3 = UITheme.Colors.TagActiveStroke;
				continue;
			}

			const canSwitchNow =
				this.battleActive &&
				!this.battleEnded &&
				!this.isPaused &&
				this.battleState === "IDLE" &&
				!isActiveRooted;

			widget.button.Active = canSwitchNow;
			widget.button.BackgroundColor3 = isActiveRooted
				? UITheme.Colors.TagRootLockBg
				: UITheme.Colors.TagReadyBg;
			widget.button.BackgroundTransparency = canSwitchNow
				? UITheme.Transparency.Opaque
				: UITheme.Transparency.DisabledButton;
			widget.stroke.Color = canSwitchNow
				? UITheme.Colors.TagReadyStroke
				: UITheme.Colors.SkillDisabledStroke;
			widget.nameLabel.TextColor3 = canSwitchNow
				? UITheme.Colors.TextPrimary
				: UITheme.Colors.TextSecondary;

			if (isActiveRooted) {
				widget.statusLabel.Text = UITheme.Texts.TagLockedStatus;
				widget.statusLabel.TextColor3 = UITheme.Colors.TagRootLockText;
			} else if (canSwitchNow) {
				widget.statusLabel.Text = UITheme.Texts.TagReadyStatus;
				widget.statusLabel.TextColor3 = UITheme.Colors.HpFillHigh;
			} else {
				widget.statusLabel.Text = UITheme.Texts.TagWaitStatus;
				widget.statusLabel.TextColor3 = UITheme.Colors.TextMuted;
			}
		}
	}

	private stepAtbInterpolation(dt: number): void {
		if (!this.battleActive) return;
		const alpha = clamp(dt * UITheme.Numbers.AtbSmoothingSpeed, 0, 1);
		this.playerDisplayAtb += (this.playerTargetAtb - this.playerDisplayAtb) * alpha;
		this.opponentDisplayAtb += (this.opponentTargetAtb - this.opponentDisplayAtb) * alpha;

		if (this.playerCard !== undefined) {
			const ratio = clamp(this.playerDisplayAtb / ATB_MAX, 0, 1);
			this.playerCard.atbFill.Size = UDim2.fromScale(ratio, 1);
			this.playerCard.atbValueLabel.Text = UITheme.Texts.FormatAtb(this.playerTargetAtb, ATB_MAX);
		}

		if (this.opponentCard !== undefined) {
			const ratio = clamp(this.opponentDisplayAtb / ATB_MAX, 0, 1);
			this.opponentCard.atbFill.Size = UDim2.fromScale(ratio, 1);
			this.opponentCard.atbValueLabel.Text = UITheme.Texts.FormatAtb(this.opponentTargetAtb, ATB_MAX);
		}
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

	private resolveHpColor(hpRatio: number): Color3 {
		if (hpRatio > UITheme.Numbers.HpHighThreshold) return UITheme.Colors.HpFillHigh;
		if (hpRatio > UITheme.Numbers.HpMidThreshold) return UITheme.Colors.HpFillMid;
		return UITheme.Colors.HpFillLow;
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
}
