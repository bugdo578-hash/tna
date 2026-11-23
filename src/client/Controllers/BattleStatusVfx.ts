import { ReplicatedStorage } from "@rbxts/services";
import type { PartIclesApi } from "../types/Part_Icles";
import {
	BATTLE_BURN_CORE_EMITTER_NAME,
	BATTLE_BURN_IMPACT_EMITTER_NAME,
	BATTLE_BURN_VFX_TEMPLATE_NAME,
	VFX_MODULE_NAME,
	VFX_TEMPLATES_FOLDER_NAME,
} from "../UI/VFXConfig";
import { battleCleanupStep } from "./BattleCleanup";

interface StatusPartIclesApi extends PartIclesApi {
	readonly Connection?: RBXScriptConnection;
	EnableEmit(this: StatusPartIclesApi, item: Instance, link?: Instance, emitCtx?: unknown): void;
	Disable(this: StatusPartIclesApi, item: Instance): void;
	SetEmitParent(this: StatusPartIclesApi, item: Instance, parent: Instance): void;
}

export interface BattleStatusVfxHost {
	readonly getAssetsRoot: () => Instance;
	readonly getStageFolder: () => Folder | undefined;
	readonly isBattleEnded: () => boolean;
}

interface ActiveBurnVfx {
	readonly limbEmitters: ParticleEmitter[];
	readonly maxEmitterLifetime: number;
	readonly corePart?: BasePart;
	readonly vfxContainer?: Folder;
	readonly visualsFolder?: Folder;
	cleanupTask?: thread;
	disposed: boolean;
}

const R6_BODY_PART_NAMES = ["Head", "Torso", "Left Arm", "Right Arm", "Left Leg", "Right Leg"] as const;
const R15_BODY_PART_NAMES = [
	"Head",
	"UpperTorso",
	"LowerTorso",
	"LeftUpperArm",
	"RightUpperArm",
	"LeftUpperLeg",
	"RightUpperLeg",
] as const;

const TORSO_RATE_SHARE = 0.28;
const LIMB_RATE_SHARE = 0.14;
const BURN_IMPACT_TAIL_MAX_SECONDS = 4.5;

function isTorsoPartName(name: string): boolean {
	return name === "Torso" || name === "UpperTorso" || name === "LowerTorso";
}

function resolveBodyParts(model: Model): BasePart[] {
	const r6: BasePart[] = [];
	for (const partName of R6_BODY_PART_NAMES) {
		const found = model.FindFirstChild(partName);
		if (found?.IsA("BasePart")) r6.push(found);
	}
	if (r6.size() > 0) return r6;

	const r15: BasePart[] = [];
	for (const partName of R15_BODY_PART_NAMES) {
		const found = model.FindFirstChild(partName);
		if (found?.IsA("BasePart")) r15.push(found);
	}
	if (r15.size() > 0) return r15;

	const fallback = model.PrimaryPart ?? model.FindFirstChild("HumanoidRootPart");
	return fallback?.IsA("BasePart") ? [fallback] : [];
}

function resolveTorsoPart(model: Model): BasePart | undefined {
	for (const candidate of ["Torso", "UpperTorso", "HumanoidRootPart"]) {
		const found = model.FindFirstChild(candidate);
		if (found?.IsA("BasePart")) return found;
	}
	return model.PrimaryPart;
}

function configureNonCollidingPart(part: BasePart, anchored: boolean): void {
	part.Anchored = anchored;
	part.CanCollide = false;
	part.CanTouch = false;
	part.CanQuery = false;
	part.Massless = !anchored;
}

function disableDescendantCollision(root: Instance): void {
	for (const descendant of root.GetDescendants()) {
		if (!descendant.IsA("BasePart")) continue;
		descendant.CanCollide = false;
		descendant.CanTouch = false;
		descendant.CanQuery = false;
	}
}

/**
 * Gerencia o VFX customizado de Burn (`ReplicatedStorage.vfxs.BurnDot`):
 * - Clona os `ParticleEmitter`s diretos de `BurnDot` nas partes do corpo (cabeça, torso, braços e pernas)
 *   ajustando o `Rate` por membro para manter a densidade equilibrada.
 * - Clona `foginlowpoly` soldado no centro do torso e aciona via `Part_Icles:EnableEmit`
 *   para disparar o `fogo bloco` apenas nos impactos configurados pelo autor.
 */
