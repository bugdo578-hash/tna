# Repo Map — Tiny Adventures (Mundo 1)

Roblox RPG ATB 1v1 com tag (até 3 bonecos/lado). `roblox-ts` + Rojo (`npm run watch` + `rojo serve`). Leia este arquivo primeiro; não escaneie o repo nem leia o GDD inteiro.
- **Regras:** edite só `src/` (nunca `out/` ou `node_modules/`); tabs, `readonly`, constantes em `src/shared/configs/*`, comentários em PT-BR; CLIENT = visual (nunca calcula dano); SERVER = gameplay autoritativo. Rode `npx.cmd rbxtsc` (0 erros) após alterar código.
- **Refs:** estado/pendências em [HANDOFF.md](HANDOFF.md), histórico em [CHANGELOG.md](CHANGELOG.md), GDD em [GDD.md](GDD.md) (só a seção necessária); MCP lê workspace/rigs/playtest/Output (não editar scripts via MCP).

## Estrutura real
- `src/server/NetworkBootstrap.server.ts`: entrypoint servidor; cria serviços, ciclo login/logout e comandos Studio (`/shop`, `/buy`, `/addtinyes`, `/give`, `/testbattle`).
- `src/client/main.client.ts`: entrypoint client; instancia e inicia controllers e UI na ordem de assinatura dos snapshots.
### Server (`src/server/`)
- `Services/AIService.ts`: IA Bronze PVE (reação, erro 30%, S3 bloqueado < Lv5, trocas por HP/tempo; só envia intenções).
- `Services/ATBService.ts`: avança barra ATB (`0–10`) em `IDLE` quando ativo está vivo e `NORMAL`.
- `Services/BattleMovement.ts`: congela/restaura `WalkSpeed`/`JumpPower`/`JumpHeight`/`UseJumpPower` e `NpcBattleActive` (NPC/PVP).
- `Services/BattleService.ts`: núcleo puro (`IDLE/PREPARE/ATTACK/RETURN`), hits, DoT/Root, troca adiada em KO (re-exporta `Signal` de `shared/Signal`).
- `Services/BattleSessionService.ts`: sessões isoladas por jogador, `Heartbeat`, pause/quit/timeouts e recompensas PVE/PVP.
- `Services/BattleTeamFactory.ts`: monta `BattleSide` a partir do inventário (`createPlayerInventorySide`) ou real (`makeRealFighter`).
- `Services/DamageService.ts`: rola Dodge/Crit por hit e aplica dano base, counter e `CRIT_MULTIPLIER`.
- `Services/DayNightService.ts`: publica âncora solar e atributos replicáveis do ciclo dia/noite no `Workspace`.
- `Services/InventoryService.ts`: monta snapshot privado `InventoryState` (`effectiveStats`, `s3Unlocked`, `unavailable`) e `setTeam`.
- `Services/NpcService.ts`: vincula `BattleNpc`/`Workspace.Npc_Luta`, `ProximityPrompt`, validações e cooldown pós-vitória em memória.
- `Services/PlayerDataService.ts`: persistência DataStore (`UpdateAsync`, schema `v4`, locks, backups, autosave, PVP/Tinyes/time; re-exporta `PlayerDataValidation`).
- `Services/PlayerDataValidation.ts`: validação pura de save/itens/stats/skills, migração de schema, clonagem profunda e `InMemoryDataStore`.
- `Services/ProgressionService.ts`: inventário clonado em memória, `addXp`, `awardPostBattleTeamXp` e `allocatePoints`.
- `Services/PvpService.ts`: `ProximityPrompt` de duelo no `HumanoidRootPart`, convites/expiração/buckets e início PVP.
- `Services/RemoteService.ts`: cria 26 `RemoteEvent`s em `ReplicatedStorage/Remotes`, valida payloads e aplica token buckets.
- `Services/ShopService.ts`: gera 3 ofertas determinísticas por janela/contador e processa compras com rollback.
- `Services/TinyesService.ts`: valida/delega saldo, gasto e contadores PVP para `PlayerDataService`.
- `Components/BattleSide.ts`: lineup de até 3 `Fighter`s, ATB único do lado, `trocar` (respeita `Root`) e substituição em morte.
- `Components/Fighter.ts`: estado do lutador em combate (`hp`, `localState`, `stats`, `slots`, `statusEffects`).
- `Dev/BattleSimulator.ts`: suíte de testes/simulação no Studio (`runSimulation`, 2.000 lutas e regressões).
- `Dev/DummyBattleSession.ts`: cria sessões dev (`createDummyBattleSession`, `createJotaroVsAnubisBattleSession`).
- `Dev/DummyFighters.ts`: cria times dummy/fixos dev (`createDummySide`, `createDevOpponentSide`) e re-exporta factory.
### Client (`src/client/`)
- `Controllers/BattleCleanup.ts`: helper `battleCleanupStep` (`pcall`/`warn`) para etapas independentes de teardown.
- `Controllers/BattleHUD.ts`: HUD de combate (ATB, HP, S1–S3/trava Lv5, Tag/Root, pause/quit), `BattleResult` e teardown.
- `Controllers/BattleNpcController.ts`: oculta prompts `BattleNpc` em batalha e exibe notificações de `NpcBattleNotice`.
- `Controllers/BattleRemotes.ts`: resolve e expõe referências dos remotes de batalha via `WaitForChild`.
- `Controllers/ChallengePromptController.ts`: oculta próprio prompt PVP e todos durante `NpcBattleActive` (`RequiresLineOfSight=false`).
- `Controllers/CharacterAnimationController.ts`: controla animação de caminhada via `Animate` nativo ou fallback `Movement`.
- `Controllers/CombatController.ts`: palco `Workspace/ClientBattleStage`, rigs, `AnimationTrack`/markers, tweens placeholder, popups e VFX.
- `Controllers/DayNightController.ts`: lê perfis no `MaterialService` e interpola `Lighting`/efeitos/`Sky` no `Heartbeat`.
- `Controllers/InventoryController.ts`: painel de inventário, seleção de `activeTeam` e alocação sem mutação otimista.
- `Controllers/PvpController.ts`: popup de convite PVP (`Aceitar`/`Recusar`) e banner de status do desafio.
- `Controllers/ShopController.ts`: painel da loja (3 prateleiras, `requestId`/`PurchaseResult`, preview `/testshop`).
- `Controllers/VFXController.ts`: runtime client do `Part_Icles` (`emit`, `preload`, `deload`, `clear`), orçamento por FPS/teto/qualidade, prioridade com teto duro para essenciais, culling só no mundo e varredura ativa sob demanda.
- `UI/CombatVisualConfig.ts`: constantes visuais de palco, placeholders, billboards e cores de combate no client.
- `UI/InventoryState.ts`: interfaces espelho do snapshot de inventário consumidas pelo `InventoryController`.
- `UI/ShopPreview.ts`: fixture visual estática para `/testshop` somente no Studio.
- `UI/TinyesDisplay.ts`: contador de saldo Tinyes no `PlayerGui` com animação `+N`.
- `UI/UITheme.ts`: tema centralizado (cores, fontes, layout, textos, política `ShowResultOnLocalQuit`).
- `UI/VFXConfig.ts`: constantes client-side de orçamento, prioridade, culling e pastas de VFX (`Part_Icles`).
- `UI/XpRewardCards.ts`: cards animados de XP pós-batalha em `BattleResult` com guarda de ciclo de vida.
- `types/Part_Icles.d.ts`: declaração TypeScript do módulo externo `ReplicatedStorage.Part_Icles`.
### Shared (`src/shared/`, além do template não usado `module.ts`) & `tools/`
- `Config.ts`: re-exporta os 10 módulos de `configs/` (`AI`, `Animation`, `Combat`, `Dev`, `Economy`, `Network`, `Persistence`, `Progression`, `Pvp`, `World`).
- `ClassData.ts`: ranges de `baseStats` das 5 classes e triângulo de counter (`×1.175`).
- `FighterData.ts`: catálogo `FIGHTER_DATA` (`jotaro`, `anubis`) e `rollClassBaseStats`.
- `SkillData.ts`: timelines provisórias de skills (`JOTARO_SKILL_DATA`, `ANUBIS_SKILL_DATA`).
- `NpcData.ts`: definições PVE (`bronze_trainer`: Jotaro Lv1 + Anubis Lv2, seed `20261115`, `rematchCooldownSeconds = 300`).
- `TypeDefs.ts`: tipos compartilhados (`ClassName`, `Rarity`, estados, `FighterInventoryItem`, `PlayerSaveData`, `DuoState`).
- `MathUtils.ts`: fórmulas puras de custo, mult, dano, cura, counter, crit, preço e alocação (`BuffMulti`/`WeakMulti` sem uso).
- `ProgressionMath.ts`: fórmulas puras de nível, pontos, curva XP, pool/divisão pós-batalha e `calcEffectiveStats`.
- `RewardMath.ts`: `calcAverageLevel` (só presentes) e `calcRewardBracket` (Bronze/Prata/Ouro).
- `DayNightCycle.ts`: funções puras e `DayNightCycleApplier` para ciclo solar e interpolação Gamma 2.0.
- `Remotes.ts`: `REMOTE_NAMES` e tipos de payloads; `RemoteService` também cria `InventoryState` e `RequestSetTeam`.
- `Signal.ts`: classe `Signal<T>` (`fire` sem `pcall`, re-exportada por `BattleService.ts`).
- `tools/`: QAs Luau para Client/Server no Studio (`vfx-controller-qa`, `ora-return-client-qa`, `battle-teardown-*-qa`, `shop-ui-qa`) e `compress-log.py`.

