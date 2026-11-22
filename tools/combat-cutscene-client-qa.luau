-- Studio Play, Client. Valida L4.2 (infraestrutura de cutscenes de câmera) + regressão de câmera L2/L2.2.
local run = game:GetService("RunService")
assert(run:IsStudio() and run:IsClient(), "Studio Client required")

local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local CutsceneRegistry = require(ts.Controllers.CombatCutsceneRegistry)
local CutsceneTests = require(ts.Controllers.CombatCutsceneTests)
local CameraTests = require(ts.Controllers.CombatCameraTests)
local FramingTests = require(ts.Controllers.CombatCameraFramingTests)
local config = require(game.ReplicatedStorage.TS.Config)

-- 1. Confirma contrato de produção: nenhuma cutscene falsa cadastrada no catálogo padrão
assert(CutsceneRegistry.defaultCombatCutsceneRegistry:getRegisteredCount() == 0,
	"Produção não pode ter cutscenes cadastradas neste lote")

-- 2. Executa suítes de regressão L2, L2.2 e suíte dedicada L4.2
assert(CameraTests.runL2CameraTests(), "L2 camera tests failed")
assert(FramingTests.runL2_2AdaptiveCameraTests(), "L2.2 adaptive camera tests failed")
assert(CutsceneTests.runL4_2CameraCutsceneTests(), "L4.2 cutscene tests failed")

-- 3. Verifica loop real de PreRender em fixture isolado (entrada -> reprodução -> blend-out -> adaptive -> teardown)
local root = Instance.new("Folder")
root.Name = "L42_LivePreRenderRoot"
local activeArenas = Instance.new("Folder", root)
activeArenas.Name = config.ACTIVE_ARENAS_FOLDER_NAME
local assets = FramingTests.cameraFramingTestFixtures.makeAssetsWithStandAndWeapon()
local arena = FramingTests.cameraFramingTestFixtures.makeOpen3v3Arena(
	activeArenas,
	"arena_l42_live",
	CFrame.new(250, 14, -140) * CFrame.Angles(0, math.rad(55), 0),
	6
)
local subject = Instance.new("Part", root)
local camera = Instance.new("Camera")
camera.CameraType = Enum.CameraType.Custom
camera.CameraSubject = subject
camera.CFrame = CFrame.new(1, 10, -15)
camera.FieldOfViewMode = Enum.FieldOfViewMode.Diagonal
camera.FieldOfView = 72
local origCF = camera.CFrame

local testRegistry = CutsceneRegistry.CombatCutsceneRegistry.new()
assert(testRegistry:registerByFighterSlot("jotaro", 3, {
	id = "qa_live_prerender",
	duration = 0.25,
	referenceSpace = "arena",
	blendInDuration = 0.05,
	blendOutDuration = 0.15,
	keyframes = {
		{ time = 0, cframe = CFrame.lookAt(Vector3.new(0, 5, 9), Vector3.new(0, 1.5, 0)), fieldOfView = 54 },
		{ time = 0.25, cframe = CFrame.lookAt(Vector3.new(3, 4, 8), Vector3.new(0, 1.5, 0)), fieldOfView = 62 },
	},
}), "Falha ao registrar fixture PreRender")

local ctrl = Combat.new(nil, assets, root, 0.2, function() return camera end, function() return Vector2.new(1920, 1080) end, testRegistry)
local ok, err = xpcall(function()
	ctrl:onBattleStarted({
		sides = { "LIVEA", "LIVEB" },
		fighters = FramingTests.cameraFramingTestFixtures.make3v3Fighters("LIVEA", "LIVEB"),
		mode = "PVE",
		canPause = true,
		arena = { instanceId = arena.model.Name, arenaId = "Arena_01", physicalSides = { "LIVEA", "LIVEB" } },
	})
	local adaptive = assert(ctrl:getLastAppliedCameraFrame(), "Frame adaptativo ausente")
	ctrl:onAttackStarted({ attackerId = "LIVEA-1", targetId = "LIVEB-1", slot = 3 })
	assert(ctrl:getCameraMode() == "cutscene", "Cutscene não iniciou via AttackStarted")
	task.wait(0.12)
	assert((camera.CFrame.Position - adaptive.cframe.Position).Magnitude > 0.5, "Câmera não saiu do enquadramento adaptativo durante cutscene")
	-- Aguarda conclusão natural + blend-out via PreRender real
	local deadline = os.clock() + 1.5
	repeat task.wait() until not ctrl:getCutsceneController():isActive() or os.clock() >= deadline
	assert(not ctrl:getCutsceneController():isActive(), "Cutscene não finalizou pelo PreRender")
	assert(ctrl:getCameraMode() == "adaptive", "Modo não retornou a adaptive após blend-out")
	assert((camera.CFrame.Position - adaptive.cframe.Position).Magnitude < 0.01, "CFrame não retornou ao adaptativo L2.2")
	assert(math.abs(camera.FieldOfView - adaptive.fieldOfView) < 0.01, "FOV não retornou ao adaptativo L2.2")

	-- Teardown durante cutscene ativa restaura câmera imediatamente
	ctrl:onAttackStarted({ attackerId = "LIVEA-1", targetId = "LIVEB-1", slot = 3 })
	assert(ctrl:getCameraMode() == "cutscene", "Segunda cutscene não iniciou")
	ctrl:cleanupStage()
	assert(not ctrl:getCutsceneController():isActive(), "Teardown não cancelou cutscene")
	assert(camera.CameraType == Enum.CameraType.Custom and camera.CameraSubject == subject, "Teardown não restaurou CameraType/Subject")
	assert(camera.FieldOfViewMode == Enum.FieldOfViewMode.Diagonal and math.abs(camera.FieldOfView - 72) < 0.001, "Teardown não restaurou FOV/Mode")
	assert((camera.CFrame.Position - origCF.Position).Magnitude < 0.001, "Teardown não restaurou CFrame original")
end, debug.traceback)

ctrl:cleanupStage()
camera:Destroy()
assets:Destroy()
root:Destroy()
assert(ok, err)
return "L4_2_CAMERA_CUTSCENE_QA_PASSED"
