-- Instale cópias temporárias deste script no servidor e no cliente, como em battle-intro-play-qa.
-- StudioTestService:ExecuteMultiplayerTestAsync(2, "Combat interruptions")
local run = game:GetService("RunService")
assert(run:IsStudio())
local players = game:GetService("Players")
local storage = game:GetService("ReplicatedStorage")
local test = game:GetService("StudioTestService")
local shared = require(storage:WaitForChild("TS"):WaitForChild("Remotes"))
local probeName = "CombatInterruptionsQA"

if run:IsClient() then
	local player = players.LocalPlayer
	local controllers = player:WaitForChild("PlayerScripts"):WaitForChild("TS"):WaitForChild("Controllers")
	local combat = require(controllers.CombatController).CombatController.new(nil, nil, nil, nil, nil, function()
		return Vector2.new(1280, 720)
	end)
	local hud = require(controllers.BattleHUD).BattleHUD.new(combat)
	combat:start()
	hud:start()
	local attackCount = 0
	local endReason
	local remotes = storage:WaitForChild(shared.REMOTES_FOLDER_NAME)
	remotes:WaitForChild(shared.REMOTE_NAMES.AttackStarted).OnClientEvent:Connect(function() attackCount += 1 end)
	remotes:WaitForChild(shared.REMOTE_NAMES.BattleEnded).OnClientEvent:Connect(function(payload) endReason = payload.reason end)
	local probe = storage:WaitForChild(probeName)
	probe.OnClientInvoke = function()
		return {
			camera = combat:getCameraMode(), paused = combat.resources:isPaused(),
			hudPaused = hud.isPaused, active = hud.battleActive, attacks = attackCount,
			generation = combat:getBattleGeneration(), pending = combat.activePendingHits, reason = endReason,
			stage = combat.stageFolder ~= nil, release = not hud.preparing,
		}
	end
	local report = probe:WaitForChild("Ready")
	report:FireServer()
	return
end

local services = game.ServerScriptService.TS.Services
local dummy = require(game.ServerScriptService.TS.Dev.DummyFighters)
local runtimeConfig = require(storage.TS.Config)
local remote = require(services.RemoteService).RemoteService.new()
-- Isola o ciclo de combate. O countdown tem uma sonda multiplayer própria.
remote.transition = nil
local registry = require(services.ArenaRegistry).ArenaRegistry.new()
registry:start()
local service = require(services.BattleSessionService).BattleSessionService.new(remote, nil, nil, registry)
service:start()
local probe = Instance.new("RemoteFunction")
probe.Name = probeName
local ready = Instance.new("RemoteEvent", probe)
ready.Name = "Ready"
local listening = {}
ready.OnServerEvent:Connect(function(player) listening[player] = true end)
probe.Parent = storage

local function waitUntil(predicate, label, timeout)
	local deadline = os.clock() + (timeout or 12)
	repeat
		if predicate() then return end
		task.wait()
	until os.clock() >= deadline
	error(label)
end

local function snapshot(player)
	return probe:InvokeClient(player)
end

local function start(player, other)
	local rng = function() return 0.5 end
	assert(service:createSession(player, other, dummy.createRealFighterSide("jotaro", rng),
		dummy.createRealFighterSide("anubis", rng), rng, if other then "PVP" else "PVE"))
	local record = service.playerSessions[player].session
	waitUntil(function() return service:isRunning(record) end, "servidor não liberou batalha")
	waitUntil(function()
		local row = snapshot(player)
		return row.release and row.stage
	end, "cliente não abriu o palco")
	return record
end

local function enterAttack(player, record)
	local side = service.playerSessions[player].side
	side:setAtb(runtimeConfig.ATB_MAX)
	assert(record.battle:requestSkill(side, 2))
end

local function checkPause(player, record, phase)
	assert(record.battle.state == phase and service:requestPause(player), "Pause rejeitado em " .. phase)
	waitUntil(function()
		local row = snapshot(player)
		return row.paused and row.hudPaused
	end, "Pause não replicou em " .. phase)
	local before = snapshot(player)
	task.wait(0.22)
	local after = snapshot(player)
	assert(before.attacks == after.attacks and before.pending == after.pending and record.battle.state == phase,
		"apresentação avançou em " .. phase)
	assert(service:requestPause(player), "Resume rejeitado")
	waitUntil(function()
		local row = snapshot(player)
		return not row.paused and not row.hudPaused
	end, "Resume não replicou em " .. phase)
end

local function tornDown(player, reason)
	waitUntil(function()
		local row = snapshot(player)
		return row.reason == reason and not row.stage and not row.active and row.camera == "inactive"
	end, "teardown incompleto para " .. reason)
	assert(not service:hasActiveSession(player) and #workspace.ActiveArenas:GetChildren() == 0, "arena/sessão residual")
end

local ok, result = xpcall(function()
	waitUntil(function()
		local joined = players:GetPlayers()
		return #joined == 2 and listening[joined[1]] and listening[joined[2]]
			and joined[1].Character and joined[2].Character
	end, "dois clientes reais não ficaram prontos", 90)
	local first, second = table.unpack(players:GetPlayers())
	local pve = start(first)
	enterAttack(first, pve)
	checkPause(first, pve, "PREPARE")
	waitUntil(function() return pve.battle.state == "ATTACK" end, "ATTACK ausente")
	checkPause(first, pve, "ATTACK")
	waitUntil(function() return pve.battle.state == "RETURN" end, "RETURN ausente")
	checkPause(first, pve, "RETURN")
	assert(service:requestQuit(first))
	tornDown(first, "quit")

	local pvp = start(first, second)
	waitUntil(function() return snapshot(second).stage end, "segundo cliente não abriu o palco")
	local firstBefore, secondBefore = snapshot(first), snapshot(second)
	enterAttack(first, pvp)
	waitUntil(function() return pvp.battle.state == "ATTACK" end, "ATTACK PvP ausente")
	assert(not service:requestPause(first) and not service:requestPause(second))
	waitUntil(function()
		local a, b = snapshot(first), snapshot(second)
		return a.attacks == firstBefore.attacks + 1 and b.attacks == secondBefore.attacks + 1 and not a.paused and not b.paused
	end, "dois clientes não observaram o mesmo ataque PvP")
	second:Kick("Studio QA disconnect")
	tornDown(first, "disconnect")
	local restarted = start(first)
	assert(restarted ~= pvp and snapshot(first).generation > firstBefore.generation)
	assert(service:requestQuit(first))
	tornDown(first, "quit")
	return "COMBAT_INTERRUPTIONS_MULTIPLAYER_QA_PASSED"
end, debug.traceback)
print(result)
test:EndTest(if ok then { result = result } else { error = result })
