-- Execute no Client em Play novo após rbxtsc/Rojo. Controllers isolados, sem servidor/perfis.
-- QA K1: A-03 (finalização prematura de multi-hit) e A-02 (cleanupStage com geração obsoleta).
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local CombatHitQueue = require(ts.Controllers.CombatHitQueue).CombatHitQueue

local checks = 0
local scenarios = {}
local function check(condition, message)
	checks += 1
	assert(condition, message)
end

local c = Combat.new()
c:initBillboardPool()

local function makeThreeHitTimeline()
	return {
		name = "K1ThreeHitQA",
		returnTime = 0.12,
		dodgeReturnTime = 0.08,
		hits = {
			{ time = 0.05 },
			{ time = 0.10 },
			{ time = 0.15 },
		},
	}
end

local function startBattle(stageName)
	c:onBattleStarted({
		sides = { "A", "B" },
		fighters = {
			{ sideId = "A", targetId = "own-1", fighterId = "dummy", hp = 100, hpMax = 100, active = true },
			{ sideId = "A", targetId = "own-2", fighterId = "dummy", hp = 100, hpMax = 100, active = false },
			{ sideId = "B", targetId = "enemy", fighterId = "dummy", hp = 100, hpMax = 100, active = true },
		},
	})
	if c.stageFolder then
		c.stageFolder.Name = stageName
	end
	return c:getBattleGeneration()
end

