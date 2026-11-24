import type { BattleStartedPayload } from "../../shared/Remotes";
import type { SkillData } from "../../shared/SkillData";
import type { SkillSlot } from "../../shared/TypeDefs";
import { ASSETS_FOLDER_NAME } from "../UI/CombatVisualConfig";
import {
	VFX_ASSETS_FOLDER_NAME,
	VFX_ATTR_IGNORAR_CULLING,
	VFX_GLOBAL_CRIT_NAME,
	VFX_GLOBAL_HIT_NAME,
	VFX_GLOBAL_KO_NAME,
	VFX_PRIORIDADE_ESSENCIAL,
} from "../UI/VFXConfig";
import { battleCleanupStep } from "./BattleCleanup";
import { CombatVfxAudio } from "./CombatVfxAudio";
import type { VFXController, VfxOrigem, VfxPrioridade } from "./VFXController";

export interface PreloadedVfxEntry {
	readonly folder: Instance;
	readonly generation: number;
}

export interface CombatVfxFighterRef {
	readonly targetId: string;
	readonly fighterId: string;
	readonly model: Model;
	readonly rootPart?: BasePart;
	readonly attachments: {
		readonly Peito: Attachment | BasePart;
	};
}

interface WorkingVfxSpatialTarget {
	readonly instance: Model | BasePart;
	readonly relativeCFrame: CFrame;
}

const VFX_PIVOT_MARKER_NAMES = new Set(["Pivot", "Origin", "Root", "Center"]);

export interface ResolvedBattleVfx {
	readonly instance: Instance;
	readonly isInModel: boolean;
	readonly key: string;
}

export interface CombatVfxBridgeHost {
	readonly getVfxController: () => VFXController | undefined;
	readonly getAssetsRoot: () => Instance;
	readonly getGlobalVfxRoot: () => Instance | undefined;
	readonly getStageFolder: () => Folder | undefined;
	readonly isBattleEnded: () => boolean;
}

export class CombatVfxBridge {
	public readonly preloadedVfxEntries: PreloadedVfxEntry[] = [];
	public readonly battleVfxWorkingCopies = new Map<string, Instance>();
	public readonly vfxCarrierParts = new Map<Instance, BasePart>();
	private readonly vfxSpatialLayouts = new Map<Instance, readonly WorkingVfxSpatialTarget[]>();
	private readonly attackEffects = new Set<Instance>();
	private readonly audio = new CombatVfxAudio(() => this.host.getVfxController()?.getSoundRuntime());

	private battleVfxGeneration = 0;

	public constructor(private readonly host: CombatVfxBridgeHost) {}

	public getBattleGeneration(): number {
		return this.battleVfxGeneration;
	}

	public ownsGeneration(expectedVfxGeneration?: number): boolean {
		return expectedVfxGeneration === undefined || expectedVfxGeneration === this.battleVfxGeneration;
	}

	public advanceGeneration(): number {
		this.battleVfxGeneration += 1;
		return this.battleVfxGeneration;
	}

	public isCurrentBattle(generation: number): boolean {
		return !this.host.isBattleEnded() && this.battleVfxGeneration === generation;
	}

	public resolveGlobalVfxRoot(): Instance | undefined {
		const assetsFolder = this.host.getAssetsRoot().FindFirstChild(ASSETS_FOLDER_NAME);
		return assetsFolder?.FindFirstChild(VFX_ASSETS_FOLDER_NAME);
	}

	public clearWorkingCopies(): void {
		this.interruptAttackVfx();
		this.battleVfxWorkingCopies.clear();
		this.vfxCarrierParts.clear();
		this.vfxSpatialLayouts.clear();
	}

	public interruptAttackVfx(): void {
		this.audio.interrupt(this.attackEffects);
		for (const effect of this.attackEffects) {
			battleCleanupStep("attack vfx", () => this.host.getVfxController()?.cancelEmission(effect));
		}
		this.attackEffects.clear();
	}

	public setAttackPaused(paused: boolean): void {
		if (paused) {
			for (const effect of this.attackEffects) this.host.getVfxController()?.cancelEmission(effect, true);
		}
		this.audio.setPaused(this.attackEffects, paused);
	}

	public clearActiveVfx(): void {
		battleCleanupStep("vfx clear", () => this.host.getVfxController()?.clear());
	}

