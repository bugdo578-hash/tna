-- REFERENCIA MANUAL PARA O ROBLOX STUDIO (L4.1.4)
-- NAO e sincronizado pelo Rojo. Copiar e colar manualmente em:
-- StarterPlayer > StarterPlayerScripts > ArenaAmbientVFX
--
-- Contrato preservado:
-- - ReplicatedStorage.Part_Icles
-- - Workspace.ActiveArenas.<instanceId>.Arena_bases["Time A"].Current_Fighter_A.Current_Figther_A_vfx_green
-- - Workspace.ActiveArenas.<instanceId>.Arena_bases["Time B"].Current_Fighter_B.Current_Figther_B_vfx_red
-- - Identificacao exclusiva via estado autoritativo local (Players.LocalPlayer.BattleAmbientVfxState),
--   sem usar CurrentCamera/Camera_A/Camera_B para decidir arena ou lado.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Part_Icles = require(ReplicatedStorage:WaitForChild("Part_Icles"))
Part_Icles:Activate()

local ACTIVE_ARENAS_NAME = "ActiveArenas"
local STATE_NODE_NAME = "BattleAmbientVfxState"
local ARENA_INSTANCE_ID_ATTRIBUTE = "ArenaInstanceId"

local localPlayer = Players.LocalPlayer

local activeArenas = nil
local activeArenasAddedConn = nil
local activeArenasRemovedConn = nil

local stateNode = nil
local stateConnections = {}

local entries = {}
local pendingArenaConns = {}

local currentArena = nil
local currentSide = nil
local currentBattleId = nil
local currentGeneration = nil
local currentClones = {}

local function findPath(root, ...)
	local node = root

	for _, name in { ... } do
		node = node:FindFirstChild(name)
		if not node then
			return nil
		end
	end

	return node
end

local function applyEffect(effect, enabled)
	if not effect or not effect.Parent then
		return
	end

	if enabled then
		pcall(function()
			Part_Icles:AbsoluteEnable(effect)
		end)
	else
		pcall(function()
			Part_Icles:AbsoluteDisable(effect)
		end)
	end
end

local function disconnectPendingArena(arena)
	local conn = pendingArenaConns[arena]
	if conn then
		conn:Disconnect()
		pendingArenaConns[arena] = nil
	end
end

local function resolve(arena)
	if not arena or not arena:IsA("Model") then
		return nil
	end

	local bases = arena:FindFirstChild("Arena_bases")
	if not bases then
		return nil
	end

	local sideA = findPath(bases, "Time A", "Current_Fighter_A")
	local sideB = findPath(bases, "Time B", "Current_Fighter_B")

	if not sideA or not sideB then
		return nil
	end

	if not sideA:IsA("BasePart") or not sideB:IsA("BasePart") then
		return nil
	end

	local green = sideA:FindFirstChild("Current_Figther_A_vfx_green")
	local red = sideB:FindFirstChild("Current_Figther_B_vfx_red")

	if not green or not red then
		return nil
	end

	local entry = {
		sideA = sideA,
		sideB = sideB,
		green = green,
		red = red,
	}

	entries[arena] = entry
	disconnectPendingArena(arena)

	applyEffect(green, false)
	applyEffect(red, false)

	return entry
end

local function cloneEffect(source, sourceAnchor, targetAnchor)
	local clone = source:Clone()
	if not clone then
		return nil
	end

	local delta = targetAnchor.CFrame * sourceAnchor.CFrame:Inverse()

	clone.Name = "Local_" .. source.Name
	clone.Parent = targetAnchor

	local function transformPart(part)
		part.CFrame = delta * part.CFrame
	end

	if clone:IsA("BasePart") then
		transformPart(clone)
	end

	for _, item in clone:GetDescendants() do
		if item:IsA("BasePart") then
			transformPart(item)
		elseif item:IsA("ObjectValue") then
			if item.Value == sourceAnchor then
				item.Value = targetAnchor
			end
		end
	end

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

	currentArena = nil
	currentSide = nil
	currentBattleId = nil
	currentGeneration = nil
end

local function setCurrent(arena, side, battleId, generation)
	if
		currentArena == arena
		and currentSide == side
		and currentBattleId == battleId
		and currentGeneration == generation
	then
		return
	end

	clearCurrent()

	if not arena or not side then
		return
	end

	local entry = entries[arena] or resolve(arena)
	if not entry then
		return
	end

	currentArena = arena
	currentSide = side
	currentBattleId = battleId
	currentGeneration = generation

	if side == 1 then
		applyEffect(entry.green, true)
		applyEffect(entry.red, true)
		return
	end

	applyEffect(entry.green, false)
	applyEffect(entry.red, false)

	local redOnA = cloneEffect(
		entry.red,
		entry.sideB,
		entry.sideA
	)

	local greenOnB = cloneEffect(
		entry.green,
		entry.sideA,
		entry.sideB
	)

	if redOnA then
		table.insert(currentClones, redOnA)
	end

	if greenOnB then
		table.insert(currentClones, greenOnB)
	end

	applyEffect(redOnA, true)
	applyEffect(greenOnB, true)
end

