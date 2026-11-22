import { GAME_FONT, UITheme } from "./UITheme";

export class BattleIntroOverlay {
	public readonly gui = new Instance("ScreenGui");
	private readonly curtain = new Instance("Frame");
	private readonly quit = new Instance("TextButton");
	private readonly countdown = new Instance("TextLabel");
	private readonly countdownScale = new Instance("UIScale");

	public constructor(playerGui: PlayerGui, onQuit: () => void) {
		const { gui, curtain, quit, countdown, countdownScale } = this;
		gui.Name = "BattleIntroOverlay";
		gui.DisplayOrder = 1000;
		gui.ResetOnSpawn = false;
		gui.ScreenInsets = Enum.ScreenInsets.None;
		gui.ClipToDeviceSafeArea = false;

		curtain.Name = "Curtain";
		curtain.Size = UDim2.fromScale(1, 1);
		curtain.BackgroundColor3 = new Color3(0, 0, 0);
		curtain.BorderSizePixel = 0;
		curtain.Active = true;
		curtain.Parent = gui;

		quit.Name = "CancelLoading";
		quit.AnchorPoint = new Vector2(0.5, 1);
		quit.Position = UDim2.fromScale(0.5, 0.88);
		quit.Size = UDim2.fromOffset(144, 42);
		quit.BackgroundColor3 = UITheme.Colors.QuitButtonBg;
		quit.TextColor3 = UITheme.Colors.TextPrimary;
		quit.FontFace = GAME_FONT;
		quit.TextSize = 22;
		quit.Text = UITheme.Texts.QuitButton;
		quit.Visible = false;
		quit.Parent = curtain;
		quit.Activated.Connect(onQuit);

		countdown.Name = "Countdown";
		countdown.AnchorPoint = new Vector2(0.5, 0.5);
		countdown.Position = UDim2.fromScale(0.5, 0.36);
		countdown.Size = UDim2.fromScale(0.48, 0.26);
		countdown.BackgroundTransparency = 1;
		countdown.TextColor3 = UITheme.Colors.TextPrimary;
		countdown.TextStrokeColor3 = new Color3(0, 0, 0);
		countdown.FontFace = GAME_FONT;
		countdown.TextScaled = true;
		countdown.Visible = false;
		countdown.Parent = gui;
		countdownScale.Parent = countdown;
		gui.Parent = playerGui;
	}

	public cover(canQuit: boolean): void {
		this.curtain.Visible = true;
		this.curtain.BackgroundTransparency = 0;
		this.quit.Visible = canQuit;
		this.countdown.Visible = false;
	}

	public reveal(fade: number): void {
		this.quit.Visible = false;
		this.curtain.BackgroundTransparency = fade;
		this.curtain.Visible = fade < 1;
	}

	public showCountdown(label: string, age: number): void {
		this.countdown.Text = label;
		this.countdown.Visible = true;
		const entrance = 1 - math.clamp(age / 0.2, 0, 1);
		const exit = math.clamp((age - 0.72) / 0.28, 0, 1);
		this.countdownScale.Scale = 1 + 0.28 * entrance * entrance;
		this.countdown.TextTransparency = math.max(0.4 * entrance, exit);
		this.countdown.TextStrokeTransparency = math.max(0.25, this.countdown.TextTransparency);
	}
}