export class BattleStatusVfx {
	private readonly activeBurns = new Map<string, ActiveBurnVfx>();
	private partIcles?: StatusPartIclesApi;
	private partIclesLoadAttempted = false;

	public constructor(private readonly host: BattleStatusVfxHost) {}

	public applyBurn(targetId: string, model: Model): boolean {
		if (this.host.isBattleEnded()) return false;
		const templateFolder = this.resolveBurnTemplate();
		if (templateFolder === undefined) return false;

		const existing = this.activeBurns.get(targetId);
		if (existing !== undefined && !existing.disposed) {
			this.cancelTailCleanup(existing);
			for (const emitter of existing.limbEmitters) {
				if (emitter.Parent !== undefined) emitter.Enabled = true;
			}
			this.emitCore(existing.corePart);
			return true;
		}

		const bodyParts = resolveBodyParts(model);
		const templateEmitters: ParticleEmitter[] = [];
		for (const child of templateFolder.GetChildren()) {
			if (child.IsA("ParticleEmitter")) templateEmitters.push(child);
		}
		const coreTemplate = templateFolder.FindFirstChild(BATTLE_BURN_CORE_EMITTER_NAME);
		const hasCore = coreTemplate?.IsA("BasePart") === true;

		if (templateEmitters.size() === 0 && !hasCore) return false;

		const limbEmitters: ParticleEmitter[] = [];
		let maxEmitterLifetime = 0.5;
		const singlePart = bodyParts.size() <= 1;

		for (const part of bodyParts) {
			const rateShare = singlePart ? 1 : isTorsoPartName(part.Name) ? TORSO_RATE_SHARE : LIMB_RATE_SHARE;
			for (const idx of $range(0, templateEmitters.size() - 1)) {
				const sourceEmitter = templateEmitters[idx];
				const cloned = sourceEmitter.Clone();
				cloned.Name = `StatusVFX_Burn_${part.Name}_${idx + 1}`;
				cloned.Rate = math.max(math.round(sourceEmitter.Rate * rateShare), 1);
				cloned.Enabled = true;
				cloned.Parent = part;
				limbEmitters.push(cloned);
				if (cloned.Lifetime.Max > maxEmitterLifetime) {
					maxEmitterLifetime = cloned.Lifetime.Max;
				}
			}
		}

		let corePart: BasePart | undefined;
		let vfxContainer: Folder | undefined;
		let visualsFolder: Folder | undefined;

		if (coreTemplate?.IsA("BasePart")) {
			const torso = resolveTorsoPart(model);
			const stageFolder = this.host.getStageFolder();
			if (torso !== undefined && torso.Parent !== undefined) {
				const container = new Instance("Folder");
				container.Name = `StatusVFX_Burn_${targetId}`;
				const visuals = new Instance("Folder");
				visuals.Name = "Particles";
				visuals.Parent = container;
				container.Parent = stageFolder ?? model;
				vfxContainer = container;
				visualsFolder = visuals;

				const clonedCore = coreTemplate.Clone();
				clonedCore.Name = `StatusVFX_Burn_${BATTLE_BURN_CORE_EMITTER_NAME}_${targetId}`;
				disableDescendantCollision(clonedCore);

				const impactChild = clonedCore.FindFirstChild(BATTLE_BURN_IMPACT_EMITTER_NAME);
				if (impactChild?.IsA("BasePart")) {
					configureNonCollidingPart(impactChild, true);
					impactChild.Parent = container;
				}

				configureNonCollidingPart(clonedCore, false);
				clonedCore.CFrame = torso.CFrame;

				const weld = new Instance("WeldConstraint");
				weld.Name = "StatusVFX_Burn_Weld";
				weld.Part0 = torso;
				weld.Part1 = clonedCore;
				weld.Parent = clonedCore;
				clonedCore.Parent = torso;
				corePart = clonedCore;

				const api = this.ensurePartIcles();
				if (api !== undefined) {
					battleCleanupStep("burn set emit parent", () => {
						api.SetEmitParent(clonedCore, visuals);
						if (impactChild !== undefined) api.SetEmitParent(impactChild, visuals);
					});
					this.emitCore(clonedCore);
				}
			}
		}

		this.activeBurns.set(targetId, {
			limbEmitters,
			maxEmitterLifetime,
			corePart,
			vfxContainer,
			visualsFolder,
			disposed: false,
		});
		return true;
	}

