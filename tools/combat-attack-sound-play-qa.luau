-- StudioTestService. Instale cópias temporárias como em battle-intro-play-qa e execute com um cliente.
local run = game:GetService("RunService")
assert(run:IsStudio())
local players = game:GetService("Players")
local storage = game:GetService("ReplicatedStorage")
local test = game:GetService("StudioTestService")
local protocol = require(storage:WaitForChild("TS"):WaitForChild("Remotes"))
local probeName = "CombatAttackSoundQA"

local function waitUntil(predicate, label, timeout)
	local deadline = os.clock() + (timeout or 16)
	repeat
		if predicate() then return end
		task.wait()
	until os.clock() >= deadline
	error(label)
end

if run:IsClient() then
	local player = players.LocalPlayer
	local controllers = player:WaitForChild("PlayerScripts"):WaitForChild("TS"):WaitForChild("Controllers")
	local probe = storage:WaitForChild(probeName)
	local template = probe:WaitForChild("AttackAudio")
	local source = template:FindFirstChildOfClass("Sound")
	local clip = source:FindFirstChild("RenderTemplate") or source
	game:GetService("ContentProvider"):PreloadAsync({clip})
	assert(clip:IsA("Sound") and clip.IsLoaded and clip.TimeLength > 0, "asset de áudio existente não carregou")
	local playing, playCount, resultReason
	local partIcles = require(storage.Part_Icles)
	local vfx = require(controllers.VFXController).VFXController.new()
	local combat = require(controllers.CombatController).CombatController.new(vfx)
	local hud = require(controllers.BattleHUD).BattleHUD.new(combat)
	local originalStart = combat.startAttackPresentation
	combat.startAttackPresentation = function(self, attack)
		originalStart(self, attack)
		self.vfxBridge:emitResolvedBattleVfx({instance = template, key = "qa-attack-audio"}, attack.attacker.rootPart, nil, true)
	end
	combat:start()
	hud:start()
	local remotes = storage:WaitForChild(protocol.REMOTES_FOLDER_NAME)
	remotes[protocol.REMOTE_NAMES.BattleEnded].OnClientEvent:Connect(function(payload) resultReason = payload.reason end)
	probe.OnClientInvoke = function(action)
		local working = combat.battleVfxWorkingCopies["qa-attack-audio"]
		if working then
			for _, emission in partIcles.ActiveEmits do
				local emitted = emission.VisualPart
				if emission._sourceItem and emission._sourceItem:IsDescendantOf(working)
					and emitted and emitted:IsA("Sound") and emitted ~= playing then
					playing = emitted
					playCount = (playCount or 0) + 1
				end
			end
		end
		if action == "skill" then hud:handleSkillButtonClicked(2) end
		if action == "pause" then remotes[protocol.REMOTE_NAMES.RequestPause]:FireServer() end
		if action == "quit" then remotes[protocol.REMOTE_NAMES.RequestQuit]:FireServer() end
		return {
			active = hud.battleActive, idle = not hud.preparing and hud.battleState == "IDLE", atb = hud.playerTargetAtb,
			paused = combat.resources:isPaused(), reason = resultReason, stage = combat.stageFolder ~= nil,
			pos = playing and playing.TimePosition, length = playing and playing.TimeLength,
			playing = playing ~= nil and playing.IsPlaying, alive = playing ~= nil and playing.Parent ~= nil,
			count = playCount or 0, soundId = playing and playing.SoundId,
			host = playing and playing.Parent and playing.Parent:GetFullName(),
		}
	end
	repeat
		run.PreRender:Wait()
		local camera = workspace.CurrentCamera
	until camera and camera.ViewportSize.X > 1 and camera.ViewportSize.Y > 1
	local character = player.Character or player.CharacterAdded:Wait()
	character:WaitForChild("HumanoidRootPart")
	probe.Ready:FireServer(clip.SoundId)
	return
end

