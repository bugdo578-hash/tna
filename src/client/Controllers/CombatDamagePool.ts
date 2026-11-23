import { RunService, Workspace } from "@rbxts/services";
import { MIN_DAMAGE } from "../../shared/Config";
import type { StatusEffect } from "../../shared/TypeDefs";
import {
	BURN_DAMAGE_STROKE_COLOR,
	BURN_DAMAGE_STROKE_TRANSPARENCY,
	BURN_DAMAGE_TEXT_COLOR,
	BURN_POPUP_BODY_X_HALF_FRACTION,
	BURN_POPUP_BODY_Y_HALF_FRACTION,
	BURN_POPUP_CAMERA_OUTWARD_PADDING_STUDS,
	BURN_POPUP_CAMERA_Z_OFFSET_STUDS,
	BURN_POPUP_FALLBACK_DEPTH_RADIUS_STUDS,
	BURN_POPUP_FALLBACK_HALF_HEIGHT_STUDS,
	BURN_POPUP_FALLBACK_HALF_WIDTH_STUDS,
	BURN_SHAKE_AMPLITUDE_X_PX,
	BURN_SHAKE_AMPLITUDE_Y_PX,
	BURN_SHAKE_DURATION_SECONDS,
	BURN_SHAKE_FREQUENCY_HZ,
	BURN_SHAKE_VERTICAL_PHASE_RATIO,
	COMBAT_FEEDBACK_COLORS,
	DAMAGE_BILLBOARD_POOL_SIZE,
	DAMAGE_BILLBOARD_SIZE_BURN,
	DAMAGE_BILLBOARD_SIZE_CRIT,
	DAMAGE_BILLBOARD_SIZE_DOT,
	DAMAGE_BILLBOARD_SIZE_NORMAL,
	DAMAGE_DEFAULT_STROKE_COLOR,
	DAMAGE_DEFAULT_STROKE_TRANSPARENCY,
	DAMAGE_POPUP_BASE_Y_OFFSET_STUDS,
	DAMAGE_POPUP_DURATION_SECONDS,
	DAMAGE_POPUP_RISE_STUDS,
	STAND_SUBMODEL_NAME,
} from "../UI/CombatVisualConfig";
import { GAME_FONT } from "../UI/UITheme";
import { battleCleanupStep } from "./BattleCleanup";

export interface BillboardPoolItem {
	readonly billboard: BillboardGui;
	readonly label: TextLabel;
	inUse: boolean;
	activeToken: number;
	shakeConnection?: RBXScriptConnection;
}

export interface CombatDamagePoolHost {
	readonly createBattleTween: <T extends Instance>(
		object: T,
		info: TweenInfo,
		goal: Partial<ExtractMembers<T, Tweenable>>,
	) => Tween;
	readonly delayBattle: (seconds: number, callback: () => void) => void;
	readonly trackBattleConnection?: (connection: RBXScriptConnection) => void;
	readonly untrackBattleConnection?: (connection: RBXScriptConnection) => void;
	readonly getCamera?: () => Camera | undefined;
}

interface FloatingTextOptions {
	readonly strokeColor?: Color3;
	readonly strokeTransparency?: number;
	readonly studsOffset?: Vector3;
	readonly studsOffsetWorldSpace?: Vector3;
	readonly riseInWorldSpace?: boolean;
	readonly thermalShake?: boolean;
}

interface BodyBounds {
	readonly center: Vector3;
	readonly halfWidth: number;
	readonly halfHeight: number;
	readonly depthRadius: number;
}

const DEFAULT_LABEL_POSITION = UDim2.fromScale(0, 0);
const RAD_PER_CYCLE = math.pi * 2;
const MIN_VECTOR_MAGNITUDE = 1e-4;

function resolveAdorneeWorldPosition(adornee: Attachment | BasePart): Vector3 {
	return adornee.IsA("Attachment") ? adornee.WorldPosition : adornee.Position;
}

