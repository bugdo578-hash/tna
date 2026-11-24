-- Sonda Final K2 (Somente Testes) — Execute no Client em Play no Roblox Studio.
-- Verifica dois cenários de borda sem alterar código de produção:
--   1) Novo AttackStarted chegando durante animação de KO de 0,35s com SwitchPerformed pendente.
--   2) FighterDied com nextActive preenchido (1 hit e barragem de 5 hits), sem SwitchPerformed inicial,
--      e depois verificando se SwitchPerformed adicional causa troca duplicada.

local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Combat = require(ts.Controllers.CombatController).CombatController
local config = require(ts.UI.CombatVisualConfig)
local SkillData = require(game.ReplicatedStorage.TS.SkillData)

local function round3(n)
	return math.floor(n * 1000 + 0.5) / 1000
end

local function posDist(a, b)
	return round3((a.Position - b.Position).Magnitude)
end

local function makeRecorder(t0)
	local events = {}
	local function log(tag, detail)
		table.insert(events, {
			t = round3(os.clock() - t0),
			tag = tag,
			detail = detail,
		})
	end
	return events, log
end

local function countMapEntries(tbl)
	local n = 0
	for _ in pairs(tbl) do
		n += 1
	end
	return n
end

local function addCheck(list, id, passed, expected, actual)
	table.insert(list, {
		id = id,
		passed = passed,
		expected = expected,
		actual = actual,
	})
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
	return c.fightersByTargetId["own-1"],
		c.fightersByTargetId["own-2"],
		c.fightersByTargetId["enemy-1"],
		c.fightersByTargetId["enemy-2"]
end

local report = {
	scenario1 = { status = "PENDING", checks = {}, events = {}, observations = {} },
	scenario2_singleHit = { status = "PENDING", checks = {}, events = {}, observations = {} },
	scenario2_fiveHit = { status = "PENDING", checks = {}, events = {}, observations = {} },
	scenario3_koTweenAndGeneration = { status = "PENDING", checks = {}, events = {}, observations = {} },
}

