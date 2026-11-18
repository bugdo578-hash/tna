# CHANGELOG — Tiny Adventures

Registro conciso de mudanças a partir de `2026-11-14` (ordem cronológica reversa). Histórico anterior a `2026-11-14` (base inicial T1–T5, T7.1, T7.2 e primeira correção de DataStore/autosave): [CHANGELOG_ARCHIVE.md](CHANGELOG_ARCHIVE.md). Estado operacional atual: [HANDOFF.md](HANDOFF.md).

## 2026-11-17 — Listener de `VFXEvent` no mundo, rate limit client e diagnóstico (`VFXController`)

- `src/client/UI/VFXConfig.ts`: adicionadas constantes `VFX_REMOTE_EVENT_NAME = "VFXEvent"`, `VFX_DEBUG = false` e rate limit provisório (`VFX_REMOTE_BUCKET_CAPACITY = 12`, `VFX_REMOTE_REFILL_PER_SECOND = 10`, `VFX_REMOTE_RATE_LIMIT_TOLERANCE = 1e-6`).
- `src/client/Controllers/VFXController.ts`: escuta `VFXEvent.OnClientEvent` via `FindFirstChild` + `ChildAdded` (no-op silencioso se ausente; sem `WaitForChild`, sem nome hardcoded fora de `VFXConfig`); valida `pasta` (`Instance` com `Parent`) e `origem` (`Vector3`/`CFrame` finitos, `BasePart`, `Attachment`, `Model` ou `nil`); aplica token bucket leve e roteia para `emit(pasta, origem, "normal", false)` com culling de mundo ativo; `destroy()` desconecta `OnClientEvent` e `ChildAdded`.
- Diagnóstico: `debugStats()` expõe cópia dos contadores (`culling`, `orcamento`, `pastaInvalida`, `moduloAusente`, `emitFalhou`, `origemInvalida`, `rateLimit`) e `VFX_DEBUG` (`false` por padrão, restrito a `RunService.IsStudio()`) emite `warn` único na primeira ocorrência de cada motivo. `server/`, `shared/` e `CombatController.ts` intocados.
- `tools/vfx-controller-qa.luau` e validação em Play novo no Studio: `npx.cmd rbxtsc` (0 erros), `VFX_CONTROLLER_QA_PASSED` (179 checks, 13 cenários incluindo `VFXEvent` ausente/`ChildAdded`, payloads inválidos, `emit` com `Vector3`, origens válidas, rate limit, `destroy()` e `debugStats()`/`VFX_DEBUG`), `BATTLE_TEARDOWN_CLIENT_PASSED` (538 checks), `ORA_RETURN_CLIENT_PASSED` (105 checks) e emissão real de `Workspace.Barragem SP` observada no console sem erros.

## 2026-11-17 — Porte client de VFX (`Part_Icles` / `VFXController`)

