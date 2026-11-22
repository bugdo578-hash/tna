-- Studio Play, Client. Valida L4.1.4 (infraestrutura de lado local/prontidão + simulação fiel do consumidor ArenaAmbientVFX)
-- sem modificar StarterPlayerScripts.ArenaAmbientVFX.
local run = game:GetService("RunService")
assert(run:IsStudio() and run:IsClient(), "Studio Client required")

local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local AmbientTests = require(ts.Controllers.CombatAmbientVfxTests)
local CameraTests = require(ts.Controllers.CombatCameraTests)
local FramingTests = require(ts.Controllers.CombatCameraFramingTests)
local CutsceneTests = require(ts.Controllers.CombatCutsceneTests)
local config = require(game.ReplicatedStorage.TS.Config)

-- 1. Suítes TS (nova L4.1.4 + regressão L2, L2.2, L4.2)
assert(AmbientTests.runL4_1_4AmbientVfxTests(), "L4.1.4 ambient VFX tests failed")
assert(CameraTests.runL2CameraTests(), "L2 camera tests failed")
assert(FramingTests.runL2_2AdaptiveCameraTests(), "L2.2 adaptive camera tests failed")
assert(CutsceneTests.runL4_2CameraCutsceneTests(), "L4.2 cutscene tests failed")

-- 2. Simulação fiel da lógica de tools/ArenaAmbientVFX.reference.luau em fixture isolado
--    (valida clonagem/ativação/desativação de Current_Figther_A_vfx_green e Current_Figther_B_vfx_red
--    com 2 arenas simultâneas, PvP lado A vs B, arco 180° e limpeza sem resíduos).
local root = Instance.new("Folder")
root.Name = "L414_ConsumerSimRoot"
local activeArenas = Instance.new("Folder", root)
activeArenas.Name = config.ACTIVE_ARENAS_FOLDER_NAME
local hostA = Instance.new("Folder", root)
local hostB = Instance.new("Folder", root)
local assets = FramingTests.cameraFramingTestFixtures.makeAssetsWithStandAndWeapon()

local function makeArenaWithVfx(instanceId, origin)
	local a = FramingTests.cameraFramingTestFixtures.makeOpen3v3Arena(activeArenas, instanceId, origin, 6)
	local green = Instance.new("Part")
	green.Name = "Current_Figther_A_vfx_green"
	green.Anchored = true
	green.CFrame = a.activeA.CFrame * CFrame.new(0, 0.5, 0)
	green.Parent = a.activeA
	local red = Instance.new("Part")
	red.Name = "Current_Figther_B_vfx_red"
	red.Anchored = true
	red.CFrame = a.activeB.CFrame * CFrame.new(0, 0.5, 0)
	red.Parent = a.activeB
	return a, green, red
end