function computeFighterBodyBounds(model: Model | undefined, rootPart: BasePart | undefined, fallbackPos: Vector3): BodyBounds {
	if (model !== undefined && model.Parent !== undefined) {
		const standModel = model.FindFirstChild(STAND_SUBMODEL_NAME);
		let minX = math.huge;
		let minY = math.huge;
		let minZ = math.huge;
		let maxX = -math.huge;
		let maxY = -math.huge;
		let maxZ = -math.huge;
		let foundAny = false;

		for (const child of model.GetChildren()) {
			if (!child.IsA("BasePart") || child === standModel) continue;
			const pos = child.Position;
			const half = child.Size.mul(0.5);
			minX = math.min(minX, pos.X - half.X);
			minY = math.min(minY, pos.Y - half.Y);
			minZ = math.min(minZ, pos.Z - half.Z);
			maxX = math.max(maxX, pos.X + half.X);
			maxY = math.max(maxY, pos.Y + half.Y);
			maxZ = math.max(maxZ, pos.Z + half.Z);
			foundAny = true;
		}

		if (foundAny) {
			const center = new Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
			const halfX = (maxX - minX) * 0.5;
			const halfY = (maxY - minY) * 0.5;
			const halfZ = (maxZ - minZ) * 0.5;
			return {
				center,
				halfWidth: math.max(math.max(halfX, halfZ), BURN_POPUP_FALLBACK_HALF_WIDTH_STUDS * 0.5),
				halfHeight: math.max(halfY, BURN_POPUP_FALLBACK_HALF_HEIGHT_STUDS * 0.5),
				depthRadius: math.max(math.max(halfX, halfZ), BURN_POPUP_FALLBACK_DEPTH_RADIUS_STUDS),
			};
		}
	}

	const center = rootPart !== undefined && rootPart.Parent !== undefined ? rootPart.Position : fallbackPos;
	return {
		center,
		halfWidth: BURN_POPUP_FALLBACK_HALF_WIDTH_STUDS,
		halfHeight: BURN_POPUP_FALLBACK_HALF_HEIGHT_STUDS,
		depthRadius: BURN_POPUP_FALLBACK_DEPTH_RADIUS_STUDS,
	};
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
			label.Position = DEFAULT_LABEL_POSITION;
			label.BackgroundTransparency = 1;
			label.FontFace = GAME_FONT;
			label.TextScaled = true;
			label.TextStrokeColor3 = DAMAGE_DEFAULT_STROKE_COLOR;
			label.TextStrokeTransparency = DAMAGE_DEFAULT_STROKE_TRANSPARENCY;
			label.TextColor3 = COMBAT_FEEDBACK_COLORS.normalHit;
			label.Text = "";
			label.Parent = billboard;

			this.billboardPool.push({ billboard, label, inUse: false, activeToken: 0 });
		}

		return container;
	}

	public acquireBillboard(): BillboardPoolItem {
		for (const item of this.billboardPool) {
			if (!item.inUse) {
				this.resetPoolItemVisuals(item);
				item.inUse = true;
				item.activeToken += 1;
				return item;
			}
		}
		const fallback = this.billboardPool[0];
		this.resetPoolItemVisuals(fallback);
		fallback.inUse = true;
		fallback.activeToken += 1;
		return fallback;
	}

	public showFloatingText(
		adornee: Attachment | BasePart,
		text: string,
		color: Color3,
		size: UDim2,
		duration = DAMAGE_POPUP_DURATION_SECONDS,
		options?: FloatingTextOptions,
	): void {
		const item = this.acquireBillboard();
		const token = item.activeToken;
		const { billboard, label } = item;

		const baseStudsOffset = options?.studsOffset ?? new Vector3(0, DAMAGE_POPUP_BASE_Y_OFFSET_STUDS, 0);
		const baseWorldOffset = options?.studsOffsetWorldSpace ?? Vector3.zero;
		const riseInWorldSpace = options?.riseInWorldSpace === true;

		billboard.Adornee = adornee;
		billboard.Size = size;
		billboard.StudsOffset = baseStudsOffset;
		billboard.StudsOffsetWorldSpace = baseWorldOffset;
		billboard.Enabled = true;

		label.FontFace = GAME_FONT;
		label.Position = DEFAULT_LABEL_POSITION;
		label.Text = text;
		label.TextColor3 = color;
		label.TextStrokeColor3 = options?.strokeColor ?? DAMAGE_DEFAULT_STROKE_COLOR;
		label.TextTransparency = 0;
		label.TextStrokeTransparency = options?.strokeTransparency ?? DAMAGE_DEFAULT_STROKE_TRANSPARENCY;

		const moveGoal = riseInWorldSpace
			? { StudsOffsetWorldSpace: baseWorldOffset.add(new Vector3(0, DAMAGE_POPUP_RISE_STUDS, 0)) }
			: { StudsOffset: baseStudsOffset.add(new Vector3(0, DAMAGE_POPUP_RISE_STUDS, 0)) };

		const moveTween = this.host.createBattleTween(
			billboard,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			moveGoal,
		);
		const fadeTween = this.host.createBattleTween(
			label,
			new TweenInfo(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
			{ TextTransparency: 1, TextStrokeTransparency: 1 },
		);
		moveTween.Play();
		fadeTween.Play();

		if (options?.thermalShake === true) {
			this.startThermalShake(item, token, math.min(BURN_SHAKE_DURATION_SECONDS, duration));
		}

		this.host.delayBattle(duration, () => {
			if (item.activeToken !== token) return;
			this.releasePoolItem(item);
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

	public showDotTick(
		adornee: Attachment | BasePart,
		displayTickDamage: number,
		effect: StatusEffect,
		targetModel?: Model,
		rootPart?: BasePart,
	): void {
		if (displayTickDamage <= 0) return;

		if (effect === "Burn") {
			const burnAdornee = rootPart !== undefined && rootPart.Parent !== undefined ? rootPart : adornee;
			const { studsOffset, studsOffsetWorldSpace, useWorldSpace } = this.computeBurnBodySurfaceOffsets(
				burnAdornee,
				targetModel,
				rootPart,
			);
			this.showFloatingText(
				burnAdornee,
				`${displayTickDamage}`,
				BURN_DAMAGE_TEXT_COLOR,
				DAMAGE_BILLBOARD_SIZE_BURN,
				DAMAGE_POPUP_DURATION_SECONDS,
				{
					strokeColor: BURN_DAMAGE_STROKE_COLOR,
					strokeTransparency: BURN_DAMAGE_STROKE_TRANSPARENCY,
					studsOffset,
					studsOffsetWorldSpace,
					riseInWorldSpace: useWorldSpace,
					thermalShake: true,
				},
			);
			return;
		}

		this.showFloatingText(
			adornee,
			`${displayTickDamage}`,
			COMBAT_FEEDBACK_COLORS.bleedTick,
			DAMAGE_BILLBOARD_SIZE_DOT,
		);
	}

	public clear(): void {
		for (const item of this.billboardPool) {
			battleCleanupStep("damage popup", () => {
				item.activeToken += 1;
				this.releasePoolItem(item);
			});
		}
	}

	public destroy(): void {
		this.clear();
		battleCleanupStep("damage pool destroy", () => this.poolContainer?.Destroy());
		this.poolContainer = undefined;
	}

	private computeBurnBodySurfaceOffsets(
		adornee: Attachment | BasePart,
		targetModel?: Model,
		rootPart?: BasePart,
	): { readonly studsOffset: Vector3; readonly studsOffsetWorldSpace: Vector3; readonly useWorldSpace: boolean } {
		const adorneePos = resolveAdorneeWorldPosition(adornee);
		const bounds = computeFighterBodyBounds(targetModel, rootPart, adorneePos);
		const lateral = (math.random() * 2 - 1) * (bounds.halfWidth * BURN_POPUP_BODY_X_HALF_FRACTION);
		const vertical = (math.random() * 2 - 1) * (bounds.halfHeight * BURN_POPUP_BODY_Y_HALF_FRACTION);
		const outwardDistance = bounds.depthRadius + BURN_POPUP_CAMERA_OUTWARD_PADDING_STUDS;

		const camera = this.host.getCamera?.() ?? Workspace.CurrentCamera;
		if (camera !== undefined) {
			const toCameraRaw = camera.CFrame.Position.sub(bounds.center);
			const toCamera =
				toCameraRaw.Magnitude > MIN_VECTOR_MAGNITUDE ? toCameraRaw.Unit : camera.CFrame.LookVector.mul(-1);
			const camRight = camera.CFrame.RightVector;
			const centerDelta = bounds.center.sub(adorneePos);
			const worldOffset = centerDelta
				.add(camRight.mul(lateral))
				.add(new Vector3(0, vertical, 0))
				.add(toCamera.mul(outwardDistance));
			return {
				studsOffset: new Vector3(0, 0, BURN_POPUP_CAMERA_Z_OFFSET_STUDS),
				studsOffsetWorldSpace: worldOffset,
				useWorldSpace: true,
			};
		}

		const centerDelta = bounds.center.sub(adorneePos);
		return {
			studsOffset: new Vector3(lateral, vertical, BURN_POPUP_CAMERA_Z_OFFSET_STUDS),
			studsOffsetWorldSpace: centerDelta,
			useWorldSpace: false,
		};
	}

	private startThermalShake(item: BillboardPoolItem, token: number, durationSeconds: number): void {
		if (durationSeconds <= 0) return;
		this.disconnectShake(item);

		const startedAt = os.clock();
		const omega = BURN_SHAKE_FREQUENCY_HZ * RAD_PER_CYCLE;
		const connection = RunService.RenderStepped.Connect(() => {
			if (item.activeToken !== token || !item.billboard.Enabled) {
				this.disconnectShake(item);
				return;
			}
			const elapsed = os.clock() - startedAt;
			if (elapsed >= durationSeconds) {
				item.label.Position = DEFAULT_LABEL_POSITION;
				this.disconnectShake(item);
				return;
			}
			const decay = 1 - elapsed / durationSeconds;
			const offsetX = math.sin(elapsed * omega) * BURN_SHAKE_AMPLITUDE_X_PX * decay;
			const offsetY =
				math.cos(elapsed * omega * BURN_SHAKE_VERTICAL_PHASE_RATIO) * BURN_SHAKE_AMPLITUDE_Y_PX * decay;
			item.label.Position = new UDim2(0, math.round(offsetX), 0, math.round(offsetY));
		});
		item.shakeConnection = connection;
		this.host.trackBattleConnection?.(connection);
	}

	private disconnectShake(item: BillboardPoolItem): void {
		const connection = item.shakeConnection;
		if (connection === undefined) return;
		item.shakeConnection = undefined;
		this.host.untrackBattleConnection?.(connection);
		battleCleanupStep("burn shake disconnect", () => connection.Disconnect());
	}

	private resetPoolItemVisuals(item: BillboardPoolItem): void {
		this.disconnectShake(item);
		item.billboard.Size = DAMAGE_BILLBOARD_SIZE_NORMAL;
		item.billboard.StudsOffset = Vector3.zero;
		item.billboard.StudsOffsetWorldSpace = Vector3.zero;
		item.label.Position = DEFAULT_LABEL_POSITION;
		item.label.TextColor3 = COMBAT_FEEDBACK_COLORS.normalHit;
		item.label.TextStrokeColor3 = DAMAGE_DEFAULT_STROKE_COLOR;
		item.label.TextStrokeTransparency = DAMAGE_DEFAULT_STROKE_TRANSPARENCY;
		item.label.TextTransparency = 0;
		item.label.Text = "";
	}

	private releasePoolItem(item: BillboardPoolItem): void {
		this.resetPoolItemVisuals(item);
		item.billboard.Enabled = false;
		item.billboard.Adornee = undefined;
		item.inUse = false;
	}
}