- `src/client/types/Part_Icles.d.ts`, `src/client/UI/VFXConfig.ts` e `src/client/Controllers/VFXController.ts`: porte em `roblox-ts` do controlador de `ReplicatedStorage.Part_Icles` com carregamento protegido por `pcall` (fallback no-op com `warn` único se ausente/inválido), API local (`emit`, `preload`, `deload`, `clear`, sem RemoteEvent) e constantes exclusivas do client.
- Correções e garantias: contador derivado de tabela forte `ativos` com limpeza em `Destroying`; prioridade (`"essencial"` para hit/crit/KO expulsa o mais antigo de baixa prioridade e respeita teto duro provisório `limite + VFX_LIMITE_ESSENCIAIS_EXTRA = 4`, expulsando o essencial mais antigo acima do teto); FPS relativo a `FramerateCap`/`fpsMaximoMedido` (não corta em teto 30 FPS mobile; piso mobile `VFX_LIMITE_MINIMO_MOBILE = 3` abaixo do inicial `4`) + teto por `SavedQualityLevel`; culling por distância restrito a VFX do mundo com varredura ativa somente quando há VFX cullable tocando; cancelamento completo de `task.delay`/`task.defer`/varredura + `AbsoluteDisable` em `clear()`; `preload`/`deload` com geração por batalha para impedir que teardown atrasado descarregue o preload da nova luta.
- Integração mínima em `CombatController.ts`, `BattleHUD.ts` (`teardownBattle` em `battleCleanupStep`) e `main.client.ts`, mantendo `src/server/` e `src/shared/` intactos e no-op silencioso na ausência de pastas VFX em `Assets/VFX` ou `<modelo>/VFX`.
- Validação em Play novo no Studio: `npx.cmd rbxtsc` (0 erros), `tools/vfx-controller-qa.luau` (`VFX_CONTROLLER_QA_PASSED`, 109 checks), `tools/battle-teardown-client-qa.luau` (`BATTLE_TEARDOWN_CLIENT_PASSED`, 538 checks), `tools/ora-return-client-qa.luau` (`ORA_RETURN_CLIENT_PASSED`, 105 checks), `BattleSimulator.runSimulation()` (`SIMULATION_ALL_PASSED`) e `git diff --check`.

## 2026-11-17 — Reescrita do `repo_map.md`, manutenção documental e `.gitignore`

- `docs/repo_map.md`: reescrito com a estrutura real do repositório (`server/Services`, `Components`, `Dev`, `client/Controllers`, `UI`, `shared` + `configs/`, `tools/`, entrypoints `NetworkBootstrap.server.ts` e `main.client.ts`), resumo por tema dos remotes reais de `Remotes.ts`, remoção de módulos inexistentes para a seção `FUTURO (não existe)` e correção de regras implementadas (`S3_UNLOCK_LEVEL = 5`, troca adiada em `ATTACK`, `Signal` em `BattleService`, PVP casual / NPC PVE existentes vs tiers/efeitos futuros).
- `docs/HANDOFF.md`: removida a pendência obsoleta sobre multi-hit após matar o ativo em `Pendências de design`, adicionado link para `CHANGELOG_ARCHIVE.md`, regravada em UTF-8 a seção `Multi-hit após KO (2026-11-16, provisório)` e atualizado `PLAYER_WALK_SPEED_MULTIPLIER` para `1,4×` (`1.4` mantido em `configs/Animation.ts` por decisão do autor, pendência removida).
- `docs/CHANGELOG_ARCHIVE.md` e `docs/CHANGELOG.md`: criado arquivo histórico anterior a `2026-11-14`, corrigido encoding UTF-8 das seções com `?` (`Cards de XP`, `XP no PVP`, `Multi-hit após morte do ativo`) e compactado o histórico a partir de `2026-11-14`.
- `.gitignore`: adicionado `.tmp/`. `git diff --check` aprovado (sem alterações de código).

## 2026-11-17 — Refatoração modular de `Config.ts` e atualização de docs

- `src/shared/Config.ts` dividido por domínio em `src/shared/configs/` (`AI.ts`, `Animation.ts`, `Combat.ts`, `Dev.ts`, `Economy.ts`, `Network.ts`, `Persistence.ts`, `Progression.ts`, `Pvp.ts`, `World.ts`) e re-exportado via `export * from` (pasta `configs/` no plural para evitar colisão case-insensitive com `Config` no Windows/Rojo).
- Constantes visuais de combate do client movidas para `src/client/UI/CombatVisualConfig.ts`, atualizando `CombatController.ts` (mantendo `MIN_DAMAGE` em `Config`) e os `require` de `tools/ora-return-client-qa.luau` e `tools/battle-teardown-client-qa.luau`. Removido `CRIT_DAMAGE_MULTIPLIER` (sem uso); demais constantes futuras/sem uso preservadas comentadas.
- Conferência documental: Crit `1.5%/pt`, troca por tempo Bronze `20–30s` e pesos da loja `60/30/10` alinhados.
- Validação: `npx.cmd rbxtsc` (0 erros), suíte completa no Studio até `SIMULATION_ALL_PASSED` com 2.000 lutas (dummy `49.7%` / `298.98275s`; Jotaro `68%` / `67.5943s`), `ORA_RETURN_CLIENT_PASSED` (105), `BATTLE_TEARDOWN_CLIENT_PASSED` (538), zero `MessageError` e `git diff --check`.

