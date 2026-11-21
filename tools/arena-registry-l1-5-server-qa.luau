-- Execute no Server em Play novo após rbxtsc/Rojo.
-- QA L1.5 (Server): valida ArenaRegistry + integração BattleSessionService/NpcService/PvpService
-- e testa clones reais de Workspace.Arena_bases com Script ambiental + ReplicatedStorage.Part_Icles.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local ServerStorage = game:GetService("ServerStorage")

local tsServer = ServerScriptService:WaitForChild("TS")
local ArenaRegistryMod = require(tsServer.Services.ArenaRegistry)
local ArenaTestsMod = require(tsServer.Dev.tests.arenaRegistryTests)
local sharedArena = require(ReplicatedStorage.TS.configs.Arena)

local checks = 0
local function check(condition, message)
	checks += 1
	assert(condition, message)
end

-- 1) Suíte unitária/integração completa do servidor (TS -> Luau)
ArenaTestsMod.validateArenaRegistry()
check(true, "validateArenaRegistry executada com sucesso")

-- 2) Teste real com clones de Workspace.Arena_bases + Script ambiental + ReplicatedStorage.Part_Icles
local realBases = workspace:FindFirstChild(sharedArena.ARENA_BASES_CONTAINER_NAME)
check(realBases ~= nil, "Workspace.Arena_bases precisa existir no Studio")
local realScript = realBases:FindFirstChildOfClass("Script")
check(realScript ~= nil, "Workspace.Arena_bases.Script precisa existir para validar VFX ambiental")

local tempTemplates = Instance.new("Folder")
tempTemplates.Name = "L15RealVfxTemplatesTemp"
tempTemplates.Parent = ServerStorage

