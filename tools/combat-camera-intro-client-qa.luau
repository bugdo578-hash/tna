-- Run on the Client in Studio Play after rbxtsc and Rojo sync.
local run = game:GetService("RunService")
assert(run:IsStudio() and run:IsClient(), "Studio Client required")

local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local fixtures = require(ts.Controllers.CombatCameraFramingTests).cameraFramingTestFixtures
local visuals = require(ts.UI.CombatVisualConfig)
local duration = visuals.CAMERA_INTRO_DURATION_SECONDS
local landscape, portrait = Vector2.new(1920, 1080), Vector2.new(414, 736)
local root = Instance.new("Folder")
local activeArenas = Instance.new("Folder")
activeArenas.Name = require(game.ReplicatedStorage.TS.Config).ACTIVE_ARENAS_FOLDER_NAME
activeArenas.Parent = root
local subject = Instance.new("Part", root)
local assets = fixtures.makeAssetsWithStandAndWeapon()
local sessions = {}

local function makeClient(viewport)
	local camera = Instance.new("Camera")
	camera.CameraType = Enum.CameraType.Custom
	camera.CameraSubject = subject
	camera.CFrame = CFrame.new(5, 12, -20) * CFrame.Angles(0, 1, 0)
	camera.FieldOfViewMode = Enum.FieldOfViewMode.Diagonal
	camera.FieldOfView = 74
	local session = { camera = camera, original = camera.CFrame, viewport = viewport }
	session.controller = Combat.new(nil, assets, root, 0.2, function() return session.camera end, function() return session.viewport end)
	table.insert(sessions, session)
	return session
end

local function assertPose(actual, expected)
	assert((actual.Position - expected.Position).Magnitude < 0.001, "position mismatch")
	assert((actual.LookVector - expected.LookVector).Magnitude < 0.0001, "look axis mismatch")
	assert((actual.UpVector - expected.UpVector).Magnitude < 0.0001, "up axis mismatch")
end

local function assertRestored(session, camera)
	camera = camera or session.camera
	assert(camera.CameraType == Enum.CameraType.Custom, "camera stayed Scriptable")
	assert(camera.CameraSubject == subject, "CameraSubject did not restore")
	assert(camera.FieldOfViewMode == Enum.FieldOfViewMode.Diagonal, "FOV mode did not restore")
	assert(math.abs(camera.FieldOfView - 74) < 0.001, "FOV did not restore")
	assertPose(camera.CFrame, session.original)
	assert(not session.controller:refreshCameraFraming(true), "teardown left camera active")
end

local function inspect(session)
	local camera = session.camera
	local frame = assert(session.controller:getLastAppliedCameraFrame(), "missing adaptive frame")
	assert(session.controller:getActiveCameraPart() == session.anchor, "wrong side or arena clone")
	assert(camera.CameraType == Enum.CameraType.Scriptable, "battle lost Scriptable")
	assert(camera.FieldOfViewMode == frame.fieldOfViewMode and math.abs(camera.FieldOfView - frame.fieldOfView) < 0.001, "adaptive FOV changed")
	local offset = fixtures.assertPreservesReferenceAxis(camera.CFrame, frame.cframe, session.anchor.Name)
	for _, fighter in session.fighters do
		local model = assert(session.controller:getFighterModel(fighter.targetId), "fighter missing")
		local bounds = fixtures.projectModel(model, camera.CFrame, camera.FieldOfView, session.viewport)
		assert(bounds.minDepth > 0.5 and bounds.minU >= 0 and bounds.maxU <= 1 and bounds.minV >= 0 and bounds.maxV <= 1,
			"fighter, Stand or sword clipped: " .. fighter.targetId)
	end
	return offset, frame
end

local function start(session, arena, mode, ownSide)
	session.anchor = if ownSide == 1 then arena.cameraA else arena.cameraB
	local physical = { "physicalA", "physicalB" }
	session.fighters = fixtures.make3v3Fighters(physical[1], physical[2])
	session.controller:onBattleStarted({
		sides = { physical[ownSide], physical[3 - ownSide] },
		fighters = session.fighters,
		mode = mode,
		canPause = mode == "PVE",
		arena = { instanceId = arena.model.Name, arenaId = "Arena_01", physicalSides = physical },
	})
	local offset, frame = inspect(session)
	fixtures.assertPreservesReferenceAxis(frame.cframe, session.anchor.CFrame, "adaptive frame")
	local center = arena.activeA.Position:Lerp(arena.activeB.Position, 0.5)
	local expected = math.min(-frame.cframe:PointToObjectSpace(center).Z * visuals.CAMERA_INTRO_DEPTH_FRACTION,
		visuals.CAMERA_INTRO_MAX_PULLBACK_STUDS)
	assert(offset > 0.1 and math.abs(offset - expected) < 0.001, "intro did not start at its adaptive pullback")
	return offset
