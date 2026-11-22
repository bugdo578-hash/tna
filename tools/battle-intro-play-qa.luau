-- StudioTestService QA. Install this source in a temporary Script in ServerScriptService
-- and a temporary LocalScript in StarterPlayerScripts. Disable the original
-- StarterPlayerScripts.TS.main during this test so the probe can start these controllers.
-- Run Server & Clients with two players, or call
-- StudioTestService:ExecuteMultiplayerTestAsync(2, "L4.1.2 QA") from Edit.
-- Remove both scripts and restore the original main's Enabled value afterward.
local run = game:GetService("RunService")
local test = game:GetService("StudioTestService")
if not run:IsStudio() then return end
local players = game:GetService("Players")
local storage = game:GetService("ReplicatedStorage")
local protocol = require(storage.TS.Remotes)
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
	local hudClass = require(controllers.BattleHUD).BattleHUD
	local frames = run.PreRender
	local combatController = combat.new()
	combatController:start()
	hudClass.new(combatController):start()
	local hud = gui:WaitForChild("BattleHUD")
	local state
	local seen
	local rendered = 0
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
			local own = anchor.Parent:FindFirstChild(if state.side == 1 then "Current_Fighter_A" else "Current_Fighter_B")
			state.behind = own.CFrame:PointToObjectSpace(camera.CFrame.Position).Z > 0
		end
	end)
	report.OnClientEvent:Connect(function(action)
		if action == "expectRespawn" and state then
			state.respawn = true
		end
	end)
	started.OnClientEvent:Connect(function(payload)
		if state and state.id == payload.transitionId then
			state.side = table.find(payload.arena.physicalSides, payload.sides[1])
			state.instanceId = payload.arena.instanceId
		end
	end)
	for _, name in {protocol.REMOTE_NAMES.AtbSync, protocol.REMOTE_NAMES.AttackStarted} do
		remotes[name].OnClientEvent:Connect(function()
			if state and (not state.goAt or workspace:GetServerTimeNow() < state.goAt) then
				state.earlyCombat = true
			end
		end)
	end
	frames:Connect(function()
		rendered += 1
		if not state then return end
		local now = workspace:GetServerTimeNow()
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
		report:FireServer("end", previous.id, {
			reason = payload.reason, restored = restored, overlayGone = gui:FindFirstChild("BattleIntroOverlay") == nil,
			hudGone = not hud.Enabled, covered = previous.coveredAtTeleport, flash = previous.flash, early = previous.earlyCombat,
			side = previous.side, anchor = previous.anchor, behind = previous.behind, arcAt = previous.arcAt,
			goAt = previous.goAt, midArc = previous.midArc, settled = previous.settled, labels = labels,
			movedAtGo = previous.movedAtGo,
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
local listening, reports, goFrames, trace = {}, {}, {}, {}
report.OnServerEvent:Connect(function(player, kind, id, value)
	if kind == "listening" then listening[player] = true end
	if kind == "diagnostic" then table.insert(trace, `{player.Name} {value}`) end
	if kind == "go" then
		goFrames[id] = goFrames[id] or {}
		goFrames[id][player] = value
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
	end, "two clients did not initialize", 30)
	local a, b = table.unpack(players:GetPlayers())
	local services = game.ServerScriptService.TS.Services
	local registry = require(services.ArenaRegistry).ArenaRegistry.new()
	registry:start()
	local remote = require(services.RemoteService).RemoteService.new()
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
	waitUntil(function() return service:getSideAtb(a, 0) > 0 end, "ATB did not start after GO")
	service:requestQuit(a)
	local rowA, rowB = checkEnd(0, a, "quit"), checkEnd(0, b, "quit")
	assert(rowA.side == 1 and rowB.side == 2 and rowA.goAt == rowB.goAt, "PvP side or timestamp mismatch")
	for _, row in {rowA, rowB} do
		assert(row.anchor == (if row.side == 1 then "Camera_A" else "Camera_B") and row.behind, "wrong opening camera")
		assert(row.arcAt == rowA.arcAt and math.abs(row.goAt - row.arcAt - 3) < 0.001, "countdown clock mismatch")
		assert(row.midArc and row.settled and row.settled < row.goAt, "camera did not move with 2 and settle during 1")
		assert(not row.movedAtGo, "camera moved at GO")
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
	return {result = "L4_1_2_MULTIPLAYER_QA_PASSED", skewSeconds = skew, first = rowA, second = rowB, trace = trace}
end, debug.traceback)
if ok then print(result.result, result.skewSeconds) else warn(result) end
test:EndTest(if ok then result else {error = result, trace = trace})
