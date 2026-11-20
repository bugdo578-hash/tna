import { Workspace } from "@rbxts/services";
import { MIN_DAMAGE } from "../../shared/Config";
import type { StatusEffect } from "../../shared/TypeDefs";
import {
	COMBAT_FEEDBACK_COLORS,
	DAMAGE_BILLBOARD_POOL_SIZE,
	DAMAGE_BILLBOARD_SIZE_CRIT,
	DAMAGE_BILLBOARD_SIZE_DOT,
	DAMAGE_BILLBOARD_SIZE_NORMAL,
	DAMAGE_POPUP_DURATION_SECONDS,
	DAMAGE_POPUP_RISE_STUDS,
} from "../UI/CombatVisualConfig";
import { GAME_FONT } from "../UI/UITheme";
import { battleCleanupStep } from "./BattleCleanup";

export interface BillboardPoolItem {
	readonly billboard: BillboardGui;
	readonly label: TextLabel;
	inUse: boolean;
}

export interface CombatDamagePoolHost {
	readonly createBattleTween: <T extends Instance>(
		object: T,
		info: TweenInfo,
		goal: Partial<ExtractMembers<T, Tweenable>>,
	) => Tween;
	readonly delayBattle: (seconds: number, callback: () => void) => void;
}

export class CombatDamagePool {
	public readonly billboardPool: BillboardPoolItem[] = [];
	public poolContainer: Folder | undefined;

	public constructor(private readonly host: CombatDamagePoolHost) {}

	public initBillboardPool(): Folder {
		const container = new Instance("Folder");
		container.Name = "CombatBillboardPool";
		container.Parent = Workspace;
		this.poolContainer = container;

		for (const index of $range(1, DAMAGE_BILLBOARD_POOL_SIZE)) {
			const billboard = new Instance("BillboardGui");
			billboard.Name = `DamagePopup_${index}`;
			billboard.Size = DAMAGE_BILLBOARD_SIZE_NORMAL;
			billboard.AlwaysOnTop = true;
			billboard.Enabled = false;
			billboard.Parent = container;

			const label = new Instance("TextLabel");
			label.Name = "Text";
			label.Size = UDim2.fromScale(1, 1);
			label.BackgroundTransparency = 1;
			label.FontFace = GAME_FONT;
			label.TextScaled = true;
			label.TextStrokeTransparency = 0.15;
			label.TextColor3 = COMBAT_FEEDBACK_COLORS.normalHit;
			label.Text = "";
			label.Parent = billboard;

			this.billboardPool.push({ billboard, label, inUse: false });
		}

		return container;
	}

	public acquireBillboard(): BillboardPoolItem {
		for (const item of this.billboardPool) {
			if (!item.inUse) {
				item.inUse = true;
				return item;
			}
		}
		const fallback = this.billboardPool[0];
		fallback.inUse = true;
		return fallback;
	}

	public showFloatingText(
		adornee: Attachment | BasePart,
		text: string,
		color: Color3,
		size: UDim2,
		duration = DAMAGE_POPUP_DURATION_SECONDS,
	): void {
		const item = this.acquireBillboard();
		const { billboard, label } = item;
		billboard.Adornee = adornee;
		billboard.Size = size;
		billboard.StudsOffset = new Vector3(0, 1.2, 0);
		billboard.Enabled = true;

		label.FontFace = GAME_FONT;
		label.Text = text;
		label.TextColor3 = color;
		label.TextTransparency = 0;
		label.TextStrokeTransparency = 0.15;

		const moveTween = this.host.createBattleTween(
			billboard,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ StudsOffset: new Vector3(0, 1.2 + DAMAGE_POPUP_RISE_STUDS, 0) },
		);
		const fadeTween = this.host.createBattleTween(
			label,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
			{ TextTransparency: 1, TextStrokeTransparency: 1 },
		);
		moveTween.Play();
		fadeTween.Play();

		this.host.delayBattle(duration, () => {
			billboard.Enabled = false;
			billboard.Adornee = undefined;
			item.inUse = false;
		});
	}

	public showDodge(adornee: Attachment | BasePart): void {
		this.showFloatingText(
			adornee,
			"DODGE",
			COMBAT_FEEDBACK_COLORS.dodgeText,
			DAMAGE_BILLBOARD_SIZE_NORMAL,
		);
	}

	public showHitDamage(adornee: Attachment | BasePart, damage: number, isCrit: boolean): void {
		const displayDamage = math.max(damage, MIN_DAMAGE);
		const text = isCrit ? `${displayDamage}!` : `${displayDamage}`;
		const color = isCrit ? COMBAT_FEEDBACK_COLORS.critHit : COMBAT_FEEDBACK_COLORS.normalHit;
		const size = isCrit ? DAMAGE_BILLBOARD_SIZE_CRIT : DAMAGE_BILLBOARD_SIZE_NORMAL;
		this.showFloatingText(adornee, text, color, size);
	}

	public showDotTick(adornee: Attachment | BasePart, displayTickDamage: number, effect: StatusEffect): void {
		const color =
			effect === "Burn" ? COMBAT_FEEDBACK_COLORS.burnTick : COMBAT_FEEDBACK_COLORS.bleedTick;
		this.showFloatingText(adornee, `${displayTickDamage}`, color, DAMAGE_BILLBOARD_SIZE_DOT);
	}

	public clear(): void {
		for (const item of this.billboardPool) {
			battleCleanupStep("damage popup", () => {
				item.billboard.Enabled = false;
				item.billboard.Adornee = undefined;
				item.inUse = false;
			});
		}
	}

	public destroy(): void {
		this.clear();
		battleCleanupStep("damage pool destroy", () => this.poolContainer?.Destroy());
		this.poolContainer = undefined;
	}
}
