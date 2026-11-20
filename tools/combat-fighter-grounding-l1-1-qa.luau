-- Execute no Client em Play novo após rbxtsc/Rojo. Controllers isolados, sem servidor/perfis.
-- QA L1.1: apoio dos pés/patas na superfície superior dos anchors de Arena_bases.
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local Grounding = require(ts.Controllers.CombatFighterGrounding)
local config = require(ts.UI.CombatVisualConfig)
local SkillData = require(game.ReplicatedStorage.TS.SkillData)

local checks = 0
local scenarios = {}

local function check(condition, message)
	checks += 1
	assert(condition, message)
end

local TOL = 1e-3
local STRICT_TOL = config.COMBAT_POSITION_TOLERANCE_STUDS
local ROT_DOT_MIN = 0.9999

local function assertOrientationClose(actual, expected, label)
	local lookDot = actual.LookVector:Dot(expected.LookVector)
	local rightDot = actual.RightVector:Dot(expected.RightVector)
	local upDot = actual.UpVector:Dot(expected.UpVector)
	check(
		lookDot >= ROT_DOT_MIN and rightDot >= ROT_DOT_MIN and upDot >= ROT_DOT_MIN,
		string.format("%s (look=%.5f, right=%.5f, up=%.5f)", label, lookDot, rightDot, upDot)
	)
end

-- Calcula a menor coordenada no eixo UpVector do anchor dentre as partes físicas fornecidas.
local function measureMinPlaneSignedDistance(parts, anchor)
	local topCenter = anchor.CFrame:PointToWorldSpace(Vector3.new(0, anchor.Size.Y * 0.5, 0))
	local up = anchor.CFrame.UpVector
	local minDist = math.huge
	for _, part in ipairs(parts) do
		local hs = part.Size * 0.5
		for sx = -1, 1, 2 do
			for sy = -1, 1, 2 do
				for sz = -1, 1, 2 do
					local corner = part.CFrame:PointToWorldSpace(Vector3.new(hs.X * sx, hs.Y * sy, hs.Z * sz))
					local signed = (corner - topCenter):Dot(up)
					if signed < minDist then
						minDist = signed
					end
				end
			end
		end
	end
	return minDist
end

local function assertFeetOnAnchorTop(entry, bodyParts, anchor, label)
	assertOrientationClose(entry.rootPart.CFrame, anchor.CFrame, label .. " orientation")
	local signedDist = measureMinPlaneSignedDistance(bodyParts, anchor)
	check(
		math.abs(signedDist) <= TOL,
		string.format("%s feet-to-top-plane signedDist=%.5f (expected ~0)", label, signedDist)
	)
	local expectedCF = Grounding.alignFighterCFrameToAnchor(anchor, entry.groundContactOffset)
	local homeErr = (entry.homeCFrame.Position - expectedCF.Position).Magnitude
	check(homeErr <= STRICT_TOL, string.format("%s homeCFrame mismatch=%.5f", label, homeErr))
end

local function weldTo(root, part)
	local w = Instance.new("WeldConstraint")
	w.Part0 = root
	w.Part1 = part
	w.Parent = part
end

-- Cria um rig de teste determinístico dentro de Assets/Fighters isolado
local function buildTallFighter(name, withGroundContact)
	local m = Instance.new("Model")
	m.Name = name
	local hrp = Instance.new("Part")
	hrp.Name = "HumanoidRootPart"
	hrp.Size = Vector3.new(1.2, 1.4, 0.8)
	hrp.Transparency = 1
	hrp.CFrame = CFrame.new(0, 10, 0)
	hrp.Parent = m
	m.PrimaryPart = hrp

	local torso = Instance.new("Part")
	torso.Name = "Torso"
	torso.Size = Vector3.new(1.4, 2.0, 0.8)
	torso.CFrame = hrp.CFrame * CFrame.new(0, 0.2, 0)
	torso.Parent = m
	weldTo(hrp, torso)

	local head = Instance.new("Part")
	head.Name = "Head"
	head.Size = Vector3.new(1.0, 1.0, 1.0)
	head.CFrame = hrp.CFrame * CFrame.new(0, 1.7, 0)
	head.Parent = m
	weldTo(hrp, head)

	-- Pernas altas chegando a relY = -2.600
	for _, spec in ipairs({ { "Left Leg", -0.45 }, { "Right Leg", 0.45 } }) do
		local leg = Instance.new("Part")
		leg.Name = spec[1]
		leg.Size = Vector3.new(0.5, 1.8, 0.5)
		leg.CFrame = hrp.CFrame * CFrame.new(spec[2], -1.7, 0) -- bottom = -1.7 - 0.9 = -2.6
		leg.Parent = m
		weldTo(hrp, leg)
	end

	if withGroundContact then
		local att = Instance.new("Attachment")
		att.Name = config.GROUND_CONTACT_ATTACHMENT_NAME
		att.Position = Vector3.new(0, -2.6, 0)
		att.Parent = hrp
	end

	return m