local function createConsumerHarness(arenasFolder, stateNode)
	local enabledMap = {}
	local entries = {}
	local currentArena, currentSide, currentBattleId, currentGeneration
	local currentClones = {}

	local function applyEffect(effect, enabled)
		if effect and effect.Parent then
			enabledMap[effect] = enabled
		end
	end

	local function resolve(arena)
		if not arena or not arena:IsA("Model") then return nil end
		local bases = arena:FindFirstChild("Arena_bases")
		if not bases then return nil end
		local sideA = bases:FindFirstChild("Time A") and bases["Time A"]:FindFirstChild("Current_Fighter_A")
		local sideB = bases:FindFirstChild("Time B") and bases["Time B"]:FindFirstChild("Current_Fighter_B")
		if not sideA or not sideB then return nil end
		local green = sideA:FindFirstChild("Current_Figther_A_vfx_green")
		local red = sideB:FindFirstChild("Current_Figther_B_vfx_red")
		if not green or not red then return nil end
		local entry = { sideA = sideA, sideB = sideB, green = green, red = red }
		entries[arena] = entry
		applyEffect(green, false)
		applyEffect(red, false)
		return entry
	end

	local function cloneEffect(source, sourceAnchor, targetAnchor)
		local clone = source:Clone()
		local delta = targetAnchor.CFrame * sourceAnchor.CFrame:Inverse()
		clone.Name = "Local_" .. source.Name
		clone.Parent = targetAnchor
		if clone:IsA("BasePart") then clone.CFrame = delta * clone.CFrame end
		applyEffect(clone, false)
		return clone
	end

	local function clearCurrent()
		local entry = currentArena and entries[currentArena] or nil
		if entry then
			applyEffect(entry.green, false)
			applyEffect(entry.red, false)
		end
		for _, clone in currentClones do
			applyEffect(clone, false)
			clone:Destroy()
		end
		table.clear(currentClones)
		currentArena, currentSide, currentBattleId, currentGeneration = nil, nil, nil, nil
	end

	local function reconcile()
		local active = stateNode:GetAttribute("Active") == true
		local fightersReady = stateNode:GetAttribute("FightersReady") == true
		local goOccurred = stateNode:GetAttribute("GoOccurred") == true
		local battleId = stateNode:GetAttribute("BattleId")
		local generation = stateNode:GetAttribute("Generation")
		local instanceId = stateNode:GetAttribute("ArenaInstanceId")
		local sideStr = stateNode:GetAttribute("LocalSide")
		local sideIdx = stateNode:GetAttribute("LocalSideIndex")
		local side = if sideStr == "A" and sideIdx == 1 then 1 elseif sideStr == "B" and sideIdx == 2 then 2 else nil
		if not (active and fightersReady and goOccurred and type(battleId) == "string" and battleId ~= ""
			and type(generation) == "number" and generation > 0 and type(instanceId) == "string" and instanceId ~= "" and side) then
			clearCurrent()
			return
		end
		local targetArena
		for _, arena in arenasFolder:GetChildren() do
			if arena:IsA("Model") and (arena.Name == instanceId or arena:GetAttribute("ArenaInstanceId") == instanceId) then
				targetArena = arena
				break
			end
		end
		if not targetArena then clearCurrent(); return end
		if currentArena == targetArena and currentSide == side and currentBattleId == battleId and currentGeneration == generation then
			return
		end
		clearCurrent()
		local entry = entries[targetArena] or resolve(targetArena)
		if not entry then return end
		currentArena, currentSide, currentBattleId, currentGeneration = targetArena, side, battleId, generation
		if side == 1 then
			applyEffect(entry.green, true)
			applyEffect(entry.red, true)
		else
			applyEffect(entry.green, false)
			applyEffect(entry.red, false)
			local redOnA = cloneEffect(entry.red, entry.sideB, entry.sideA)
			local greenOnB = cloneEffect(entry.green, entry.sideA, entry.sideB)
			table.insert(currentClones, redOnA)
			table.insert(currentClones, greenOnB)
			applyEffect(redOnA, true)
			applyEffect(greenOnB, true)
		end
	end

	for _, arena in arenasFolder:GetChildren() do resolve(arena) end
	local c1 = stateNode:GetAttributeChangedSignal("Revision"):Connect(reconcile)
	local c2 = stateNode:GetAttributeChangedSignal("Active"):Connect(reconcile)
	reconcile()
	return {
		isEnabled = function(inst) return enabledMap[inst] == true end,
		getClones = function() return currentClones end,
		getCurrentArena = function() return currentArena end,
		getCurrentSide = function() return currentSide end,
		destroy = function() c1:Disconnect(); c2:Disconnect(); clearCurrent() end,
	}
end

local arena1, g1, r1 = makeArenaWithVfx("arena_qa_1", CFrame.new(200, 10, 0))
local arena2, g2, r2 = makeArenaWithVfx("arena_qa_2", CFrame.new(250, 10, 0))
local camA = Instance.new("Camera")
local camB = Instance.new("Camera")
local ctrlA = Combat.new(nil, assets, root, 0.2, function() return camA end, function() return Vector2.new(1920, 1080) end, nil, hostA)
local ctrlB = Combat.new(nil, assets, root, 0.2, function() return camB end, function() return Vector2.new(1920, 1080) end, nil, hostB)
local consA = createConsumerHarness(activeArenas, ctrlA:getAmbientVfxStateInstance())
local consB = createConsumerHarness(activeArenas, ctrlB:getAmbientVfxStateInstance())

