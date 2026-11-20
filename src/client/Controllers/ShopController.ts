import { HttpService, Players, ReplicatedStorage, RunService, UserInputService } from "@rbxts/services";
import { S3_UNLOCK_LEVEL } from "../../shared/Config";
import { REMOTE_NAMES, REMOTES_FOLDER_NAME, type PurchaseReason, type PurchaseResultPayload, type RequestPurchasePayload, type ShopStatePayload, type TinyesChangedPayload } from "../../shared/Remotes";
import { SHOP_PREVIEW, SHOP_PREVIEW_BALANCE } from "../UI/ShopPreview";
import { GAME_FONT, UITheme } from "../UI/UITheme";

const T = UITheme.Shop;
const C = UITheme.Colors;
type Offer = ShopStatePayload["offers"][number];
let requestCounter = 0;

/** Apresenta apenas snapshots. O servidor autoriza, debita e entrega no InventoryState. */
export class ShopController {
	private readonly gui = new Instance("ScreenGui");
	private readonly toggle = new Instance("TextButton");
	private readonly lifetime: RBXScriptConnection[] = [];
	private readonly visibleConnections: RBXScriptConnection[] = [];
	private readonly buttons: { button: TextButton; offer: Offer }[] = [];
	private panel?: Frame;
	private balanceLabel?: TextLabel;
	private noticeLabel?: TextLabel;
	private state?: ShopStatePayload;
	private balance?: number;
	private liveState?: ShopStatePayload;
	private liveBalance?: number;
	private preview = false;
	private previewResult: PurchaseReason | "ok" | "timeout" = "ok";
	private battleActive = false;
	private inventoryOpen = false;
	private started = false;
	private destroyed = false;
	private purchase?: RemoteEvent;
	private pending?: { requestId: string; name: string };
	private requestDeadline?: number;
	private requestTimer?: thread;
	private previewTimer?: thread;
	private noticeTimer?: thread;
	private notice = "";

	public constructor(private readonly beforeOpen: () => void = () => {}) {}

