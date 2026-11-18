-- Studio Client, fresh rbxtsc/Rojo sync. Isolated controllers; never mutates saved data or ReplicatedStorage.Assets.
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ts = Players.LocalPlayer:WaitForChild("PlayerScripts"):WaitForChild("TS")

local VFXController = require(ts.Controllers.VFXController).VFXController
local VFXConfig = require(ts.UI.VFXConfig)
local CombatController = require(ts.Controllers.CombatController).CombatController
local BattleHUD = require(ts.Controllers.BattleHUD).BattleHUD
local UITheme = require(ts.UI.UITheme).UITheme
local JOTARO_S2 = require(ReplicatedStorage.TS.SkillData).JOTARO_SKILL_DATA[2]

local checks = 0
local rows = {}
local function check(cond, msg)
	checks += 1
	assert(cond, msg)
end

local function makeSignal()
	local listeners = {}
	return {
		Event = {
			Connect = function(_, fn)
				local entry = { fn = fn, connected = true }
				table.insert(listeners, entry)
				return {
					Connected = true,
					Disconnect = function(self)
						self.Connected = false
						entry.connected = false
					end,
				}
			end,
		},
		Fire = function(_, ...)
			for _, entry in ipairs(table.clone(listeners)) do
				if entry.connected then
					entry.fn(...)
				end
			end
		end,
		Count = function()
			local n = 0
			for _, entry in ipairs(listeners) do
				if entry.connected then
					n += 1
				end
			end
			return n
		end,
	}
end

local function makeMockStorage(initialChild)
	local children = {}
	if initialChild then
		children[initialChild.Name] = initialChild
	end
	local childAddedSig = makeSignal()
	return {
		FindFirstChild = function(_, name)
			return children[name]
		end,
		ChildAdded = childAddedSig.Event,
		AddChild = function(_, child)
			children[child.Name] = child
			childAddedSig:Fire(child)
		end,
		ChildAddedSignal = childAddedSig,
	}
end

local function makeMockRemoteEvent(name)
	local onClientEventSig = makeSignal()
	return {
		Name = name,
		IsA = function(_, className)
			return className == "RemoteEvent"
		end,
		OnClientEvent = onClientEventSig.Event,
		FireClient = function(_, ...)
			onClientEventSig:Fire(...)
		end,
		Signal = onClientEventSig,
	}
end

local function makeMockPartIcles(durationByFolder)
	local calls = {
		activate = 0,
		emits = {},
		disables = {},
		preloads = {},
		deloads = {},
		disableCountByFolder = {},
		emitCountByFolder = {},
		preloadCountByFolder = {},
		deloadCountByFolder = {},
	}
	local api = {
		MAX_ACTIVE_PARTICLES = 1000,
		Activate = function()
			calls.activate += 1
		end,
		Preload = function(_, root)
			table.insert(calls.preloads, root)
			calls.preloadCountByFolder[root] = (calls.preloadCountByFolder[root] or 0) + 1
		end,
		Deload = function(_, root)
			table.insert(calls.deloads, root)
			calls.deloadCountByFolder[root] = (calls.deloadCountByFolder[root] or 0) + 1
		end,
		AbsoluteEmit = function(_, item)
			table.insert(calls.emits, item)
			calls.emitCountByFolder[item] = (calls.emitCountByFolder[item] or 0) + 1
			if durationByFolder then
				return durationByFolder[item]
			end
			return 5
		end,
		AbsoluteDisable = function(_, item)
			table.insert(calls.disables, item)
			calls.disableCountByFolder[item] = (calls.disableCountByFolder[item] or 0) + 1
		end,
	}
	return api, calls
end

local function makeSettings(quality, fpsCap)
	local sigQuality = makeSignal()
	local sigCap = makeSignal()
	local settings
	settings = {
		SavedQualityLevel = quality or Enum.SavedQualitySetting.Automatic,
		FramerateCap = fpsCap or 60,
		GetPropertyChangedSignal = function(_, prop)
			if prop == "FramerateCap" then
				return sigCap.Event
			end
			return sigQuality.Event
		end,
		SetQuality = function(_, newQuality)
			settings.SavedQualityLevel = newQuality
			sigQuality:Fire()
		end,
		SetCap = function(_, newCap)
			settings.FramerateCap = newCap
			sigCap:Fire()
		end,
	}
	return settings
end

local tempRoot = Instance.new("Folder")
tempRoot.Name = "VFXControllerQA_Temp"
tempRoot.Parent = workspace

local isolatedStorage = Instance.new("Folder")
isolatedStorage.Name = "IsolatedStorage"
isolatedStorage.Parent = tempRoot

local originalHud = Players.LocalPlayer.PlayerGui:FindFirstChild(UITheme.ScreenGuiName)
if originalHud then
	originalHud.Name = "BattleHUDOriginal_VfxQA"
end

