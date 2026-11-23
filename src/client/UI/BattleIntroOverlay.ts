import {
	BATTLE_INTRO_JOTARO_ASPECT_RATIO,
	BATTLE_INTRO_JOTARO_COLS,
	BATTLE_INTRO_JOTARO_FRAME_HEIGHT,
	BATTLE_INTRO_JOTARO_FRAME_SECONDS,
	BATTLE_INTRO_JOTARO_FRAME_WIDTH,
	BATTLE_INTRO_JOTARO_FRAMES,
	BATTLE_INTRO_JOTARO_SPRITESHEET_ID,
	BATTLE_INTRO_LOADING_TEXT,
	BATTLE_INTRO_WAVE_PAUSE_SECONDS,
	BATTLE_INTRO_WAVE_PULSE_SECONDS,
	BATTLE_INTRO_WAVE_SCALE_AMPLITUDE,
	BATTLE_INTRO_WAVE_STEP_SECONDS,
} from "./CombatVisualConfig";
import { GAME_FONT, UITheme } from "./UITheme";

interface WaveLetter {
	readonly label: TextLabel;
	readonly scale: UIScale;
}

const LOADING_CHARS: readonly string[] = (() => {
	const chars: string[] = [];
	for (const i of $range(1, BATTLE_INTRO_LOADING_TEXT.size())) {
		chars.push(BATTLE_INTRO_LOADING_TEXT.sub(i, i));
	}
	return chars;
})();

const WAVE_CYCLE_SECONDS =
	LOADING_CHARS.size() * BATTLE_INTRO_WAVE_STEP_SECONDS + BATTLE_INTRO_WAVE_PAUSE_SECONDS;

export class BattleIntroOverlay {
	public readonly gui = new Instance("ScreenGui");
	private readonly curtain = new Instance("Frame");
	private readonly quit = new Instance("TextButton");
	private readonly countdown = new Instance("TextLabel");
	private readonly countdownScale = new Instance("UIScale");
	private readonly loadingGroup = new Instance("Frame");
	private readonly jotaroSprite = new Instance("ImageLabel");
	private readonly waveLetters: WaveLetter[] = [];
	private currentFrameIndex = -1;
	private loadingVisible = false;

