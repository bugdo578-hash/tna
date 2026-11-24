-- Execute no Client em Play novo após rbxtsc/Rojo. Controllers isolados, sem servidor/perfis.
-- QA L1: posicionamento 3D dos lutadores nos anchors reais de Workspace.Arena_bases.
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local CombatArenaAnchors = require(ts.Controllers.CombatArenaAnchors)
local CombatFighterGrounding = require(ts.Controllers.CombatFighterGrounding)
local config = require(ts.UI.CombatVisualConfig)
local SkillData = require(game.ReplicatedStorage.TS.SkillData)

local checks = 0
local scenarios = {}
local TOL = config.COMBAT_POSITION_TOLERANCE_STUDS
local ROT_DOT_MIN = 0.9999

local function check(condition, message)
	checks += 1
	assert(condition, message)
end

local function assertCFrameClose(actual, expected, posTol, rotDotMin, label)
	local posErr = (actual.Position - expected.Position).Magnitude
	local lookDot = actual.LookVector:Dot(expected.LookVector)
	local rightDot = actual.RightVector:Dot(expected.RightVector)
	local upDot = actual.UpVector:Dot(expected.UpVector)
	check(
		posErr <= posTol and lookDot >= rotDotMin and rightDot >= rotDotMin and upDot >= rotDotMin,
		string.format(
			"%s (posErr=%.5f, lookDot=%.5f, rightDot=%.5f, upDot=%.5f)",
			label,
			posErr,
			lookDot,
			rightDot,
			upDot
		)
	)
end

local function assertAlignedToAnchor(actual, anchorPart, fighter, label)
	local expected = CombatFighterGrounding.alignFighterCFrameToAnchor(anchorPart, fighter.groundContactOffset)
	assertCFrameClose(actual, expected, TOL, ROT_DOT_MIN, label)
end

local arena = workspace:FindFirstChild(config.ARENA_BASES_NAME)
check(arena ~= nil, "Workspace.Arena_bases must exist in Studio")

local timeA = arena:FindFirstChild("Time A")
local timeB = arena:FindFirstChild("Time B")
check(timeA ~= nil and timeB ~= nil, "Arena_bases must contain Time A and Time B folders")

local anchorParts = {
	activeA = timeA:FindFirstChild("Current_Fighter_A"),
	waitA1 = timeA:FindFirstChild("Waiting_Fighter_A"),
	waitA2 = timeA:FindFirstChild("Waiting_Fighter_A_2"),
	activeB = timeB:FindFirstChild("Current_Fighter_B"),
	waitB1 = timeB:FindFirstChild("Waiting_Fighter_B"),
	waitB2 = timeB:FindFirstChild("Waiting_Fighter_B_2"),
}
for key, part in pairs(anchorParts) do
	check(part ~= nil and part:IsA("BasePart"), "Missing or non-BasePart anchor: " .. key)
end

-- Snapshot completo de todos os BaseParts da arena para restauração garantida ao final.
local originalPartCFrames = {}
if arena:IsA("BasePart") then
	originalPartCFrames[arena] = arena.CFrame
end
for _, desc in ipairs(arena:GetDescendants()) do
	if desc:IsA("BasePart") then
		originalPartCFrames[desc] = desc.CFrame
	end
end

local function restoreArenaTransform()
	for part, cf in pairs(originalPartCFrames) do
		if part.Parent ~= nil then
			part.CFrame = cf
		end
	end
end

local function transformArenaRigid(deltaCFrame)
	local originCF = arena:IsA("BasePart") and originalPartCFrames[arena] or originalPartCFrames[anchorParts.activeA]
	local targetOrigin = deltaCFrame * originCF
	local rigidDelta = targetOrigin * originCF:Inverse()
	for part, origCF in pairs(originalPartCFrames) do
		if part.Parent ~= nil then
			part.CFrame = rigidDelta * origCF
		end
	end
end

