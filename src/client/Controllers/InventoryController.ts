import { Players, ReplicatedStorage, TweenService, UserInputService } from "@rbxts/services";
import { REMOTES_FOLDER_NAME, REMOTE_NAMES, type RequestAllocatePayload } from "../../shared/Remotes";
import type { AllocatableStat } from "../../shared/TypeDefs";
import type { InventoryFighter, InventoryState } from "../UI/InventoryState";
import { GAME_FONT, UITheme } from "../UI/UITheme";

const T = UITheme.Inventory;
const C = UITheme.Colors;
const STATS: readonly AllocatableStat[] = ["hp", "atk", "dodge", "crit"];

/** Só apresenta snapshots. Nenhuma mutação otimista de stats, pontos ou time. */
export class InventoryController {
	public constructor(
		private readonly beforeOpen: () => void = () => {},
		private readonly visibilityChanged: (open: boolean) => void = () => {},
	) {}
	private readonly gui = new Instance("ScreenGui");
	private readonly toggle = new Instance("TextButton");
	private panel?: Frame;
	private state?: InventoryState;
	private selected?: string;
	private battleActive = false;
	private started = false;
	private destroyed = false;
	private readonly lifetime: RBXScriptConnection[] = [];
	private readonly visibleConnections: RBXScriptConnection[] = [];
	private readonly tweens: Tween[] = [];
	private allocate?: RemoteEvent;
	private setTeam?: RemoteEvent;

	public start(): void {
		if (this.started) return;
		this.started = true;
		this.gui.Name = T.ScreenGuiName;
		this.gui.DisplayOrder = T.DisplayOrder;
		this.gui.ResetOnSpawn = false;
		this.gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
		this.gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets;
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
		const inventory = folder.WaitForChild(REMOTE_NAMES.InventoryState) as RemoteEvent;
		this.lifetime.push(inventory.OnClientEvent.Connect((payload: InventoryState) => {
			this.state = payload;
			if (this.panel !== undefined) this.render();
		}));
		// Os listeners persistentes conservam snapshots e permitem reabrir a tela fechada.
		this.lifetime.push((folder.WaitForChild(REMOTE_NAMES.BattleStarted) as RemoteEvent).OnClientEvent.Connect(() => {
			this.battleActive = true;
			this.close();
			this.toggle.Visible = false;
		}));
		this.lifetime.push((folder.WaitForChild(REMOTE_NAMES.BattleEnded) as RemoteEvent).OnClientEvent.Connect(() => {
			this.battleActive = false;
			this.toggle.Visible = true;
		}));
		this.allocate = folder.WaitForChild(REMOTE_NAMES.RequestAllocate) as RemoteEvent;
		this.setTeam = folder.WaitForChild(REMOTE_NAMES.RequestSetTeam) as RemoteEvent;
	}

	public close(): void {
		for (const connection of this.visibleConnections) connection.Disconnect();
		this.visibleConnections.clear();
		for (const tween of this.tweens) tween.Cancel();
		this.tweens.clear();
		const panel = this.panel;
		this.panel = undefined;
		panel?.Destroy();
		this.toggle.Visible = !this.battleActive;
		this.visibilityChanged(false);
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
		if (this.battleActive) return;
		if (this.panel !== undefined) this.close();
		else { this.beforeOpen(); this.render(); }
	}

	private render(): void {
		const oldGrid = this.panel?.FindFirstChild("Grid");
		const scroll = oldGrid?.IsA("ScrollingFrame") ? oldGrid.CanvasPosition : Vector2.zero;
		this.close();
		this.toggle.Visible = false;
		const panel = this.frame(this.gui, "Panel", T.PanelPos, T.PanelSize, C.PanelBackground);
		this.panel = panel;
		this.label(panel, T.Title, T.TitlePos, T.TitleSize);
		this.button(panel, "Close", T.CloseText, T.ClosePos, T.CloseSize, () => this.close());
		const grid = new Instance("ScrollingFrame");
		grid.Name = "Grid";
		grid.Position = T.GridPos;
		grid.Size = T.GridSize;
		grid.BackgroundTransparency = UITheme.Transparency.Hidden;
		grid.BorderSizePixel = 0;
		grid.ScrollBarThickness = T.ScrollThickness;
		grid.AutomaticCanvasSize = Enum.AutomaticSize.Y;
		grid.CanvasSize = UDim2.fromScale(0, 0);
		grid.ScrollingDirection = Enum.ScrollingDirection.Y;
		grid.Parent = panel;
		const layout = new Instance("UIGridLayout");
		layout.CellSize = T.CellSize;
		layout.CellPadding = T.CellGap;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Parent = grid;
		if (this.state === undefined || this.state.fighters.isEmpty()) {
			this.label(panel, this.state === undefined ? T.Loading : T.Empty, T.GridPos, T.GridSize);
		} else {
			this.state.fighters.forEach((fighter, index) => this.card(grid, fighter, index));
		}
		grid.CanvasPosition = scroll;
		const detail = this.frame(panel, "Detail", T.DetailPos, T.DetailSize, C.PanelSecondary);
		const fighter = this.state?.fighters.find((item) => item.itemUuid === this.selected);
		if (fighter !== undefined) this.detail(detail, fighter);
		else this.label(detail, this.state?.allocationReason !== undefined ? T.AllocationReasons[this.state.allocationReason] : T.Select, UITheme.Layout.OriginPosition, UITheme.Layout.FullSize);
		this.team(panel, fighter);
		this.visibilityChanged(true);
	}