end

local ok, failure = xpcall(function()
	local arena1 = fixtures.makeOpen3v3Arena(activeArenas, "L41_rotated", CFrame.new(180, 12, -90) * CFrame.Angles(0, math.rad(37), 0), 6)
	local arena2 = fixtures.makeOpen3v3Arena(activeArenas, "L41_other", CFrame.new(-200, 25, 120) * CFrame.Angles(0, math.rad(-80), 0), 6)
	local pve, pvpA, pvpB = makeClient(landscape), makeClient(portrait), makeClient(landscape)
	local firstPve = start(pve, arena1, "PVE", 1)
	local firstA = start(pvpA, arena2, "PVP", 1)
	local firstB = start(pvpB, arena2, "PVP", 2)
	local startedAt = os.clock()

	-- Observe the render loop in both aspect ratios while two different arena clones are active.
	local prevPve, prevA, prevB = firstPve, firstA, firstB
	repeat
		run.RenderStepped:Wait()
		local a, b, c = inspect(pve), inspect(pvpA), inspect(pvpB)
		assert(a <= prevPve + 0.001 and b <= prevA + 0.001 and c <= prevB + 0.001, "intro motion reversed")
		prevPve, prevA, prevB = a, b, c
	until os.clock() - startedAt >= duration * 0.35
	assert(prevPve > 0 and prevPve < firstPve - 0.01, "PvE never rendered an intermediate frame")
	assert(prevA > 0 and prevA < firstA - 0.01 and prevB > 0 and prevB < firstB - 0.01,
		"PvP never rendered intermediate frames on both sides")

	-- The viewport override exercises the same refresh path as the Camera.ViewportSize listener.
	local beforeRefresh = pve.camera.CFrame
	assert(pve.controller:refreshCameraFraming(true), "forced refresh failed")
	assertPose(pve.camera.CFrame, beforeRefresh)
	pve.viewport = portrait
	assert(pve.controller:refreshCameraFraming(false), "resize refresh failed")
	local afterResize, resizedFrame = inspect(pve)
	assert(afterResize < 0.001, "resize did not finish at the new adaptive frame")

	-- The existing cleanup path must release the camera even with a render update pending.
	local oldGeneration = pvpB.controller:getBattleGeneration()
	pvpB.controller:cleanupStage(oldGeneration)
	assertRestored(pvpB)
	run.RenderStepped:Wait()
	assertRestored(pvpB)
	local second = start(pvpB, arena1, "PVP", 2)
	pvpB.controller:cleanupStage(oldGeneration)
	assert(inspect(pvpB) > 0, "old teardown cancelled the second intro")

	local secondAt = os.clock()
	local prevSecond = second
	repeat
		run.RenderStepped:Wait()
		local a, b = inspect(pvpA), inspect(pvpB)
		assert(a <= prevA + 0.001 and b <= prevSecond + 0.001, "camera moved away from its target")
		assertPose(pve.camera.CFrame, resizedFrame.cframe)
		prevA, prevSecond = a, b
	until os.clock() - secondAt >= duration + 0.15
	for _, session in sessions do
		local remaining, frame = inspect(session)
		assert(remaining < 0.001, "intro did not reach the final framing")
		run.RenderStepped:Wait()
		assertPose(session.camera.CFrame, frame.cframe)
		session.controller:cleanupStage()
		assertRestored(session)
	end

	-- CurrentCamera replacement must leave the substitute camera untouched.
	start(pve, arena1, "PVE", 1)
	local originalCamera = pve.camera
	local replacement = Instance.new("Camera")
	local originalType = replacement.CameraType
	replacement.CFrame = CFrame.new(-30, 50, 20)
	local replacementPose = replacement.CFrame
	pve.camera = replacement
	run.RenderStepped:Wait()
	run.RenderStepped:Wait()
	pve.camera = originalCamera
	local replacementType, replacementFrame = replacement.CameraType, replacement.CFrame
	replacement:Destroy()
	assert(replacementType == originalType, "replacement camera type changed")
	assertPose(replacementFrame, replacementPose)
	assertRestored(pve)
end, debug.traceback)

for _, session in sessions do
	session.controller:cleanupStage()
	session.camera:Destroy()
end
assets:Destroy()
root:Destroy()
assert(ok, failure)
print("L4_1_CAMERA_INTRO_TESTS_ALL_PASSED")
return "L4_1_CAMERA_INTRO_TESTS_ALL_PASSED"