local ok, runErr = pcall(function()
	-- =========================================================================
	-- CENÁRIO 1 — Novo ataque durante KO (1 hit + KO 0.35s + SwitchPerformed + AttackStarted)
	-- =========================================================================
	do
		local s1 = report.scenario1
		local own1, _, enemy1, enemy2 = startTwoEnemyBattle("K2_EdgeProbe_Scenario1", 50)
		local enemyActiveCF = enemy1.homeCFrame
		local enemy1BenchCF = c:computeBenchSlotCFrame(enemy1.sideIndex, enemy1.benchIndex, enemy1.groundContactOffset)
		local enemy2BenchCF = enemy2.homeCFrame
		local s1Timeline = SkillData.JOTARO_SKILL_DATA[1]

		local t0 = os.clock()
		local events, log = makeRecorder(t0)
		s1.events = events

		local koTweenStartedAt = nil
		local koTweenEndedAt = nil
		local koTweenFinalState = nil
		local enemy1Tweens = {}
		local enemy2Tweens = {}
		local switchAppliedAt = nil
		local forceCompleteSnapshot = nil

		local origCreateTween = c.createBattleTween
		c.createBattleTween = function(self, object, info, goal)
			local tween = origCreateTween(self, object, info, goal)
			if object == enemy1.rootPart then
				local entry = {
					startedAt = round3(os.clock() - t0),
					duration = round3(info.Time),
					targetDistToActive = goal.CFrame and posDist(goal.CFrame, enemyActiveCF) or -1,
					targetDistToBench = goal.CFrame and posDist(goal.CFrame, enemy1BenchCF) or -1,
					state = "Playing",
					endedAt = nil,
				}
				table.insert(enemy1Tweens, entry)
				local isKo = math.abs(info.Time - config.PLACEHOLDER_KO_TWEEN_SECONDS) < 0.001
				if isKo then
					koTweenStartedAt = entry.startedAt
					log("koTween:start", { duration = entry.duration, finalizerGen = c.attackFinalizer.finalizerGeneration })
				else
					log("enemy1Tween:start", entry)
				end
				tween.Completed:Connect(function(playbackState)
					entry.state = playbackState.Name
					entry.endedAt = round3(os.clock() - t0)
					if isKo then
						koTweenFinalState = playbackState.Name
						koTweenEndedAt = entry.endedAt
						log("koTween:completed", { state = playbackState.Name, elapsed = round3(entry.endedAt - entry.startedAt) })
					else
						log("enemy1Tween:completed", { state = playbackState.Name, duration = entry.duration })
					end
				end)
			elseif object == enemy2.rootPart then
				local entry = {
					startedAt = round3(os.clock() - t0),
					duration = round3(info.Time),
					targetDistToActive = goal.CFrame and posDist(goal.CFrame, enemyActiveCF) or -1,
					state = "Playing",
				}
				table.insert(enemy2Tweens, entry)
				log("enemy2Tween:start", entry)
				tween.Completed:Connect(function(playbackState)
					entry.state = playbackState.Name
					entry.endedAt = round3(os.clock() - t0)
					log("enemy2Tween:completed", { state = playbackState.Name })
				end)
			end
			return tween
		end

		local origForceComplete = c.attackFinalizer.forceCompletePendingForNextAttack
		c.attackFinalizer.forceCompletePendingForNextAttack = function(self)
			local before = {
				t = round3(os.clock() - t0),
				activeKoCount = countMapEntries(self.activeKoTargets),
				pendingSwitches = #self.pendingSwitches,
				gen = self.finalizerGeneration,
			}
			origForceComplete(self)
			local after = {
				t = round3(os.clock() - t0),
				activeKoCount = countMapEntries(self.activeKoTargets),
				pendingSwitches = #self.pendingSwitches,
				gen = self.finalizerGeneration,
			}
			forceCompleteSnapshot = { before = before, after = after }
			log("forceCompletePendingForNextAttack", forceCompleteSnapshot)
		end

		local origApplySwitch = c.attackFinalizer.applySwitchPerformed
		c.attackFinalizer.applySwitchPerformed = function(self, payload)
			switchAppliedAt = round3(os.clock() - t0)
			log("applySwitchPerformed", {
				previous = payload.previousFighterId,
				active = payload.activeFighterId,
				koElapsed = koTweenStartedAt and round3(switchAppliedAt - koTweenStartedAt) or -1,
			})
			return origApplySwitch(self, payload)
		end

		local unsubDeath = c:onFighterDeathVisualFlushed(function(payload)
			log("deathVisualFlushed", { fighterId = payload.fighterId, nextActive = payload.nextActive })
		end)

		-- 1. Ataque de 1 hit causa KO
		log("attack1:start", { attacker = "own-1", target = "enemy-1", slot = 1, hit1Time = s1Timeline.hits[1].time })
		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-1", slot = 1 })
		c:delayBattle(s1Timeline.hits[1].time - 0.01, function()
			log("attack1:sendHitAndDeath", { damage = 50 })
			c:onHitResolved({ hitIndex = 1, targetId = "enemy-1", hit = true, damage = 50, crit = false, followUpCancelled = false })
			c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = nil })
		end)

		-- 2. Espera hit 1 consumir e queda de 0,35s começar
		task.wait(s1Timeline.hits[1].time + 0.05)
		local koActiveAfterHit = c.attackFinalizer:hasActiveKoAnimations()
		local deadAfterHit = enemy1.dead

		-- 3. SwitchPerformed chega e fica pendente
		log("switchPerformed:send", { previous = "enemy-1", active = "enemy-2" })
		c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		local switchQueuedInitially = (#c.pendingSwitches == 1) and (not enemy2.active)
		log("switchPerformed:afterSend", {
			pendingSwitches = #c.pendingSwitches,
			enemy2Active = enemy2.active,
			activeKoCount = countMapEntries(c.attackFinalizer.activeKoTargets),
		})

		-- 4. Ainda durante a queda de 0,35s (~0.13s após KO iniciar), chega novo AttackStarted
		task.wait(0.08)
		local dotBeforeNextAttack = round3(enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCF.UpVector))
		local koElapsedBeforeNextAttack = koTweenStartedAt and round3((os.clock() - t0) - koTweenStartedAt) or -1
		log("attack2:sendDuringKO", {
			koElapsed = koElapsedBeforeNextAttack,
			enemy1UpDot = dotBeforeNextAttack,
			enemy1DistToActive = posDist(enemy1.rootPart.CFrame, enemyActiveCF),
			enemy2DistToBench = posDist(enemy2.rootPart.CFrame, enemy2BenchCF),
		})
		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-2", slot = 1 })

		-- Observa imediatamente após novo AttackStarted (ainda bem antes de 0,35s de KO)
		local immediateAfterAttack2 = {
			t = round3(os.clock() - t0),
			koElapsed = koTweenStartedAt and round3((os.clock() - t0) - koTweenStartedAt) or -1,
			hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
			pendingSwitches = #c.pendingSwitches,
			enemy2Active = enemy2.active,
			enemy1Active = enemy1.active,
			enemy1HomeDistToBench = posDist(enemy1.homeCFrame, enemy1BenchCF),
			enemy2HomeDistToActive = posDist(enemy2.homeCFrame, enemyActiveCF),
		}
		log("attack2:immediateAfter", immediateAfterAttack2)

		-- Aguarda 0.12s (t_ko ~ 0.25s, ainda ANTES de 0.35s!) para observar movimento/estado visual
		task.wait(0.12)
		local midKoAfterAttack2 = {
			t = round3(os.clock() - t0),
			koElapsed = koTweenStartedAt and round3((os.clock() - t0) - koTweenStartedAt) or -1,
			koTweenFinalState = koTweenFinalState,
			enemy1UpDot = round3(enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCF.UpVector)),
			enemy1DistToBench = posDist(enemy1.rootPart.CFrame, enemy1BenchCF),
			enemy2DistToActive = posDist(enemy2.rootPart.CFrame, enemyActiveCF),
			enemy2Active = enemy2.active,
		}
		log("attack2:midKoSample", midKoAfterAttack2)

		-- Conclui ataque 2 normalmente e aguarda o ciclo completo (KO restante + ataque 2 + popup temporário de dano)
		c:onHitResolved({ hitIndex = 1, targetId = "enemy-2", hit = true, damage = 10, crit = false, followUpCancelled = false })
		task.wait(config.PLACEHOLDER_KO_TWEEN_SECONDS + s1Timeline.hits[1].time + config.DAMAGE_POPUP_DURATION_SECONDS + 0.15)

		local endState = {
			t = round3(os.clock() - t0),
			activePendingHits = c.activePendingHits,
			pendingSwitches = #c.pendingSwitches,
			pendingDeaths = countMapEntries(c.pendingDeaths),
			activeKoCount = countMapEntries(c.attackFinalizer.activeKoTargets),
			battleTasks = countMapEntries(c.battleTasks),
			battleTweens = countMapEntries(c.battleTweens),
			enemy2Hp = enemy2.hp,
			enemy1DistToBench = posDist(enemy1.rootPart.CFrame, enemy1BenchCF),
			enemy2DistToActive = posDist(enemy2.rootPart.CFrame, enemyActiveCF),
			koTweenStartedAt = koTweenStartedAt,
			koTweenEndedAt = koTweenEndedAt,
			koTweenFinalState = koTweenFinalState,
			switchAppliedAt = switchAppliedAt,
			enemy1Tweens = enemy1Tweens,
			enemy2Tweens = enemy2Tweens,
		}
		log("scenario1:end", endState)

		s1.observations = {
			koActiveAfterHit = koActiveAfterHit,
			deadAfterHit = deadAfterHit,
			switchQueuedInitially = switchQueuedInitially,
			koElapsedBeforeNextAttack = koElapsedBeforeNextAttack,
			dotBeforeNextAttack = dotBeforeNextAttack,
			forceCompleteSnapshot = forceCompleteSnapshot,
			immediateAfterAttack2 = immediateAfterAttack2,
			midKoAfterAttack2 = midKoAfterAttack2,
			endState = endState,
		}

		addCheck(
			s1.checks,
			"S1.1_initial_ko_and_switch_queued",
			deadAfterHit and koActiveAfterHit and switchQueuedInitially,
			"dead=true, activeKo=true, switchQueued=true",
			string.format("dead=%s, activeKo=%s, switchQueued=%s", tostring(deadAfterHit), tostring(koActiveAfterHit), tostring(switchQueuedInitially))
		)
		addCheck(
			s1.checks,
			"S1.2_ko_not_invalidated_prematurely",
			immediateAfterAttack2.hasActiveKo == true,
			"hasActiveKo=true while KO < 0.35s",
			string.format(
				"hasActiveKo=%s, forceComplete activeKo %d->%d, gen %d->%d at koElapsed=%.3fs",
				tostring(immediateAfterAttack2.hasActiveKo),
				forceCompleteSnapshot and forceCompleteSnapshot.before.activeKoCount or -1,
				forceCompleteSnapshot and forceCompleteSnapshot.after.activeKoCount or -1,
				forceCompleteSnapshot and forceCompleteSnapshot.before.gen or -1,
				forceCompleteSnapshot and forceCompleteSnapshot.after.gen or -1,
				immediateAfterAttack2.koElapsed
			)
		)
		addCheck(
			s1.checks,
			"S1.3_no_premature_switch",
			(not immediateAfterAttack2.enemy2Active) and (switchAppliedAt == nil or (koTweenStartedAt ~= nil and (switchAppliedAt - koTweenStartedAt) >= config.PLACEHOLDER_KO_TWEEN_SECONDS - 0.02)),
			"switch only after >= 0.35s KO",
			string.format(
				"enemy2ActiveImmediate=%s, switchAppliedAt=%s, koStartedAt=%s, delta=%.3fs",
				tostring(immediateAfterAttack2.enemy2Active),
				tostring(switchAppliedAt),
				tostring(koTweenStartedAt),
				(switchAppliedAt and koTweenStartedAt) and (switchAppliedAt - koTweenStartedAt) or -1
			)
		)
		addCheck(
			s1.checks,
			"S1.4_ko_tween_not_cancelled",
			koTweenFinalState == "Completed",
			"koTween PlaybackState=Completed (duration ~0.35s)",
			string.format(
				"koTween PlaybackState=%s, elapsed=%.3fs",
				tostring(koTweenFinalState),
				(koTweenEndedAt and koTweenStartedAt) and (koTweenEndedAt - koTweenStartedAt) or -1
			)
		)
		addCheck(
			s1.checks,
			"S1.5_ko_pose_preserved_during_fall",
			midKoAfterAttack2.enemy1UpDot < 0.5,
			"enemy1 UpVector dot < 0.5 during KO fall",
			string.format("enemy1 UpVector dot=%.3f, distToBench=%.3f at koElapsed=%.3fs", midKoAfterAttack2.enemy1UpDot, midKoAfterAttack2.enemy1DistToBench, midKoAfterAttack2.koElapsed)
		)
		addCheck(
			s1.checks,
			"S1.6_no_residual_queues_or_tasks",
			endState.activePendingHits == 0 and endState.pendingSwitches == 0 and endState.pendingDeaths == 0 and endState.activeKoCount == 0 and endState.battleTasks == 0 and endState.battleTweens == 0,
			"all queues=0, battleTasks=0, battleTweens=0",
			string.format("hits=%d, switches=%d, deaths=%d, activeKo=%d, tasks=%d, tweens=%d", endState.activePendingHits, endState.pendingSwitches, endState.pendingDeaths, endState.activeKoCount, endState.battleTasks, endState.battleTweens)
		)
		addCheck(
			s1.checks,
			"S1.7_attack2_hit_and_final_positions",
			endState.enemy2Hp == 90 and endState.enemy1DistToBench <= config.COMBAT_POSITION_TOLERANCE_STUDS and endState.enemy2DistToActive <= config.COMBAT_POSITION_TOLERANCE_STUDS,
			"enemy2.hp=90, enemy1 at bench, enemy2 at active",
			string.format("enemy2Hp=%d, enemy1DistToBench=%.4f, enemy2DistToActive=%.4f", endState.enemy2Hp, endState.enemy1DistToBench, endState.enemy2DistToActive)
		)

		local allPassed = true
		for _, chk in ipairs(s1.checks) do
			if not chk.passed then
				allPassed = false
				break
			end
		end
		s1.status = allPassed and "PASSED" or "FAILED"

		unsubDeath()
		c.createBattleTween = origCreateTween
		c.attackFinalizer.forceCompletePendingForNextAttack = origForceComplete
		c.attackFinalizer.applySwitchPerformed = origApplySwitch
	end

	-- =========================================================================
	-- CENÁRIO 2A — FighterDied com nextActive preenchido em ataque de 1 hit
	-- =========================================================================
	do
		local s2a = report.scenario2_singleHit
		local own1, _, enemy1, enemy2 = startTwoEnemyBattle("K2_EdgeProbe_Scenario2_1Hit", 50)
		local enemyActiveCF = enemy1.homeCFrame
		local enemy1BenchCF = c:computeBenchSlotCFrame(enemy1.sideIndex, enemy1.benchIndex, enemy1.groundContactOffset)
		local enemy2BenchCF = enemy2.homeCFrame
		local s1Timeline = SkillData.JOTARO_SKILL_DATA[1]

		local t0 = os.clock()
		local events, log = makeRecorder(t0)
		s2a.events = events

		local koStartedAt = nil
		local koEndedAt = nil
		local koFinalState = nil
		local enemy2ActiveTransitions = 0
		local enemy2TweensToActive = {}
		local enemy1BenchMoves = {}

		local origCreateTween = c.createBattleTween
		c.createBattleTween = function(self, object, info, goal)
			local tween = origCreateTween(self, object, info, goal)
			if object == enemy1.rootPart then
				local isKo = math.abs(info.Time - config.PLACEHOLDER_KO_TWEEN_SECONDS) < 0.001
				local distBench = goal.CFrame and posDist(goal.CFrame, enemy1BenchCF) or -1
				if isKo then
					koStartedAt = round3(os.clock() - t0)
					log("koTween:start", { duration = round3(info.Time) })
				else
					log("enemy1Tween:start", { duration = round3(info.Time), distToBench = distBench })
					if distBench < 0.1 then
						table.insert(enemy1BenchMoves, { kind = "tween", t = round3(os.clock() - t0) })
					end
				end
				tween.Completed:Connect(function(playbackState)
					if isKo then
						koEndedAt = round3(os.clock() - t0)
						koFinalState = playbackState.Name
						log("koTween:completed", { state = playbackState.Name, elapsed = round3(koEndedAt - koStartedAt) })
					end
				end)
			elseif object == enemy2.rootPart then
				local distActive = goal.CFrame and posDist(goal.CFrame, enemyActiveCF) or -1
				local rec = { t = round3(os.clock() - t0), duration = round3(info.Time), distToActive = distActive }
				if distActive < 0.1 then
					table.insert(enemy2TweensToActive, rec)
				end
				log("enemy2Tween:start", rec)
			end
			return tween
		end

		local origApplyActive = c.applyActiveVisualState
		c.applyActiveVisualState = function(self, entry)
			if entry.targetId == "enemy-2" and entry.active then
				enemy2ActiveTransitions += 1
				log("enemy2:applyActiveVisualState", { count = enemy2ActiveTransitions, koElapsed = koStartedAt and round3((os.clock() - t0) - koStartedAt) or -1 })
			elseif entry.targetId == "enemy-1" and entry.dead and posDist(entry.homeCFrame, enemy1BenchCF) < 0.1 then
				table.insert(enemy1BenchMoves, { kind = "applyActiveAtBench", t = round3(os.clock() - t0) })
				log("enemy1:benchVisualState", { t = round3(os.clock() - t0) })
			end
			return origApplyActive(self, entry)
		end

		local unsubDeath = c:onFighterDeathVisualFlushed(function(payload)
			log("deathVisualFlushed", { fighterId = payload.fighterId, nextActive = payload.nextActive })
		end)

		-- Dispara ataque de 1 hit + FighterDied com nextActive="enemy-2" (SEM SwitchPerformed!)
		log("attack1:start", { attacker = "own-1", target = "enemy-1", slot = 1 })
		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-1", slot = 1 })
		c:delayBattle(s1Timeline.hits[1].time - 0.01, function()
			log("attack1:sendHitAndDeathWithNextActive", { nextActive = "enemy-2" })
			c:onHitResolved({ hitIndex = 1, targetId = "enemy-1", hit = true, damage = 50, crit = false, followUpCancelled = false })
			c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = "enemy-2" })
		end)

		-- Amostra logo após hit letal (~0.06s dentro do KO de 0,35s)
		task.wait(s1Timeline.hits[1].time + 0.06)
		local earlyKoSample = {
			t = round3(os.clock() - t0),
			koElapsed = koStartedAt and round3((os.clock() - t0) - koStartedAt) or -1,
			hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
			enemy1Dead = enemy1.dead,
			enemy1UpDot = round3(enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCF.UpVector)),
			enemy2Active = enemy2.active,
			enemy2DistToBench = posDist(enemy2.rootPart.CFrame, enemy2BenchCF),
			enemy2DistToActive = posDist(enemy2.rootPart.CFrame, enemyActiveCF),
			enemy2TweensToActiveCount = #enemy2TweensToActive,
		}
		log("sample:earlyDuringKO", earlyKoSample)

		-- Amostra em ~0.24s após hit letal (ainda ANTES de 0,35s do KO, mas já depois do switch tween de 0,18s!)
		task.wait(0.18)
		local lateKoSample = {
			t = round3(os.clock() - t0),
			koElapsed = koStartedAt and round3((os.clock() - t0) - koStartedAt) or -1,
			hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
			enemy1UpDot = round3(enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCF.UpVector)),
			enemy1DistToActive = posDist(enemy1.rootPart.CFrame, enemyActiveCF),
			enemy2Active = enemy2.active,
			enemy2DistToActive = posDist(enemy2.rootPart.CFrame, enemyActiveCF),
		}
		log("sample:lateDuringKO", lateKoSample)

		-- Espera conclusão da queda de 0,35s
		task.wait(0.25)
		local afterKoBeforeSwitch = {
			t = round3(os.clock() - t0),
			hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
			enemy1DistToBench = posDist(enemy1.rootPart.CFrame, enemy1BenchCF),
			enemy2DistToActive = posDist(enemy2.rootPart.CFrame, enemyActiveCF),
			enemy2TweensToActiveCount = #enemy2TweensToActive,
			enemy2ActiveTransitions = enemy2ActiveTransitions,
		}
		log("sample:afterKoBeforeSwitch", afterKoBeforeSwitch)

		-- Parte 2: envia SwitchPerformed adicional após FighterDied(nextActive) para checar troca duplicada
		log("switchPerformed:sendAdditional", { previous = "enemy-1", active = "enemy-2" })
		c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		task.wait(config.PLACEHOLDER_SWITCH_TWEEN_SECONDS + 0.08)

		local afterAdditionalSwitch = {
			t = round3(os.clock() - t0),
			enemy2TweensToActiveCount = #enemy2TweensToActive,
			enemy2ActiveTransitions = enemy2ActiveTransitions,
			enemy1BenchMovesCount = #enemy1BenchMoves,
			enemy2TweensToActive = enemy2TweensToActive,
			enemy1BenchMoves = enemy1BenchMoves,
			pendingSwitches = #c.pendingSwitches,
			activePendingHits = c.activePendingHits,
		}
		log("sample:afterAdditionalSwitch", afterAdditionalSwitch)

		s2a.observations = {
			koStartedAt = koStartedAt,
			koEndedAt = koEndedAt,
			koFinalState = koFinalState,
			earlyKoSample = earlyKoSample,
			lateKoSample = lateKoSample,
			afterKoBeforeSwitch = afterKoBeforeSwitch,
			afterAdditionalSwitch = afterAdditionalSwitch,
		}

		addCheck(
			s2a.checks,
			"S2A.1_nextActive_waits_for_ko_completion",
			(not earlyKoSample.enemy2Active) and (earlyKoSample.enemy2TweensToActiveCount == 0) and (lateKoSample.enemy2DistToActive > 1.0),
			"enemy-2 stays inactive at bench during 0.35s KO",
			string.format(
				"at koElapsed=%.3fs: enemy2Active=%s, distToBench=%.3f, distToActive=%.3f, tweensToActive=%d; at koElapsed=%.3fs: distToActive=%.3f",
				earlyKoSample.koElapsed,
				tostring(earlyKoSample.enemy2Active),
				earlyKoSample.enemy2DistToBench,
				earlyKoSample.enemy2DistToActive,
				earlyKoSample.enemy2TweensToActiveCount,
				lateKoSample.koElapsed,
				lateKoSample.enemy2DistToActive
			)
		)
		addCheck(
			s2a.checks,
			"S2A.2_ko_tween_completed",
			koFinalState == "Completed",
			"koTween PlaybackState=Completed",
			string.format("state=%s, elapsed=%.3fs", tostring(koFinalState), (koEndedAt and koStartedAt) and (koEndedAt - koStartedAt) or -1)
		)
		addCheck(
			s2a.checks,
			"S2A.3_additional_switch_no_duplicate",
			afterAdditionalSwitch.enemy2TweensToActiveCount <= 1 and afterAdditionalSwitch.enemy2ActiveTransitions <= 1,
			"at most 1 switch/entry tween for enemy-2",
			string.format(
				"enemy2TweensToActive=%d, enemy2ActiveTransitions=%d, enemy1BenchMoves=%d",
				afterAdditionalSwitch.enemy2TweensToActiveCount,
				afterAdditionalSwitch.enemy2ActiveTransitions,
				afterAdditionalSwitch.enemy1BenchMovesCount
			)
		)
		addCheck(
			s2a.checks,
			"S2A.4_auto_switch_applied_without_switch_event",
			afterKoBeforeSwitch.enemy2TweensToActiveCount == 1 and afterKoBeforeSwitch.enemy2ActiveTransitions == 1 and afterKoBeforeSwitch.enemy1DistToBench <= config.COMBAT_POSITION_TOLERANCE_STUDS,
			"auto-switch applied once via nextActive and enemy-1 stably at bench",
			string.format(
				"beforeSwitch: tweens=%d, transitions=%d, enemy1DistToBench=%.4f",
				afterKoBeforeSwitch.enemy2TweensToActiveCount,
				afterKoBeforeSwitch.enemy2ActiveTransitions,
				afterKoBeforeSwitch.enemy1DistToBench
			)
		)

		local allPassed = true
		for _, chk in ipairs(s2a.checks) do
			if not chk.passed then
				allPassed = false
				break
			end
		end
		s2a.status = allPassed and "PASSED" or "FAILED"

		unsubDeath()
		c.createBattleTween = origCreateTween
		c.applyActiveVisualState = origApplyActive
	end

	-- =========================================================================
	-- CENÁRIO 2B — FighterDied com nextActive preenchido em barragem de 5 hits (KO@hit2)
	-- =========================================================================
	do
		local s2b = report.scenario2_fiveHit
		local own1, _, enemy1, enemy2 = startTwoEnemyBattle("K2_EdgeProbe_Scenario2_5Hit", 100)
		local enemyActiveCF = enemy1.homeCFrame
		local enemy1BenchCF = c:computeBenchSlotCFrame(enemy1.sideIndex, enemy1.benchIndex, enemy1.groundContactOffset)
		local enemy2BenchCF = enemy2.homeCFrame
		local times = { 0.08, 0.18, 0.28, 0.38, 0.48 }
		local s2Timeline = { name = "K2.1 fixture", prepareTime = 0, returnTime = 0.30, dodgeReturnTime = 0.15, hits = {} }
		for _, time in times do
			table.insert(s2Timeline.hits, { time = time, damageShare = 1 / #times })
		end
		own1.equippedSkills = table.clone(own1.equippedSkills)
		own1.equippedSkills[2] = s2Timeline

		local t0 = os.clock()
		local events, log = makeRecorder(t0)
		s2b.events = events

		local koStartedAt = nil
		local koEndedAt = nil
		local koFinalState = nil
		local sequenceFinalizedAt = nil
		local enemy2ActiveTransitions = 0
		local enemy2TweensToActive = {}
		local enemy1BenchMoves = {}

		local origFinalizeAttack = c.attackFinalizer.finalizeAttack
		c.attackFinalizer.finalizeAttack = function(self, attacker, timeline)
			sequenceFinalizedAt = round3(os.clock() - t0)
			log("finalizeAttack", { attacker = attacker.targetId, activeKo = self:hasActiveKoAnimations() })
			return origFinalizeAttack(self, attacker, timeline)
		end

		local origCreateTween = c.createBattleTween
		c.createBattleTween = function(self, object, info, goal)
			local tween = origCreateTween(self, object, info, goal)
			if object == enemy1.rootPart then
				local isKo = math.abs(info.Time - config.PLACEHOLDER_KO_TWEEN_SECONDS) < 0.001
				local distBench = goal.CFrame and posDist(goal.CFrame, enemy1BenchCF) or -1
				if isKo then
					koStartedAt = round3(os.clock() - t0)
					log("koTween:start", { duration = round3(info.Time), pendingHits = c.activePendingHits })
				else
					log("enemy1Tween:start", { duration = round3(info.Time), distToBench = distBench })
					if distBench < 0.1 then
						table.insert(enemy1BenchMoves, { kind = "tween", t = round3(os.clock() - t0) })
					end
				end
				tween.Completed:Connect(function(playbackState)
					if isKo then
						koEndedAt = round3(os.clock() - t0)
						koFinalState = playbackState.Name
						log("koTween:completed", { state = playbackState.Name, elapsed = round3(koEndedAt - koStartedAt) })
					end
				end)
			elseif object == enemy2.rootPart then
				local distActive = goal.CFrame and posDist(goal.CFrame, enemyActiveCF) or -1
				local rec = {
					t = round3(os.clock() - t0),
					duration = round3(info.Time),
					distToActive = distActive,
					pendingHits = c.activePendingHits,
					hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
				}
				if distActive < 0.1 then
					table.insert(enemy2TweensToActive, rec)
				end
				log("enemy2Tween:start", rec)
			end
			return tween
		end

		local origApplyActive = c.applyActiveVisualState
		c.applyActiveVisualState = function(self, entry)
			if entry.targetId == "enemy-2" and entry.active then
				enemy2ActiveTransitions += 1
				log("enemy2:applyActiveVisualState", {
					count = enemy2ActiveTransitions,
					pendingHits = c.activePendingHits,
					hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
				})
			elseif entry.targetId == "enemy-1" and entry.dead and posDist(entry.homeCFrame, enemy1BenchCF) < 0.1 then
				table.insert(enemy1BenchMoves, { kind = "applyActiveAtBench", t = round3(os.clock() - t0) })
				log("enemy1:benchVisualState", { t = round3(os.clock() - t0) })
			end
			return origApplyActive(self, entry)
		end

		-- Dispara barragem de 5 hits (Jotaro S2), KO no hit 2 (0.18s), hit 5 termina em 0.48s
		-- NÃO envia SwitchPerformed inicialmente!
		log("barrage:start", { attacker = "own-1", target = "enemy-1", slot = 2, hit2Time = s2Timeline.hits[2].time, hit5Time = s2Timeline.hits[5].time })
		c:onAttackStarted({ attackerId = "own-1", targetId = "enemy-1", slot = 2 })
		c:delayBattle(s2Timeline.hits[1].time - 0.01, function()
			c:onHitResolved({ hitIndex = 1, targetId = "enemy-1", hit = true, damage = 40, crit = false, followUpCancelled = false })
		end)
		c:delayBattle(s2Timeline.hits[2].time - 0.01, function()
			log("barrage:sendHit2AndDeathWithNextActive", { nextActive = "enemy-2" })
			c:onHitResolved({ hitIndex = 2, targetId = "enemy-1", hit = true, damage = 60, crit = false, followUpCancelled = false })
			c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = "enemy-2" })
		end)

		-- Amostra em t = 0.28s (0.10s após KO no hit 2; hits 4 e 5 ainda pendentes até 0.48s; KO até ~0.53s)
		task.wait(0.28)
		local midBarrageSample = {
			t = round3(os.clock() - t0),
			activePendingHits = c.activePendingHits,
			hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
			sequenceFinalizedAt = sequenceFinalizedAt,
			enemy1Dead = enemy1.dead,
			enemy1UpDot = round3(enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCF.UpVector)),
			enemy2Active = enemy2.active,
			enemy2DistToBench = posDist(enemy2.rootPart.CFrame, enemy2BenchCF),
			enemy2DistToActive = posDist(enemy2.rootPart.CFrame, enemyActiveCF),
			enemy2TweensToActiveCount = #enemy2TweensToActive,
		}
		log("sample:midBarrageDuringKO", midBarrageSample)

		-- Amostra em t = 0.42s (ainda antes de hit 5 em 0.48s e fim do KO em 0.53s; mas já depois do switch tween de 0.18s!)
		task.wait(0.14)
		local preHit5Sample = {
			t = round3(os.clock() - t0),
			activePendingHits = c.activePendingHits,
			hasActiveKo = c.attackFinalizer:hasActiveKoAnimations(),
			sequenceFinalizedAt = sequenceFinalizedAt,
			enemy1UpDot = round3(enemy1.rootPart.CFrame.UpVector:Dot(enemyActiveCF.UpVector)),
			enemy1DistToActive = posDist(enemy1.rootPart.CFrame, enemyActiveCF),
			enemy2Active = enemy2.active,
			enemy2DistToActive = posDist(enemy2.rootPart.CFrame, enemyActiveCF),
		}
		log("sample:preHit5DuringKO", preHit5Sample)

		-- Agora envia SwitchPerformed adicional em t = 0.43s (antes do fim da sequência/KO)
		log("switchPerformed:sendAdditionalDuringBarrage", { previous = "enemy-1", active = "enemy-2" })
		c:onSwitchPerformed({ sideId = "B", previousFighterId = "enemy-1", activeFighterId = "enemy-2" })
		local pendingAfterAdditionalSwitch = #c.pendingSwitches

		-- Aguarda fim completo da barragem (0.48s), KO (0.53s) e eventual switch (0.18s)
		task.wait(0.55)
		local finalSample = {
			t = round3(os.clock() - t0),
			koStartedAt = koStartedAt,
			koEndedAt = koEndedAt,
			koFinalState = koFinalState,
			sequenceFinalizedAt = sequenceFinalizedAt,
			pendingAfterAdditionalSwitch = pendingAfterAdditionalSwitch,
			enemy2TweensToActiveCount = #enemy2TweensToActive,
			enemy2ActiveTransitions = enemy2ActiveTransitions,
			enemy1BenchMovesCount = #enemy1BenchMoves,
			enemy2TweensToActive = enemy2TweensToActive,
			enemy1BenchMoves = enemy1BenchMoves,
			activePendingHits = c.activePendingHits,
			pendingSwitches = #c.pendingSwitches,
		}
		log("sample:final", finalSample)

		s2b.observations = {
			midBarrageSample = midBarrageSample,
			preHit5Sample = preHit5Sample,
			finalSample = finalSample,
		}

		addCheck(
			s2b.checks,
			"S2B.1_nextActive_waits_for_barrage_and_ko",
			(not midBarrageSample.enemy2Active) and (midBarrageSample.enemy2TweensToActiveCount == 0) and (preHit5Sample.enemy2DistToActive > 1.0),
			"enemy-2 stays inactive at bench until barrage (0.48s) and KO (0.53s) finish",
			string.format(
				"at t=%.3fs (pendingHits=%d, activeKo=%s): enemy2Active=%s, distToBench=%.3f, distToActive=%.3f, tweens=%d; at t=%.3fs (seqFin=%s): distToActive=%.3f",
				midBarrageSample.t,
				midBarrageSample.activePendingHits,
				tostring(midBarrageSample.hasActiveKo),
				tostring(midBarrageSample.enemy2Active),
				midBarrageSample.enemy2DistToBench,
				midBarrageSample.enemy2DistToActive,
				midBarrageSample.enemy2TweensToActiveCount,
				preHit5Sample.t,
				tostring(preHit5Sample.sequenceFinalizedAt),
				preHit5Sample.enemy2DistToActive
			)
		)
		addCheck(
			s2b.checks,
			"S2B.2_additional_switch_no_duplicate",
			finalSample.enemy2TweensToActiveCount <= 1 and finalSample.enemy2ActiveTransitions <= 1,
			"at most 1 switch/entry tween for enemy-2 even if SwitchPerformed also arrives",
			string.format(
				"enemy2TweensToActive=%d, enemy2ActiveTransitions=%d, enemy1BenchMoves=%d, queuedDuringBarrage=%d",
				finalSample.enemy2TweensToActiveCount,
				finalSample.enemy2ActiveTransitions,
				finalSample.enemy1BenchMovesCount,
				finalSample.pendingAfterAdditionalSwitch
			)
		)
		addCheck(
			s2b.checks,
			"S2B.3_single_auto_switch_and_final_positions",
			finalSample.enemy2TweensToActiveCount == 1
				and finalSample.enemy2ActiveTransitions == 1
				and finalSample.enemy1BenchMovesCount == 1
				and posDist(enemy1.rootPart.CFrame, enemy1BenchCF) <= config.COMBAT_POSITION_TOLERANCE_STUDS
				and posDist(enemy2.rootPart.CFrame, enemyActiveCF) <= config.COMBAT_POSITION_TOLERANCE_STUDS,
			"exactly 1 switch transition and final positions at bench/active",
			string.format(
				"tweens=%d, transitions=%d, benchMoves=%d, enemy1DistToBench=%.4f, enemy2DistToActive=%.4f",
				finalSample.enemy2TweensToActiveCount,
				finalSample.enemy2ActiveTransitions,
				finalSample.enemy1BenchMovesCount,
				posDist(enemy1.rootPart.CFrame, enemy1BenchCF),
				posDist(enemy2.rootPart.CFrame, enemyActiveCF)
			)
		)

		local allPassed = true
		for _, chk in ipairs(s2b.checks) do
			if not chk.passed then
				allPassed = false
				break
			end
		end
		s2b.status = allPassed and "PASSED" or "FAILED"

		c.attackFinalizer.finalizeAttack = origFinalizeAttack
		c.createBattleTween = origCreateTween
		c.applyActiveVisualState = origApplyActive
	end

	-- =========================================================================
	-- CENÁRIO 3 — Tween de KO vs PivotTo e proteção por geração de batalha
	-- =========================================================================
	do
		local s3 = report.scenario3_koTweenAndGeneration
		local _, _, enemy1, enemy2 = startTwoEnemyBattle("K2_EdgeProbe_Scenario3_KoPivot", 50)
		local enemy1BenchCF = c:computeBenchSlotCFrame(enemy1.sideIndex, enemy1.benchIndex, enemy1.groundContactOffset)
		local enemyActiveCF = enemy1.homeCFrame

		local koStateAtBenchMove = nil
		local koTweenRef = nil
		local origCreateTween = c.createBattleTween
		c.createBattleTween = function(self, object, info, goal)
			local tween = origCreateTween(self, object, info, goal)
			if object == enemy1.rootPart and math.abs(info.Time - config.PLACEHOLDER_KO_TWEEN_SECONDS) < 0.001 then
				koTweenRef = tween
			end
			return tween
		end

		local origApplyActive = c.applyActiveVisualState
		c.applyActiveVisualState = function(self, entry)
			if entry.targetId == "enemy-1" and entry.dead and posDist(entry.homeCFrame, enemy1BenchCF) < 0.1 then
				koStateAtBenchMove = koTweenRef and koTweenRef.PlaybackState.Name or "None"
			end
			return origApplyActive(self, entry)
		end

		-- Morte fora de ataque (ex.: DoT) com nextActive preenchido
		c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = "enemy-2" })
		task.wait(config.PLACEHOLDER_KO_TWEEN_SECONDS + 0.12)
		local distAfterKo = posDist(enemy1.rootPart.CFrame, enemy1BenchCF)
		-- Aguarda janela extra para garantir que o tween de KO nunca sobrescreve o PivotTo
		task.wait(0.25)
		local distAfterExtraWait = posDist(enemy1.rootPart.CFrame, enemy1BenchCF)
		local enemy2DistAfterSwitch = posDist(enemy2.rootPart.CFrame, enemyActiveCF)

		addCheck(
			s3.checks,
			"S3.1_ko_tween_settled_before_pivot_and_stable_at_bench",
			koStateAtBenchMove == "Completed"
				and distAfterKo <= config.COMBAT_POSITION_TOLERANCE_STUDS
				and distAfterExtraWait <= config.COMBAT_POSITION_TOLERANCE_STUDS
				and enemy2.active
				and enemy2DistAfterSwitch <= config.COMBAT_POSITION_TOLERANCE_STUDS,
			"koTween Completed before bench PivotTo, enemy-1 permanently at bench, enemy-2 at active",
			string.format(
				"koStateAtBenchMove=%s, distAfterKo=%.4f, distAfterExtraWait=%.4f, enemy2Active=%s, enemy2Dist=%.4f",
				tostring(koStateAtBenchMove),
				distAfterKo,
				distAfterExtraWait,
				tostring(enemy2.active),
				enemy2DistAfterSwitch
			)
		)

		c.createBattleTween = origCreateTween
		c.applyActiveVisualState = origApplyActive

		-- Parte 2: nova batalha iniciada no meio de um KO (proteção por geração)
		local _, _, b1Enemy1, _ = startTwoEnemyBattle("K2_EdgeProbe_Scenario3_Battle1", 50)
		c:onFighterDied({ sideId = "B", fighterId = "enemy-1", nextActive = "enemy-2" })
		task.wait(0.10)
		local b1HadKo = c.attackFinalizer:hasActiveKoAnimations() and b1Enemy1.dead

		-- Inicia batalha 2 enquanto KO da batalha 1 ainda estaria em andamento
		local _, _, b2Enemy1, b2Enemy2 = startTwoEnemyBattle("K2_EdgeProbe_Scenario3_Battle2", 100)
		local b2Enemy1ExpectedCF = b2Enemy1.homeCFrame
		local b2Enemy2ExpectedCF = b2Enemy2.homeCFrame

		-- Aguarda além da duração nominal do KO + margem de fallback
		task.wait(config.PLACEHOLDER_KO_TWEEN_SECONDS + 0.25)

		local b2State = {
			b1HadKo = b1HadKo,
			b2Enemy1Active = b2Enemy1.active,
			b2Enemy1Dead = b2Enemy1.dead,
			b2Enemy2Active = b2Enemy2.active,
			b2Enemy1Dist = posDist(b2Enemy1.rootPart.CFrame, b2Enemy1ExpectedCF),
			b2Enemy2Dist = posDist(b2Enemy2.rootPart.CFrame, b2Enemy2ExpectedCF),
			activeKoCount = countMapEntries(c.attackFinalizer.activeKoTargets),
			pendingSwitches = #c.pendingSwitches,
			battleTasks = countMapEntries(c.battleTasks),
			battleTweens = countMapEntries(c.battleTweens),
		}
		s3.observations = { koStateAtBenchMove = koStateAtBenchMove, b2State = b2State }

		addCheck(
			s3.checks,
			"S3.2_stale_ko_callback_cannot_affect_new_battle",
			b2State.b1HadKo
				and b2State.b2Enemy1Active
				and (not b2State.b2Enemy1Dead)
				and (not b2State.b2Enemy2Active)
				and b2State.b2Enemy1Dist <= config.COMBAT_POSITION_TOLERANCE_STUDS
				and b2State.b2Enemy2Dist <= config.COMBAT_POSITION_TOLERANCE_STUDS
				and b2State.activeKoCount == 0
				and b2State.pendingSwitches == 0
				and b2State.battleTasks == 0
				and b2State.battleTweens == 0,
			"battle 2 fighters untouched, zero residual KO/tasks/tweens",
			string.format(
				"b1HadKo=%s, b2E1Active=%s, b2E1Dead=%s, b2E2Active=%s, d1=%.4f, d2=%.4f, ko=%d, sw=%d, tasks=%d, tweens=%d",
				tostring(b2State.b1HadKo),
				tostring(b2State.b2Enemy1Active),
				tostring(b2State.b2Enemy1Dead),
				tostring(b2State.b2Enemy2Active),
				b2State.b2Enemy1Dist,
				b2State.b2Enemy2Dist,
				b2State.activeKoCount,
				b2State.pendingSwitches,
				b2State.battleTasks,
				b2State.battleTweens
			)
		)

		local allPassed = true
		for _, chk in ipairs(s3.checks) do
			if not chk.passed then
				allPassed = false
				break
			end
		end
		s3.status = allPassed and "PASSED" or "FAILED"
	end
end)

c:cleanupStage()
if c.poolContainer then
	c.poolContainer:Destroy()
end

if not ok then
	error("K2_EDGE_PROBE_RUNTIME_ERROR: " .. tostring(runErr))
end

return report
