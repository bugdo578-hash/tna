import { Players, ReplicatedStorage, TweenService } from "@rbxts/services";
import { REMOTE_NAMES, REMOTES_FOLDER_NAME, type TinyesChangedPayload } from "../../shared/Remotes";
import { GAME_FONT, UITheme } from "./UITheme";

// Apresentação apenas: o saldo sempre vem do servidor.
const gui = new Instance("ScreenGui");
gui.Name = UITheme.Tinyes.ScreenGuiName;
gui.ResetOnSpawn = false;
gui.DisplayOrder = UITheme.Tinyes.DisplayOrder;
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
const label = new Instance("TextLabel");
label.Name = "Balance";
label.Position = UITheme.Tinyes.Position;
label.Size = UITheme.Tinyes.Size;
label.BackgroundColor3 = UITheme.Colors.PanelBackground;
label.BackgroundTransparency = UITheme.Transparency.Panel;
label.TextColor3 = UITheme.Colors.RewardGold;
label.FontFace = GAME_FONT;
label.TextScaled = true;
label.Text = "Tinyes: —";
const constraint = new Instance("UITextSizeConstraint");
constraint.MinTextSize = UITheme.Tinyes.MinTextSize;
constraint.MaxTextSize = UITheme.Tinyes.MaxTextSize;
constraint.Parent = label;
label.Parent = gui;
gui.Parent = Players.LocalPlayer.WaitForChild("PlayerGui");
let lastBalance: number | undefined;
const remote = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME).WaitForChild(REMOTE_NAMES.TinyesChanged) as RemoteEvent;
remote.OnClientEvent.Connect((payload: TinyesChangedPayload) => {
	const previous = lastBalance;
	lastBalance = payload.balance;
	label.Text = `Tinyes: ${payload.balance}`;
	if (previous === undefined || payload.balance <= previous) return;
	const gain = new Instance("TextLabel");
	gain.Name = "Gain";
	gain.Size = UITheme.Layout.FullSize;
	gain.Position = UITheme.Tinyes.GainStart;
	gain.BackgroundTransparency = UITheme.Transparency.Hidden;
	gain.TextColor3 = UITheme.Colors.RewardGold;
	gain.FontFace = GAME_FONT;
	gain.TextScaled = true;
	gain.Text = `+${payload.balance - previous}`;
	constraint.Clone().Parent = gain;
	gain.Parent = label;
	const tween = TweenService.Create(gain, new TweenInfo(UITheme.Tinyes.GainSeconds), {
		Position: UITheme.Tinyes.GainEnd,
		TextTransparency: UITheme.Transparency.Hidden,
	});
	tween.Completed.Once(() => gain.Destroy());
	tween.Play();
});
