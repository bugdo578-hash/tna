import type {
	BattleEndedPayload,
	BattleEndReason,
	BattleSessionMode,
} from "../../shared/Remotes";
import { GAME_FONT, UITheme } from "./UITheme";
import type { XpRewardCards } from "./XpRewardCards";

export interface CreatedResultOverlay {
	readonly overlay: Frame;
	readonly actionButton: TextButton;
}

export interface HudBattleResultHost {
	readonly getResultScreenGui: () => ScreenGui | undefined;
	readonly getOwnSideId: () => string;
	readonly getBattleMode: () => BattleSessionMode;
	readonly isBattleActive: () => boolean;
	readonly getXpCards: () => XpRewardCards;
	readonly registerLifetimeConnection: (connection: RBXScriptConnection) => void;
	readonly teardownBattle: () => void;
	readonly onCloseClicked: () => void;
	readonly onActionClicked: () => void;
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
	readonly applyTextConstraint: (parent: GuiObject, minSize: number, maxSize: number) => UITextSizeConstraint;
}

/**
 * Constrói e controla a tela de resultado de batalha (PVE/PVP) e a exibição dos cards de XP,
 * delegando a renderização de XP para a instância `XpRewardCards` mantida em `BattleHUD`.
 */
export class HudBattleResult {
	private resultOverlay: Frame | undefined;
	private resultCardStroke: UIStroke | undefined;
	private resultTitleLabel: TextLabel | undefined;
	private resultRewardLabel: TextLabel | undefined;
	private resultReasonLabel: TextLabel | undefined;
	private resultBlockedLabel: TextLabel | undefined;
	private resultActionButton: TextButton | undefined;

	public constructor(private readonly host: HudBattleResultHost) {}

