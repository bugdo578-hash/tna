import { TweenService } from "@rbxts/services";
import { ATB_MAX, FLOAT_TOLERANCE } from "../../shared/Config";
import { clamp } from "../../shared/MathUtils";
import type { ClientFighterIndex } from "../../shared/Remotes";
import type { ClassName, StatusEffect } from "../../shared/TypeDefs";
import { battleCleanupStep } from "../Controllers/BattleCleanup";
import { UITheme } from "./UITheme";

export interface HudEffectMeta {
	readonly duration: number;
	readonly remainingDuration: number;
	readonly charges?: number;
	readonly maxCharges?: number;
}

export interface HudFighterState {
	readonly targetId: string;
	readonly fighterId: string;
	readonly sideId: string;
	readonly sideIndex: 0 | 1;
	readonly teamSlotIndex: ClientFighterIndex;
	readonly displayName: string;
	readonly iconText: string;
	readonly className: ClassName;
	readonly level: number;
	readonly s3Unlocked: boolean;
	readonly slotCosts: readonly [number, number, number];
	readonly skillNames: readonly [string, string, string];
	hp: number;
	hpMax: number;
	active: boolean;
	dead: boolean;
	readonly effects: Set<StatusEffect>;
	readonly effectMeta?: Map<StatusEffect, HudEffectMeta>;
}

export interface StatusCardWidgets {
	readonly root: Frame;
	readonly iconBadge: Frame;
	readonly iconLabel: TextLabel;
	readonly nameLabel: TextLabel;
	readonly metaLabel: TextLabel;
	readonly hpFill: Frame;
	readonly hpValueLabel: TextLabel;
	readonly atbFill: Frame;
	readonly atbValueLabel: TextLabel;
	readonly statusBadges: Readonly<Record<string, TextLabel>>;
	readonly genericStatusBadge?: TextLabel;
	readonly atbMarkers: readonly {
		readonly root: Frame;
		readonly line: Frame;
		readonly label: TextLabel;
	}[];
}

export interface HudFighterStatusHost {
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

export function resolveHpColor(hpRatio: number): Color3 {
	if (hpRatio > UITheme.Numbers.HpHighThreshold) return UITheme.Colors.HpFillHigh;
	if (hpRatio > UITheme.Numbers.HpMidThreshold) return UITheme.Colors.HpFillMid;
	return UITheme.Colors.HpFillLow;
}

/**
 * Constrói e atualiza os cards de status dos lutadores ativos (HP, tweens de HP,
 * badges de efeitos, barra ATB suavizada e marcadores de custo S1–S3).
 */
export class HudFighterStatus {
	private playerCard: StatusCardWidgets | undefined;
	private opponentCard: StatusCardWidgets | undefined;
	private readonly hpTweens = new Map<Frame, Tween>();
	private playerDisplayAtb = 0;
	private opponentDisplayAtb = 0;

	public constructor(private readonly host: HudFighterStatusHost) {}

	public buildCards(parent: GuiObject): void {
		this.clearHpTweens();
		this.playerCard = this.createStatusCard(
			parent,
			"PlayerStatusCard",
			UITheme.Layout.TopLeftAnchor,
			UITheme.Layout.PlayerCardPos,
			true,
		);
		this.opponentCard = this.createStatusCard(
			parent,
			"OpponentStatusCard",
			UITheme.Layout.TopRightAnchor,
			UITheme.Layout.OpponentCardPos,
			false,
		);
	}

	public getHpTweens(): Map<Frame, Tween> {
		return this.hpTweens;
	}

	public clearHpTweens(): void {
		for (const [, tween] of this.hpTweens) {
			battleCleanupStep("HP tween", () => tween.Cancel());
		}
		this.hpTweens.clear();
	}

	public resetAtbDisplay(): void {
		this.playerDisplayAtb = 0;
		this.opponentDisplayAtb = 0;
		this.stepAtbInterpolation(0, 0, 0);
	}

