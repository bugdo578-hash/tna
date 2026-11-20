-- Studio Client, targeted regression QA for B-01 (Quit recovery), B-03 (Modal input blocking) and B-04 (Pause auto-resume HUD refresh).
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local HUD = require(ts.Controllers.BattleHUD).BattleHUD
local Combat = require(ts.Controllers.CombatController).CombatController
local remotes = require(ts.Controllers.BattleRemotes).BattleRemotes
local uiTheme = require(ts.UI.UITheme)
local theme = uiTheme.UITheme

local originalHud = game.Players.LocalPlayer.PlayerGui:FindFirstChild(theme.ScreenGuiName)
if originalHud then originalHud.Name = "BattleHUDOriginalLoteIQA" end
local originalRes = game.Players.LocalPlayer.PlayerGui:FindFirstChild(theme.ResultScreenGuiName)
if originalRes then originalRes.Name = "BattleResultOriginalLoteIQA" end

local c = Combat.new()
c:initBillboardPool()
local h = HUD.new(c)
h:buildGui()
h.screenGui.Name = "BattleHUDLoteIQA"
h.resultScreenGui.Name = "BattleResultLoteIQA"

local originalQuit = remotes.requestQuit
local originalPause = remotes.requestPause
local originalSkill = remotes.requestSkill
local originalSwitch = remotes.requestSwitch

local quitCalls, pauseCalls, skillCalls, switchCalls = 0, 0, 0, 0
local quitHook = nil

remotes.requestQuit = {
	FireServer = function()
		quitCalls += 1
		if quitHook then quitHook(quitCalls) end
	end,
}
remotes.requestPause = {
	FireServer = function()
		pauseCalls += 1
	end,
}
remotes.requestSkill = {
	FireServer = function()
		skillCalls += 1
	end,
}
remotes.requestSwitch = {
	FireServer = function()
		switchCalls += 1
	end,
}

local checks = 0
local failures = {}
local function check(condition, message)
	checks += 1
	if not condition then
		table.insert(failures, message)
	end
end

local function startBattle(mode, fighters)
	local own, enemy = "A", "B"
	local payload = {
		sides = { own, enemy },
		mode = mode or "PVE",
		canPause = (mode or "PVE") == "PVE",
		fighters = fighters or {
			{ sideId = own, targetId = "qa-own-1", fighterId = "jotaro", className = "Fury", level = 1, s3Unlocked = false, slotCosts = { 1, 2, 3 }, hp = 100, hpMax = 100, active = true },
			{ sideId = own, targetId = "qa-own-2", fighterId = "dio", className = "Menace", level = 1, s3Unlocked = false, slotCosts = { 1, 2, 3 }, hp = 100, hpMax = 100, active = false },
			{ sideId = enemy, targetId = "qa-enemy-1", fighterId = "dummy", className = "Menace", level = 1, s3Unlocked = false, slotCosts = { 1, 2, 3 }, hp = 100, hpMax = 100, active = true },
		},
	}
	c:onBattleStarted(payload)
	if c.stageFolder then c.stageFolder.Name = "ClientBattleStageLoteIQA" end
	h:onBattleStarted(payload)
	return own, enemy
end

local function findQuitButtons(root)
	local found = {}
	for _, desc in root:GetDescendants() do
		if desc:IsA("TextButton") and desc.Name == "QuitButton" then
			table.insert(found, desc)
		end
	end
	return found
end

