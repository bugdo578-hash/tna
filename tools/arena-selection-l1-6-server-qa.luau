-- Execute no Server em Play novo após rbxtsc/Rojo.
-- QA L1.6 (Server): valida catálogo universal, seleção aleatória, não repetição imediata,
-- reutilização simultânea do mesmo template real (Workspace.Arena_01) em slots físicos distintos
-- sem sobreposição e isolamento de VFX ambiental (Script + ReplicatedStorage.Part_Icles).
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local ServerStorage = game:GetService("ServerStorage")

local tsServer = ServerScriptService:WaitForChild("TS")
local ArenaRegistryMod = require(tsServer.Services.ArenaRegistry)
local ArenaRegistryTestsMod = require(tsServer.Dev.tests.arenaRegistryTests)
local ArenaSelectionTestsMod = require(tsServer.Dev.tests.arenaSelectionTests)
local sharedArena = require(ReplicatedStorage.TS.configs.Arena)

local checks = 0
local function check(condition, message)
	checks += 1
	assert(condition, message)
end

-- 1) Suítes unitárias/integração do servidor (TS -> Luau)
ArenaRegistryTestsMod.validateArenaRegistry()
check(true, "validateArenaRegistry executada com sucesso")
ArenaSelectionTestsMod.validateArenaSelectionL16()
check(true, "validateArenaSelectionL16 executada com sucesso")

-- 2) Teste real com clones simultâneos do MESMO template real em slots físicos distintos + VFX Part_Icles
local realArenaModel = workspace:FindFirstChild("Arena_01")
local realBases = if realArenaModel then realArenaModel:FindFirstChild(sharedArena.ARENA_BASES_CONTAINER_NAME) else workspace:FindFirstChild(sharedArena.ARENA_BASES_CONTAINER_NAME)
check(realBases ~= nil, "Arena_bases real precisa existir no Studio (Workspace.Arena_01.Arena_bases ou Workspace.Arena_bases)")
local realScript = realBases:FindFirstChildOfClass("Script")
check(realScript ~= nil, "Arena_bases.Script precisa existir para validar VFX ambiental")

local tempTemplates = Instance.new("Folder")
tempTemplates.Name = "L16RealTemplatesTemp"
tempTemplates.Parent = ServerStorage

local tempSlots = Instance.new("Folder")
tempSlots.Name = "L16RealSlotsTemp"
tempSlots.Parent = workspace

