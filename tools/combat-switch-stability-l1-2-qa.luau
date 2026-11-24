-- Studio Play, Client. Os dois times, arenas e timelines abaixo são fixtures da sonda.
local run = game:GetService("RunService")
assert(run:IsStudio() and run:IsClient())
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local fixtures = require(ts.Controllers.CombatCameraFramingTests).cameraFramingTestFixtures
local visual = require(ts.UI.CombatVisualConfig)
local config = require(game.ReplicatedStorage.TS.Config)
local TIMEOUT = 4 * (visual.HIT_RESULT_WAIT_SECONDS + visual.PLACEHOLDER_KO_TWEEN_SECONDS)
local POSITION_TOLERANCE = visual.COMBAT_POSITION_TOLERANCE_STUDS
local ROTATION_DOT_MIN = 0.9999
local TOTAL_CYCLES = 100

local scope = Instance.new("Folder")
local arenas = Instance.new("Folder", scope)
arenas.Name = config.ACTIVE_ARENAS_FOLDER_NAME
local arena = fixtures.makeOpen3v3Arena(arenas, "qa_switch_stability", CFrame.Angles(0.17, 0.83, -0.12), 6)
local assets = Instance.new("Folder", scope)
local assetFolder = Instance.new("Folder", assets)
assetFolder.Name = visual.ASSETS_FOLDER_NAME
local fighterFolder = Instance.new("Folder", assetFolder)
fighterFolder.Name = visual.FIGHTER_ASSETS_FOLDER_NAME
local rig = Instance.new("Model", fighterFolder)
rig.Name = "switch_fixture"
local root = Instance.new("Part", rig)
root.Name = "HumanoidRootPart"
root.Anchored = true
rig.PrimaryPart = root
local contact = Instance.new("Attachment", root)
contact.Name = visual.GROUND_CONTACT_ATTACHMENT_NAME
contact.Position = root.Size * Vector3.new(0.2, -0.5, 0.1)

local camera = Instance.new("Camera", scope)
local c = Combat.new(nil, assets, scope, nil, function() return camera end, function() return Vector2.new(1920, 1080) end)
c:initBillboardPool()
local sides = { "side-a", "side-b" }
local timeline = { name = "fixture", hits = {}, returnTime = visual.PLACEHOLDER_SWITCH_TWEEN_SECONDS }
timeline.dodgeReturnTime = timeline.returnTime
local hitCount = 4
for index = 1, hitCount do
	table.insert(timeline.hits, { time = index * visual.PLACEHOLDER_STRIKE_TWEEN_SECONDS, damageShare = 1 / hitCount })
end
c.resolveSkillTimeline = function() return timeline end

local session = 0
local expectedActive = {}
local expectedDead = {}
local maxPosition, maxAngle, maxGround, maxFrame, maxHitch = 0, 0, 0, 0, 0
local frameConnection = run.PreRender:Connect(function(dt) maxFrame = math.max(maxFrame, dt) end)

local function waitFor(predicate, label)
	local deadline = os.clock() + TIMEOUT
	while not predicate() do
		assert(os.clock() < deadline, label .. ": timeout")
		task.wait()
	end
end

local function idle()
	return not c.activeAttack and c.activePendingHits == 0 and not c.attackFinalizer:hasActiveKoAnimations()
		and #c.pendingSwitches == 0 and next(c.pendingDeaths) == nil and next(c.battleTweens) == nil
end

local function setup()
	session += 1
	table.clear(expectedActive)
	table.clear(expectedDead)
	local snapshots = {}
	for _, side in sides do
		for slot = 1, 2 do
			local id = side .. "-" .. slot
			if slot == 1 then expectedActive[side] = id end
			table.insert(snapshots, {
				sideId = side, targetId = id, fighterId = rig.Name, hp = 100, hpMax = 100, active = slot == 1,
			})
		end
	end
	c:onBattleStarted({
		sessionId = session,
		sides = if session % 2 == 0 then { sides[2], sides[1] } else sides,
		arena = { instanceId = arena.model.Name, arenaId = "Arena_01", physicalSides = sides },
		mode = "PVE", fighters = snapshots,
	})
end

local function opposite(side)
	return if side == sides[1] then sides[2] else sides[1]
end

