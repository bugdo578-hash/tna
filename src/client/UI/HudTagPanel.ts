import { clamp } from "../../shared/MathUtils";
import type { ClientFighterIndex } from "../../shared/Remotes";
import { resolveHpColor, type HudFighterState } from "./HudFighterStatus";
import { UITheme } from "./UITheme";

export interface TagSlotWidgets {
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

export interface HudTagPanelHost {
	readonly onSlotClicked: (index: ClientFighterIndex) => void;
	readonly registerLifetimeConnection: (connection: RBXScriptConnection) => void;
	readonly createTextLabel: (
		parent: Instance,
		name: string,
		position: UDim2,
		size: UDim2,
		text: string,
		font: Enum.Font,
		color: Color3,
		xAlign: Enum.TextXAlignment,
	) => TextLabel;
	readonly applyCorner: (parent: GuiObject, radius: UDim) => UICorner;
	readonly applyStroke: (parent: GuiObject, color: Color3, thickness: number) => UIStroke;
	readonly applyAspectRatio: (parent: GuiObject, ratio: number) => UIAspectRatioConstraint;
}

export interface HudTagPanelState {
	readonly activePlayer: HudFighterState | undefined;
	readonly playerTeamOrder: readonly string[];
	readonly fightersByTargetId: ReadonlyMap<string, HudFighterState>;
	readonly canSwitchInCurrentPhase: boolean;
}

/**
 * Constrói e atualiza o painel de Tag (slots 1–3, mini-barras de HP, banner de Root,
 * estados ativo/pronto/aguarde/bloqueado/KO) e encaminha cliques para o coordenador.
 */
export class HudTagPanel {
	private rootLockBanner: TextLabel | undefined;
	private readonly tagSlotWidgets: TagSlotWidgets[] = [];

	public constructor(private readonly host: HudTagPanelHost) {}

	public createPanel(parent: GuiObject): void {
		this.tagSlotWidgets.clear();

		const panel = new Instance("Frame");
		panel.Name = "TagPanel";
		panel.AnchorPoint = UITheme.Layout.BottomLeftAnchor;
		panel.Position = UITheme.Layout.TagPanelPos;
		panel.Size = UITheme.Layout.TagPanelSize;
		panel.BackgroundColor3 = UITheme.Colors.PanelBackground;
		panel.BackgroundTransparency = UITheme.Transparency.Panel;
		panel.Parent = parent;
		this.host.applyCorner(panel, UITheme.CornerRadius.Panel);
		this.host.applyStroke(panel, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);
		this.host.applyAspectRatio(panel, UITheme.AspectRatios.TagPanel);

		this.host.createTextLabel(
			panel,
			"TagHeader",
			UITheme.Layout.TagHeaderPos,
			UITheme.Layout.TagHeaderSize,
			UITheme.Texts.TagHeader,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Left,
		);

		const rootBanner = this.host.createTextLabel(
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
		this.host.applyCorner(rootBanner, UITheme.CornerRadius.Badge);
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
			this.host.applyCorner(btn, UITheme.CornerRadius.Button);
			const stroke = this.host.applyStroke(btn, UITheme.Colors.TagReadyStroke, UITheme.StrokeThickness.Normal);

			const badge = new Instance("Frame");
			badge.Name = "SlotBadge";
			badge.Position = UITheme.Layout.TagSlotBadgePos;
			badge.Size = UITheme.Layout.TagSlotBadgeSize;
			badge.BackgroundColor3 = UITheme.Colors.PanelSecondary;
			badge.Parent = btn;
			this.host.applyCorner(badge, UITheme.CornerRadius.Badge);
			this.host.applyAspectRatio(badge, UITheme.AspectRatios.IconBadge);

			const badgeLabel = this.host.createTextLabel(
				badge,
				"IndexLabel",
				UITheme.Layout.OriginPosition,
				UITheme.Layout.FullSize,
				`${slotIdx}`,
				UITheme.Fonts.Bold,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Center,
			);

			const nameLabel = this.host.createTextLabel(
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
			this.host.applyCorner(hpTrack, UITheme.CornerRadius.Bar);

			const hpFill = new Instance("Frame");
			hpFill.Name = "MiniHpFill";
			hpFill.Position = UITheme.Layout.OriginPosition;
			hpFill.Size = UITheme.Layout.FullSize;
			hpFill.BackgroundColor3 = UITheme.Colors.HpFillHigh;
			hpFill.BorderSizePixel = 0;
			hpFill.Parent = hpTrack;
			this.host.applyCorner(hpFill, UITheme.CornerRadius.Bar);

			const statusLabel = this.host.createTextLabel(
				btn,
				"StatusText",
				UITheme.Layout.TagSlotStatusPos,
				UITheme.Layout.TagSlotStatusSize,
				UITheme.Texts.TagReadyStatus,
				UITheme.Fonts.Bold,
				UITheme.Colors.TextSecondary,
				Enum.TextXAlignment.Center,
			);

			const deadCrossLabel = this.host.createTextLabel(
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

			this.host.registerLifetimeConnection(
				btn.Activated.Connect(() => {
					this.host.onSlotClicked(slotIdx);
				}),
			);

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

	public refresh(state: HudTagPanelState): void {
		const isActiveRooted = state.activePlayer !== undefined && state.activePlayer.effects.has("Root");

		if (this.rootLockBanner !== undefined) {
			this.rootLockBanner.Visible = isActiveRooted;
		}

		for (const widget of this.tagSlotWidgets) {
			const targetId = state.playerTeamOrder[widget.index - 1];
			const fighter = targetId !== undefined ? state.fightersByTargetId.get(targetId) : undefined;
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
			widget.hpFill.BackgroundColor3 = resolveHpColor(hpRatio);

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

			const canSwitchNow = state.canSwitchInCurrentPhase && !isActiveRooted;

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
}
