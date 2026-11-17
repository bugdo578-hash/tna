-- Studio Client, fresh rbxtsc/Rojo sync. Isolated controllers; never purchases or mutates saved data.
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local HUD = require(ts.Controllers.BattleHUD).BattleHUD
local Combat = require(ts.Controllers.CombatController).CombatController
local XP = require(ts.UI.XpRewardCards).XpRewardCards
local remotes = require(ts.Controllers.BattleRemotes).BattleRemotes
local theme = require(ts.UI.UITheme).UITheme
local config = require(ts.UI.CombatVisualConfig)
local original = game.Players.LocalPlayer.PlayerGui:FindFirstChild(theme.ScreenGuiName)
if original then original.Name = "BattleHUDOriginalQA" end
local c = Combat.new()
c:initBillboardPool()
local h = HUD.new(c)
h:buildGui()
h.screenGui.Name = "BattleHUDTeardownQA"
h.resultScreenGui.Name = "BattleResultTeardownQA"
local originalQuit = remotes.requestQuit
local quitCount = 0
remotes.requestQuit = { FireServer = function() quitCount += 1 end }
local rows, checks = {}, 0
local function check(condition, message)
	checks += 1
	assert(condition, message)
end
local function start(mode, reverse)
	local own, enemy = reverse and "B" or "A", reverse and "A" or "B"
	local payload = { sides = { own, enemy }, mode = mode, canPause = mode == "PVE", fighters = {
		{ sideId = own, targetId = "qa-own", fighterId = "dummy", className = "Fury", level = 1, hp = 100, hpMax = 100, active = true },
		{ sideId = enemy, targetId = "qa-enemy", fighterId = "dummy", className = "Menace", level = 1, hp = 100, hpMax = 100, active = true },
	} }
	c:onBattleStarted(payload)
	c.stageFolder.Name = "ClientBattleStageTeardownQA"
	h:onBattleStarted(payload)
	check(h.screenGui.Enabled and c.stageFolder ~= nil and h.battleActive, "BattleStarted hidden")
	return own, enemy
