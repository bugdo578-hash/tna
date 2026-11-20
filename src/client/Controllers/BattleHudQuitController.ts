import type { BattleEndedPayload } from "../../shared/Remotes";
import {
	GAME_FONT,
	QUIT_FINAL_TIMEOUT_SECONDS,
	QUIT_RETRY_INTERVAL_SECONDS,
	QUIT_RETRY_MAX_ATTEMPTS,
	UITheme,
} from "../UI/UITheme";
import { BattleRemotes } from "./BattleRemotes";

export interface BattleHudQuitHost {
	readonly isBattleActive: () => boolean;
	readonly isBattleEnded: () => boolean;
	readonly getScreenGui: () => ScreenGui | undefined;
	readonly getResultScreenGui: () => ScreenGui | undefined;
	readonly getQuitButton: () => TextButton | undefined;
	readonly getQuitStatusLabel: () => TextLabel | undefined;
}

/**
 * Gerencia o fluxo de saída da batalha no HUD: confirmação em dois cliques com timeout,
 * exibição de "Saindo...", reenvio periódico de RequestQuit e política de supressão do resultado.
 */
export class BattleHudQuitController {
	private quitRequested = false;
	private quitRetryTimer: thread | undefined;
	private quitRetryToken = 0;
	private battleGeneration = 0;
	private quitConfirmPending = false;
	private quitConfirmToken = 0;
	private quitConfirmTimer: thread | undefined;

	public constructor(private readonly host: BattleHudQuitHost) {}

	public createQuitStatusLabel(parent: ScreenGui): TextLabel {
		const quitStatus = new Instance("TextLabel");
		quitStatus.Name = "QuitStatus";
		quitStatus.AnchorPoint = UITheme.Layout.CenterAnchor;
		quitStatus.Position = UITheme.Layout.CenterPosition;
		quitStatus.Size = UITheme.Layout.QuitStatusSize;
		quitStatus.BackgroundColor3 = UITheme.Colors.PanelBackground;
		quitStatus.TextColor3 = UITheme.Colors.TextPrimary;
		quitStatus.FontFace = GAME_FONT;
		quitStatus.TextScaled = true;
		quitStatus.Text = UITheme.Texts.QuitInProgress;
		quitStatus.Visible = false;
		quitStatus.Parent = parent;
		return quitStatus;
	}

	public handleQuitClicked(): void {
		if (!this.host.isBattleActive() || this.host.isBattleEnded() || this.quitRequested) return;

		if (!this.quitConfirmPending) {
			this.quitConfirmPending = true;
			this.quitConfirmToken += 1;
			const token = this.quitConfirmToken;
			const quitButton = this.host.getQuitButton();
			if (quitButton !== undefined) {
				quitButton.Text = UITheme.Texts.QuitConfirmButton;
				quitButton.BackgroundColor3 = UITheme.Colors.QuitConfirmBg;
			}
			if (this.quitConfirmTimer !== undefined) {
				task.cancel(this.quitConfirmTimer);
				this.quitConfirmTimer = undefined;
			}
			this.quitConfirmTimer = task.delay(UITheme.Numbers.QuitConfirmTimeoutSeconds, () => {
				this.quitConfirmTimer = undefined;
				const currentQuitButton = this.host.getQuitButton();
				if (
					this.quitConfirmToken === token &&
					this.quitConfirmPending &&
					currentQuitButton !== undefined &&
					currentQuitButton.Parent !== undefined
				) {
					this.resetQuitConfirmState();
				}
			});
			return;
		}

		this.resetQuitConfirmState();
		this.quitRequested = true;
		this.quitRetryToken += 1;
		const token = this.quitRetryToken;
		const generation = this.battleGeneration;
		const screenGui = this.host.getScreenGui();
		if (screenGui !== undefined) screenGui.Enabled = false;
		const quitStatusLabel = this.host.getQuitStatusLabel();
		if (quitStatusLabel !== undefined) quitStatusLabel.Visible = true;
		const resultScreenGui = this.host.getResultScreenGui();
		if (resultScreenGui !== undefined) resultScreenGui.Enabled = true;
		this.sendQuitRequest(1, token, generation);
	}

	public cancelQuitRetry(): void {
		this.quitRequested = false;
		this.quitRetryToken += 1;
		const quitStatusLabel = this.host.getQuitStatusLabel();
		if (quitStatusLabel !== undefined) quitStatusLabel.Visible = false;
		const timer = this.quitRetryTimer;
		this.quitRetryTimer = undefined;
		if (timer !== undefined) task.cancel(timer);
	}

	public resetQuitConfirmState(): void {
		this.quitConfirmPending = false;
		this.quitConfirmToken += 1;
		if (this.quitConfirmTimer !== undefined) {
			task.cancel(this.quitConfirmTimer);
			this.quitConfirmTimer = undefined;
		}
		const quitButton = this.host.getQuitButton();
		if (quitButton !== undefined) {
			quitButton.Text = UITheme.Texts.QuitButton;
			quitButton.BackgroundColor3 = UITheme.Colors.QuitButtonBg;
		}
	}

	public resetForNewBattle(): void {
		this.battleGeneration += 1;
		this.resetQuitConfirmState();
		this.cancelQuitRetry();
		const resultScreenGui = this.host.getResultScreenGui();
		if (resultScreenGui !== undefined) resultScreenGui.Enabled = false;
	}

	public isQuitRequested(): boolean {
		return this.quitRequested;
	}

	public shouldSuppressResult(payload: BattleEndedPayload, ownSideId: string): boolean {
		return (
			(!UITheme.ShowResultOnLocalQuit &&
				(this.quitRequested || (payload.reason === "quit" && payload.winnerSideId !== ownSideId))) ||
			(payload.winnerSideId === undefined && (payload.xpRewards === undefined || payload.xpRewards.size() === 0))
		);
	}

	private sendQuitRequest(attempt: number, token: number, generation: number): void {
		if (
			!this.quitRequested ||
			this.quitRetryToken !== token ||
			this.battleGeneration !== generation ||
			!this.host.isBattleActive() ||
			this.host.isBattleEnded()
		) {
			return;
		}
		if (this.quitRetryTimer !== undefined) {
			task.cancel(this.quitRetryTimer);
			this.quitRetryTimer = undefined;
		}
		if (attempt < QUIT_RETRY_MAX_ATTEMPTS) {
			this.quitRetryTimer = task.delay(QUIT_RETRY_INTERVAL_SECONDS, () => {
				this.quitRetryTimer = undefined;
				if (this.quitRetryToken !== token || this.battleGeneration !== generation) return;
				this.sendQuitRequest(attempt + 1, token, generation);
			});
		} else {
			this.quitRetryTimer = task.delay(QUIT_FINAL_TIMEOUT_SECONDS, () => {
				this.quitRetryTimer = undefined;
				this.recoverFromQuitTimeout(token, generation);
			});
		}
		BattleRemotes.requestQuit.FireServer();
	}

	private recoverFromQuitTimeout(token: number, generation: number): void {
		if (
			!this.quitRequested ||
			this.quitRetryToken !== token ||
			this.battleGeneration !== generation ||
			!this.host.isBattleActive() ||
			this.host.isBattleEnded()
		) {
			return;
		}
		this.cancelQuitRetry();
		this.resetQuitConfirmState();
		const resultScreenGui = this.host.getResultScreenGui();
		if (resultScreenGui !== undefined) resultScreenGui.Enabled = false;
		const screenGui = this.host.getScreenGui();
		if (screenGui !== undefined) screenGui.Enabled = true;
	}
}
