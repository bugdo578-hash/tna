-- Execute no Client em Play novo após rbxtsc/Rojo. Controllers isolados, sem alterar assets permanentes.
-- QA L1.5 (Client): resolução de instâncias reservadas em ActiveArenas, consistência PvP A/B,
-- isolamento entre duas arenas ativas, arena movida/girada, preservação de GroundContact,
-- espera limitada de replicação, proteção por geração e recusa sem fallback para arena errada.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local CombatArenaAnchors = require(ts.Controllers.CombatArenaAnchors)
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
		string.format(
			"%s (posErr=%.5f, lookDot=%.5f, rightDot=%.5f, upDot=%.5f)",
			label, posErr, lookDot, rightDot, upDot
		)
	)
end

local function assertAlignedToAnchor(actual, anchorPart, fighter, label)
	local expected = CombatFighterGrounding.alignFighterCFrameToAnchor(anchorPart, fighter.groundContactOffset)
	assertCFrameClose(actual, expected, label)
end

local function cloneRealBasesIntoModel(parent, instanceId, arenaId, arenaType, deltaCFrame)
	local realBases = workspace:FindFirstChild(config.ARENA_BASES_NAME)
	check(realBases ~= nil, "Workspace.Arena_bases precisa existir no Studio para fixture L1.5")

	local model = Instance.new("Model")
	model.Name = instanceId
	model:SetAttribute(sharedArena.ARENA_ID_ATTRIBUTE, arenaId)
	model:SetAttribute(sharedArena.ARENA_TYPE_ATTRIBUTE, arenaType)
	model:SetAttribute(sharedArena.ARENA_INSTANCE_ID_ATTRIBUTE, instanceId)

	local basesClone = realBases:Clone()
	-- Remove Script local em fixture client para não depender de execução server
	local innerScript = basesClone:FindFirstChildOfClass("Script")
	if innerScript then
		innerScript:Destroy()
	end
	basesClone.Parent = model
	if basesClone:IsA("BasePart") then
		model.PrimaryPart = basesClone
	end

	if deltaCFrame ~= nil then
		local originCF = basesClone:IsA("BasePart") and basesClone.CFrame or basesClone:GetPivot()
		local targetOrigin = deltaCFrame * originCF
		local rigidDelta = targetOrigin * originCF:Inverse()
		if basesClone:IsA("BasePart") then
			basesClone.CFrame = rigidDelta * basesClone.CFrame
		end
		for _, desc in ipairs(basesClone:GetDescendants()) do
			if desc:IsA("BasePart") then
				desc.CFrame = rigidDelta * desc.CFrame
			end
		end
	end

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
	for _ in pairs(tbl) do
		n += 1
	end
	return n
end

local testRoot = Instance.new("Folder")
testRoot.Name = "L15ClientArenaRoot"
testRoot.Parent = workspace

local activeArenasFolder = Instance.new("Folder")
activeArenasFolder.Name = sharedArena.ACTIVE_ARENAS_FOLDER_NAME
activeArenasFolder.Parent = testRoot

-- Também coloca uma Arena_bases solta em testRoot para comprovar que NUNCA há fallback para ela
local decoyBases = workspace:FindFirstChild(config.ARENA_BASES_NAME):Clone()
local decoyScript = decoyBases:FindFirstChildOfClass("Script")
if decoyScript then
	decoyScript:Destroy()
