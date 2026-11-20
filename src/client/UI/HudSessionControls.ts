import type { BattleGlobalState } from "../../shared/TypeDefs";
import { GAME_FONT, UITheme } from "./UITheme";

export interface CreatedSessionControls {
	readonly pauseButton: TextButton;
	readonly quitButton: TextButton;
	readonly stateBannerLabel: TextLabel;
}

export interface HudPauseVisualState {
	readonly canPause: boolean;
	readonly isPaused: boolean;
	readonly battleEnded: boolean;
}

export interface HudSessionControlsHost {
	readonly onPauseClicked: () => void;
	readonly onQuitClicked: () => void;
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

/**
 * Constrói e atualiza os controles de sessão (PauseButton, QuitButton, StateBanner e PauseOverlay),
 * aplicando o layout relativo entre Pause e Quit e delegando decisões/Remotes ao coordenador.
 */
export class HudSessionControls {
	private pauseButton: TextButton | undefined;
	private quitButton: TextButton | undefined;
	private stateBannerLabel: TextLabel | undefined;
	private pauseOverlay: Frame | undefined;

	public constructor(private readonly host: HudSessionControlsHost) {}

	public createControls(parent: GuiObject): CreatedSessionControls {
		const container = new Instance("Frame");
		container.Name = "SessionControls";
		container.AnchorPoint = UITheme.Layout.TopCenterAnchor;
		container.Position = UITheme.Layout.SessionControlsPos;
		container.Size = UITheme.Layout.SessionControlsSize;
		container.BackgroundTransparency = UITheme.Transparency.Hidden;
		container.Parent = parent;
		this.host.applyAspectRatio(container, UITheme.AspectRatios.SessionControls);

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
		pauseBtn.FontFace = GAME_FONT;
		pauseBtn.TextColor3 = UITheme.Colors.TextPrimary;
		pauseBtn.TextScaled = true;
		pauseBtn.Text = UITheme.Texts.PauseButton;
		pauseBtn.AutoButtonColor = true;
		pauseBtn.Parent = buttonsRow;
		this.host.applyCorner(pauseBtn, UITheme.CornerRadius.Button);
		this.host.applyStroke(pauseBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);
		this.pauseButton = pauseBtn;

		this.host.registerLifetimeConnection(
			pauseBtn.Activated.Connect(() => {
				this.host.onPauseClicked();
			}),
		);

		const quitBtn = new Instance("TextButton");
		quitBtn.Name = "QuitButton";
		quitBtn.Position = UITheme.Layout.QuitButtonWithPausePos;
		quitBtn.Size = UITheme.Layout.QuitButtonWithPauseSize;
		quitBtn.BackgroundColor3 = UITheme.Colors.QuitButtonBg;
		quitBtn.FontFace = GAME_FONT;
		quitBtn.TextColor3 = UITheme.Colors.TextPrimary;
		quitBtn.TextScaled = true;
		quitBtn.Text = UITheme.Texts.QuitButton;
		quitBtn.AutoButtonColor = true;
		quitBtn.Parent = buttonsRow;
		this.host.applyCorner(quitBtn, UITheme.CornerRadius.Button);
		this.host.applyStroke(quitBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);
		this.quitButton = quitBtn;

		this.host.registerLifetimeConnection(
			quitBtn.Activated.Connect(() => {
				this.host.onQuitClicked();
			}),
		);

		const stateBanner = this.host.createTextLabel(
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
		this.host.applyCorner(stateBanner, UITheme.CornerRadius.Badge);
		this.stateBannerLabel = stateBanner;

		return {
			pauseButton: pauseBtn,
			quitButton: quitBtn,
			stateBannerLabel: stateBanner,
		};
	}

	public createPauseOverlay(parent: ScreenGui): Frame {
		const backdrop = new Instance("Frame");
		backdrop.Name = "PauseOverlay";
		backdrop.Position = UITheme.Layout.OriginPosition;
		backdrop.Size = UITheme.Layout.FullSize;
		backdrop.BackgroundColor3 = UITheme.Colors.OverlayBackdrop;
		backdrop.BackgroundTransparency = UITheme.Transparency.ModalBackdrop;
		backdrop.Active = true;
		backdrop.Visible = false;
		backdrop.ZIndex = 20;
		backdrop.Parent = parent;
		this.pauseOverlay = backdrop;

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
		inputBlocker.ZIndex = 20;
		inputBlocker.Parent = backdrop;

		const card = new Instance("Frame");
		card.Name = "PauseModalCard";
		card.AnchorPoint = UITheme.Layout.CenterAnchor;
		card.Position = UITheme.Layout.CenterPosition;
		card.Size = UITheme.Layout.ModalCardSize;
		card.BackgroundColor3 = UITheme.Colors.PanelBackground;
		card.ZIndex = 21;
		card.Parent = backdrop;
		this.host.applyCorner(card, UITheme.CornerRadius.Modal);
		this.host.applyStroke(card, UITheme.Colors.PauseActiveBg, UITheme.StrokeThickness.Thick);
		this.host.applyAspectRatio(card, UITheme.AspectRatios.ModalCard);

		const title = this.host.createTextLabel(
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

		const subtitle = this.host.createTextLabel(
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
		resumeBtn.FontFace = GAME_FONT;
		resumeBtn.TextColor3 = UITheme.Colors.TextPrimary;
		resumeBtn.TextScaled = true;
		resumeBtn.Text = UITheme.Texts.PausedOverlayResumeButton;
		resumeBtn.ZIndex = 22;
		resumeBtn.Parent = card;
		this.host.applyCorner(resumeBtn, UITheme.CornerRadius.Button);
		this.host.applyStroke(resumeBtn, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);

		this.host.registerLifetimeConnection(
			resumeBtn.Activated.Connect(() => {
				this.host.onPauseClicked();
			}),
		);

		return backdrop;
	}

	public refreshLayout(state: HudPauseVisualState): void {
		if (this.pauseButton === undefined || this.quitButton === undefined) return;
		if (state.canPause) {
			this.pauseButton.Visible = true;
			this.quitButton.Position = UITheme.Layout.QuitButtonWithPausePos;
			this.quitButton.Size = UITheme.Layout.QuitButtonWithPauseSize;
		} else {
			this.pauseButton.Visible = false;
			this.quitButton.Position = UITheme.Layout.QuitButtonSoloPos;
			this.quitButton.Size = UITheme.Layout.QuitButtonSoloSize;
		}
		this.refreshPauseVisuals(state);
	}

	public refreshPauseVisuals(state: HudPauseVisualState): void {
		if (this.pauseOverlay !== undefined) {
			this.pauseOverlay.Visible = state.canPause && state.isPaused && !state.battleEnded;
		}
		if (this.pauseButton !== undefined) {
			this.pauseButton.Text = state.isPaused ? UITheme.Texts.ResumeButton : UITheme.Texts.PauseButton;
			this.pauseButton.BackgroundColor3 = state.isPaused
				? UITheme.Colors.PauseActiveBg
				: UITheme.Colors.PauseButtonBg;
		}
	}

	public refreshStateBanner(battleState: BattleGlobalState): void {
		if (this.stateBannerLabel === undefined) return;
		this.stateBannerLabel.Text = `${UITheme.Texts.StatePrefix}${battleState}`;
	}
}
