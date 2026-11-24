-- StudioTestService QA. Install this source in a temporary Script in ServerScriptService
-- and a temporary LocalScript in StarterPlayerScripts. Disable the original
-- StarterPlayerScripts.TS.main and ServerScriptService.TS.NetworkBootstrap
-- so the probe can start its own controllers and battle service.
-- Run Server & Clients with two players, or call
-- StudioTestService:ExecuteMultiplayerTestAsync(2, "L5.1 QA") from Edit.
-- Remove both scripts and restore the original Enabled values afterward.
local run = game:GetService("RunService")
local test = game:GetService("StudioTestService")
if not run:IsStudio() then return end
local players = game:GetService("Players")
local storage = game:GetService("ReplicatedStorage")
local protocol = require(storage.TS.Remotes)
local remote = if run:IsServer() then require(game.ServerScriptService.TS.Services.RemoteService).RemoteService.new() else nil
local remotes = storage:WaitForChild(protocol.REMOTES_FOLDER_NAME)
local transition = remotes:WaitForChild(protocol.REMOTE_NAMES.BattleTransition)
local started = remotes:WaitForChild(protocol.REMOTE_NAMES.BattleStarted)
local ended = remotes:WaitForChild(protocol.REMOTE_NAMES.BattleEnded)
local report