## Remotes (`src/shared/Remotes.ts` → `ReplicatedStorage/Remotes`)
- **Combate & Sessão (15):** ações (`RequestSkill/Switch/Pause/Quit`), ciclo/ATB (`BattleStarted`, `StateChanged`, `AtbSync`, `FighterDied`, `BattleEnded`) e timeline/efeitos (`AttackStarted`, `HitResolved`, `SwitchPerformed`, `Effect*`).
- **PVP & NPC (4):** convite/status de duelo (`Challenge*`, `RequestChallengeResponse`) e avisos/cooldown NPC (`NpcBattleNotice`).
- **Loja, Tinyes & Inventário (7):** compras/ofertas (`RequestPurchase`, `PurchaseResult`, `ShopState`), saldo (`TinyesChanged`) e alocação/time (`RequestAllocate`, além de `InventoryState` e `RequestSetTeam` criados em `RemoteService`).

## Estados, ATB e morte
- `IDLE → PREPARE → ATTACK → RETURN → IDLE`; ação/troca grátis só em `IDLE`; `PREPARE`/`ATTACK`/`RETURN` pausam ATB.
- Barra ATB `0–10` por lado (`BASE_ATB_SPEED = 0.588`, runtime `fighter.currentAtbSpeed`). Troca mantém ATB; morte zera.
- `CAÍDO` pausa ATB e DoT; `CARREGANDO` pausa ATB e não congela DoT.
- **Morte em `ATTACK`:** troca automática aleatória fica adiada até o fim de `ATTACK` (antes de `RETURN`), ignorando hits restantes (provisório); fora de `ATTACK`, troca imediata. Ignora `Root`, zera ATB e remove `Burn`/`Bleed`; derrota quando todos caem.

