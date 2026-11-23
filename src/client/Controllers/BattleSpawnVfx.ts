import { ReplicatedStorage } from "@rbxts/services";
import { FIGHTER_MATERIALIZATION_SECONDS } from "../UI/CombatVisualConfig";
import { BATTLE_SPAWN_VFX_TEMPLATE_NAME, VFX_MODULE_NAME, VFX_TEMPLATES_FOLDER_NAME } from "../UI/VFXConfig";
import type { PartIclesApi } from "../types/Part_Icles";
import { battleCleanupStep } from "./BattleCleanup";

interface SpawnPartIcles extends PartIclesApi {
	readonly Connection?: RBXScriptConnection;
	Disable(this: SpawnPartIcles, item: Instance): void;
	SetEmitParent(this: SpawnPartIcles, item: Instance, parent: Instance): void;
	SetTimescale(this: SpawnPartIcles, item: Instance, scale: number, duration?: number, permanent?: boolean): void;
}

export class BattleSpawnVfx {
	public static load(): BattleSpawnVfx | undefined {
		const template = ReplicatedStorage.FindFirstChild(VFX_TEMPLATES_FOLDER_NAME)?.FindFirstChild(BATTLE_SPAWN_VFX_TEMPLATE_NAME);
		const module = ReplicatedStorage.FindFirstChild(VFX_MODULE_NAME);
		if (!template?.IsA("Model") || !module?.IsA("ModuleScript")) return undefined;
		const [ok, api] = pcall(() => {
			const api = require(module) as SpawnPartIcles;
			if (api.Connection === undefined) api.Activate();
			return api;
		});
		if (!ok) {
			warn(`[BattleSpawnVfx] Part_Icles: ${tostring(api)}`);
			return undefined;
		}
		return new BattleSpawnVfx(template, api);
	}

	private constructor(private readonly template: Model, private readonly api: SpawnPartIcles) {}

	public emit(fighter: Model, frame: CFrame, stage: Folder): (() => void) | undefined {
		const clone = this.template.Clone();
		const placeholder = clone.FindFirstChild("Fighter_placeHolder");
		const highlight = placeholder?.FindFirstChild("Highligthspawn");
		const adornee = highlight?.FindFirstChild("Adornee");
		if (!highlight?.IsA("Highlight") || !adornee?.IsA("ObjectValue")) {
			clone.Destroy();
			warn("[BattleSpawnVfx] Emissor Highligthspawn ou referência Adornee ausente.");
			return undefined;
		}

		const particles = new Instance("Folder");
		particles.Name = "BattleSpawnVfx";
		const visuals = new Instance("Folder");
		visuals.Name = "Particles";
		visuals.Parent = particles;
		const highlights = new Instance("Folder");
		highlights.Name = "BattleSpawnHighlight";
		let tail: thread | undefined;
		let disposed = false;
		const cleanup = () => {
			if (disposed) return;
			disposed = true;
			if (tail !== undefined) task.cancel(tail);
			tail = undefined;
			battleCleanupStep("spawn particles stop", () => this.api.Disable(clone));
			battleCleanupStep("spawn particles destroy", () => particles.Destroy());
			battleCleanupStep("spawn highlight destroy", () => highlights.Destroy());
			battleCleanupStep("spawn emitter destroy", () => clone.Destroy());
		};
		const [ok, failure] = pcall(() => {
			// Mantenha o emissor na árvore do AbsoluteEmit. O Qwinkle cria
			// e anima o Highlight visual no fighter por EmitParent e Adornee.
			highlight.Parent = clone;
			adornee.Value = fighter;
			for (const descendant of clone.GetDescendants()) {
				if (descendant.IsA("ObjectValue") && descendant.Value === placeholder) descendant.Value = fighter;
			}
			placeholder?.Destroy();

			clone.PivotTo(frame);
			const homingTarget = clone.FindFirstChild("gelu")?.FindFirstChild("modevents")?.FindFirstChild("HOMING_TARGET");
			const impactSurface = homingTarget?.IsA("ObjectValue") ? homingTarget.Value : undefined;
			for (const child of clone.GetChildren()) {
				if (!child.IsA("BasePart")) continue;
				child.Anchored = true;
			}
			for (const descendant of clone.GetDescendants()) {
				if (!descendant.IsA("BasePart")) continue;
				descendant.CanCollide = false;
				descendant.CanTouch = false;
				if (descendant !== impactSurface) descendant.CanQuery = false;
			}
			for (const descendant of clone.GetDescendants()) {
				if (descendant.GetAttribute("Transformed") !== true) continue;
				// A emissão aninhada no RenderTemplate do b1 adota o seu próprio parent.
				let parent = descendant.Parent;
				while (parent !== undefined && parent !== clone && parent.Name !== "RenderTemplate") parent = parent.Parent;
				// O raycast do Qwinkle exclui o EmitParent inteiro. O alvo de impacto fica no clone fonte.
				if (parent === clone) this.api.SetEmitParent(descendant, descendant === highlight ? highlights : visuals);
			}

			const lifetime = highlight.FindFirstChild("PartIcleProperties")?.GetAttribute("Lifetime");
			if (typeIs(lifetime, "NumberRange") && lifetime.Max > 0) {
				this.api.SetTimescale(highlight, lifetime.Max / FIGHTER_MATERIALIZATION_SECONDS, undefined, true);
			}
			highlights.Parent = fighter;
			clone.Parent = particles;
			particles.Parent = stage;
			const duration = this.api.AbsoluteEmit(clone) ?? FIGHTER_MATERIALIZATION_SECONDS;
			tail = task.delay(math.max(duration, FIGHTER_MATERIALIZATION_SECONDS), () => {
				// Um impacto no fim da emissão pode ter suas próprias partículas em andamento.
				const deadline = os.clock() + duration;
				while (visuals.GetChildren().size() > 0 && os.clock() < deadline) task.wait();
				tail = undefined;
				cleanup();
			});
		});
		if (!ok) {
			cleanup();
			warn(`[BattleSpawnVfx] Emissão: ${tostring(failure)}`);
			return undefined;
		}
		return cleanup;
	}
}
