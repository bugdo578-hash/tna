-- Execute no Client em Play novo após rbxtsc/Rojo. Controllers isolados, sem servidor/perfis.
local Combat = require(game.Players.LocalPlayer.PlayerScripts.TS.Controllers.CombatController).CombatController
local config = require(game.Players.LocalPlayer.PlayerScripts.TS.UI.CombatVisualConfig)
local timeline = require(game.ReplicatedStorage.TS.SkillData).JOTARO_SKILL_DATA[2]
local c = Combat.new()
c:initBillboardPool()
local checks, rows = 0, {}
local function check(value, message)
	checks += 1
	assert(value, message)
end
local function close(actual, expected, label)
	check((actual.Position - expected.Position).Magnitude <= config.COMBAT_POSITION_TOLERANCE_STUDS, label)
end
local function start()
	c:onBattleStarted({ sides = { "A", "B" }, fighters = {
		{ sideId = "A", targetId = "own", fighterId = "jotaro", hp = 100, hpMax = 100, active = true },
		{ sideId = "B", targetId = "enemy", fighterId = "anubis", hp = 100, hpMax = 100, active = true },
	} })
	c.stageFolder.Name = "OraReturnQA"
	local a, b = c.fightersByTargetId.own, c.fightersByTargetId.enemy
	check(a.standMotion ~= nil and a.standMotion.joint.Part1 ~= nil, "QA requires real StandJoint")
	task.wait(config.PLACEHOLDER_STRIKE_TWEEN_SECONDS * 2)
	return a, b
end
local function attack()
	c:onAttackStarted({ attackerId = "own", targetId = "enemy", slot = 2 })
end
local function result(i, hit)
	c:onHitResolved({ attackerId = "own", targetId = "enemy", hitIndex = i, hit = hit, damage = hit and 1 or 0, crit = false })
end
local ok, failure = pcall(function()
	for _, mode in { "hit", "dodge", "KO" } do
		local a, b = start()
		local base, standBase = a.homeCFrame, a.standMotion.baseC1
		local standWorldBase = a.standMotion.joint.Part1.CFrame
		for use = 1, 5 do
			-- Reinicia somente a fixture do alvo entre usos; nunca recaptura a base do atacante.
			b.dead, b.active, b.hp = false, true, b.hpMax
			b.model:PivotTo(b.homeCFrame)
			attack()
			for i, hit in timeline.hits do
				if mode ~= "KO" or i <= 2 then
					c:delayBattle(hit.time, function()
						result(i, mode ~= "dodge")
						if mode == "KO" and i == 2 then c:onFighterDied({ fighterId = "enemy", sideId = "B" }) end
					end)
				end
			end
			task.wait(timeline.hits[#timeline.hits].time + timeline.returnTime + config.HIT_RESULT_WAIT_SECONDS)
			close(a.rootPart.CFrame, base, mode .. " body " .. use)
			close(a.standMotion.joint.C1, standBase, mode .. " joint " .. use)
			close(a.standMotion.joint.Part1.CFrame, standWorldBase, mode .. " Stand HRP " .. use)
			check(a.standMotion.baseC1 == standBase and a.homeCFrame == base, "base changed")
			check(c.activePendingHits == 0, "ignored hits left pending")
			if mode == "KO" then check(b.dead and b.rootPart.CFrame.UpVector:Dot(b.homeCFrame.UpVector) < 0.5, "KO body regression") end
		end
		table.insert(rows, mode .. ": 5 uses passed")
	end
	-- Cancela durante avanço e recuo; confere a restauração mesmo após Destroy.
	for _, phase in { 0.5, 1.5 } do
		for _, reason in { "Quit", "last target KO" } do
			local a = start()
			local root, joint, base, standBase = a.rootPart, a.standMotion.joint, a.homeCFrame, a.standMotion.baseC1
			attack()
			result(1, true)
			task.wait(timeline.hits[1].time + config.PLACEHOLDER_STRIKE_TWEEN_SECONDS * phase)
			if reason == "last target KO" then c:onFighterDied({ fighterId = "enemy", sideId = "B" }) end
			c:cleanupStage() -- BattleEnded/teardown compartilhado por ambos os motivos.
			close(root.CFrame, base, reason .. " body at teardown")
			close(joint.C1, standBase, reason .. " joint at teardown")
			task.wait(timeline.hits[#timeline.hits].time + timeline.returnTime)
			close(joint.C1, standBase, "stale recoil after teardown")
			check(next(c.battleTasks) == nil and next(c.battleTweens) == nil, "teardown resources")
		end
	end
	-- Recuo pendente de um pulso anterior não pode sobrescrever outro pulso/restauração.
	local a = start()
	c:pulseStandStrike(a)
	c:pulseStandStrike(a)
	c:restoreStandBase(a)
	task.wait(config.PLACEHOLDER_STRIKE_TWEEN_SECONDS * 3)
	close(a.standMotion.joint.C1, a.standMotion.baseC1, "stale pulse callback")
end)
c:cleanupStage()
c.poolContainer:Destroy()
assert(ok, failure)
return { result = "ORA_RETURN_CLIENT_PASSED", checks = checks, scenarios = rows }