## 2026-11-17 — Animação de caminhada do jogador (`CharacterAnimationController`)

- `CharacterAnimationController.ts`: `Animate` nativo é o caminho principal (IDs e velocidade de `walk`/`run` observados por `ChildAdded`, sem duplicar track); fallback manual `Movement` roda apenas após timeout sem `Animate` (para em pulo/queda/ar, repouso ou `WalkSpeed <= 0` e é destruído por `Animate` tardio).
- Pré-carga assíncrona via `ContentProvider.PreloadAsync`, constantes em `Config`/`configs/Animation.ts` e limpeza por personagem (`CharacterRemoving`, `AncestryChanged`, `Died`).
- Validação: `npx.cmd rbxtsc` sem erros; validação visual completa no Studio pendente para a versão final.

## 2026-11-16 — Regra definitiva: cooldown NPC exclusivamente após vitória

- Decisão definitiva: sem teto diário Bronze; `NpcService` registra `NpcData.rematchCooldownSeconds` (`bronze_trainer = 300s`, faixa desejada 5–15 min) por jogador/`npcId` estritamente após vitória natural do jogador. Dano + Quit/desconexão, derrota, respawn, timeout e erro não geram cooldown.
- Estado em memória (limpo em `PlayerRemoving`; reentrada zera provisoriamente), aviso privado em `NpcBattleNotice` (`UITheme.Npc`) e botão do resultado apenas `FECHAR` (removido disparo de `/testbattle`).
- Validação: `npx.cmd rbxtsc`, `git diff --check`, `SIMULATION_ALL_PASSED` (`NPC_BATTLES_PASSED`, `NPC_REMATCH_COOLDOWN_PASSED`, 2.000 lutas sem mudança de balanço) e `BATTLE_TEARDOWN_CLIENT_PASSED` (538 checks).

## 2026-11-16 — Atualização de docs e Burn/Bleed fechado em 3s

- Decisão final do autor para Burn/Bleed fechada em **3s (3 ticks, 1/s)** em `HANDOFF.md`, `repo_map.md`, `CHANGELOG.md` e comentário de `Config`/`configs/Combat.ts`.
- Atualizadas em `HANDOFF.md` as pendências antigas de loja (`requestId`/`PurchaseResult`), UI de convite PVP (`PvpController`/`ChallengePromptController`), teste real PVP com dois clientes, item 4 (`DEV_AUTO_START_TEST_BATTLE = false` só no Studio) e seções de teardown em UTF-8; confirmados Crit `+1/pt` (`1.5%/pt`) e troca por tempo Bronze (`20–30s` em `IDLE`, respeitando `Root`).

## 2026-11-16 — Multi-hit após KO (provisório) e retorno absoluto do ORA ORA