## Fórmulas
- Roll `t` (`0–1`) por slot na oferta define custo e mult juntos (permanente no `itemUuid`): `custo = lerp(min, max, t)`; S1 `0.75–3.0`, S2 `4.0–7.0`, S3 `8.0–10.0`.
- `mult = D_slot * (custo / BASE_ATB_SPEED)` (`D_slot`: S1 `0.2145`, S2 `0.1373`, S3 `0.1825`).
- `levelScale = 0.5 + ((level - 1) / 29) * 0.5`; `dano = round(ATK_final * mult * levelScale)`; counter `×1.175` (`COUNTER_DAMAGE_MULTIPLIER`); animação nunca entra no dano; mínimo `1`.
- Cura (funções puras): `ATK_cura = base + alocado + chips` (sem buffs/levelScale); `cura = round(min(ATK_cura * healMult, HP_MAX * capHP))` (S1 `0.55/20%`, S2 `1.10/30%`, S3 `1.40/45%`); AoE `round(curaSingle / aliadosVivos)`.
- Bleed `25%` / Burn `20%` do dano REAL conectado (`3 ticks`, `1/s`, `3s` — decisão final fechada pelo autor); renovam, não empilham; tick `< 1` acumula, último tick garante `≥ 1`, nunca emite `"0"`. `Root`: `5/8/12s` (S1/S2/S3), bloqueia só troca voluntária.
- Dodge/Crit: server rola por hit no tempo da timeline e envia `HitResolved`; hit único esquivado cancela follow-up (`dodgeReturnTime`); multi-hit não cancela próximos hits. Dodge `1%/pt`, Crit `1.5%/pt` (`CRIT_MULTIPLIER = 1.5`, mínimo `1`).

