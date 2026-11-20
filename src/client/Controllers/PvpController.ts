import { Players, ReplicatedStorage, RunService } from "@rbxts/services";
import {
	REMOTE_NAMES,
	REMOTES_FOLDER_NAME,
	type ChallengeReceivedPayload,
	type ChallengeStatus,
	type ChallengeStatusPayload,
	type RequestChallengeResponsePayload,
} from "../../shared/Remotes";
import { GAME_FONT, UITheme } from "../UI/UITheme";

const T = UITheme.Pvp;
const C = UITheme.Colors;

interface ActiveInvite {
	readonly inviteId: string;
	readonly duration: number;
	readonly deadline: number;
}

function isValidStatus(value: unknown): value is ChallengeStatus {
	return value === "enviado" || value === "aceito" || value === "recusado" || value === "expirado" || value === "indisponivel";
}

/**
 * Controlador de apresentação do fluxo de convite e status do duelo PVP.
 * Exibe apenas dados enviados pelo servidor e envia apenas { inviteId, accept }.
 */
export class PvpController {
	public readonly gui = new Instance("ScreenGui");
	private readonly lifetime: RBXScriptConnection[] = [];
	private readonly inviteConnections: RBXScriptConnection[] = [];
	private readonly statusConnections: RBXScriptConnection[] = [];

	private responseRemote?: RemoteEvent;
	private invitePanel?: Frame;
	private inviteTimerFill?: Frame;
	private statusPanel?: Frame;
	private inviteTimer?: thread;
	private statusTimer?: thread;

	private currentInvite?: ActiveInvite;
	private pendingOutgoingInviteId?: string;
	private expiredReceivedInviteId?: string;
	private lastRespondedInvite?: { readonly inviteId: string; readonly accept: boolean };

	private battleActive = false;
	private started = false;
	private destroyed = false;
	private guiDisposed = false;

	public start(): void {
		if (this.started || this.destroyed) return;
		this.started = true;

		this.gui.Name = T.ScreenGuiName;
		this.gui.DisplayOrder = T.DisplayOrder;
		this.gui.ResetOnSpawn = false;
		this.gui.IgnoreGuiInset = false;
		this.gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets;
		this.gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
		this.gui.Parent = Players.LocalPlayer.WaitForChild("PlayerGui");

		this.lifetime.push(
			this.gui.Destroying.Connect(() => {
				this.guiDisposed = true;
				this.destroy();
			}),
		);

		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME);
		this.responseRemote = folder.WaitForChild(REMOTE_NAMES.RequestChallengeResponse) as RemoteEvent;
		const challengeReceived = folder.WaitForChild(REMOTE_NAMES.ChallengeReceived) as RemoteEvent;
		const challengeStatus = folder.WaitForChild(REMOTE_NAMES.ChallengeStatus) as RemoteEvent;
		const battleStarted = folder.WaitForChild(REMOTE_NAMES.BattleStarted) as RemoteEvent;
		const battleEnded = folder.WaitForChild(REMOTE_NAMES.BattleEnded) as RemoteEvent;