local function buildRealArenaTemplate(arenaId, arenaType, offsetCFrame)
	local model = Instance.new("Model")
	model.Name = "Template_" .. arenaId
	model:SetAttribute(sharedArena.ARENA_ID_ATTRIBUTE, arenaId)
	model:SetAttribute(sharedArena.ARENA_TYPE_ATTRIBUTE, arenaType)
	local cloneBases = realBases:Clone()
	-- Limpa atributos de runtime copiados do Workspace para provar ativação fresca no clone
	local g = cloneBases["Time A"].Current_Fighter_A.Current_Figther_A_vfx_green
	local r = cloneBases["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red
	g:SetAttribute("_PartIclePlaying", nil)
	g:SetAttribute("_emitGen", nil)
	r:SetAttribute("_PartIclePlaying", nil)
	r:SetAttribute("_emitGen", nil)
	cloneBases.Parent = model
	if cloneBases:IsA("BasePart") then
		model.PrimaryPart = cloneBases
	end
	if offsetCFrame ~= nil then
		local originCF = cloneBases:IsA("BasePart") and cloneBases.CFrame or cloneBases:GetPivot()
		local delta = (offsetCFrame * originCF) * originCF:Inverse()
		if cloneBases:IsA("BasePart") then
			cloneBases.CFrame = delta * cloneBases.CFrame
		end
		for _, desc in ipairs(cloneBases:GetDescendants()) do
			if desc:IsA("BasePart") then
				desc.CFrame = delta * desc.CFrame
			end
		end
	end
	model.Parent = tempTemplates
	return model
end

local registry = ArenaRegistryMod.ArenaRegistry.new({
	templatesContainer = tempTemplates,
	activeArenasParent = workspace,
	activeArenasFolderName = "L15ActiveArenasVfxTest",
})

local function waitUntil(timeoutSec, predicate)
	local deadline = os.clock() + timeoutSec
	while os.clock() < deadline do
		if predicate() then
			return true
		end
		task.wait(0.05)
	end
	return predicate()
end

local vfxSummary = ""
local ok, err = pcall(function()
	buildRealArenaTemplate("studio_real_pve_1", "PVE", CFrame.new(180, 0, 180))
	buildRealArenaTemplate("studio_real_pve_2", "PVE", CFrame.new(-180, 0, 180))
	local discovered = registry:discoverTemplates()
	check(#discovered == 2, "2 templates reais derivados de Workspace.Arena_bases descobertos")

	local r1 = registry:reserveForSession("vfx-session-1", "PVE")
	local r2 = registry:reserveForSession("vfx-session-2", "PVE")
	check(r1.ok and r1.reservation ~= nil, "reserva real VFX 1")
	check(r2.ok and r2.reservation ~= nil, "reserva real VFX 2")
	check(r1.reservation.arenaId ~= r2.reservation.arenaId, "duas arenas reais distintas")

	local inst1 = r1.reservation.instance
	local inst2 = r2.reservation.instance
	local green1 = inst1:FindFirstChild("Arena_bases")["Time A"].Current_Fighter_A.Current_Figther_A_vfx_green
	local red1 = inst1:FindFirstChild("Arena_bases")["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red
	local green2 = inst2:FindFirstChild("Arena_bases")["Time A"].Current_Fighter_A.Current_Figther_A_vfx_green
	local red2 = inst2:FindFirstChild("Arena_bases")["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red
	check(green1 ~= green2 and red1 ~= red2, "emissores ambientais são instâncias distintas por clone")
	check(green1.Link.Value == green1 and red1.Link.Value == red1, "ObjectValue Link do clone 1 aponta para o próprio clone 1")
	check(green2.Link.Value == green2 and red2.Link.Value == red2, "ObjectValue Link do clone 2 aponta para o próprio clone 2")

	-- Aguarda Scripts clonados ativarem Part_Icles nos 2 clones reais
	local activated = waitUntil(2.5, function()
		return green1:GetAttribute("_PartIclePlaying") == true
			and red1:GetAttribute("_PartIclePlaying") == true
			and green2:GetAttribute("_PartIclePlaying") == true
			and red2:GetAttribute("_PartIclePlaying") == true
	end)
	check(activated, "Scripts clonados ativaram _PartIclePlaying em ambos os clones (green/red)")

	local rtG1 = green1:FindFirstChild("RenderTemplate")
	local rtR1 = red1:FindFirstChild("RenderTemplate")
	local rtG2 = green2:FindFirstChild("RenderTemplate")
	local rtR2 = red2:FindFirstChild("RenderTemplate")
	check(rtG1 ~= nil and rtR1 ~= nil and rtG2 ~= nil and rtR2 ~= nil, "RenderTemplate presentes em ambos os clones")

	local cG1a, cR1a, cG2a, cR2a = rtG1.CFrame, rtR1.CFrame, rtG2.CFrame, rtR2.CFrame
	local bothAnimatingBefore = waitUntil(1.0, function()
		return rtG1.CFrame ~= cG1a and rtR1.CFrame ~= cR1a and rtG2.CFrame ~= cG2a and rtR2.CFrame ~= cR2a
	end)
	check(bothAnimatingBefore, "RenderTemplate de ambas as arenas está animando (Part_Icles ativo nos clones)")

	-- Libera e destrói APENAS a arena 1
	check(registry:releaseReservation(r1.reservation), "liberação da arena real 1")
	check(inst1.Parent == nil, "arena 1 destruída")
	check(inst2.Parent ~= nil, "arena 2 permanece ativa")

	-- Verifica que a arena 2 continua animando normalmente após destruir a arena 1
	local cG2b, cR2b = rtG2.CFrame, rtR2.CFrame
	local arena2AnimatingAfter = waitUntil(1.0, function()
		return green2:GetAttribute("_PartIclePlaying") == true
			and red2:GetAttribute("_PartIclePlaying") == true
			and rtG2.CFrame ~= cG2b
			and rtR2.CFrame ~= cR2b
	end)
	check(green2:GetAttribute("_PartIclePlaying") == true and red2:GetAttribute("_PartIclePlaying") == true, "VFX da arena 2 permanece _PartIclePlaying=true após destruir arena 1")
	check(arena2AnimatingAfter, "RenderTemplate da arena 2 continuou animando após destruir arena 1")

	-- Libera arena 2 e confere cleanup completo
	check(registry:releaseReservation(r2.reservation), "liberação da arena real 2")
	check(inst2.Parent == nil, "arena 2 destruída")
	check(registry:getReleaseCount() == 2, "exatamente 2 liberações contabilizadas")

	vfxSummary = string.format(
		"activated=%s bothAnimatingBefore=%s arena2AnimatingAfter=%s",
		tostring(activated), tostring(bothAnimatingBefore), tostring(arena2AnimatingAfter)
	)
end)

pcall(function() registry:destroy() end)
pcall(function()
	local f = workspace:FindFirstChild("L15ActiveArenasVfxTest")
	if f then f:Destroy() end
end)
pcall(function() tempTemplates:Destroy() end)

assert(ok, err)
print(string.format("L1_5_ARENA_SERVER_QA_PASSED checks=%d vfx=%s", checks, vfxSummary))