local function make3v3Payload(side0Id, side1Id, mode)
	return {
		sides = { side0Id, side1Id },
		mode = mode or "PVE",
		canPause = (mode or "PVE") == "PVE",
		fighters = {
			{ sideId = side0Id, targetId = "a1", fighterId = "jotaro", hp = 120, hpMax = 120, active = true },
			{ sideId = side0Id, targetId = "a2", fighterId = "anubis", hp = 100, hpMax = 100, active = false },
			{ sideId = side0Id, targetId = "a3", fighterId = "jotaro", hp = 110, hpMax = 110, active = false },
			{ sideId = side1Id, targetId = "b1", fighterId = "anubis", hp = 80, hpMax = 80, active = true },
			{ sideId = side1Id, targetId = "b2", fighterId = "jotaro", hp = 100, hpMax = 100, active = false },
			{ sideId = side1Id, targetId = "b3", fighterId = "anubis", hp = 90, hpMax = 90, active = false },
		},
	}
end

local function buildSyntheticArenaRoot()
	local root = Instance.new("Folder")
	root.Name = "L1SyntheticRoot"
	local arenaPart = Instance.new("Part")
	arenaPart.Name = config.ARENA_BASES_NAME
	arenaPart.Anchored = true
	arenaPart.Parent = root

	local function addTeam(folderName, activeName, wait1Name, wait2Name, zSign)
		local folder = Instance.new("Folder")
		folder.Name = folderName
		folder.Parent = arenaPart
		local specs = {
			{ activeName, CFrame.new(0, 5, 7 * zSign) * CFrame.Angles(0, math.rad(45 * zSign), 0) },
			{ wait1Name, CFrame.new(-4, 2, 8 * zSign) * CFrame.Angles(0, math.rad(30 * zSign), 0) },
			{ wait2Name, CFrame.new(4, 2, 8 * zSign) * CFrame.Angles(0, math.rad(60 * zSign), 0) },
		}
		for _, spec in ipairs(specs) do
			local p = Instance.new("Part")
			p.Name = spec[1]
			p.Anchored = true
			p.CFrame = spec[2]
			p.Parent = folder
		end
		return folder
	end

	local fA = addTeam("Time A", "Current_Fighter_A", "Waiting_Fighter_A", "Waiting_Fighter_A_2", 1)
	local fB = addTeam("Time B", "Current_Fighter_B", "Waiting_Fighter_B", "Waiting_Fighter_B_2", -1)
	return root, arenaPart, fA, fB
end

local c = Combat.new()
c:initBillboardPool()

local localChar = game.Players.LocalPlayer.Character
local localHrp = localChar and localChar:FindFirstChild("HumanoidRootPart")
local initialPlayerPos = localHrp and localHrp.Position or nil