	public removeBurn(targetId: string, immediate = false): void {
		const active = this.activeBurns.get(targetId);
		if (active === undefined) return;
		this.activeBurns.delete(targetId);
		this.stopHandle(active, immediate);
	}

	public clearAll(): void {
		const handles: ActiveBurnVfx[] = [];
		for (const [, handle] of this.activeBurns) handles.push(handle);
		this.activeBurns.clear();
		for (const handle of handles) {
			this.stopHandle(handle, true);
		}
	}

	private resolveBurnTemplate(): Folder | undefined {
		const root = this.host.getAssetsRoot();
		const direct = root.FindFirstChild(VFX_TEMPLATES_FOLDER_NAME)?.FindFirstChild(BATTLE_BURN_VFX_TEMPLATE_NAME);
		if (direct?.IsA("Folder")) return direct;
		return undefined;
	}

	private ensurePartIcles(): StatusPartIclesApi | undefined {
		if (this.partIcles !== undefined) return this.partIcles;
		if (this.partIclesLoadAttempted) return undefined;
		this.partIclesLoadAttempted = true;

		const root = this.host.getAssetsRoot();
		const module = root.FindFirstChild(VFX_MODULE_NAME) ?? ReplicatedStorage.FindFirstChild(VFX_MODULE_NAME);
		if (!module?.IsA("ModuleScript")) return undefined;

		const [ok, api] = pcall(() => {
			const loaded = require(module) as StatusPartIclesApi;
			if (loaded.Connection === undefined) loaded.Activate();
			return loaded;
		});
		if (!ok) {
			warn(`[BattleStatusVfx] Part_Icles: ${tostring(api)}`);
			return undefined;
		}
		this.partIcles = api;
		return api;
	}

	private emitCore(corePart: BasePart | undefined): void {
		if (corePart === undefined || corePart.Parent === undefined) return;
		const api = this.ensurePartIcles();
		if (api === undefined) return;
		battleCleanupStep("burn core emit", () => api.EnableEmit(corePart));
	}

	private cancelTailCleanup(handle: ActiveBurnVfx): void {
		if (handle.cleanupTask === undefined) return;
		const pending = handle.cleanupTask;
		handle.cleanupTask = undefined;
		pcall(() => task.cancel(pending));
	}

	private stopHandle(handle: ActiveBurnVfx, immediate: boolean): void {
		if (handle.disposed) return;
		this.cancelTailCleanup(handle);

		for (const emitter of handle.limbEmitters) {
			if (emitter.Parent !== undefined) emitter.Enabled = false;
		}
		if (handle.corePart !== undefined && handle.corePart.Parent !== undefined) {
			const api = this.ensurePartIcles();
			if (api !== undefined) {
				battleCleanupStep("burn core disable", () => api.Disable(handle.corePart!));
			}
		}

		if (immediate) {
			this.destroyHandle(handle);
			return;
		}

		const waitSeconds = math.max(handle.maxEmitterLifetime, 0.25);
		handle.cleanupTask = task.delay(waitSeconds, () => {
			for (const emitter of handle.limbEmitters) {
				battleCleanupStep("burn limb emitter destroy", () => emitter.Destroy());
			}
			handle.limbEmitters.clear();

			const visuals = handle.visualsFolder;
			if (visuals !== undefined && visuals.Parent !== undefined) {
				const deadline = os.clock() + BURN_IMPACT_TAIL_MAX_SECONDS;
				while (visuals.Parent !== undefined && visuals.GetChildren().size() > 0 && os.clock() < deadline) {
					task.wait(0.1);
				}
			}
			handle.cleanupTask = undefined;
			this.destroyHandle(handle);
		});
	}

	private destroyHandle(handle: ActiveBurnVfx): void {
		if (handle.disposed) return;
		handle.disposed = true;
		this.cancelTailCleanup(handle);
		for (const emitter of handle.limbEmitters) {
			battleCleanupStep("burn limb emitter destroy", () => emitter.Destroy());
		}
		handle.limbEmitters.clear();
		if (handle.corePart !== undefined) {
			battleCleanupStep("burn core destroy", () => handle.corePart!.Destroy());
		}
		if (handle.vfxContainer !== undefined) {
			battleCleanupStep("burn container destroy", () => handle.vfxContainer!.Destroy());
		}
	}
}