- `BattleService` (regra provisória): ativo morto permanece até o fim de `ATTACK`; hits restantes não rolam Dodge/crit nem emitem `HitResolved`; `FighterDied` sai imediatamente (`nextActive` omitido quando adiado) e `SwitchPerformed` ocorre em `enterReturn` antes de `RETURN` (troca aleatória, `ATB = 0`, ignora `Root`, remove Burn/Bleed; último lutador encerra logo).
- `CombatController`: mantém KO no campo durante a sequência de hits; corrige drift acumulativo do Star Platinum (`pulseStandStrike`) fixando `baseC1` por clone, destinos absolutos, cancelamento do tween anterior e geração para invalidar recuos atrasados (`PLACEHOLDER_ORA_EXTRA_ADVANCE_STUDS`, `PLACEHOLDER_STAND_STRIKE_STUDS`, `COMBAT_POSITION_TOLERANCE_STUDS = 1e-4`). Restaura `homeCFrame` no teardown.
- Validação: `npx.cmd rbxtsc`, `git diff --check`, `SIMULATION_ALL_PASSED` (`MULTI_HIT_DEATH_PASSED`; dummy `49,7%` / `298,98275s`; Jotaro `68%` / `67,5943s`), `MULTI_HIT_CLIENT_QUEUE_PASSED`, `ORA_RETURN_CLIENT_PASSED` (105 checks em `tools/ora-return-client-qa.luau`) e `BATTLE_TEARDOWN_CLIENT_PASSED` (526 checks).

## 2026-11-16 — Teardown da batalha e liberação de sessão

- Diagnóstico e matriz por cenário em [BATTLE_TEARDOWN_DIAGNOSIS.md](BATTLE_TEARDOWN_DIAGNOSIS.md). `BattleHUD.teardownBattle()` + `battleCleanupStep` (`BattleCleanup.ts`) centralizam limpeza; resultado/cards separados em `BattleResult`; Quit confirmado oculta HUD imediatamente e suprime resultado local por padrão (`UITheme.ShowResultOnLocalQuit = false`).
- `CombatController` cancela tweens/tasks/markers/tracks e destrói `ClientBattleStage` imediatamente; servidor isola recompensa e envio de `BattleEnded` por participante conectado (`Parent === Players`), protegendo liberação de movimento/IA.
- Validação: `npx.cmd rbxtsc`, `git diff --check`, `SIMULATION_ALL_PASSED` (`BATTLE_TEARDOWN_LIFECYCLE_PASSED`: 14 caminhos), `BATTLE_TEARDOWN_CLIENT_PASSED` (526 checks em `tools/battle-teardown-client-qa.luau`) e `BATTLE_TEARDOWN_LIVE_PASSED` (9 cenários por RemoteEvents em `tools/battle-teardown-live-qa.luau`).

## 2026-11-16 — Teto diário de XP PVP, participação mínima no quit e schema v4

- Regras PVP em `BattleSessionService`, `PlayerDataService` e `configs/Pvp.ts`: `PVP_DAILY_XP_CAP = 2000` (independente do teto de Tinyes, corte determinístico nos slots 0/1/2, soma apenas XP útil, `limite_diario_xp` ao zerar) e `PVP_MIN_QUIT_DAMAGE_FRACTION = 0.25` + 3 hits mínimos em quit/desconexão (`luta_curta`, sem overkill).
- Schema `v3 → v4`: acrescenta `pvp.dailyXp = 0` validado como inteiro `[0, MAX_SAVED_NUMBER]`, zerado no mesmo `dayKey = floor(os.time()/86400)`.
- Validação: `npx.cmd rbxtsc`, `git diff --check`, `SIMULATION_ALL_PASSED` (`PVP_DAILY_XP_AND_MINIMUM_FIGHT_PASSED`, com DataStore em memória e participantes simulados).

## 2026-11-15 — Duelo PVP casual 1v1, UI PVP e schema v3

