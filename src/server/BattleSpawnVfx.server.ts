import { ReplicatedStorage, Workspace } from "@rbxts/services";
import { BATTLE_SPAWN_VFX_TEMPLATE_NAME } from "../shared/configs/BattleIntro";

// Retire o modelo de cena somente na sessão em execução. O template manual
// permanece no Workspace do Studio e o runtime independe de streaming.
const template = Workspace.FindFirstChild(BATTLE_SPAWN_VFX_TEMPLATE_NAME);
if (template?.IsA("Model") && ReplicatedStorage.FindFirstChild(BATTLE_SPAWN_VFX_TEMPLATE_NAME) === undefined) {
	template.Parent = ReplicatedStorage;
}
