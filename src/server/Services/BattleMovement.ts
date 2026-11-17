import { NPC_BATTLE_ACTIVE_ATTRIBUTE } from "../../shared/Config";

/** Um snapshot por jogador; adquirir novamente nunca captura valores já zerados. */
function cleanupMovement(name: string, cleanup: () => void): void {
	const [ok, failure] = pcall(cleanup);
	if (!ok) warn(`[BattleMovement] ${name}: ${tostring(failure)}`);
}

const releases = new Map<Player, () => void>();
export function freezeBattleMovement(player: Player, humanoid: Humanoid, onRemoving: () => void): () => void {
	const existing = releases.get(player);
	if (existing !== undefined) return existing;
	const speed = humanoid.WalkSpeed;
	const power = humanoid.JumpPower;
	const height = humanoid.JumpHeight;
	const usePower = humanoid.UseJumpPower;
	let released = false;
	let removing: RBXScriptConnection | undefined;
	const release = () => {
		if (released) return;
		released = true;
		releases.delete(player);
		cleanupMovement("CharacterRemoving", () => removing?.Disconnect());
		cleanupMovement("WalkSpeed", () => { humanoid.WalkSpeed = speed; });
		cleanupMovement("JumpPower", () => { humanoid.JumpPower = power; });
		cleanupMovement("JumpHeight", () => { humanoid.JumpHeight = height; });
		cleanupMovement("UseJumpPower", () => { humanoid.UseJumpPower = usePower; });
		cleanupMovement("NpcBattleActive", () => player.SetAttribute(NPC_BATTLE_ACTIVE_ATTRIBUTE, false));
	};
	releases.set(player, release);
	const [ok, failure] = pcall(() => {
		humanoid.WalkSpeed = 0;
		humanoid.JumpPower = 0;
		humanoid.JumpHeight = 0;
		player.SetAttribute(NPC_BATTLE_ACTIVE_ATTRIBUTE, true);
		removing = player.CharacterRemoving.Connect(onRemoving);
	});
	if (!ok) { release(); error(failure); }
	return release;
}
