-- QA Client do Lote M:
--   A-06: VFX relativo à posição/orientação/pivô/offset do alvo em arenas clonadas, movidas e rotacionadas
--   B-07: DisplayOrder do TinyesDisplay vs Loading/Countdown, Combate/Pause, Resultado, Shop, PvP e Inventário
--   A-05 (client): HUD preserva ATB visual na morte no banco e zera na morte do ativo; Finalizer não troca ativo em morte no banco

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local StarterPlayer = game:GetService("StarterPlayer")
local Workspace = game:GetService("Workspace")

local sps = StarterPlayer:WaitForChild("StarterPlayerScripts")
local ts = sps:WaitForChild("TS")
local controllers = ts:WaitForChild("Controllers")
local ui = ts:WaitForChild("UI")

local CombatController = require(controllers:WaitForChild("CombatController")).CombatController
local BattleHUD = require(controllers:WaitForChild("BattleHUD")).BattleHUD
local VFXController = require(controllers:WaitForChild("VFXController")).VFXController
local BattleIntroOverlay = require(ui:WaitForChild("BattleIntroOverlay")).BattleIntroOverlay
local UITheme = require(ui:WaitForChild("UITheme")).UITheme
local VFXConfig = require(ui:WaitForChild("VFXConfig"))
local JOTARO_S1 = require(ReplicatedStorage:WaitForChild("TS"):WaitForChild("SkillData")).JOTARO_SKILL_DATA[1]

local checks = 0
local rows = {}
local function check(cond, msg)
	checks += 1
	assert(cond, "[LOT_M_CLIENT_QA FAIL] " .. tostring(msg))
end

local function makeSignal()
	local list = {}
	return {
		Event = {
			Connect = function(_, fn)
				table.insert(list, fn)
				return {
					Connected = true,
					Disconnect = function(self)
						self.Connected = false
						local idx = table.find(list, fn)
						if idx then table.remove(list, idx) end
					end,
				}
			end,
		},
		Fire = function(_, ...)
			for _, fn in ipairs(table.clone(list)) do fn(...) end
		end,
	}
end

local function makeSettings()
	local sig = makeSignal()
	return {
		SavedQualityLevel = Enum.SavedQualitySetting.Automatic,
		FramerateCap = 60,
		GetPropertyChangedSignal = function() return sig.Event end,
	}
end

local function makeMockPartIcles()
	local calls = { emits = {}, disables = {} }
	local api = {
		MAX_ACTIVE_PARTICLES = 1000,
		Activate = function() end,
		Preload = function() end,
		Deload = function() end,
		AbsoluteEmit = function(_, folder)
			table.insert(calls.emits, folder)
			return 0.5
		end,
		AbsoluteDisable = function(_, folder)
			table.insert(calls.disables, folder)
		end,
	}
	return api, calls
end

local function approxVec(a, b, tol)
	return (a - b).Magnitude <= (tol or 1e-3)
end

local function approxCFrame(a, b, posTol, dirTol)
	posTol = posTol or 1e-3
	dirTol = dirTol or 1e-3
	return (a.Position - b.Position).Magnitude <= posTol
		and (a.LookVector - b.LookVector).Magnitude <= dirTol
		and (a.UpVector - b.UpVector).Magnitude <= dirTol
end

local function buildArenaClone(parent, instanceId, arenaId, pivotCFrame)
	local activeArenas = parent:FindFirstChild("ActiveArenas")
	if not activeArenas then
		activeArenas = Instance.new("Folder")
		activeArenas.Name = "ActiveArenas"
		activeArenas.Parent = parent
	end
	local arena = Instance.new("Model")
	arena.Name = "ArenaClone_" .. instanceId
	arena:SetAttribute("ArenaId", arenaId)
	arena:SetAttribute("ArenaInstanceId", instanceId)

	local bases = Instance.new("Folder")
	bases.Name = "Arena_bases"
	bases.Parent = arena

	local function makeAnchor(sideFolder, name, cf)
		local p = Instance.new("Part")
		p.Name = name
		p.Size = Vector3.new(4, 1, 4)
		p.Anchored = true
		p.CanCollide = false
		p.CFrame = cf
		p.Parent = sideFolder
		return p
	end

	local timeA = Instance.new("Folder"); timeA.Name = "Time A"; timeA.Parent = bases
	local timeB = Instance.new("Folder"); timeB.Name = "Time B"; timeB.Parent = bases

	local aCur = makeAnchor(timeA, "Current_Fighter_A", CFrame.new(-8, 0, 0) * CFrame.Angles(0, math.rad(-90), 0))
	makeAnchor(timeA, "Waiting_Fighter_A", CFrame.new(-14, 0, -4) * CFrame.Angles(0, math.rad(-90), 0))
	makeAnchor(timeA, "Waiting_Fighter_A_2", CFrame.new(-14, 0, 4) * CFrame.Angles(0, math.rad(-90), 0))

	makeAnchor(timeB, "Current_Fighter_B", CFrame.new(8, 0, 0) * CFrame.Angles(0, math.rad(90), 0))
	makeAnchor(timeB, "Waiting_Fighter_B", CFrame.new(14, 0, -4) * CFrame.Angles(0, math.rad(90), 0))
	makeAnchor(timeB, "Waiting_Fighter_B_2", CFrame.new(14, 0, 4) * CFrame.Angles(0, math.rad(90), 0))

	arena.PrimaryPart = aCur
	arena:PivotTo(pivotCFrame)
	arena.Parent = activeArenas
	return arena
