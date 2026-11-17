-- Studio only. Create ReplicatedStorage.BattleTeardownQAProbe (RemoteFunction), run this in
-- Client to install the probe, then in Server. One real client + one mock PVP participant.
-- No profile writes or live service request bindings. Probe is destroyed on completion.
local run = game:GetService("RunService")
assert(run:IsStudio(), "Studio only")
local storage = game:GetService("ReplicatedStorage")
local probe = storage:WaitForChild("BattleTeardownQAProbe")
if run:IsClient() then
	probe.OnClientInvoke = function()
		local player = game.Players.LocalPlayer
		local gui = player.PlayerGui:FindFirstChild("BattleHUD")
		local result = player.PlayerGui:FindFirstChild("BattleResult")
		return {
			hud = gui ~= nil and gui.Enabled,
			stage = workspace:FindFirstChild("ClientBattleStage") ~= nil,
			npcActive = player:GetAttribute("NpcBattleActive") == true,
			result = result ~= nil and result.Enabled,
			xp = result ~= nil and result:FindFirstChild("XpRewards", true) ~= nil,
		}
	end
	return "BATTLE_TEARDOWN_LIVE_PROBE_READY"
end
local services = game.ServerScriptService.TS.Services
local Session = require(services.BattleSessionService).BattleSessionService
local freeze = require(services.BattleMovement).freezeBattleMovement
local createSide = require(services.NpcService).createNpcSide
local definition = require(storage.TS.NpcData).NPC_DATA.bronze_trainer
local protocol = require(storage.TS.Remotes)
local remoteFolder = storage:FindFirstChild(protocol.REMOTES_FOLDER_NAME)
local player = game.Players:GetPlayers()[1]
assert(player and player.Character and not player:GetAttribute("NpcBattleActive"), "idle real player required")
local humanoid = player.Character:FindFirstChildOfClass("Humanoid")
local original = { humanoid.WalkSpeed, humanoid.JumpPower, humanoid.JumpHeight, humanoid.UseJumpPower }
local rows = {}
local activeSession, restore, opponentRemoving, opponentHumanoid
local ok, failure = pcall(function()
	for _, case in {
		{ "PVE victory", "PVE", "win" }, { "PVE defeat", "PVE", "loss" },
		{ "PVE quit", "PVE", "quit" }, { "PVP victory", "PVP", "win" },
		{ "PVP local quit", "PVP", "quit" }, { "PVP opponent quit", "PVP", "opponentQuit" },
		{ "PVP opponent disconnect", "PVP", "disconnect" },
		{ "PVE error no winner", "PVE", "error" }, { "PVP error no winner", "PVP", "error" },
	} do
		opponentRemoving = Instance.new("BindableEvent")
		opponentHumanoid = Instance.new("Humanoid")
		local attributes = {}
		local other = { Parent = game.Players, Name = "TeardownLiveOpponent", UserId = -990012,
			CharacterRemoving = opponentRemoving.Event,
			SetAttribute = function(_, name, value) attributes[name] = value end }
		local starts, attempts = {}, {}
		local names = {
			sendBattleStarted = "BattleStarted", sendStateChanged = "StateChanged", sendAtbSync = "AtbSync",
			sendSwitchPerformed = "SwitchPerformed", sendAttackStarted = "AttackStarted", sendHitResolved = "HitResolved",
			sendEffectApplied = "EffectApplied", sendEffectTick = "EffectTick", sendEffectExpired = "EffectExpired",
			sendFighterDied = "FighterDied", sendBattleEnded = "BattleEnded",
		}
		local adapter = { bindRequests = function() end, forgetPlayer = function() end }
		for method, name in names do
			adapter[method] = function(_, recipient, payload)
				if name == "BattleStarted" then starts[recipient] = payload end
				if name == "BattleEnded" then
					attempts[recipient] = (attempts[recipient] or 0) + 1
					-- Synthetic XP exercises the real result GUI without writing progression.
					if recipient == player and payload.winnerSideId == starts[player].sides[1] then
						payload.xpRewards = { { itemUuid = "live-qa", fighterId = "jotaro", displayName = "QA",
							className = "Fury", xpGained = 20, previousLevel = 1, previousXp = 0, previousXpToNext = 100,
							newLevel = 1, newXp = 20, newXpToNext = 100, leveledUp = false } }
					end
				end
				if recipient == player then remoteFolder:FindFirstChild(protocol.REMOTE_NAMES[name]):FireClient(player, payload) end
			end
		end
		local session = Session.new(adapter)
		activeSession = session
		local releases = { freeze(player, humanoid, function() session:destroySessionForPlayer(player) end) }
		if case[2] == "PVP" then table.insert(releases, freeze(other, opponentHumanoid, function() session:destroySessionForPlayer(other) end)) end
		restore = function() for _, release in releases do release() end end
		local rng = function() return 0.5 end
		assert(session:createSession(player, case[2] == "PVP" and other or nil,
			createSide(definition, rng), createSide(definition, rng), rng, case[2], restore), "create failed")
		task.wait(0.15)
		local before = probe:InvokeClient(player)
		assert(before.hud and before.stage and before.npcActive, case[1] .. ": active battle hidden")
		local start = starts[player]
		adapter:sendAttackStarted(player, { attackerId = start.fighters[1].targetId, targetId = start.fighters[3].targetId, slot = 1 })
		local record = session.activeSessions[1]
		local outcome = case[3]
		if outcome == "quit" then session:requestQuit(player)
		elseif outcome == "opponentQuit" then session:requestQuit(other)
		elseif outcome == "disconnect" then other.Parent = nil; session:destroySessionForPlayer(other)
		elseif outcome == "error" then record.battle.step = function() error("live QA session error") end; session:step(0.1)
		else record.battle.events.battleEnd:fire(record.sides[outcome == "loss" and 2 or 1]); session:step(0) end
		task.wait(0.15)
		local after = probe:InvokeClient(player)
		assert(not after.hud and not after.stage and not after.npcActive, case[1] .. ": teardown failed")
		local resultExpected = outcome ~= "quit" and outcome ~= "error"
		assert(after.result == resultExpected, case[1] .. ": result policy")
		assert(attempts[player] == 1 and not session:hasActiveSession(player), case[1] .. ": real participant not ended")
		if case[2] == "PVP" then
			assert(attempts[other] == (other.Parent and 1 or nil) and not session:hasActiveSession(other), "opponent notification")
			assert(attributes.NpcBattleActive == false, "opponent flag")
		end
		assert(humanoid.WalkSpeed == original[1] and humanoid.JumpPower == original[2] and
			humanoid.JumpHeight == original[3] and humanoid.UseJumpPower == original[4], "movement not restored")
		table.insert(rows, { scenario = case[1], hud = after.hud, stage = after.stage, npcActive = after.npcActive, result = after.result, xp = after.xp })
		opponentRemoving:Destroy(); opponentHumanoid:Destroy()
	end
end)
if activeSession then activeSession:requestQuit(player) end
if restore then restore() end
if opponentRemoving then opponentRemoving:Destroy() end
if opponentHumanoid then opponentHumanoid:Destroy() end
probe:Destroy()
assert(ok, failure)
return { result = "BATTLE_TEARDOWN_LIVE_PASSED", scenarios = rows }