end

-- Simula proporções baixas / quadrúpede como o Iggy (4 patas + corpo horizontal)
local function buildQuadrupedLowFighter(name, withGroundContact)
	local m = Instance.new("Model")
	m.Name = name
	local hrp = Instance.new("Part")
	hrp.Name = "HumanoidRootPart"
	hrp.Size = Vector3.new(0.5, 0.4, 0.9)
	hrp.Transparency = 1
	hrp.CFrame = CFrame.new(0, 10, 0)
	hrp.Parent = m
	m.PrimaryPart = hrp

	local body = Instance.new("Part")
	body.Name = "Body"
	body.Size = Vector3.new(0.65, 0.45, 1.1)
	body.CFrame = hrp.CFrame * CFrame.new(0, 0.05, 0)
	body.Parent = m
	weldTo(hrp, body)

	local head = Instance.new("Part")
	head.Name = "Head"
	head.Size = Vector3.new(0.45, 0.45, 0.45)
	head.CFrame = hrp.CFrame * CFrame.new(0, 0.35, -0.55)
	head.Parent = m
	weldTo(hrp, head)

	-- 4 patas baixas chegando a relY = -0.480
	local pawPositions = {
		{ "PawFL", Vector3.new(-0.22, -0.33, -0.35) },
		{ "PawFR", Vector3.new(0.22, -0.33, -0.35) },
		{ "PawBL", Vector3.new(-0.22, -0.33, 0.35) },
		{ "PawBR", Vector3.new(0.22, -0.33, 0.35) },
	}
	for _, spec in ipairs(pawPositions) do
		local paw = Instance.new("Part")
		paw.Name = spec[1]
		paw.Size = Vector3.new(0.18, 0.30, 0.18) -- bottom = -0.33 - 0.15 = -0.48
		paw.CFrame = hrp.CFrame * CFrame.new(spec[2])
		paw.Parent = m
		weldTo(hrp, paw)
	end

	if withGroundContact then
		local att = Instance.new("Attachment")
		att.Name = config.GROUND_CONTACT_ATTACHMENT_NAME
		att.Position = Vector3.new(0.05, -0.48, -0.08)
		att.Parent = hrp
	end

	return m
end