- `PvpService` + `PvpController` + `ChallengePromptController` + `UITheme.Pvp`: `ProximityPrompt` (`Desafiar`, 12 studs) no `HumanoidRootPart`, convite/aceite por `ChallengeReceived`/`RequestChallengeResponse`/`ChallengeStatus` (buckets 3/1s, 5s entre convites, 15s validade/recusa), sorteio interno de lados com `BattleStarted.sides[0]` local e ocultamento local do próprio prompt / durante `NpcBattleActive` (`RequiresLineOfSight = false` no client).
- `BattleMovement.ts` extraído e compartilhado entre NPC e PVP (`NpcBattleActive` mantido); `RewardMath.ts` (`calcAverageLevel`, `calcRewardBracket`); schema `v2 → v3` com `pvp` (2 vitórias pagas por par direcional em janela fixa de 3.600s, teto 2.000 Tinyes/dia, limite 200 pares ativos).
- Validação: `npx.cmd rbxtsc`, `git diff --check`, QA UI PVP (`79/79` checks), `PVP_BATTLES_PASSED`, `PVP_INVITES_AND_PERSISTENCE_PASSED` e `SIMULATION_ALL_PASSED` (dummy `48,4%` / `297,3764s`; Jotaro `80%` / `63,40455s`).

## 2026-11-15 — NPC PVE por ProximityPrompt e revalidação da suíte

- `NpcService`, `NpcData.ts`, `BattleTeamFactory.ts`, `BattleNpcController.ts`: adota tag `BattleNpc` e `Workspace.Npc_Luta`, configura `Style=Default`, `bronze_trainer` (Jotaro Lv1 + Anubis Lv2, seed `20261115`), distância 7 studs e debounce 1s; `DEV_AUTO_START_TEST_BATTLE = false` e `/testbattle`/auto-start restritos ao Studio; fix da IA Bronze para times com menos de 3 lutadores.
- Validação: `npx.cmd rbxtsc`, `git diff --check`, revalidação completa no Studio até `SIMULATION_ALL_PASSED` (`NPC_BATTLES_PASSED`, `SURGICAL_1..7` e 7 validadores adicionais sem marcador próprio).

## 2026-11-15 — Ciclo dia/noite em roblox-ts

- Reescrita de `docs/diaenoite.txt` em `src/shared/DayNightCycle.ts`, `src/server/Services/DayNightService.ts` e `src/client/Controllers/DayNightController.ts`: servidor publica atributos no `Workspace` (`InicioCicloSolar`, `DuracaoCiclo=1440`, `HoraInicial=8`, `Pausado=false`) e client interpola `Lighting`, efeitos por classe, `ColorGrading` e `Sky` no `Heartbeat`. `DAY_NIGHT_CYCLE_PASSED`.

## 2026-11-15 — Loja T8, resultados privados de compra/alocação e schema v2

- `ShopService`: 3 prateleiras determinísticas (Jotaro/Anubis, níveis 1/2/3 com pesos `60/30/10`, faixas Comum 150–250 / Rara 400–950 / Épica 1.500–4.000 / Lendária 6.000–14.000, janela 3.600s, bucket 3/1s, rollback em falha, `/shop`, `/buy`, `/addtinyes` no Studio); schema `v1 → v2` com `shopRestockCounts = [0, 0, 0]`.
- Contrato privado de compra e alocação: `RequestPurchase { offerId, requestId }`, `PurchaseResult { requestId, offerId, ok, reason? }` (`saldo | oferta_invalida | em_batalha | limite | erro`) e `InventoryState.allocationReason` (`sem_pontos | cap_nivel | par | invalido`).
- `ShopController` + `ShopPreview.ts` (`/testshop` no Studio): usa `requestId` + `PurchaseResult` com trava de 5s, abertura mútua com inventário e bloqueio em batalha.
- Validação: `npx.cmd rbxtsc`, `git diff --check`, `tools/shop-ui-qa.luau` (`SHOP_PURCHASE_RESULTS_AND_ALLOCATION_UI_PASSED`, `PURCHASE_RESULT_REMOTE_LISTENER_PASSED`), `PURCHASE_AND_ALLOCATION_RESULTS_PASSED`, `SHOP_SYNCHRONIZATION_PASSED`, `SHOP_PASSED`, `SIMULATION_ALL_PASSED` (persistência com DataStore mock).

## 2026-11-15 — Tela e contrato de inventário