local function runB01()
	local interval = uiTheme.QUIT_RETRY_INTERVAL_SECONDS
	local maxAttempts = uiTheme.QUIT_RETRY_MAX_ATTEMPTS
	local finalTimeout = uiTheme.QUIT_FINAL_TIMEOUT_SECONDS or 0.75

	check(interval == 0.35, "B-01: QUIT_RETRY_INTERVAL_SECONDS alterado: " .. tostring(interval))
	check(maxAttempts == 8, "B-01: QUIT_RETRY_MAX_ATTEMPTS alterado: " .. tostring(maxAttempts))
	check(uiTheme.QUIT_FINAL_TIMEOUT_SECONDS ~= nil and uiTheme.QUIT_FINAL_TIMEOUT_SECONDS > 0, "B-01: QUIT_FINAL_TIMEOUT_SECONDS ausente")

	-- Caso 1: servidor não responde após todas as 8 tentativas
	quitCalls = 0
	quitHook = nil
	startBattle("PVE")
	local quitButtons = findQuitButtons(h.screenGui)
	check(#quitButtons == 1, "B-01: esperado 1 QuitButton, encontrado " .. tostring(#quitButtons))
	check(rawequal(h.quitButton, h.quitController.host.getQuitButton()), "B-01: QuitButton nao compartilhado entre HUD e QuitController")
	check(rawequal(h.quitButton, h.sessionControls.quitButton), "B-01: QuitButton nao compartilhado com HudSessionControls")

	local t0 = os.clock()
	h:handleQuitClicked()
	check(quitCalls == 0 and h.quitButton.Text == theme.Texts.QuitConfirmButton, "B-01: primeiro clique deveria pedir confirmacao")
	h:handleQuitClicked()
	check(quitCalls == 1 and not h.screenGui.Enabled and h.quitStatusLabel.Visible, "B-01: segundo clique nao iniciou Quit")

	local deadline = os.clock() + (maxAttempts * interval) + 1.5
	repeat task.wait(0.05) until quitCalls >= maxAttempts or os.clock() >= deadline
	local elapsedRetries = os.clock() - t0
	check(quitCalls == maxAttempts, "B-01: esperado 8 tentativas, obtido " .. tostring(quitCalls))
	check(elapsedRetries >= (maxAttempts - 1) * interval - 0.15, "B-01: intervalo de retries muito curto: " .. tostring(elapsedRetries))

	-- Aguarda timeout final de recuperação
	task.wait(finalTimeout + 0.25)
	check(quitCalls == maxAttempts, "B-01: enviou tentativas alem de 8: " .. tostring(quitCalls))
	check(h.screenGui.Enabled == true, "B-01: BattleHUD nao foi restaurado apos timeout final")
	check(h.quitStatusLabel.Visible == false, "B-01: QuitStatus nao foi ocultado apos timeout final")
	check(h.resultScreenGui.Enabled == false, "B-01: ResultScreenGui permaneceu habilitado apos timeout final")
	check(h.resultOverlay.Visible == false, "B-01: ResultOverlay foi aberto indevidamente")
	check(h.quitController:isQuitRequested() == false, "B-01: quitRequested nao foi limpo")
	check(h.battleActive == true and h.battleEnded == false, "B-01: batalha foi encerrada localmente")
	check(c.stageFolder ~= nil, "B-01: palco foi destruido localmente")
	check(h.quitButton.Text == theme.Texts.QuitButton, "B-01: texto do QuitButton nao foi restaurado")

	-- Novo Quit possível em dois cliques
	local beforeNewQuit = quitCalls
	h:handleQuitClicked()
	check(quitCalls == beforeNewQuit and h.quitButton.Text == theme.Texts.QuitConfirmButton, "B-01: nova confirmacao de Quit falhou no 1o clique")
	h:handleQuitClicked()
	check(quitCalls == beforeNewQuit + 1 and not h.screenGui.Enabled and h.quitStatusLabel.Visible, "B-01: novo Quit falhou no 2o clique")

	-- BattleEnded tardio e válido continua sendo processado normalmente
	h:onBattleEnded({ winnerSideId = "B", reason = "quit" })
	check(not h.battleActive and h.battleEnded and not h.screenGui.Enabled and not h.resultScreenGui.Enabled and c.stageFolder == nil, "B-01: BattleEnded tardio nao foi processado corretamente")

	-- Caso 2: BattleEnded chega antes do timeout final (logo apos a 8a tentativa)
	quitCalls = 0
	quitHook = function(n)
		if n == maxAttempts then
			task.defer(function()
				h:onBattleEnded({ winnerSideId = "B", reason = "quit" })
			end)
		end
	end
	startBattle("PVE")
	h:handleQuitClicked(); h:handleQuitClicked()
	local d2 = os.clock() + (maxAttempts * interval) + 1.5
	repeat task.wait(0.05) until quitCalls >= maxAttempts or os.clock() >= d2
	task.wait(finalTimeout + 0.25)
	check(not h.battleActive and h.battleEnded and not h.screenGui.Enabled and not h.quitStatusLabel.Visible and not h.resultScreenGui.Enabled, "B-01: BattleEnded antes do timeout sofreu restauracao indevida")

	-- Caso 3: Teardown acontece antes do timeout final
	quitCalls = 0
	quitHook = function(n)
		if n == maxAttempts then
			task.defer(function()
				h:teardownBattle(true)
			end)
		end
	end
	startBattle("PVE")
	h:handleQuitClicked(); h:handleQuitClicked()
	local d3 = os.clock() + (maxAttempts * interval) + 1.5
	repeat task.wait(0.05) until quitCalls >= maxAttempts or os.clock() >= d3
	task.wait(finalTimeout + 0.25)
	check(not h.battleActive and h.battleEnded and not h.screenGui.Enabled and not h.quitStatusLabel.Visible and not h.resultScreenGui.Enabled, "B-01: teardown antes do timeout sofreu alteracao de callback antigo")

	-- Caso 4: Batalha 1 termina e Batalha 2 comeca antes de um timeout antigo
	quitCalls = 0
	local battle2Stage = nil
	quitHook = function(n)
		if n == maxAttempts then
			task.defer(function()
				h:onBattleEnded({ winnerSideId = "B", reason = "quit" })
				startBattle("PVP")
				battle2Stage = c.stageFolder
			end)
		end
	end
	startBattle("PVE")
	h:handleQuitClicked(); h:handleQuitClicked()
	local d4 = os.clock() + (maxAttempts * interval) + 1.5
	repeat task.wait(0.05) until battle2Stage ~= nil or os.clock() >= d4
	task.wait(finalTimeout + 0.25)
	check(h.battleActive and not h.battleEnded and h.screenGui.Enabled and c.stageFolder == battle2Stage and h.battleMode == "PVP", "B-01: timeout antigo afetou Batalha 2")
	quitHook = nil
	h:onBattleEnded({ reason = "error" })
end

local function runB03()
	startBattle("PVE")
	h:handlePauseClicked()
	check(h.pauseOverlay ~= nil and h.pauseOverlay.Visible == true, "B-03: PauseOverlay nao ficou visivel")
	check(h.pauseOverlay.Active == true, "B-03: PauseOverlay.Active deveria ser true")
	check(h.pauseOverlay.Size == theme.Layout.FullSize and h.pauseOverlay.Position == theme.Layout.OriginPosition, "B-03: PauseOverlay nao ocupa area esperada")
	check(h.pauseOverlay.ZIndex == 20, "B-03: PauseOverlay ZIndex alterado")
	local pauseBlocker = h.pauseOverlay:FindFirstChild("InputBlocker")
	check(pauseBlocker ~= nil and pauseBlocker:IsA("GuiButton") and pauseBlocker.Active == true and pauseBlocker.Size == theme.Layout.FullSize and pauseBlocker.ZIndex == 20, "B-03: PauseOverlay InputBlocker ausente ou inativo")

	local resumeBtn = h.pauseOverlay:FindFirstChild("ResumeButton", true)
	check(resumeBtn ~= nil and resumeBtn:IsA("TextButton") and resumeBtn.Visible, "B-03: ResumeButton ausente")

	-- Fechar pausa
	h:handlePauseClicked()
	check(h.pauseOverlay.Visible == false, "B-03: PauseOverlay nao fechou")

	-- ResultOverlay
	h:onBattleEnded({ winnerSideId = "A", tinyesReward = 50 })
	check(h.resultOverlay ~= nil and h.resultOverlay.Visible == true and h.resultScreenGui.Enabled == true, "B-03: ResultOverlay nao abriu")
	check(h.resultOverlay.Active == true, "B-03: ResultOverlay.Active deveria ser true")
	check(h.resultOverlay.Size == theme.Layout.FullSize and h.resultOverlay.Position == theme.Layout.OriginPosition, "B-03: ResultOverlay nao ocupa area esperada")
	check(h.resultOverlay.ZIndex == 30, "B-03: ResultOverlay ZIndex alterado")
	local resultBlocker = h.resultOverlay:FindFirstChild("InputBlocker")
	check(resultBlocker ~= nil and resultBlocker:IsA("GuiButton") and resultBlocker.Active == true and resultBlocker.Size == theme.Layout.FullSize and resultBlocker.ZIndex == 30, "B-03: ResultOverlay InputBlocker ausente ou inativo")
	h:closeResultOverlay()
	check(h.resultOverlay.Visible == false and h.resultScreenGui.Enabled == false, "B-03: ResultOverlay nao fechou")
end

local function runB04()
	skillCalls = 0
	switchCalls = 0

	-- Caso 1: PvE em IDLE, ATB = 2 (S1=1, S2=2, S3=3 bloqueado por nivel), reserva vivo
	startBattle("PVE")
	h:onAtbSync({ sideId = "A", atb = 2 })
	local skillWidgets = h.skillsPanel.skillButtonWidgets
	local tagWidgets = h.tagPanel.tagSlotWidgets

	check(skillWidgets[1].button.Active == true and skillWidgets[1].stateLabel.Text == theme.Texts.SkillReadyState, "B-04: pre-condicao S1 pronta falhou")
	check(skillWidgets[2].button.Active == true and skillWidgets[2].stateLabel.Text == theme.Texts.SkillReadyState, "B-04: pre-condicao S2 pronta falhou")
	check(skillWidgets[3].button.Active == false and skillWidgets[3].stateLabel.Text == theme.Texts.SkillLockedState, "B-04: pre-condicao S3 bloqueada falhou")
	check(tagWidgets[2].button.Active == true and tagWidgets[2].statusLabel.Text == theme.Texts.TagReadyStatus, "B-04: pre-condicao Tag TROCAR falhou")

	-- Pausar
	h:handlePauseClicked()
	check(h.isPaused == true and h.pauseOverlay.Visible == true, "B-04: Pause nao ativou")
	check(skillWidgets[1].button.Active == false and skillWidgets[1].stateLabel.Text == theme.Texts.SkillBusyState, "B-04: S1 deveria mostrar AGUARDE IDLE em pause")
	check(tagWidgets[2].button.Active == false and tagWidgets[2].statusLabel.Text == theme.Texts.TagWaitStatus, "B-04: Tag deveria mostrar AGUARDE IDLE em pause")

	-- Passar > 0.35s e receber AtbSync do oponente
	task.wait(0.42)
	h:onAtbSync({ sideId = "B", atb = 1 })
	check(h.isPaused == false and h.pauseOverlay.Visible == false, "B-04: PauseOverlay nao desapareceu apos AtbSync do oponente")
	check(skillWidgets[1].button.Active == true and skillWidgets[1].stateLabel.Text == theme.Texts.SkillReadyState, "B-04: S1 nao voltou a ficar pronta apos auto-resume")
	check(skillWidgets[2].button.Active == true and skillWidgets[2].stateLabel.Text == theme.Texts.SkillReadyState, "B-04: S2 nao voltou a ficar pronta apos auto-resume")
	check(skillWidgets[3].button.Active == false and skillWidgets[3].stateLabel.Text == theme.Texts.SkillLockedState, "B-04: S3 nao preservou bloqueio de nivel apos auto-resume")
	check(tagWidgets[2].button.Active == true and tagWidgets[2].statusLabel.Text == theme.Texts.TagReadyStatus, "B-04: Tag nao voltou a mostrar TROCAR apos auto-resume")

	-- Caso 2: ATB insuficiente (0.5 < 1) + auto-resume via AtbSync do oponente
	h:onAtbSync({ sideId = "A", atb = 0.5 })
	h:handlePauseClicked()
	task.wait(0.42)
	h:onAtbSync({ sideId = "B", atb = 1.5 })
	check(not h.isPaused, "B-04: auto-resume com ATB baixo falhou")
	check(skillWidgets[1].button.Active == false and skillWidgets[1].stateLabel.Text == theme.Texts.SkillNoAtbState, "B-04: S1 deveria mostrar SEM ATB apos auto-resume")
	check(tagWidgets[2].button.Active == true and tagWidgets[2].statusLabel.Text == theme.Texts.TagReadyStatus, "B-04: Tag deveria mostrar TROCAR mesmo com ATB baixo")

	-- Caso 3: Estado nao permite troca (ATTACK) durante pausa -> auto-resume via AtbSync do oponente mantem Tag e Skills bloqueados
	h:onAtbSync({ sideId = "A", atb = 2 })
	h:onStateChanged({ state = "ATTACK" })
	h:handlePauseClicked()
	task.wait(0.42)
	h:onAtbSync({ sideId = "B", atb = 2 })
	check(not h.isPaused and not h.pauseOverlay.Visible, "B-04: auto-resume em ATTACK falhou")
	check(skillWidgets[1].button.Active == false and skillWidgets[1].stateLabel.Text == theme.Texts.SkillBusyState, "B-04: S1 deveria continuar bloqueada em ATTACK")
	check(tagWidgets[2].button.Active == false and tagWidgets[2].statusLabel.Text == theme.Texts.TagWaitStatus, "B-04: Tag deveria continuar bloqueado em ATTACK")

	-- Caso 4: PvP continua com Pause indisponivel
	h:onBattleEnded({ reason = "error" })
	local pauseBeforePvp = pauseCalls
	startBattle("PVP")
	check(h.canPause == false and h.pauseButton.Visible == false, "B-04: PvP deveria ocultar Pause")
	h:handlePauseClicked()
	check(h.isPaused == false and h.pauseOverlay.Visible == false and pauseCalls == pauseBeforePvp, "B-04: PvP nao deveria permitir Pause")

	-- Sem RequestSkill ou RequestSwitch extras
	check(skillCalls == 0, "B-04: RequestSkill extra disparado: " .. tostring(skillCalls))
	check(switchCalls == 0, "B-04: RequestSwitch extra disparado: " .. tostring(switchCalls))
	h:onBattleEnded({ reason = "error" })
end

local ok, err = pcall(function()
	runB01()
	runB03()
	runB04()
end)

remotes.requestQuit = originalQuit
remotes.requestPause = originalPause
remotes.requestSkill = originalSkill
remotes.requestSwitch = originalSwitch
pcall(function() h:destroy() end)
pcall(function() c:destroy() end)
if originalHud then originalHud.Name = theme.ScreenGuiName end
if originalRes then originalRes.Name = theme.ResultScreenGuiName end

if not ok then
	error("REGRESSION_QA_CRASH: " .. tostring(err))
end
if #failures > 0 then
	print("REGRESSION_QA_FAILED", "checks=" .. checks, "failures=" .. #failures)
	for _, msg in failures do
		print("  FAIL:", msg)
	end
else
	print("REGRESSION_QA_PASSED", "checks=" .. checks)
end
