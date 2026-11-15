import { CollectionService, Players, ProximityPromptService, ReplicatedStorage, StarterGui, Workspace } from "@rbxts/services";
import { BATTLE_NPC_TAG, NPC_BATTLE_ACTIVE_ATTRIBUTE } from "../../shared/Config";
import { REMOTE_NAMES, REMOTES_FOLDER_NAME } from "../../shared/Remotes";
import { BattleRemotes } from "./BattleRemotes";

const player = Players.LocalPlayer;
const hidden = new Map<ProximityPrompt, boolean>();
let inBattle = player.GetAttribute(NPC_BATTLE_ACTIVE_ATTRIBUTE) === true;

function hide(prompt: ProximityPrompt): void {
	if (!inBattle || hidden.has(prompt)) return;
	let ancestor: Instance | undefined = prompt.Parent;
	while (ancestor !== undefined) {
		if (CollectionService.HasTag(ancestor, BATTLE_NPC_TAG)) {
			hidden.set(prompt, prompt.Enabled);
			prompt.Enabled = false;
			return;
		}
		ancestor = ancestor.Parent;
	}
}

function update(active: boolean): void {
	inBattle = active;
	if (active) {
		for (const npc of CollectionService.GetTagged(BATTLE_NPC_TAG)) {
			for (const descendant of npc.GetDescendants()) if (descendant.IsA("ProximityPrompt")) hide(descendant);
		}
	} else {
		for (const [prompt, enabled] of hidden) if (prompt.Parent !== undefined) prompt.Enabled = enabled;
		hidden.clear();
	}
}

BattleRemotes.battleStarted.OnClientEvent.Connect(() => update(true));
BattleRemotes.battleEnded.OnClientEvent.Connect(() => update(false));
player.GetAttributeChangedSignal(NPC_BATTLE_ACTIVE_ATTRIBUTE).Connect(() => update(player.GetAttribute(NPC_BATTLE_ACTIVE_ATTRIBUTE) === true));
ProximityPromptService.PromptShown.Connect((prompt) => hide(prompt));
Workspace.DescendantAdded.Connect((descendant) => { if (descendant.IsA("ProximityPrompt")) hide(descendant); });
CollectionService.GetInstanceAddedSignal(BATTLE_NPC_TAG).Connect(() => update(inBattle));
const notice = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME).WaitForChild(REMOTE_NAMES.NpcBattleNotice) as RemoteEvent;
notice.OnClientEvent.Connect((message: string) => {
	pcall(() => StarterGui.SetCore("SendNotification", { Title: "Batalha", Text: message }));
});
update(inBattle);