local function findArenaByInstanceId(instanceId)
	if not activeArenas or type(instanceId) ~= "string" or instanceId == "" then
		return nil
	end

	local matched = nil
	for _, arena in activeArenas:GetChildren() do
		if arena:IsA("Model") then
			local attrId = arena:GetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE)
			if arena.Name == instanceId or attrId == instanceId then
				if matched ~= nil then
					return nil
				end
				matched = arena
			end
		end
	end

	return matched
end

local function readAuthoritativeSide(node)
	local localSide = node:GetAttribute("LocalSide")
	local localSideIndex = node:GetAttribute("LocalSideIndex")

	if localSide == "A" and localSideIndex == 1 then
		return 1
	end
	if localSide == "B" and localSideIndex == 2 then
		return 2
	end

	return nil
end

local function reconcile()
	if not stateNode or not stateNode.Parent or not activeArenas or not activeArenas.Parent then
		clearCurrent()
		return
	end

	local active = stateNode:GetAttribute("Active") == true
	local fightersReady = stateNode:GetAttribute("FightersReady") == true
	local goOccurred = stateNode:GetAttribute("GoOccurred") == true
	local battleId = stateNode:GetAttribute("BattleId")
	local generation = stateNode:GetAttribute("Generation")
	local arenaInstanceId = stateNode:GetAttribute("ArenaInstanceId")
	local side = readAuthoritativeSide(stateNode)

	if
		not active
		or not fightersReady
		or not goOccurred
		or type(battleId) ~= "string"
		or battleId == ""
		or type(generation) ~= "number"
		or generation <= 0
		or type(arenaInstanceId) ~= "string"
		or arenaInstanceId == ""
		or side == nil
	then
		clearCurrent()
		return
	end

	local arena = findArenaByInstanceId(arenaInstanceId)
	if not arena then
		clearCurrent()
		return
	end

	local entry = entries[arena] or resolve(arena)
	if not entry then
		clearCurrent()
		return
	end

	setCurrent(arena, side, battleId, generation)
end

local function trackArena(arena)
	if not arena or not arena:IsA("Model") then
		return
	end

	if resolve(arena) then
		reconcile()
		return
	end

	disconnectPendingArena(arena)
	pendingArenaConns[arena] = arena.DescendantAdded:Connect(function()
		if entries[arena] then
			disconnectPendingArena(arena)
			return
		end
		if resolve(arena) then
			reconcile()
		end
	end)
end

local function unbindActiveArenas()
	if activeArenasAddedConn then
		activeArenasAddedConn:Disconnect()
		activeArenasAddedConn = nil
	end
	if activeArenasRemovedConn then
		activeArenasRemovedConn:Disconnect()
		activeArenasRemovedConn = nil
	end
	for arena in pendingArenaConns do
		disconnectPendingArena(arena)
	end
	clearCurrent()
	table.clear(entries)
	activeArenas = nil
end

local function bindActiveArenas(folder)
	if activeArenas == folder then
		return
	end

	unbindActiveArenas()

	if not folder or not folder:IsA("Folder") then
		return
	end

	activeArenas = folder

	for _, arena in folder:GetChildren() do
		trackArena(arena)
	end

	activeArenasAddedConn = folder.ChildAdded:Connect(function(arena)
		trackArena(arena)
	end)

	activeArenasRemovedConn = folder.ChildRemoved:Connect(function(arena)
		disconnectPendingArena(arena)
		if arena == currentArena then
			clearCurrent()
		end
		entries[arena] = nil
	end)

	reconcile()
end

local function disconnectStateNode()
	for _, conn in stateConnections do
		conn:Disconnect()
	end
	table.clear(stateConnections)
	stateNode = nil
	clearCurrent()
end

local function bindStateNode(node)
	if stateNode == node then
		return
	end

	disconnectStateNode()

	if not node or not node:IsA("Configuration") then
		return
	end

	stateNode = node
	table.insert(stateConnections, node:GetAttributeChangedSignal("Revision"):Connect(reconcile))
	table.insert(stateConnections, node:GetAttributeChangedSignal("Active"):Connect(reconcile))
	table.insert(stateConnections, node.Destroying:Connect(function()
		if stateNode == node then
			disconnectStateNode()
		end
	end))

	reconcile()
end

Workspace.ChildAdded:Connect(function(child)
	if child.Name == ACTIVE_ARENAS_NAME and child:IsA("Folder") then
		bindActiveArenas(child)
	end
end)

Workspace.ChildRemoved:Connect(function(child)
	if child == activeArenas then
		unbindActiveArenas()
	end
end)

if localPlayer then
	localPlayer.ChildAdded:Connect(function(child)
		if child.Name == STATE_NODE_NAME and child:IsA("Configuration") then
			bindStateNode(child)
		end
	end)

	localPlayer.ChildRemoved:Connect(function(child)
		if child == stateNode then
			disconnectStateNode()
		end
	end)

	local existingState = localPlayer:FindFirstChild(STATE_NODE_NAME)
	if existingState and existingState:IsA("Configuration") then
		bindStateNode(existingState)
	end
end

local existingArenas = Workspace:FindFirstChild(ACTIVE_ARENAS_NAME)
if existingArenas and existingArenas:IsA("Folder") then
	bindActiveArenas(existingArenas)
end