local ok, err = xpcall(function()
	-- PvP cliente A (Time A) na arena 1, cliente B (Time B) na arena 2 simultaneamente
	ctrlA:onBattleTransition({ id = 10, phase = "cover" })
	ctrlB:onBattleTransition({ id = 20, phase = "cover" })
	ctrlA:onBattleStarted({
		transitionId = 10,
		sides = { "A1", "B1" },
		fighters = FramingTests.cameraFramingTestFixtures.make3v3Fighters("A1", "B1"),
		mode = "PVP",
		canPause = false,
		arena = { instanceId = "arena_qa_1", arenaId = "Arena_01", physicalSides = { "A1", "B1" } },
	})
	ctrlB:onBattleStarted({
		transitionId = 20,
		sides = { "B2", "A2" },
		fighters = FramingTests.cameraFramingTestFixtures.make3v3Fighters("A2", "B2"),
		mode = "PVP",
		canPause = false,
		arena = { instanceId = "arena_qa_2", arenaId = "Arena_01", physicalSides = { "A2", "B2" } },
	})
	task.wait(0.05)

	-- Antes de GO!: tudo desligado em ambas as arenas mesmo com câmeras no lado oposto
	camA.CFrame = arena1.cameraB.CFrame
	camB.CFrame = arena2.cameraA.CFrame
	assert(not consA.isEnabled(g1) and not consA.isEnabled(r1), "Arena 1 não pode ativar antes do GO!")
	assert(not consB.isEnabled(g2) and not consB.isEnabled(r2) and #consB.getClones() == 0, "Arena 2 não pode ativar antes do GO!")

	-- GO! apenas para batalha 10 (Time A na arena 1)
	ctrlA:onStateChanged({ state = "IDLE", battleReleased = 10 })
	assert(consA.isEnabled(g1) and consA.isEnabled(r1), "Arena 1 deve ativar green(A) e red(B) após GO!")
	assert(not consA.isEnabled(g2) and not consA.isEnabled(r2), "Cliente A não pode ativar arena alheia 2")
	assert(#consB.getClones() == 0 and not consB.isEnabled(g2), "Cliente B ainda sem GO! permanece oculto")

	-- GO! para batalha 20 (Time B na arena 2) -> clona red em A e green em B
	ctrlB:onStateChanged({ state = "IDLE", battleReleased = 20 })
	assert(consB.getCurrentArena() == arena2.model and consB.getCurrentSide() == 2, "Cliente B fixado no lado 2 da arena 2")
	assert(not consB.isEnabled(g2) and not consB.isEnabled(r2), "Originais da arena 2 ficam desligados para Time B")
	assert(#consB.getClones() == 2, "Time B cria exatamente 2 clones locais (red em A, green em B)")
	local redOnA = arena2.activeA:FindFirstChild("Local_Current_Figther_B_vfx_red")
	local greenOnB = arena2.activeB:FindFirstChild("Local_Current_Figther_A_vfx_green")
	assert(redOnA and greenOnB and consB.isEnabled(redOnA) and consB.isEnabled(greenOnB),
		"Time B deve ver verde em B e vermelho em A")

	-- Exit limpa imediatamente sem deixar clones residuais
	ctrlA:onBattleTransition({ id = 10, phase = "exit" })
	ctrlB:onBattleTransition({ id = 20, phase = "exit" })
	assert(not consA.isEnabled(g1) and not consA.isEnabled(r1), "Exit limpa arena 1 imediatamente")
	assert(#consB.getClones() == 0 and not arena2.activeA:FindFirstChild("Local_Current_Figther_B_vfx_red")
		and not arena2.activeB:FindFirstChild("Local_Current_Figther_A_vfx_green"),
		"Exit destrói clones locais da arena 2 imediatamente")
end, debug.traceback)

consA.destroy()
consB.destroy()
ctrlA:cleanupStage()
ctrlB:cleanupStage()
camA:Destroy()
camB:Destroy()
assets:Destroy()
root:Destroy()
assert(ok, err)
return "L4_1_4_AMBIENT_VFX_QA_PASSED"