	public start(): void {
		if (this.started || this.destroyed) return;
		this.started = true;
		this.gui.Name = T.ScreenGuiName;
		this.gui.DisplayOrder = T.DisplayOrder;
		this.gui.ResetOnSpawn = false;
		this.gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets;
		this.gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
		this.toggle.Name = "Toggle";
		this.styleText(this.toggle, T.ToggleText, T.TogglePos, T.ToggleSize);
		this.toggle.BackgroundColor3 = C.PanelSecondary;
		this.toggle.BackgroundTransparency = UITheme.Transparency.Opaque;
		this.toggle.Parent = this.gui;
		this.gui.Parent = Players.LocalPlayer.WaitForChild("PlayerGui");
		this.lifetime.push(this.toggle.Activated.Connect(() => this.toggleOpen()));
		this.lifetime.push(UserInputService.InputBegan.Connect((input, processed) => {
			if (!processed && UserInputService.GetFocusedTextBox() === undefined && input.KeyCode === T.ToggleKey) this.toggleOpen();
		}));
		this.lifetime.push(this.gui.Destroying.Connect(() => this.destroy()));
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME);
		this.purchase = folder.WaitForChild(REMOTE_NAMES.RequestPurchase) as RemoteEvent;
		this.lifetime.push((folder.WaitForChild(REMOTE_NAMES.PurchaseResult) as RemoteEvent).OnClientEvent.Connect((payload: PurchaseResultPayload) => {
			if (!this.preview) this.receiveResult(payload);
		}));
		// Assinaturas de vida conservam o último snapshot enquanto o painel está fechado.
		this.lifetime.push((folder.WaitForChild(REMOTE_NAMES.ShopState) as RemoteEvent).OnClientEvent.Connect((payload: ShopStatePayload) => {
			this.liveState = payload;
			if (!this.preview) this.receiveState(payload);
		}));
		this.lifetime.push((folder.WaitForChild(REMOTE_NAMES.TinyesChanged) as RemoteEvent).OnClientEvent.Connect((payload: TinyesChangedPayload) => {
			this.liveBalance = payload.balance;
			if (!this.preview) this.receiveBalance(payload.balance);
		}));
		this.lifetime.push((folder.WaitForChild(REMOTE_NAMES.BattleStarted) as RemoteEvent).OnClientEvent.Connect(() => {
			this.battleActive = true;
			this.close();
		}));
		this.lifetime.push((folder.WaitForChild(REMOTE_NAMES.BattleEnded) as RemoteEvent).OnClientEvent.Connect(() => {
			this.battleActive = false;
			this.toggle.Visible = !this.inventoryOpen;
		}));
		if (RunService.IsStudio()) {
			this.lifetime.push(Players.LocalPlayer.Chatted.Connect((message) => {
				const args = message.split(" ");
				if (args[0] === T.DevCommand) this.testShop(args[1]);
			}));
		}
	}

	private testShop(result = "ok"): void {
		if (!RunService.IsStudio() || this.battleActive) return;
		this.close();
		if (result === T.DevExit || this.pending !== undefined) return;
		if (result !== "ok" && result !== "timeout" && result !== "saldo" && result !== "oferta_invalida" && result !== "em_batalha" && result !== "limite" && result !== "erro") return;
		this.preview = true;
		this.previewResult = result;
		this.receiveBalance(SHOP_PREVIEW_BALANCE);
		this.receiveState(SHOP_PREVIEW);
		this.open();
	}

	public close(): void {
		this.clearView();
		// Conserva apenas o prazo lógico: fechar/reabrir não permite reenviar a compra.
		this.cancelRequest(this.preview || this.destroyed);
		if (this.previewTimer !== undefined) task.cancel(this.previewTimer);
		this.previewTimer = undefined;
		if (this.noticeTimer !== undefined) task.cancel(this.noticeTimer);
		this.noticeTimer = undefined;
		this.notice = "";
		if (this.preview) {
			this.preview = false;
			this.state = this.liveState;
			this.balance = this.liveBalance;
		}
		this.toggle.Visible = !this.battleActive && !this.inventoryOpen && !this.destroyed;
	}

	public setInventoryOpen(open: boolean): void {
		this.inventoryOpen = open;
		this.toggle.Visible = !open && !this.battleActive && this.panel === undefined && !this.destroyed;
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.close();
		for (const connection of this.lifetime) connection.Disconnect();
		this.lifetime.clear();
		this.gui.Destroy();
	}

	private toggleOpen(): void {
		if (this.panel !== undefined) this.close();
		else this.open();
	}

	private open(): void {
		if (this.battleActive || this.destroyed) return;
		this.beforeOpen();
		this.resumeRequest();
		this.render();
		if (this.notice !== "") this.showNotice(this.notice);
	}

	private receiveState(payload: ShopStatePayload): void {
		this.state = payload;
		if (this.panel !== undefined) this.render();
	}

	private receiveBalance(balance: number): void {
		this.balance = balance;
		this.refreshButtons();
	}

	private receiveResult(payload: PurchaseResultPayload): void {
		const pending = this.pending;
		if (pending === undefined || payload.requestId !== pending.requestId) return;
		this.cancelRequest();
		this.showNotice(payload.ok ? `${T.Purchased} ${pending.name}` : T.PurchaseReasons[payload.reason ?? "erro"]);
		this.refreshButtons();
	}

	private buy(offer: Offer): void {
		if (this.panel === undefined || this.battleActive || this.pending !== undefined || this.balance === undefined || this.balance < offer.price) return;
		if (!this.state?.offers.some((current) => current.offerId === offer.offerId)) return;
		// Contador local + 8 caracteres aleatórios: permanece abaixo dos 64 bytes do contrato.
		const requestId = `${++requestCounter}-${HttpService.GenerateGUID(false).sub(1, 8)}`;
		this.pending = { requestId, name: offer.displayName };
		this.requestDeadline = os.clock() + T.PurchaseTimeoutSeconds;
		this.refreshButtons();
		this.resumeRequest();
		// Preview não envia IDs sintéticos nem altera saldo/inventário no servidor.
		if (this.preview) {
			const result = this.previewResult;
			if (result !== "timeout") this.previewTimer = task.delay(T.DevResultSeconds, () => {
				this.previewTimer = undefined;
				this.receiveResult({ requestId, offerId: offer.offerId, ok: result === "ok", reason: result === "ok" ? undefined : result });
			});
		} else {
			const payload: RequestPurchasePayload = { offerId: offer.offerId, requestId };
			this.purchase?.FireServer(payload);
		}
	}

	private cancelRequest(release = true): void {
		if (this.requestTimer !== undefined) task.cancel(this.requestTimer);
		this.requestTimer = undefined;
		if (release) {
			this.pending = undefined;
			this.requestDeadline = undefined;
		}
	}

	private resumeRequest(): void {
		if (this.pending === undefined || this.requestDeadline === undefined || this.requestTimer !== undefined) return;
		const remaining = this.requestDeadline - os.clock();
		if (remaining <= 0) { this.cancelRequest(); this.showNotice(T.Timeout); return; }
		this.requestTimer = task.delay(remaining, () => {
			this.requestTimer = undefined;
			this.cancelRequest();
			this.showNotice(T.Timeout);
			this.refreshButtons();
		});
	}

	private showNotice(text: string): void {
		if (this.noticeTimer !== undefined) task.cancel(this.noticeTimer);
		this.noticeTimer = undefined;
		this.notice = text;
		if (this.panel === undefined) return;
		if (this.noticeLabel !== undefined) this.noticeLabel.Text = text;
		this.noticeTimer = task.delay(T.NoticeSeconds, () => {
			this.noticeTimer = undefined;
			this.notice = "";
			if (this.noticeLabel !== undefined) this.noticeLabel.Text = "";
		});
	}

	private clearView(): void {
		for (const connection of this.visibleConnections) connection.Disconnect();
		this.visibleConnections.clear();
		this.buttons.clear();
		this.balanceLabel = undefined;
		this.noticeLabel = undefined;
		const panel = this.panel;
		this.panel = undefined;
		panel?.Destroy();
	}

	private render(): void {
		this.clearView();
		this.toggle.Visible = false;
		const panel = this.frame(this.gui, "Panel", T.PanelPos, T.PanelSize, C.PanelBackground);
		this.panel = panel;
		this.label(panel, "Title", this.preview ? `${T.Title} · STUDIO` : T.Title, T.TitlePos, T.TitleSize);
		this.balanceLabel = this.label(panel, "Balance", T.FormatBalance(this.balance), T.BalancePos, T.BalanceSize);
		this.balanceLabel.TextColor3 = C.RewardGold;
		this.noticeLabel = this.label(panel, "Notice", this.notice, T.NoticePos, T.NoticeSize);
		const close = this.button(panel, "Close", T.CloseText, T.ClosePos, T.CloseSize, () => this.close());
		const aspect = new Instance("UIAspectRatioConstraint");
		aspect.AspectRatio = T.CloseAspect;
		aspect.AspectType = Enum.AspectType.FitWithinMaxSize;
		aspect.Parent = close;
		const cards = this.frame(panel, "Cards", T.CardsPos, T.CardsSize, C.PanelBackground);
		for (let index = 0; index < T.ShelfCount; index++) {
			const card = this.frame(cards, `Shelf${index + 1}`, UDim2.fromScale(index * T.CardStep, 0), UDim2.fromScale(T.CardWidth, 1), C.PanelSecondary);
			const offer = this.state?.offers[index];
			if (offer === undefined) {
				this.label(card, "Empty", this.state === undefined ? T.Loading : T.EmptyShelf, UITheme.Layout.OriginPosition, UITheme.Layout.FullSize);
				continue;
			}
			this.label(card, "Name", offer.displayName, T.NamePos, T.NameSize);
			this.label(card, "Rarity", offer.rarity, T.RarityPos, T.RaritySize).TextColor3 = UITheme.Inventory.RarityColors[offer.rarity];
			this.label(card, "Meta", `${offer.className} · Lv${offer.level}`, T.MetaPos, T.MetaSize);
			const stats = offer.baseStats;
			this.label(card, "BaseStats", `HP ${T.FormatValue(stats.hp)} · ATK ${T.FormatValue(stats.atk)}\nDodge ${T.FormatValue(stats.dodge)} · Crit ${T.FormatValue(stats.crit)}`, T.StatsPos, T.StatsSize);
			const locked = offer.level < S3_UNLOCK_LEVEL;
			this.label(card, "SlotCosts", `S1 ${T.FormatValue(offer.slotCosts[0])}\nS2 ${T.FormatValue(offer.slotCosts[1])}\nS3 ${T.FormatValue(offer.slotCosts[2])}${locked ? ` ${UITheme.Texts.SkillLockedState}` : ""}`, T.CostsPos, T.CostsSize);
			this.label(card, "Price", T.FormatPrice(offer.price), T.PricePos, T.PriceSize).TextColor3 = C.RewardGold;
			const button = this.button(card, "Buy", T.Buy, T.BuyPos, T.BuySize, () => this.buy(offer));
			this.buttons.push({ button, offer });
		}
		this.refreshButtons();
	}

	private refreshButtons(): void {
		if (this.balanceLabel !== undefined) this.balanceLabel.Text = T.FormatBalance(this.balance);
		for (const { button, offer } of this.buttons) {
			const enabled = this.pending === undefined && this.balance !== undefined && this.balance >= offer.price && !this.battleActive;
			button.Active = enabled;
			button.Selectable = enabled;
			button.AutoButtonColor = enabled;
			button.Text = this.pending !== undefined ? T.Pending : this.balance === undefined ? T.UnknownBalance : this.balance < offer.price ? T.Insufficient : T.Buy;
			button.BackgroundColor3 = enabled ? C.ActionButtonPrimary : C.SkillDisabledBg;
			button.TextColor3 = enabled ? C.TextPrimary : C.TextMuted;
		}
	}

	private frame(parent: Instance, name: string, pos: UDim2, size: UDim2, color: Color3): Frame {
		const frame = new Instance("Frame");
		frame.Name = name; frame.Position = pos; frame.Size = size;
		frame.BorderSizePixel = 0; frame.BackgroundColor3 = color;
		frame.Parent = parent;
		return frame;
	}

	private styleText(text: TextLabel | TextButton, value: string, pos: UDim2, size: UDim2): void {
		text.Position = pos; text.Size = size; text.Text = value;
		text.FontFace = GAME_FONT; text.TextColor3 = C.TextPrimary;
		text.TextScaled = true; text.TextWrapped = true; text.BorderSizePixel = 0;
		text.BackgroundTransparency = UITheme.Transparency.Hidden;
		const constraint = new Instance("UITextSizeConstraint");
		constraint.MinTextSize = T.MinTextSize; constraint.MaxTextSize = T.MaxTextSize; constraint.Parent = text;
	}

	private label(parent: Instance, name: string, value: string, pos: UDim2, size: UDim2): TextLabel {
		const label = new Instance("TextLabel");
		label.Name = name; this.styleText(label, value, pos, size); label.Parent = parent;
		return label;
	}

	private button(parent: Instance, name: string, value: string, pos: UDim2, size: UDim2, action: () => void): TextButton {
		const button = new Instance("TextButton");
		button.Name = name; this.styleText(button, value, pos, size);
		button.BackgroundTransparency = UITheme.Transparency.Opaque;
		button.BackgroundColor3 = C.ActionButtonSecondary;
		button.Parent = parent;
		this.visibleConnections.push(button.Activated.Connect(action));
		return button;
	}
}