local function clearRuntimeParticleAttrs(basesContainer)
	local g = basesContainer["Time A"].Current_Fighter_A.Current_Figther_A_vfx_green
	local r = basesContainer["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red
	g:SetAttribute("_PartIclePlaying", nil)
	g:SetAttribute("_emitGen", nil)
	r:SetAttribute("_PartIclePlaying", nil)
	r:SetAttribute("_emitGen", nil)
end

local function buildRealTemplateFromStudio(visualName, arenaId)
	local model
	if realArenaModel and realArenaModel:IsA("Model") then
		model = realArenaModel:Clone()
		model.Name = visualName
		clearRuntimeParticleAttrs(model:FindFirstChild(sharedArena.ARENA_BASES_CONTAINER_NAME))
	else
		model = Instance.new("Model")
		model.Name = visualName
		local cloneBases = realBases:Clone()
		clearRuntimeParticleAttrs(cloneBases)
		cloneBases.Parent = model
		if cloneBases:IsA("BasePart") then
			model.PrimaryPart = cloneBases
		end
	end
	model:SetAttribute(sharedArena.ARENA_ID_ATTRIBUTE, arenaId)
	-- Sem ArenaType: catálogo universal L1.6
	model:SetAttribute(sharedArena.ARENA_TYPE_ATTRIBUTE, nil)
	model.Parent = tempTemplates
	return model
end

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

local registry = ArenaRegistryMod.ArenaRegistry.new({
	templatesContainer = tempTemplates,
	slotsContainer = tempSlots,
	activeArenasParent = workspace,
	activeArenasFolderName = "L16ActiveArenasRealTest",
	rng = function() return 0.0 end,
})

local vfxSummary = ""
local ok, err = pcall(function()
	-- Apenas 1 template real (clone simultâneo do MESMO template em 2 slots físicos distintos!)
	local templateModel = buildRealTemplateFromStudio("Arena_01", "studio_island_universal")
	local origPivot = templateModel:GetPivot()
	local origBases = templateModel:FindFirstChild(sharedArena.ARENA_BASES_CONTAINER_NAME)
	local origCurA = origBases["Time A"].Current_Fighter_A
	local origVfxA = origCurA.Current_Figther_A_vfx_green
	local relCurA = origPivot:ToObjectSpace(origCurA.CFrame)
	local relVfxA = origCurA.CFrame:ToObjectSpace(origVfxA.CFrame)

	-- Slot 1 via BasePart, Slot 2 via Attachment (separados > 400 studs, com rotações diferentes)
	local slot1CF = CFrame.new(1450, 30, -350) * CFrame.Angles(0, math.rad(25), 0)
	local slot1Part = Instance.new("Part")
	slot1Part.Name = "Slot_01"
	slot1Part.Anchored = true
	slot1Part.CanCollide = false
	slot1Part.Size = Vector3.new(4, 1, 4)
	slot1Part.CFrame = slot1CF
	slot1Part.Parent = tempSlots

	local holder = Instance.new("Part")
	holder.Name = "SlotHolder"
	holder.Anchored = true
	holder.CanCollide = false
	holder.Size = Vector3.new(4, 1, 4)
	holder.CFrame = CFrame.new(1950, 45, 180)
	holder.Parent = tempSlots
	local slot2Att = Instance.new("Attachment")
	slot2Att.Name = "Slot_02"
	slot2Att.CFrame = CFrame.new(0, 2, 0) * CFrame.Angles(0, math.rad(-115), 0)
	slot2Att.Parent = holder

	registry:start()
	check(#registry:getRegisteredTemplates() == 1, "1 template universal real descoberto sem ArenaType")
	check(#registry:getRegisteredSlots() == 2, "2 slots físicos reais (BasePart + Attachment) descobertos")

	-- Reserva simultânea do MESMO template para PVE e PVP
	local r1 = registry:reserveForSession("l16-real-pve", "PVE", { participantKeys = { "u:1001" } })
	local r2 = registry:reserveForSession("l16-real-pvp", "PVP", { participantKeys = { "u:1002", "u:1003" } })
	check(r1.ok and r1.reservation ~= nil, "reserva real 1 (PVE)")
	check(r2.ok and r2.reservation ~= nil, "reserva real 2 simultânea no mesmo template (PVP)")
	check(r1.reservation.arenaId == "studio_island_universal" and r2.reservation.arenaId == "studio_island_universal", "ambas usam o mesmo ArenaId simultaneamente")
	check(r1.reservation.instanceId ~= r2.reservation.instanceId, "ArenaInstanceId exclusivos")
	check(r1.reservation.slotId ~= r2.reservation.slotId, "slots físicos distintos")

	-- Capacidade física esgotada (2/2) -> recusa sem criar arena infinita
	local r3 = registry:reserveForSession("l16-real-boss", "BOSS", { participantKeys = { "u:1004" } })
	check(not r3.ok and r3.reason == "no_slot_available", "3ª batalha recusada por capacidade física esgotada")

	local inst1 = r1.reservation.instance
	local inst2 = r2.reservation.instance
	local pivot1 = inst1:GetPivot()
	local pivot2 = inst2:GetPivot()
	check((pivot1.Position - slot1CF.Position).Magnitude < 1e-2, "clone 1 posicionado exatamente em Slot_01")
	check((pivot2.Position - slot2Att.WorldCFrame.Position).Magnitude < 1e-2, "clone 2 posicionado exatamente em Slot_02")
	check((pivot1.Position - pivot2.Position).Magnitude > 400, "clones simultâneos sem sobreposição física (>400 studs)")

	-- Layout interno preservado (anchors e VFX mantêm exatamente a mesma relação com o pivot)
	local bases1 = inst1:FindFirstChild(sharedArena.ARENA_BASES_CONTAINER_NAME)
	local bases2 = inst2:FindFirstChild(sharedArena.ARENA_BASES_CONTAINER_NAME)
	local curA1 = bases1["Time A"].Current_Fighter_A
	local curA2 = bases2["Time A"].Current_Fighter_A
	local green1 = curA1.Current_Figther_A_vfx_green
	local red1 = bases1["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red
	local green2 = curA2.Current_Figther_A_vfx_green
	local red2 = bases2["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red

	check((pivot1:ToObjectSpace(curA1.CFrame).Position - relCurA.Position).Magnitude < 1e-2, "relação pivot->anchor preservada no clone 1")
	check((pivot2:ToObjectSpace(curA2.CFrame).Position - relCurA.Position).Magnitude < 1e-2, "relação pivot->anchor preservada no clone 2")
	check((curA1.CFrame:ToObjectSpace(green1.CFrame).Position - relVfxA.Position).Magnitude < 1e-2, "relação anchor->VFX preservada no clone 1")
	check((curA2.CFrame:ToObjectSpace(green2.CFrame).Position - relVfxA.Position).Magnitude < 1e-2, "relação anchor->VFX preservada no clone 2")
	check(green1 ~= green2 and red1 ~= red2, "emissores VFX são instâncias independentes entre clones do mesmo template")

	-- Aguarda Scripts clonados ativarem Part_Icles nos 2 clones reais simultâneos
	local activated = waitUntil(2.5, function()
		return green1:GetAttribute("_PartIclePlaying") == true
			and red1:GetAttribute("_PartIclePlaying") == true
			and green2:GetAttribute("_PartIclePlaying") == true
			and red2:GetAttribute("_PartIclePlaying") == true
	end)
	check(activated, "Scripts clonados ativaram _PartIclePlaying em ambos os clones simultâneos do mesmo template")

	local rtG1 = green1:FindFirstChild("RenderTemplate")
	local rtR1 = red1:FindFirstChild("RenderTemplate")
	local rtG2 = green2:FindFirstChild("RenderTemplate")
	local rtR2 = red2:FindFirstChild("RenderTemplate")
	check(rtG1 ~= nil and rtR1 ~= nil and rtG2 ~= nil and rtR2 ~= nil, "RenderTemplate presentes em ambos os clones")

	local cG1a, cR1a, cG2a, cR2a = rtG1.CFrame, rtR1.CFrame, rtG2.CFrame, rtR2.CFrame
	local bothAnimatingBefore = waitUntil(1.0, function()
		return rtG1.CFrame ~= cG1a and rtR1.CFrame ~= cR1a and rtG2.CFrame ~= cG2a and rtR2.CFrame ~= cR2a
	end)
	check(bothAnimatingBefore, "Part_Icles animando simultaneamente nos dois clones em slots separados")

	-- Destrói apenas o clone 1 -> libera Slot_01 sem afetar clone 2
	check(registry:releaseReservation(r1.reservation), "liberação do clone 1")
	check(inst1.Parent == nil, "clone 1 destruído")
	check(inst2.Parent ~= nil, "clone 2 permanece ativo")
	check(registry:getAvailableSlotCount() == 1, "Slot_01 liberado após destruição do clone 1")

	local cG2b, cR2b = rtG2.CFrame, rtR2.CFrame
	local clone2AnimatingAfter = waitUntil(1.0, function()
		return green2:GetAttribute("_PartIclePlaying") == true
			and red2:GetAttribute("_PartIclePlaying") == true
			and rtG2.CFrame ~= cG2b
			and rtR2.CFrame ~= cR2b
	end)
	check(clone2AnimatingAfter, "VFX do clone 2 continuou animando normalmente após destruir clone 1 do mesmo template")

	-- Nova batalha BOSS reutiliza o espaço físico recém-liberado
	local r4 = registry:reserveForSession("l16-real-boss-reused", "BOSS", { participantKeys = { "u:1004" } })
	check(r4.ok and r4.reservation ~= nil and r4.reservation.slotId == r1.reservation.slotId, "slot liberado reutilizado por nova batalha BOSS")
	check(not registry:releaseReservation(r1.reservation), "cleanup atrasado do clone 1 não afeta r4")
	check(r4.reservation.instance.Parent ~= nil, "r4 permanece ativo após cleanup atrasado")

	check(registry:releaseReservation(r2.reservation), "liberação do clone 2")
	check(registry:releaseReservation(r4.reservation), "liberação do clone 4")
	check(registry:getAvailableSlotCount() == 2, "todos os slots livres ao encerrar")
	check(registry:getReleaseCount() == 3, "exatamente 3 liberações contabilizadas")

	vfxSummary = string.format(
		"source=%s activated=%s bothAnimating=%s clone2After=%s",
		realArenaModel and "Arena_01" or "Arena_bases",
		tostring(activated), tostring(bothAnimatingBefore), tostring(clone2AnimatingAfter)
	)
end)

pcall(function() registry:destroy() end)
pcall(function()
	local f = workspace:FindFirstChild("L16ActiveArenasRealTest")
	if f then f:Destroy() end
end)
pcall(function() tempSlots:Destroy() end)
pcall(function() tempTemplates:Destroy() end)

assert(ok, err)
print(string.format("L1_6_ARENA_SERVER_QA_PASSED checks=%d vfx=%s", checks, vfxSummary))