local ok, failure = pcall(function()
	-- 1. Módulo ausente / com erro não quebra e avisa uma única vez; módulo real em ReplicatedStorage funciona.
	do
		local missingWarnCount = 0
		local logConn = LogService.MessageOut:Connect(function(msg, msgType)
			if msgType == Enum.MessageType.MessageWarning and string.find(msg, "%[VFXController%]") then
				missingWarnCount += 1
			end
		end)
		local emptyStorage = Instance.new("Folder")
		emptyStorage.Parent = tempRoot
		local vfxMissing = VFXController.new({
			replicatedStorage = emptyStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
		})
		vfxMissing:start()
		check(not vfxMissing:getBudgetSnapshot().disponivel, "empty storage should disable VFXController")
		local dummyFolder = Instance.new("Folder")
		dummyFolder.Parent = tempRoot
		check(vfxMissing:emit(dummyFolder) == false, "missing module emit must return false")
		check(vfxMissing:emit(dummyFolder) == false, "second missing module emit must return false")
		check(vfxMissing:preload(dummyFolder) == 0, "missing module preload must return 0")
		check(vfxMissing:deload(dummyFolder) == false, "missing module deload must return false")
		vfxMissing:clear()
		task.wait(0.05)
		logConn:Disconnect()
		check(missingWarnCount == 1, "missing module must emit exactly one warn, got " .. tostring(missingWarnCount))
		vfxMissing:destroy()

		local resolveCalls = 0
		local vfxBroken = VFXController.new({
			replicatedStorage = isolatedStorage,
			resolvePartIcles = function()
				resolveCalls += 1
				error("simulated broken Part_Icles")
			end,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
		})
		vfxBroken:start()
		vfxBroken:emit(dummyFolder)
		vfxBroken:preload(dummyFolder)
		vfxBroken:deload(dummyFolder)
		vfxBroken:clear()
		check(resolveCalls == 1, "broken module must only attempt load once")
		vfxBroken:destroy()

		if ReplicatedStorage:FindFirstChild(VFXConfig.VFX_MODULE_NAME) then
			local vfxReal = VFXController.new({
				heartbeat = makeSignal().Event,
				userGameSettings = makeSettings(),
			})
			vfxReal:start()
			check(vfxReal:getBudgetSnapshot().disponivel, "real Part_Icles should load in Studio")
			local realPart = Instance.new("Part")
			realPart.Anchored = true
			realPart.Position = Vector3.new(0, 10, 0)
			realPart.Parent = tempRoot
			local emitter = Instance.new("ParticleEmitter")
			emitter:SetAttribute("EmitCount", 2)
			emitter.Parent = realPart
			vfxReal:preload(realPart)
			vfxReal:emit(realPart, realPart.Position, "essencial", true)
			vfxReal:clear()
			vfxReal:deload(realPart)
			vfxReal:destroy()
			realPart:Destroy()
		end
		table.insert(rows, "missing/broken/real Part_Icles: passed")
	end

	-- 2. Orçamento respeitado & qualidade gráfica
	do
		local api, calls = makeMockPartIcles()
		local hb = makeSignal()
		local settings = makeSettings(Enum.SavedQualitySetting.Automatic, 60)
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = hb.Event,
			userGameSettings = settings,
			isMobile = false,
		})
		vfx:start()
		check(vfx:getBudgetSnapshot().limiteVfxSimultaneos == VFXConfig.VFX_LIMITE_MAXIMO, "desktop initial limit")
		check(api.MAX_ACTIVE_PARTICLES == VFXConfig.VFX_PARTICULAS_MAXIMO, "desktop MAX_ACTIVE_PARTICLES")

		local folders = {}
		for i = 1, VFXConfig.VFX_LIMITE_MAXIMO + 1 do
			local f = Instance.new("Folder")
			f.Name = "Normal_" .. i
			f:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			f.Parent = tempRoot
			table.insert(folders, f)
		end

		for i = 1, VFXConfig.VFX_LIMITE_MAXIMO do
			check(vfx:emit(folders[i], nil, "normal") == true, "within budget emit " .. i)
		end
		check(vfx:getActiveCount() == VFXConfig.VFX_LIMITE_MAXIMO, "active count at desktop limit")
		check(vfx:emit(folders[VFXConfig.VFX_LIMITE_MAXIMO + 1], nil, "normal") == false, "overflow normal discarded")
		check(#calls.emits == VFXConfig.VFX_LIMITE_MAXIMO, "overflow did not call AbsoluteEmit")

		settings:SetQuality(Enum.SavedQualitySetting.QualityLevel1)
		check(vfx:getBudgetSnapshot().limiteVfxSimultaneos == VFXConfig.VFX_LIMITE_MINIMO, "low quality clamps limit")
		check(api.MAX_ACTIVE_PARTICLES < VFXConfig.VFX_PARTICULAS_MAXIMO, "low quality clamps particles")

		vfx:destroy()
		for _, f in folders do
			f:Destroy()
		end
		table.insert(rows, "budget and quality cap: passed")
	end

	-- 3. Prioridade expulsa o antigo + Teto duro VFX_LIMITE_ESSENCIAIS_EXTRA
	do
		local api, calls = makeMockPartIcles()
		local hb = makeSignal()
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = hb.Event,
			userGameSettings = makeSettings(Enum.SavedQualitySetting.Automatic, 60),
			isMobile = true,
		})
		vfx:start()
		local mobileLimit = VFXConfig.VFX_LIMITE_MOBILE
		local hardCap = mobileLimit + VFXConfig.VFX_LIMITE_ESSENCIAIS_EXTRA
		check(vfx:getBudgetSnapshot().limiteVfxSimultaneos == mobileLimit, "mobile limit check")
		check(vfx:getBudgetSnapshot().limiteEssenciaisTeto == hardCap, "hard essential cap snapshot")

		local normals = {}
		for i = 1, mobileLimit do
			local f = Instance.new("Folder")
			f.Name = "Low_" .. i
			f:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			f.Parent = tempRoot
			table.insert(normals, f)
			check(vfx:emit(f, nil, "normal") == true, "fill mobile slot " .. i)
		end

		local essentials = {}
		for i = 1, hardCap + 2 do
			local f = Instance.new("Folder")
			f.Name = "Ess_" .. i
			f:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			f.Parent = tempRoot
			table.insert(essentials, f)
		end

		-- Primeiro essencial expulsa o normal mais antigo (Low_1)
		check(vfx:emit(essentials[1], nil, "essencial") == true, "essential 1 emits")
		check((calls.disableCountByFolder[normals[1]] or 0) == 1, "oldest normal evicted")
		check((calls.disableCountByFolder[normals[2]] or 0) == 0, "second normal kept")
		check(vfx:getActiveCount() == mobileLimit, "count stays at mobile limit after evicting normal")

		-- Expulsa normals restantes até ficarem só essenciais
		for i = 2, mobileLimit do
			check(vfx:emit(essentials[i], nil, "essencial") == true, "essential " .. i .. " emits")
			check((calls.disableCountByFolder[normals[i]] or 0) == 1, "normal " .. i .. " evicted FIFO")
		end
		check(vfx:getActiveCount() == mobileLimit, "only essentials occupy normal budget")

		-- Acima do orçamento normal, essenciais usam a folga até limite + VFX_LIMITE_ESSENCIAIS_EXTRA
		for i = mobileLimit + 1, hardCap do
			check(vfx:emit(essentials[i], nil, "essencial") == true, "extra essential " .. i .. " emits")
		end
		check(vfx:getActiveCount() == hardCap, "reached hard essential ceiling")
		check((calls.disableCountByFolder[essentials[1]] or 0) == 0, "essential 1 still active before overflow")

		-- Acima de limite + extra, expulsa o essencial MAIS ANTIGO
		check(vfx:emit(essentials[hardCap + 1], nil, "essencial") == true, "essential past hard cap still emits")
		check((calls.disableCountByFolder[essentials[1]] or 0) == 1, "oldest essential evicted above hard cap")
		check(vfx:getActiveCount() == hardCap, "hard cap never exceeded")

		check(vfx:emit(essentials[hardCap + 2], nil, "essencial") == true, "second essential past hard cap emits")
		check((calls.disableCountByFolder[essentials[2]] or 0) == 1, "second oldest essential evicted FIFO")
		check(vfx:getActiveCount() == hardCap, "hard cap never exceeded on second overflow")

		-- Normal é descartado enquanto essenciais ocupam o orçamento
		local rejectedNormal = Instance.new("Folder")
		rejectedNormal:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
		rejectedNormal.Parent = tempRoot
		check(vfx:emit(rejectedNormal, nil, "normal") == false, "normal rejected when essentials fill budget")

		vfx:destroy()
		for _, f in normals do f:Destroy() end
		for _, f in essentials do f:Destroy() end
		rejectedNormal:Destroy()
		table.insert(rows, "priority eviction and essential hard cap: passed")
	end

	-- 4. ORA ORA (5 hits e 5 crits seguidos) dentro do orçamento e teto
	do
		local durations = {}
		local api, calls = makeMockPartIcles(durations)
		local hb = makeSignal()
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = hb.Event,
			userGameSettings = makeSettings(Enum.SavedQualitySetting.Automatic, 60),
			isMobile = true,
		})
		vfx:start()

		local oraFolder = Instance.new("Folder")
		oraFolder.Name = "Barragem_estelar"
		oraFolder:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
		oraFolder.Parent = tempRoot
		durations[oraFolder] = 0.2

		local maxSeen = 0
		for i = 1, 5 do
			check(vfx:emit(oraFolder, nil, "essencial") == true, "ORA ORA direct hit " .. i)
			maxSeen = math.max(maxSeen, vfx:getActiveCount())
			if i < 5 then
				task.wait(0.1)
			end
		end
		check(maxSeen <= 1, "ORA ORA rapid re-emit occupies only 1 slot")
		task.wait(0.32)
		check(vfx:getActiveCount() == 0, "ORA ORA auto-disabled cleanly")
		check((calls.emitCountByFolder[oraFolder] or 0) == 5, "ORA ORA emitted all 5 hits")

		-- ORA ORA integrado via CombatController com 5 crits seguidos (mobile + teto duro)
		local fakeAssetsRoot = Instance.new("Folder")
		fakeAssetsRoot.Parent = tempRoot
		local assets = Instance.new("Folder")
		assets.Name = "Assets"
		assets.Parent = fakeAssetsRoot
		local vfxRoot = Instance.new("Folder")
		vfxRoot.Name = VFXConfig.VFX_ASSETS_FOLDER_NAME
		vfxRoot.Parent = assets
		local jotaroVfx = Instance.new("Folder")
		jotaroVfx.Name = "jotaro"
		jotaroVfx.Parent = vfxRoot
		local oraSkillTpl = Instance.new("Folder")
		oraSkillTpl.Name = "Barragem_estelar"
		oraSkillTpl.Parent = jotaroVfx
		local critTpl = Instance.new("Folder")
		critTpl.Name = VFXConfig.VFX_GLOBAL_CRIT_NAME
		critTpl.Parent = vfxRoot

		local combat = CombatController.new(vfx, fakeAssetsRoot)
		combat:initBillboardPool()
		combat:onBattleStarted({
			sides = { "A", "B" },
			mode = "PVE",
			fighters = {
				{ sideId = "A", targetId = "own", fighterId = "jotaro", className = "Fury", level = 1, s3Unlocked = true, hp = 100, hpMax = 100, active = true },
				{ sideId = "B", targetId = "enemy", fighterId = "anubis", className = "Menace", level = 1, s3Unlocked = true, hp = 500, hpMax = 500, active = true },
			},
		})
		combat.stageFolder.Name = "VfxOraCombatQA"

		-- Preenche teto quase todo com essenciais distintos para validar que 5 crits seguidos do ORA ORA nunca passam de limite + extra
		local prefill = {}
		local hardCap = VFXConfig.VFX_LIMITE_MOBILE + VFXConfig.VFX_LIMITE_ESSENCIAIS_EXTRA
		for i = 1, hardCap - 1 do
			local ef = Instance.new("Folder")
			ef:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			ef.Parent = tempRoot
			durations[ef] = 5
			vfx:emit(ef, nil, "essencial")
			table.insert(prefill, ef)
		end

		combat:onAttackStarted({ attackerId = "own", targetId = "enemy", slot = 2 })
		local maxDuringOraCrits = 0
		for i, hit in JOTARO_S2.hits do
			combat:delayBattle(hit.time, function()
				combat:onHitResolved({
					hitIndex = i,
					hit = true,
					crit = true,
					damage = 10,
					targetId = "enemy",
					followUpCancelled = false,
				})
			end)
		end
		local deadline = os.clock() + JOTARO_S2.hits[#JOTARO_S2.hits].time + JOTARO_S2.returnTime + 0.15
		while os.clock() < deadline do
			maxDuringOraCrits = math.max(maxDuringOraCrits, vfx:getActiveCount())
			task.wait(0.02)
		end
		check(maxDuringOraCrits <= hardCap, "ORA ORA 5 crits exceeded hard essential cap: " .. tostring(maxDuringOraCrits))
		check(#calls.emits >= 10, "ORA ORA 5 crits emitted skill and crit VFX")

		combat:cleanupStage()
		combat.poolContainer:Destroy()
		vfx:destroy()
		for _, ef in prefill do ef:Destroy() end
		fakeAssetsRoot:Destroy()
		oraFolder:Destroy()
		table.insert(rows, "ORA ORA 5 hits & 5 crits within budget/cap: passed")
	end

	-- 5. Contador sem vazamento em Destroying e 6. clear() cancela tudo
	do
		local durations = {}
		local api, calls = makeMockPartIcles(durations)
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = true,
		})
		vfx:start()

		local folders = {}
		for i = 1, VFXConfig.VFX_LIMITE_MOBILE do
			local f = Instance.new("Folder")
			f:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			f.Parent = tempRoot
			durations[f] = 5
			table.insert(folders, f)
			check(vfx:emit(f, nil, "normal") == true, "fill slot " .. i)
		end
		check(vfx:getActiveCount() == VFXConfig.VFX_LIMITE_MOBILE, "filled mobile budget")
		folders[1]:Destroy()
		task.wait()
		check(vfx:getActiveCount() == VFXConfig.VFX_LIMITE_MOBILE - 1, "Destroying decremented active count")

		local replacement = Instance.new("Folder")
		replacement:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
		replacement.Parent = tempRoot
		durations[replacement] = 0.08
		check(vfx:emit(replacement, nil, "normal") == true, "slot freed after Destroy")

		-- Dispara reemissão pendente (task.defer) + delay curto e chama clear() imediatamente
		check(vfx:emit(replacement, nil, "normal") == true, "pending reemit queued")
		local emitsBeforeClear = #calls.emits
		local disablesBeforeClear = #calls.disables
		vfx:clear()
		check(vfx:getActiveCount() == 0, "clear zeroed active count")
		check(#calls.disables > disablesBeforeClear, "clear disabled active folders")
		local disablesRightAfterClear = #calls.disables

		task.wait(0.2)
		check(#calls.emits == emitsBeforeClear, "clear cancelled pending defer emit")
		check(#calls.disables == disablesRightAfterClear, "clear cancelled pending auto-disable delay")

		vfx:destroy()
		for i = 2, #folders do folders[i]:Destroy() end
		replacement:Destroy()
		table.insert(rows, "Destroying leak-free counter & clear cancels all: passed")
	end

	-- 7. Teardown no meio do VFX sem restos + 8. Deload com geração por batalha
	do
		local durations = {}
		local api, calls = makeMockPartIcles(durations)
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = false,
		})
		vfx:start()

		-- Caso A: API direta preload/deload com geração
		local genFolder = Instance.new("Folder")
		genFolder.Parent = tempRoot
		local g1 = vfx:preload(genFolder)
		local g2 = vfx:preload(genFolder)
		check(vfx:deload(genFolder, g1) == false, "stale generation deload rejected")
		check((calls.deloadCountByFolder[genFolder] or 0) == 0, "stale deload did not call Part_Icles:Deload")
		check(vfx:deload(genFolder, g2) == true, "current generation deload accepted")
		check((calls.deloadCountByFolder[genFolder] or 0) == 1, "matching deload called Part_Icles:Deload")
		genFolder:Destroy()

		-- Caso B: Teardown no meio do VFX via BattleHUD + CombatController
		local fakeAssetsRoot = Instance.new("Folder")
		fakeAssetsRoot.Parent = tempRoot
		local assets = Instance.new("Folder")
		assets.Name = "Assets"
		assets.Parent = fakeAssetsRoot
		local vfxRoot = Instance.new("Folder")
		vfxRoot.Name = VFXConfig.VFX_ASSETS_FOLDER_NAME
		vfxRoot.Parent = assets
		local jotaroVfx = Instance.new("Folder")
		jotaroVfx.Name = "jotaro"
		jotaroVfx.Parent = vfxRoot
		local oraSkillTpl = Instance.new("Folder")
		oraSkillTpl.Name = "Barragem_estelar"
		oraSkillTpl.Parent = jotaroVfx
		local hitTpl = Instance.new("Folder")
		hitTpl.Name = VFXConfig.VFX_GLOBAL_HIT_NAME
		hitTpl.Parent = vfxRoot

		local combat = CombatController.new(vfx, fakeAssetsRoot)
		combat:initBillboardPool()
		local hud = BattleHUD.new(combat, vfx)
		hud:buildGui()
		hud.screenGui.Name = "BattleHUD_VfxQA"
		hud.resultScreenGui.Name = "BattleResult_VfxQA"

		local battlePayload = {
			sides = { "A", "B" },
			mode = "PVE",
			canPause = true,
			fighters = {
				{ sideId = "A", targetId = "own", fighterId = "jotaro", className = "Fury", level = 1, s3Unlocked = true, hp = 100, hpMax = 100, active = true },
				{ sideId = "B", targetId = "enemy", fighterId = "anubis", className = "Menace", level = 1, s3Unlocked = true, hp = 100, hpMax = 100, active = true },
			},
		}

		combat:onBattleStarted(battlePayload)
		combat.stageFolder.Name = "ClientBattleStage_VfxQA1"
		hud:onBattleStarted(battlePayload)
		check((calls.preloadCountByFolder[jotaroVfx] or 0) == 1, "BattleStarted preloaded fighter VFX")
		check((calls.preloadCountByFolder[hitTpl] or 0) == 1, "BattleStarted preloaded Hit VFX")

		combat:onAttackStarted({ attackerId = "own", targetId = "enemy", slot = 2 })
		combat:onHitResolved({ hitIndex = 1, hit = true, crit = false, damage = 10, targetId = "enemy", followUpCancelled = false })
		task.wait(JOTARO_S2.hits[1].time + 0.03)
		check(#calls.emits >= 2, "mid-attack emitted skill + hit VFX")
		check(vfx:getActiveCount() >= 2, "VFX active mid-attack")

		-- Teardown no meio da sequência
		hud:onBattleEnded({ reason = "quit" })
		check(vfx:getActiveCount() == 0, "teardown cleared active VFX")
		check((calls.deloadCountByFolder[jotaroVfx] or 0) == 1, "teardown deloaded fighter VFX")
		check((calls.deloadCountByFolder[hitTpl] or 0) == 1, "teardown deloaded Hit VFX")
		local emitsAtTeardown = #calls.emits
		task.wait(JOTARO_S2.hits[#JOTARO_S2.hits].time + 0.1)
		check(#calls.emits == emitsAtTeardown and vfx:getActiveCount() == 0, "no late VFX after teardown")

		-- Nova batalha imediata após teardown mantém preload e teardown atrasado da anterior não descarrega
		combat:onBattleStarted(battlePayload)
		combat.stageFolder.Name = "ClientBattleStage_VfxQA2"
		hud:onBattleStarted(battlePayload)
		check((calls.preloadCountByFolder[jotaroVfx] or 0) == 2, "immediate new battle re-preloaded VFX")

		-- Simula chegada atrasada de Battle 3 antes do teardown antigo da Battle 2
		combat:onBattleStarted(battlePayload)
		combat.stageFolder.Name = "ClientBattleStage_VfxQA3"
		local deloadsBeforeStaleHud = calls.deloadCountByFolder[jotaroVfx] or 0
		check(deloadsBeforeStaleHud == 2, "Battle 2 unloaded when Battle 3 replaced stage")
		-- Battle 3 já emitiu Hit antes do teardown atrasado da Battle 2
		local battle3Vfx = Instance.new("Folder")
		battle3Vfx:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
		battle3Vfx.Parent = tempRoot
		vfx:emit(battle3Vfx, nil, "essencial")
		hud:teardownBattle() -- carrega geração antiga da Battle 2!
		check((calls.deloadCountByFolder[jotaroVfx] or 0) == deloadsBeforeStaleHud, "stale HUD teardown did not deload new battle preload")
		check(vfx:getActiveCount() == 1, "stale HUD teardown did not clear new battle active VFX")

		combat:cleanupStage()
		hud:destroy()
		combat.poolContainer:Destroy()
		vfx:destroy()
		battle3Vfx:Destroy()
		fakeAssetsRoot:Destroy()
		table.insert(rows, "mid-VFX teardown & per-battle generation deload: passed")
	end

	-- 9. Teto 30 FPS mobile não corta; queda real corta e retorno recupera
	do
		local api = makeMockPartIcles()
		local hb = makeSignal()
		local settings = makeSettings(Enum.SavedQualitySetting.Automatic, 30)
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = hb.Event,
			userGameSettings = settings,
			isMobile = true,
		})
		vfx:start()

		-- 30 FPS estável com FramerateCap = 30
		for _ = 1, 60 do
			hb:Fire(1 / 30)
		end
		check(vfx:getBudgetSnapshot().limiteVfxSimultaneos >= VFXConfig.VFX_LIMITE_MOBILE, "30 FPS cap must not cut budget")

		-- Mesmo sem FramerateCap (0), referência por FPS máximo medido mantém 30 FPS saudável
		settings:SetCap(0)
		for _ = 1, 45 do
			hb:Fire(1 / 30)
		end
		check(vfx:getBudgetSnapshot().limiteVfxSimultaneos >= VFXConfig.VFX_LIMITE_MOBILE, "30 FPS measured max must not cut budget")

		-- Queda real para 15 FPS corta até limite mínimo mobile (3, sem pular para 6!)
		for _ = 1, 60 do
			hb:Fire(1 / 15)
		end
		check(vfx:getBudgetSnapshot().limiteVfxSimultaneos == VFXConfig.VFX_LIMITE_MINIMO_MOBILE, "15 FPS drop cuts to mobile minimum")

		-- Recuperação para 30 FPS sobe de volta
		for _ = 1, 90 do
			hb:Fire(1 / 30)
		end
		check(vfx:getBudgetSnapshot().limiteVfxSimultaneos > VFXConfig.VFX_LIMITE_MINIMO_MOBILE, "recovery back to 30 FPS restores budget")

		vfx:destroy()
		table.insert(rows, "30 FPS mobile ceiling adaptation: passed")
	end

	-- 10. Culling só em VFX do mundo & varredura ativa somente com VFX cullable ativo
	do
		local api, calls = makeMockPartIcles()
		local fakeCamera = Instance.new("Camera")
		fakeCamera.CFrame = CFrame.new(0, 0, 0)
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = false,
			getCamera = function() return fakeCamera end,
		})
		vfx:start()
		check(vfx:getBudgetSnapshot().scanAtiva == false, "scan must stay idle initially")

		local battleStage = Instance.new("Folder")
		battleStage.Name = "ClientBattleStage"
		battleStage.Parent = tempRoot
		local battleFx = Instance.new("Part")
		battleFx.Position = Vector3.new(0, 0, 5000)
		battleFx.Parent = battleStage
		check(vfx:emit(battleFx, battleFx.Position, "essencial") == true, "battle stage VFX bypasses distance culling")
		check(vfx:getBudgetSnapshot().scanAtiva == false, "battle VFX does not start world distance scan")
		vfx:clear()

		local farWorldFx = Instance.new("Part")
		farWorldFx.Position = Vector3.new(0, 0, 2000)
		farWorldFx.Parent = tempRoot
		check(vfx:emit(farWorldFx, farWorldFx) == false, "far world VFX culled on emit")
		check(vfx:getBudgetSnapshot().scanAtiva == false, "culled VFX did not start scan")

		local nearWorldFx = Instance.new("Part")
		nearWorldFx.Position = Vector3.new(0, 0, 50)
		nearWorldFx.Parent = tempRoot
		check(vfx:emit(nearWorldFx, nearWorldFx) == true, "near world VFX emits")
		check(vfx:getBudgetSnapshot().scanAtiva == true, "active world VFX starts scan")

		-- Move para fora da histerese (600 * 1.25 = 750 studs) e aguarda varredura
		nearWorldFx.Position = Vector3.new(0, 0, 1200)
		task.wait(VFXConfig.VFX_INTERVALO_VARREDURA_SEGUNDOS + 0.2)
		check((calls.disableCountByFolder[nearWorldFx] or 0) == 1, "scan disabled world VFX out of hysteresis range")
		check(vfx:getActiveCount() == 0, "world VFX removed from active after scan")
		task.wait(0.05)
		check(vfx:getBudgetSnapshot().scanAtiva == false, "scan stops when no cullable VFX remains")

		vfx:destroy()
		fakeCamera:Destroy()
		table.insert(rows, "world-only culling & active-only scan: passed")
	end

	-- 11. VFXEvent ausente não quebra, sem aviso, e ChildAdded conecta dinamicamente
	do
		local api, calls = makeMockPartIcles()
		local warnCount = 0
		local logConn = LogService.MessageOut:Connect(function(msg, msgType)
			if msgType == Enum.MessageType.MessageWarning and string.find(msg, "%[VFXController%]") then
				warnCount += 1
			end
		end)

		local realEventStorage = Instance.new("Folder")
		realEventStorage.Parent = tempRoot
		local vfxNoEvent = VFXController.new({
			partIcles = api,
			replicatedStorage = realEventStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = false,
		})
		vfxNoEvent:start()

		-- Filho não-RemoteEvent com mesmo nome deve ser ignorado sem erro
		local fakeFolderEvent = Instance.new("Folder")
		fakeFolderEvent.Name = VFXConfig.VFX_REMOTE_EVENT_NAME
		fakeFolderEvent.Parent = realEventStorage
		task.wait()

		-- RemoteEvent real adicionado depois via ChildAdded não pode quebrar
		local realRemote = Instance.new("RemoteEvent")
		realRemote.Name = VFXConfig.VFX_REMOTE_EVENT_NAME
		realRemote.Parent = realEventStorage
		task.wait()

		local localFx = Instance.new("Folder")
		localFx:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
		localFx.Parent = tempRoot
		check(vfxNoEvent:emit(localFx) == true, "emit works even when VFXEvent started missing")
		vfxNoEvent:destroy()

		-- Storage mockado começando ausente e recebendo VFXEvent tardio via ChildAdded
		local mockStorage = makeMockStorage(nil)
		local fakeCamera = Instance.new("Camera")
		fakeCamera.CFrame = CFrame.new(0, 0, 0)
		local vfxLate = VFXController.new({
			partIcles = api,
			replicatedStorage = mockStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = false,
			getCamera = function() return fakeCamera end,
		})
		vfxLate:start()
		check(mockStorage.ChildAddedSignal:Count() == 1, "ChildAdded connected when VFXEvent initially missing")

		local lateEvent = makeMockRemoteEvent(VFXConfig.VFX_REMOTE_EVENT_NAME)
		mockStorage:AddChild(lateEvent)
		check(lateEvent.Signal:Count() == 1, "ChildAdded connected OnClientEvent when VFXEvent arrived")

		local emitsBefore = #calls.emits
		lateEvent:FireClient(localFx, Vector3.new(0, 0, 15))
		check(#calls.emits == emitsBefore + 1, "late VFXEvent triggered emit")

		task.wait(0.05)
		logConn:Disconnect()
		check(warnCount == 0, "missing VFXEvent must not emit warns, got " .. tostring(warnCount))

		vfxLate:destroy()
		fakeCamera:Destroy()
		table.insert(rows, "missing VFXEvent no-op & ChildAdded connection: passed")
	end

	-- 12. Payload inválido ignorado em silêncio, emit com Vector3, origens válidas, culling e prioridade normal
	do
		check(VFXConfig.VFX_DEBUG == false, "VFX_DEBUG must default to false")

		local api, calls = makeMockPartIcles()
		local remoteEvent = makeMockRemoteEvent(VFXConfig.VFX_REMOTE_EVENT_NAME)
		local mockStorage = makeMockStorage(remoteEvent)
		local fakeCamera = Instance.new("Camera")
		fakeCamera.CFrame = CFrame.new(0, 0, 0)

		local warnCount = 0
		local logConn = LogService.MessageOut:Connect(function(msg, msgType)
			if msgType == Enum.MessageType.MessageWarning and string.find(msg, "%[VFXController%]") then
				warnCount += 1
			end
		end)

		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = mockStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = true,
			getCamera = function() return fakeCamera end,
		})
		vfx:start()

		local validWorldFolder = Instance.new("Folder")
		validWorldFolder.Name = "WorldFxFolder"
		validWorldFolder.Parent = tempRoot

		local orphanFolder = Instance.new("Folder")
		local otherFolder = Instance.new("Folder")
		otherFolder.Parent = tempRoot

		-- Payloads inválidos descartados em silêncio
		remoteEvent:FireClient()
		remoteEvent:FireClient("Barragem SP")
		remoteEvent:FireClient(123, Vector3.new(0, 0, 0))
		remoteEvent:FireClient({}, Vector3.new(0, 0, 0))
		remoteEvent:FireClient(orphanFolder, Vector3.new(0, 0, 0))
		remoteEvent:FireClient(validWorldFolder, "Vector3")
		remoteEvent:FireClient(validWorldFolder, 42)
		remoteEvent:FireClient(validWorldFolder, otherFolder)
		remoteEvent:FireClient(validWorldFolder, Vector3.new(0 / 0, 0, 0))
		remoteEvent:FireClient(validWorldFolder, CFrame.new(0 / 0, 0, 0))

		check(#calls.emits == 0, "invalid payloads must never call AbsoluteEmit")
		local statsInvalid = vfx:debugStats()
		check(statsInvalid.pastaInvalida == 5, "expected 5 pastaInvalida, got " .. tostring(statsInvalid.pastaInvalida))
		check(statsInvalid.origemInvalida == 5, "expected 5 origemInvalida, got " .. tostring(statsInvalid.origemInvalida))

		-- emit direto com origem Vector3 (perto emite, longe sofre culling)
		local directFolder = Instance.new("Folder")
		directFolder.Parent = tempRoot
		check(vfx:emit(directFolder, Vector3.new(0, 0, 20)) == true, "direct emit with near Vector3 origin succeeds")
		check(vfx:emit(validWorldFolder, Vector3.new(0, 0, 2000)) == false, "direct emit with far Vector3 origin is culled")
		vfx:clear()

		-- VFXEvent com Vector3 perto vs longe (culling ativo)
		local fVec = Instance.new("Folder")
		fVec.Parent = tempRoot
		remoteEvent:FireClient(fVec, Vector3.new(0, 0, 25))
		check((calls.emitCountByFolder[fVec] or 0) == 1, "VFXEvent near Vector3 emitted")
		local fFar = Instance.new("Folder")
		fFar.Parent = tempRoot
		remoteEvent:FireClient(fFar, Vector3.new(0, 0, 2000))
		check((calls.emitCountByFolder[fFar] or 0) == 0, "VFXEvent far Vector3 culled")
		remoteEvent:FireClient(fFar, CFrame.new(0, 0, 2000))
		check((calls.emitCountByFolder[fFar] or 0) == 0, "VFXEvent far CFrame culled")

		-- CFrame, BasePart, Attachment, Model perto
		local fCf = Instance.new("Folder"); fCf.Parent = tempRoot
		remoteEvent:FireClient(fCf, CFrame.new(0, 0, 30))
		check((calls.emitCountByFolder[fCf] or 0) == 1, "VFXEvent CFrame emitted")

		local originPart = Instance.new("Part")
		originPart.Position = Vector3.new(0, 0, 35)
		originPart.Parent = tempRoot
		local originAtt = Instance.new("Attachment")
		originAtt.Position = Vector3.new(0, 0, 5)
		originAtt.Parent = originPart
		local originModel = Instance.new("Model")
		originModel.Parent = tempRoot
		originModel:PivotTo(CFrame.new(0, 0, 40))

		local fPart = Instance.new("Folder"); fPart.Parent = tempRoot
		local fAtt = Instance.new("Folder"); fAtt.Parent = tempRoot
		local fModel = Instance.new("Folder"); fModel.Parent = tempRoot
		vfx:clear()
		remoteEvent:FireClient(fPart, originPart)
		remoteEvent:FireClient(fAtt, originAtt)
		remoteEvent:FireClient(fModel, originModel)
		check((calls.emitCountByFolder[fPart] or 0) == 1, "VFXEvent BasePart origin emitted")
		check((calls.emitCountByFolder[fAtt] or 0) == 1, "VFXEvent Attachment origin emitted")
		check((calls.emitCountByFolder[fModel] or 0) == 1, "VFXEvent Model origin emitted")

		-- Estilo Barragem SP: Model com Part interna e origem nil
		vfx:clear()
		local barragemModel = Instance.new("Model")
		barragemModel.Parent = tempRoot
		local barragemPart = Instance.new("Part")
		barragemPart.Position = Vector3.new(0, 0, 50)
		barragemPart.Parent = barragemModel
		remoteEvent:FireClient(barragemModel)
		check((calls.emitCountByFolder[barragemModel] or 0) == 1, "VFXEvent nil origin with Model emitted")
		check(vfx:getBudgetSnapshot().scanAtiva == true, "VFXEvent world VFX keeps distance culling scan active")

		-- Prioridade normal no VFXEvent (mesmo com atributo Prioridade=essencial, não expulsa nem passa do orçamento normal)
		vfx:clear()
		local fillFolders = {}
		for i = 1, VFXConfig.VFX_LIMITE_MOBILE do
			local ff = Instance.new("Folder")
			ff:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			ff.Parent = tempRoot
			table.insert(fillFolders, ff)
			check(vfx:emit(ff, nil, "normal") == true, "fill mobile budget before remote priority check")
		end
		local remoteTaggedEssential = Instance.new("Folder")
		remoteTaggedEssential:SetAttribute(VFXConfig.VFX_ATTR_PRIORIDADE, VFXConfig.VFX_PRIORIDADE_ESSENCIAL)
		remoteTaggedEssential.Parent = tempRoot
		remoteEvent:FireClient(remoteTaggedEssential, Vector3.new(0, 0, 10))
		check((calls.emitCountByFolder[remoteTaggedEssential] or 0) == 0, "VFXEvent uses normal priority and respects budget")
		check(vfx:debugStats().orcamento == 1, "budget discard recorded for VFXEvent overflow")

		task.wait(0.05)
		logConn:Disconnect()
		check(warnCount == 0, "default VFX_DEBUG=false must discard silently, got warns: " .. tostring(warnCount))

		vfx:destroy()
		orphanFolder:Destroy()
		fakeCamera:Destroy()
		table.insert(rows, "VFXEvent validation, origins, Vector3 emit, culling & normal priority: passed")
	end

	-- 13. Rate limit leve no client (VFXEvent)
	do
		local api, calls = makeMockPartIcles()
		local remoteEvent = makeMockRemoteEvent(VFXConfig.VFX_REMOTE_EVENT_NAME)
		local mockStorage = makeMockStorage(remoteEvent)
		local now = 100
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = mockStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = false,
			clock = function() return now end,
		})
		vfx:start()

		local fxList = {}
		for i = 1, VFXConfig.VFX_REMOTE_BUCKET_CAPACITY + 1 do
			local fx = Instance.new("Folder")
			fx.Name = "RateLimitFx_" .. i
			fx:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			fx.Parent = tempRoot
			table.insert(fxList, fx)
		end

		for i = 1, VFXConfig.VFX_REMOTE_BUCKET_CAPACITY do
			remoteEvent:FireClient(fxList[i], Vector3.new(0, 0, 10))
		end
		check(#calls.emits == VFXConfig.VFX_REMOTE_BUCKET_CAPACITY, "burst within bucket capacity accepted")
		check(vfx:debugStats().rateLimit == 0, "no rateLimit drops within capacity")

		for _ = 1, 4 do
			remoteEvent:FireClient(fxList[VFXConfig.VFX_REMOTE_BUCKET_CAPACITY + 1], Vector3.new(0, 0, 10))
		end
		check(#calls.emits == VFXConfig.VFX_REMOTE_BUCKET_CAPACITY, "burst above capacity dropped")
		check(vfx:debugStats().rateLimit == 4, "4 rateLimit drops recorded")
		check(vfx:debugStats().orcamento == 0, "rate limit drops happen before budget check")

		vfx:clear()
		now += (1 / VFXConfig.VFX_REMOTE_REFILL_PER_SECOND) + 0.01
		remoteEvent:FireClient(fxList[VFXConfig.VFX_REMOTE_BUCKET_CAPACITY + 1], Vector3.new(0, 0, 10))
		check(#calls.emits == VFXConfig.VFX_REMOTE_BUCKET_CAPACITY + 1, "bucket refilled 1 token after interval")
		check(vfx:debugStats().rateLimit == 4, "rateLimit count unchanged after refill")

		vfx:destroy()
		table.insert(rows, "VFXEvent client rate limit: passed")
	end

	-- 14. destroy() desconecta todas as conexões (OnClientEvent, ChildAdded, Heartbeat)
	do
		local api, calls = makeMockPartIcles()
		local hb = makeSignal()
		local remoteEvent = makeMockRemoteEvent(VFXConfig.VFX_REMOTE_EVENT_NAME)
		local mockStorage = makeMockStorage(remoteEvent)
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = mockStorage,
			heartbeat = hb.Event,
			userGameSettings = makeSettings(),
			isMobile = false,
		})
		vfx:start()

		check(remoteEvent.Signal:Count() == 1, "OnClientEvent connected before destroy")
		check(mockStorage.ChildAddedSignal:Count() == 1, "ChildAdded connected before destroy")
		check(hb:Count() == 1, "Heartbeat connected before destroy")

		vfx:destroy()
		vfx:destroy() -- idempotente

		check(remoteEvent.Signal:Count() == 0, "OnClientEvent disconnected on destroy")
		check(mockStorage.ChildAddedSignal:Count() == 0, "ChildAdded disconnected on destroy")
		check(hb:Count() == 0, "Heartbeat disconnected on destroy")

		local fx = Instance.new("Folder")
		fx:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
		fx.Parent = tempRoot
		local statsBefore = vfx:debugStats()
		remoteEvent:FireClient(fx, Vector3.new(0, 0, 10))
		remoteEvent:FireClient("invalid")
		check(#calls.emits == 0, "destroyed controller does not emit on VFXEvent")
		check(vfx:debugStats().pastaInvalida == statsBefore.pastaInvalida, "destroyed controller ignores remote events")

		local replacementEvent = makeMockRemoteEvent(VFXConfig.VFX_REMOTE_EVENT_NAME)
		mockStorage:AddChild(replacementEvent)
		check(replacementEvent.Signal:Count() == 0, "destroyed controller does not connect late VFXEvent")

		table.insert(rows, "destroy() disconnects all listeners: passed")
	end

	-- 15. Diagnóstico debugStats() e VFX_DEBUG (warn único por motivo só no Studio, sem spam)
	do
		local shouldThrow = false
		local api = {
			MAX_ACTIVE_PARTICLES = 1000,
			Activate = function() end,
			Preload = function() end,
			Deload = function() end,
			AbsoluteEmit = function()
				if shouldThrow then
					error("simulated emit failure")
				end
				return 5
			end,
			AbsoluteDisable = function() end,
		}

		local warnMessages = {}
		local logConn = LogService.MessageOut:Connect(function(msg, msgType)
			if msgType == Enum.MessageType.MessageWarning and string.find(msg, "%[VFXController%]") then
				table.insert(warnMessages, msg)
			end
		end)

		local remoteEvent = makeMockRemoteEvent(VFXConfig.VFX_REMOTE_EVENT_NAME)
		local mockStorage = makeMockStorage(remoteEvent)
		local fakeCamera = Instance.new("Camera")
		fakeCamera.CFrame = CFrame.new(0, 0, 0)
		local now = 500
		local vfxDebug = VFXController.new({
			partIcles = api,
			replicatedStorage = mockStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = true,
			getCamera = function() return fakeCamera end,
			clock = function() return now end,
			debug = true,
			isStudio = true,
		})
		vfxDebug:start()

		local nearFx = Instance.new("Folder")
		nearFx.Parent = tempRoot
		local farFx = Instance.new("Folder")
		farFx.Parent = tempRoot
		local orphan = Instance.new("Folder")

		-- Cada motivo repetido 3x: contador sobe para 3, mas warn sai só 1x por motivo
		for _ = 1, 3 do
			remoteEvent:FireClient(orphan) -- pastaInvalida
			remoteEvent:FireClient(nearFx, "bad") -- origemInvalida
			check(vfxDebug:emit(farFx, Vector3.new(0, 0, 2000)) == false, "debug culling")
		end

		-- Preenche orçamento mobile e provoca 3 descartes por orçamento
		for i = 1, VFXConfig.VFX_LIMITE_MOBILE do
			local bf = Instance.new("Folder")
			bf:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			bf.Parent = tempRoot
			check(vfxDebug:emit(bf, nil, "normal") == true, "fill debug budget " .. i)
		end
		for _ = 1, 3 do
			local overFx = Instance.new("Folder")
			overFx:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			overFx.Parent = tempRoot
			check(vfxDebug:emit(overFx, nil, "normal") == false, "debug budget overflow")
		end

		-- Provoca 3 falhas de AbsoluteEmit
		vfxDebug:clear()
		shouldThrow = true
		for _ = 1, 3 do
			local errFx = Instance.new("Folder")
			errFx:SetAttribute(VFXConfig.VFX_ATTR_IGNORAR_CULLING, true)
			errFx.Parent = tempRoot
			check(vfxDebug:emit(errFx) == false, "debug emitFalhou")
		end
		shouldThrow = false

		-- Provoca 3 rate limits
		for _ = 1, VFXConfig.VFX_REMOTE_BUCKET_CAPACITY + 3 do
			remoteEvent:FireClient(nearFx, Vector3.new(0, 0, 10))
		end

		-- Módulo ausente com debug = true no Studio (3 emits -> contador 3, warn único 1)
		local missingStorage = Instance.new("Folder")
		missingStorage.Parent = tempRoot
		local vfxMissingDebug = VFXController.new({
			replicatedStorage = missingStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			debug = true,
			isStudio = true,
		})
		vfxMissingDebug:start()
		for _ = 1, 3 do
			check(vfxMissingDebug:emit(nearFx) == false, "debug missing module")
		end

		task.wait(0.05)
		logConn:Disconnect()

		local stats = vfxDebug:debugStats()
		check(stats.pastaInvalida == 3, "debugStats pastaInvalida == 3")
		check(stats.origemInvalida == 3, "debugStats origemInvalida == 3")
		check(stats.culling == 3, "debugStats culling == 3")
		check(stats.orcamento == 3, "debugStats orcamento == 3")
		check(stats.emitFalhou == 3, "debugStats emitFalhou == 3")
		check(stats.rateLimit == 3, "debugStats rateLimit == 3")
		check(vfxMissingDebug:debugStats().moduloAusente == 3, "debugStats moduloAusente == 3")

		-- Snapshot defensivo
		stats.culling = 999
		check(vfxDebug:debugStats().culling == 3, "debugStats returns defensive copy")

		-- 6 motivos em vfxDebug + 1 moduloAusente em vfxMissingDebug = 7 warns sem spam
		check(#warnMessages == 7, "VFX_DEBUG Studio must warn once per reason (expected 7, got " .. tostring(#warnMessages) .. ")")

		-- Fora do Studio (isStudio = false): debugStats conta, mas zero warns
		local nonStudioWarns = 0
		local logConnProd = LogService.MessageOut:Connect(function(msg, msgType)
			if msgType == Enum.MessageType.MessageWarning and string.find(msg, "%[VFXController%]") then
				nonStudioWarns += 1
			end
		end)
		local prodRemote = makeMockRemoteEvent(VFXConfig.VFX_REMOTE_EVENT_NAME)
		local prodStorage = makeMockStorage(prodRemote)
		local vfxProd = VFXController.new({
			partIcles = api,
			replicatedStorage = prodStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = true,
			getCamera = function() return fakeCamera end,
			clock = function() return now end,
			debug = true,
			isStudio = false,
		})
		vfxProd:start()
		prodRemote:FireClient(orphan)
		prodRemote:FireClient(nearFx, "bad")
		vfxProd:emit(farFx, Vector3.new(0, 0, 2000))
		shouldThrow = true
		vfxProd:emit(nearFx, Vector3.new(0, 0, 10))
		shouldThrow = false
		task.wait(0.05)
		logConnProd:Disconnect()

		local prodStats = vfxProd:debugStats()
		check(prodStats.pastaInvalida == 1 and prodStats.origemInvalida == 1 and prodStats.culling == 1 and prodStats.emitFalhou == 1, "non-Studio still tracks debugStats")
		check(nonStudioWarns == 0, "VFX_DEBUG must never warn outside Studio, got " .. tostring(nonStudioWarns))

		vfxDebug:destroy()
		vfxMissingDebug:destroy()
		vfxProd:destroy()
		orphan:Destroy()
		fakeCamera:Destroy()
		table.insert(rows, "debugStats() & VFX_DEBUG Studio-only single warn: passed")
	end
end)

tempRoot:Destroy()
if originalHud then
	originalHud.Name = UITheme.ScreenGuiName
end

assert(ok, failure)
return { result = "VFX_CONTROLLER_QA_PASSED", checks = checks, scenarios = rows }
