-- Execute no Client em Play novo após rbxtsc/Rojo. Controllers isolados, sem servidor/perfis.
-- QA K2: A-04 (ataques sobrepostos) e A-01 (KO durante multi-hit e ataque de 1 hit com SwitchPerformed).
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local config = require(ts.UI.CombatVisualConfig)
local SkillData = require(game.ReplicatedStorage.TS.SkillData)

local checks = 0
local scenarios = {}
local function check(condition, message)
	checks += 1
	assert(condition, message)
end

local function closePos(actual, expected, tol, label)
	check((actual.Position - expected.Position).Magnitude <= tol, label .. " (dist=" .. tostring((actual.Position - expected.Position).Magnitude) .. ")")
end

local c = Combat.new()
c:initBillboardPool()

local function startTwoEnemyBattle(stageName, enemy1Hp)
	c:onBattleStarted({
		sides = { "A", "B" },
		fighters = {
			{ sideId = "A", targetId = "own-1", fighterId = "jotaro", hp = 100, hpMax = 100, active = true },
			{ sideId = "A", targetId = "own-2", fighterId = "anubis", hp = 100, hpMax = 100, active = false },
			{ sideId = "B", targetId = "enemy-1", fighterId = "anubis", hp = enemy1Hp or 100, hpMax = 100, active = true },
			{ sideId = "B", targetId = "enemy-2", fighterId = "anubis", hp = 100, hpMax = 100, active = false },
		},
	})
	if c.stageFolder then
		c.stageFolder.Name = stageName
	end
	task.wait(config.PLACEHOLDER_STRIKE_TWEEN_SECONDS * 2)
	return c.fightersByTargetId["own-1"], c.fightersByTargetId["own-2"], c.fightersByTargetId["enemy-1"], c.fightersByTargetId["enemy-2"]
end