end

local function buildFighterRigWithStand(name, addModelVfx)
	local model = Instance.new("Model")
	model.Name = name

	-- Stand inserido ANTES do Torso para testar prioridade de Attachment do corpo principal!
	local stand = Instance.new("Model")
	stand.Name = "Stand"
	local standTorso = Instance.new("Part")
	standTorso.Name = "Torso"
	standTorso.Size = Vector3.new(2, 2, 1)
	standTorso.CFrame = CFrame.new(0, 4, 4)
	standTorso.Parent = stand
	local standPeito = Instance.new("Attachment")
	standPeito.Name = "Peito"
	standPeito.Position = Vector3.new(0, 0, 0)
	standPeito.Parent = standTorso
	stand.Parent = model

	local hrp = Instance.new("Part")
	hrp.Name = "HumanoidRootPart"
	hrp.Size = Vector3.new(2, 2, 1)
	hrp.CFrame = CFrame.new(0, 3, 0)
	hrp.Parent = model
	model.PrimaryPart = hrp

	local torso = Instance.new("Part")
	torso.Name = "Torso"
	torso.Size = Vector3.new(2, 2, 1)
	torso.CFrame = CFrame.new(0, 3, 0)
	torso.Parent = model
	local weld = Instance.new("WeldConstraint")
	weld.Part0 = hrp
	weld.Part1 = torso
	weld.Parent = torso

	local standWeld = Instance.new("WeldConstraint")
	standWeld.Part0 = hrp
	standWeld.Part1 = standTorso
	standWeld.Parent = standTorso

	local peito = Instance.new("Attachment")
	peito.Name = "Peito"
	peito.CFrame = CFrame.new(0, 0.25, -0.35)
	peito.Parent = torso

	local cabeca = Instance.new("Attachment")
	cabeca.Name = "Cabeca"
	cabeca.CFrame = CFrame.new(0, 1.5, 0)
	cabeca.Parent = torso

	local gc = Instance.new("Attachment")
	gc.Name = "GroundContact"
	gc.Position = Vector3.new(0, -1, 0)
	gc.Parent = hrp

	local hum = Instance.new("Humanoid")
	hum.Parent = model

	if addModelVfx then
		local vfxFolder = Instance.new("Folder")
		vfxFolder.Name = VFXConfig.VFX_ASSETS_FOLDER_NAME
		vfxFolder.Parent = model

		-- Skill VFX dentro do modelo do atacante (antes ficava no atacante, agora deve ir para o alvo!)
		local skillFolder = Instance.new("Folder")
		skillFolder.Name = "star_Finger"
		skillFolder.Parent = vfxFolder

		local mainPart = Instance.new("Part")
		mainPart.Name = "Core"
		mainPart.Anchored = false
		mainPart.CanCollide = true
		mainPart.CFrame = CFrame.new(50, 10, -20)
		mainPart.Parent = skillFolder

		local offsetPart = Instance.new("Part")
		offsetPart.Name = "Ring"
		offsetPart.Anchored = false
		offsetPart.CanCollide = true
		offsetPart.CFrame = CFrame.new(50, 10, -20) * CFrame.new(0, 0.5, -2)
		offsetPart.Parent = skillFolder

		local em = Instance.new("ParticleEmitter")
		em.Parent = mainPart
	end

	return model
end

local tempRoot = Instance.new("Folder")
tempRoot.Name = "LotMClientQATemp"
tempRoot.Parent = Workspace