local function swapPayload(side)
	local current = expectedActive[side]
	local reserve = if current == side .. "-1" then side .. "-2" else side .. "-1"
	return { sessionId = session, sideId = side, previousFighterId = current, activeFighterId = reserve }
end

local function applySwap(payload)
	c:onSwitchPerformed(payload)
	expectedActive[payload.sideId] = payload.activeFighterId
end

local function assertPose(actual, expected, label, measure)
	local position = (actual.Position - expected.Position).Magnitude
	local lookDot, rightDot, upDot = actual.LookVector:Dot(expected.LookVector),
		actual.RightVector:Dot(expected.RightVector), actual.UpVector:Dot(expected.UpVector)
	local angle = math.deg(math.acos(math.clamp((lookDot + rightDot + upDot - 1) / 2, -1, 1)))
	if measure then
		maxPosition = math.max(maxPosition, position)
		maxAngle = math.max(maxAngle, angle)
	end
	assert(position <= POSITION_TOLERANCE and math.min(lookDot, rightDot, upDot) >= ROTATION_DOT_MIN,
		string.format("%s: %.8f studs, %.6f graus", label, position, angle))
end

local function verifyPoses()
	local resolved = assert(c:getResolvedArenaAnchors())
	for index, side in sides do
		for slot = 1, 2 do
			local id = side .. "-" .. slot
			local fighter = assert(c.fightersByTargetId[id])
			local active = expectedActive[side] == id
			assert(fighter.active == active and fighter.dead == (expectedDead[id] == true), "estado incorreto de " .. id)
			assert(fighter.sideIndex == index - 1 and fighter.groundContactOffset:FuzzyEq(contact.Position, POSITION_TOLERANCE))
			local anchor = if active then resolved.sides[index].active else resolved.sides[index].waiting[1]
			local top = anchor.CFrame * CFrame.new(0, anchor.Size.Y / 2, 0)
			local expected = top * CFrame.new(-contact.Position)
			assertPose(fighter.homeCFrame, expected, id .. " home", true)
			assertPose(fighter.rootPart.CFrame, expected, id .. " root", true)
			local error = (fighter.rootPart.CFrame:PointToWorldSpace(contact.Position) - top.Position).Magnitude
			maxGround = math.max(maxGround, error)
			assert(error <= POSITION_TOLERANCE, "GroundContact de " .. id)
		end
	end
end

local function pause(paused)
	c:onStateChanged({ sessionId = session, state = "IDLE", paused = paused })
end

local function verifyCancelled(tweens)
	assert(next(tweens) ~= nil, "fixture não iniciou movimento")
	for tween in tweens do assert(tween.PlaybackState == Enum.PlaybackState.Cancelled, "tween obsoleto sobreviveu") end
end

