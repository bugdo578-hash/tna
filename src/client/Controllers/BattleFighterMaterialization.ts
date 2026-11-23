import { Workspace } from "@rbxts/services";
import { ARENA_OPTIONAL_AOE_ANCHOR_NAMES } from "../../shared/configs/Arena";
import { BATTLE_COUNTDOWN_SECONDS } from "../../shared/configs/BattleIntro";
import {
	FIGHTER_MATERIALIZATION_GO_MARGIN_SECONDS,
	FIGHTER_MATERIALIZATION_SECONDS,
	FIGHTER_MATERIALIZATION_START_SECONDS,
} from "../UI/CombatVisualConfig";
import { battleCleanupStep } from "./BattleCleanup";
import { BattleSpawnVfx } from "./BattleSpawnVfx";
import type { ResolvedArenaAnchors } from "./CombatArenaAnchors";
import { alignFighterCFrameToAnchor, computeAnchorTopSurfaceCFrame } from "./CombatFighterGrounding";

interface Fighter {
	readonly model: Model;
	readonly sideId: string;
	readonly active: boolean;
	readonly benchIndex: number;
	readonly homeCFrame: CFrame;
	readonly groundContactOffset: Vector3;
}

type LocalVisual = BasePart | Decal | ParticleEmitter | Beam | Trail | Fire | Smoke | Sparkles;
type ToggleVisual = Highlight | LayerCollector | Light;

interface MaterializingFighter {
	readonly fighter: Fighter;
	readonly anchor: BasePart;
	readonly delay: number;
	readonly transparency: Map<LocalVisual, number>;
	readonly enabled: Map<ToggleVisual, boolean>;
	readonly humanoid?: Humanoid;
	readonly display?: Enum.HumanoidDisplayDistanceType;
	startedAt?: number;
	disposeVfx?: () => void;
	finished: boolean;
}

function createEntry(fighter: Fighter, anchor: BasePart, delay: number): MaterializingFighter {
	const transparency = new Map<LocalVisual, number>();
	const enabled = new Map<ToggleVisual, boolean>();
	for (const visual of fighter.model.GetDescendants()) {
		if (visual.IsA("BasePart") || visual.IsA("Decal") || visual.IsA("ParticleEmitter") || visual.IsA("Beam") ||
			visual.IsA("Trail") || visual.IsA("Fire") || visual.IsA("Smoke") || visual.IsA("Sparkles")) {
			transparency.set(visual, visual.LocalTransparencyModifier);
		} else if (visual.IsA("Highlight") || visual.IsA("LayerCollector") || visual.IsA("Light")) {
			enabled.set(visual, visual.Enabled);
		}
	}
	const humanoid = fighter.model.FindFirstChildOfClass("Humanoid");
	return { fighter, anchor, delay, transparency, enabled, humanoid, display: humanoid?.DisplayDistanceType, finished: false };
}

function setHidden(entry: MaterializingFighter, hidden: number): void {
	for (const [visual, original] of entry.transparency) {
		if (visual.Parent !== undefined) visual.LocalTransparencyModifier = original + (1 - original) * hidden;
	}
}

