-- Studio Play, Client. Exercises L2/L2.2 and the short L4.1.2 intro on cloned fixtures.
local run = game:GetService("RunService")
assert(run:IsStudio() and run:IsClient(), "Studio Client required")

local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local framing = require(ts.Controllers.CombatCameraFramingTests)
local fixtures = framing.cameraFramingTestFixtures
local config = require(game.ReplicatedStorage.TS.Config)
local landscape, square, portrait = Vector2.new(1920, 1080), Vector2.new(1024, 768), Vector2.new(414, 736)
local root = Instance.new("Folder")
local activeArenas = Instance.new("Folder", root)
activeArenas.Name = config.ACTIVE_ARENAS_FOLDER_NAME
local subject = Instance.new("Part", root)
local assets = fixtures.makeAssetsWithStandAndWeapon()
local clients = {}

local function makeClient(viewport)
	local camera = Instance.new("Camera")
	camera.CameraType = Enum.CameraType.Custom
	camera.CameraSubject = subject
	camera.CFrame = CFrame.new(5, 12, -20) * CFrame.Angles(0, 1, 0)
	camera.FieldOfViewMode = Enum.FieldOfViewMode.Diagonal
	camera.FieldOfView = 74
	local client = { camera = camera, original = camera.CFrame, viewport = viewport }
	client.controller = Combat.new(nil, assets, root, 0.2, function() return client.camera end, function() return client.viewport end)
	table.insert(clients, client)
	return client
end

local function assertPose(actual, expected)
	assert((actual.Position - expected.Position).Magnitude < 0.001, "position mismatch")
	assert((actual.LookVector - expected.LookVector).Magnitude < 0.0001, "look axis mismatch")
	assert((actual.UpVector - expected.UpVector).Magnitude < 0.0001, "up axis mismatch")
end

local function assertRestored(client)
	local camera = client.camera
	assert(camera.CameraType == Enum.CameraType.Custom and camera.CameraSubject == subject, "camera ownership not restored")
	assert(camera.FieldOfViewMode == Enum.FieldOfViewMode.Diagonal, "FOV mode not restored")
	assert(math.abs(camera.FieldOfView - 74) < 0.001, "FOV not restored")
	assertPose(camera.CFrame, client.original)
	assert(not client.controller:refreshCameraFraming(true), "teardown left camera active")
end

local function inspect(client)
	local camera = client.camera
	local frame = assert(client.controller:getLastAppliedCameraFrame(), "missing adaptive frame")
	assert(client.controller:getActiveCameraPart() == client.anchor, "wrong physical side or clone")
	assert(camera.CameraType == Enum.CameraType.Scriptable, "battle lost Scriptable")
	local t = math.clamp(((client.progress or 1) - 0.75) / 0.25, 0, 1)
	local expectedFov = frame.fieldOfView + 1.25 * (1 - t*t*(3 - 2*t))
	assert(camera.FieldOfViewMode == frame.fieldOfViewMode and math.abs(camera.FieldOfView - expectedFov) < 0.001,
		"arrival zoom or adaptive FOV mismatch")
	for _, fighter in client.fighters do
		local model = assert(client.controller:getFighterModel(fighter.targetId), "fighter missing")
		local bounds = fixtures.projectModel(model, camera.CFrame, camera.FieldOfView, client.viewport)
		assert(bounds.minDepth > 0.5 and bounds.minU >= 0 and bounds.maxU <= 1 and bounds.minV >= 0 and bounds.maxV <= 1,
			"fighter, Stand or weapon clipped: " .. fighter.targetId)
	end
	return frame
end

local function start(client, arena, mode, ownSide)
	client.anchor = if ownSide == 1 then arena.cameraA else arena.cameraB
	client.progress = 1
	client.own = if ownSide == 1 then arena.activeA else arena.activeB
	client.enemy = if ownSide == 1 then arena.activeB else arena.activeA
	local physical = { "physicalA", "physicalB" }
	client.fighters = fixtures.make3v3Fighters(physical[1], physical[2])
	client.controller:onBattleStarted({
		sides = { physical[ownSide], physical[3 - ownSide] },
		fighters = client.fighters,
		mode = mode,
		canPause = mode == "PVE",
		arena = { instanceId = arena.model.Name, arenaId = "Arena_01", physicalSides = physical },
	})
	local final = inspect(client)
	assertPose(client.camera.CFrame, final.cframe)
	assert(client.controller.cameraController:prepareIntro(ownSide - 1), "missing arc")
	client.progress = 0
	inspect(client)
	client.startPosition = client.camera.CFrame.Position
	local offset = final.cframe:PointToObjectSpace(client.camera.CFrame.Position)
	local center = client.own.Position:Lerp(client.enemy.Position, 0.5)
	assert(math.abs(offset.X) > 0.1 and offset.Y > 0.1, "intro needs lateral sweep and height")
	assert((client.camera.CFrame.Position - center).Magnitude > (final.cframe.Position - center).Magnitude,
		"opening must be farther from the fighters")
	local forward = (client.enemy.Position - client.own.Position).Unit
	assert((client.camera.CFrame.Position - client.own.Position):Dot(forward) < -1, "opening in front of own team")
	client.sweep = 0
	return final