-- Rig com Stand, Accessory, VFX, Partículas e Hitbox muito abaixo dos pés (não podem distorcer a altura!)
local function buildClutteredFighter(name)
	local m = buildTallFighter(name, false)
	local hrp = m.PrimaryPart

	-- Stand abaixo dos pés (chegando a relY = -7.5)
	local stand = Instance.new("Model")
	stand.Name = "Stand"
	stand.Parent = m
	local standLeg = Instance.new("Part")
	standLeg.Name = "StandLeg"
	standLeg.Size = Vector3.new(1, 2, 1)
	standLeg.CFrame = hrp.CFrame * CFrame.new(-1, -6.5, 1)
	standLeg.Parent = stand
	weldTo(hrp, standLeg)
	-- GroundContact dentro do Stand deve ser ignorado
	local standContact = Instance.new("Attachment")
	standContact.Name = config.GROUND_CONTACT_ATTACHMENT_NAME
	standContact.Position = Vector3.new(0, -1, 0)
	standContact.Parent = standLeg

	-- Accessory pendurado bem abaixo dos pés (relY = -6.0)
	local acc = Instance.new("Accessory")
	acc.Name = "LongScarf"
	acc.Parent = m
	local accHandle = Instance.new("Part")
	accHandle.Name = "Handle"
	accHandle.Size = Vector3.new(0.5, 2.0, 0.5)
	accHandle.CFrame = hrp.CFrame * CFrame.new(0, -5.0, 0.4)
	accHandle.Parent = acc
	weldTo(hrp, accHandle)

	-- Pasta VFX com mesh opaco abaixo dos pés (relY = -8.0)
	local vfxFolder = Instance.new("Folder")
	vfxFolder.Name = "VFX"
	vfxFolder.Parent = m
	local vfxPart = Instance.new("Part")
	vfxPart.Name = "AuraRing"
	vfxPart.Size = Vector3.new(3, 1, 3)
	vfxPart.CFrame = hrp.CFrame * CFrame.new(0, -7.5, 0)
	vfxPart.Parent = vfxFolder
	weldTo(hrp, vfxPart)

	-- Hitbox gigante abaixo dos pés (relY = -9.0)
	local hitbox = Instance.new("Part")
	hitbox.Name = "AttackHitbox"
	hitbox.Size = Vector3.new(4, 4, 4)
	hitbox.Transparency = 0.5
	hitbox.CFrame = hrp.CFrame * CFrame.new(0, -7.0, 0)
	hitbox.Parent = m
	weldTo(hrp, hitbox)

	-- Parte invisível genérica com ParticleEmitter abaixo dos pés (relY = -10.0)
	local particleHost = Instance.new("Part")
	particleHost.Name = "GenericHolder"
	particleHost.Size = Vector3.new(1, 1, 1)
	particleHost.Transparency = 1
	particleHost.CFrame = hrp.CFrame * CFrame.new(0, -9.5, 0)
	particleHost.Parent = m
	weldTo(hrp, particleHost)
	local emitter = Instance.new("ParticleEmitter")
	emitter.Parent = particleHost

	return m
end

local function collectRealBodyParts(entry, expectedNames)
	local list = {}
	for _, name in ipairs(expectedNames) do
		local p = entry.model:FindFirstChild(name)
		if p and p:IsA("BasePart") then
			table.insert(list, p)
		end
	end
	return list
end

local arena = workspace:FindFirstChild(config.ARENA_BASES_NAME)
check(arena ~= nil, "Workspace.Arena_bases required")
local timeA = arena:FindFirstChild("Time A")
local timeB = arena:FindFirstChild("Time B")
local anchors = {
	activeA = timeA:FindFirstChild("Current_Fighter_A"),
	waitA1 = timeA:FindFirstChild("Waiting_Fighter_A"),
	waitA2 = timeA:FindFirstChild("Waiting_Fighter_A_2"),
	activeB = timeB:FindFirstChild("Current_Fighter_B"),
	waitB1 = timeB:FindFirstChild("Waiting_Fighter_B"),
	waitB2 = timeB:FindFirstChild("Waiting_Fighter_B_2"),
}

local originalCFrames = {}
if arena:IsA("BasePart") then
	originalCFrames[arena] = arena.CFrame
end
for _, d in ipairs(arena:GetDescendants()) do
	if d:IsA("BasePart") then
		originalCFrames[d] = d.CFrame
	end
end
local function restoreArena()
	for part, cf in pairs(originalCFrames) do
		if part.Parent ~= nil then
			part.CFrame = cf
		end
	end
end
local function transformArenaRigid(deltaCF)
	local originCF = arena:IsA("BasePart") and originalCFrames[arena] or originalCFrames[anchors.activeA]
	local rigidDelta = (deltaCF * originCF) * originCF:Inverse()
	for part, origCF in pairs(originalCFrames) do
		if part.Parent ~= nil then
			part.CFrame = rigidDelta * origCF
		end
	end
end

-- Monta assetsRoot isolado com lutadores customizados + clones de jotaro/anubis reais
local customAssetsRoot = Instance.new("Folder")
customAssetsRoot.Name = "L1_1_CustomAssetsRoot"
local assetsFolder = Instance.new("Folder")
assetsFolder.Name = config.ASSETS_FOLDER_NAME
assetsFolder.Parent = customAssetsRoot
local fightersFolder = Instance.new("Folder")
fightersFolder.Name = config.FIGHTER_ASSETS_FOLDER_NAME
fightersFolder.Parent = assetsFolder

