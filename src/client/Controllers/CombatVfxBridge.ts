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
import type { VFXController, VfxOrigem, VfxPrioridade } from "./VFXController";

export interface PreloadedVfxEntry {
	readonly folder: Instance;
	readonly generation: number;
}

export interface CombatVfxFighterRef {
	readonly targetId: string;
	readonly fighterId: string;
	readonly model: Model;
	readonly attachments: {
		readonly Peito: Attachment | BasePart;
	};
}

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
		this.battleVfxWorkingCopies.clear();
		this.vfxCarrierParts.clear();
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
		const skillName = timeline.name ?? `S${slot}`;
		const slotName = `S${slot}`;

		const modelVfx = attacker.model.FindFirstChild(VFX_ASSETS_FOLDER_NAME);
		if (modelVfx !== undefined) {
			const direct = modelVfx.FindFirstChild(skillName) ?? modelVfx.FindFirstChild(slotName);
			if (direct !== undefined) {
				return { instance: direct, isInModel: true, key: `model:${attacker.targetId}:${direct.Name}` };
			}
		}

		const vfxRoot = this.host.getGlobalVfxRoot();
		if (vfxRoot === undefined) return undefined;

		const fighterVfx =
			vfxRoot.FindFirstChild(attacker.fighterId) ?? vfxRoot.FindFirstChild(attacker.fighterId.lower());
		if (fighterVfx !== undefined) {
			const found = fighterVfx.FindFirstChild(skillName) ?? fighterVfx.FindFirstChild(slotName);
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
		const origem = target.attachments.Peito;

		const skillVfx = this.resolveSkillVfx(attacker, timeline, slot);
		if (skillVfx !== undefined) {
			this.emitResolvedBattleVfx(skillVfx, origem, VFX_PRIORIDADE_ESSENCIAL);
		}

		const impactName = isCrit ? VFX_GLOBAL_CRIT_NAME : VFX_GLOBAL_HIT_NAME;
		let impactVfx = this.resolveNamedCombatVfx(attacker, impactName);
		if (impactVfx === undefined && isCrit) {
			impactVfx = this.resolveNamedCombatVfx(attacker, VFX_GLOBAL_HIT_NAME);
		}
		if (impactVfx !== undefined) {
			this.emitResolvedBattleVfx(impactVfx, origem, VFX_PRIORIDADE_ESSENCIAL);
		}
	}

	public emitKoVfx(deadFighter: CombatVfxFighterRef): void {
		if (this.host.getVfxController() === undefined) return;
		const koVfx = this.resolveNamedCombatVfx(deadFighter, VFX_GLOBAL_KO_NAME);
		if (koVfx !== undefined) {
			this.emitResolvedBattleVfx(koVfx, deadFighter.attachments.Peito, VFX_PRIORIDADE_ESSENCIAL);
		}
	}

	public emitResolvedBattleVfx(
		resolved: ResolvedBattleVfx,
		origem: VfxOrigem,
		prioridade: VfxPrioridade,
	): void {
		const vfx = this.host.getVfxController();
		if (vfx === undefined || this.host.isBattleEnded()) return;
		if (resolved.isInModel) {
			vfx.emit(resolved.instance, origem, prioridade, true);
			return;
		}

		const working = this.getOrCreateWorkingVfxCopy(resolved.key, resolved.instance, origem);
		if (working === undefined) return;
		vfx.emit(working, origem, prioridade, true);
	}

	public getOrCreateWorkingVfxCopy(key: string, template: Instance, origem: VfxOrigem): Instance | undefined {
		const stageFolder = this.host.getStageFolder();
		if (stageFolder === undefined || !stageFolder.Parent) return undefined;

		let working = this.battleVfxWorkingCopies.get(key);
		if (working === undefined || !working.Parent) {
			working = template.Clone();
			working.Name = `BattleVFX_${key}`;
			working.SetAttribute(VFX_ATTR_IGNORAR_CULLING, true);
			this.parentAndPositionWorkingVfx(working, origem);
			this.battleVfxWorkingCopies.set(key, working);
			return working;
		}

		this.positionWorkingVfx(working, origem);
		return working;
	}

	private resolveOrigemCFrame(origem: VfxOrigem): CFrame {
		if (typeIs(origem, "CFrame")) return origem;
		if (typeIs(origem, "Vector3")) return new CFrame(origem);
		if (origem.IsA("Attachment")) return origem.WorldCFrame;
		if (origem.IsA("BasePart")) return origem.CFrame;
		return origem.GetPivot();
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
			return;
		}
		if (working.IsA("Model")) {
			working.PivotTo(cf);
		} else if (working.IsA("BasePart")) {
			working.CFrame = cf;
		}
	}
}