if run:IsClient() then
	report = storage:WaitForChild("BattleIntroQAReport")
	local player = players.LocalPlayer
	local gui = player:WaitForChild("PlayerGui")
	local camera = workspace.CurrentCamera
	local controllers = player.PlayerScripts:WaitForChild("TS"):WaitForChild("Controllers")
	local combat = require(controllers.CombatController).CombatController
	local grounding = require(controllers.CombatFighterGrounding)
	local partIcles = require(storage.Part_Icles)
	local hudClass = require(controllers.BattleHUD).BattleHUD
	local frames = run.PreRender
	local combatController = combat.new()
	combatController:start()
	local hudController = hudClass.new(combatController)
	hudController:start()
	local hud = gui:WaitForChild("BattleHUD")
	local state
	local seen
	local rendered = 0
	local function sampleSpawns(state, now)
		local stage = workspace:FindFirstChild("ClientBattleStage_" .. state.instanceId)
		local arena = workspace.ActiveArenas:FindFirstChild(state.instanceId)
		if not stage or not arena then return end
		local sideLetter = if state.side == 1 then "A" else "B"
		local side = arena.Arena_bases["Time " .. sideLetter]
		local function checkFrame(actual, anchor)
			local frame = grounding.computeAnchorTopSurfaceCFrame(anchor)
			return frame:ToObjectSpace(actual):FuzzyEq(CFrame.identity, 0.005)
		end
		for _, row in state.spawns do
			local model = stage:FindFirstChild(row.name)
			if not model then continue end
			local body = row.body
			if not body then
				for _, part in model:GetDescendants() do
					if part:IsA("BasePart") and part.Transparency < 0.95 then body = part; break end
				end
				assert(body, "missing visible body: " .. row.name)
				row.body = body
				row.original = body.Transparency
				local root = model.PrimaryPart
				row.offset = grounding.resolveFighterGroundContact(model, root, model:FindFirstChild("Stand")).offset
			end
			local modifier = body.LocalTransparencyModifier
			row.baseChanged = row.baseChanged or body.Transparency ~= row.original
			local holder = model:FindFirstChild("BattleSpawnHighlight")
			local highlight = holder and holder:FindFirstChildOfClass("Highlight")
			if not row.own then
				row.opposingChanged = row.opposingChanged or modifier ~= 0 or holder ~= nil
				continue
			end
			if modifier == 1 then row.hidden = true end
			if highlight and not row.endAt then
				row.startAt = row.startAt or now
				row.correctAdornee = (row.correctAdornee ~= false) and highlight.Adornee == model and highlight.Enabled
				row.minFill = math.min(row.minFill or 1, highlight.FillTransparency)
				row.maxFill = math.max(row.maxFill or 0, highlight.FillTransparency)
				row.faded = row.faded or modifier > 0 and modifier < 1
			end
			if highlight and modifier > 0 and not row.endAt then
				local anchorName = if row.slot == 0 then "Current_Fighter_" .. sideLetter else "AoE_Target_" .. sideLetter .. "_" .. row.slot
				local anchor = side[anchorName]
				local foot = model.PrimaryPart.CFrame * CFrame.new(row.offset)
				row.feetAligned = (row.feetAligned ~= false) and checkFrame(foot, anchor)
			end
			for _, container in stage:GetChildren() do
				local clone = container.Name == "BattleSpawnVfx" and container:FindFirstChild("spawnvfx")
				local source = clone and clone:FindFirstChild("Highligthspawn")
				local adornee = source and source:FindFirstChild("Adornee")
				if not adornee or adornee.Value ~= model then continue end
				local anchorName = if row.slot == 0 then "Current_Fighter_" .. sideLetter else "AoE_Target_" .. sideLetter .. "_" .. row.slot
				row.vfxAligned = (row.vfxAligned ~= false) and checkFrame(clone:GetPivot(), side[anchorName])
				row.placeholderSeen = row.placeholderSeen or clone:FindFirstChild("Fighter_placeHolder") ~= nil
				row.retainedTarget = clone.gelu.modevents.HOMING_TARGET.Value == clone.coloquenotorsodosfigthers
					and clone.gelu.AccelTarget.Value == clone.coloquenotorsodosfigthers
					and clone.gelu.modevents.EFEITO_IMPACTO.Value == clone.b1["sange bloco"]
				row.emitters = row.emitters or {}
				for _, emitted in partIcles.ActiveEmits do
					local emitter = emitted._sourceItem
					local visual = emitted.VisualPart
					if emitter and visual and visual:IsDescendantOf(container) then
						row.emitters[emitter.Name] = true
						if row.endAt then row.particleTail = true end
					end
				end
			end
			if row.startAt and modifier == 0 and not row.endAt then
				row.endAt = now
				local anchorName = if row.slot == 0 then "Current_Fighter_" .. sideLetter
					elseif row.slot == 1 then "Waiting_Fighter_" .. sideLetter else "Waiting_Fighter_" .. sideLetter .. "_2"
				row.home = checkFrame(model.PrimaryPart.CFrame * CFrame.new(row.offset), side[anchorName])
			end
		end
	end
	local function atPose(pose)
		return pose:ToObjectSpace(camera.CFrame):FuzzyEq(CFrame.identity, 0.001)
	end
	-- The observer's PreRender connection can run before the production
	-- controller. Timestamp the label write in its own frame.
	gui.ChildAdded:Connect(function(overlay)
		if overlay.Name ~= "BattleIntroOverlay" then return end
		local countdown = overlay:WaitForChild("Countdown")
		countdown:GetPropertyChangedSignal("Text"):Connect(function()
			local label = countdown.Text
			if not state or not seen or seen[label] then return end
			local now = workspace:GetServerTimeNow()
			seen[label] = now
			if label == "GO!" then
				report:FireServer("go", state.id, now)
			else
				for _, widget in hud:GetDescendants() do
					if widget.Name == "AtbValue" and widget:IsA("TextLabel") and widget.Text ~= "0.0 / 10" then
						state.earlyCombat = true
					end
				end
			end
		end)
	end)
	game:GetService("LogService").MessageOut:Connect(function(message, level)
		if level == Enum.MessageType.MessageError then report:FireServer("diagnostic", 0, message) end
	end)
	transition.OnClientEvent:Connect(function(payload)
		report:FireServer("diagnostic", payload.id, "received " .. payload.phase)
		if payload.phase == "cover" then
			local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
			if not root or not camera then
				report:FireServer("diagnostic", payload.id, "missing root or camera at cover")
				return
			end
			state = { id = payload.id, origin = root.Position, character = player.Character, cameraType = camera.CameraType, subject = camera.CameraSubject,
				fov = camera.FieldOfView, fovMode = camera.FieldOfViewMode }
			seen = {}
			local before = rendered
			task.delay(0.5, function()
				local overlay = gui:FindFirstChild("BattleIntroOverlay")
				report:FireServer("diagnostic", payload.id,
					`frames={rendered - before} viewport={camera.ViewportSize} overlay={overlay ~= nil}`)
			end)
		elseif state and state.id == payload.id and payload.phase == "schedule" then
			state.arcAt, state.goAt = payload.arcAt, payload.goAt
			state.opening = camera.CFrame
			state.destination = combatController:getLastAppliedCameraFrame().cframe
			local anchor = combatController:getActiveCameraPart()
			state.anchor = anchor.Name
			local bases = anchor.Parent.Parent
			local clone = bases.Parent
			assert(clone:IsA("Model") and clone.Parent == workspace.ActiveArenas and clone.Name == state.instanceId)
			assert(bases["Time A"].Current_Fighter_A.Current_Figther_A_vfx_green
				and bases["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red
				and storage.Part_Icles and player.PlayerScripts.ArenaAmbientVFX)
			local opposingFolder = bases[if state.side == 1 then "Time B" else "Time A"]
			local opposingCamera = opposingFolder:FindFirstChild(if state.side == 1 then "Camera_B" else "Camera_A")
			local fighterA = bases["Time A"].Current_Fighter_A
			local fighterB = bases["Time B"].Current_Fighter_B
			local center = fighterA.Position:Lerp(fighterB.Position, 0.5)
			local up = fighterA.CFrame.UpVector
			local function horizDir(pos)
				local delta = pos - center
				return (delta - up * delta:Dot(up)).Unit
			end
			state.opposingStart = opposingCamera ~= nil
				and horizDir(camera.CFrame.Position):Dot(horizDir(opposingCamera.Position)) > 0.85
				and horizDir(camera.CFrame.Position):Dot(horizDir(state.destination.Position)) < -0.85
		end
	end)
	report.OnClientEvent:Connect(function(action, id)
		if action == "expectRespawn" and state then
			state.respawn = true
		elseif action == "skill" and state and state.id == id then
			local deadline = os.clock() + 5
			repeat
				task.wait()
				local active = hudController:getActiveFighterForSide(0)
				if active and not hudController.preparing and hudController.battleState == "IDLE"
					and hudController.playerTargetAtb >= active.slotCosts[1] then
					hudController:handleSkillButtonClicked(1)
					return
				end
			until os.clock() >= deadline
			report:FireServer("diagnostic", id, "HUD did not allow S1 after release")
		end
	end)
	started.OnClientEvent:Connect(function(payload)
		if state and state.id == payload.transitionId then
			state.side = table.find(payload.arena.physicalSides, payload.sides[1])
			state.instanceId = payload.arena.instanceId
			state.spawns = {}
			local bench = 0
			for _, fighter in payload.fighters do
				local own = fighter.sideId == payload.sides[1]
				if own and not fighter.active then bench += 1 end
				table.insert(state.spawns, {
					name = fighter.targetId .. "_" .. fighter.fighterId,
					own = own,
					slot = if fighter.active then 0 else bench,
				})
			end
		end
	end)
	for _, name in {protocol.REMOTE_NAMES.AtbSync, protocol.REMOTE_NAMES.AttackStarted} do
		remotes[name].OnClientEvent:Connect(function()
			if state and (not state.goAt or workspace:GetServerTimeNow() < state.goAt) then
				state.earlyCombat = true
			end
		end)
	end
	remotes[protocol.REMOTE_NAMES.StateChanged].OnClientEvent:Connect(function(payload)
		if state and payload.battleReleased == state.id then
			local id = state.id
			task.defer(function()
				if state and state.id == id then
					report:FireServer("released", id, {
						state = payload.state, hud = hudController.battleState,
						preparing = hudController.preparing, at = workspace:GetServerTimeNow(),
					})
				end
			end)
		end
	end)
	frames:Connect(function()
		rendered += 1
		if not state then return end
		local now = workspace:GetServerTimeNow()
		if state.spawns then sampleSpawns(state, now) end
		local overlay = gui:FindFirstChild("BattleIntroOverlay")
		local covered = overlay and overlay.Enabled and overlay.Curtain.Visible and overlay.Curtain.BackgroundTransparency == 0
		local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
		if root and (root.Position - state.origin).Magnitude > 50 then
			if state.coveredAtTeleport == nil then state.coveredAtTeleport = covered == true end
			if not covered and camera.CameraType ~= Enum.CameraType.Scriptable then state.flash = true end
		end
		if overlay and overlay.Enabled and overlay.Countdown.Visible then
			local label = overlay.Countdown.Text
			if label == "2" then
				state.midArc = state.midArc or (not atPose(state.opening) and not atPose(state.destination))
			elseif label == "1" and now < state.goAt and atPose(state.destination) then
				state.settled = state.settled or now
			elseif label == "GO!" and not atPose(state.destination) then
				state.movedAtGo = true
			end
		end
	end)
	ended.OnClientEvent:Connect(function(payload)
		local previous = state
		local labels = seen
		if not previous or previous.id ~= payload.transitionId then return end
		local deadline = os.clock() + 3
		repeat task.wait() until not gui:FindFirstChild("BattleIntroOverlay") or os.clock() >= deadline
		local expectedSubject = previous.subject
		if previous.respawn then
			repeat task.wait() until (player.Character and player.Character ~= previous.character
				and player.Character:FindFirstChildOfClass("Humanoid")) or os.clock() >= deadline
			expectedSubject = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		end
		local restored = expectedSubject ~= nil and camera.CameraType == previous.cameraType and camera.CameraSubject == expectedSubject
			and camera.FieldOfView == previous.fov and camera.FieldOfViewMode == previous.fovMode
		local stageGone = not previous.instanceId or not workspace:FindFirstChild("ClientBattleStage_" .. previous.instanceId)
		local spawnResidue = false
		for _, emit in partIcles.ActiveEmits do
			local source = emit._sourceItem
			if source and (source.Name == "Highligthspawn" or source.Name == "growing wind" or source.Name == "gelu") then
				spawnResidue = true
				break
			end
		end
		for _, row in previous.spawns or {} do row.body = nil; row.offset = nil end
		report:FireServer("end", previous.id, {
			reason = payload.reason, restored = restored, overlayGone = gui:FindFirstChild("BattleIntroOverlay") == nil,
			hudGone = not hud.Enabled, covered = previous.coveredAtTeleport, flash = previous.flash, early = previous.earlyCombat,
			side = previous.side, anchor = previous.anchor, opposingStart = previous.opposingStart, arcAt = previous.arcAt,
			goAt = previous.goAt, midArc = previous.midArc, settled = previous.settled, labels = labels,
			movedAtGo = previous.movedAtGo,
			spawns = previous.spawns, stageGone = stageGone, spawnResidue = spawnResidue,
		})
		if state == previous then state = nil end
	end)
	if not game:IsLoaded() then game.Loaded:Wait() end
	local character = player.Character or player.CharacterAdded:Wait()
	character:WaitForChild("HumanoidRootPart")
	report:FireServer("diagnostic", 0, "controllers ready; waiting for viewport " .. tostring(camera.ViewportSize))
	local activeFrames = 0
	repeat
		local dt = frames:Wait()
		activeFrames = if camera.ViewportSize.X > 1 and camera.ViewportSize.Y > 1 and dt < 0.2 then activeFrames + 1 else 0
	until activeFrames >= 3
	report:FireServer("listening")
	return
end

report = Instance.new("RemoteEvent")
report.Name = "BattleIntroQAReport"
report.Parent = storage
local listening, reports, goFrames, released, trace = {}, {}, {}, {}, {}
report.OnServerEvent:Connect(function(player, kind, id, value)
	if kind == "listening" then listening[player] = true end
	if kind == "diagnostic" then table.insert(trace, `{player.Name} {value}`) end
	if kind == "go" then
		goFrames[id] = goFrames[id] or {}
		goFrames[id][player] = value
	end
	if kind == "released" then
		released[id] = released[id] or {}
		released[id][player] = value
	end
	if kind == "end" then
		reports[id] = reports[id] or {}
		reports[id][player] = value
	end
end)

local function waitUntil(check, message, timeout)
	local deadline = os.clock() + (timeout or 15)
	repeat
		if check() then return end
		task.wait()
	until os.clock() >= deadline
	error(message)
end

local ok, result = xpcall(function()
	-- Studio launches two OS processes after the server starts. Measure controller
	-- initialization from the arrival of the participants, as matchmaking does.
	while #players:GetPlayers() < 2 do players.PlayerAdded:Wait() end
	waitUntil(function()
		local joined = players:GetPlayers()
		return #joined == 2 and listening[joined[1]] and listening[joined[2]]
			and joined[1].Character and joined[2].Character
	end, "two clients did not initialize", 60)
	local a, b = table.unpack(players:GetPlayers())
	local services = game.ServerScriptService.TS.Services
	local registry = require(services.ArenaRegistry).ArenaRegistry.new()
	registry:start()
	game:GetService("LogService").MessageOut:Connect(function(message, level)
		if (level == Enum.MessageType.MessageWarning or level == Enum.MessageType.MessageError) and #trace < 40 then
			table.insert(trace, message)
		end
	end)
	local realBind = remote.transition.bind
	-- Gate the second client after its real readiness acknowledgement.
	-- This lets the live test cover a slow client and a loading timeout.
	local loadingPolicy, slowSince
	remote.transition.bind = function(receive)
		realBind(function(player, id, ack)
			table.insert(trace, `{player.Name} {id} {ack}`)
			if player == b and ack == "ready" and loadingPolicy then
				if loadingPolicy == "delay" then
					slowSince = workspace:GetServerTimeNow()
					task.delay(1.25, receive, player, id, ack)
				end
				return
			end
			receive(player, id, ack)
		end)
	end
	local realSend = remote.transition.send
	local schedules = {}
	remote.transition.send = function(player, payload)
		table.insert(trace, `{player.Name} {payload.id} {payload.phase}`)
		if payload.phase == "schedule" then schedules[payload.id] = payload end
		realSend(player, payload)
	end
	local service = require(services.BattleSessionService).BattleSessionService.new(remote, nil, nil, registry)
	service:start()
	local dummy = require(game.ServerScriptService.TS.Dev.DummyFighters)
	local rng = function() return 0.5 end
	local function start(first, second, encounter, finished)
		assert(service:createSession(first, second, dummy.createRealFighterSide("jotaro", rng), dummy.createRealFighterSide("anubis", rng),
			rng, if second then "PVP" else "PVE", finished, encounter), "session create failed")
	end
	local function checkEnd(id, player, reason)
		waitUntil(function() return reports[id] and reports[id][player] end, "missing client teardown " .. id)
		local row = reports[id][player]
		assert(row.reason == reason and row.restored and row.hudGone and row.overlayGone and not row.flash and not row.early,
			"bad teardown: " .. game:GetService("HttpService"):JSONEncode(row))
		assert(row.covered, "cage teleport not covered")
		assert(row.stageGone and not row.spawnResidue, "spawn resources survived teardown")
		return row
	end

	loadingPolicy = "delay"
	start(a, b)
	waitUntil(function() return schedules[0] end, "PvP countdown was not scheduled")
	assert(slowSince and schedules[0].arcAt - slowSince > 2, "server did not wait for the slower client")
	assert(service:getSideAtb(a, 0) == 0 and service:getSideAtb(a, 1) == 0, "server ATB before GO")
	waitUntil(function() return goFrames[0] and goFrames[0][a] and goFrames[0][b] end, "one client missed GO")
	local skew = math.abs(goFrames[0][a] - goFrames[0][b])
	assert(skew < 0.2, "GO skew " .. skew)
	waitUntil(function() return released[0] and released[0][a] and released[0][b] end, "one client missed the server release")
	local record = service.playerSessions[a].session
	assert(service:isRunning(record) and record.battle.state == "IDLE", "server did not release into IDLE")
	for _, row in released[0] do
		assert(row.state == "IDLE" and row.hud == "IDLE" and not row.preparing and row.at >= schedules[0].goAt,
			"client did not enter IDLE after authoritative GO")
	end
	waitUntil(function() return service:getSideAtb(a, 0) > 0 end, "ATB did not start after GO")
	local attacks = {}
	local hits = 0
	local disconnectAttack = record.battle.events.attackStarted:connect(function(event) table.insert(attacks, event.attacker) end)
	local disconnectHit = record.battle.events.hitResolved:connect(function() hits += 1 end)
	for index, player in {a, b} do
		local side = service.playerSessions[player].side
		side:setAtb(require(storage.TS.Config).ATB_MAX)
		report:FireClient(player, "skill", 0)
		waitUntil(function()
			return attacks[index] == side:getActiveFighter() and hits >= index and record.battle.state == "IDLE"
		end, "real client could not use S1 after GO")
	end
	disconnectAttack()
	disconnectHit()
	service:requestQuit(a)
	local rowA, rowB = checkEnd(0, a, "quit"), checkEnd(0, b, "quit")
	assert(rowA.side == 1 and rowB.side == 2 and rowA.goAt == rowB.goAt, "PvP side or timestamp mismatch")
	for _, row in {rowA, rowB} do
		assert(row.anchor == (if row.side == 1 then "Camera_A" else "Camera_B") and row.opposingStart, "wrong opening camera")
		assert(row.arcAt == rowA.arcAt and math.abs(row.goAt - row.arcAt - 3) < 0.001, "countdown clock mismatch")
		assert(row.midArc and row.settled and row.settled < row.goAt, "camera did not move with 2 and settle during 1")
		assert(not row.movedAtGo, "camera moved at GO")
		local own = {}
		for _, fighter in row.spawns do
			assert(not fighter.baseChanged and not fighter.opposingChanged, "opposing fighter or base appearance changed")
			if not fighter.own then continue end
			assert(fighter.hidden and fighter.faded and fighter.correctAdornee and fighter.minFill < 0.08 and fighter.maxFill > 0.8,
				"missing local fade or animated Qwinkle Highlight: " .. game:GetService("HttpService"):JSONEncode(fighter))
			assert(fighter.vfxAligned and fighter.feetAligned and fighter.home and not fighter.placeholderSeen,
				"incorrect VFX, feet or bench placement: " .. game:GetService("HttpService"):JSONEncode(fighter))
			local emitters = fighter.emitters or {}
			assert(fighter.retainedTarget and emitters["growing wind"] and emitters.b1 and emitters.gelu and (emitters.Part or emitters.Sound)
				and emitters["sange bloco"] and fighter.particleTail,
				"incomplete authored VFX: " .. game:GetService("HttpService"):JSONEncode(fighter))
			assert(math.abs(fighter.endAt - fighter.startAt - 1.5) <= 0.12 and fighter.endAt <= row.goAt - 0.15, "materialization timing")
			own[fighter.slot] = fighter
		end
		assert(own[0] and own[1] and own[2], "missing local fighter slots")
		assert(math.abs(own[1].startAt - own[0].startAt - 0.75) < 0.12 and math.abs(own[2].startAt - own[1].startAt - 0.35) < 0.12,
			"incorrect stagger")
		local previous = row.arcAt
		for _, label in {"3", "2", "1", "GO!"} do
			local observed = row.labels[label]
			assert(observed and observed >= previous, "missing/out-of-order " .. label .. " on " .. row.anchor
				.. ": " .. game:GetService("HttpService"):JSONEncode(row.labels))
			previous = observed
		end
	end

	loadingPolicy = "timeout"
	start(b, a)
	checkEnd(1, a, "timeout")
	checkEnd(1, b, "timeout")
	assert(not schedules[1], "timed-out prep scheduled a GO")

	loadingPolicy = nil
	start(a, nil, "BOSS")
	waitUntil(function() return schedules[2] and workspace:GetServerTimeNow() >= schedules[2].arcAt + 0.3 end, "Boss arc did not start")
	service:requestQuit(a)
	checkEnd(2, a, "quit")
	assert(not goFrames[2], "Boss quit during arc reached GO")

	start(a, b)
	waitUntil(function()
		return schedules[3] and workspace:GetServerTimeNow() >= schedules[3].goAt - 2
	end, "PvP countdown did not start")
	-- Disconnect the test player at the server clock boundary. Closing a whole
	-- Studio client process can take longer than the remaining countdown.
	local removedAt
	local removing = players.PlayerRemoving:Connect(function(player)
		if player == b then removedAt = workspace:GetServerTimeNow() end
	end)
	b:Kick("L4.1.2 QA disconnect")
	checkEnd(3, a, "disconnect")
	removing:Disconnect()
	assert(removedAt and removedAt < schedules[3].goAt, "test disconnect arrived after GO")
	assert(not goFrames[3], "PvP disconnect during countdown reached GO")
	start(a, nil)
	waitUntil(function() return schedules[4] and workspace:GetServerTimeNow() >= schedules[4].arcAt - 0.2 end, "missing fade")
	service:requestQuit(a)
	checkEnd(4, a, "quit")
	assert(not goFrames[4], "quit during fade reached GO")
	local release = require(services.BattleMovement).freezeBattleMovement(a, a.Character.Humanoid, function()
		service:destroySessionForPlayer(a)
	end)
	start(a, nil, nil, release)
	waitUntil(function() return schedules[5] and workspace:GetServerTimeNow() >= schedules[5].arcAt + 1 end, "missing respawn countdown")
	report:FireClient(a, "expectRespawn")
	a:LoadCharacterAsync()
	checkEnd(5, a, "disconnect")
	assert(not goFrames[5] and not service:hasActiveSession(a) and #workspace.ActiveArenas:GetChildren() == 0,
		"respawn left battle running")
	return {result = "L5_1_MULTIPLAYER_QA_PASSED", skewSeconds = skew, first = rowA, second = rowB,
		authoritativeReleases = 2, skillRequestsWithHits = hits, trace = trace}
end, debug.traceback)
if ok then print(result.result, result.skewSeconds) else warn(result) end
test:EndTest(if ok then result else {error = result, trace = trace})