end
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
	-- Cenário 1: Duas batalhas PvE simultâneas em arenas diferentes + destruição isolada
	-- =========================================================================
	local arena1 = cloneRealBasesIntoModel(activeArenasFolder, "Arena_battle-100_1", "pve_alpha", "PVE", CFrame.new(120, 4, -80))
	local arena2 = cloneRealBasesIntoModel(activeArenasFolder, "Arena_battle-101_2", "pve_beta", "PVE", CFrame.new(-140, 12, 95) * CFrame.Angles(0, math.rad(45), 0))
	local a1 = getAnchorsFromModel(arena1)
	local a2 = getAnchorsFromModel(arena2)

	local ctrl1 = makeController()
	local ctrl2 = makeController()

	ctrl1:onBattleStarted(makePayload(
		{ "battle-100-A", "battle-100-B" },
		{ "battle-100-A", "battle-100-B" },
		{ arenaId = "pve_alpha", arenaType = "PVE", instanceId = "Arena_battle-100_1", physicalSides = { "battle-100-A", "battle-100-B" } },
		"PVE"
	))
	ctrl2:onBattleStarted(makePayload(
		{ "battle-101-A", "battle-101-B" },
		{ "battle-101-A", "battle-101-B" },
		{ arenaId = "pve_beta", arenaType = "PVE", instanceId = "Arena_battle-101_2", physicalSides = { "battle-101-A", "battle-101-B" } },
		"PVE"
	))

	check(ctrl1:getActiveArenaInstance() == arena1, "C1: ctrl1 resolve arena1")
	check(ctrl2:getActiveArenaInstance() == arena2, "C1: ctrl2 resolve arena2")
	check(ctrl1.stageFolder ~= ctrl2.stageFolder, "C1: stageFolders distintos")
	check(ctrl1.stageFolder.Name == config.WORKSPACE_BATTLE_FOLDER_NAME .. "_Arena_battle-100_1", "C1: nome isolado stageFolder 1")
	check(ctrl2.stageFolder.Name == config.WORKSPACE_BATTLE_FOLDER_NAME .. "_Arena_battle-101_2", "C1: nome isolado stageFolder 2")
	check(countMap(ctrl1.fightersByTargetId) == 6 and countMap(ctrl2.fightersByTargetId) == 6, "C1: 6 lutadores em cada arena")

	assertAlignedToAnchor(ctrl1.fightersByTargetId["battle-100-A-1"].model:GetPivot(), a1.activeA, ctrl1.fightersByTargetId["battle-100-A-1"], "C1: arena1 Time A ativo")
	assertAlignedToAnchor(ctrl1.fightersByTargetId["battle-100-B-1"].model:GetPivot(), a1.activeB, ctrl1.fightersByTargetId["battle-100-B-1"], "C1: arena1 Time B ativo")
	assertAlignedToAnchor(ctrl2.fightersByTargetId["battle-101-A-1"].model:GetPivot(), a2.activeA, ctrl2.fightersByTargetId["battle-101-A-1"], "C1: arena2 Time A ativo")
	assertAlignedToAnchor(ctrl2.fightersByTargetId["battle-101-B-1"].model:GetPivot(), a2.activeB, ctrl2.fightersByTargetId["battle-101-B-1"], "C1: arena2 Time B ativo")

	-- Destruir arena 1 + teardown ctrl1 NÃO altera arena 2 nem os lutadores da arena 2
	local f2Before = ctrl2.fightersByTargetId["battle-101-A-1"].model:GetPivot()
	ctrl1:cleanupStage()
	arena1:Destroy()
	check(arena1.Parent == nil, "C1: arena1 destruída")
	check(arena2.Parent == activeArenasFolder, "C1: arena2 continua em ActiveArenas")
	check(ctrl2.stageFolder ~= nil and ctrl2.stageFolder.Parent == workspace, "C1: stageFolder 2 intacto")
	check(ctrl2:getActiveArenaInstance() == arena2, "C1: ctrl2 mantém arena2")
	assertCFrameClose(ctrl2.fightersByTargetId["battle-101-A-1"].model:GetPivot(), f2Before, "C1: lutador da arena2 inalterado após destruir arena1")

	-- Troca normal na arena2 após destruição da arena1 continua funcionando com GroundContact
	ctrl2:onSwitchPerformed({
		sideId = "battle-101-A",
		previousFighterId = "battle-101-A-1",
		activeFighterId = "battle-101-A-2",
	})
	task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.1)
	assertAlignedToAnchor(ctrl2.fightersByTargetId["battle-101-A-2"].model:GetPivot(), a2.activeA, ctrl2.fightersByTargetId["battle-101-A-2"], "C1: substituto na arena2 alinhado ao activeA")
	assertAlignedToAnchor(ctrl2.fightersByTargetId["battle-101-A-1"].model:GetPivot(), a2.waitA1, ctrl2.fightersByTargetId["battle-101-A-1"], "C1: substituído na arena2 foi para waitA1")

	ctrl2:cleanupStage()
	arena2:Destroy()
	table.insert(scenarios, "C1_TWO_PVE_ISOLATED")

	-- =========================================================================
	-- Cenário 2: Dois clientes PvP na MESMA instância física sem inverter A/B
	-- =========================================================================
	local pvpArena = cloneRealBasesIntoModel(
		activeArenasFolder,
		"Arena_battle-200_3",
		"pvp_colosseum",
		"PVP",
		CFrame.new(260, 8, 60) * CFrame.Angles(0, math.rad(-35), 0)
	)
	local pAnchors = getAnchorsFromModel(pvpArena)
	local pvpInfo = {
		arenaId = "pvp_colosseum",
		arenaType = "PVP",
		instanceId = "Arena_battle-200_3",
		physicalSides = { "battle-200-A", "battle-200-B" },
	}

	local pvpClient1 = makeController()
	local pvpClient2 = makeController()

	-- Cliente 1 recebe sides relativo [A, B]; Cliente 2 recebe sides relativo [B, A]
	pvpClient1:onBattleStarted(makePayload({ "battle-200-A", "battle-200-B" }, { "battle-200-A", "battle-200-B" }, pvpInfo, "PVP"))
	pvpClient2:onBattleStarted(makePayload({ "battle-200-B", "battle-200-A" }, { "battle-200-A", "battle-200-B" }, pvpInfo, "PVP"))

	check(pvpClient1:getActiveArenaInstance() == pvpArena and pvpClient2:getActiveArenaInstance() == pvpArena, "C2: ambos clientes PvP resolvem a mesma instância física")
	check(pvpClient1.fightersByTargetId["battle-200-A-1"].sideIndex == 0, "C2: Cliente 1 coloca A em sideIndex 0 (Time A)")
	check(pvpClient2.fightersByTargetId["battle-200-A-1"].sideIndex == 0, "C2: Cliente 2 coloca A em sideIndex 0 (Time A, sem inverter!)")
	check(pvpClient1.fightersByTargetId["battle-200-B-1"].sideIndex == 1, "C2: Cliente 1 coloca B em sideIndex 1 (Time B)")
	check(pvpClient2.fightersByTargetId["battle-200-B-1"].sideIndex == 1, "C2: Cliente 2 coloca B em sideIndex 1 (Time B, sem inverter!)")

	-- Poses físicas idênticas entre Cliente 1 e Cliente 2 para TODOS os 6 lutadores
	for _, targetId in ipairs({ "battle-200-A-1", "battle-200-A-2", "battle-200-A-3", "battle-200-B-1", "battle-200-B-2", "battle-200-B-3" }) do
		local f1 = pvpClient1.fightersByTargetId[targetId]
		local f2 = pvpClient2.fightersByTargetId[targetId]
		assertCFrameClose(f1.model:GetPivot(), f2.model:GetPivot(), "C2: pose física consistente entre clientes PvP para " .. targetId)
	end
	assertAlignedToAnchor(pvpClient2.fightersByTargetId["battle-200-A-1"].model:GetPivot(), pAnchors.activeA, pvpClient2.fightersByTargetId["battle-200-A-1"], "C2: Cliente 2 A-1 em Current_Fighter_A")
	assertAlignedToAnchor(pvpClient2.fightersByTargetId["battle-200-B-1"].model:GetPivot(), pAnchors.activeB, pvpClient2.fightersByTargetId["battle-200-B-1"], "C2: Cliente 2 B-1 em Current_Fighter_B")

	-- Troca no lado B em PvP mantém ambos os clientes coerentes em Time B
	pvpClient1:onSwitchPerformed({ sideId = "battle-200-B", previousFighterId = "battle-200-B-1", activeFighterId = "battle-200-B-2" })
	pvpClient2:onSwitchPerformed({ sideId = "battle-200-B", previousFighterId = "battle-200-B-1", activeFighterId = "battle-200-B-2" })
	task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.1)
	assertAlignedToAnchor(pvpClient1.fightersByTargetId["battle-200-B-2"].model:GetPivot(), pAnchors.activeB, pvpClient1.fightersByTargetId["battle-200-B-2"], "C2: Cliente 1 B-2 em activeB após troca")
	assertAlignedToAnchor(pvpClient2.fightersByTargetId["battle-200-B-2"].model:GetPivot(), pAnchors.activeB, pvpClient2.fightersByTargetId["battle-200-B-2"], "C2: Cliente 2 B-2 em activeB após troca")

	pvpClient1:cleanupStage()
	pvpClient2:cleanupStage()
	pvpArena:Destroy()
	table.insert(scenarios, "C2_PVP_SAME_INSTANCE_AND_SIDES")

	-- =========================================================================
	-- Cenário 3: Arena movida e girada em 3D (translação + Yaw/Pitch/Roll) + GroundContact
	-- =========================================================================
	local rotatedDelta = CFrame.new(-310, 42, -195) * CFrame.Angles(math.rad(14), math.rad(123), math.rad(-9))
	local rotArena = cloneRealBasesIntoModel(activeArenasFolder, "Arena_battle-300_4", "pve_tilted", "PVE", rotatedDelta)
	local rAnchors = getAnchorsFromModel(rotArena)

	-- Asset sintético com Attachment GroundContact deslocado para validar preservação individual
	local customAssets = Instance.new("Folder")
	customAssets.Name = "L15CustomAssets"
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
	gcAtt.Position = Vector3.new(0.25, -2.75, -0.15)
	gcAtt.Parent = gcRoot
	gcModel.Parent = fightersFolder

	local rotCtrl = Combat.new(nil, customAssets, testRoot, 0.4)
	rotCtrl:initBillboardPool()
	table.insert(controllersToClean, rotCtrl)

	rotCtrl:onBattleStarted(makePayload(
		{ "battle-300-A", "battle-300-B" },
		{ "battle-300-A", "battle-300-B" },
		{ arenaId = "pve_tilted", arenaType = "PVE", instanceId = "Arena_battle-300_4", physicalSides = { "battle-300-A", "battle-300-B" } },
		"PVE"
	))

	local gcEntry = rotCtrl.fightersByTargetId["battle-300-A-1"]
	check(gcEntry ~= nil, "C3: lutador com GroundContact instanciado")
	check((gcEntry.groundContactOffset - Vector3.new(0.25, -2.75, -0.15)).Magnitude <= TOL, "C3: GroundContact individual preservado")
	local expectedTopWorld = (rAnchors.activeA.CFrame * CFrame.new(0, rAnchors.activeA.Size.Y * 0.5, 0)).Position
	local actualContactWorld = (gcEntry.model:GetPivot() * CFrame.new(gcEntry.groundContactOffset)).Position
	check((actualContactWorld - expectedTopWorld).Magnitude <= TOL, "C3: GroundContact coincide com face superior do anchor girado 3D")
	assertAlignedToAnchor(gcEntry.model:GetPivot(), rAnchors.activeA, gcEntry, "C3: orientação 3D completa preservada no anchor girado")

	rotCtrl:cleanupStage()
	rotArena:Destroy()
	customAssets:Destroy()
	table.insert(scenarios, "C3_ROTATED_AND_GROUND_CONTACT")

	-- =========================================================================
	-- Cenário 4: Espera limitada de replicação + proteção por geração
	-- =========================================================================
	local delayedCtrl = makeController(0.6)
	local delayedInfo = {
		arenaId = "pve_delayed",
		arenaType = "PVE",
		instanceId = "Arena_battle-400_5",
		physicalSides = { "battle-400-A", "battle-400-B" },
	}
	local delayedArena = nil
	task.delay(0.12, function()
		delayedArena = cloneRealBasesIntoModel(activeArenasFolder, "Arena_battle-400_5", "pve_delayed", "PVE", CFrame.new(80, 3, 210))
	end)
	delayedCtrl:onBattleStarted(makePayload({ "battle-400-A", "battle-400-B" }, { "battle-400-A", "battle-400-B" }, delayedInfo, "PVE"))
	check(delayedArena ~= nil and delayedCtrl:getActiveArenaInstance() == delayedArena, "C4: aguardou replicação atrasada da instância exata")
	check(countMap(delayedCtrl.fightersByTargetId) == 6, "C4: lutadores posicionados após replicação")
	local dAnchors = getAnchorsFromModel(delayedArena)
	assertAlignedToAnchor(delayedCtrl.fightersByTargetId["battle-400-A-1"].model:GetPivot(), dAnchors.activeA, delayedCtrl.fightersByTargetId["battle-400-A-1"], "C4: pose correta após espera")

	-- Proteção por geração: cleanupStage durante espera aborta batalha antiga sem poluir
	local genCtrl = makeController(0.5)
	local doneGenWait = false
	task.spawn(function()
		genCtrl:onBattleStarted(makePayload(
			{ "battle-401-A", "battle-401-B" },
			{ "battle-401-A", "battle-401-B" },
			{ arenaId = "pve_never", arenaType = "PVE", instanceId = "Arena_battle-401_6", physicalSides = { "battle-401-A", "battle-401-B" } },
			"PVE"
		))
		doneGenWait = true
	end)
	task.wait(0.06)
	genCtrl:cleanupStage()
	task.wait(0.12)
	check(doneGenWait, "C4: espera abortada prontamente após cleanupStage")
	check(countMap(genCtrl.fightersByTargetId) == 0 and genCtrl.stageFolder == nil, "C4: nenhum lutador ou stage vazado após abort por geração")

	delayedCtrl:cleanupStage()
	delayedArena:Destroy()
	table.insert(scenarios, "C4_REPLICATION_WAIT_AND_GENERATION")

	-- =========================================================================
	-- Cenário 5: Sem fallback para arena errada (ausente/timeout, ArenaId divergente, duplicidade)
	-- =========================================================================
	local otherArena = cloneRealBasesIntoModel(activeArenasFolder, "Arena_battle-500_7", "pve_other", "PVE", CFrame.new(-60, 0, -60))
	local noFallbackCtrl = makeController(0.12)

	-- 5a: instância inexistente (com decoy Arena_bases e otherArena presentes!)
	noFallbackCtrl:onBattleStarted(makePayload(
		{ "battle-501-A", "battle-501-B" },
		{ "battle-501-A", "battle-501-B" },
		{ arenaId = "pve_missing", arenaType = "PVE", instanceId = "Arena_battle-501_999", physicalSides = { "battle-501-A", "battle-501-B" } },
		"PVE"
	))
	check(countMap(noFallbackCtrl.fightersByTargetId) == 0, "C5a: timeout nunca posiciona lutadores em decoy/outra arena")
	check(noFallbackCtrl:getActiveArenaInstance() == nil and noFallbackCtrl.stageFolder == nil, "C5a: sem instância/stage em timeout")
	check(#noFallbackCtrl:getArenaAnchorDiagnostics() > 0, "C5a: diagnóstico registrado em timeout")

	-- 5b: ArenaId divergente do atributo da instância
	noFallbackCtrl:onBattleStarted(makePayload(
		{ "battle-502-A", "battle-502-B" },
		{ "battle-502-A", "battle-502-B" },
		{ arenaId = "pve_wrong_id", arenaType = "PVE", instanceId = "Arena_battle-500_7", physicalSides = { "battle-502-A", "battle-502-B" } },
		"PVE"
	))
	check(countMap(noFallbackCtrl.fightersByTargetId) == 0, "C5b: divergência de ArenaId rejeitada sem fallback")
	check(noFallbackCtrl:getActiveArenaInstance() == nil, "C5b: nenhuma arena vinculada em divergência")

	-- 5c: ArenaType divergente
	noFallbackCtrl:onBattleStarted(makePayload(
		{ "battle-503-A", "battle-503-B" },
		{ "battle-503-A", "battle-503-B" },
		{ arenaId = "pve_other", arenaType = "PVP", instanceId = "Arena_battle-500_7", physicalSides = { "battle-503-A", "battle-503-B" } },
		"PVP"
	))
	check(countMap(noFallbackCtrl.fightersByTargetId) == 0, "C5c: divergência de ArenaType rejeitada sem fallback")

	noFallbackCtrl:cleanupStage()
	otherArena:Destroy()
	table.insert(scenarios, "C5_NO_WRONG_ARENA_FALLBACK")
end)

for _, c in ipairs(controllersToClean) do
	pcall(function()
		c:cleanupStage()
		if c.damagePool then
			c.damagePool:destroy()
		end
	end)
end
pcall(function()
	testRoot:Destroy()
end)

assert(ok, err)
print(string.format("L1_5_ARENA_CLIENT_QA_PASSED checks=%d scenarios=%s", checks, table.concat(scenarios, ",")))
