-- Execute no Client em Play novo após rbxtsc/Rojo. Controllers isolados, sem alterar assets permanentes.
-- QA L1.6 (Client): catálogo universal sem ArenaType, dois clones simultâneos do MESMO template
-- em slots físicos distintos sem sobreposição, isolamento de lutadores, consistência PvP A/B,
-- preservação de GroundContact em arena movida/girada, espera limitada, proteção por geração e sem fallback.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local CombatFighterGrounding = require(ts.Controllers.CombatFighterGrounding)
local config = require(ts.UI.CombatVisualConfig)
local sharedArena = require(ReplicatedStorage.TS.configs.Arena)

local checks = 0
local scenarios = {}

local function check(condition, message)
	checks += 1
	assert(condition, message)
end

local TOL = config.COMBAT_POSITION_TOLERANCE_STUDS
local ROT_DOT_MIN = 0.9999

local function assertCFrameClose(actual, expected, label)
	local posErr = (actual.Position - expected.Position).Magnitude
	local lookDot = actual.LookVector:Dot(expected.LookVector)
	local rightDot = actual.RightVector:Dot(expected.RightVector)
	local upDot = actual.UpVector:Dot(expected.UpVector)
	check(
		posErr <= TOL and lookDot >= ROT_DOT_MIN and rightDot >= ROT_DOT_MIN and upDot >= ROT_DOT_MIN,
		string.format("%s (posErr=%.5f, lookDot=%.5f, rightDot=%.5f, upDot=%.5f)", label, posErr, lookDot, rightDot, upDot)
	)
end

local function assertAlignedToAnchor(actual, anchorPart, fighter, label)
	local expected = CombatFighterGrounding.alignFighterCFrameToAnchor(anchorPart, fighter.groundContactOffset)
	assertCFrameClose(actual, expected, label)
end

local realArenaModel = workspace:FindFirstChild("Arena_01")
local realBasesSource = if realArenaModel then realArenaModel:FindFirstChild(config.ARENA_BASES_NAME) else workspace:FindFirstChild(config.ARENA_BASES_NAME)
check(realBasesSource ~= nil, "Arena_bases real precisa existir no Studio (Workspace.Arena_01.Arena_bases ou Workspace.Arena_bases)")

local function cloneUniversalArenaIntoSlot(parent, instanceId, arenaId, slotCFrame)
	local model = Instance.new("Model")
	model.Name = instanceId
	model:SetAttribute(sharedArena.ARENA_ID_ATTRIBUTE, arenaId)
	model:SetAttribute(sharedArena.ARENA_INSTANCE_ID_ATTRIBUTE, instanceId)
	-- Sem ArenaType: L1.6 catálogo universal

	local basesClone = realBasesSource:Clone()
	local innerScript = basesClone:FindFirstChildOfClass("Script")
	if innerScript then
		innerScript:Destroy()
	end
	basesClone.Parent = model
	if basesClone:IsA("BasePart") then
		model.PrimaryPart = basesClone
	end
	model:PivotTo(slotCFrame)
	model.Parent = parent
	return model
end

local function getAnchorsFromModel(model)
	local bases = model:FindFirstChild(config.ARENA_BASES_NAME)
	local timeA = bases and bases:FindFirstChild("Time A")
	local timeB = bases and bases:FindFirstChild("Time B")
	return {
		bases = bases,
		activeA = timeA and timeA:FindFirstChild("Current_Fighter_A"),
		waitA1 = timeA and timeA:FindFirstChild("Waiting_Fighter_A"),
		waitA2 = timeA and timeA:FindFirstChild("Waiting_Fighter_A_2"),
		activeB = timeB and timeB:FindFirstChild("Current_Fighter_B"),
		waitB1 = timeB and timeB:FindFirstChild("Waiting_Fighter_B"),
		waitB2 = timeB and timeB:FindFirstChild("Waiting_Fighter_B_2"),
	}
end

local function makePayload(sides, physicalSides, arenaInfo, mode)
	local sideA = physicalSides[1]
	local sideB = physicalSides[2]
	return {
		sides = sides,
		mode = mode or "PVE",
		canPause = (mode or "PVE") == "PVE",
		arena = arenaInfo,
		fighters = {
			{ sideId = sideA, targetId = sideA .. "-1", fighterId = "jotaro", hp = 120, hpMax = 120, active = true },
			{ sideId = sideA, targetId = sideA .. "-2", fighterId = "anubis", hp = 100, hpMax = 100, active = false },
			{ sideId = sideA, targetId = sideA .. "-3", fighterId = "jotaro", hp = 110, hpMax = 110, active = false },
			{ sideId = sideB, targetId = sideB .. "-1", fighterId = "anubis", hp = 90, hpMax = 90, active = true },
			{ sideId = sideB, targetId = sideB .. "-2", fighterId = "jotaro", hp = 105, hpMax = 105, active = false },
			{ sideId = sideB, targetId = sideB .. "-3", fighterId = "anubis", hp = 95, hpMax = 95, active = false },
		},
	}