	public resetSideAtbDisplay(isPlayer: boolean): void {
		if (isPlayer) {
			this.playerDisplayAtb = 0;
		} else {
			this.opponentDisplayAtb = 0;
		}
	}

	public refreshActiveStatusCards(
		activePlayer: HudFighterState | undefined,
		activeOpponent: HudFighterState | undefined,
	): void {
		if (this.playerCard !== undefined && activePlayer !== undefined) {
			this.populateStatusCard(this.playerCard, activePlayer, true);
		}
		if (this.opponentCard !== undefined && activeOpponent !== undefined) {
			this.populateStatusCard(this.opponentCard, activeOpponent, false);
		}
	}

	public refreshPlayerAtbMarkers(activePlayer: HudFighterState | undefined, playerTargetAtb: number): void {
		if (this.playerCard !== undefined && activePlayer !== undefined) {
			for (const slot of [1, 2, 3] as const) {
				const marker = this.playerCard.atbMarkers[slot - 1];
				const cost = activePlayer.slotCosts[slot - 1];
				const reached = playerTargetAtb + FLOAT_TOLERANCE >= cost;
				const locked = slot === 3 && !activePlayer.s3Unlocked;
				const color = locked
					? UITheme.Colors.TextMuted
					: reached
						? UITheme.Colors.AtbMarkerReached
						: UITheme.Colors.AtbMarkerPending;
				const transparency = locked ? UITheme.Transparency.LockedSkillMarker : UITheme.Transparency.Opaque;
				marker.line.BackgroundTransparency = transparency;
				marker.label.TextTransparency = transparency;
				marker.line.BackgroundColor3 = color;
				marker.label.TextColor3 = color;
			}
		}
	}

	public stepAtbInterpolation(dt: number, playerTargetAtb: number, opponentTargetAtb: number): void {
		const alpha = clamp(dt * UITheme.Numbers.AtbSmoothingSpeed, 0, 1);
		this.playerDisplayAtb += (playerTargetAtb - this.playerDisplayAtb) * alpha;
		this.opponentDisplayAtb += (opponentTargetAtb - this.opponentDisplayAtb) * alpha;

		if (this.playerCard !== undefined) {
			const ratio = clamp(this.playerDisplayAtb / ATB_MAX, 0, 1);
			this.playerCard.atbFill.Size = UDim2.fromScale(ratio, 1);
			this.playerCard.atbValueLabel.Text = UITheme.Texts.FormatAtb(playerTargetAtb, ATB_MAX);
		}

		if (this.opponentCard !== undefined) {
			const ratio = clamp(this.opponentDisplayAtb / ATB_MAX, 0, 1);
			this.opponentCard.atbFill.Size = UDim2.fromScale(ratio, 1);
			this.opponentCard.atbValueLabel.Text = UITheme.Texts.FormatAtb(opponentTargetAtb, ATB_MAX);
		}
	}