local ok, failure = pcall(function()
	-- =========================================================================
	-- A-03 (integrado): ataque de 3 hits, hit 3 consumido antes do hit 2 com troca enfileirada
	-- =========================================================================
	startBattle("K1MultiHitStageQA")
	local own1 = c.fightersByTargetId["own-1"]
	local own2 = c.fightersByTargetId["own-2"]
	local enemy = c.fightersByTargetId["enemy"]
	check(own1 ~= nil and own2 ~= nil and enemy ~= nil, "A-03 fixture fighters missing")

	local timeline = makeThreeHitTimeline()
	c.currentAttackToken += 1
	local attackToken = c.currentAttackToken
	c.followUpCancelledForCurrentAttack = false
	c.hitQueue:beginAttack(3)

	for hitIndex = 1, 3 do
		c:onHitResolved({
			attackerId = "own-1",
			targetId = "enemy",
			hitIndex = hitIndex,
			hit = true,
			damage = 10,
			crit = false,
		})
	end

	-- Enfileira SwitchPerformed enquanto há hits pendentes
	c:onSwitchPerformed({
		sideId = "A",
		previousFighterId = "own-1",
		activeFighterId = "own-2",
	})
	check(c.hitQueue:hasPendingHits(), "A-03: hasPendingHits must be true before consuming hits")
	check(c.activePendingHits == 3, "A-03: activePendingHits expected 3, got " .. tostring(c.activePendingHits))
	check(#c.pendingSwitches == 1, "A-03: switch should be queued while hits are pending")
	check(own1.active and not own2.active, "A-03: switch must not apply before hits finish")

	-- Consome hit 1
	c:waitForAndConsumeHitIndex(1, own1, enemy, timeline, attackToken, 2)
	check(c.hitQueue:hasPendingHits(), "A-03: hasPendingHits must remain true after hit 1")
	check(c.activePendingHits == 2, "A-03: activePendingHits expected 2 after hit 1, got " .. tostring(c.activePendingHits))
	check(#c.pendingSwitches == 1 and own1.active and not own2.active, "A-03: switch applied prematurely after hit 1")

	-- Consome hit 3 ANTES do hit 2
	c:waitForAndConsumeHitIndex(3, own1, enemy, timeline, attackToken, 2)
	check(c.hitQueue:hasPendingHits(), "A-03: hasPendingHits must remain true when hit 3 is consumed before hit 2")
	check(c.activePendingHits == 1, "A-03: activePendingHits expected 1 when hit 2 is still pending, got " .. tostring(c.activePendingHits))
	check(#c.pendingSwitches == 1, "A-03: pending switch must remain queued until hit 2 is consumed")
	check(own1.active and not own2.active, "A-03: switch was applied prematurely before hit 2")

	-- Consumo duplicado do hit 3 não pode decrementar nem finalizar
	c:waitForAndConsumeHitIndex(3, own1, enemy, timeline, attackToken, 2)
	check(c.hitQueue:hasPendingHits(), "A-03: duplicate hit 3 must keep hasPendingHits true")
	check(c.activePendingHits == 1, "A-03: duplicate hit 3 must not decrement activePendingHits")
	check(#c.pendingSwitches == 1 and own1.active and not own2.active, "A-03: duplicate hit 3 must not apply switch")

	-- Consome hit 2 (último pendente): agora sim finaliza e aplica troca
	c:waitForAndConsumeHitIndex(2, own1, enemy, timeline, attackToken, 2)
	check(not c.hitQueue:hasPendingHits(), "A-03: hasPendingHits must be false after all 3 hits are consumed")
	check(c.activePendingHits == 0, "A-03: activePendingHits expected 0 after all hits, got " .. tostring(c.activePendingHits))
	check(#c.pendingSwitches == 0, "A-03: pending switches must be drained when all hits finish")
	check(not own1.active and own2.active, "A-03: queued switch must be applied once all 3 hits are consumed")

	table.insert(scenarios, "A-03 integrated out-of-order 3-hit + queued switch passed")

	-- =========================================================================
	-- A-03 (unitário): followUpCancelled, duplicados, sem negativos e callbacks atrasados
	-- =========================================================================
	local unitEnded = false
	local unitToken = 1
	local unitCancelled = false
	local syncedPending = 0
	local q = CombatHitQueue.new({
		isBattleEnded = function() return unitEnded end,
		isAttackCurrent = function(tok) return tok == unitToken and not unitEnded end,
		isFollowUpCancelled = function() return unitCancelled end,
		onPendingHitsChanged = function(val) syncedPending = val end,
	})

	-- Ordem 3 -> 1 -> 2 sem followUpCancelled
	q:beginAttack(3)
	for i = 1, 3 do
		q:recordHitResult({ attackerId = "a", targetId = "b", hitIndex = i, hit = true, damage = 5, crit = false })
	end
	local consumedOrder = {}
	local fin3 = q:waitForAndConsumeHitIndex(3, 3, unitToken, function() return false end, function() table.insert(consumedOrder, 3) end)
	check(fin3 == false and q:hasPendingHits() and q:getActivePendingHits() == 2 and syncedPending == 2, "A-03 unit: hit 3 first must not finish")
	local fin1 = q:waitForAndConsumeHitIndex(1, 3, unitToken, function() return false end, function() table.insert(consumedOrder, 1) end)
	check(fin1 == false and q:hasPendingHits() and q:getActivePendingHits() == 1 and syncedPending == 1, "A-03 unit: hit 1 second must not finish")
	local fin2 = q:waitForAndConsumeHitIndex(2, 3, unitToken, function() return false end, function() table.insert(consumedOrder, 2) end)
	check(fin2 == true and not q:hasPendingHits() and q:getActivePendingHits() == 0 and syncedPending == 0, "A-03 unit: hit 2 last must finish")
	local finDup = q:waitForAndConsumeHitIndex(2, 3, unitToken, function() return false end, function() table.insert(consumedOrder, 99) end)
	check(finDup == false and q:getActivePendingHits() == 0 and #consumedOrder == 3, "A-03 unit: duplicate after finish must be no-op")

	-- followUpCancelled no hit 1 encerra imediatamente e bloqueia hits atrasados do mesmo ataque
	unitToken += 1
	unitCancelled = false
	q:beginAttack(3)
	for i = 1, 3 do
		q:recordHitResult({ attackerId = "a", targetId = "b", hitIndex = i, hit = i == 1, damage = 0, crit = false, followUpCancelled = i == 1 })
	end
	local cancelConsumes = 0
	local finCancel = q:waitForAndConsumeHitIndex(1, 3, unitToken, function() return false end, function()
		cancelConsumes += 1
		unitCancelled = true
	end)
	check(finCancel == true and not q:hasPendingHits() and q:getActivePendingHits() == 0 and syncedPending == 0, "A-03 unit: followUpCancelled must finalize immediately")
	local lateAfterCancel = q:waitForAndConsumeHitIndex(2, 3, unitToken, function() return false end, function()
		cancelConsumes += 1
	end)
	check(lateAfterCancel == false and cancelConsumes == 1 and q:getActivePendingHits() == 0, "A-03 unit: delayed hit after followUpCancelled must not consume or re-finalize")

	-- Callback atrasado de ataque antigo não pode interferir ou finalizar ataque novo
	local oldToken = unitToken
	unitToken += 1
	unitCancelled = false
	q:beginAttack(3)
	for i = 1, 3 do
		q:recordHitResult({ attackerId = "a", targetId = "b", hitIndex = i, hit = true, damage = 7, crit = false })
	end
	local staleConsumed = false
	local finStale = q:waitForAndConsumeHitIndex(3, 3, oldToken, function() return false end, function()
		staleConsumed = true
	end)
	check(finStale == false and not staleConsumed and q:getActivePendingHits() == 3 and not q:isHitConsumed(3), "A-03 unit: stale attackToken must not affect new attack")

	-- Transição de ataque reentrante dentro de consumeResults não pode finalizar nem decrementar o ataque novo
	local tokenBeforeReentry = unitToken
	local finReentrant = q:waitForAndConsumeHitIndex(1, 3, tokenBeforeReentry, function() return false end, function()
		unitToken += 1
		q:beginAttack(2)
	end)
	check(finReentrant == false and q:getActivePendingHits() == 2 and q:hasPendingHits(), "A-03 unit: reentrant new attack must not be decremented or finalized by old callback")

	table.insert(scenarios, "A-03 unit followUpCancelled + duplicate + stale callback guards passed")

	-- =========================================================================
	-- A-02: cleanupStage(gen1) não pode destruir batalha 2 (gen2); cleanupStage(gen2) limpa normalmente
	-- =========================================================================
	local gen1 = startBattle("K1Gen1StageQA")
	local gen2 = startBattle("K1Gen2StageQA")
	check(gen2 > gen1, "A-02: gen2 must be greater than gen1")

	local stage2 = c.stageFolder
	local fOwn1 = c.fightersByTargetId["own-1"]
	local fOwn2 = c.fightersByTargetId["own-2"]
	local fEnemy = c.fightersByTargetId["enemy"]
	check(stage2 ~= nil and stage2.Parent == workspace, "A-02: battle 2 stage must exist in workspace")
	check(fOwn1 ~= nil and fOwn2 ~= nil and fEnemy ~= nil, "A-02: battle 2 fighters must exist")

	local staleTaskFired = false
	c:delayBattle(10, function()
		staleTaskFired = true
	end)
	local sentinelConn = workspace.ChildAdded:Connect(function() end)
	c.battleConnections[sentinelConn] = true
	c.hitQueue:beginAttack(2)
	local token2 = c.currentAttackToken

	-- Cleanup atrasado da batalha 1 (gen1)
	local returnedOnStale = c:cleanupStage(gen1)
	check(returnedOnStale == gen2, "A-02: stale cleanupStage(gen1) must return current gen2, got " .. tostring(returnedOnStale))
	check(c:getBattleGeneration() == gen2 and c.battleVfxGeneration == gen2, "A-02: battle 2 generation must remain intact")
	check(not c.battleEnded, "A-02: battle 2 must remain active (battleEnded == false)")
	check(c.currentAttackToken == token2, "A-02: battle 2 attack token must remain intact")
	check(c.activePendingHits == 2 and c.hitQueue:hasPendingHits(), "A-02: battle 2 hitQueue must remain intact")
	check(c.stageFolder == stage2 and stage2.Parent == workspace, "A-02: battle 2 stageFolder must remain intact")
	check(c.fightersByTargetId["own-1"] == fOwn1 and c.fightersByTargetId["own-2"] == fOwn2 and c.fightersByTargetId["enemy"] == fEnemy, "A-02: battle 2 fighters map must remain intact")
	check(fOwn1.model.Parent == stage2 and fEnemy.model.Parent == stage2, "A-02: battle 2 fighter models must remain parented to stage2")
	check(sentinelConn.Connected and c.battleConnections[sentinelConn] == true, "A-02: battle 2 connections must remain active")
	check(next(c.battleTasks) ~= nil and not staleTaskFired, "A-02: battle 2 tasks must remain active")

	-- Cleanup legítimo da batalha 2 (gen2)
	local returnedOnCurrent = c:cleanupStage(gen2)
	check(returnedOnCurrent == gen2 + 1, "A-02: cleanupStage(gen2) must advance generation to gen2 + 1")
	check(c:getBattleGeneration() == returnedOnCurrent and c.battleVfxGeneration == returnedOnCurrent, "A-02: generation must match post-cleanup generation")
	check(c.battleEnded == true, "A-02: cleanupStage(gen2) must mark battleEnded = true")
	check(c.stageFolder == nil and stage2.Parent == nil, "A-02: cleanupStage(gen2) must destroy stage2")
	check(next(c.fightersByTargetId) == nil, "A-02: cleanupStage(gen2) must clear fightersByTargetId")
	check(not sentinelConn.Connected and next(c.battleConnections) == nil, "A-02: cleanupStage(gen2) must disconnect and clear battleConnections")
	check(next(c.battleTasks) == nil, "A-02: cleanupStage(gen2) must cancel and clear battleTasks")
	check(c.activePendingHits == 0 and not c.hitQueue:hasPendingHits(), "A-02: cleanupStage(gen2) must clear hitQueue")

	-- Repetir cleanupStage(gen2) após já ter avançado não deve alterar geração
	local returnedRepeated = c:cleanupStage(gen2)
	check(returnedRepeated == returnedOnCurrent and c:getBattleGeneration() == returnedOnCurrent, "A-02: repeated cleanupStage(gen2) must be no-op")

	table.insert(scenarios, "A-02 stale cleanupStage(gen1) guard + valid cleanupStage(gen2) passed")
end)

c:cleanupStage()
if c.poolContainer then
	c.poolContainer:Destroy()
end
assert(ok, failure)
return { result = "K1_HIT_QUEUE_GENERATION_QA_PASSED", checks = checks, scenarios = scenarios }
