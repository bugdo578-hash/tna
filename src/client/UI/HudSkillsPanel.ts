import { FLOAT_TOLERANCE } from "../../shared/Config";
import type { SkillSlot } from "../../shared/TypeDefs";
import type { HudFighterState } from "./HudFighterStatus";
import { GAME_FONT, UITheme } from "./UITheme";

export interface SkillButtonWidgets {
	readonly slot: SkillSlot;
	readonly button: TextButton;
	readonly stroke: UIStroke;
	readonly slotTag: TextLabel;
	readonly costLabel: TextLabel;
	readonly nameLabel: TextLabel;
	readonly stateLabel: TextLabel;
}

export interface HudSkillsPanelHost {
	readonly onSkillClicked: (slot: SkillSlot) => void;
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

export interface HudSkillsPanelState {
	readonly activePlayer: HudFighterState | undefined;
	readonly playerAtb: number;
	readonly canUseSkillsInCurrentPhase: boolean;
}

/**
 * Constrói e atualiza o painel de habilidades (botões S1–S3, custos, trava de nível da S3,
 * disponibilidade por ATB/fase/Pause/KO) e encaminha cliques para o coordenador.
 */
export class HudSkillsPanel {
	private readonly skillButtonWidgets: SkillButtonWidgets[] = [];

	public constructor(private readonly host: HudSkillsPanelHost) {}

	public createPanel(parent: GuiObject): void {
		this.skillButtonWidgets.clear();

		const panel = new Instance("Frame");
		panel.Name = "SkillsPanel";
		panel.AnchorPoint = UITheme.Layout.BottomRightAnchor;
		panel.Position = UITheme.Layout.SkillsPanelPos;
		panel.Size = UITheme.Layout.SkillsPanelSize;
		panel.BackgroundColor3 = UITheme.Colors.PanelBackground;
		panel.BackgroundTransparency = UITheme.Transparency.Panel;
		panel.Parent = parent;
		this.host.applyCorner(panel, UITheme.CornerRadius.Panel);
		this.host.applyStroke(panel, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);
		this.host.applyAspectRatio(panel, UITheme.AspectRatios.SkillsPanel);

		this.host.createTextLabel(
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
			btn.FontFace = GAME_FONT;
			btn.Text = "";
			btn.AutoButtonColor = false;
			btn.Parent = buttonsContainer;
			this.host.applyCorner(btn, UITheme.CornerRadius.Button);
			const stroke = this.host.applyStroke(btn, UITheme.Colors.SkillDisabledStroke, UITheme.StrokeThickness.Thick);

			const slotTag = this.host.createTextLabel(
				btn,
				"SlotTag",
				UITheme.Layout.SkillSlotTagPos,
				UITheme.Layout.SkillSlotTagSize,
				`S${slot}`,
				UITheme.Fonts.Title,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Left,
			);

			const costLabel = this.host.createTextLabel(
				btn,
				"CostLabel",
				UITheme.Layout.SkillCostTagPos,
				UITheme.Layout.SkillCostTagSize,
				UITheme.Texts.FormatCost(UITheme.Numbers.DefaultSlotCosts[slot - 1]),
				UITheme.Fonts.Bold,
				UITheme.Colors.AtbMarkerReached,
				Enum.TextXAlignment.Right,
			);

			const nameLabel = this.host.createTextLabel(
				btn,
				"SkillName",
				UITheme.Layout.SkillNamePos,
				UITheme.Layout.SkillNameSize,
				`Skill ${slot}`,
				UITheme.Fonts.Bold,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Center,
			);

			const stateLabel = this.host.createTextLabel(
				btn,
				"SkillState",
				UITheme.Layout.SkillStatePos,
				UITheme.Layout.SkillStateSize,
				UITheme.Texts.SkillNoAtbState,
				UITheme.Fonts.Medium,
				UITheme.Colors.TextSecondary,
				Enum.TextXAlignment.Center,
			);

			this.host.registerLifetimeConnection(
				btn.Activated.Connect(() => {
					this.host.onSkillClicked(slot);
				}),
			);

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

	public refresh(state: HudSkillsPanelState): void {
		const activePlayer = state.activePlayer;
		for (const widget of this.skillButtonWidgets) {
			const slotIndex = widget.slot - 1;
			const skillName = activePlayer?.skillNames[slotIndex] ?? `Skill ${widget.slot}`;
			const cost = activePlayer?.slotCosts[slotIndex] ?? UITheme.Numbers.DefaultSlotCosts[slotIndex];

			widget.nameLabel.Text = skillName;
			widget.costLabel.Text = UITheme.Texts.FormatCost(cost);

			const isIdle = state.canUseSkillsInCurrentPhase;
			const hasAtb = state.playerAtb + FLOAT_TOLERANCE >= cost;
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
				widget.stateLabel.Text = locked
					? UITheme.Texts.SkillLockedState
					: !hasAtb
						? UITheme.Texts.SkillNoAtbState
						: UITheme.Texts.SkillBusyState;
				widget.stateLabel.TextColor3 = UITheme.Colors.TextMuted;
			}
		}
	}
}