	private createStatusCard(
		parent: GuiObject,
		name: string,
		anchorPoint: Vector2,
		position: UDim2,
		isPlayer: boolean,
	): StatusCardWidgets {
		const card = new Instance("Frame");
		card.Name = name;
		card.AnchorPoint = anchorPoint;
		card.Position = position;
		card.Size = UITheme.Layout.StatusCardSize;
		card.BackgroundColor3 = UITheme.Colors.PanelBackground;
		card.BackgroundTransparency = UITheme.Transparency.Panel;
		card.Parent = parent;

		this.host.applyCorner(card, UITheme.CornerRadius.Panel);
		this.host.applyStroke(card, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Normal);
		this.host.applyAspectRatio(card, UITheme.AspectRatios.StatusCard);

		const header = new Instance("Frame");
		header.Name = "Header";
		header.Position = UITheme.Layout.CardHeaderPos;
		header.Size = UITheme.Layout.CardHeaderSize;
		header.BackgroundTransparency = UITheme.Transparency.Hidden;
		header.Parent = card;

		const iconBadge = new Instance("Frame");
		iconBadge.Name = "IconBadge";
		iconBadge.Position = UITheme.Layout.FighterIconPos;
		iconBadge.Size = UITheme.Layout.FighterIconSize;
		iconBadge.BackgroundColor3 = UITheme.Colors.PanelSecondary;
		iconBadge.Parent = header;
		this.host.applyCorner(iconBadge, UITheme.CornerRadius.Badge);
		this.host.applyAspectRatio(iconBadge, UITheme.AspectRatios.IconBadge);

		const iconLabel = this.host.createTextLabel(
			iconBadge,
			"IconLabel",
			UITheme.Layout.OriginPosition,
			UITheme.Layout.FullSize,
			"?",
			UITheme.Fonts.Title,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Center,
		);

		const nameLabel = this.host.createTextLabel(
			header,
			"FighterName",
			UITheme.Layout.FighterNamePos,
			UITheme.Layout.FighterNameSize,
			isPlayer ? UITheme.Texts.PlayerSideTag : UITheme.Texts.OpponentSideTag,
			UITheme.Fonts.Title,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Left,
		);

		const metaLabel = this.host.createTextLabel(
			header,
			"FighterMeta",
			UITheme.Layout.FighterMetaPos,
			UITheme.Layout.FighterMetaSize,
			"",
			UITheme.Fonts.Medium,
			UITheme.Colors.TextSecondary,
			Enum.TextXAlignment.Left,
		);

		const badgeRow = new Instance("Frame");
		badgeRow.Name = "StatusBadges";
		badgeRow.Position = UITheme.Layout.StatusBadgeRowPos;
		badgeRow.Size = UITheme.Layout.StatusBadgeRowSize;
		badgeRow.BackgroundTransparency = UITheme.Transparency.Hidden;
		badgeRow.Parent = header;

		const effectsOrder: readonly StatusEffect[] = ["Burn", "Bleed", "Root", "Hamon"];
		const statusBadges = {} as Record<string, TextLabel>;
		const badgeStep = 1 / effectsOrder.size();
		const badgeWidth = badgeStep - 0.02;
		for (const idx of $range(0, effectsOrder.size() - 1)) {
			const effect = effectsOrder[idx];
			const badge = this.host.createTextLabel(
				badgeRow,
				`Badge_${effect}`,
				UDim2.fromScale(idx * badgeStep, 0),
				UDim2.fromScale(badgeWidth, 1),
				UITheme.Texts.StatusShortLabels[effect] ?? effect.upper(),
				UITheme.Fonts.Bold,
				UITheme.Colors.TextPrimary,
				Enum.TextXAlignment.Center,
			);
			badge.BackgroundColor3 = UITheme.StatusColors[effect] ?? UITheme.Colors.PanelSecondary;
			badge.BackgroundTransparency = UITheme.Transparency.Opaque;
			badge.Visible = false;
			this.host.applyCorner(badge, UITheme.CornerRadius.Badge);
			statusBadges[effect] = badge;
		}
		const genericStatusBadge = this.host.createTextLabel(
			badgeRow,
			"Badge_Generic",
			UDim2.fromScale((effectsOrder.size() - 1) * badgeStep, 0),
			UDim2.fromScale(badgeWidth, 1),
			"BUFF",
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Center,
		);
		genericStatusBadge.BackgroundColor3 = UITheme.Colors.PanelSecondary;
		genericStatusBadge.BackgroundTransparency = UITheme.Transparency.Opaque;
		genericStatusBadge.Visible = false;
		this.host.applyCorner(genericStatusBadge, UITheme.CornerRadius.Badge);

		// Barra de HP
		const hpTrack = new Instance("Frame");
		hpTrack.Name = "HpBarTrack";
		hpTrack.Position = UITheme.Layout.HpBarPos;
		hpTrack.Size = UITheme.Layout.HpBarSize;
		hpTrack.BackgroundColor3 = UITheme.Colors.BarTrack;
		hpTrack.BackgroundTransparency = UITheme.Transparency.BarTrack;
		hpTrack.Parent = card;
		this.host.applyCorner(hpTrack, UITheme.CornerRadius.Bar);
		this.host.applyStroke(hpTrack, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);

		const hpFill = new Instance("Frame");
		hpFill.Name = "HpFill";
		hpFill.Position = UITheme.Layout.OriginPosition;
		hpFill.Size = UITheme.Layout.FullSize;
		hpFill.BackgroundColor3 = UITheme.Colors.HpFillHigh;
		hpFill.BorderSizePixel = 0;
		hpFill.Parent = hpTrack;
		this.host.applyCorner(hpFill, UITheme.CornerRadius.Bar);

		this.host.createTextLabel(
			hpTrack,
			"HpTitle",
			UITheme.Layout.BarLabelPos,
			UITheme.Layout.BarLabelSize,
			UITheme.Texts.HpLabel,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Left,
		);

		const hpValueLabel = this.host.createTextLabel(
			hpTrack,
			"HpValue",
			UITheme.Layout.BarValuePos,
			UITheme.Layout.BarValueSize,
			"0 / 0",
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Right,
		);

		// Barra de ATB (0 a 10)
		const atbTrack = new Instance("Frame");
		atbTrack.Name = "AtbBarTrack";
		atbTrack.Position = UITheme.Layout.AtbBarPos;
		atbTrack.Size = UITheme.Layout.AtbBarSize;
		atbTrack.BackgroundColor3 = UITheme.Colors.BarTrack;
		atbTrack.BackgroundTransparency = UITheme.Transparency.BarTrack;
		atbTrack.Parent = card;
		this.host.applyCorner(atbTrack, UITheme.CornerRadius.Bar);
		this.host.applyStroke(atbTrack, UITheme.Colors.PanelStroke, UITheme.StrokeThickness.Thin);

		const atbFill = new Instance("Frame");
		atbFill.Name = "AtbFill";
		atbFill.Position = UITheme.Layout.OriginPosition;
		atbFill.Size = UDim2.fromScale(0, 1);
		atbFill.BackgroundColor3 = isPlayer ? UITheme.Colors.AtbFillPlayer : UITheme.Colors.AtbFillOpponent;
		atbFill.BorderSizePixel = 0;
		atbFill.Parent = atbTrack;
		this.host.applyCorner(atbFill, UITheme.CornerRadius.Bar);

		this.host.createTextLabel(
			atbTrack,
			"AtbTitle",
			UITheme.Layout.BarLabelPos,
			UITheme.Layout.BarLabelSize,
			UITheme.Texts.AtbLabel,
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Left,
		);

		const atbValueLabel = this.host.createTextLabel(
			atbTrack,
			"AtbValue",
			UITheme.Layout.BarValuePos,
			UITheme.Layout.BarValueSize,
			UITheme.Texts.FormatAtb(0, ATB_MAX),
			UITheme.Fonts.Bold,
			UITheme.Colors.TextPrimary,
			Enum.TextXAlignment.Right,
		);

		// Marcas visuais de custo de ATB (S1, S2, S3) na barra do player
		const atbMarkers: {
			readonly root: Frame;
			readonly line: Frame;
			readonly label: TextLabel;
		}[] = [];

		if (isPlayer) {
			for (const slot of [1, 2, 3] as const) {
				const defaultCost = UITheme.Numbers.DefaultSlotCosts[slot - 1];
				const markerRoot = new Instance("Frame");
				markerRoot.Name = `CostMarker_S${slot}`;
				markerRoot.AnchorPoint = UITheme.Layout.AtbMarkerLineAnchor;
				markerRoot.Position = UDim2.fromScale(clamp(defaultCost / ATB_MAX, 0.05, 0.95), 0.5);
				markerRoot.Size = UITheme.Layout.AtbMarkerLineSize;
				markerRoot.BackgroundTransparency = UITheme.Transparency.Hidden;
				markerRoot.ZIndex = 4;
				markerRoot.Parent = atbTrack;

				const markerLine = new Instance("Frame");
				markerLine.Name = "Line";
				markerLine.Size = UITheme.Layout.FullSize;
				markerLine.BackgroundColor3 = UITheme.Colors.AtbMarkerPending;
				markerLine.BorderSizePixel = 0;
				markerLine.ZIndex = 4;
				markerLine.Parent = markerRoot;

				const markerLabel = this.host.createTextLabel(
					markerRoot,
					"SlotLabel",
					UITheme.Layout.AtbMarkerLabelPos,
					UITheme.Layout.AtbMarkerLabelSize,
					`S${slot}`,
					UITheme.Fonts.Bold,
					UITheme.Colors.AtbMarkerPending,
					Enum.TextXAlignment.Center,
				);
				markerLabel.AnchorPoint = new Vector2(0.5, 0);
				markerLabel.ZIndex = 5;

				atbMarkers.push({ root: markerRoot, line: markerLine, label: markerLabel });
			}
		}

		return {
			root: card,
			iconBadge,
			iconLabel,
			nameLabel,
			metaLabel,
			hpFill,
			hpValueLabel,
			atbFill,
			atbValueLabel,
			statusBadges,
			genericStatusBadge,
			atbMarkers,
		};
	}

