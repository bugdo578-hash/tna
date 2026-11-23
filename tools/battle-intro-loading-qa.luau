-- Studio Play, Client. Valida o loading cinematográfico com Jotaro dançando e Loading... animado:
-- 1. Spritesheet (rbxassetid://98463252431050), 24 quadros (4x6), 256x340, loop fluido e ImageRectOffset correto.
-- 2. Posicionamento no canto inferior direito, sem caixa/fundo, proporção preservada, responsivo PC/celular.
-- 3. Loading... em onda letra por letra (10 caracteres incluindo "...").
-- 4. Fade-in suave da cortina + fade-in de conteúdo, e fade-out suave na saída sem flicker.
-- 5. Carregamento rápido vs demorado sem congelar.
-- 6. Simulação de baixo FPS (saltos de relógio monotônico mantendo sincronia temporal).
-- 7. Cancelamento, falha, exit cover, reset e nova batalha consecutiva sem vazamento de conexões.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
local ts = player.PlayerScripts:WaitForChild("TS")
local BattleIntroOverlay = require(ts.UI.BattleIntroOverlay).BattleIntroOverlay
local BattleIntroController = require(ts.Controllers.BattleIntroController).BattleIntroController
local Config = require(ts.UI.CombatVisualConfig)

local checks = 0
local rows = {}
local function check(cond, msg)
	checks += 1
	assert(cond, "[BATTLE_INTRO_LOADING_QA FAIL] " .. tostring(msg))
end

local function approx(a, b, tol)
	return math.abs(a - b) <= (tol or 1e-3)
end

local ok, failure = xpcall(function()
	-- 1. Spritesheet, layout, proporção e onda de Loading...
	do
		local overlay = BattleIntroOverlay.new(playerGui, function() end)
		overlay.gui.Name = "BattleIntroOverlay_QA"

		local curtain = overlay.gui:FindFirstChild("Curtain")
		local group = overlay.gui:FindFirstChild("LoadingGroup")
		local sprite = group and group:FindFirstChild("JotaroSprite")
		local textRow = group and group:FindFirstChild("LoadingTextRow")

		check(overlay.gui.DisplayOrder == 1000, "DisplayOrder preservado em 1000")
		check(curtain ~= nil and curtain.BackgroundTransparency == 1, "cortina inicia transparente para fade-in suave")
		check(group ~= nil and group.Visible == false and group.BackgroundTransparency == 1, "LoadingGroup inicia oculto e sem fundo")
		check(group.AnchorPoint == Vector2.new(1, 1), "LoadingGroup ancorado no canto inferior direito")
		check(group.Position.X.Scale > 0.9 and group.Position.Y.Scale > 0.9, "LoadingGroup posicionado próximo às bordas direita e inferior")

		check(sprite ~= nil and sprite:IsA("ImageLabel"), "JotaroSprite presente")
		check(sprite.Image == "rbxassetid://98463252431050", "asset id correto do Jotaro")
		check(sprite.BackgroundTransparency == 1, "JotaroSprite sem fundo atrás")
		check(sprite.ResampleMode == Enum.ResamplerMode.Pixelated, "pixel art sem borrão (Pixelated)")
		check(sprite.ScaleType == Enum.ScaleType.Fit, "ScaleType Fit preservando proporção")
		check(sprite.ImageRectSize == Vector2.new(Config.BATTLE_INTRO_JOTARO_FRAME_WIDTH, Config.BATTLE_INTRO_JOTARO_FRAME_HEIGHT), "ImageRectSize corresponde ao quadro da spritesheet")

		local aspect = sprite:FindFirstChildOfClass("UIAspectRatioConstraint")
		check(aspect ~= nil and approx(aspect.AspectRatio, 256 / 340, 1e-4), "UIAspectRatioConstraint preserva 256:340")

		-- Verifica todos os 10 caracteres de "Loading..."
		check(textRow ~= nil and textRow.BackgroundTransparency == 1, "LoadingTextRow sem fundo")
		local expectedChars = { "L", "o", "a", "d", "i", "n", "g", ".", ".", "." }
		local scales = {}
		for i, ch in ipairs(expectedChars) do
			local slot = textRow:FindFirstChild("Slot_" .. i)
			local label = slot and slot:FindFirstChild("Char_" .. i)
			local sc = label and label:FindFirstChildOfClass("UIScale")
			check(label ~= nil and label:IsA("TextLabel") and label.Text == ch, "caractere " .. i .. " = " .. ch)
			check(sc ~= nil, "UIScale presente no caractere " .. i)
			table.insert(scales, sc)
		end

		-- Testa sequência dos 24 quadros (4 colunas x 6 linhas) e loop
		overlay:startLoadingAnimation()
		check(group.Visible == true, "LoadingGroup visível ao iniciar")
		for f = 0, 23 do
			overlay:updateLoading(f * Config.BATTLE_INTRO_JOTARO_FRAME_SECONDS + 0.001, 0)
			local expectedCol = f % 4
			local expectedRow = math.floor(f / 4)
			local expectedOffset = Vector2.new(expectedCol * Config.BATTLE_INTRO_JOTARO_FRAME_WIDTH, expectedRow * Config.BATTLE_INTRO_JOTARO_FRAME_HEIGHT)
			check(
				(sprite.ImageRectOffset - expectedOffset).Magnitude < 1e-2,
				string.format("frame %d offset esperado (%.2f,%.2f), obtido (%.2f,%.2f)", f, expectedOffset.X, expectedOffset.Y, sprite.ImageRectOffset.X, sprite.ImageRectOffset.Y)
			)
		end
		-- Frame 24 deve voltar ao frame 0 (loop)
		overlay:updateLoading(24 * Config.BATTLE_INTRO_JOTARO_FRAME_SECONDS + 0.001, 0)
		check((sprite.ImageRectOffset - Vector2.new(0, 0)).Magnitude < 1e-2, "loop volta ao quadro 0 após quadro 23")

		-- Testa salto de FPS baixo (0.0s -> 0.85s = quadro 10 direto, sem atrasar)
		overlay:updateLoading(10 * Config.BATTLE_INTRO_JOTARO_FRAME_SECONDS + 0.001, 0)
		local expected10 = Vector2.new((10 % 4) * Config.BATTLE_INTRO_JOTARO_FRAME_WIDTH, math.floor(10 / 4) * Config.BATTLE_INTRO_JOTARO_FRAME_HEIGHT)
		check((sprite.ImageRectOffset - expected10).Magnitude < 1e-2, "baixo FPS pula quadros mantendo sincronia temporal")

		-- Testa onda letra por letra incluindo os 3 pontos
		local maxScaleSeen = {}
		for i = 1, 10 do maxScaleSeen[i] = 1 end
		for stepIdx = 0, 60 do
			local t = stepIdx * 0.03
			overlay:updateLoading(t, 0)
			for i = 1, 10 do
				if scales[i].Scale > maxScaleSeen[i] then
					maxScaleSeen[i] = scales[i].Scale
				end
			end
		end
		for i = 1, 10 do
			check(maxScaleSeen[i] > 1.15, "caractere " .. i .. " (" .. expectedChars[i] .. ") participou da onda")
		end

		-- Stop limpa animação e reseta escalas
		overlay:stopLoadingAnimation()
		check(group.Visible == false, "stopLoadingAnimation oculta LoadingGroup")
		for i = 1, 10 do
			check(approx(scales[i].Scale, 1, 1e-4), "escala restaurada para 1 ao parar")
		end

		overlay.gui:Destroy()
		table.insert(rows, "Spritesheet 24 frames (4x6), layout bottom-right, low-FPS sync & wave text: passed")
	end

	-- 2. Fluxo completo no BattleIntroController (fade-in, loading, schedule, fade-out, exit, cancel, nova batalha)
	do
		local sentAcks = {}
		local cancelledIds = {}
		local recovered = 0

		local ctrl = BattleIntroController.new(
			function() return true end,
			function() return true end,
			function() recovered += 1 end,
			function(id) table.insert(cancelledIds, id) end
		)
		local origSend = ctrl.send
		ctrl.send = function(_, id, ack)
			table.insert(sentAcks, { id = id, ack = ack })
		end

		-- Inicia transição 101
		ctrl:receive({ id = 101, phase = "cover" })
		local state = ctrl.current
		check(state ~= nil and state.id == 101, "transição 101 criada")
		local curtain = state.overlay.gui:FindFirstChild("Curtain")
		local group = state.overlay.gui:FindFirstChild("LoadingGroup")
		check(curtain.BackgroundTransparency == 1 and not state.covered, "cortina não pisca preto instantaneamente")

		-- Passo intermediário no fade-in (metade do tempo)
		local t0 = state.coverStartedAt
		ctrl:step(state, t0 + 0.01) -- limpa coverFramePending
		ctrl:step(state, t0 + Config.BATTLE_INTRO_COVER_FADE_SECONDS * 0.5)
		check(curtain.BackgroundTransparency > 0 and curtain.BackgroundTransparency < 1, "cortina escurece progressivamente")
		check(not state.covered and #sentAcks == 0, "não envia covered antes da cortina fechar totalmente")
		check(group.Visible == false, "Jotaro só aparece após cobertura completa")

		-- Fim do fade-in da cortina
		ctrl:step(state, t0 + Config.BATTLE_INTRO_COVER_FADE_SECONDS + 0.02)
		check(state.covered == true and curtain.BackgroundTransparency == 0, "cortina atinge opacidade total")
		check(#sentAcks == 1 and sentAcks[1].ack == "covered", "envia covered após cobertura completa")
		check(group.Visible == true, "Jotaro e Loading... exibidos após cobertura")

		-- Aguarda preparação demorada (2.5s): animação segue fluida sem congelar
		local sprite = group:FindFirstChild("JotaroSprite")
		ctrl:step(state, state.loadingStartedAt + 0.25)
		check(sprite.ImageTransparency == 0, "Jotaro visível após fade-in de conteúdo")
		local off1 = sprite.ImageRectOffset
		ctrl:step(state, state.loadingStartedAt + 1.1)
		local off2 = sprite.ImageRectOffset
		check(off1 ~= off2, "spritesheet continua animando durante loading demorado")

		-- Chega schedule (arcAt = loadingStartedAt + 2.5, goAt = arcAt + 3.0)
		local arcAt = state.loadingStartedAt + 2.5
		local goAt = arcAt + 3.0
		ctrl:ready(101)
		ctrl:receive({ id = 101, phase = "schedule", arcAt = arcAt, goAt = goAt })

		-- Durante dissolução antes/início do reveal
		ctrl:step(state, arcAt - Config.BATTLE_INTRO_FADE_SECONDS - 0.02)
		check(sprite.ImageTransparency > 0 and sprite.ImageTransparency < 1, "Jotaro dissolve suavemente antes do reveal")

		-- Durante reveal da cortina
		ctrl:step(state, arcAt - Config.BATTLE_INTRO_FADE_SECONDS * 0.5)
		check(curtain.BackgroundTransparency > 0 and curtain.BackgroundTransparency < 1, "cortina revela suavemente")
		check(group.Visible == false, "conteúdo de loading já oculto durante abertura")

		-- Fim do reveal
		ctrl:step(state, arcAt)
		check(state.fadeFinished == true and curtain.Visible == false, "cortina totalmente aberta em arcAt")

		-- Exit cover fade-in suave
		ctrl:receive({ id = 101, phase = "exit", cageFrame = CFrame.new(0, 0, 0) })
		check(group.Visible == false, "LoadingGroup não aparece na saída da batalha")
		ctrl:step(state, arcAt + 0.01) -- limpa coverFramePending
		ctrl:step(state, arcAt + 0.02) -- inicia exitStartedAt
		ctrl:step(state, arcAt + 0.02 + Config.BATTLE_INTRO_EXIT_COVER_FADE_SECONDS * 0.5)
		check(curtain.BackgroundTransparency > 0 and curtain.BackgroundTransparency < 1 and not state.exitCovered, "cortina de saída escurece suavemente")
		ctrl:step(state, arcAt + 0.02 + Config.BATTLE_INTRO_EXIT_COVER_FADE_SECONDS + 0.02)
		check(state.exitCovered == true and curtain.BackgroundTransparency == 0, "saída envia exitCovered ao fechar")

		-- Batalha consecutiva (102) seguida de cancelamento/reset limpo
		ctrl:receive({ id = 102, phase = "cover" })
		check(ctrl.current ~= nil and ctrl.current.id == 102, "nova batalha 102 substitui 101")
		ctrl:failed(102)
		check(#cancelledIds == 1 and cancelledIds[1] == 102, "failed cancela 102 e para animação")
		ctrl:reset()
		check(ctrl.current == nil and ctrl.render == nil, "reset desconecta PreRender e destrói overlay")

		table.insert(rows, "BattleIntroController transitions (cover, long load, reveal, exit, reset): passed")
	end
end, debug.traceback)

assert(ok, failure)
return { result = "BATTLE_INTRO_LOADING_QA_PASSED", checks = checks, scenarios = rows }
