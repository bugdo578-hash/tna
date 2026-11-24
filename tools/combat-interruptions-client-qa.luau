-- Execute em Studio Play, Client. Os rigs, a timeline e a câmera pertencem exclusivamente à sonda.
assert(game:GetService("RunService"):IsStudio() and game:GetService("RunService"):IsClient())
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local Registry = require(ts.Controllers.CombatCutsceneRegistry).CombatCutsceneRegistry
local fixtures = require(ts.Controllers.CombatCameraFramingTests).cameraFramingTestFixtures
local visual = require(ts.UI.CombatVisualConfig)
local config = require(game.ReplicatedStorage.TS.Config)

local scope = Instance.new("Folder")
local arenas = Instance.new("Folder", scope)
arenas.Name = config.ACTIVE_ARENAS_FOLDER_NAME
local arena = fixtures.makeOpen3v3Arena(arenas, "qa_interrupt", CFrame.Angles(0.15, 0.7, 0.10), 6)
local assets = Instance.new("Folder", scope)
local assetFolder = Instance.new("Folder", assets)
assetFolder.Name = visual.ASSETS_FOLDER_NAME
local fighterFolder = Instance.new("Folder", assetFolder)
fighterFolder.Name = visual.FIGHTER_ASSETS_FOLDER_NAME
local genericRig = Instance.new("Model", fighterFolder)
genericRig.Name = "fixture"
local root = Instance.new("Part", genericRig)
root.Name = "HumanoidRootPart"
root.Anchored = true
genericRig.PrimaryPart = root
local contact = Instance.new("Attachment", root)
contact.Name = visual.GROUND_CONTACT_ATTACHMENT_NAME
contact.Position = Vector3.new(0.1, -root.Size.Y / 2, 0)