	private card(parent: Instance, fighter: InventoryFighter, index: number): void {
		const card = this.button(parent, fighter.itemUuid, "", UITheme.Layout.OriginPosition, T.CellSize, () => {
			this.selected = fighter.itemUuid;
			this.render();
		});
		card.LayoutOrder = index;
		const inTeam = this.state?.activeTeam.includes(fighter.itemUuid) === true;
		card.BackgroundColor3 = fighter.unavailable ? C.SkillDisabledBg : this.selected === fighter.itemUuid ? C.TagActiveBg : C.PanelSecondary;
		const name = this.label(card, fighter.displayName, T.CardNamePos, T.CardNameSize);
		name.TextColor3 = fighter.unavailable ? C.TextMuted : fighter.rarity !== undefined ? T.RarityColors[fighter.rarity] : C.TextPrimary;
		const meta = this.label(card, `${fighter.rarity ?? "—"} · ${fighter.className ?? "—"}\nLv.${fighter.level}`, T.CardMetaPos, T.CardMetaSize);
		meta.TextColor3 = fighter.unavailable ? C.TextMuted : C.TextSecondary;
		const badge = this.label(card, fighter.unavailable ? T.Unavailable : fighter.newLevel ? T.NewLevel : inTeam ? T.InTeam : "", T.CardBadgePos, T.CardBadgeSize);
		badge.TextColor3 = fighter.unavailable ? C.TextMuted : C.RewardGold;
		if (fighter.newLevel === true && !fighter.unavailable) {
			const tween = TweenService.Create(badge, new TweenInfo(T.BlinkSeconds, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { TextTransparency: T.BlinkTransparency });
			this.tweens.push(tween);
			tween.Play();
		}
	}

	private detail(parent: Frame, fighter: InventoryFighter): void {
		this.label(parent, `${fighter.displayName} · Lv.${fighter.level}`, T.DetailNamePos, T.DetailNameSize);
		this.bar(parent, "XP", fighter.xpToNext > 0 ? fighter.xp / fighter.xpToNext : 1,
			fighter.xpToNext > 0 ? `${fighter.xp} / ${fighter.xpToNext} XP` : T.MaxXp, T.XpPos, T.XpSize, C.AtbFillPlayer);
		const reason = this.state?.allocationReason ?? fighter.allocationReason;
		this.label(parent, reason !== undefined ? T.AllocationReasons[reason] : `Pontos disponíveis: ${fighter.availablePoints}`, T.PointsPos, T.PointsSize);
		const rows = this.frame(parent, "Stats", T.StatsPos, T.StatsSize);
		for (const index of $range(0, STATS.size() - 1)) {
			const stat = STATS[index];
			const row = this.frame(rows, stat, UDim2.fromScale(0, index * T.StatStep), UDim2.fromScale(1, T.StatHeight));
			const value = fighter.effectiveStats[stat];
			this.bar(row, stat, value / T.StatDisplayRange[stat], `${string.upper(stat)}  ${string.format("%g", value)}`, UITheme.Layout.OriginPosition, T.StatTrackSize, C.AtbFillPlayer);
			const plus = this.button(row, "Allocate", "+", T.PlusPos, T.PlusSize, () => {
				if (this.battleActive || fighter.availablePoints <= 0 || fighter.unavailable) return;
				const payload: RequestAllocatePayload = { itemUuid: fighter.itemUuid, stat, amount: 1 };
				this.allocate?.FireServer(payload);
			});
			const aspect = new Instance("UIAspectRatioConstraint");
			aspect.AspectRatio = T.PlusAspect;
			aspect.AspectType = Enum.AspectType.FitWithinMaxSize;
			aspect.Parent = plus;
			this.enable(plus, fighter.availablePoints > 0 && !fighter.unavailable);
		}
		const skills = this.frame(parent, "Skills", T.SkillsPos, T.SkillsSize);
		for (const index of $range(0, fighter.skills.size() - 1)) {
			const skill = fighter.skills[index];
			const locked = index === 2 && !fighter.s3Unlocked;
			const label = this.label(skills, `S${index + 1}\n${UITheme.Texts.FormatCost(skill.cost)}${locked ? `\n${UITheme.Texts.SkillLockedState}` : ""}`,
				UDim2.fromScale(index * T.SkillStep, 0), UDim2.fromScale(T.SkillWidth, 1));
			label.TextColor3 = locked ? C.TextMuted : C.TextSecondary;
		}
	}

	private team(parent: Frame, selected?: InventoryFighter): void {
		const root = this.frame(parent, "Team", T.TeamPos, T.TeamSize);
		this.label(root, T.TeamHint, UITheme.Layout.OriginPosition, T.TeamTitleSize);
		for (const index of $range(0, 2)) {
			const uuid = this.state?.activeTeam[index];
			const fighter = this.state?.fighters.find((item) => item.itemUuid === uuid);
			const slot = this.button(root, `Slot${index + 1}`, `${index + 1} · ${fighter?.displayName ?? (uuid !== undefined ? uuid : T.EmptySlot)}`,
				UDim2.fromScale(index * T.SlotStep, T.TeamSlotY), UDim2.fromScale(T.SlotWidth, T.TeamSlotHeight), () => {
					if (this.battleActive || selected === undefined || selected.unavailable || this.state === undefined) return;
					// Serialização da seleção para o contrato denso { uuids }; validação pertence ao servidor.
					const uuids = [...this.state.activeTeam];
					const previous = uuids.indexOf(selected.itemUuid);
					if (previous >= 0) {
						const displaced = uuids[index];
						if (displaced !== undefined) uuids[previous] = displaced;
						else uuids.remove(previous);
					}
					uuids[index] = selected.itemUuid;
					this.setTeam?.FireServer({ uuids });
				});
			this.enable(slot, selected !== undefined && !selected.unavailable);
			if (fighter?.unavailable) slot.TextColor3 = C.TextMuted;
		}
	}

	private frame(parent: Instance, name: string, pos: UDim2, size: UDim2, color?: Color3): Frame {
		const frame = new Instance("Frame");
		frame.Name = name; frame.Position = pos; frame.Size = size; frame.BorderSizePixel = 0;
		frame.BackgroundColor3 = color ?? C.PanelBackground;
		frame.BackgroundTransparency = color !== undefined ? UITheme.Transparency.Opaque : UITheme.Transparency.Hidden;
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

	private label(parent: Instance, value: string, pos: UDim2, size: UDim2): TextLabel {
		const label = new Instance("TextLabel");
		this.styleText(label, value, pos, size); label.Parent = parent;
		return label;
	}

	private button(parent: Instance, name: string, value: string, pos: UDim2, size: UDim2, action: () => void): TextButton {
		const button = new Instance("TextButton");
		button.Name = name; this.styleText(button, value, pos, size);
		button.BackgroundColor3 = C.ActionButtonSecondary;
		button.BackgroundTransparency = UITheme.Transparency.Opaque;
		button.Parent = parent;
		this.visibleConnections.push(button.Activated.Connect(action));
		return button;
	}

	private enable(button: TextButton, enabled: boolean): void {
		button.Active = enabled; button.Selectable = enabled; button.AutoButtonColor = enabled;
		button.TextColor3 = enabled ? C.TextPrimary : C.TextMuted;
		button.BackgroundColor3 = enabled ? C.ActionButtonSecondary : C.SkillDisabledBg;
	}

	private bar(parent: Instance, name: string, fraction: number, text: string, pos: UDim2, size: UDim2, color: Color3): void {
		const track = this.frame(parent, name, pos, size, C.BarTrack);
		this.frame(track, "Fill", UITheme.Layout.OriginPosition, UDim2.fromScale(math.clamp(fraction, 0, 1), 1), color);
		this.label(track, text, UITheme.Layout.OriginPosition, UITheme.Layout.FullSize);
	}
}