export class BattleFighterMaterialization {
	public static prepare(
		fighters: ReadonlyMap<string, Fighter>,
		ownSideId: string,
		physicalSides: readonly [string, string],
		anchors: ResolvedArenaAnchors,
		stage: Folder,
		isCurrent: () => boolean,
	): BattleFighterMaterialization | undefined {
		const sideIndex = physicalSides[0] === ownSideId ? 0 : physicalSides[1] === ownSideId ? 1 : undefined;
		if (sideIndex === undefined) return undefined;
		const vfx = BattleSpawnVfx.load();
		if (vfx === undefined || !isCurrent()) return undefined;
		const side = anchors.sides[sideIndex];
		const entries: MaterializingFighter[] = [];
		for (const [, fighter] of fighters) {
			if (fighter.sideId !== ownSideId) continue;
			const slot = fighter.active ? 0 : fighter.benchIndex + 1;
			const delay = FIGHTER_MATERIALIZATION_START_SECONDS[slot];
			if (delay === undefined) continue;
			const aoe = fighter.active ? undefined : side.folder.FindFirstChild(ARENA_OPTIONAL_AOE_ANCHOR_NAMES[sideIndex][fighter.benchIndex]);
			const anchor = fighter.active ? side.active : aoe?.IsA("BasePart") ? aoe : side.waiting[fighter.benchIndex];
			entries.push(createEntry(fighter, anchor, delay));
		}
		const plan = new BattleFighterMaterialization(entries, vfx, anchors, stage, isCurrent);
		const [ok, failure] = pcall(() => {
			for (const entry of entries) {
				setHidden(entry, 1);
				for (const [visual] of entry.enabled) visual.Enabled = false;
				if (entry.humanoid !== undefined) entry.humanoid.DisplayDistanceType = Enum.HumanoidDisplayDistanceType.None;
			}
		});
		if (ok) return plan;
		plan.cancel();
		warn(`[BattleFighterMaterialization] Preparação: ${tostring(failure)}`);
		return undefined;
	}

	private constructor(
		private readonly entries: MaterializingFighter[],
		private readonly vfx: BattleSpawnVfx,
		private readonly anchors: ResolvedArenaAnchors,
		private readonly stage: Folder,
		private readonly isCurrent: () => boolean,
	) {}

	/** Segue o mesmo relógio do countdown e abre mão do efeito se um frame perder a janela. */
	public step(now: number, goAt: number): void {
		if (!this.isCurrent() || !this.stage.IsDescendantOf(Workspace) || !this.anchors.root.IsDescendantOf(Workspace)) {
			this.cancel();
			return;
		}
		const readyBy = goAt - FIGHTER_MATERIALIZATION_GO_MARGIN_SECONDS;
		for (const entry of this.entries) {
			if (entry.finished) continue;
			if (!entry.fighter.model.IsDescendantOf(this.stage) || !entry.anchor.IsDescendantOf(this.anchors.root) || now >= readyBy) {
				this.finish(entry);
				continue;
			}
			if (entry.startedAt === undefined) {
				if (now < goAt - BATTLE_COUNTDOWN_SECONDS + entry.delay) continue;
				if (now + FIGHTER_MATERIALIZATION_SECONDS > readyBy) {
					this.finish(entry);
					continue;
				}
				if (!entry.fighter.active) entry.fighter.model.PivotTo(alignFighterCFrameToAnchor(entry.anchor, entry.fighter.groundContactOffset));
				entry.startedAt = now;
				entry.disposeVfx = this.vfx.emit(entry.fighter.model, computeAnchorTopSurfaceCFrame(entry.anchor), this.stage);
			}
			const progress = (now - entry.startedAt) / FIGHTER_MATERIALIZATION_SECONDS;
			if (progress >= 1) this.finish(entry);
			else setHidden(entry, 1 - progress);
		}
	}

	public finishReveal(): void {
		for (const entry of this.entries) this.finish(entry);
	}

	public cancel(): void {
		for (const entry of this.entries) {
			entry.disposeVfx?.();
			entry.disposeVfx = undefined;
			this.finish(entry);
		}
	}

	private finish(entry: MaterializingFighter): void {
		if (entry.finished) return;
		entry.finished = true;
		battleCleanupStep("fighter intro transparency", () => setHidden(entry, 0));
		battleCleanupStep("fighter intro effects", () => {
			for (const [visual, wasEnabled] of entry.enabled) {
				if (visual.Parent !== undefined) visual.Enabled = wasEnabled;
			}
			if (entry.humanoid?.Parent !== undefined && entry.display !== undefined) {
				entry.humanoid.DisplayDistanceType = entry.display;
			}
		});
		if (!entry.fighter.active && entry.startedAt !== undefined && entry.fighter.model.IsDescendantOf(this.stage)) {
			battleCleanupStep("fighter intro bench", () => entry.fighter.model.PivotTo(entry.fighter.homeCFrame));
		}
	}
}