		this.lifetime.push(
			challengeReceived.OnClientEvent.Connect((payload: unknown) => {
				this.onChallengeReceived(payload as ChallengeReceivedPayload);
			}),
			challengeStatus.OnClientEvent.Connect((payload: unknown) => {
				this.onChallengeStatus(payload as ChallengeStatusPayload);
			}),
			battleStarted.OnClientEvent.Connect(() => {
				this.onBattleStarted();
			}),
			battleEnded.OnClientEvent.Connect(() => {
				this.onBattleEnded();
			}),
		);
	}

	public close(): void {
		this.closeInvite();
		this.closeStatus();
	}

	public closeInvite(): void {
		this.currentInvite = undefined;
		if (this.inviteTimer !== undefined) {
			task.cancel(this.inviteTimer);
			this.inviteTimer = undefined;
		}
		for (const connection of this.inviteConnections) connection.Disconnect();
		this.inviteConnections.clear();
		this.inviteTimerFill = undefined;
		const panel = this.invitePanel;
		this.invitePanel = undefined;
		if (!this.guiDisposed) panel?.Destroy();
	}

	public closeStatus(): void {
		if (this.statusTimer !== undefined) {
			task.cancel(this.statusTimer);
			this.statusTimer = undefined;
		}
		for (const connection of this.statusConnections) connection.Disconnect();
		this.statusConnections.clear();
		const panel = this.statusPanel;
		this.statusPanel = undefined;
		if (!this.guiDisposed) panel?.Destroy();
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.close();
		this.pendingOutgoingInviteId = undefined;
		this.expiredReceivedInviteId = undefined;
		this.lastRespondedInvite = undefined;
		for (const connection of this.lifetime) connection.Disconnect();
		this.lifetime.clear();
		if (!this.guiDisposed) {
			this.guiDisposed = true;
			this.gui.Destroy();
		}
	}

	public onChallengeReceived(payload: ChallengeReceivedPayload): void {
		if (this.destroyed || this.battleActive) return;
		if (!typeIs(payload, "table")) return;
		if (!typeIs(payload.inviteId, "string") || payload.inviteId.size() === 0) return;
		if (!typeIs(payload.challengerName, "string")) return;
		if (!typeIs(payload.expiresIn, "number") || payload.expiresIn <= 0 || payload.expiresIn !== payload.expiresIn || payload.expiresIn >= math.huge) {
			return;
		}

		this.closeInvite();
		this.expiredReceivedInviteId = undefined;

		const inviteId = payload.inviteId;
		const duration = payload.expiresIn;
		const deadline = os.clock() + duration;
		this.currentInvite = { inviteId, duration, deadline };

		const card = this.createCard("InvitePopup", T.InvitePos, T.InviteSize, T.InviteAnchor, T.InviteMinSize, T.InviteMaxSize, C.AtbFillPlayer, 20);
		this.invitePanel = card;

		const badge = this.createLabel(card, "Badge", T.InviteBadgeText, T.InviteBadgePos, T.InviteBadgeSize, UITheme.Fonts.Bold, C.RewardGold, T.BadgeMinTextSize, T.BadgeMaxTextSize);
		badge.ZIndex = 21;

		const message = this.createLabel(
			card,
			"InviteMessage",
			T.FormatInviteText(payload.challengerName),
			T.InviteTextPos,
			T.InviteTextSize,
			UITheme.Fonts.Title,
			C.TextPrimary,
			T.MinTextSize,
			T.MaxTextSize,
		);
		message.ZIndex = 21;

		const track = new Instance("Frame");
		track.Name = "TimeBarTrack";
		track.Position = T.TimeBarPos;
		track.Size = T.TimeBarSize;
		track.BackgroundColor3 = C.BarTrack;
		track.BackgroundTransparency = UITheme.Transparency.BarTrack;
		track.BorderSizePixel = 0;
		track.ZIndex = 21;
		track.Parent = card;
		this.applyCorner(track, UITheme.CornerRadius.Bar);

		const fill = new Instance("Frame");
		fill.Name = "TimeBarFill";
		fill.Position = UITheme.Layout.OriginPosition;
		fill.Size = UITheme.Layout.FullSize;
		fill.BackgroundColor3 = C.AtbFillPlayer;
		fill.BorderSizePixel = 0;
		fill.ZIndex = 22;
		fill.Parent = track;
		this.applyCorner(fill, UITheme.CornerRadius.Bar);
		this.inviteTimerFill = fill;

		const buttonsRow = new Instance("Frame");
		buttonsRow.Name = "ButtonsRow";
		buttonsRow.Position = T.ButtonsRowPos;
		buttonsRow.Size = T.ButtonsRowSize;
		buttonsRow.BackgroundTransparency = UITheme.Transparency.Hidden;
		buttonsRow.ZIndex = 21;
		buttonsRow.Parent = card;

		const acceptBtn = this.createButton(buttonsRow, "AcceptButton", T.AcceptText, T.AcceptPos, T.AcceptSize, C.ActionButtonPrimary, T.ButtonMinTextSize, T.ButtonMaxTextSize, 22);
		const declineBtn = this.createButton(buttonsRow, "DeclineButton", T.DeclineText, T.DeclinePos, T.DeclineSize, C.QuitButtonBg, T.ButtonMinTextSize, T.ButtonMaxTextSize, 22);

		this.inviteConnections.push(
			acceptBtn.Activated.Connect(() => this.respondToInvite(true)),
			declineBtn.Activated.Connect(() => this.respondToInvite(false)),
			RunService.Heartbeat.Connect(() => this.stepInviteBar()),
		);

		this.inviteTimer = task.delay(duration, () => {
			this.inviteTimer = undefined;
			this.expireInvite(inviteId);
		});
	}

	public respondToInvite(accept: boolean): void {
		const invite = this.currentInvite;
		if (invite === undefined) return;
		this.lastRespondedInvite = { inviteId: invite.inviteId, accept };
		this.closeInvite();
		const payload: RequestChallengeResponsePayload = { inviteId: invite.inviteId, accept };
		this.responseRemote?.FireServer(payload);
	}

	public onChallengeStatus(payload: ChallengeStatusPayload): void {
		if (this.destroyed) return;
		if (!typeIs(payload, "table")) return;
		if (!typeIs(payload.inviteId, "string") || !isValidStatus(payload.status)) return;

		if (payload.status === "enviado") {
			this.pendingOutgoingInviteId = payload.inviteId;
			this.showStatus(T.StatusTexts.enviado, "enviado", false);
			return;
		}

		// Se este client tinha o popup aberto para o mesmo convite, fecha imediatamente.
		if (this.currentInvite !== undefined && this.currentInvite.inviteId === payload.inviteId) {
			this.closeInvite();
			if (this.pendingOutgoingInviteId !== payload.inviteId) {
				return;
			}
		}

		if (this.expiredReceivedInviteId !== undefined && this.expiredReceivedInviteId === payload.inviteId) {
			this.expiredReceivedInviteId = undefined;
			if (payload.status === "expirado" && this.pendingOutgoingInviteId !== payload.inviteId) {
				return;
			}
		}

		if (this.lastRespondedInvite !== undefined && this.lastRespondedInvite.inviteId === payload.inviteId) {
			const responded = this.lastRespondedInvite;
			this.lastRespondedInvite = undefined;
			if (this.pendingOutgoingInviteId !== payload.inviteId) {
				if (!responded.accept || payload.status === "aceito") {
					return;
				}
			}
		}

		if (this.pendingOutgoingInviteId === payload.inviteId) {
			this.pendingOutgoingInviteId = undefined;
		}

		this.showStatus(T.StatusTexts[payload.status], payload.status, true);
	}

	public onBattleStarted(): void {
		this.battleActive = true;
		this.closeInvite();
		if (this.pendingOutgoingInviteId === undefined) {
			this.closeStatus();
		}
	}

	public onBattleEnded(): void {
		this.battleActive = false;
	}

	private stepInviteBar(): void {
		const invite = this.currentInvite;
		if (invite === undefined) return;
		const remaining = math.max(invite.deadline - os.clock(), 0);
		if (this.inviteTimerFill !== undefined) {
			const ratio = invite.duration > 0 ? math.clamp(remaining / invite.duration, 0, 1) : 0;
			this.inviteTimerFill.Size = UDim2.fromScale(ratio, 1);
		}
		if (remaining <= 0) {
			this.expireInvite(invite.inviteId);
		}
	}

	private expireInvite(inviteId: string): void {
		if (this.currentInvite === undefined || this.currentInvite.inviteId !== inviteId) return;
		this.expiredReceivedInviteId = inviteId;
		this.closeInvite();
	}

	private showStatus(text: string, status: ChallengeStatus, autoHide: boolean): void {
		this.closeStatus();
		const accent = T.StatusColors[status];
		const card = this.createCard("StatusBanner", T.StatusPos, T.StatusSize, T.StatusAnchor, T.StatusMinSize, T.StatusMaxSize, accent, 10);
		this.statusPanel = card;

		const label = this.createLabel(card, "StatusText", text, T.StatusTextPos, T.StatusTextSize, UITheme.Fonts.Bold, C.TextPrimary, T.MinTextSize, T.MaxTextSize);
		label.ZIndex = 11;

		const closeBtn = this.createButton(card, "CloseButton", T.CloseText, T.StatusClosePos, T.StatusCloseSize, C.ActionButtonSecondary, T.MinTextSize, T.MaxTextSize, 11);
		const aspect = new Instance("UIAspectRatioConstraint");
		aspect.AspectRatio = T.StatusCloseAspect;
		aspect.AspectType = Enum.AspectType.FitWithinMaxSize;
		aspect.Parent = closeBtn;

		this.statusConnections.push(closeBtn.Activated.Connect(() => this.closeStatus()));

		if (autoHide) {
			this.statusTimer = task.delay(T.StatusNoticeSeconds, () => {
				this.statusTimer = undefined;
				this.closeStatus();
			});
		}
	}

	private createCard(
		name: string,
		pos: UDim2,
		size: UDim2,
		anchor: Vector2,
		minSize: Vector2,
		maxSize: Vector2,
		strokeColor: Color3,
		zIndex: number,
	): Frame {
		const card = new Instance("Frame");
		card.Name = name;
		card.AnchorPoint = anchor;
		card.Position = pos;
		card.Size = size;
		card.BackgroundColor3 = C.PanelBackground;
		card.BackgroundTransparency = UITheme.Transparency.Panel;
		card.BorderSizePixel = 0;
		card.ZIndex = zIndex;
		card.Parent = this.gui;

		const sizeConstraint = new Instance("UISizeConstraint");
		sizeConstraint.MinSize = minSize;
		sizeConstraint.MaxSize = maxSize;
		sizeConstraint.Parent = card;

		this.applyCorner(card, UITheme.CornerRadius.Panel);
		this.applyStroke(card, strokeColor, UITheme.StrokeThickness.Thick);
		return card;
	}

	private createLabel(
		parent: Instance,
		name: string,
		text: string,
		pos: UDim2,
		size: UDim2,
		font: Enum.Font,
		color: Color3,
		minTextSize: number,
		maxTextSize: number,
	): TextLabel {
		const label = new Instance("TextLabel");
		label.Name = name;
		label.Position = pos;
		label.Size = size;
		label.BackgroundTransparency = UITheme.Transparency.Hidden;
		label.BorderSizePixel = 0;
		label.Font = font;
		label.FontFace = GAME_FONT;
		label.TextColor3 = color;
		label.TextScaled = true;
		label.TextWrapped = true;
		label.Text = text;
		label.Parent = parent;

		const constraint = new Instance("UITextSizeConstraint");
		constraint.MinTextSize = minTextSize;
		constraint.MaxTextSize = maxTextSize;
		constraint.Parent = label;
		return label;
	}

	private createButton(
		parent: Instance,
		name: string,
		text: string,
		pos: UDim2,
		size: UDim2,
		bgColor: Color3,
		minTextSize: number,
		maxTextSize: number,
		zIndex: number,
	): TextButton {
		const button = new Instance("TextButton");
		button.Name = name;
		button.Position = pos;
		button.Size = size;
		button.BackgroundColor3 = bgColor;
		button.BackgroundTransparency = UITheme.Transparency.Opaque;
		button.BorderSizePixel = 0;
		button.FontFace = GAME_FONT;
		button.TextColor3 = C.TextPrimary;
		button.TextScaled = true;
		button.TextWrapped = true;
		button.Text = text;
		button.AutoButtonColor = true;
		button.ZIndex = zIndex;
		button.Parent = parent;

		const constraint = new Instance("UITextSizeConstraint");
		constraint.MinTextSize = minTextSize;
		constraint.MaxTextSize = maxTextSize;
		constraint.Parent = button;

		this.applyCorner(button, UITheme.CornerRadius.Button);
		this.applyStroke(button, C.PanelStroke, UITheme.StrokeThickness.Thin);
		return button;
	}

	private applyCorner(parent: GuiObject, radius: UDim): void {
		const corner = new Instance("UICorner");
		corner.CornerRadius = radius;
		corner.Parent = parent;
	}

	private applyStroke(parent: GuiObject, color: Color3, thickness: number): void {
		const stroke = new Instance("UIStroke");
		stroke.Color = color;
		stroke.Thickness = thickness;
		stroke.Transparency = UITheme.Transparency.StrokeDefault;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = parent;
	}
}
