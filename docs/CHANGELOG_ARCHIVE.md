# CHANGELOG ARCHIVE — Tiny Adventures (histórico anterior a 2026-11-14)

Resumo consolidado da base funcional inicial e da primeira correção cirúrgica de T7.2 antes de `2026-11-14`. Para alterações de `2026-11-14` em diante, consulte [CHANGELOG.md](CHANGELOG.md); para o estado operacional atual, consulte [HANDOFF.md](HANDOFF.md).

> **Nota de leitura:** alguns parâmetros da base inicial listada abaixo foram revisados depois (por exemplo: curva/divisão de XP pós-batalha em `2026-11-14`, Burn/Bleed fechado como decisão final em 3s em `2026-11-16` e troca adiada em multi-hit após KO em `2026-11-16`).

## Marcos base entregues (T1–T5, T7.1, T7.2)

1. **Simulador base:** 1.000 lutas 3v3 dummy (~50% winrate) validadas.
2. **Efeitos de lançamento:** `Burn`, `Bleed` e `Root` implementados e validados no núcleo e simulador.
3. **Controles de sessão:** `RequestPause` (somente PVE) e `RequestQuit` (remotes, regras e validação).
4. **T1 (`FighterData.ts` / `SkillData.ts`):** templates `jotaro` (`star_Finger`, `Barragem_estelar`, `Time Stop`) e `anubis` (`Boomerang`, `Possessão`, `Adaptação`), além de `BattleStarted` com `targetId`, `fighterId`, `hp`, `hpMax` e `slotCosts` (1.000 lutas Jotaro vs Anubis a 69,6% no marco original).
5. **T2 (`CombatController.ts` + rigs):** modelos em `ReplicatedStorage/Assets/Fighters` (`jotaro` com `Stand`/`StandJoint`; `anubis` com `Espada`/`SwordMotor` soldada ao `Handle`) e Attachments (`Peito`, `MaoDireita`, `MaoEsquerda`, `Cabeca`), validados em Playtest MCP.
6. **T3 (`UITheme.ts` + `BattleHUD.ts`):** HUD responsivo (`Scale` + `UIAspectRatioConstraint`) com ATB, marcas S1–S3, HP sincronizado com markers/hits, troca (Tag) com bloqueio de `Root` e `"X"` em KO, pause PVE, quit em 2 cliques e overlay de resultado.
7. **T4/T5 (`AIService.ts` Bronze + crítico):** IA Bronze por intenções (`1.5–3s`, Ultimate `2–4s`, 30% erro para S1, troca por HP `<25%` a 50% e troca por tempo `20–30s` em `IDLE`) e aplicação de `CRIT_MULTIPLIER = 1.5` via `applyCritMultiplier`.
8. **T7.1 (`ProgressionMath.ts`, `ProgressionService.ts`, `RequestAllocate`):** inventário com `itemUuid` permanente (`HttpService.GenerateGUID(false)`), rolls preservados, cap de stats por nível (`+2/nível`, `0` no Lv1, `58` no Lv30) e pares (`|ATK - Dodge| <= 5`, `|HP - Crit| <= 5`).
9. **T7.2 (`PlayerDataService.ts`):** persistência via `UpdateAsync` com schema versionado v1, migração por etapas, concessão atômica do starter (`jotaro`) somente para conta nova (`oldValue === undefined`), session lock (`120s`, `SESSION_LOCK_WAIT_ATTEMPTS`, `SESSION_LOCK_KICK_MESSAGE` / `SESSION_LOCK_LOST_KICK_MESSAGE`), reset de flags no topo dos callbacks, retry com backoff exponencial, backup `C_<timestamp>_<GUID>` e recuperação `RECOVERED_LAST_VALID`, autosave (`60s`), `PlayerRemoving` com retry em background (`LOGOUT_RETRY_MAX_BACKOFF_SECONDS = 30`), `BindToClose` (`25s`) e fallback em memória restrito ao Studio (`shouldTriggerStudioFallback`).

## Arquitetura inicial registrada (pré-2026-11-14)

- **Shared (`src/shared/`):** `Config.ts`, `ClassData.ts` (`doesClassCounter`, `getCounterMultiplier` ×1.175), `TypeDefs.ts`, `MathUtils.ts`, `ProgressionMath.ts`, `SkillData.ts`, `FighterData.ts`, `Remotes.ts`.
- **Server (`src/server/`):** `Components/` (`Fighter.ts`, `BattleSide.ts`), `Services/` (`ATBService.ts`, `DamageService.ts`, `AIService.ts`, `BattleService.ts`, `RemoteService.ts`, `ProgressionService.ts`, `PlayerDataService.ts`, `BattleSessionService.ts`), `NetworkBootstrap.server.ts`, `Dev/` (`DummyFighters.ts`, `DummyBattleSession.ts`, `BattleSimulator.ts`).
- **Client (`src/client/`):** `Controllers/` (`BattleRemotes.ts`, `CombatController.ts`, `BattleHUD.ts`), `UI/UITheme.ts`.
- **Validação MCP Studio registrada na base:** `ReplicatedStorage/Remotes`, rigs em `ReplicatedStorage/Assets/Fighters`, `Workspace/ClientBattleStage`, `Workspace/CombatBillboardPool`, 5 hits de `Barragem_estelar`, `"DODGE"`, KO/trocas e viewports mobile `667×375`, `844×390`, `800×480` e `1024×768` sem cortes/sobreposições.
- **Melhorias de baixa prioridade anotadas na base:** mover `Signal` de `BattleService.ts` para `src/shared/`, proteger `Signal.fire` com `pcall`, e definir eventual mínimo para `calcCuraAoE` (GDD sem mínimo). *(Nota: a pendência histórica da base sobre multi-hit após matar o ativo foi tratada em `2026-11-16`.)*

## Correção cirúrgica T7.2 — Fallback exclusivo no Studio e autosave isolado (pré-2026-11-14)

- **Arquivos alterados:** `src/server/Services/PlayerDataService.ts`, `src/server/Dev/BattleSimulator.ts`, `docs/HANDOFF.md`.
- **Fallback exclusivo no Studio:** `resolveInitialDataStore` e `activateMemoryFallback` passaram a verificar `RunService:IsStudio()`. Em servidor publicado, falha em `GetDataStore()` não ativa `fallbackStore`, retorna `NETWORK_ERROR` e expulsa sem criar conta nova; no Studio, emite `"FALLBACK EM MEMÓRIA: NADA PERSISTE ENTRE PLAYS"` em `print` e `warn`. `shouldTriggerStudioFallback` restrito a `"403"` ou `"studio"`.
- **Preservação de sessão ativa:** em `loadPlayer`, falha de rede ou erro inesperado quando já existe `existingSession` carregada preserva os dados em memória (`tinyes`, `level`, `allocatedStats`, `itemUuid`) sem expulsar nem sobrescrever.
- **Autosave isolado por jogador:** `autosaveAllPlayers` envolve cada jogador em `pcall` próprio; exceção limpa `session.saving = false`, marca `pendingRetrySave = true`, registra `userId` + `key` em `warn` e continua salvando os demais jogadores.
- **Validação:** `npx rbxtsc` com zero erros e `BattleSimulator.runSimulation()` retornou `SIMULATION_ALL_PASSED` (incluindo testes a–d de fallback/502/isolamento e 2.000 lutas). Limitações de DataStore real em produção (quotas/throttling, latência, contenção entre `JobId`s e `BindToClose` real até 30s) mantidas documentadas.
