-- Run in Studio Client after a fresh rbxtsc/Rojo sync. No server purchases.
local ts = game.Players.LocalPlayer.PlayerScripts.TS
local Controller = require(ts.Controllers.ShopController).ShopController
local Inventory = require(ts.Controllers.InventoryController).InventoryController
local theme = require(ts.UI.UITheme).UITheme
local fixture = require(ts.UI.ShopPreview)
local state = fixture.SHOP_PREVIEW
local qa = Controller.new()
qa.gui.Name, qa.gui.Enabled = "ShopQA", false
qa.gui.Parent = game.Players.LocalPlayer.PlayerGui
local inventory = Inventory.new()
inventory.gui.Enabled = false
local sent, ids = {}, {}
qa.purchase = { FireServer = function(_, payload)
	assert(type(payload.requestId) == "string" and #payload.requestId > 0 and #payload.requestId <= 64, "requestId length")
	assert(not ids[payload.requestId], "reused requestId")
	assert(payload.requestId:match("^%d+%-%x%x%x%x%x%x%x%x$"), "requestId format")
	ids[payload.requestId] = true
	local fields = 0
	for _ in payload do fields += 1 end
	assert(fields == 2 and payload.offerId ~= nil, "purchase contract")
	table.insert(sent, payload)
end }
local function reset()
	qa:close()
	qa:cancelRequest()
	qa:receiveState(state)
	qa:receiveBalance(fixture.SHOP_PREVIEW_BALANCE)
	qa:open()
end
local function result(request, ok, reason)
	qa:receiveResult({ requestId = request.requestId, offerId = request.offerId, ok = ok, reason = reason })
end
local function changedState()
	local nextState = { offers = {} }
	for index, offer in state.offers do nextState.offers[index] = table.clone(offer) end
	nextState.offers[1].offerId = "replacement"
	return nextState
end
local function hasText(root, text)
	for _, item in root:GetDescendants() do
		if item:IsA("TextLabel") and item.Text == text then return true end
	end
	return false
end
local ok, reason = pcall(function()
	reset()
	qa:buy(state.offers[3])
	assert(#sent == 0, "insufficient balance sent request")
	qa:buy(state.offers[1])
	qa:buy(state.offers[1])
	qa:buy(state.offers[2])
	assert(#sent == 1 and sent[1].offerId == state.offers[1].offerId, "double click")
	assert(qa.balance == fixture.SHOP_PREVIEW_BALANCE and qa.state == state, "optimistic mutation")
	local request = sent[#sent]
	local deadline = qa.requestDeadline
	result({ requestId = "unrelated", offerId = request.offerId }, true)
	result({ requestId = "unrelated", offerId = request.offerId }, false, "saldo")
	assert(qa.pending.requestId == request.requestId and qa.notice == "", "unrelated result affected UI")
	qa:receiveState(changedState())
	qa:receiveBalance(200)
	assert(qa.pending ~= nil and qa.notice == "", "snapshots confirmed/unlocked purchase")
	qa:receiveState(state)
	qa:receiveBalance(fixture.SHOP_PREVIEW_BALANCE)
	qa:close()
	assert(qa.requestTimer == nil and qa.noticeTimer == nil, "closed timer")
	qa:open()
	qa:buy(state.offers[1])
	assert(qa.requestDeadline == deadline and #sent == 1 and not qa.buttons[1].button.Active, "reopening bypassed lock")
	result(request, true)
	assert(qa.notice == theme.Shop.Purchased .. " Anubis" and qa.pending == nil and qa.requestTimer == nil and qa.buttons[1].button.Active, "success result")
	result(request, false, "saldo")
	assert(qa.notice == theme.Shop.Purchased .. " Anubis", "duplicate result changed notice")
	for _, refusal in { "saldo", "oferta_invalida", "em_batalha", "limite", "erro" } do
		reset()
		qa:buy(state.offers[1])
		local current = sent[#sent]
		result(request, true)
		assert(qa.pending.requestId == current.requestId and qa.notice == "", "old result matched new request")
		result(current, false, refusal)
		assert(qa.notice == theme.Shop.PurchaseReasons[refusal] and qa.pending == nil and qa.buttons[1].button.Active, refusal)
	end
	reset()
	qa:buy(state.offers[1])
	request = sent[#sent]
	task.wait(theme.Shop.PurchaseTimeoutSeconds + .1)
	assert(qa.pending == nil and qa.requestTimer == nil and qa.buttons[1].button.Active and qa.notice == theme.Shop.Timeout, "timeout/retry")
	qa:buy(state.offers[1])
	local retry = sent[#sent]
	result(request, true)
	assert(qa.pending.requestId == retry.requestId and qa.notice == theme.Shop.Timeout, "late result released retry")
	local connections = table.clone(qa.visibleConnections)
	qa:close()
	assert(qa.panel == nil and qa.requestTimer == nil and qa.previewTimer == nil and qa.noticeTimer == nil, "close leaked work")
	for _, connection in connections do assert(not connection.Connected, "close leaked connection") end
	result(retry, true)
	assert(qa.pending == nil and qa.noticeTimer == nil and qa.panel == nil, "closed result leaked timer/lock")
	qa:open()
	assert(qa.noticeLabel.Text == theme.Shop.Purchased .. " Anubis", "closed result lost")
	qa:close()
	for _, outcome in { "ok", "saldo", "oferta_invalida", "em_batalha", "limite", "erro" } do
		reset()
		qa:testShop(outcome)
		assert(qa.preview and qa.previewResult == outcome and qa.panel.Title.Text:find("STUDIO"), "/testshop entry")
		local count = #sent
		qa:buy(state.offers[1])
		qa:buy(state.offers[1])
		assert(qa.pending ~= nil and not qa.buttons[1].button.Active, "preview double click")
		task.wait(theme.Shop.DevResultSeconds + .1)
		assert(#sent == count and qa.pending == nil and qa.buttons[1].button.Active, "preview sent request/stayed locked")
		assert(qa.notice == (outcome == "ok" and theme.Shop.Purchased .. " Anubis" or theme.Shop.PurchaseReasons[outcome]), "preview " .. outcome)
	end
	qa:testShop("off")
	assert(not qa.preview and qa.panel == nil, "/testshop off")
	reset()
	qa.preview = true
	qa:buy(state.offers[1])
	qa:close()
	assert(qa.previewTimer == nil and qa.requestTimer == nil and qa.pending == nil, "preview close leaked work")
	task.wait(theme.Shop.DevResultSeconds + .1)
	assert(qa.notice == "" and qa.panel == nil, "closed preview callback ran")
	reset()
	qa:buy(state.offers[1])
	qa:close()
	task.wait(theme.Shop.PurchaseTimeoutSeconds + .1)
	assert(qa.notice == "" and qa.panel == nil, "closed timer changed UI")
	qa:open()
	assert(qa.pending == nil and qa.notice == theme.Shop.Timeout and qa.buttons[1].button.Active, "closed deadline did not expire")
	qa:close()
	qa.battleActive = true
	qa:open()
	assert(qa.panel == nil, "battle opened shop")
	qa.battleActive = false
	qa:setInventoryOpen(true)
	assert(not qa.toggle.Visible, "toggle covers inventory")
	local fighter = { itemUuid = "qa", fighterId = "anubis", displayName = "Anubis", level = 3, xp = 0, xpToNext = 300,
		effectiveStats = { hp = 14, atk = 10, dodge = 5, crit = 9 }, availablePoints = 4,
		skills = {}, s3Unlocked = false, unavailable = false }
	for _, refusal in { "sem_pontos", "cap_nivel", "par", "invalido" } do
		inventory.state = { fighters = { fighter }, activeTeam = {}, allocationReason = refusal }
		inventory.selected = "qa"
		inventory:render()
		assert(hasText(inventory.panel, theme.Inventory.AllocationReasons[refusal]), "allocation " .. refusal)
		inventory.selected = nil
		inventory:render()
		assert(hasText(inventory.panel, theme.Inventory.AllocationReasons[refusal]), "unselected allocation " .. refusal)
	end
	inventory.state = { fighters = { fighter }, activeTeam = {} }
	inventory.selected = "qa"
	inventory:render()
	assert(hasText(inventory.panel, "Pontos disponíveis: 4"), "allocation reason persisted without field")
	qa:destroy()
	qa:destroy()
end)
qa:destroy()
inventory:destroy()
assert(ok, reason)
return "SHOP_PURCHASE_RESULTS_AND_ALLOCATION_UI_PASSED"