local ok, failure = pcall(function()
	-- =========================================================================
	-- A-04: Ataque 1 (2 hits) com HitResolved(2) e SwitchPerformed pendentes;
	--       Ataque 2 inicia antes do fim do ataque 1.
	-- =========================================================================
	do
		local own1, _, enemy1, enemy2 = startTwoEnemyBattle("K2_A04_OverlapStageQA", 100)
		local own1Base = own1.homeCFrame
		local own1StandBase = own1.standMotion.baseC1
		local enemyActiveCFrame = enemy1.homeCFrame
		check(own1.standMotion ~= nil, "A-04: own-1 requires StandJoint")

		local twoHitTimeline = {
			name = "K2TwoHitOverlapQA",
			prepareTime = 0.1,
			returnTime = 0.12,
			dodgeReturnTime = 0.08,
			hits = {
				{ time = 0.08, damageShare = 0.5, followUp = true },
				{ time = 0.45, damageShare = 0.5, followUp = false },
			},
		}
		local singleHitTimeline = {
			name = "K2SingleHitOverlapQA",
			prepareTime = 0.1,
			returnTime = 0.12,
			dodgeReturnTime = 0.08,
			hits = {
				{ time = 0.12, damageShare = 1.0, followUp = false },
			},
		}

		local origResolve = c.resolveSkillTimeline
		c.resolveSkillTimeline = function(self, fighterId, slot)
			if slot == 2 then
				return twoHitTimeline
			end
			return singleHitTimeline
		end

		local orderLog = {}
		local unsubHp = c:onFighterHpVisualChanged(function(targetId, hp)
			table.insert(orderLog, "hp:" .. targetId .. ":" .. tostring(hp))
		end)
		local origApplyActive = c.applyActiveVisualState
		c.applyActiveVisualState = function(self, entry)
			if entry.targetId == "enemy-2" and entry.active then
				table.insert(orderLog, "switch:enemy-2:active")
			end
			return origApplyActive(self, entry)
		end
		local origRunPlaceholder = c.standMotion.runPlaceholderAttackSequence
		c.standMotion.runPlaceholderAttackSequence = function(self, attacker, target, timeline, attackToken, slot, consumeHit)
			table.insert(orderLog, "attackStart:" .. attacker.targetId .. "->" .. target.targetId)
			return origRunPlaceholder(self, attacker, target, timeline, attackToken, slot, consumeHit)
		end

		-- Inicia Ataque 1 (own-1 -> enemy-1, 2 hits)
		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-1", slot = 2 })
		c:onHitResolved({ hitIndex = 1, targetId = "enemy-1", hit = true, damage = 20, crit = false, followUpCancelled = false })
		task.wait(0.14)
		check(enemy1.hp == 80, "A-04: hit 1 should reduce enemy-1 hp to 80, got " .. tostring(enemy1.hp))
		check((own1.rootPart.CFrame.Position - own1Base.Position).Magnitude > 1.0, "A-04: own-1 should have advanced during attack 1")

		-- Hit 2 e SwitchPerformed chegam pendentes ANTES do tempo do hit 2 (0.45s)
		c:onHitResolved({ hitIndex = 2, targetId = "enemy-1", hit = true, damage = 35, crit = false, followUpCancelled = false })
		c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		check(enemy1.hp == 80, "A-04: hit 2 should remain pending before overlap")
		check(#c.pendingSwitches == 1 and enemy1.active and not enemy2.active, "A-04: switch should be queued while attack 1 has pending hits")

		-- Inicia Ataque 2 (enemy-2 -> own-1, 1 hit) ANTES do fim do Ataque 1
		c:onAttackStarted({ attackerId = "enemy-2", targetId = "own-1", slot = 1 })

		-- Hit 2 deve ter sido consumido (HP = 45), troca aplicada antes do ataque 2 e sem switches retidos
		check(enemy1.hp == 45, "A-04: pending hit 2 of attack 1 must not be discarded (expected 45, got " .. tostring(enemy1.hp) .. ")")
		check(not enemy1.active and enemy2.active, "A-04: pending switch must be applied before attack 2 starts")
		check(#c.pendingSwitches == 0, "A-04: pending switches must be drained before attack 2 starts")
		closePos(enemy2.homeCFrame, enemyActiveCFrame, 0.05, "A-04: enemy-2 homeCFrame must be active slot for attack 2")

		-- Confere ordem: hp:enemy-1:45 -> switch:enemy-2:active -> attackStart:enemy-2->own-1
		local idxHp2, idxSwitch, idxAtk2
		for idx, item in ipairs(orderLog) do
			if item == "hp:enemy-1:45" then idxHp2 = idx end
			if item == "switch:enemy-2:active" then idxSwitch = idx end
			if item == "attackStart:enemy-2->own-1" then idxAtk2 = idx end
		end
		check(idxHp2 ~= nil and idxSwitch ~= nil and idxAtk2 ~= nil, "A-04: missing expected order markers")
		check(idxHp2 < idxSwitch and idxSwitch < idxAtk2, "A-04: expected hit2 -> switch -> attack2 order")

		-- Conclui Ataque 2 normalmente e verifica retorno de own-1 (atacante anterior) e enemy-2
		c:onHitResolved({ hitIndex = 1, targetId = "own-1", hit = true, damage = 15, crit = false, followUpCancelled = false })
		task.wait(0.45)
		check(own1.hp == 85, "A-04: attack 2 hit 1 should reduce own-1 hp to 85, got " .. tostring(own1.hp))
		closePos(own1.rootPart.CFrame, own1Base, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-04: previous attacker own-1 must return to base")
		closePos(own1.standMotion.joint.C1, own1StandBase, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-04: previous attacker Stand must return to base")
		closePos(enemy2.rootPart.CFrame, enemyActiveCFrame, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-04: attack 2 attacker enemy-2 must return to active base")
		check(c.activePendingHits == 0 and #c.pendingSwitches == 0, "A-04: no pending queues after attack 2 finishes")

		unsubHp()
		c.resolveSkillTimeline = origResolve
		c.applyActiveVisualState = origApplyActive
		c.standMotion.runPlaceholderAttackSequence = origRunPlaceholder
		table.insert(scenarios, "A-04 overlapping attack finalized hit2, returned attacker1 and applied switch in order")
	end

	-- =========================================================================
	-- A-01.1: KO em ataque de 1 hit (Jotaro S1) com 2 inimigos;
	--         SwitchPerformed não pode cancelar tween de KO de 0,35s.
	-- =========================================================================
	do
		local own1, _, enemy1, enemy2 = startTwoEnemyBattle("K2_A01_SingleHitKoQA", 50)
		local own1Base = own1.homeCFrame
		local own1StandBase = own1.standMotion.baseC1
		local enemyActiveCFrame = enemy1.homeCFrame
		local s1Timeline = SkillData.JOTARO_SKILL_DATA[1]

		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-1", slot = 1 })
		c:delayBattle(s1Timeline.hits[1].time - 0.01, function()
			c:onHitResolved({ hitIndex = 1, targetId = "enemy-1", hit = true, damage = 50, crit = false, followUpCancelled = false })
			c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = nil })
			c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		end)

		-- Logo após o hit 1 (0.15s) mas bem antes do fim do KO tween (0.15 + 0.35 = 0.50s)
		task.wait(s1Timeline.hits[1].time + 0.12)
		check(enemy1.hp == 0 and enemy1.dead, "A-01 (1-hit): enemy-1 must be dead after lethal hit")
		check(not enemy2.active, "A-01 (1-hit): enemy-2 must NOT switch in while KO tween is still playing")
		check(#c.pendingSwitches == 1, "A-01 (1-hit): SwitchPerformed must stay queued during KO tween")

		-- Perto do final da queda (~0.30s após hit 1, antes de 0.35s)
		task.wait(0.18)
		local koDot = enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCFrame.UpVector)
		check(koDot < 0.5, "A-01 (1-hit): enemy-1 KO tween must not be cancelled (UpVector dot=" .. tostring(koDot) .. ")")
		check(not enemy2.active and #c.pendingSwitches == 1, "A-01 (1-hit): switch must still wait for full 0.35s KO tween")

		-- Depois do fim do KO (0.35s) + switch tween (0.18s) + margem
		task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.20)
		check(not enemy1.active and enemy2.active, "A-01 (1-hit): switch must apply after KO tween completes")
		closePos(enemy2.rootPart.CFrame, enemyActiveCFrame, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (1-hit): enemy-2 must reach active slot")
		closePos(own1.rootPart.CFrame, own1Base, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (1-hit): attacker must return to base")
		closePos(own1.standMotion.joint.C1, own1StandBase, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (1-hit): Stand must return to base")
		check(c.activePendingHits == 0 and #c.pendingSwitches == 0 and next(c.pendingDeaths) == nil, "A-01 (1-hit): all queues must be empty after completion")

		table.insert(scenarios, "A-01 (1-hit KO + 2 enemies) preserved 0.35s KO tween before SwitchPerformed")
	end

	-- =========================================================================
	-- A-01.2: Barragem de 5 hits (Jotaro S2), KO no hit 2, 2 inimigos,
	--         SwitchPerformed recebido antes do consumo do último hit.
	--         Nenhum soco visual após o KO, nenhuma troca antecipada,
	--         KO de 0,35s completo, nenhuma fila pendente ao finalizar.
	-- =========================================================================
	do
		local own1, _, enemy1, enemy2 = startTwoEnemyBattle("K2_A01_FiveHitKo2QA", 100)
		local own1Base = own1.homeCFrame
		local own1StandBase = own1.standMotion.baseC1
		local enemyActiveCFrame = enemy1.homeCFrame
		local s2Timeline = SkillData.JOTARO_SKILL_DATA[2]

		local pulsesBeforeDead = 0
		local pulsesAfterDead = 0
		local attackerStrikeTweensAfterDead = 0

		local origPulse = c.standMotion.pulseStandStrike
		c.standMotion.pulseStandStrike = function(self, attacker, advanceStuds)
			if enemy1.dead then
				pulsesAfterDead += 1
			else
				pulsesBeforeDead += 1
			end
			return origPulse(self, attacker, advanceStuds)
		end

		local origTweenModel = c.standMotion.tweenModelTo
		c.standMotion.tweenModelTo = function(self, model, targetCFrame, duration)
			if model == own1.model and enemy1.dead and (targetCFrame.Position - own1Base.Position).Magnitude > 0.05 then
				attackerStrikeTweensAfterDead += 1
			end
			return origTweenModel(self, model, targetCFrame, duration)
		end

		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-1", slot = 2 })
		-- Hit 1 (0.08s): 40 dano
		c:delayBattle(s2Timeline.hits[1].time - 0.01, function()
			c:onHitResolved({ hitIndex = 1, targetId = "enemy-1", hit = true, damage = 40, crit = false, followUpCancelled = false })
		end)
		-- Hit 2 (0.18s): 60 dano (letal!) + FighterDied. Servidor não envia hits 3, 4, 5.
		c:delayBattle(s2Timeline.hits[2].time - 0.01, function()
			c:onHitResolved({ hitIndex = 2, targetId = "enemy-1", hit = true, damage = 60, crit = false, followUpCancelled = false })
			c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = nil })
		end)
		-- SwitchPerformed chega em 0.34s (ANTES do consumo do último hit em 0.48s)
		c:delayBattle(0.34, function()
			c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		end)

		-- Em t = 0.42s (hits 3 e 4 já passaram; hit 5 ainda pendente; KO ainda rodando até ~0.53s)
		task.wait(0.42)
		check(enemy1.hp == 0 and enemy1.dead, "A-01 (5-hit KO@2): enemy-1 must be dead after hit 2")
		check(not enemy2.active and #c.pendingSwitches == 1, "A-01 (5-hit KO@2): switch must NOT apply before last hit and KO end")
		check(c.activePendingHits >= 1, "A-01 (5-hit KO@2): hit 5 should still be pending at 0.42s")
		check(pulsesAfterDead == 0, "A-01 (5-hit KO@2): expected 0 Stand strike pulses after KO, got " .. tostring(pulsesAfterDead))
		check(attackerStrikeTweensAfterDead == 0, "A-01 (5-hit KO@2): expected 0 attacker body punch tweens after KO, got " .. tostring(attackerStrikeTweensAfterDead))

		-- Em t = 0.50s (hit 5 em 0.48s já finalizou a sequência, mas KO de 0.35s desde 0.18s termina em ~0.53s)
		task.wait(0.08)
		local koDotAtSeqEnd = enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCFrame.UpVector)
		check(koDotAtSeqEnd < 0.5, "A-01 (5-hit KO@2): defeated fighter must stay fallen on the ground (dot=" .. tostring(koDotAtSeqEnd) .. ")")
		check(not enemy2.active and #c.pendingSwitches == 1, "A-01 (5-hit KO@2): switch must wait for 0.35s KO completion even after hit 5")

		-- Aguarda conclusão do KO (~0.53s) + retorno (0.30s) + switch (0.18s)
		task.wait(0.45)
		check(pulsesBeforeDead == 2, "A-01 (5-hit KO@2): expected exactly 2 Stand strikes (hit 1 and lethal hit 2), got " .. tostring(pulsesBeforeDead))
		check(pulsesAfterDead == 0, "A-01 (5-hit KO@2): expected 0 Stand strikes after KO at end, got " .. tostring(pulsesAfterDead))
		check(attackerStrikeTweensAfterDead == 0, "A-01 (5-hit KO@2): expected 0 body punches after KO at end, got " .. tostring(attackerStrikeTweensAfterDead))
		check(not enemy1.active and enemy2.active, "A-01 (5-hit KO@2): enemy-2 must be active after sequence and KO complete")
		closePos(enemy2.rootPart.CFrame, enemyActiveCFrame, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (5-hit KO@2): enemy-2 must reach active slot")
		closePos(own1.rootPart.CFrame, own1Base, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (5-hit KO@2): own-1 must return to base")
		closePos(own1.standMotion.joint.C1, own1StandBase, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (5-hit KO@2): Stand must return to base")
		check(c.activePendingHits == 0 and #c.pendingSwitches == 0 and next(c.pendingDeaths) == nil, "A-01 (5-hit KO@2): all queues must be empty after completion")

		c.standMotion.pulseStandStrike = origPulse
		c.standMotion.tweenModelTo = origTweenModel
		table.insert(scenarios, "A-01 (5-hit barrage KO@2 + early SwitchPerformed) skipped post-KO strikes and delayed switch")
	end

	-- =========================================================================
	-- A-01.3: KO no hit 1 da barragem de 5 hits (queda termina em 0.43s ANTES do
	--         fim da sequência em 0.48s) -> troca só pode aplicar após hit 5!
	-- =========================================================================
	do
		local own1, _, enemy1, enemy2 = startTwoEnemyBattle("K2_A01_FiveHitKo1QA", 40)
		local own1Base = own1.homeCFrame
		local own1StandBase = own1.standMotion.baseC1
		local enemyActiveCFrame = enemy1.homeCFrame
		local s2Timeline = SkillData.JOTARO_SKILL_DATA[2]

		local pulsesAfterDead = 0
		local origPulse = c.standMotion.pulseStandStrike
		c.standMotion.pulseStandStrike = function(self, attacker, advanceStuds)
			if enemy1.dead then
				pulsesAfterDead += 1
			end
			return origPulse(self, attacker, advanceStuds)
		end

		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-1", slot = 2 })
		c:delayBattle(s2Timeline.hits[1].time - 0.01, function()
			c:onHitResolved({ hitIndex = 1, targetId = "enemy-1", hit = true, damage = 40, crit = false, followUpCancelled = false })
			c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = nil })
		end)
		c:delayBattle(0.30, function()
			c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		end)

		-- Em t = 0.45s: KO de 0.35s (0.08 + 0.35 = 0.43s) JÁ terminou, mas hit 5 (0.48s) ainda não!
		task.wait(0.45)
		check(enemy1.dead, "A-01 (5-hit KO@1): enemy-1 must be dead")
		check(not enemy2.active and #c.pendingSwitches == 1, "A-01 (5-hit KO@1): switch must still wait for sequence end after KO ends")
		local koDot = enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCFrame.UpVector)
		check(koDot < 0.5, "A-01 (5-hit KO@1): enemy-1 must stay on ground until sequence ends (dot=" .. tostring(koDot) .. ")")

		-- Após hit 5 (0.48s) + retorno (0.30s) + switch (0.18s)
		task.wait(0.55)
		check(pulsesAfterDead == 0, "A-01 (5-hit KO@1): expected 0 Stand strikes after KO, got " .. tostring(pulsesAfterDead))
		check(not enemy1.active and enemy2.active, "A-01 (5-hit KO@1): switch must apply once sequence ends")
		closePos(enemy2.rootPart.CFrame, enemyActiveCFrame, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (5-hit KO@1): enemy-2 must reach active slot")
		closePos(own1.rootPart.CFrame, own1Base, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (5-hit KO@1): own-1 must return to base")
		closePos(own1.standMotion.joint.C1, own1StandBase, config.COMBAT_POSITION_TOLERANCE_STUDS, "A-01 (5-hit KO@1): Stand must return to base")
		check(c.activePendingHits == 0 and #c.pendingSwitches == 0 and next(c.pendingDeaths) == nil, "A-01 (5-hit KO@1): all queues must be empty")

		c.standMotion.pulseStandStrike = origPulse
		table.insert(scenarios, "A-01 (5-hit KO@1) kept fighter fallen until sequence end after KO completed")
	end

	-- =========================================================================
	-- Regressão: troca normal em IDLE, barragem sem KO (5 socos) e esquiva
	-- =========================================================================
	do
		local own1, own2, enemy1, enemy2 = startTwoEnemyBattle("K2_RegressionNormalQA", 100)
		local own1Base = own1.homeCFrame
		local s2Timeline = SkillData.JOTARO_SKILL_DATA[2]

		-- Troca normal sem ataque/KO aplica imediatamente
		c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		check(not enemy1.active and enemy2.active and #c.pendingSwitches == 0, "Regression: normal IDLE switch must apply immediately")

		-- Barragem 5 hits sem KO contra enemy-2 executa os 5 socos
		local pulseCount = 0
		local origPulse = c.standMotion.pulseStandStrike
		c.standMotion.pulseStandStrike = function(self, attacker, advanceStuds)
			pulseCount += 1
			return origPulse(self, attacker, advanceStuds)
		end
		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-2", slot = 2 })
		for i, hitSpec in ipairs(s2Timeline.hits) do
			c:delayBattle(hitSpec.time - 0.01, function()
				c:onHitResolved({ hitIndex = i, targetId = "enemy-2", hit = true, damage = 5, crit = false, followUpCancelled = false })
			end)
		end
		task.wait(s2Timeline.hits[#s2Timeline.hits].time + s2Timeline.returnTime + 0.15)
		check(pulseCount == 5, "Regression: non-KO 5-hit barrage must execute all 5 strikes, got " .. tostring(pulseCount))
		check(enemy2.hp == 75 and not enemy2.dead, "Regression: non-KO 5-hit barrage expected hp 75, got " .. tostring(enemy2.hp))
		closePos(own1.rootPart.CFrame, own1Base, config.COMBAT_POSITION_TOLERANCE_STUDS, "Regression: attacker returned to base after normal barrage")
		check(c.activePendingHits == 0 and #c.pendingSwitches == 0, "Regression: clean state after normal barrage")

		c.standMotion.pulseStandStrike = origPulse
		-- Troca normal do lado A também funciona
		c:onSwitchPerformed({ sideId = "A", previousFighterId = "own-1", activeFighterId = "own-2" })
		check(not own1.active and own2.active and #c.pendingSwitches == 0, "Regression: normal side A switch must apply immediately")

		table.insert(scenarios, "Regression: normal switch and 5-hit non-KO barrage preserved")
	end
end)

c:cleanupStage()
if c.poolContainer then
	c.poolContainer:Destroy()
end
assert(ok, failure)
return { result = "K2_MULTIHIT_KO_SWITCH_QA_PASSED", checks = checks, scenarios = scenarios }