buildTallFighter("tall_auto", false).Parent = fightersFolder
buildTallFighter("tall_att", true).Parent = fightersFolder
buildQuadrupedLowFighter("low_iggy_auto", false).Parent = fightersFolder
buildQuadrupedLowFighter("low_iggy_att", true).Parent = fightersFolder
buildClutteredFighter("cluttered_auto").Parent = fightersFolder

local cReal = Combat.new()
cReal:initBillboardPool()

local cCustom = Combat.new(nil, customAssetsRoot, workspace)
cCustom:initBillboardPool()

local ok, failure = pcall(function()
	-- =========================================================================
	-- 1. Rigs reais (Jotaro com Stand + Anubis com Espada) nos anchors reais A/B
	-- =========================================================================
	do
		cReal:onBattleStarted({
			sides = { "A", "B" },
			mode = "PVE",
			fighters = {
				{ sideId = "A", targetId = "j1", fighterId = "jotaro", hp = 120, hpMax = 120, active = true },
				{ sideId = "A", targetId = "a2", fighterId = "anubis", hp = 100, hpMax = 100, active = false },
				{ sideId = "A", targetId = "j3", fighterId = "jotaro", hp = 110, hpMax = 110, active = false },
				{ sideId = "B", targetId = "b1", fighterId = "anubis", hp = 80, hpMax = 80, active = true },
				{ sideId = "B", targetId = "b2", fighterId = "jotaro", hp = 100, hpMax = 100, active = false },
				{ sideId = "B", targetId = "b3", fighterId = "anubis", hp = 90, hpMax = 90, active = false },
			},
		})
		cReal.stageFolder.Name = "L1_1_RealRigsStageQA"

		local j1 = cReal.fightersByTargetId["j1"]
		local a2 = cReal.fightersByTargetId["a2"]
		local j3 = cReal.fightersByTargetId["j3"]
		local b1 = cReal.fightersByTargetId["b1"]
		local b2 = cReal.fightersByTargetId["b2"]
		local b3 = cReal.fightersByTargetId["b3"]

		local jotaroLegs = { "Jotaro_LeftLeg", "Jotaro_RightLeg" }
		local anubisLegs = { "Left Leg", "Right Leg" }

		assertFeetOnAnchorTop(j1, collectRealBodyParts(j1, jotaroLegs), anchors.activeA, "S1: real jotaro active A")
		assertFeetOnAnchorTop(a2, collectRealBodyParts(a2, anubisLegs), anchors.waitA1, "S1: real anubis wait A1")
		assertFeetOnAnchorTop(j3, collectRealBodyParts(j3, jotaroLegs), anchors.waitA2, "S1: real jotaro wait A2")
		assertFeetOnAnchorTop(b1, collectRealBodyParts(b1, anubisLegs), anchors.activeB, "S1: real anubis active B")
		assertFeetOnAnchorTop(b2, collectRealBodyParts(b2, jotaroLegs), anchors.waitB1, "S1: real jotaro wait B1")
		assertFeetOnAnchorTop(b3, collectRealBodyParts(b3, anubisLegs), anchors.waitB2, "S1: real anubis wait B2")

		-- Confirma que o pivot NÃO está mais enterrado no centro da Part (offset Y ~ -1.200)
		check(math.abs(j1.groundContactOffset.Y - (-1.2)) <= 0.01, "S1: jotaro groundContactOffset.Y expected ~-1.2, got " .. tostring(j1.groundContactOffset.Y))
		check(math.abs(b1.groundContactOffset.Y - (-1.2)) <= 0.01, "S1: anubis groundContactOffset.Y expected ~-1.2, got " .. tostring(b1.groundContactOffset.Y))

		cReal:cleanupStage()
		table.insert(scenarios, "S1: real Jotaro & Anubis grounded on active/waiting anchors A/B passed")
	end

	-- =========================================================================
	-- 2. Personagem alto, personagem baixo (proporções Iggy), Stand/acessórios/VFX/hitboxes
	--    + Trocas repetidas sem deslocamento acumulado + KO + Retorno de ataque
	-- =========================================================================
	do
		cCustom:onBattleStarted({
			sides = { "A", "B" },
			mode = "PVE",
			fighters = {
				{ sideId = "A", targetId = "tall", fighterId = "tall_auto", hp = 120, hpMax = 120, active = true },
				{ sideId = "A", targetId = "iggy", fighterId = "low_iggy_auto", hp = 100, hpMax = 100, active = false },
				{ sideId = "A", targetId = "clut", fighterId = "cluttered_auto", hp = 110, hpMax = 110, active = false },
				{ sideId = "B", targetId = "tallAtt", fighterId = "tall_att", hp = 50, hpMax = 50, active = true },
				{ sideId = "B", targetId = "iggyAtt", fighterId = "low_iggy_att", hp = 100, hpMax = 100, active = false },
				{ sideId = "B", targetId = "clutB", fighterId = "cluttered_auto", hp = 90, hpMax = 90, active = false },
			},
		})
		cCustom.stageFolder.Name = "L1_1_MixedProportionsStageQA"

		local tall = cCustom.fightersByTargetId["tall"]
		local iggy = cCustom.fightersByTargetId["iggy"]
		local clut = cCustom.fightersByTargetId["clut"]
		local tallAtt = cCustom.fightersByTargetId["tallAtt"]
		local iggyAtt = cCustom.fightersByTargetId["iggyAtt"]
		local clutB = cCustom.fightersByTargetId["clutB"]

		-- Verifica que Stand/Accessory/VFX/Hitbox/Partículas NÃO alteraram o offset de cluttered_auto (igual a tall_auto = -2.6)
		check(
			(clut.groundContactOffset - tall.groundContactOffset).Magnitude <= STRICT_TOL,
			string.format("S2: Stand/Accessory/VFX/Hitbox must not distort height (tall=%s, clut=%s)", tostring(tall.groundContactOffset), tostring(clut.groundContactOffset))
		)
		check(math.abs(tall.groundContactOffset.Y - (-2.6)) <= TOL, "S2: tall fighter offset expected -2.6, got " .. tostring(tall.groundContactOffset.Y))
		check(math.abs(iggy.groundContactOffset.Y - (-0.48)) <= TOL, "S2: low quadruped (Iggy-like) offset expected -0.48, got " .. tostring(iggy.groundContactOffset.Y))

		-- GroundContact Attachment explícito em tallAtt e iggyAtt deve coincidir com o centro da face superior do anchor
		local tallAttPoint = tallAtt.rootPart:FindFirstChild(config.GROUND_CONTACT_ATTACHMENT_NAME)
		local iggyAttPoint = iggyAtt.rootPart:FindFirstChild(config.GROUND_CONTACT_ATTACHMENT_NAME)
		local topActiveB = Grounding.computeAnchorTopSurfaceCFrame(anchors.activeB).Position
		local topWaitB1 = Grounding.computeAnchorTopSurfaceCFrame(anchors.waitB1).Position
		check((tallAttPoint.WorldPosition - topActiveB).Magnitude <= TOL, "S2: tall GroundContact must match active B top surface")
		check((iggyAttPoint.WorldPosition - topWaitB1).Magnitude <= TOL, "S2: quadruped GroundContact (with X/Z offset) must match wait B1 top surface")

		assertFeetOnAnchorTop(tall, collectRealBodyParts(tall, { "Left Leg", "Right Leg" }), anchors.activeA, "S2: tall active A")
		assertFeetOnAnchorTop(iggy, collectRealBodyParts(iggy, { "PawFL", "PawFR", "PawBL", "PawBR" }), anchors.waitA1, "S2: iggy wait A1")
		assertFeetOnAnchorTop(clut, collectRealBodyParts(clut, { "Left Leg", "Right Leg" }), anchors.waitA2, "S2: cluttered wait A2")
		assertFeetOnAnchorTop(clutB, collectRealBodyParts(clutB, { "Left Leg", "Right Leg" }), anchors.waitB2, "S2: cluttered wait B2")

		-- Repetidas trocas (10 ciclos) entre tall e iggy: ZERO deslocamento acumulado!
		local initialTallActiveCF = tall.homeCFrame
		local initialIggyBenchCF = iggy.homeCFrame
		for cycle = 1, 5 do
			cCustom:onSwitchPerformed({ sideId = "A", previousFighterId = "tall", activeFighterId = "iggy" })
			task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.04)
			assertFeetOnAnchorTop(iggy, collectRealBodyParts(iggy, { "PawFL", "PawFR", "PawBL", "PawBR" }), anchors.activeA, "S2: cycle " .. cycle .. " iggy active")
			assertFeetOnAnchorTop(tall, collectRealBodyParts(tall, { "Left Leg", "Right Leg" }), anchors.waitA1, "S2: cycle " .. cycle .. " tall bench")

			cCustom:onSwitchPerformed({ sideId = "A", previousFighterId = "iggy", activeFighterId = "tall" })
			task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.04)
			assertFeetOnAnchorTop(tall, collectRealBodyParts(tall, { "Left Leg", "Right Leg" }), anchors.activeA, "S2: cycle " .. cycle .. " tall back active")
			assertFeetOnAnchorTop(iggy, collectRealBodyParts(iggy, { "PawFL", "PawFR", "PawBL", "PawBR" }), anchors.waitA1, "S2: cycle " .. cycle .. " iggy back bench")
		end
		check((tall.rootPart.CFrame.Position - initialTallActiveCF.Position).Magnitude <= STRICT_TOL, "S2: zero accumulated drift on tall after 10 switches")
		check((iggy.rootPart.CFrame.Position - initialIggyBenchCF.Position).Magnitude <= STRICT_TOL, "S2: zero accumulated drift on iggy after 10 switches")

		-- Ataque + retorno + KO de tallAtt com substituto automático iggyAtt
		local s1Timeline = SkillData.JOTARO_SKILL_DATA[1]
		cCustom:onAttackStarted({ attackerId = "tall", targetId = "tallAtt", slot = 1 })
		cCustom:onHitResolved({ attackerId = "tall", targetId = "tallAtt", hitIndex = 1, hit = true, damage = 200, crit = false })
		cCustom:onFighterDied({ sideId = "B", fighterId = "tallAtt", nextActive = "iggyAtt" })
		task.wait(s1Timeline.hits[1].time + s1Timeline.returnTime + config.PLACEHOLDER_KO_TWEEN_SECONDS + config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.2)

		assertFeetOnAnchorTop(tall, collectRealBodyParts(tall, { "Left Leg", "Right Leg" }), anchors.activeA, "S2: attacker tall returned grounded after KO")
		assertFeetOnAnchorTop(iggyAtt, collectRealBodyParts(iggyAtt, { "PawFL", "PawFR", "PawBL", "PawBR" }), anchors.activeB, "S2: substitute iggyAtt grounded at active B")
		check((iggyAttPoint.WorldPosition - topActiveB).Magnitude <= TOL, "S2: substitute iggyAtt GroundContact matches active B top surface")
		assertFeetOnAnchorTop(tallAtt, collectRealBodyParts(tallAtt, { "Left Leg", "Right Leg" }), anchors.waitB1, "S2: KO tallAtt grounded at wait B1")

		cCustom:cleanupStage()
		table.insert(scenarios, "S2: tall, low quadruped (Iggy), Stand/Accessory/VFX/Hitbox immunity, 10x switch, KO & return passed")
	end

	-- =========================================================================
	-- 3. Arena transladada e rotacionada em 3D (incluindo pitch e roll — sem eixo Y global!)
	-- =========================================================================
	do
		local delta3D = CFrame.new(-62, 27, 41) * CFrame.Angles(math.rad(35), math.rad(143), math.rad(25))
		transformArenaRigid(delta3D)

		-- Confirma que UpVector do anchor NÃO é o eixo Y global (0,1,0)
		local globalYDot = anchors.activeA.CFrame.UpVector:Dot(Vector3.new(0, 1, 0))
		check(globalYDot < 0.9, "S3: anchor must be genuinely tilted away from global Y (dot=" .. tostring(globalYDot) .. ")")

		cCustom:onBattleStarted({
			sides = { "A", "B" },
			mode = "PVE",
			fighters = {
				{ sideId = "A", targetId = "tall", fighterId = "tall_auto", hp = 120, hpMax = 120, active = true },
				{ sideId = "A", targetId = "iggy", fighterId = "low_iggy_att", hp = 100, hpMax = 100, active = false },
				{ sideId = "A", targetId = "clut", fighterId = "cluttered_auto", hp = 110, hpMax = 110, active = false },
				{ sideId = "B", targetId = "iggyB", fighterId = "low_iggy_auto", hp = 100, hpMax = 100, active = true },
				{ sideId = "B", targetId = "tallB", fighterId = "tall_att", hp = 100, hpMax = 100, active = false },
			},
		})
		cCustom.stageFolder.Name = "L1_1_TiltedArenaStageQA"

		local tall = cCustom.fightersByTargetId["tall"]
		local iggy = cCustom.fightersByTargetId["iggy"]
		local clut = cCustom.fightersByTargetId["clut"]
		local iggyB = cCustom.fightersByTargetId["iggyB"]
		local tallB = cCustom.fightersByTargetId["tallB"]

		assertFeetOnAnchorTop(tall, collectRealBodyParts(tall, { "Left Leg", "Right Leg" }), anchors.activeA, "S3: tilted tall active A")
		assertFeetOnAnchorTop(iggy, collectRealBodyParts(iggy, { "PawFL", "PawFR", "PawBL", "PawBR" }), anchors.waitA1, "S3: tilted iggy wait A1")
		assertFeetOnAnchorTop(clut, collectRealBodyParts(clut, { "Left Leg", "Right Leg" }), anchors.waitA2, "S3: tilted cluttered wait A2")
		assertFeetOnAnchorTop(iggyB, collectRealBodyParts(iggyB, { "PawFL", "PawFR", "PawBL", "PawBR" }), anchors.activeB, "S3: tilted iggy active B")
		assertFeetOnAnchorTop(tallB, collectRealBodyParts(tallB, { "Left Leg", "Right Leg" }), anchors.waitB1, "S3: tilted tall wait B1")

		local iggyAttPoint = iggy.rootPart:FindFirstChild(config.GROUND_CONTACT_ATTACHMENT_NAME)
		local topWaitA1 = Grounding.computeAnchorTopSurfaceCFrame(anchors.waitA1).Position
		check((iggyAttPoint.WorldPosition - topWaitA1).Magnitude <= TOL, "S3: tilted GroundContact coincides with tilted top surface center")

		-- Troca na arena inclinada/girada
		cCustom:onSwitchPerformed({ sideId = "A", previousFighterId = "tall", activeFighterId = "iggy" })
		task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.08)
		assertFeetOnAnchorTop(iggy, collectRealBodyParts(iggy, { "PawFL", "PawFR", "PawBL", "PawBR" }), anchors.activeA, "S3: tilted switch iggy -> active A")
		assertFeetOnAnchorTop(tall, collectRealBodyParts(tall, { "Left Leg", "Right Leg" }), anchors.waitA1, "S3: tilted switch tall -> wait A1")

		restoreArena()
		cCustom:cleanupStage()
		table.insert(scenarios, "S3: 3D translated + pitched/rolled/yawed arena grounding (no global Y dependency) passed")
	end

	-- =========================================================================
	-- 4. Ausência de GroundContact (visível e estrutural) e geometria inválida
	-- =========================================================================
	do
		-- 4a. Fallback estrutural quando todas as partes físicas são transparentes (sem GroundContact)
		local transparentRig = Instance.new("Model")
		transparentRig.Name = "TransparentRig"
		local tHrp = Instance.new("Part")
		tHrp.Name = "HumanoidRootPart"
		tHrp.Size = Vector3.new(1, 1, 1)
		tHrp.Transparency = 1
		tHrp.CFrame = CFrame.new(0, 5, 0)
		tHrp.Parent = transparentRig
		transparentRig.PrimaryPart = tHrp
		local tLeg = Instance.new("Part")
		tLeg.Name = "Left Leg"
		tLeg.Size = Vector3.new(0.4, 1.0, 0.4)
		tLeg.Transparency = 1
		tLeg.CFrame = tHrp.CFrame * CFrame.new(0, -1.0, 0) -- bottom = -1.5
		tLeg.Parent = transparentRig
		local resStruct = Grounding.resolveFighterGroundContact(transparentRig, tHrp, nil)
		check(resStruct.valid and resStruct.source == "structural_body", "S4a: transparent rig must use structural_body fallback")
		check(math.abs(resStruct.offset.Y - (-1.5)) <= STRICT_TOL, "S4a: structural_body offset expected -1.5, got " .. tostring(resStruct.offset.Y))
		transparentRig:Destroy()

		-- 4b. GroundContact duplicado -> ignora ambiguidade e cai determinístico para corpo físico
		local dupModel = buildTallFighter("DupContact", true)
		local dupAtt = Instance.new("Attachment")
		dupAtt.Name = config.GROUND_CONTACT_ATTACHMENT_NAME
		dupAtt.Position = Vector3.new(0, -9.0, 0)
		dupAtt.Parent = dupModel.PrimaryPart
		local resDup = Grounding.resolveFighterGroundContact(dupModel, dupModel.PrimaryPart, nil)
		check(resDup.valid and resDup.source == "visible_body", "S4b: duplicate GroundContact must fall back to visible_body")
		check(math.abs(resDup.offset.Y - (-2.6)) <= STRICT_TOL, "S4b: duplicate GroundContact fallback offset expected -2.6")
		dupModel:Destroy()

		-- 4c. GroundContact com posição NaN -> ignora e cai para corpo físico
		local nanAttModel = buildQuadrupedLowFighter("NanContact", true)
		local badAtt = nanAttModel.PrimaryPart:FindFirstChild(config.GROUND_CONTACT_ATTACHMENT_NAME)
		badAtt.Position = Vector3.new(0 / 0, -1, 0)
		local resNanAtt = Grounding.resolveFighterGroundContact(nanAttModel, nanAttModel.PrimaryPart, nil)
		check(resNanAtt.valid and resNanAtt.source == "visible_body", "S4c: NaN GroundContact must fall back to visible_body")
		check(math.abs(resNanAtt.offset.Y - (-0.48)) <= STRICT_TOL, "S4c: NaN GroundContact fallback offset expected -0.48")
		nanAttModel:Destroy()

		-- 4d. Geometria inválida: modelo contendo apenas partes excluídas (Hitbox/VFX/Stand) -> diagnóstico claro, offset zero finito
		local invalidModel = Instance.new("Model")
		invalidModel.Name = "InvalidOnlyHitbox"
		local badRoot = Instance.new("Part")
		badRoot.Name = "HitboxRoot"
		badRoot.Size = Vector3.new(1, 2, 1)
		badRoot.CFrame = CFrame.new(0, 5, 0)
		badRoot.Parent = invalidModel
		invalidModel.PrimaryPart = badRoot
		local resInv = Grounding.resolveFighterGroundContact(invalidModel, badRoot, nil)
		check(not resInv.valid and resInv.source == "fallback_invalid", "S4d: invalid geometry must report fallback_invalid")
		check(resInv.diagnostic ~= nil and #resInv.diagnostic > 0, "S4d: invalid geometry must provide diagnostic message")
		check(resInv.offset == Vector3.zero, "S4d: invalid geometry must not invent magic height offset")
		local alignedInv = Grounding.alignFighterCFrameToAnchor(anchors.activeA, resInv.offset)
		local topA = Grounding.computeAnchorTopSurfaceCFrame(anchors.activeA)
		check((alignedInv.Position - topA.Position).Magnitude <= STRICT_TOL, "S4d: fallback_invalid aligns cleanly to anchor top without NaN")
		invalidModel:Destroy()

		-- 4e. Offset não finito em alignFighterCFrameToAnchor -> retorna plano superior sem NaN
		local alignedNan = Grounding.alignFighterCFrameToAnchor(anchors.activeA, Vector3.new(0, 0 / 0, 0))
		check((alignedNan.Position - topA.Position).Magnitude <= STRICT_TOL, "S4e: non-finite offset falls back safely to anchor top surface")

		table.insert(scenarios, "S4: missing GroundContact (visible & structural) and invalid geometry diagnostics passed")
	end
end)

restoreArena()
cReal:cleanupStage()
if cReal.poolContainer then cReal.poolContainer:Destroy() end
cCustom:cleanupStage()
if cCustom.poolContainer then cCustom.poolContainer:Destroy() end
customAssetsRoot:Destroy()
assert(ok, failure)
return { result = "L1_1_FIGHTER_GROUNDING_QA_PASSED", checks = checks, scenarios = scenarios }