	public deloadBattleVfx(expectedGeneration?: number): void {
		if (expectedGeneration !== undefined && expectedGeneration !== this.battleVfxGeneration) {
			return;
		}
		const entries = [...this.preloadedVfxEntries];
		this.preloadedVfxEntries.clear();
		this.battleVfxWorkingCopies.clear();
		this.vfxCarrierParts.clear();
		this.vfxSpatialLayouts.clear();
		for (const entry of entries) {
			battleCleanupStep("vfx deload folder", () => this.host.getVfxController()?.deload(entry.folder, entry.generation));
		}
	}

	public clear(expectedGeneration?: number): void {
		this.clearWorkingCopies();
		this.clearActiveVfx();
		battleCleanupStep("vfx deload", () => this.deloadBattleVfx(expectedGeneration));
	}

	public destroy(): void {
		this.clear();
	}

	public preloadBattleVfx(
		payload: BattleStartedPayload,
		generation: number,
		fighters: ReadonlyMap<string, CombatVfxFighterRef>,
	): void {
		const vfx = this.host.getVfxController();
		if (vfx === undefined) return;
		const seen = new Set<Instance>();
		const registrarPreload = (folder: Instance | undefined): void => {
			if (!this.isCurrentBattle(generation) || folder === undefined || folder.Parent === undefined || seen.has(folder)) return;
			seen.add(folder);
			vfx.preload(folder, generation);
			if (!this.isCurrentBattle(generation)) {
				battleCleanupStep("stale vfx preload", () => vfx.deload(folder, generation));
				return;
			}
			this.preloadedVfxEntries.push({ folder, generation });
		};

		const vfxRoot = this.host.getGlobalVfxRoot();
		if (vfxRoot !== undefined) {
			registrarPreload(vfxRoot.FindFirstChild(VFX_GLOBAL_HIT_NAME));
			registrarPreload(vfxRoot.FindFirstChild(VFX_GLOBAL_CRIT_NAME));
			registrarPreload(vfxRoot.FindFirstChild(VFX_GLOBAL_KO_NAME));

			for (const snapshot of payload.fighters) {
				const fighterFolder =
					vfxRoot.FindFirstChild(snapshot.fighterId) ?? vfxRoot.FindFirstChild(snapshot.fighterId.lower());
				registrarPreload(fighterFolder);
			}
		}

		for (const [, entry] of fighters) {
			registrarPreload(entry.model.FindFirstChild(VFX_ASSETS_FOLDER_NAME));
		}
	}

	public resolveSkillVfx(
		attacker: CombatVfxFighterRef,
		timeline: SkillData,
		slot: SkillSlot,
	): ResolvedBattleVfx | undefined {
		const candidates: string[] = [];
		for (const candidate of [timeline.vfxName, timeline.id, timeline.name, `S${slot}`]) {
			if (candidate !== undefined && candidate.size() > 0 && !candidates.includes(candidate)) {
				candidates.push(candidate);
			}
		}
		const findFirst = (container: Instance): Instance | undefined => {
			for (const name of candidates) {
				const found = container.FindFirstChild(name);
				if (found !== undefined) return found;
			}
			return undefined;
		};

		const modelVfx = attacker.model.FindFirstChild(VFX_ASSETS_FOLDER_NAME);
		if (modelVfx !== undefined) {
			const direct = findFirst(modelVfx);
			if (direct !== undefined) {
				return { instance: direct, isInModel: true, key: `model:${attacker.targetId}:${direct.Name}` };
			}
		}

		const vfxRoot = this.host.getGlobalVfxRoot();
		if (vfxRoot === undefined) return undefined;

		const fighterVfx =
			vfxRoot.FindFirstChild(attacker.fighterId) ?? vfxRoot.FindFirstChild(attacker.fighterId.lower());
		if (fighterVfx !== undefined) {
			const found = findFirst(fighterVfx);
			if (found !== undefined) {
				return { instance: found, isInModel: false, key: `fighter:${attacker.fighterId.lower()}:${found.Name}` };
			}
		}

		return undefined;
	}

	public resolveNamedCombatVfx(
		fighter: CombatVfxFighterRef,
		effectName: string,
	): ResolvedBattleVfx | undefined {
		const modelVfx = fighter.model.FindFirstChild(VFX_ASSETS_FOLDER_NAME);
		const modelHit = modelVfx?.FindFirstChild(effectName);
		if (modelHit !== undefined) {
			return { instance: modelHit, isInModel: true, key: `model:${fighter.targetId}:${effectName}` };
		}

		const vfxRoot = this.host.getGlobalVfxRoot();
		if (vfxRoot === undefined) return undefined;

		const fighterVfx =
			vfxRoot.FindFirstChild(fighter.fighterId) ?? vfxRoot.FindFirstChild(fighter.fighterId.lower());
		const fighterScoped = fighterVfx?.FindFirstChild(effectName);
		if (fighterScoped !== undefined) {
			return {
				instance: fighterScoped,
				isInModel: false,
				key: `fighter:${fighter.fighterId.lower()}:${effectName}`,
			};
		}

		const globalVfx = vfxRoot.FindFirstChild(effectName);
		if (globalVfx !== undefined) {
			return { instance: globalVfx, isInModel: false, key: `global:${effectName}` };
		}

		return undefined;
	}