	private populateStatusCard(card: StatusCardWidgets, fighter: HudFighterState, isPlayer: boolean): void {
		card.iconBadge.BackgroundColor3 = UITheme.ClassColors[fighter.className];
		card.iconLabel.Text = fighter.iconText;
		card.nameLabel.Text = fighter.displayName;
		const sideTag = isPlayer ? UITheme.Texts.PlayerSideTag : UITheme.Texts.OpponentSideTag;
		card.metaLabel.Text = `${sideTag} • ${fighter.className} ${UITheme.Texts.LevelPrefix}${fighter.level}`;

		const hpRatio = fighter.hpMax > 0 ? clamp(fighter.hp / fighter.hpMax, 0, 1) : 0;
		const hpColor = resolveHpColor(hpRatio);
		card.hpFill.BackgroundColor3 = hpColor;
		this.hpTweens.get(card.hpFill)?.Cancel();
		const hpTween = TweenService.Create(
			card.hpFill,
			new TweenInfo(UITheme.Numbers.HpTweenSeconds, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ Size: UDim2.fromScale(hpRatio, 1) },
		);
		this.hpTweens.set(card.hpFill, hpTween);
		hpTween.Play();
		card.hpValueLabel.Text = UITheme.Texts.FormatHp(fighter.hp, fighter.hpMax);

		for (const effect of ["Burn", "Bleed", "Root", "Hamon"] as const) {
			const badge = card.statusBadges[effect];
			if (badge !== undefined) {
				badge.Visible = fighter.effects.has(effect);
			}
		}
		if (card.genericStatusBadge !== undefined) {
			let unknownEffect: string | undefined;
			for (const activeEffect of fighter.effects) {
				if (card.statusBadges[activeEffect] === undefined) {
					unknownEffect = tostring(activeEffect);
					break;
				}
			}
			if (unknownEffect !== undefined) {
				const shortMap = UITheme.Texts.StatusShortLabels as Readonly<Record<string, string>>;
				const colorMap = UITheme.StatusColors as Readonly<Record<string, Color3>>;
				card.genericStatusBadge.Text = shortMap[unknownEffect] ?? unknownEffect.sub(1, 5).upper();
				card.genericStatusBadge.BackgroundColor3 = colorMap[unknownEffect] ?? UITheme.Colors.PanelSecondary;
				card.genericStatusBadge.Visible = true;
			} else {
				card.genericStatusBadge.Visible = false;
			}
		}

		if (isPlayer) {
			for (const slot of [1, 2, 3] as const) {
				const marker = card.atbMarkers[slot - 1];
				const cost = fighter.slotCosts[slot - 1];
				const ratio = clamp(cost / ATB_MAX, 0.04, 0.96);
				marker.root.Position = UDim2.fromScale(ratio, 0.5);
				marker.label.Text = `S${slot}`;
			}
		}
	}
}