end
local function assertEnded()
	check(not h.screenGui.Enabled and not h.battleActive and h.battleEnded, "HUD still active")
	check(c.stageFolder == nil and not workspace:FindFirstChild("ClientBattleStageTeardownQA"), "stage survived")
	check(next(c.battleTweens) == nil and next(c.battleTasks) == nil and next(c.battleConnections) == nil and next(c.battleTracks) == nil, "combat resources survived")
	check(next(h.hpTweens) == nil and #h.battleDisconnectors == 0, "HUD resources survived")
	check(next(c.hpVisualListeners) == nil and next(c.deathVisualListeners) == nil, "visual callbacks survived")
	for _, item in c.billboardPool do check(not item.billboard.Enabled and not item.inUse and item.billboard.Adornee == nil, "popup survived") end
end
local function assertResultClosed()
	check(not h.resultScreenGui.Enabled and h.xpCards.root == nil, "result/cards survived dismissal")
	check(next(h.xpCards.tweens) == nil and next(h.xpCards.connections) == nil, "XP resources survived dismissal")
end
local ok, failure = pcall(function()
	for _, case in {
		{ "PVE victory", "PVE", true, "victory", true },
		{ "PVE defeat", "PVE", false, "victory" },
		{ "PVE quit", "PVE", false, "quit", false, true },
		{ "PVP victory", "PVP", true, "victory", true },
		{ "PVP defeat", "PVP", false, "victory" },
		{ "PVP quit loser", "PVP", false, "quit", false, true },
		{ "PVP quit winner", "PVP", true, "quit", true },
		{ "opponent disconnect", "PVP", true, "disconnect", true },
		{ "error PVE no winner", "PVE", nil, "error" },
		{ "error PVP no winner", "PVP", nil, "error" },
		{ "timeout", "PVP", nil, "timeout" },
	} do
		local own, enemy = start(case[2], true)
		h:closeResultOverlay()
		h:handleResultCloseAndRestart()
		check(h.screenGui.Enabled and c.stageFolder ~= nil, "dismissal hid active battle")
		if #rows == 0 then
			task.wait(config.BATTLE_END_CLEANUP_DELAY_SECONDS + 0.1)
			check(h.screenGui.Enabled and c.stageFolder ~= nil, "active battle disappeared after old cleanup interval")
		end
		c:onAttackStarted({ attackerId = "qa-own", targetId = "qa-enemy", slot = 1 })
		local target = c.fightersByTargetId["qa-enemy"]
		c:showFloatingText(target.attachments.Cabeca, "QA", Color3.new(1, 1, 1), UDim2.fromOffset(100, 40))
		check(next(c.battleTweens) ~= nil and next(c.battleTasks) ~= nil, "fixture lacks live resources")
		local tweenSnapshot = table.clone(c.battleTweens)
		local signal = Instance.new("BindableEvent")
		local connection = signal.Event:Connect(function() error("late marker") end)
		c.battleConnections[connection] = true
		local staleCallback = false
		c:delayBattle(0.1, function() staleCallback = true end)
		local winner = if case[3] == nil then nil elseif case[3] then own else enemy
		local payload = { winnerSideId = winner, reason = case[4], xpRewards = case[5] and XP.devRewards() or nil }
		if case[6] then
			local before = quitCount
			h:handleQuitClicked()
			check(h.screenGui.Enabled and c.stageFolder ~= nil and quitCount == before, "first quit click ended battle")
			h:handleQuitClicked()
			check(not h.screenGui.Enabled and c.stageFolder ~= nil and h.battleActive and quitCount == before + 1, "confirmed quit policy")
		end
		h:onBattleEnded(payload)
		assertEnded()
		check(not connection.Connected, "marker still connected")
		for tween in tweenSnapshot do check(tween.PlaybackState ~= Enum.PlaybackState.Playing, "tween still playing") end
		local resultExpected = not case[6] and winner ~= nil
		check(h.resultScreenGui.Enabled == resultExpected, "result policy: " .. case[1])
		check((h.xpCards.root ~= nil) == (case[5] == true), "XP visibility: " .. case[1])
		local resultGui = h.resultScreenGui
		h:onBattleEnded(payload)
		check(h.resultScreenGui == resultGui, "duplicate end changed result")
		h:closeResultOverlay()
		assertResultClosed()
		task.wait(0.15)
		check(not staleCallback, "old delayed callback ran")
		signal:Destroy()
		table.insert(rows, case[1] .. ": passed")
	end
	-- A failure in one cleanup step cannot prevent the stage, connections or tweens from being cleaned.
	local own = start("PVE")
	c:onAttackStarted({ attackerId = "qa-own", targetId = "qa-enemy", slot = 1 })
	c.battleTweens[{ Cancel = function() error("injected tween cleanup error") end }] = true
	c.battleConnections[{ Disconnect = function() error("injected connection cleanup error") end }] = true
	local trackDestroyed = false
	c.battleTracks[{ Stop = function() error("injected animation stop error") end,
		Destroy = function() trackDestroyed = true end }] = true
	local clear = h.xpCards.clear
	h.xpCards.clear = function() error("injected XP cleanup error") end
	h:onBattleEnded({ reason = "error" })
	assertEnded()
	check(trackDestroyed, "animation destroy skipped after stop error")
	h.xpCards.clear = clear
	h:closeResultOverlay()
	assertResultClosed()
	-- Rendering happens after teardown, so renderer exceptions cannot leave combat active.
	start("PVE")
	local show = h.xpCards.show
	h.xpCards.show = function() error("injected XP rendering error") end
	h:onBattleEnded({ winnerSideId = "A", reason = "victory", xpRewards = XP.devRewards() })
	assertEnded(); assertResultClosed()
	h.xpCards.show = show
	-- Fechar o resultado não pode pedir outra batalha, inclusive no Studio.
	start("PVE")
	h:onBattleEnded({ winnerSideId = "A", reason = "victory", xpRewards = XP.devRewards() })
	local requestDevBattle = h.requestDevBattle
	local requested = false
	h.requestDevBattle = function() requested = true end
	h:handleResultCloseAndRestart()
	check(not requested, "closing result requested another battle")
	check(h.resultActionButton.Text == "FECHAR", "result button still offers restart")
	assertEnded(); assertResultClosed()
	h.requestDevBattle = requestDevBattle
	-- The author may opt back into a local Quit result; default is immediate close.
	start("PVP")
	theme.ShowResultOnLocalQuit = true
	h:handleQuitClicked(); h:handleQuitClicked()
	h:onBattleEnded({ winnerSideId = "B", reason = "quit" })
	check(h.resultScreenGui.Enabled, "Quit result override ignored")
	theme.ShowResultOnLocalQuit = false
	h:closeResultOverlay()
	assertEnded(); assertResultClosed()
	-- Missing result modal must not bypass cleanup.
	start("PVE")
	h.resultOverlay.ResultModalCard:Destroy()
	h:onBattleEnded({ reason = "error" })
	assertEnded(); assertResultClosed()
	-- A new battle remains alive beyond the former end-delay; no timer from the old one owns it.
	start("PVE")
	h:onBattleEnded({ reason = "error" })
	start("PVE")
	task.wait(config.BATTLE_END_CLEANUP_DELAY_SECONDS + 0.2)
	check(c.stageFolder ~= nil and h.screenGui.Enabled and h.battleActive, "old cleanup destroyed next battle")
	h:onBattleEnded({ reason = "error" })
	assertEnded()
end)
remotes.requestQuit = originalQuit
theme.ShowResultOnLocalQuit = false
h:destroy()
c:cleanupStage()
c.poolContainer:Destroy()
if original then original.Name = theme.ScreenGuiName end
assert(ok, failure)
return { result = "BATTLE_TEARDOWN_CLIENT_PASSED", checks = checks, scenarios = rows }