local ok, failure = pcall(function()
	-- =========================================================================
	-- 1. Arena na posição original: ativos A/B + reservas 1 e 2 + cache único
	-- =========================================================================
	do
		local resolveCalls = 0
		local origResolve = c.arenaAnchors.resolveForBattle
		c.arenaAnchors.resolveForBattle = function(self)
			resolveCalls += 1
			return origResolve(self)
		end

		c:onBattleStarted(make3v3Payload("A", "B", "PVE"))
		c.stageFolder.Name = "L1OriginalArenaStageQA"
		check(resolveCalls == 1, "S1: resolveForBattle must be called once per battle, got " .. tostring(resolveCalls))

		local resolved = c:getResolvedArenaAnchors()
		check(resolved ~= nil and resolved.root == arena, "S1: resolved arena root must be Workspace.Arena_bases")
		check(#c:getArenaAnchorDiagnostics() == 0, "S1: valid arena must produce zero diagnostics")

		local a1 = c.fightersByTargetId["a1"]
		local a2 = c.fightersByTargetId["a2"]
		local a3 = c.fightersByTargetId["a3"]
		local b1 = c.fightersByTargetId["b1"]
		local b2 = c.fightersByTargetId["b2"]
		local b3 = c.fightersByTargetId["b3"]

		assertAlignedToAnchor(a1.homeCFrame, anchorParts.activeA, a1, "S1: a1 homeCFrame == Current_Fighter_A")
		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.activeA, a1, "S1: a1 rootPart == Current_Fighter_A")
		assertAlignedToAnchor(a2.homeCFrame, anchorParts.waitA1, a2, "S1: a2 homeCFrame == Waiting_Fighter_A")
		assertAlignedToAnchor(a2.rootPart.CFrame, anchorParts.waitA1, a2, "S1: a2 rootPart == Waiting_Fighter_A")
		assertAlignedToAnchor(a3.homeCFrame, anchorParts.waitA2, a3, "S1: a3 homeCFrame == Waiting_Fighter_A_2")
		assertAlignedToAnchor(a3.rootPart.CFrame, anchorParts.waitA2, a3, "S1: a3 rootPart == Waiting_Fighter_A_2")

		assertAlignedToAnchor(b1.homeCFrame, anchorParts.activeB, b1, "S1: b1 homeCFrame == Current_Fighter_B")
		assertAlignedToAnchor(b1.rootPart.CFrame, anchorParts.activeB, b1, "S1: b1 rootPart == Current_Fighter_B")
		assertAlignedToAnchor(b2.homeCFrame, anchorParts.waitB1, b2, "S1: b2 homeCFrame == Waiting_Fighter_B")
		assertAlignedToAnchor(b2.rootPart.CFrame, anchorParts.waitB1, b2, "S1: b2 rootPart == Waiting_Fighter_B")
		assertAlignedToAnchor(b3.homeCFrame, anchorParts.waitB2, b3, "S1: b3 homeCFrame == Waiting_Fighter_B_2")
		assertAlignedToAnchor(b3.rootPart.CFrame, anchorParts.waitB2, b3, "S1: b3 rootPart == Waiting_Fighter_B_2")

		-- Troca voluntária com reserva 2 (a1 <-> a3): a1 deve ocupar Waiting_Fighter_A_2, a2 permanece em Waiting_Fighter_A
		c:onSwitchPerformed({ sideId = "A", previousFighterId = "a1", activeFighterId = "a3" })
		task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.08)
		check(resolveCalls == 1, "S1: voluntary switch must reuse cached anchors without re-resolving")
		assertAlignedToAnchor(a3.rootPart.CFrame, anchorParts.activeA, a3, "S1: a3 active after voluntary switch")
		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.waitA2, a1, "S1: a1 moved to vacated Waiting_Fighter_A_2")
		assertAlignedToAnchor(a2.rootPart.CFrame, anchorParts.waitA1, a2, "S1: a2 untouched at Waiting_Fighter_A")

		-- Troca voluntária com reserva 1 (a3 <-> a2): a3 deve ocupar Waiting_Fighter_A, a1 permanece em Waiting_Fighter_A_2
		c:onSwitchPerformed({ sideId = "A", previousFighterId = "a3", activeFighterId = "a2" })
		task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.08)
		assertAlignedToAnchor(a2.rootPart.CFrame, anchorParts.activeA, a2, "S1: a2 active after second voluntary switch")
		assertAlignedToAnchor(a3.rootPart.CFrame, anchorParts.waitA1, a3, "S1: a3 moved to vacated Waiting_Fighter_A")
		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.waitA2, a1, "S1: a1 untouched at Waiting_Fighter_A_2")

		-- Volta a1 (Jotaro com Stand) para ativo para validar ataque ORA ORA + retorno do atacante/Stand
		c:onSwitchPerformed({ sideId = "A", previousFighterId = "a2", activeFighterId = "a1" })
		task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.08)
		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.activeA, a1, "S1: a1 active before ORA ORA")

		check(a1.standMotion ~= nil and a1.standMotion.joint.Part1 ~= nil, "S1: Jotaro requires real StandJoint")
		local standBaseC1 = a1.standMotion.baseC1
		local standWorldBase = a1.standMotion.joint.Part1.CFrame
		local oraTimeline = SkillData.JOTARO_SKILL_DATA[2]
		c:onAttackStarted({ attackerId = "a1", targetId = "b1", slot = 2 })
		for idx, hit in ipairs(oraTimeline.hits) do
			c:delayBattle(hit.time, function()
				c:onHitResolved({
					attackerId = "a1",
					targetId = "b1",
					hitIndex = idx,
					hit = true,
					damage = 5,
					crit = false,
				})
			end)
		end
		task.wait(oraTimeline.hits[#oraTimeline.hits].time + oraTimeline.returnTime + config.HIT_RESULT_WAIT_SECONDS)
		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.activeA, a1, "S1: attacker returned to Current_Fighter_A")
		assertCFrameClose(a1.standMotion.joint.C1, standBaseC1, TOL, ROT_DOT_MIN, "S1: Stand joint C1 returned to base")
		assertCFrameClose(a1.standMotion.joint.Part1.CFrame, standWorldBase, TOL, ROT_DOT_MIN, "S1: Stand world CFrame returned to base")

		-- KO de b1 com substituto automático b2 (Waiting_Fighter_B -> Current_Fighter_B, b1 morto -> Waiting_Fighter_B, b3 permanece em Waiting_Fighter_B_2)
		local s1Timeline = SkillData.JOTARO_SKILL_DATA[1]
		c:onAttackStarted({ attackerId = "a1", targetId = "b1", slot = 1 })
		c:onHitResolved({ attackerId = "a1", targetId = "b1", hitIndex = 1, hit = true, damage = 200, crit = false })
		c:onFighterDied({ sideId = "B", fighterId = "b1", nextActive = "b2" })
		task.wait(s1Timeline.hits[1].time + s1Timeline.returnTime + config.PLACEHOLDER_KO_TWEEN_SECONDS + config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.2)
		check(b1.dead and not b1.active and b2.active and not b2.dead, "S1: b1 dead and b2 promoted after KO")
		assertAlignedToAnchor(b1.rootPart.CFrame, anchorParts.waitB1, b1, "S1: dead b1 moved to Waiting_Fighter_B")
		assertAlignedToAnchor(b2.rootPart.CFrame, anchorParts.activeB, b2, "S1: substitute b2 moved to Current_Fighter_B")
		assertAlignedToAnchor(b3.rootPart.CFrame, anchorParts.waitB2, b3, "S1: b3 untouched at Waiting_Fighter_B_2")
		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.activeA, a1, "S1: a1 returned after KO attack")
		check(resolveCalls == 1, "S1: entire battle resolved arena anchors exactly once")

		c.arenaAnchors.resolveForBattle = origResolve
		table.insert(scenarios, "S1: original arena + 3v3 + switches + ORA return + KO auto-switch passed")
	end

	-- =========================================================================
	-- 2. Teardown + Nova batalha com Arena transladada e girada
	-- =========================================================================
	do
		c:cleanupStage()
		check(c:getResolvedArenaAnchors() == nil, "S2: cleanupStage must clear cached arena anchors")
		check(c.stageFolder == nil, "S2: cleanupStage must clear stageFolder")

		-- Translada e gira a arena inteira (ex.: +47, +11, -33 e rotação composta Y=127°, X=8°, Z=-5°)
		local delta = CFrame.new(47, 11, -33) * CFrame.Angles(math.rad(8), math.rad(127), math.rad(-5))
		transformArenaRigid(delta)

		-- Verifica que os anchors realmente mudaram de posição e orientação antes da nova batalha
		local movedDist = (anchorParts.activeA.CFrame.Position - originalPartCFrames[anchorParts.activeA].Position).Magnitude
		check(movedDist > 20, "S2: transformed arena must differ significantly from original")

		c:onBattleStarted(make3v3Payload("A", "B", "PVE"))
		c.stageFolder.Name = "L1TransformedArenaStageQA"

		local a1 = c.fightersByTargetId["a1"]
		local a2 = c.fightersByTargetId["a2"]
		local a3 = c.fightersByTargetId["a3"]
		local b1 = c.fightersByTargetId["b1"]
		local b2 = c.fightersByTargetId["b2"]
		local b3 = c.fightersByTargetId["b3"]

		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.activeA, a1, "S2: transformed a1 == Current_Fighter_A")
		assertAlignedToAnchor(a2.rootPart.CFrame, anchorParts.waitA1, a2, "S2: transformed a2 == Waiting_Fighter_A")
		assertAlignedToAnchor(a3.rootPart.CFrame, anchorParts.waitA2, a3, "S2: transformed a3 == Waiting_Fighter_A_2")
		assertAlignedToAnchor(b1.rootPart.CFrame, anchorParts.activeB, b1, "S2: transformed b1 == Current_Fighter_B")
		assertAlignedToAnchor(b2.rootPart.CFrame, anchorParts.waitB1, b2, "S2: transformed b2 == Waiting_Fighter_B")
		assertAlignedToAnchor(b3.rootPart.CFrame, anchorParts.waitB2, b3, "S2: transformed b3 == Waiting_Fighter_B_2")

		-- Troca + KO + retorno do atacante/Stand na arena girada e transladada
		local standBaseC1 = a1.standMotion.baseC1
		local standWorldBase = a1.standMotion.joint.Part1.CFrame
		local s1Timeline = SkillData.JOTARO_SKILL_DATA[1]
		c:onAttackStarted({ attackerId = "a1", targetId = "b1", slot = 1 })
		c:onHitResolved({ attackerId = "a1", targetId = "b1", hitIndex = 1, hit = true, damage = 200, crit = false })
		c:onFighterDied({ sideId = "B", fighterId = "b1", nextActive = "b3" })
		task.wait(s1Timeline.hits[1].time + s1Timeline.returnTime + config.PLACEHOLDER_KO_TWEEN_SECONDS + config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.2)

		assertAlignedToAnchor(a1.rootPart.CFrame, anchorParts.activeA, a1, "S2: transformed attacker returned")
		assertCFrameClose(a1.standMotion.joint.C1, standBaseC1, TOL, ROT_DOT_MIN, "S2: transformed Stand C1 returned")
		assertCFrameClose(a1.standMotion.joint.Part1.CFrame, standWorldBase, TOL, ROT_DOT_MIN, "S2: transformed Stand world returned")
		assertAlignedToAnchor(b3.rootPart.CFrame, anchorParts.activeB, b3, "S2: transformed substitute b3 at Current_Fighter_B")
		assertAlignedToAnchor(b1.rootPart.CFrame, anchorParts.waitB2, b1, "S2: transformed dead b1 at vacated Waiting_Fighter_B_2")
		assertAlignedToAnchor(b2.rootPart.CFrame, anchorParts.waitB1, b2, "S2: transformed b2 untouched at Waiting_Fighter_B")

		restoreArenaTransform()
		c:cleanupStage()
		table.insert(scenarios, "S2: teardown + translated/rotated arena + full orientation + KO/switch/return passed")
	end

	-- =========================================================================
	-- 3. PvP com lados invertidos (sides = { "B", "A" }): preservação da identidade visual
	-- =========================================================================
	do
		c:onBattleStarted(make3v3Payload("B", "A", "PVP"))
		c.stageFolder.Name = "L1PvpSwappedSidesStageQA"

		-- Lado local ("B", sides[0]) deve ocupar Time A (sideIndex 0); oponente ("A", sides[1]) ocupa Time B (sideIndex 1)
		local local1 = c.fightersByTargetId["a1"]
		local local2 = c.fightersByTargetId["a2"]
		local local3 = c.fightersByTargetId["a3"]
		local opp1 = c.fightersByTargetId["b1"]
		local opp2 = c.fightersByTargetId["b2"]
		local opp3 = c.fightersByTargetId["b3"]

		check(local1.sideId == "B" and local1.sideIndex == 0, "S3: PvP local side B must map to sideIndex 0")
		check(opp1.sideId == "A" and opp1.sideIndex == 1, "S3: PvP opponent side A must map to sideIndex 1")

		assertAlignedToAnchor(local1.rootPart.CFrame, anchorParts.activeA, local1, "S3: PvP local active at Current_Fighter_A")
		assertAlignedToAnchor(local2.rootPart.CFrame, anchorParts.waitA1, local2, "S3: PvP local wait 1 at Waiting_Fighter_A")
		assertAlignedToAnchor(local3.rootPart.CFrame, anchorParts.waitA2, local3, "S3: PvP local wait 2 at Waiting_Fighter_A_2")
		assertAlignedToAnchor(opp1.rootPart.CFrame, anchorParts.activeB, opp1, "S3: PvP opponent active at Current_Fighter_B")
		assertAlignedToAnchor(opp2.rootPart.CFrame, anchorParts.waitB1, opp2, "S3: PvP opponent wait 1 at Waiting_Fighter_B")
		assertAlignedToAnchor(opp3.rootPart.CFrame, anchorParts.waitB2, opp3, "S3: PvP opponent wait 2 at Waiting_Fighter_B_2")

		c:onSwitchPerformed({ sideId = "B", previousFighterId = "a1", activeFighterId = "a2" })
		task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.08)
		assertAlignedToAnchor(local2.rootPart.CFrame, anchorParts.activeA, local2, "S3: PvP local switch active at Current_Fighter_A")
		assertAlignedToAnchor(local1.rootPart.CFrame, anchorParts.waitA1, local1, "S3: PvP local switch bench at Waiting_Fighter_A")

		c:cleanupStage()
		table.insert(scenarios, "S3: PvP reversed sides preserve visual side identity passed")
	end

	-- =========================================================================
	-- 4. Ausência de referências, duplicatas, tipo inválido e remoção em runtime
	-- =========================================================================
	do
		local function testInvalidRoot(label, mutateFn, expectedFragment)
			local root, arenaPart, fA, fB = buildSyntheticArenaRoot()
			mutateFn(root, arenaPart, fA, fB)
			local childrenBefore = #root:GetDescendants()

			local res = CombatArenaAnchors.resolveArenaAnchors(root)
			check(not res.ok and res.anchors == nil, label .. ": resolveArenaAnchors must fail")
			check(#res.diagnostics >= 1, label .. ": diagnostics must not be empty")
			local joined = table.concat(res.diagnostics, " | ")
			check(
				string.find(joined, expectedFragment, 1, true) ~= nil,
				label .. ": diagnostic must mention '" .. expectedFragment .. "', got: " .. joined
			)

			local isolated = Combat.new(nil, game.ReplicatedStorage, root)
			isolated:initBillboardPool()
			isolated:onBattleStarted(make3v3Payload("A", "B", "PVE"))
			check(isolated:getResolvedArenaAnchors() == nil, label .. ": controller must not cache anchors on failure")
			check(isolated.stageFolder == nil, label .. ": controller must not create stage with invented coordinates")
			check(next(isolated.fightersByTargetId) == nil, label .. ": controller must not spawn fighters when arena is invalid")
			check(#isolated:getArenaAnchorDiagnostics() >= 1, label .. ": controller must keep failure diagnostics")
			check(#root:GetDescendants() == childrenBefore, label .. ": resolver must never create substitute Parts")

			isolated:cleanupStage()
			isolated.poolContainer:Destroy()
			root:Destroy()
		end

		-- 4a. Arena_bases ausente
		testInvalidRoot("S4a_missing_arena", function(_, arenaPart)
			arenaPart:Destroy()
		end, "Arena_bases")

		-- 4b. Arena_bases duplicada
		testInvalidRoot("S4b_duplicate_arena", function(root)
			local dup = Instance.new("Part")
			dup.Name = config.ARENA_BASES_NAME
			dup.Parent = root
		end, "duplicada")

		-- 4c. Pasta Time B ausente
		testInvalidRoot("S4c_missing_team_folder", function(_, _, _, fB)
			fB:Destroy()
		end, "Time B")

		-- 4d. Anchor Part ausente (Waiting_Fighter_B_2)
		testInvalidRoot("S4d_missing_waiting_part", function(_, _, _, fB)
			fB:FindFirstChild("Waiting_Fighter_B_2"):Destroy()
		end, "Waiting_Fighter_B_2")

		-- 4e. Anchor Part duplicada (Waiting_Fighter_A)
		testInvalidRoot("S4e_duplicate_waiting_part", function(_, _, fA)
			local dup = Instance.new("Part")
			dup.Name = "Waiting_Fighter_A"
			dup.Parent = fA
		end, "duplicada")

		-- 4f. Referência de tipo inválido (Current_Fighter_B como Folder em vez de BasePart)
		testInvalidRoot("S4f_invalid_part_class", function(_, _, _, fB)
			fB:FindFirstChild("Current_Fighter_B"):Destroy()
			local bad = Instance.new("Folder")
			bad.Name = "Current_Fighter_B"
			bad.Parent = fB
		end, "BasePart")

		-- 4g. Remoção em runtime e benchSlot fora da faixa
		local root, _, fA, fB = buildSyntheticArenaRoot()
		local isolated = Combat.new(nil, game.ReplicatedStorage, root)
		isolated:initBillboardPool()
		isolated:onBattleStarted(make3v3Payload("A", "B", "PVE"))
		check(isolated:getResolvedArenaAnchors() ~= nil, "S4g: synthetic valid arena must resolve")
		check(isolated:computeBenchSlotCFrame(0, -1) == nil, "S4g: negative benchSlot must return nil")
		check(isolated:computeBenchSlotCFrame(0, 2) == nil, "S4g: out-of-range benchSlot must return nil")
		check(isolated:computeBenchSlotCFrame(1, 0.5) == nil, "S4g: fractional benchSlot must return nil")

		local activePartA = fA:FindFirstChild("Current_Fighter_A")
		activePartA.Parent = nil
		check(isolated:computeActiveSlotCFrame(0) == nil, "S4g: detached active anchor must return nil instead of stale/invented CFrame")
		local waitPartB = fB:FindFirstChild("Waiting_Fighter_B")
		waitPartB.Parent = nil
		check(isolated:computeBenchSlotCFrame(1, 0) == nil, "S4g: detached waiting anchor must return nil")

		isolated:cleanupStage()
		isolated.poolContainer:Destroy()
		root:Destroy()
		table.insert(scenarios, "S4: missing/duplicate/invalid/detached arena anchor diagnostics passed")
	end

	-- =========================================================================
	-- 5. Personagem do jogador inalterado
	-- =========================================================================
	do
		if initialPlayerPos ~= nil and localHrp ~= nil and localHrp.Parent ~= nil then
			local playerDelta = (localHrp.Position - initialPlayerPos).Magnitude
			check(playerDelta < 1.0, "S5: local player character must not be teleported by L1 (delta=" .. tostring(playerDelta) .. ")")
		end
		table.insert(scenarios, "S5: player character position untouched passed")
	end
end)

restoreArenaTransform()
c:cleanupStage()
if c.poolContainer then
	c.poolContainer:Destroy()
end
assert(ok, failure)
return { result = "L1_ARENA_ANCHORS_QA_PASSED", checks = checks, scenarios = scenarios }
