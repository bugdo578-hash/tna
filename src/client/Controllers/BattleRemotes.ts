import {
	REMOTE_NAMES,
	REMOTES_FOLDER_NAME,
} from "../../shared/Remotes";
import { ReplicatedStorage } from "@rbxts/services";

const remotesFolder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME) as Folder;

function waitForRemote(name: string): RemoteEvent {
	return remotesFolder.WaitForChild(name) as RemoteEvent;
}

export const BattleRemotes = {
	requestSkill: waitForRemote(REMOTE_NAMES.RequestSkill),
	requestSwitch: waitForRemote(REMOTE_NAMES.RequestSwitch),
	requestPause: waitForRemote(REMOTE_NAMES.RequestPause),
	requestQuit: waitForRemote(REMOTE_NAMES.RequestQuit),
	requestAllocate: waitForRemote(REMOTE_NAMES.RequestAllocate),
	battleStarted: waitForRemote(REMOTE_NAMES.BattleStarted),
	battleTransition: waitForRemote(REMOTE_NAMES.BattleTransition),
	stateChanged: waitForRemote(REMOTE_NAMES.StateChanged),
	switchPerformed: waitForRemote(REMOTE_NAMES.SwitchPerformed),
	attackStarted: waitForRemote(REMOTE_NAMES.AttackStarted),
	hitResolved: waitForRemote(REMOTE_NAMES.HitResolved),
	effectApplied: waitForRemote(REMOTE_NAMES.EffectApplied),
	effectTick: waitForRemote(REMOTE_NAMES.EffectTick),
	effectExpired: waitForRemote(REMOTE_NAMES.EffectExpired),
	fighterDied: waitForRemote(REMOTE_NAMES.FighterDied),
	battleEnded: waitForRemote(REMOTE_NAMES.BattleEnded),
	atbSync: waitForRemote(REMOTE_NAMES.AtbSync),
};