## Classes, progressão e economia
- **Classes (`ClassData.ts`):** triângulo `Fury → Menace → Dominator → Fury`; Support/Controller sem counter. Base (`hp/atk/dodge/crit`, roll separado dos skills): Fury `13–17/8–12/5–8/8–12`; Support `8–15/4–7/8–14/3–6`; Controller `16–20/6–10/5–8/5–8`; Dominator `14–18/7–11/3–6/6–10`; Menace `12–16/9–13/4–7/7–11`.
- **Progressão:** Lv `1–30`; `+2` pts/nível (`0` no Lv1, `58` no Lv30); HP `+12.5/pt`, ATK `+1/pt`, Dodge `+1/pt` (`1%`), Crit `+1/pt` (`1.5%`); cap = nível; pares `|ATK−Dodge| ≤ 5` e `|HP−Crit| ≤ 5`. **S3 bloqueado até Lv5 (`S3_UNLOCK_LEVEL = 5`)** — regra implementada.
- **XP pós-batalha:** só vitória PVE; pool `75 + 15 * nível médio inimigo` (inválido/fora de `1–30` = `0`); divisão válida `1=100%`, `2=50%/50%`, `3=50%` maior `damageDealt`/`25%/25%` (empate menor slot; inválidos/duplicados ignorados) → multiplicador por `diff = nível − média` (`≤-3: 1.35`, `≤-1: 1.15`, `≤1: 1`, `≤3: 0.60`, `≤5: 0.25`, `>5: 0.05`) → `max(1, floor(raw))`; curva `100 * nível` (teto útil `43.500`).
- **PVE/NPC, PVP e Loja:** `TINYES_WIN_BY_TIER` Bronze `50–150` (PVE ativo), Prata `150–250`, Ouro `170–350` (usados por `RewardMath` no PVP; `TINYES_MAX_ADD_PER_CALL = 1000`). **NPC PVE:** sem teto diário Bronze; cooldown `300s` em memória contado estritamente após vitória natural. **PVP casual:** existe (`PvpService`/`PvpController`), paga Tinyes + XP pela média do perdedor (fator `1`, `≥ 3` hits, quit/desconexão `≥ 25%` HP inicial, 2/par/3600s, tetos diários `2000` Tinyes e `2000` XP em schema `v4`). **Loja:** 3 prateleiras (`60/30/10%`), `shopRestockCounts` no DataStore, `requestId`/`PurchaseResult`. **IA Bronze:** reação `1.5–3s`, Ultimate `2–4s`, erro `30%`, troca HP `<25%` (`50%`) e tempo `20–30s` em `IDLE`.
- **IDs & Anti-exploit:** `fighterId` (template), `offerId` (temporário), `itemUuid` (permanente). Server valida tudo e envia só dados da própria batalha; token buckets `10/10s` (batalha), `5/2s` (alocação/time), `3/1s` (loja e resposta PVP).

## FUTURO (não existe)
- **Funções puras/constantes sem uso em combate (FUTURO):** `CARREGANDO` (`CHARGE_DAMAGE_MULTIPLIER = 1.5`), dupla `Bruford/Tarkus` (`DuoState`/`DUO_*`), `BuffMulti`/`WeakMulti` (`MathUtils`: `capFinal * min(aplicações, 4) / 4`) e `Time Stop` real (Jotaro S3 é 1 hit provisório).
- **Não existem no código:** `Hamon`, `Block`, `Stun`, `Silence`, `Weaken`, `Clean`, `Vulnerabilidade`, `Resistência`, `Freeze`, chips equipáveis, reorganizar skills, soft counter Support/Controller, tiers/NPCs `Rival`/`Prata`/`Ouro`/`Boss`, `Torneio`, `Crate`, `Arena`/`ServerStorage/Arenas`, `Tag`, `Input`, `Camera`, `Cutscene`, `Sound`, `ShopData`, `AIBrain` e `Components/Skill`.