end

local function countMap(tbl)
	local n = 0
	for _ in pairs(tbl) do n += 1 end
	return n
end

local testRoot = Instance.new("Folder")
testRoot.Name = "L16ClientArenaRoot"
testRoot.Parent = workspace

local activeArenasFolder = Instance.new("Folder")
activeArenasFolder.Name = sharedArena.ACTIVE_ARENAS_FOLDER_NAME
activeArenasFolder.Parent = testRoot

-- Decoy Arena_bases em testRoot para provar que nunca há fallback
local decoyBases = realBasesSource:Clone()
local decoyScript = decoyBases:FindFirstChildOfClass("Script")
if decoyScript then decoyScript:Destroy() end
decoyBases.Parent = testRoot

local controllersToClean = {}
local function makeController(timeoutSec)
	local c = Combat.new(nil, ReplicatedStorage, testRoot, timeoutSec or 0.4)
	c:initBillboardPool()
	table.insert(controllersToClean, c)
	return c
end

local ok, err = pcall(function()
	-- =========================================================================
	-- Cenário 1: Mesmo template (ArenaId) clonado simultaneamente em 2 slots físicos distintos (sem ArenaType)
	-- =========================================================================
	local slot1CF = CFrame.new(1300, 20, -400) * CFrame.Angles(0, math.rad(15), 0)
	local slot2CF = CFrame.new(1750, 35, 120) * CFrame.Angles(0, math.rad(-80), 0)
	local clone1 = cloneUniversalArenaIntoSlot(activeArenasFolder, "Arena_l16-1_1", "shared_island", slot1CF)
	local clone2 = cloneUniversalArenaIntoSlot(activeArenasFolder, "Arena_l16-2_2", "shared_island", slot2CF)
	local a1 = getAnchorsFromModel(clone1)
	local a2 = getAnchorsFromModel(clone2)

	local ctrl1 = makeController()
	local ctrl2 = makeController()

	ctrl1:onBattleStarted(makePayload(
		{ "l16-1-A", "l16-1-B" },
		{ "l16-1-A", "l16-1-B" },
		{ arenaId = "shared_island", instanceId = "Arena_l16-1_1", physicalSides = { "l16-1-A", "l16-1-B" } },
		"PVE"
	))
	ctrl2:onBattleStarted(makePayload(
		{ "l16-2-A", "l16-2-B" },
		{ "l16-2-A", "l16-2-B" },
		{ arenaId = "shared_island", instanceId = "Arena_l16-2_2", physicalSides = { "l16-2-A", "l16-2-B" } },
		"PVE"
	))

	check(ctrl1:getActiveArenaInstance() == clone1, "C1: ctrl1 resolve clone1 (mesmo ArenaId, sem ArenaType)")
	check(ctrl2:getActiveArenaInstance() == clone2, "C1: ctrl2 resolve clone2 (mesmo ArenaId, sem ArenaType)")
	check(ctrl1.stageFolder ~= ctrl2.stageFolder, "C1: stageFolders isolados entre clones do mesmo template")
	check(countMap(ctrl1.fightersByTargetId) == 6 and countMap(ctrl2.fightersByTargetId) == 6, "C1: 6 lutadores em cada clone")

	local f1Pos = ctrl1.fightersByTargetId["l16-1-A-1"].model:GetPivot().Position
	local f2Pos = ctrl2.fightersByTargetId["l16-2-A-1"].model:GetPivot().Position
	check((f1Pos - f2Pos).Magnitude > 400, "C1: lutadores das duas batalhas fisicamente separados (>400 studs)")

	assertAlignedToAnchor(ctrl1.fightersByTargetId["l16-1-A-1"].model:GetPivot(), a1.activeA, ctrl1.fightersByTargetId["l16-1-A-1"], "C1: clone1 Time A ativo")
	assertAlignedToAnchor(ctrl1.fightersByTargetId["l16-1-B-1"].model:GetPivot(), a1.activeB, ctrl1.fightersByTargetId["l16-1-B-1"], "C1: clone1 Time B ativo")
	assertAlignedToAnchor(ctrl2.fightersByTargetId["l16-2-A-1"].model:GetPivot(), a2.activeA, ctrl2.fightersByTargetId["l16-2-A-1"], "C1: clone2 Time A ativo")
	assertAlignedToAnchor(ctrl2.fightersByTargetId["l16-2-B-1"].model:GetPivot(), a2.activeB, ctrl2.fightersByTargetId["l16-2-B-1"], "C1: clone2 Time B ativo")

	-- Destruir clone 1 NÃO altera clone 2 nem os lutadores da batalha 2
	local f2Before = ctrl2.fightersByTargetId["l16-2-A-1"].model:GetPivot()
	ctrl1:cleanupStage()
	clone1:Destroy()
	check(clone1.Parent == nil and clone2.Parent == activeArenasFolder, "C1: somente clone 1 destruído")
	check(ctrl2.stageFolder ~= nil and ctrl2.stageFolder.Parent == workspace, "C1: stageFolder 2 permanece ativo")
	assertCFrameClose(ctrl2.fightersByTargetId["l16-2-A-1"].model:GetPivot(), f2Before, "C1: lutador da batalha 2 inalterado após destruir clone 1")

	-- Troca na batalha 2 preserva GroundContact após encerrar batalha 1
	ctrl2:onSwitchPerformed({ sideId = "l16-2-A", previousFighterId = "l16-2-A-1", activeFighterId = "l16-2-A-2" })
	task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.1)
	assertAlignedToAnchor(ctrl2.fightersByTargetId["l16-2-A-2"].model:GetPivot(), a2.activeA, ctrl2.fightersByTargetId["l16-2-A-2"], "C1: substituto em clone2 alinhado ao activeA")
	assertAlignedToAnchor(ctrl2.fightersByTargetId["l16-2-A-1"].model:GetPivot(), a2.waitA1, ctrl2.fightersByTargetId["l16-2-A-1"], "C1: substituído em clone2 foi para waitA1")

	ctrl2:cleanupStage()
	clone2:Destroy()
	table.insert(scenarios, "C1_SAME_TEMPLATE_SIMULTANEOUS_ISOLATED")

	-- =========================================================================
	-- Cenário 2: PvP em template universal (sem ArenaType) preserva lados físicos canônicos A/B
	-- =========================================================================
	local pvpSlotCF = CFrame.new(1550, 28, 310) * CFrame.Angles(0, math.rad(135), 0)
	local pvpClone = cloneUniversalArenaIntoSlot(activeArenasFolder, "Arena_l16-pvp_3", "shared_island", pvpSlotCF)
	local pAnchors = getAnchorsFromModel(pvpClone)
	local pvpInfo = {
		arenaId = "shared_island",
		instanceId = "Arena_l16-pvp_3",
		physicalSides = { "l16-pvp-A", "l16-pvp-B" },
	}

	local pvpC1 = makeController()
	local pvpC2 = makeController()
	pvpC1:onBattleStarted(makePayload({ "l16-pvp-A", "l16-pvp-B" }, { "l16-pvp-A", "l16-pvp-B" }, pvpInfo, "PVP"))
	pvpC2:onBattleStarted(makePayload({ "l16-pvp-B", "l16-pvp-A" }, { "l16-pvp-A", "l16-pvp-B" }, pvpInfo, "PVP"))

	check(pvpC1:getActiveArenaInstance() == pvpClone and pvpC2:getActiveArenaInstance() == pvpClone, "C2: ambos clientes PvP na mesma instância universal")
	for _, targetId in ipairs({ "l16-pvp-A-1", "l16-pvp-A-2", "l16-pvp-A-3", "l16-pvp-B-1", "l16-pvp-B-2", "l16-pvp-B-3" }) do
		assertCFrameClose(
			pvpC1.fightersByTargetId[targetId].model:GetPivot(),
			pvpC2.fightersByTargetId[targetId].model:GetPivot(),
			"C2: pose física canônica idêntica entre clientes PvP para " .. targetId
		)
	end
	assertAlignedToAnchor(pvpC2.fightersByTargetId["l16-pvp-A-1"].model:GetPivot(), pAnchors.activeA, pvpC2.fightersByTargetId["l16-pvp-A-1"], "C2: Cliente 2 A-1 em Time A")
	assertAlignedToAnchor(pvpC2.fightersByTargetId["l16-pvp-B-1"].model:GetPivot(), pAnchors.activeB, pvpC2.fightersByTargetId["l16-pvp-B-1"], "C2: Cliente 2 B-1 em Time B")

	pvpC1:cleanupStage()
	pvpC2:cleanupStage()
	pvpClone:Destroy()
	table.insert(scenarios, "C2_PVP_UNIVERSAL_CANONICAL_SIDES")

	-- =========================================================================
	-- Cenário 3: GroundContact preservado em clone universal movido/girado 3D
	-- =========================================================================
	local tiltedSlotCF = CFrame.new(-420, 55, 290) * CFrame.Angles(math.rad(11), math.rad(-142), math.rad(7))
	local rotClone = cloneUniversalArenaIntoSlot(activeArenasFolder, "Arena_l16-rot_4", "shared_island", tiltedSlotCF)
	local rAnchors = getAnchorsFromModel(rotClone)

	local customAssets = Instance.new("Folder")
	customAssets.Name = "L16CustomAssets"
	local assetsFolder = Instance.new("Folder")
	assetsFolder.Name = config.ASSETS_FOLDER_NAME
	assetsFolder.Parent = customAssets
	local fightersFolder = Instance.new("Folder")
	fightersFolder.Name = config.FIGHTER_ASSETS_FOLDER_NAME
	fightersFolder.Parent = assetsFolder

	local gcModel = Instance.new("Model")
	gcModel.Name = "jotaro"
	local gcRoot = Instance.new("Part")
	gcRoot.Name = "HumanoidRootPart"
	gcRoot.Size = Vector3.new(2, 2, 1)
	gcRoot.Anchored = true
	gcRoot.Parent = gcModel
	gcModel.PrimaryPart = gcRoot
	local gcAtt = Instance.new("Attachment")
	gcAtt.Name = config.GROUND_CONTACT_ATTACHMENT_NAME
	gcAtt.Position = Vector3.new(-0.2, -2.6, 0.1)
	gcAtt.Parent = gcRoot
	gcModel.Parent = fightersFolder

	local rotCtrl = Combat.new(nil, customAssets, testRoot, 0.4)
	rotCtrl:initBillboardPool()
	table.insert(controllersToClean, rotCtrl)
	rotCtrl:onBattleStarted(makePayload(
		{ "l16-rot-A", "l16-rot-B" },
		{ "l16-rot-A", "l16-rot-B" },
		{ arenaId = "shared_island", instanceId = "Arena_l16-rot_4", physicalSides = { "l16-rot-A", "l16-rot-B" } },
		"PVE"
	))

	local gcEntry = rotCtrl.fightersByTargetId["l16-rot-A-1"]
	check(gcEntry ~= nil, "C3: lutador com GroundContact instanciado em clone universal")
	local expectedTopWorld = (rAnchors.activeA.CFrame * CFrame.new(0, rAnchors.activeA.Size.Y * 0.5, 0)).Position
	local actualContactWorld = (gcEntry.model:GetPivot() * CFrame.new(gcEntry.groundContactOffset)).Position
	check((actualContactWorld - expectedTopWorld).Magnitude <= TOL, "C3: GroundContact coincide com face superior do anchor girado 3D")
	assertAlignedToAnchor(gcEntry.model:GetPivot(), rAnchors.activeA, gcEntry, "C3: orientação 3D preservada")

	rotCtrl:cleanupStage()
	rotClone:Destroy()
	customAssets:Destroy()
	table.insert(scenarios, "C3_GROUND_CONTACT_3D_SLOT")

	-- =========================================================================
	-- Cenário 4: Rejeita ArenaId falsificado/divergente e nunca faz fallback
	-- =========================================================================
	local activeClone = cloneUniversalArenaIntoSlot(activeArenasFolder, "Arena_l16-sec_5", "real_server_arena", CFrame.new(900, 10, 900))
	local secCtrl = makeController(0.15)
	secCtrl:onBattleStarted(makePayload(
		{ "l16-sec-A", "l16-sec-B" },
		{ "l16-sec-A", "l16-sec-B" },
		{ arenaId = "forged_client_arena", instanceId = "Arena_l16-sec_5", physicalSides = { "l16-sec-A", "l16-sec-B" } },
		"PVE"
	))
	check(countMap(secCtrl.fightersByTargetId) == 0 and secCtrl:getActiveArenaInstance() == nil, "C4: ArenaId divergente rejeitado sem fallback")

	secCtrl:onBattleStarted(makePayload(
		{ "l16-miss-A", "l16-miss-B" },
		{ "l16-miss-A", "l16-miss-B" },
		{ arenaId = "real_server_arena", instanceId = "Arena_nonexistent_99", physicalSides = { "l16-miss-A", "l16-miss-B" } },
		"PVE"
	))
	check(countMap(secCtrl.fightersByTargetId) == 0 and secCtrl:getActiveArenaInstance() == nil, "C4: instanceId ausente rejeitado sem fallback para decoy")

	secCtrl:cleanupStage()
	activeClone:Destroy()
	table.insert(scenarios, "C4_NO_SPOOF_NO_FALLBACK")
end)

for _, c in ipairs(controllersToClean) do
	pcall(function()
		c:cleanupStage()
		if c.damagePool then c.damagePool:destroy() end
	end)
end
pcall(function() testRoot:Destroy() end)

assert(ok, err)
print(string.format("L1_6_ARENA_CLIENT_QA_PASSED checks=%d scenarios=%s", checks, table.concat(scenarios, ",")))