	public emitHitVfx(
		attacker: CombatVfxFighterRef,
		target: CombatVfxFighterRef,
		timeline: SkillData,
		slot: SkillSlot,
		isCrit: boolean,
	): void {
		if (this.host.getVfxController() === undefined) return;
		const origem = this.resolveTargetOrigem(target);

		const skillVfx = this.resolveSkillVfx(attacker, timeline, slot);
		if (skillVfx !== undefined) {
			this.emitResolvedBattleVfx(skillVfx, origem, VFX_PRIORIDADE_ESSENCIAL, true);
		}

		const impactName = isCrit ? VFX_GLOBAL_CRIT_NAME : VFX_GLOBAL_HIT_NAME;
		let impactVfx = this.resolveNamedCombatVfx(attacker, impactName);
		if (impactVfx === undefined && isCrit) {
			impactVfx = this.resolveNamedCombatVfx(attacker, VFX_GLOBAL_HIT_NAME);
		}
		if (impactVfx !== undefined) {
			this.emitResolvedBattleVfx(impactVfx, origem, VFX_PRIORIDADE_ESSENCIAL, true);
		}
	}

	public emitKoVfx(deadFighter: CombatVfxFighterRef): void {
		if (this.host.getVfxController() === undefined) return;
		const koVfx = this.resolveNamedCombatVfx(deadFighter, VFX_GLOBAL_KO_NAME);
		if (koVfx !== undefined) {
			this.emitResolvedBattleVfx(koVfx, this.resolveTargetOrigem(deadFighter), VFX_PRIORIDADE_ESSENCIAL);
		}
	}

	public emitResolvedBattleVfx(
		resolved: ResolvedBattleVfx,
		origem: VfxOrigem,
		prioridade: VfxPrioridade,
		attackEffect = false,
	): void {
		const vfx = this.host.getVfxController();
		if (vfx === undefined || this.host.isBattleEnded()) return;
		const working = this.getOrCreateWorkingVfxCopy(resolved.key, resolved.instance, origem);
		if (working === undefined) return;
		if (attackEffect) this.attackEffects.add(working);
		vfx.emit(working, origem, prioridade, true);
	}

	public getOrCreateWorkingVfxCopy(key: string, template: Instance, origem: VfxOrigem): Instance | undefined {
		const stageFolder = this.host.getStageFolder();
		if (stageFolder === undefined || !stageFolder.Parent) return undefined;

		let working = this.battleVfxWorkingCopies.get(key);
		if (working === undefined || !working.Parent) {
			if (!template.Archivable) return undefined;
			working = template.Clone();
			working.Name = `BattleVFX_${key}`;
			working.SetAttribute(VFX_ATTR_IGNORAR_CULLING, true);
			this.prepareWorkingVfxPhysics(working);
			this.captureSpatialLayout(working);
			this.parentAndPositionWorkingVfx(working, origem);
			this.battleVfxWorkingCopies.set(key, working);
			return working;
		}

		this.positionWorkingVfx(working, origem);
		return working;
	}

	private resolveTargetOrigem(target: CombatVfxFighterRef): VfxOrigem {
		const peito = target.attachments.Peito;
		if (peito !== undefined && peito.Parent !== undefined) {
			return peito;
		}
		if (target.rootPart !== undefined && target.rootPart.Parent !== undefined) {
			return target.rootPart;
		}
		return target.model;
	}

	private resolveOrigemCFrame(origem: VfxOrigem): CFrame {
		if (typeIs(origem, "CFrame")) return origem;
		if (typeIs(origem, "Vector3")) return new CFrame(origem);
		if (origem.IsA("Attachment")) return origem.WorldCFrame;
		if (origem.IsA("BasePart")) return origem.CFrame;
		return origem.GetPivot();
	}