	public createResultOverlay(parent: ScreenGui): CreatedResultOverlay {
		const backdrop = new Instance("Frame");
		backdrop.Name = "ResultOverlay";
		backdrop.Position = UITheme.Layout.OriginPosition;
		backdrop.Size = UITheme.Layout.FullSize;
		backdrop.BackgroundColor3 = UITheme.Colors.OverlayBackdrop;
		backdrop.BackgroundTransparency = UITheme.Transparency.ModalBackdrop;
		backdrop.Active = true;
		backdrop.Visible = false;
		backdrop.ZIndex = 30;
		backdrop.Parent = parent;
		this.resultOverlay = backdrop;

		const inputBlocker = new Instance("TextButton");
		inputBlocker.Name = "InputBlocker";
		inputBlocker.Position = UITheme.Layout.OriginPosition;
		inputBlocker.Size = UITheme.Layout.FullSize;
		inputBlocker.BackgroundTransparency = UITheme.Transparency.Hidden;
		inputBlocker.FontFace = GAME_FONT;
		inputBlocker.Text = "";
		inputBlocker.AutoButtonColor = false;
		inputBlocker.Active = true;
		inputBlocker.Selectable = false;
		inputBlocker.ZIndex = 30;
		inputBlocker.Parent = backdrop;

		const card = new Instance("Frame");
		card.Name = "ResultModalCard";
		card.AnchorPoint = UITheme.Layout.CenterAnchor;
		card.Position = UITheme.Layout.CenterPosition;
		card.Size = UITheme.Xp.ModalSize;
		card.BackgroundColor3 = UITheme.Colors.PanelBackground;
		card.ZIndex = 31;
		card.Parent = backdrop;
		this.host.applyCorner(card, UITheme.CornerRadius.Modal);
		this.resultCardStroke = this.host.applyStroke(card, UITheme.Colors.VictoryAccent, UITheme.StrokeThickness.Thick);

		const titleLabel = this.host.createTextLabel(
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

		const rewardLabel = this.host.createTextLabel(
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

		const pvpReasonLabel = this.host.createTextLabel(
			card,
			"PvpReasonText",
			UITheme.Pvp.ResultReasonPos,
			UITheme.Pvp.ResultReasonSize,
			"",
			UITheme.Fonts.Medium,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Center,
		);
		pvpReasonLabel.TextWrapped = true;
		pvpReasonLabel.Visible = false;
		pvpReasonLabel.ZIndex = 32;
		this.host.applyTextConstraint(pvpReasonLabel, UITheme.Pvp.MinTextSize, UITheme.Pvp.MaxTextSize);
		this.resultReasonLabel = pvpReasonLabel;

		const pvpBlockedLabel = this.host.createTextLabel(
			card,
			"RewardBlockedNotice",
			UITheme.Pvp.ResultBlockedPos,
			UITheme.Pvp.ResultBlockedSize,
			"",
			UITheme.Fonts.Bold,
			UITheme.Colors.PauseActiveBg,
			Enum.TextXAlignment.Center,
		);
		pvpBlockedLabel.BackgroundColor3 = UITheme.Colors.PanelSecondary;
		pvpBlockedLabel.BackgroundTransparency = UITheme.Transparency.SecondaryPanel;
		pvpBlockedLabel.TextWrapped = true;
		pvpBlockedLabel.Visible = false;
		pvpBlockedLabel.ZIndex = 32;
		this.host.applyCorner(pvpBlockedLabel, UITheme.CornerRadius.Panel);
		this.host.applyStroke(pvpBlockedLabel, UITheme.Colors.PauseActiveBg, UITheme.StrokeThickness.Thin);
		this.host.applyTextConstraint(pvpBlockedLabel, UITheme.Pvp.MinTextSize, UITheme.Pvp.MaxTextSize);
		const noticePadding = new Instance("UIPadding");
		noticePadding.PaddingLeft = UITheme.Pvp.ResultBlockedPadding;
		noticePadding.PaddingRight = UITheme.Pvp.ResultBlockedPadding;
		noticePadding.Parent = pvpBlockedLabel;
		this.resultBlockedLabel = pvpBlockedLabel;

		const actionBtn = new Instance("TextButton");
		actionBtn.Name = "CloseRestartButton";
		actionBtn.Position = UITheme.Xp.ButtonPos;
		actionBtn.Size = UITheme.Xp.ButtonSize;
		actionBtn.BackgroundColor3 = UITheme.Colors.ActionButtonPrimary;
		actionBtn.FontFace = GAME_FONT;
		actionBtn.TextColor3 = UITheme.Colors.TextPrimary;
		actionBtn.TextScaled = true;
		actionBtn.Text = UITheme.Texts.ResultCloseButton;
		actionBtn.ZIndex = 32;
		actionBtn.Parent = card;
		this.host.applyCorner(actionBtn, UITheme.CornerRadius.Button);
		this.host.applyStroke(actionBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);
		this.resultActionButton = actionBtn;

		const close = actionBtn.Clone();
		close.Name = "ExitResultButton";
		close.Text = "X";
		close.Position = UITheme.Xp.ClosePos;
		close.Size = UITheme.Xp.CloseSize;
		close.Parent = card;
		this.host.registerLifetimeConnection(
			close.Activated.Connect(() => {
				this.host.onCloseClicked();
			}),
		);
		this.host.registerLifetimeConnection(
			actionBtn.Activated.Connect(() => {
				this.host.onActionClicked();
			}),
		);

		return { overlay: backdrop, actionButton: actionBtn };
	}

	public hasResultGui(): boolean {
		const gui = this.host.getResultScreenGui();
		const overlay = this.resultOverlay;
		if (gui === undefined || gui.Parent === undefined || overlay === undefined || overlay.Parent !== gui) return false;
		const modal = overlay.FindFirstChild("ResultModalCard");
		return modal !== undefined && modal.IsA("Frame") && modal.Parent === overlay;
	}

	public showBattleResult(payload: BattleEndedPayload): void {
		if (!this.hasResultGui()) return;
		const ownSideId = this.host.getOwnSideId();
		const hasWinner = payload.winnerSideId !== undefined;
		const isVictory = ownSideId !== "" && hasWinner && payload.winnerSideId === ownSideId;
		if (this.host.getBattleMode() === "PVP") this.applyPvpResult(payload, hasWinner, isVictory);
		else this.applyPveResult(payload, isVictory);
		this.host.getXpCards().show(this.resultOverlay, payload.xpRewards);
		if (this.resultOverlay !== undefined) this.resultOverlay.Visible = true;
		const resultScreenGui = this.host.getResultScreenGui();
		if (resultScreenGui !== undefined) resultScreenGui.Enabled = true;
	}

	public applyPveResult(payload: BattleEndedPayload, isVictory: boolean): void {
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
			this.resultRewardLabel.Visible = true;
			this.resultRewardLabel.Text = UITheme.Texts.FormatReward(payload.tinyesReward ?? 0);
		}
		if (this.resultReasonLabel !== undefined) {
			this.resultReasonLabel.Visible = false;
			this.resultReasonLabel.Text = "";
		}
		if (this.resultBlockedLabel !== undefined) {
			this.resultBlockedLabel.Visible = false;
			this.resultBlockedLabel.Text = "";
		}
		if (this.resultActionButton !== undefined) {
			this.resultActionButton.Text = UITheme.Texts.ResultCloseButton;
		}
	}

	public applyPvpResult(payload: BattleEndedPayload, hasWinner: boolean, isVictory: boolean): void {
		const accent = !hasWinner
			? UITheme.Colors.TextPrimary
			: isVictory
				? UITheme.Colors.VictoryAccent
				: UITheme.Colors.DefeatAccent;
		const strokeColor = !hasWinner
			? UITheme.Colors.PanelStroke
			: isVictory
				? UITheme.Colors.VictoryAccent
				: UITheme.Colors.DefeatAccent;
		if (this.resultTitleLabel !== undefined) {
			this.resultTitleLabel.Text = !hasWinner
				? UITheme.Pvp.EndedNoWinnerTitle
				: isVictory
					? UITheme.Texts.VictoryTitle
					: UITheme.Texts.DefeatTitle;
			this.resultTitleLabel.TextColor3 = accent;
		}
		if (this.resultCardStroke !== undefined) {
			this.resultCardStroke.Color = strokeColor;
		}
		if (this.resultRewardLabel !== undefined) {
			if (isVictory && payload.tinyesReward !== undefined) {
				this.resultRewardLabel.Visible = true;
				this.resultRewardLabel.Text = UITheme.Texts.FormatReward(payload.tinyesReward);
			} else {
				this.resultRewardLabel.Visible = false;
				this.resultRewardLabel.Text = "";
			}
		}
		if (this.resultBlockedLabel !== undefined) {
			const blockedText = isVictory && payload.rewardBlockedReason !== undefined
				? (UITheme.Pvp.RewardBlockedReasons[payload.rewardBlockedReason] ?? "")
				: "";
			this.resultBlockedLabel.Text = blockedText;
			this.resultBlockedLabel.Visible = blockedText !== "";
		}
		if (this.resultReasonLabel !== undefined) {
			const reasonText = this.resolvePvpEndReasonText(payload.reason, isVictory);
			this.resultReasonLabel.Text = reasonText;
			this.resultReasonLabel.Visible = reasonText !== "";
		}
		if (this.resultActionButton !== undefined) {
			this.resultActionButton.Text = UITheme.Pvp.CloseResultButton;
		}
	}

	public closeResultOverlay(): void {
		if (this.host.isBattleActive()) return;
		this.host.teardownBattle();
	}

	public handleResultCloseAndRestart(): void {
		if (this.host.isBattleActive()) return;
		this.host.teardownBattle();
	}

	private resolvePvpEndReasonText(reason: BattleEndReason | undefined, isVictory: boolean): string {
		if (reason === "quit") {
			return isVictory ? UITheme.Pvp.EndReasonTexts.quitWin : UITheme.Pvp.EndReasonTexts.quitLoss;
		}
		if (reason === "disconnect") return UITheme.Pvp.EndReasonTexts.disconnect;
		if (reason === "timeout") return UITheme.Pvp.EndReasonTexts.timeout;
		if (reason === "error") return UITheme.Pvp.EndReasonTexts.error;
		return UITheme.Pvp.EndReasonTexts.victory;
	}
}
