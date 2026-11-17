import { battleCleanupStep } from "../Controllers/BattleCleanup";
import { TweenService } from "@rbxts/services";
import { S3_UNLOCK_LEVEL } from "../../shared/Config";
import type { FighterXpReward } from "../../shared/TypeDefs";
import { UITheme } from "./UITheme";

// Optional server extension: one total XP cost for each completed level, in order.
type RewardWithSteps = FighterXpReward & { readonly steps?: readonly { readonly level: number; readonly xpToNext: number }[] };
export class XpRewardCards {
    private root?: Frame;
    private tweens = new Set<Tween>();
    private connections = new Set<RBXScriptConnection>();
    private generation = 0;
    public clear(): void {
        this.release(true);
    }
    private release(destroyRoot: boolean): void {
        this.generation++;
        for (const connection of this.connections) battleCleanupStep("XP connection", () => connection.Disconnect());
        this.connections.clear();
        for (const tween of this.tweens) battleCleanupStep("XP tween", () => tween.Cancel());
        this.tweens.clear();
        const root = this.root;
        this.root = undefined;
        if (destroyRoot && root !== undefined) battleCleanupStep("XP root", () => root.Destroy());
    }
    public show(overlay: Frame | undefined, rewards?: readonly FighterXpReward[]): void {
        this.clear();
        if (!rewards || rewards.size() === 0) return;
        if (overlay === undefined || overlay.Parent === undefined || !overlay.IsDescendantOf(game)) return;
        const modal = overlay.FindFirstChild("ResultModalCard");
        if (modal === undefined || !modal.IsA("Frame") || modal.Parent === undefined) return;
        const row = new Instance("Frame");
        row.Name = "XpRewards";
        row.Position = UITheme.Xp.RowPos; row.Size = UITheme.Xp.RowSize;
        row.BackgroundTransparency = UITheme.Transparency.Hidden; row.ZIndex = modal.ZIndex;
        row.Parent = modal; this.root = row;
        const generation = this.generation;
        this.connections.add(row.Destroying.Connect(() => {
            if (generation === this.generation) this.release(false);
        }));
        this.connections.add(modal.Destroying.Connect(() => {
            if (generation === this.generation) this.clear();
        }));
        this.connections.add(row.AncestryChanged.Connect(() => {
            if (generation === this.generation && !this.isLive(generation, row)) this.clear();
        }));
        const count = math.min(rewards.size(), UITheme.Xp.MaxCards);
        rewards.forEach((reward, index) => {
            if (index >= count) return;
            this.card(row, reward, index, count);
        });
    }
    private card(row: Frame, reward: RewardWithSteps, index: number, count: number): void {
        if (!this.isLive(this.generation, row)) return;
        const t = UITheme.Xp;
        const card = new Instance("Frame"); card.Name = reward.itemUuid;
        card.AnchorPoint = UITheme.Layout.CenterAnchor;
        card.Position = UDim2.fromScale(t.Center + (index - (count - 1) / 2) * (t.CardWidth + t.Gap), t.Center);
        card.Size = UDim2.fromScale(t.CardWidth, 1);
        card.BackgroundColor3 = UITheme.ClassColors[reward.className]; card.ZIndex = row.ZIndex;
        card.Parent = row;
        const aspect = new Instance("UIAspectRatioConstraint"); aspect.AspectRatio = t.Aspect; aspect.Parent = card;
        this.corner(card, t.Corner);
        const stroke = new Instance("UIStroke"); stroke.Thickness = t.Stroke; stroke.Color = UITheme.Colors.TextDark; stroke.Parent = card;
        const gradient = new Instance("UIGradient"); gradient.Color = new ColorSequence(UITheme.Colors.TextPrimary, UITheme.Colors.PanelSecondary); gradient.Rotation = t.GradientRotation; gradient.Parent = card;
        this.label(card, "Gain", t.GainPos, t.GainSize, `+${reward.xpGained} XP`, UITheme.Fonts.Medium);
        this.label(card, "DisplayName", t.NamePos, t.NameSize, reward.displayName, UITheme.Fonts.Title);
        const badge = this.label(card, "Class", t.BadgePos, t.BadgeSize, reward.className, UITheme.Fonts.Bold);
        badge.BackgroundTransparency = UITheme.Transparency.Opaque; badge.BackgroundColor3 = UITheme.ClassColors[reward.className]; this.corner(badge, t.Circle);
        const level = this.label(card, "Level", t.LevelPos, t.LevelSize, `LVL ${reward.previousLevel}`, UITheme.Fonts.Title);
        level.TextStrokeColor3 = UITheme.Colors.TextDark; level.TextStrokeTransparency = t.LevelStrokeTransparency;
        const unlock = this.label(card, "Unlock", t.UnlockPos, t.UnlockSize, t.UnlockText, UITheme.Fonts.Bold);
        unlock.TextColor3 = t.Highlight; unlock.Visible = false;
        const track = new Instance("Frame"); track.Name = "XpTrack"; track.Position = t.BarPos; track.Size = t.BarSize;
        track.BackgroundColor3 = UITheme.Colors.BarTrack; track.ZIndex = card.ZIndex; track.Parent = card; this.corner(track, t.Circle);
        const fill = new Instance("Frame"); fill.Name = "XpFill"; fill.BorderSizePixel = 0;
        fill.BackgroundColor3 = t.Fill; fill.ZIndex = track.ZIndex; fill.Parent = track; this.corner(fill, t.Circle);
        const ratio = (xp: number, cost: number) => cost > 0 ? math.clamp(xp / cost, 0, 1) : 0;
        fill.Size = UDim2.fromScale(ratio(reward.previousXp, reward.previousXpToNext), 1);
        const generation = this.generation;
        const live = () => this.isLive(generation, card, level, unlock, fill);
        const finish = () => {
            if (!live()) return;
            level.Text = `LVL ${reward.newLevel}`;
            unlock.Visible = reward.previousLevel < S3_UNLOCK_LEVEL && reward.newLevel >= S3_UNLOCK_LEVEL;
            this.animate(fill, { Size: UDim2.fromScale(ratio(reward.newXp, reward.newXpToNext), 1) }, t.FillSeconds, generation);
        };
        const levels = reward.newLevel - reward.previousLevel;
        if (!reward.leveledUp || levels <= 0) { finish(); return; }
        // With exactly two levels the sole intermediate cost is determined by the payload.
        const costs = [reward.previousXpToNext];
        if (levels === 2) costs.push(reward.xpGained - (reward.previousXpToNext - reward.previousXp) - reward.newXp);
        if (levels > 2) {
            if (!reward.steps || reward.steps.size() !== levels) {
                warn("XP cards: servidor deve incluir steps [{level, xpToNext}] para cada nivel concluido.");
                finish(); return;
            }
            for (let i = 1; i < levels; i++) {
                const step = reward.steps[i];
                if (step.level !== reward.previousLevel + i || step.xpToNext <= 0) { finish(); return; }
                costs.push(step.xpToNext);
            }
        }
        const advance = (index: number): void => {
            if (!live()) return;
            this.animate(fill, { Size: UITheme.Layout.FullSize }, t.FillSeconds, generation, () => {
                if (!live()) return;
                const nextLevel = reward.previousLevel + index + 1;
                level.Text = `LVL ${nextLevel}`; level.TextColor3 = t.Highlight;
                if (reward.previousLevel < S3_UNLOCK_LEVEL && nextLevel >= S3_UNLOCK_LEVEL) unlock.Visible = true;
                this.animate(level, { TextColor3: UITheme.Colors.TextPrimary }, t.HighlightSeconds, generation, () => {
                    if (!live()) return;
                    fill.Size = UDim2.fromScale(0, 1);
                    if (index + 1 < costs.size()) advance(index + 1); else finish();
                });
            });
        };
        advance(0);
    }
    private isLive(generation: number, ...objects: Instance[]): boolean {
        const root = this.root;
        if (generation !== this.generation || root === undefined || root.Parent === undefined || !root.IsDescendantOf(game)) return false;
        return objects.every((object) => object.Parent !== undefined && (object === root || object.IsDescendantOf(root)));
    }
    private animate<T extends Instance>(object: T, goal: Partial<ExtractMembers<T, Tweenable>>, seconds: number, generation: number, done?: () => void): void {
        if (!this.isLive(generation, object)) return;
        const tween = TweenService.Create(object, new TweenInfo(seconds, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), goal);
        this.tweens.add(tween);
        const connection = tween.Completed.Connect((state) => {
            connection.Disconnect(); this.connections.delete(connection); this.tweens.delete(tween);
            if (this.isLive(generation, object) && state === Enum.PlaybackState.Completed) done?.();
        });
        this.connections.add(connection); tween.Play();
    }
    private corner(object: GuiObject, radius: UDim): void { const corner = new Instance("UICorner"); corner.CornerRadius = radius; corner.Parent = object; }
    private label(parent: Frame, name: string, position: UDim2, size: UDim2, text: string, font: Enum.Font): TextLabel {
        const label = new Instance("TextLabel"); label.Name = name; label.Position = position; label.Size = size;
        label.BackgroundTransparency = UITheme.Transparency.Hidden; label.Text = text; label.Font = font;
        label.TextScaled = true; label.TextWrapped = true; label.TextColor3 = UITheme.Colors.TextPrimary; label.ZIndex = parent.ZIndex; label.Parent = parent; return label;
    }
    public static devRewards(): FighterXpReward[] {
        return [
            { itemUuid: "dev-one", fighterId: "dev", displayName: "Um nivel", className: "Fury", xpGained: 70, previousLevel: 1, previousXp: 80, previousXpToNext: 100, newLevel: 2, newXp: 50, newXpToNext: 200, leveledUp: true },
            { itemUuid: "dev-two", fighterId: "dev", displayName: "Dois niveis", className: "Menace", xpGained: 270, previousLevel: 1, previousXp: 80, previousXpToNext: 100, newLevel: 3, newXp: 50, newXpToNext: 300, leveledUp: true },
            { itemUuid: "dev-s3", fighterId: "dev", displayName: "S3 desbloqueado", className: "Support", xpGained: 100, previousLevel: 4, previousXp: 350, previousXpToNext: 400, newLevel: 5, newXp: 50, newXpToNext: 500, leveledUp: true },
        ];
    }
}