	private prepareWorkingVfxPhysics(working: Instance): void {
		const configurePart = (part: BasePart): void => {
			part.Anchored = true;
			part.CanCollide = false;
			part.CanQuery = false;
			part.CanTouch = false;
		};
		if (working.IsA("BasePart")) {
			configurePart(working);
		}
		for (const descendant of working.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				configurePart(descendant);
			}
		}
	}

	private collectTopSpatialInstances(root: Instance, out: Array<Model | BasePart>): void {
		if (root.IsA("Model")) {
			out.push(root);
			return;
		}
		if (root.IsA("BasePart")) {
			out.push(root);
		}
		for (const child of root.GetChildren()) {
			if (child.IsA("Model")) {
				out.push(child);
			} else if (child.IsA("BasePart")) {
				this.collectTopSpatialInstances(child, out);
			} else {
				this.collectTopSpatialInstances(child, out);
			}
		}
	}

	private findExplicitPivotCFrame(working: Instance): CFrame | undefined {
		for (const child of working.GetChildren()) {
			if (!VFX_PIVOT_MARKER_NAMES.has(child.Name)) continue;
			if (child.IsA("Attachment")) return child.WorldCFrame;
			if (child.IsA("BasePart")) return child.CFrame;
			if (child.IsA("Model")) return child.GetPivot();
		}
		return undefined;
	}

	private captureSpatialLayout(working: Instance): void {
		const spatialInstances: Array<Model | BasePart> = [];
		this.collectTopSpatialInstances(working, spatialInstances);
		if (spatialInstances.size() === 0) {
			this.vfxSpatialLayouts.delete(working);
			return;
		}

		let referenceCFrame: CFrame;
		if (working.IsA("Model")) {
			referenceCFrame = working.GetPivot();
		} else if (working.IsA("BasePart")) {
			referenceCFrame = working.CFrame;
		} else {
			const first = spatialInstances[0];
			referenceCFrame =
				this.findExplicitPivotCFrame(working) ??
				(first.IsA("Model") ? first.GetPivot() : first.CFrame);
		}

		const layout: WorkingVfxSpatialTarget[] = [];
		for (const item of spatialInstances) {
			const itemCFrame = item.IsA("Model") ? item.GetPivot() : item.CFrame;
			layout.push({
				instance: item,
				relativeCFrame: referenceCFrame.ToObjectSpace(itemCFrame),
			});
		}
		this.vfxSpatialLayouts.set(working, layout);
	}

	private parentAndPositionWorkingVfx(working: Instance, origem: VfxOrigem): void {
		const stageFolder = this.host.getStageFolder();
		if (stageFolder === undefined) return;
		const cf = this.resolveOrigemCFrame(origem);
		const needsCarrier =
			working.IsA("Attachment") ||
			working.IsA("ParticleEmitter") ||
			(working.IsA("Folder") && this.hasDirectEmitterOrAttachment(working));

		if (needsCarrier) {
			const carrier = new Instance("Part");
			carrier.Name = `Carrier_${working.Name}`;
			carrier.Size = new Vector3(0.2, 0.2, 0.2);
			carrier.Transparency = 1;
			carrier.Anchored = true;
			carrier.CanCollide = false;
			carrier.CanQuery = false;
			carrier.CanTouch = false;
			carrier.CFrame = cf;
			carrier.Parent = stageFolder;
			this.vfxCarrierParts.set(working, carrier);
			working.Parent = carrier;
			this.positionWorkingVfx(working, origem);
			return;
		}

		working.Parent = stageFolder;
		this.positionWorkingVfx(working, origem);
	}

	private hasDirectEmitterOrAttachment(folder: Instance): boolean {
		for (const child of folder.GetChildren()) {
			if (child.IsA("Attachment") || child.IsA("ParticleEmitter")) {
				return true;
			}
		}
		return false;
	}

	private positionWorkingVfx(working: Instance, origem: VfxOrigem): void {
		const cf = this.resolveOrigemCFrame(origem);
		const carrier = this.vfxCarrierParts.get(working);
		if (carrier !== undefined && carrier.Parent !== undefined) {
			carrier.CFrame = cf;
		}

		const layout = this.vfxSpatialLayouts.get(working);
		if (layout !== undefined && layout.size() > 0) {
			for (const entry of layout) {
				if (entry.instance.Parent === undefined) continue;
				const desired = cf.mul(entry.relativeCFrame);
				if (entry.instance.IsA("Model")) {
					entry.instance.PivotTo(desired);
				} else {
					entry.instance.CFrame = desired;
				}
			}
			return;
		}

		if (working.IsA("Model")) {
			working.PivotTo(cf);
		} else if (working.IsA("BasePart")) {
			working.CFrame = cf;
		}
	}
}