- `InventoryService`, `InventoryController` e `InventoryState.ts`: `InventoryState` privado, `RequestSetTeam` (bucket dedicado), `/give jotaro|anubis` no Studio, UI responsiva com `effectiveStats`, alocação sem mutação otimista e tratamento de `unavailable`. `INVENTORY_REQUEST_PAYLOADS_AND_NO_OPTIMISTIC_MUTATION_PASSED`.

## 2026-11-14 — XP pós-batalha, cards de XP, trava S3 Lv5, Tinyes e rolls permanentes

- **Tinyes:** `TinyesService` + `TinyesDisplay` (`TINYES_WIN_BY_TIER` Bronze 50–150, Prata 150–250, Ouro 170–350; só Bronze ligado; `TINYES_MAX_ADD_PER_CALL = 1000`, `TINYES_ECONOMY_PASSED`).
- **Curva e divisão de XP:** `calcXpForNextLevel = 100 * nível` (teto útil `43.500` em `calcMaxUsefulXp`), pool `75 + 15 * nível médio inimigo` (só vitória PvE), divisão 100% / 50–50% / 50–25–25% (`0 > 1 > 2`), preservação de `unavailable`, validação de nível inimigo `[1, 30]` e endurecimento contra entradas inválidas/duplicadas (`XP_CURVE_AND_TEAM_DISTRIBUTION_PASSED`).
- **Integração XP e UI:** `BattleService.recordDamage` (incluindo DoT com `ActiveDotEffect.source`) + `BattleSessionService` chamando `awardPostBattleTeamXp` com `rewardPaid` único e `BattleEndedPayload.xpRewards?` (`POST_BATTLE_XP_PASSED`); `XpRewardCards.ts` com validação de ciclo de vida/modal destruído e `/testxp` (`XP_DEV_COUNTS_AND_DOUBLE_OPEN_PASSED`, `XP_X_DURING_ANIMATION_PASSED`, `XP_NEW_BATTLE_DURING_ANIMATION_PASSED`, `XP_DESTROYED_OR_MISSING_MODAL_PASSED`).
- **S3 Lv5 e rolls em `/testbattle`:** `S3_UNLOCK_LEVEL = 5` em `BattleService`, `AIService` e `BattleHUD` (`S3_UNLOCK_PASSED`, `S3_HUD_SWITCH_PASSED`); `/testbattle` e auto-start passando `activeTeam` e rolls salvos do inventário (`INVENTORY_TEST_BATTLES_PASSED`).

## 2026-11-14 — Endurecimento de persistência e rede (`PlayerDataService`, `RemoteService`, `BattleSessionService`, `BattleSide`)

- **Sessões, confirmação e backup (`PlayerDataService`):** token `sessionId` no `sessionLock`, confirmação recursiva do retorno de `UpdateAsync` em `lastPersistedData` (`SET_RETRY_SHUTDOWN_BUDGET_PASSED`, `PROGRESSION_SNAPSHOTS_PASSED`); backup atômico `C_<timestamp>_<GUID sem hífens>` antes de restauração, validação de arrays densos/limites/`unavailable`/`Duo` (`CORRUPTION_BACKUP_AND_INVENTORY_PASSED`); guarda de saída durante load (`REMOVED_DURING_LOAD`, `LEAVING_DURING_LOAD_PASSED`), descarte de lock com timestamp inválido no load normal (`LOAD_GUARDS_AND_INVALID_LOCK_PASSED`) e orçamento de retry de `SetAsync` no `BindToClose`.
- **Rede e combate (`RemoteService`, `BattleSessionService`, `BattleSide`):** token buckets (`10/10s` batalha, `5/2s` alocação), exigência de `Parent === Players` em `createSession`, `stepSession` isolado por `pcall`, restrição de `triggerSide*`/`attachSideAI` ao modo PVE e validação de índice em `BattleSide.trocar` (`SURGICAL_1..7`, `SIMULATION_ALL_PASSED`).