	public constructor(playerGui: PlayerGui, onQuit: () => void) {
		const { gui, curtain, quit, countdown, countdownScale, loadingGroup, jotaroSprite } = this;
		gui.Name = "BattleIntroOverlay";
		gui.DisplayOrder = 1000;
		gui.ResetOnSpawn = false;
		gui.ScreenInsets = Enum.ScreenInsets.None;
		gui.ClipToDeviceSafeArea = false;

		curtain.Name = "Curtain";
		curtain.Size = UDim2.fromScale(1, 1);
		curtain.BackgroundColor3 = new Color3(0, 0, 0);
		curtain.BackgroundTransparency = 1;
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

		// Conjunto único no canto inferior direito, sem fundo nem caixa, responsivo para PC e celular.
		loadingGroup.Name = "LoadingGroup";
		loadingGroup.AnchorPoint = new Vector2(1, 1);
		loadingGroup.Position = UDim2.fromScale(0.975, 0.965);
		loadingGroup.Size = UDim2.fromScale(0.14, 0.24);
		loadingGroup.BackgroundTransparency = 1;
		loadingGroup.BorderSizePixel = 0;
		loadingGroup.Visible = false;
		loadingGroup.Parent = gui;

		const sizeConstraint = new Instance("UISizeConstraint");
		sizeConstraint.MinSize = new Vector2(88, 132);
		sizeConstraint.MaxSize = new Vector2(148, 224);
		sizeConstraint.Parent = loadingGroup;

		jotaroSprite.Name = "JotaroSprite";
		jotaroSprite.AnchorPoint = new Vector2(0.5, 0);
		jotaroSprite.Position = UDim2.fromScale(0.5, 0);
		jotaroSprite.Size = UDim2.fromScale(1, 0.78);
		jotaroSprite.BackgroundTransparency = 1;
		jotaroSprite.BorderSizePixel = 0;
		jotaroSprite.Image = BATTLE_INTRO_JOTARO_SPRITESHEET_ID;
		jotaroSprite.ImageTransparency = 1;
		jotaroSprite.ImageRectSize = new Vector2(
			BATTLE_INTRO_JOTARO_FRAME_WIDTH,
			BATTLE_INTRO_JOTARO_FRAME_HEIGHT,
		);
		jotaroSprite.ImageRectOffset = new Vector2(0, 0);
		jotaroSprite.ScaleType = Enum.ScaleType.Fit;
		jotaroSprite.ResampleMode = Enum.ResamplerMode.Pixelated;
		jotaroSprite.Parent = loadingGroup;

		const spriteAspect = new Instance("UIAspectRatioConstraint");
		spriteAspect.AspectRatio = BATTLE_INTRO_JOTARO_ASPECT_RATIO;
		spriteAspect.Parent = jotaroSprite;

		const textRow = new Instance("Frame");
		textRow.Name = "LoadingTextRow";
		textRow.AnchorPoint = new Vector2(0.5, 1);
		textRow.Position = UDim2.fromScale(0.5, 1);
		textRow.Size = UDim2.fromScale(1, 0.19);
		textRow.BackgroundTransparency = 1;
		textRow.BorderSizePixel = 0;
		textRow.Parent = loadingGroup;

		const slotWidth = 1 / LOADING_CHARS.size();
		for (const index of $range(0, LOADING_CHARS.size() - 1)) {
			const char = LOADING_CHARS[index];
			const slot = new Instance("Frame");
			slot.Name = `Slot_${index + 1}`;
			slot.Position = UDim2.fromScale(index * slotWidth, 0);
			slot.Size = UDim2.fromScale(slotWidth, 1);
			slot.BackgroundTransparency = 1;
			slot.BorderSizePixel = 0;
			slot.Parent = textRow;

			const letter = new Instance("TextLabel");
			letter.Name = `Char_${index + 1}`;
			letter.AnchorPoint = new Vector2(0.5, 0.5);
			letter.Position = UDim2.fromScale(0.5, 0.5);
			letter.Size = UDim2.fromScale(1, 1);
			letter.BackgroundTransparency = 1;
			letter.FontFace = GAME_FONT;
			letter.TextColor3 = UITheme.Colors.TextPrimary;
			letter.TextStrokeColor3 = new Color3(0, 0, 0);
			letter.TextStrokeTransparency = 1;
			letter.TextTransparency = 1;
			letter.TextScaled = true;
			letter.Text = char;
			letter.Parent = slot;

			const scale = new Instance("UIScale");
			scale.Scale = 1;
			scale.Parent = letter;

			this.waveLetters.push({ label: letter, scale });
		}

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

	public cover(canQuit: boolean, instantCurtain = true): void {
		this.curtain.Visible = true;
		if (instantCurtain) {
			this.curtain.BackgroundTransparency = 0;
		}
		this.quit.Visible = canQuit;
		this.countdown.Visible = false;
	}

	public setCurtainTransparency(transparency: number): void {
		const clamped = math.clamp(transparency, 0, 1);
		this.curtain.BackgroundTransparency = clamped;
		this.curtain.Visible = clamped < 1;
	}

	public startLoadingAnimation(): void {
		this.loadingVisible = true;
		this.loadingGroup.Visible = true;
		this.applyFrame(0);
		this.setLoadingContentTransparency(1);
	}

	public stopLoadingAnimation(): void {
		this.loadingVisible = false;
		this.loadingGroup.Visible = false;
		this.setLoadingContentTransparency(1);
		for (const item of this.waveLetters) {
			item.scale.Scale = 1;
		}
	}

	public updateLoading(elapsedSeconds: number, contentTransparency: number): void {
		if (!this.loadingVisible) return;
		const safeElapsed = math.max(elapsedSeconds, 0);
		const frameIndex = math.floor(safeElapsed / BATTLE_INTRO_JOTARO_FRAME_SECONDS) % BATTLE_INTRO_JOTARO_FRAMES;
		this.applyFrame(frameIndex);
		this.setLoadingContentTransparency(contentTransparency);

		for (const index of $range(0, this.waveLetters.size() - 1)) {
			const offset = safeElapsed - index * BATTLE_INTRO_WAVE_STEP_SECONDS;
			let localT = offset % WAVE_CYCLE_SECONDS;
			if (localT < 0) localT += WAVE_CYCLE_SECONDS;
			if (localT < BATTLE_INTRO_WAVE_PULSE_SECONDS) {
				const phase = localT / BATTLE_INTRO_WAVE_PULSE_SECONDS;
				const pulse = 0.5 - 0.5 * math.cos(2 * math.pi * phase);
				this.waveLetters[index].scale.Scale = 1 + BATTLE_INTRO_WAVE_SCALE_AMPLITUDE * pulse;
			} else {
				this.waveLetters[index].scale.Scale = 1;
			}
		}
	}

	public reveal(fade: number): void {
		this.quit.Visible = false;
		this.setCurtainTransparency(fade);
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

	private applyFrame(frameIndex: number): void {
		if (frameIndex === this.currentFrameIndex) return;
		this.currentFrameIndex = frameIndex;
		const col = frameIndex % BATTLE_INTRO_JOTARO_COLS;
		const row = math.floor(frameIndex / BATTLE_INTRO_JOTARO_COLS);
		this.jotaroSprite.ImageRectOffset = new Vector2(
			col * BATTLE_INTRO_JOTARO_FRAME_WIDTH,
			row * BATTLE_INTRO_JOTARO_FRAME_HEIGHT,
		);
	}

	private setLoadingContentTransparency(transparency: number): void {
		const clamped = math.clamp(transparency, 0, 1);
		this.jotaroSprite.ImageTransparency = clamped;
		const stroke = math.max(0.35, clamped);
		for (const item of this.waveLetters) {
			item.label.TextTransparency = clamped;
			item.label.TextStrokeTransparency = stroke;
		}
	}
}