local services = game.ServerScriptService.TS.Services
local config = require(storage.TS.Config)
local dummy = require(game.ServerScriptService.TS.Dev.DummyFighters)
local remote = require(services.RemoteService).RemoteService.new()
local registry = require(services.ArenaRegistry).ArenaRegistry.new()
registry:start()
local service = require(services.BattleSessionService).BattleSessionService.new(remote, nil, nil, registry)
service:start()
local probe = Instance.new("RemoteFunction")
probe.Name = probeName
local ready = Instance.new("RemoteEvent", probe)
ready.Name = "Ready"
local template = Instance.new("Part", probe)
template.Name = "AttackAudio"
template.Transparency = 1
template.Anchored = true
template.CanCollide = false
local source = workspace["Barragem SP"].ora
assert(source:IsA("Sound") and source.SoundId ~= "")
local copy = source:Clone()
copy.Looped = true
copy:SetAttribute("Looped", true)
copy:SetAttribute("EmitDelay", 0)
copy.Parent = template
local player, loadedAsset
ready.OnServerEvent:Connect(function(sender, id) player, loadedAsset = sender, id end)
probe.Parent = storage

local ok, result = xpcall(function()
	waitUntil(function() return player ~= nil end, "cliente de áudio não iniciou", 90)
	assert(loadedAsset == (source:FindFirstChild("RenderTemplate") or source).SoundId)
	local checks = {}
	local rng = function() return 0.5 end
	for round, outcome in {"quit", "victory"} do
		local attacker = dummy.createRealFighterSide("jotaro", rng)
		local target = dummy.createRealFighterSide("anubis", rng)
		assert(service:createSession(player, nil, attacker, target, rng, "PVE"))
		local session = service.playerSessions[player].session
		waitUntil(function()
			local row = probe:InvokeClient(player)
			return service:isRunning(session) and row.stage and row.idle
		end, "PvE não chegou a IDLE")
		attacker:setAtb(config.ATB_MAX)
		waitUntil(function() return probe:InvokeClient(player).atb >= config.ATB_MAX end, "ATB não replicou")
		probe:InvokeClient(player, "skill")
		waitUntil(function()
			local row = probe:InvokeClient(player)
			return row.playing and row.pos > 0.02 and row.count == round
		end, "Sound não tocou durante a habilidade")
		local beforePause = probe:InvokeClient(player, "pause")
		assert(beforePause.soundId == loadedAsset, "asset tocado difere do RenderTemplate existente")
		waitUntil(function()
			local row = probe:InvokeClient(player)
			return row.paused and session.paused and not row.playing
		end, "Pause não congelou o Sound")
		local pausedPhase = session.battle.state
		assert(pausedPhase == "ATTACK" or pausedPhase == "RETURN", "Pause ocorreu fora da habilidade")
		local frozen = probe:InvokeClient(player)
		task.wait(0.25)
		local held = probe:InvokeClient(player)
		assert(not frozen.playing and not held.playing and math.abs(held.pos - frozen.pos) <= 0.03,
			"TimePosition avançou em Pause " .. game:GetService("HttpService"):JSONEncode({before = beforePause, paused = frozen, held = held}))
		assert(held.pos >= beforePause.pos - 0.03 and held.pos > 0, "Pause zerou TimePosition")
		probe:InvokeClient(player, "pause")
		waitUntil(function()
			local row = probe:InvokeClient(player)
			return not row.paused and row.playing and row.pos > held.pos + 0.02 and row.count == round
		end, "Resume reiniciou ou não retomou o Sound")
		local resumed = probe:InvokeClient(player)
		if outcome == "quit" then
			probe:InvokeClient(player, "quit")
		else
			-- Injeta o resultado terminal no serviço para interromper a mesma cópia ainda tocando.
			session.battle.events.battleEnd:fire(attacker)
		end
		waitUntil(function()
			local row = probe:InvokeClient(player)
			return row.reason == outcome and not row.stage and not row.active and not row.alive and not row.playing
		end, "o Sound sobreviveu ao fim por " .. outcome)
		table.insert(checks, {outcome = outcome, phase = pausedPhase, duration = held.length,
			beforePause = beforePause.pos, paused = frozen.pos, held = held.pos, resumed = resumed.pos, starts = resumed.count})
	end
	return {result = "COMBAT_ATTACK_SOUND_PLAY_QA_PASSED", asset = loadedAsset, checks = checks}
end, debug.traceback)
test:EndTest(if ok then result else {error = result})