local camera = Instance.new("Camera", scope)
local outsideCamera = camera.CFrame
local registry = Registry.new()
local interval = 0.14
local phases = { "approach", "contact", "follow-through", "recover" }
local timeline = { id = "fixture_sequence", name = "fixture", hits = {}, returnTime = interval * 2, dodgeReturnTime = interval }
for index in phases do
	table.insert(timeline.hits, { time = index * interval, damageShare = 1 / #phases })
end
local duration = timeline.hits[#phases].time
assert(registry:registerBySkillId(timeline.id, {
	duration = duration,
	referenceSpace = "arena",
	keyframes = {
		{ time = 0, cframe = CFrame.new(0, 4, 10), fieldOfView = 60 },
		{ time = duration, cframe = CFrame.new(2, 4, 9), fieldOfView = 66 },
	},
}))

local c = Combat.new(nil, assets, scope, 0.1, function() return camera end, function() return Vector2.new(1920, 1080) end, registry)
c.resolveSkillTimeline = function() return timeline end
c:initBillboardPool()
local session = 0
local checks = 0
local function check(condition, message)
	assert(condition, message)
	checks += 1
end

local function setup(flip)
	session += 1
	c:onBattleStarted({
		sessionId = session,
		sides = if flip then { "B", "A" } else { "A", "B" },
		arena = { instanceId = arena.model.Name, arenaId = "Arena_01", physicalSides = { "A", "B" } },
		mode = "PVE",
		fighters = {
			{ sideId = "A", fighterId = "fixture", targetId = "a", hp = 100, hpMax = 100, active = true },
			{ sideId = "B", fighterId = "fixture", targetId = "b", hp = 100, hpMax = 100, active = true },
			{ sideId = "B", fighterId = "fixture", targetId = "reserve", hp = 100, hpMax = 100, active = false },
		},
	})
	return c.fightersByTargetId.a, c.fightersByTargetId.b, c.fightersByTargetId.reserve
end

local function start(sequence, reverse)
	c:onAttackStarted({
		sessionId = session, attackSequence = sequence, slot = 1,
		attackerId = if reverse then "b" else "a", targetId = if reverse then "a" else "b",
	})
	return c.currentAttackToken
end

local function hit(sequence, index, target, damage, sid)
	c:onHitResolved({
		sessionId = sid or session, attackSequence = sequence, hitIndex = index, targetId = target.targetId,
		hit = damage > 0, damage = damage, crit = false, followUpCancelled = false,
	})
end

local function pause(paused, state)
	c:onStateChanged({ sessionId = session, state = state, paused = paused })
end

local function atHome(fighter)
	local pivot = fighter.model:GetPivot()
	return (pivot.Position - fighter.homeCFrame.Position).Magnitude < 0.03
		and pivot.UpVector:Dot(fighter.homeCFrame.UpVector) > 0.999
		and pivot.LookVector:Dot(fighter.homeCFrame.LookVector) > 0.999
end

local function untilTrue(predicate, message)
	local deadline = os.clock() + visual.HIT_RESULT_WAIT_SECONDS + duration + timeline.returnTime
	repeat task.wait() until predicate() or os.clock() > deadline
	check(predicate(), message)
end

local function fakeTrack(resources, token, rig)
	local signals = {}
	local track = { IsPlaying = false, Speed = 1, destroyed = false, signals = signals }
	function track:Play() self.IsPlaying = true end
	function track:AdjustSpeed(speed) self.Speed = speed end
	function track:Stop() self.IsPlaying = false end
	function track:GetMarkerReachedSignal(name)
		signals[name] = signals[name] or Instance.new("BindableEvent", rig)
		return signals[name].Event
	end
	function track:Destroy()
		self.destroyed = true
		for _, marker in signals do marker:Destroy() end
	end
	local animator = { LoadAnimation = function() return track end }
	resources:playAnimation(animator, Instance.new("Animation", rig), token)
	return track
end

local ok, failure = xpcall(function()
	local a, b = setup(false)
	pause(true, "PREPARE")
	start(1, false)
	task.wait(interval)
	check(c:getCameraMode() ~= "cutscene" and atHome(a), "avançou no PREPARE pausado")
	pause(false, "PREPARE")
	untilTrue(function() return c:getCameraMode() == "cutscene" end, "cutscene não iniciou")
	pause(true, "ATTACK")
	local token = c.currentAttackToken
	local track = fakeTrack(c.resources, token, a.model)
	pause(false, "ATTACK")
	local targetPose = b.homeCFrame * CFrame.new(0, 0, -3)
	c.standMotion:moveTemporarily(b, targetPose, duration)
	c.resources:delay(interval, function() fakeTrack(c.resources, token, a.model) end, token)
	pause(true, "ATTACK")
	local pausedCam = camera.CFrame
	local pausedPivot = b.model:GetPivot()
	for index in phases do
		hit(0, index, b, 50)
		local damage = if index % 2 == 0 then 0 else 5
		hit(1, index, b, damage)
		hit(1, index, b, damage)
	end
	task.wait(duration)
	check(b.hp == 100 and camera.CFrame == pausedCam and b.model:GetPivot() == pausedPivot and track.Speed == 0, "recursos avançaram no ATTACK pausado")
	pause(false, "ATTACK")
	untilTrue(function() return c.activePendingHits == 0 end, "hits não retomaram")
	pause(true, "RETURN")
	local returning = a.model:GetPivot()
	task.wait(timeline.returnTime)
	check(a.model:GetPivot() == returning and b.hp == 90, "retorno ou resultados duplicados em Pause")
	pause(false, "RETURN")
	untilTrue(function() return atHome(a) and atHome(b) and track.destroyed end, "retorno natural incompleto")
	check(a.homeCFrame ~= b.homeCFrame, "anchors físicos indistintos")

	a, b = setup(false)
	pause(true, "PREPARE")
	start(1, false)
	c:onBattleEnded({ sessionId = session, reason = "quit" })
	c:cleanupStage()
	check(next(c.battleTasks) == nil and c:getCameraMode() == "inactive", "Quit no PREPARE deixou fase pendente")

	for stage in phases do
		a, b = setup(stage % 2 == 0)
		local reverse = stage % 2 == 0
		local target = if reverse then a else b
		token = start(1, reverse)
		local stageTrack = fakeTrack(c.resources, token, target.model)
		local oldStage = c.stageFolder
		local auxiliary = Instance.new("Sound", oldStage)
		local callbacks = 0
		c.resources:own(token, function() auxiliary:Destroy() end)
		local transparency = target.rootPart.Transparency
		target.rootPart.Transparency = 1
		c.resources:own(token, function() target.rootPart.Transparency = transparency end)
		c.resources:delay(duration + interval, function() callbacks += 1 end, token)
		c.standMotion:moveTemporarily(target, target.homeCFrame * CFrame.new(2, 0, 0), duration)
		local returnPhase = stage == #phases
		for index = 1, if returnPhase then #phases else stage - 1 do hit(1, index, target, 0) end
		if returnPhase then
			untilTrue(function() return c.activePendingHits == 0 end, "sonda não chegou ao RETURN")
		else
			task.wait((stage - 1) * interval)
		end
		c:onBattleEnded({ sessionId = session, reason = "quit" })
		local oldGeneration = c:getBattleGeneration()
		local oldSession = session
		c:cleanupStage()
		c:cleanupStage()
		check(camera.CFrame == outsideCamera and oldStage.Parent == nil, "Quit não restaurou palco/câmera")
		check(stageTrack.destroyed and auxiliary.Parent == nil and next(c.battleTasks) == nil
			and target.rootPart.Transparency == transparency, "recursos residuais após Quit")
		a, b = setup(reverse)
		start(1, reverse)
		target = if reverse then a else b
		hit(1, 1, target, 90, oldSession)
		c:cleanupStage(oldGeneration)
		for index in phases do hit(1, index, target, 0) end
		untilTrue(function() return c.activePendingHits == 0 and atHome(a) and atHome(b) end, "batalha seguinte não completou")
		check(callbacks == 0 and target.hp == 100, "batalha nova recebeu evento antigo ou dano na esquiva")
	end

	for _, lethal in { 1, math.ceil(#phases / 2), #phases } do
		local reserve
		a, b, reserve = setup(false)
		start(1, false)
		c.standMotion:moveTemporarily(b, b.homeCFrame * CFrame.new(1, 0, 0), duration)
		for index = 1, lethal do hit(1, index, b, if index == lethal then 100 else 0) end
		c:onFighterDied({ sessionId = session, sideId = "B", fighterId = b.targetId, nextActive = reserve.targetId })
		local swap = { sessionId = session, sideId = "B", previousFighterId = b.targetId, activeFighterId = reserve.targetId }
		c:onSwitchPerformed(swap)
		c:onSwitchPerformed(swap)
		untilTrue(function() return reserve.active and atHome(reserve) end, "troca automática incompleta")
		check(b.dead and not b.active and reserve.hp == 100 and c.activePendingHits == 0, "KO, fila ou reserva incorreta")
	end

	a, b = setup(false)
	start(1, false)
	task.wait(timeline.hits[1].time + visual.HIT_RESULT_WAIT_SECONDS + interval)
	hit(1, 1, b, 5)
	untilTrue(function() return b.hp == 95 end, "resultado atrasado descartado após espera do marker")
	start(2, false)
	local current = c.currentAttackToken
	start(2, false)
	check(c.currentAttackToken == current, "AttackStarted duplicado reiniciou a apresentação")
	for index in phases do hit(2, index, b, 0) end
	untilTrue(function() return c.activePendingHits == 0 end, "ataque novo não concluiu")
	check(b.hp == 95, "esquiva total alterou HP")

	a, b = setup(false)
	local firstTrack
	c.tryPlaySlotAnimation = function()
		firstTrack = fakeTrack(c.resources, c.currentAttackToken, a.model)
		return firstTrack
	end
	start(1, false)
	-- Marker antes do resultado. Os demais markers não existem no asset de teste.
	local oldMarker = firstTrack.signals.Hit1
	oldMarker:Fire()
	task.wait()
	hit(1, 1, b, 5)
	for index = 2, #phases do hit(1, index, b, 0) end
	untilTrue(function() return b.hp == 95 and c.activePendingHits == 0 end, "marker ou fallback perdeu resultado")
	start(2, false)
	oldMarker:Fire()
	check(c.activePendingHits == #phases and b.hp == 95, "marker anterior alcançou o ataque novo")
	local brokenAnimator = { LoadAnimation = function() error("asset indisponível") end }
	check(c.resources:playAnimation(brokenAnimator, Instance.new("Animation", a.model), c.currentAttackToken) == nil,
		"falha de AnimationTrack impediu fallback")
end, debug.traceback)
c:cleanupStage()
scope:Destroy()
assert(ok, failure)
return { result = "COMBAT_INTERRUPTIONS_CLIENT_QA_PASSED", checks = checks }