local function ko(side, multiHit)
	local payload = swapPayload(side)
	local target = c.fightersByTargetId[payload.previousFighterId]
	if multiHit then
		c:onAttackStarted({ sessionId = session, attackSequence = 1, slot = 1,
			attackerId = expectedActive[opposite(side)], targetId = target.targetId })
		for index in timeline.hits do
			c:onHitResolved({ sessionId = session, attackSequence = 1, hitIndex = index, targetId = target.targetId,
				hit = true, damage = if index == #timeline.hits then target.hp else 1, crit = false, followUpCancelled = false })
		end
	end
	c:onFighterDied({ sessionId = session, sideId = side, fighterId = target.targetId, nextActive = payload.activeFighterId })
	assert(not c.fightersByTargetId[payload.activeFighterId].active, "substituto entrou antes do KO")
	expectedDead[target.targetId] = true
	expectedActive[side] = payload.activeFighterId
	waitFor(idle, "troca por KO")
	c:onSwitchPerformed(payload)
	assert(idle(), "troca duplicada após KO")
end

local function hitch()
	task.defer(function()
		local start = os.clock()
		-- Consome um quadro no cliente de teste com base na duração real da troca.
		while os.clock() - start < visual.PLACEHOLDER_SWITCH_TWEEN_SECONDS * 1.5 do end
		maxHitch = math.max(maxHitch, os.clock() - start)
	end)
end

local scenarios = {
	{ name = "voluntary", count = 20, run = function(side) applySwap(swapPayload(side)) end },
	{ name = "consecutive_cancelled", count = 20, run = function(side)
		applySwap(swapPayload(side))
		local superseded = table.clone(c.battleTweens)
		applySwap(swapPayload(side))
		-- O TweenService resolve a sobreposição na atualização do motor.
		waitFor(idle, "trocas consecutivas")
		verifyCancelled(superseded)
	end },
	{ name = "pause_resume", count = 10, run = function(side)
		local payload = swapPayload(side)
		applySwap(payload)
		pause(true)
		local fighter = c.fightersByTargetId[payload.activeFighterId]
		local frozen = fighter.rootPart.CFrame
		assert(next(c.battleTweens) ~= nil)
		for tween in c.battleTweens do assert(tween.PlaybackState == Enum.PlaybackState.Paused) end
		run.Heartbeat:Wait()
		run.Heartbeat:Wait()
		assert(fighter.rootPart.CFrame == frozen, "troca avançou durante Pause")
		pause(false)
	end },
	{ name = "late_reaction", count = 10, run = function(side)
		local host = c.standMotion.host
		local delayBattle, staleCallback = host.delayBattle, nil
		host.delayBattle = function(_, callback) staleCallback = callback end
		c.standMotion:playDodgeReaction(c.fightersByTargetId[expectedActive[side]])
		host.delayBattle = delayBattle
		applySwap(swapPayload(side))
		waitFor(idle, "troca antes do callback atrasado")
		local delivered = false
		task.defer(function() assert(staleCallback)(); delivered = true end)
		waitFor(function() return delivered end, "entrega do callback anterior")
		assert(idle(), "callback atrasado iniciou movimento com anchor antigo")
	end },
	{ name = "frame_hitch", count = 10, run = function(side)
		applySwap(swapPayload(side))
		hitch()
	end },
	{ name = "automatic_ko", count = 10, fresh = true, run = function(side) ko(side, false) end },
	{ name = "multihit_ko", count = 10, fresh = true, run = function(side) ko(side, true) end },
	{ name = "quit_restart", count = 10, fresh = true, run = function(side)
		local old = swapPayload(side)
		applySwap(old)
		local interrupted = table.clone(c.battleTweens)
		local generation, stage = c:getBattleGeneration(), c.stageFolder
		local obsoleteRan = false
		c:delayBattle(visual.PLACEHOLDER_SWITCH_TWEEN_SECONDS, function() obsoleteRan = true end)
		c:onBattleEnded({ sessionId = session, reason = "quit" })
		c:cleanupStage(generation)
		verifyCancelled(interrupted)
		assert(not stage.Parent and next(c.battleTasks) == nil and idle(), "teardown deixou recursos")
		setup()
		c:cleanupStage(generation)
		c:onSwitchPerformed(old)
		assert(idle())
		applySwap(swapPayload(side))
		waitFor(idle, "troca na nova batalha")
		assert(not obsoleteRan, "callback da batalha antiga executou")
	end },
}

local passed, failures, outcomes = 0, {}, {}
local ok, failure = xpcall(function()
	for _, scenario in scenarios do
		outcomes[scenario.name] = { passed = 0, failed = 0 }
		setup()
		for index = 1, scenario.count do
			local caseOk, err = xpcall(function()
				if scenario.fresh then setup() end
				scenario.run(sides[(index - 1) % #sides + 1])
				waitFor(idle, scenario.name)
				verifyPoses()
			end, debug.traceback)
			if caseOk then
				passed += 1
				outcomes[scenario.name].passed += 1
			else
				outcomes[scenario.name].failed += 1
				table.insert(failures, { scenario = scenario.name, trial = index, error = err })
				setup()
			end
		end
	end
	assert(maxHitch >= visual.PLACEHOLDER_SWITCH_TWEEN_SECONDS * 1.5, "variação controlada de quadro ausente")
	assert(passed + #failures == TOTAL_CYCLES, "quantidade incorreta de ciclos")
end, debug.traceback)
frameConnection:Disconnect()
c:cleanupStage()
c.poolContainer:Destroy()
scope:Destroy()
return {
	result = if ok and #failures == 0 then "L1_2_COMBAT_SWITCH_STABILITY_PASSED" else "L1_2_COMBAT_SWITCH_STABILITY_FAILED",
	passed = passed, failures = failures, error = if not ok then failure else nil, outcomes = outcomes,
	maxPosition = maxPosition, maxAngle = maxAngle, maxGround = maxGround, maxFrame = maxFrame, maxHitch = maxHitch,
}