end

local ok, failure = xpcall(function()
	assert(require(ts.Controllers.CombatCameraTests).runL2CameraTests(), "L2")
	assert(framing.runL2_2AdaptiveCameraTests(), "L2.2")
	local arena1 = fixtures.makeOpen3v3Arena(activeArenas, "L411_rotated", CFrame.new(180, 12, -90) * CFrame.Angles(0, math.rad(37), 0), 6)
	local arena2 = fixtures.makeOpen3v3Arena(activeArenas, "L411_other", CFrame.new(-200, 25, 120) * CFrame.Angles(0, math.rad(-80), 0), 6)
	local pve, pvpA, pvpB = makeClient(landscape), makeClient(square), makeClient(portrait)
	start(pve, arena1, "PVE", 1)
	start(pvpA, arena2, "PVP", 1)
	start(pvpB, arena2, "PVP", 2)

	local prior = {}
	for _, client in clients do prior[client] = client.camera.CFrame end
	for tick = 1, 60 do
		for _, client in clients do
			assert(client.controller.cameraController:setIntroProgress(tick / 60), "active camera lost")
			client.progress = tick / 60
			inspect(client)
			if tick == 30 and client ~= pve then
				local finish = client.controller:getLastAppliedCameraFrame().cframe.Position
				local chord = client.startPosition - finish
				local bow = client.camera.CFrame.Position - finish:Lerp(client.startPosition, 0.5)
				assert(bow.Magnitude > chord.Magnitude * 0.12, "midpoint does not curve smoothly along the arc")
			end
			local from, to = prior[client], client.camera.CFrame
			assert((from.LookVector - to.LookVector).Magnitude < 0.12, "abrupt orientation change")
			local center = (client.own.Position + client.enemy.Position) / 2
			local up = client.own.CFrame.UpVector
			local function bearing(pos)
				local delta = pos - center
				return (delta - up * delta:Dot(up)).Unit
			end
			client.sweep += bearing(from.Position):Angle(bearing(to.Position))
			assert(client.sweep < math.rad(89), "large orbit around the arena")
			prior[client] = to
		end
		if tick == 23 then
			pve.viewport = portrait
			assert(pve.controller:refreshCameraFraming(false), "resize refresh failed")
			local frame = inspect(pve)
			assert((pve.camera.CFrame.Position - frame.cframe.Position).Magnitude > 0.1, "resize ended the arc early")
			prior[pve] = pve.camera.CFrame
		end
	end
	for _, client in clients do
		local final = inspect(client).cframe
		assertPose(client.camera.CFrame, final)
		assert(client.controller.cameraController:setIntroProgress(1))
		assertPose(client.camera.CFrame, final)
	end

	-- Put a solid obstacle across the last part of the outward camera travel.
	-- The intro must shorten before it, preserving the authored destination.
	root.Name = "IntroQAClones"
	root.Parent = workspace
	start(pve, arena1, "PVE", 1)
	local opening = pve.camera.CFrame
	local wall = Instance.new("Part")
	wall.Anchored = true
	wall.Size = Vector3.new(3, 3, 3)
	wall.CFrame = opening
	wall.Parent = arena1.model
	assert(pve.controller:refreshCameraFraming(true))
	assert((opening.Position - pve.camera.CFrame.Position).Magnitude > 1.5, "camera entered obstacle")
	assert(pve.controller.cameraController:setIntroProgress(1))
	pve.progress = 1
	local final = inspect(pve).cframe
	assertPose(pve.camera.CFrame, final)
	wall:Destroy()

	start(pvpB, arena1, "PVP", 2)
	local oldGeneration = pvpB.controller:getBattleGeneration()
	pvpB.controller:cleanupStage(oldGeneration)
	assertRestored(pvpB)
	assert(not pvpB.controller.cameraController:setIntroProgress(0.5), "old arc survived teardown")
	start(pvpB, arena2, "PVP", 1)
	local pose = pvpB.camera.CFrame
	pvpB.controller:cleanupStage(oldGeneration)
	assertPose(pvpB.camera.CFrame, pose)

	local originalCamera = pvpB.camera
	local replacement = Instance.new("Camera")
	pvpB.camera = replacement
	local replacementPose = replacement.CFrame
	assert(not pvpB.controller.cameraController:setIntroProgress(0.5), "stale camera still owns the arc")
	pvpB.controller:cleanupStage()
	assertPose(replacement.CFrame, replacementPose)
	pvpB.camera = originalCamera
	replacement:Destroy()
end, debug.traceback)

for _, client in clients do
	client.controller:cleanupStage()
	if ok then assertRestored(client) end
	client.camera:Destroy()
end
assets:Destroy()
root:Destroy()
assert(ok, failure)
return "L4_1_2_CAMERA_QA_PASSED"