local ok, failure = pcall(function()
	-- =========================================================================
	-- 1. B-07 — DisplayOrder real do TinyesDisplay no PlayerGui
	-- =========================================================================
	do
		local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")
		local tinyesGui = playerGui:WaitForChild(UITheme.Tinyes.ScreenGuiName, 5)
		check(tinyesGui ~= nil and tinyesGui:IsA("ScreenGui"), "TinyesDisplay deve existir no PlayerGui")
		check(UITheme.Tinyes.DisplayOrder == 8, "UITheme.Tinyes.DisplayOrder deve ser 8")
		check(tinyesGui.DisplayOrder == UITheme.Tinyes.DisplayOrder, "TinyesDisplay.DisplayOrder deve usar UITheme")
		check(tinyesGui.DisplayOrder < UITheme.Shop.DisplayOrder, "TinyesDisplay abaixo de Shop")
		check(tinyesGui.DisplayOrder < UITheme.Pvp.DisplayOrder, "TinyesDisplay abaixo de PvpUI")
		check(tinyesGui.DisplayOrder < UITheme.DisplayOrder, "TinyesDisplay abaixo de BattleHUD e PauseOverlay")
		check(tinyesGui.DisplayOrder < UITheme.Xp.ResultDisplayOrder, "TinyesDisplay abaixo de BattleResult")
		check(tinyesGui.DisplayOrder < UITheme.Inventory.DisplayOrder, "TinyesDisplay abaixo de Inventory")

		-- Confirma contra BattleIntroOverlay real (loading curtain + countdown)
		local introOverlay = BattleIntroOverlay.new(playerGui, function() end)
		check(tinyesGui.DisplayOrder < introOverlay.gui.DisplayOrder, "TinyesDisplay abaixo de BattleIntroOverlay (loading/countdown)")
		introOverlay.gui:Destroy()

		-- Confirma demais ScreenGuis reais montadas no PlayerGui
		for _, spec in ipairs({
			{ name = UITheme.Shop.ScreenGuiName, label = "Shop" },
			{ name = UITheme.Pvp.ScreenGuiName, label = "PvpUI" },
			{ name = UITheme.ScreenGuiName, label = "BattleHUD" },
			{ name = UITheme.ResultScreenGuiName, label = "BattleResult" },
			{ name = UITheme.Inventory.ScreenGuiName, label = "Inventory" },
		}) do
			local otherGui = playerGui:FindFirstChild(spec.name)
			if otherGui and otherGui:IsA("ScreenGui") then
				check(
					tinyesGui.DisplayOrder < otherGui.DisplayOrder,
					"TinyesDisplay (" .. tostring(tinyesGui.DisplayOrder) .. ") deve ficar abaixo de " .. spec.label .. " (" .. tostring(otherGui.DisplayOrder) .. ")"
				)
			end
		end

		-- Layout visual preservado
		local balance = tinyesGui:FindFirstChild("Balance")
		check(balance ~= nil and balance:IsA("TextLabel"), "Balance TextLabel preservado")
		check(balance.Position == UITheme.Tinyes.Position and balance.Size == UITheme.Tinyes.Size, "layout visual do Tinyes preservado")
		table.insert(rows, "B-07 TinyesDisplay DisplayOrder & hierarchy: passed")
	end

	-- =========================================================================
	-- 2. A-06 — VFX relativo ao alvo em arenas clonadas, movidas e rotacionadas
	-- =========================================================================
	do
		local api, calls = makeMockPartIcles()
		local isolatedStorage = Instance.new("Folder"); isolatedStorage.Parent = tempRoot
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = false,
		})
		vfx:start()

		local fakeAssetsRoot = Instance.new("Folder")
		local assets = Instance.new("Folder"); assets.Name = "Assets"; assets.Parent = fakeAssetsRoot
		local fightersFolder = Instance.new("Folder"); fightersFolder.Name = "Fighters"; fightersFolder.Parent = assets
		buildFighterRigWithStand("jotaro", true).Parent = fightersFolder
		buildFighterRigWithStand("anubis", false).Parent = fightersFolder

		local vfxRoot = Instance.new("Folder"); vfxRoot.Name = VFXConfig.VFX_ASSETS_FOLDER_NAME; vfxRoot.Parent = assets

		-- Global Hit: Folder com múltiplas Parts + Pivot explícito + Emissor direto (mista)
		local hitTpl = Instance.new("Folder"); hitTpl.Name = VFXConfig.VFX_GLOBAL_HIT_NAME; hitTpl.Parent = vfxRoot
		local hitPivot = Instance.new("Part")
		hitPivot.Name = "Pivot"
		hitPivot.Anchored = false
		hitPivot.CFrame = CFrame.new(100, 20, -50) * CFrame.Angles(0, math.rad(30), 0)
		hitPivot.Parent = hitTpl
		local hitSub = Instance.new("Part")
		hitSub.Name = "Shockwave"
		hitSub.Anchored = false
		hitSub.CFrame = hitPivot.CFrame * CFrame.new(1.5, 0, -2.5)
		hitSub.Parent = hitTpl
		local directEmitter = Instance.new("ParticleEmitter")
		directEmitter.Parent = hitTpl

		-- Global KO: Model sem PrimaryPart com WorldPivot deslocado 2 studs abaixo da Burst
		local koTpl = Instance.new("Model"); koTpl.Name = VFXConfig.VFX_GLOBAL_KO_NAME; koTpl.Parent = vfxRoot
		local koPart = Instance.new("Part")
		koPart.Name = "Burst"
		koPart.Anchored = true
		koPart.CFrame = CFrame.new(-30, 12, 40)
		koPart.Parent = koTpl
		koTpl.WorldPivot = CFrame.new(-30, 10, 40) -- pivô 2 studs abaixo da Burst

		-- Arena clonada, movida e rotacionada em 125° no eixo Y
		local arenaRoot = Instance.new("Folder"); arenaRoot.Name = "ArenaRootA06"; arenaRoot.Parent = tempRoot
		local arenaPivot = CFrame.new(420, 35, -310) * CFrame.Angles(0, math.rad(125), 0)
		buildArenaClone(arenaRoot, "lotm-a06-rot125", "Arena_LotM", arenaPivot)

		local combat = CombatController.new(vfx, fakeAssetsRoot, arenaRoot, 1)
		combat:initBillboardPool()

		local payload = {
			sides = { "A", "B" },
			mode = "PVE",
			canPause = true,
			arena = { arenaId = "Arena_LotM", instanceId = "lotm-a06-rot125", physicalSides = { "A", "B" } },
			fighters = {
				{ sideId = "A", targetId = "a1", fighterId = "jotaro", className = "Fury", level = 10, s3Unlocked = true, hp = 100, hpMax = 100, active = true },
				{ sideId = "A", targetId = "a2", fighterId = "anubis", className = "Menace", level = 10, s3Unlocked = true, hp = 100, hpMax = 100, active = false },
				{ sideId = "B", targetId = "b1", fighterId = "anubis", className = "Menace", level = 10, s3Unlocked = true, hp = 100, hpMax = 100, active = true },
				{ sideId = "B", targetId = "b2", fighterId = "jotaro", className = "Fury", level = 10, s3Unlocked = true, hp = 100, hpMax = 100, active = false },
			},
		}
		combat:onBattleStarted(payload)
		combat.stageFolder.Name = "ClientBattleStage_LotMA06"

		local a1 = combat.fightersByTargetId["a1"]
		local b1 = combat.fightersByTargetId["b1"]
		check(a1 ~= nil and b1 ~= nil, "lutadores a1 e b1 criados na arena rotacionada")

		-- Attachment Peito no Jotaro deve pertencer ao corpo principal, nunca ao Stand!
		check(
			a1.attachments.Peito:IsA("Attachment") and not a1.attachments.Peito:IsDescendantOf(a1.standModel),
			"Peito do Jotaro deve resolver para o corpo principal e não para o Stand"
		)

		-- Dispara S1 do Jotaro (tem skill VFX dentro do modelo + Hit global misto) acertando b1
		local expectedTargetCf = b1.attachments.Peito.WorldCFrame
		combat:onAttackStarted({ attackerId = "a1", targetId = "b1", slot = 1 })
		combat:onHitResolved({ hitIndex = 1, hit = true, crit = false, damage = 15, targetId = "b1", followUpCancelled = false })
		task.wait(JOTARO_S1.hits[1].time + 0.08)

		local skillWorking = combat.battleVfxWorkingCopies["model:a1:star_Finger"]
		local hitWorking = combat.battleVfxWorkingCopies["global:Hit"]
		check(skillWorking ~= nil, "skill VFX do modelo do atacante deve criar working copy posicionada no alvo")
		check(hitWorking ~= nil, "global Hit VFX deve criar working copy")

		-- Skill VFX (Folder com 2 Parts dentro do modelo do atacante) deve estar no ALVO b1, NÃO em a1!
		local corePart = skillWorking:FindFirstChild("Core")
		local ringPart = skillWorking:FindFirstChild("Ring")
		check(corePart ~= nil and ringPart ~= nil, "Core e Ring presentes na working copy")
		check(corePart.Anchored == true and corePart.CanCollide == false, "working VFX partes ancoradas e sem colisão")
		check(approxCFrame(corePart.CFrame, expectedTargetCf), "Core da skill VFX alinhado ao Peito.WorldCFrame do alvo b1")
		check(
			approxCFrame(ringPart.CFrame, expectedTargetCf * CFrame.new(0, 0.5, -2)),
			"Ring preserva offset relativo na orientação rotacionada do alvo b1"
		)
		check(
			(corePart.Position - a1.attachments.Peito.WorldPosition).Magnitude > 5,
			"skill VFX do modelo do atacante não pode ficar preso no atacante"
		)

		-- Hit VFX (Folder mista: carrier + Pivot + Shockwave com offset)
		local hitCarrier = combat.vfxCarrierParts[hitWorking]
		local hitPivotCopy = hitWorking:FindFirstChild("Pivot")
		local hitSubCopy = hitWorking:FindFirstChild("Shockwave")
		check(hitCarrier ~= nil and approxCFrame(hitCarrier.CFrame, expectedTargetCf), "carrier de Folder mista alinhado ao alvo b1")
		check(hitPivotCopy ~= nil and approxCFrame(hitPivotCopy.CFrame, expectedTargetCf), "Pivot da Folder mista alinhado ao alvo b1")
		check(
			hitSubCopy ~= nil and approxCFrame(hitSubCopy.CFrame, expectedTargetCf * CFrame.new(1.5, 0, -2.5)),
			"Shockwave da Folder mista preserva deslocamento relativo na arena rotacionada"
		)

		-- Reutilização do Hit VFX no alvo oposto (b1 atacando a1, orientação invertida na mesma arena rotacionada)
		task.wait(0.2)
		local expectedOppositeCf = a1.attachments.Peito.WorldCFrame
		combat:onAttackStarted({ attackerId = "b1", targetId = "a1", slot = 1 })
		combat:onHitResolved({ hitIndex = 1, hit = true, crit = false, damage = 12, targetId = "a1", followUpCancelled = false })
		task.wait(0.6)
		check(approxCFrame(hitCarrier.CFrame, expectedOppositeCf), "reutilização do Hit move carrier para a1 com orientação oposta")
		check(approxCFrame(hitPivotCopy.CFrame, expectedOppositeCf), "reutilização do Hit move Pivot para a1")
		check(
			approxCFrame(hitSubCopy.CFrame, expectedOppositeCf * CFrame.new(1.5, 0, -2.5)),
			"reutilização do Hit preserva offset sem drift na orientação oposta"
		)

		-- KO VFX (Model com WorldPivot deslocado 2 studs abaixo da Burst)
		local koTargetCf = b1.attachments.Peito.WorldCFrame
		combat:onFighterDied({ sideId = "B", fighterId = "b1", nextActive = "b2" })
		task.wait(0.05)
		local koWorking = combat.battleVfxWorkingCopies["global:KO"]
		check(koWorking ~= nil and koWorking:IsA("Model"), "KO working copy criada")
		local koBurst = koWorking:FindFirstChild("Burst")
		check(
			koBurst ~= nil and approxCFrame(koBurst.CFrame, koTargetCf * CFrame.new(0, 2, 0)),
			"KO Model preserva WorldPivot offset relativo na orientação do alvo"
		)

		-- Template original nunca foi modificado
		check(approxVec(hitPivot.Position, Vector3.new(100, 20, -50)), "template original de Hit intacto")
		check(approxVec(koPart.Position, Vector3.new(-30, 12, 40)), "template original de KO intacto")

		-- Teardown limpa tudo sem restos
		combat:cleanupStage()
		check(next(combat.battleVfxWorkingCopies) == nil, "cleanup limpa battleVfxWorkingCopies")
		check(next(combat.vfxCarrierParts) == nil, "cleanup limpa vfxCarrierParts")
		combat.poolContainer:Destroy()
		vfx:destroy()
		fakeAssetsRoot:Destroy()
		table.insert(rows, "A-06 target-relative VFX (rotated/moved arena, Folder/Model/inModel/reuse): passed")
	end

	-- =========================================================================
	-- 3. A-05 (client) — HUD preserva ATB visual na morte no banco e zera na morte do ativo
	-- =========================================================================
	do
		local api = makeMockPartIcles()
		local isolatedStorage = Instance.new("Folder"); isolatedStorage.Parent = tempRoot
		local vfx = VFXController.new({
			partIcles = api,
			replicatedStorage = isolatedStorage,
			heartbeat = makeSignal().Event,
			userGameSettings = makeSettings(),
			isMobile = false,
		})
		vfx:start()

		local fakeAssetsRoot = Instance.new("Folder")
		local assets = Instance.new("Folder"); assets.Name = "Assets"; assets.Parent = fakeAssetsRoot
		local fightersFolder = Instance.new("Folder"); fightersFolder.Name = "Fighters"; fightersFolder.Parent = assets
		buildFighterRigWithStand("jotaro", false).Parent = fightersFolder
		buildFighterRigWithStand("anubis", false).Parent = fightersFolder

		local arenaRoot = Instance.new("Folder"); arenaRoot.Name = "ArenaRootA05"; arenaRoot.Parent = tempRoot
		buildArenaClone(arenaRoot, "lotm-a05", "Arena_A05", CFrame.new(0, 20, 0))

		local combat = CombatController.new(vfx, fakeAssetsRoot, arenaRoot, 1)
		combat:initBillboardPool()
		local hud = BattleHUD.new(combat, vfx)
		hud:buildGui()
		hud.screenGui.Name = "BattleHUD_LotMA05"
		hud.resultScreenGui.Name = "BattleResult_LotMA05"

		local battlePayload = {
			sides = { "A", "B" },
			mode = "PVE",
			canPause = true,
			arena = { arenaId = "Arena_A05", instanceId = "lotm-a05", physicalSides = { "A", "B" } },
			fighters = {
				{ sideId = "A", targetId = "own-1", fighterId = "jotaro", className = "Fury", level = 10, s3Unlocked = true, hp = 100, hpMax = 100, active = true },
				{ sideId = "A", targetId = "own-2", fighterId = "anubis", className = "Menace", level = 10, s3Unlocked = true, hp = 10, hpMax = 100, active = false },
				{ sideId = "B", targetId = "opp-1", fighterId = "anubis", className = "Menace", level = 10, s3Unlocked = true, hp = 100, hpMax = 100, active = true },
			},
		}
		combat:onBattleStarted(battlePayload)
		combat.stageFolder.Name = "ClientBattleStage_LotMA05"
		hud:onBattleStarted(battlePayload)

		-- Define ATB do lado A em 6.5
		hud:onAtbSync({ sideId = "A", atb = 6.5 })
		check(math.abs(hud.playerTargetAtb - 6.5) < 1e-4, "ATB inicial do jogador em 6.5")

		-- Morte no BANCO (own-2) com nextActive = nil: ATB do jogador DEVE ser preservado em 6.5 e own-1 continua ativo!
		combat:onFighterDied({ sideId = "A", fighterId = "own-2", nextActive = nil })
		task.wait(0.05)
		check(math.abs(hud.playerTargetAtb - 6.5) < 1e-4, "morte no banco preserva playerTargetAtb no HUD")
		check(hud.fightersByTargetId["own-1"].active == true, "morte no banco mantém own-1 ativo no HUD")
		check(hud.fightersByTargetId["own-2"].dead == true and hud.fightersByTargetId["own-2"].active == false, "own-2 marcado morto no HUD")
		check(combat.fightersByTargetId["own-1"].active == true, "morte no banco mantém own-1 ativo no CombatController")

		-- Agora morte do ATIVO (own-1): ATB do jogador DEVE zerar!
		combat:onFighterDied({ sideId = "A", fighterId = "own-1", nextActive = nil })
		task.wait(0.05)
		check(hud.playerTargetAtb == 0, "morte do ativo deve zerar playerTargetAtb no HUD")

		combat:cleanupStage()
		hud:destroy()
		combat.poolContainer:Destroy()
		vfx:destroy()
		fakeAssetsRoot:Destroy()
		table.insert(rows, "A-05 client HUD/Finalizer bench death preserves ATB: passed")
	end
end)

tempRoot:Destroy()
assert(ok, failure)
return { result = "LOT_M_CLIENT_QA_PASSED", checks = checks, scenarios = rows }
