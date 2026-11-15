# ROADMAP — Tiny Adventures
Dois ajustes rápidos que vale notar antes de rodar a T1:T4 já está pronta: No HANDOFF.md, RequestPause e RequestQuit já foram implementados e validados no simulador, então você pode pular direto da T3 para a T5 (só confirme se o BattleStarted manda a flag canPause pro HUD usar na T3).   Alinhamento de payloads na T1/T2: Garanta que o BattleStarted mande a lista de lutadores com targetId, fighterId, hp e hpMax (como você anotou no topo) para que a T2 consiga mapear targetId → modelo sem precisar adivinhar.   
Leia antes: `CLAUDE.md`, `docs/repo_map.md`, `docs/HANDOFF.md`.
Uma tarefa por vez. `/clear` entre tarefas. Ao fim de cada uma: atualizar `docs/HANDOFF.md`, rodar `npx rbxtsc` (zero erros), commit.

## Regras fixas
- Scripts só em `src/` (Rojo). NUNCA criar ou editar script pelo MCP.
- MCP (se disponível): ler workspace, conferir rigs/Attachments, rodar playtest, ler Output, ajustar Instances/assets. Comece em modo somente leitura. Peça só o necessário (token).
- Server decide gameplay. Client só apresenta.
- Sem número mágico. Constantes em `Config.ts`. Valor provisório: marcar "provisório".
- Item marcado FUTURO no repo_map: não implementar.
- Dúvida de regra: perguntar ao autor. Não inventar.
- Não reescrever arquivo validado. Só mude o que foi pedido.

## Esforço sugerido
- Baixo: ajuste pequeno, atualizar docs.
- Médio: padrão (a maioria das tarefas).
- Máximo: arquitetura nova, bug difícil, revisão de segurança.

---

## STATUS
- [x] Shared base (Config, ClassData, TypeDefs, MathUtils, SkillData, Remotes)
- [x] Núcleo: ATB, estados, dano, Dodge, crit, timeline por skill
- [x] Efeitos: Burn, Bleed, Root (DoT/Root só correm em IDLE; persistem no banco)
- [x] Rede: remotes, sessões, rate limit, timeouts, SwitchPerformed, EffectApplied/Tick/Expired
- [x] Simulador 3v3 validado (1000 lutas, sem assert)
- [ ] Tarefas abaixo, em ordem

---

## T1 — Jotaro e Anubis (dados reais) · esforço médio
```
Crie os dois primeiros lutadores reais. Leia docs/repo_map.md e docs/HANDOFF.md.

Arquivos: src/shared/FighterData.ts (fighterId, nome, classe, raridade, skills).
Skills em src/shared/SkillData.ts, formato de timeline existente.

Jotaro (fighterId "jotaro", Fury, Lendária):
- S1 Dedinhos: 1 hit. Só dano (cegueira é FUTURO).
- S2 ORA ORA: 5 hits, damageShare igual (soma 1). Sem Stun.
- S3 Time Stop: 1 hit forte. Time Stop real é FUTURO. Comentar "provisório".

Anubis (fighterId "anubis", Menace, Épica):
- S1 Boomerang: 1 hit.
- S2 Possessão: 1 hit no alvo. Dano espalhado é FUTURO.
- S3 Adaptação: 1 hit provisório. Modo de Adaptação é FUTURO.

Timelines provisórias (prepareTime, hit.time, returnTime, dodgeReturnTime).
Comentar "tempos provisórios; trocar pelos markers da animação".

Regras:
- Stats base vêm do roll da classe (ClassData). Não inventar stats.
- Custo e mult: calcSkillSlotRoll.
- Só Burn/Bleed/Root como efeitos.
- BattleStarted deve mandar por lutador: targetId, fighterId, hp, hpMax.
- Função de teste que monta times com esses dois.

Valide no simulador: Jotaro vs Anubis, 1000 lutas. Mostre winrate e duração média.
Jotaro deve ganhar mais (counter ×1.175).
Assert extra: troca automática por morte ignora Root.
Rode npx rbxtsc. Zero erros.
```
Aceite: compila, simulador sem assert, Jotaro > 50%.

## T2 — CombatController (client) · esforço médio
Pré-requisito no Studio (autor): rigs de Jotaro e Anubis (Humanoid padrão) com Attachments `Peito`, `MaoDireita`, `MaoEsquerda`, `Cabeca`. Conferir via MCP (leitura).
```
Crie o controller de combate no client. Leia docs/HANDOFF.md, src/shared/Remotes.ts e src/client/Controllers/BattleRemotes.ts.

Regras:
- Client só apresenta. Nunca calcula dano, hit, crit ou Dodge.
- Sem números mágicos (Config).

Arquivo: src/client/Controllers/CombatController.ts

1. Mapa targetId → modelo (a partir de BattleStarted).
2. Fila de resultados por hitIndex. Guarda cada HitResolved até o marker correspondente.
3. AttackStarted: toca a animação do slot. Marker HitN consome o resultado N.
   Resultado atrasado: espera até HIT_RESULT_WAIT_SECONDS (Config); depois mostra pelo tempo do SkillData.
4. Ao consumir:
   - hit: número de dano (pool de BillboardGui), HP visual desce, animação de dano no alvo.
   - crit: número maior e outra cor.
   - miss: esquiva no alvo + "DODGE". Sem número.
   - followUpCancelled: pula o follow-up, vai ao retorno curto.
5. EffectApplied liga VFX, EffectTick mostra número pequeno (nunca 0), EffectExpired desliga.
6. FighterDied: KO depois do último hit pendente.
7. SwitchPerformed: animação de tag.
8. BattleEnded: resultado. Não espera RETURN nem IDLE.
9. Sem AnimationTrack (placeholder): dispara os hits pelos tempos do SkillData.

Placeholder: Tween em Motor6D (avanço, soco, recuo) ou movimento do modelo.
VFX: um BillboardGui e uma partícula simples. VFX real é do autor, no Studio.
Sem HUD, câmera ou loja.
Rode npx rbxtsc. Zero erros.
```
Aceite (Studio): Jotaro vs Anubis, número aparece no momento certo; Dodge mostra "DODGE" sem número; ORA ORA mostra 5 números.

## T3 — HUD básico · esforço médio
```
Crie o HUD de batalha no client. Leia docs/HANDOFF.md, Remotes.ts e CombatController.

Arquivos: src/client/UI/UITheme.ts (cores, fontes, tamanhos; tudo aqui) e src/client/Controllers/BattleHUD.ts

1. Barra ATB de cada lado (0–10), atualiza com AtbSync. Marcas nos custos dos slots.
2. Barra de HP do ativo de cada lado, com número.
3. Três botões de skill: mostram custo; habilitados só em IDLE e ATB >= custo; clique envia RequestSkill { slot }.
4. Caixinha de troca com os 3 bonecos: clique envia RequestSwitch { index }. Mortos cinza com X. Root mostra cadeado.
5. Tela VICTORY / DEFEAT (Tinyes placeholder).
6. Botões Pause (só PVE) e Quit: RequestPause / RequestQuit.

Regras: client só mostra; responsivo (Scale, UIAspectRatioConstraint); botões grandes para celular; texto pelo UITheme.
Sem câmera, loja ou inventário.
Rode npx rbxtsc. Zero erros.
```
Aceite: testar no emulador de celular do Studio.

## T4 — Pause e Quit (server) · esforço médio
```
Implemente a lógica de RequestPause e RequestQuit no server. Leia docs/HANDOFF.md e BattleSessionService.

- RequestPause: só em sessão PVE. PVP ignora em silêncio. Alterna paused.
  Pausado: loop pula step(dt); timeouts congelam.
- Limite PVE_PAUSE_MAX_SECONDS = 120 (Config), acumulado por luta. Ao estourar, o pause se desfaz.
- RequestQuit: encerra a sessão. Quem saiu perde. BattleEnded com o outro lado vencedor. PVE: sem recompensa.
- Desconexão conta como Quit.
- Vale em qualquer estado, inclusive ATTACK.
- Limpa eventos e referências ao encerrar.
Teste no simulador: pause não altera ATB nem timers; quit termina com o vencedor certo.
Rode npx rbxtsc. Zero erros.
```

## T5 — MARCO: luta jogável (você vs IA simples) · esforço médio
```
Crie IA simples (Bronze) para PVE. Leia docs/repo_map.md (seção IA) e HANDOFF.md.
Bronze: delay 1.5–3.0s, skill aleatória, erro 30%, troca só morrendo (50%).
Usa o mesmo requestSkill/requestSwitch do núcleo. Sem atalhos.
Arquivo: src/server/Services/AIService.ts. Aleatoriedade por rng injetável.
Sessão PVE dev: jogador vs IA com Jotaro e Anubis.
Rode npx rbxtsc. Zero erros.
```
Aceite: jogar uma luta completa no Studio. Avaliar o feeling antes de continuar. Ajustar números em playtest.

## T6 — Efeitos de combate restantes · esforço médio (um por prompt)
Ordem: cura (single/AoE/autocura) → BuffMulti → WeakMulti → Hamon (3 cargas) → Escudo → casting (CARREGANDO ×1.5) → CAIDO.
Cada um: regra do repo_map, eventos para o client, assert no simulador, aceite no Studio.

## T7 — Progressão e dados · esforço médio/máximo (DataStore)
XP e level up, distribuição de pontos (cap = nível; pares ≤ 5), inventário com itemUuid, PlayerDataService (DataStore com retry e proteção), persistência de baseStats/custos/mult por itemUuid.

## T8 — Loja e economia · esforço máximo (compra e Robux)
Estoque pessoal por client, roll de baseStats e skills na oferta (offerId × itemUuid), compra validada no server (Tinyes e Robux), Caixas de Sorte (5/dia), preços do GDD.

## T9 — Mundo e fluxo · esforço médio
Cidade, NPCs com patrulha, diálogo [E], menu de seleção, Ready Check PVP (240s), arena invisível (alocador), tutorial.

## T10 — Câmera, cutscene e VFX · esforço médio
Split, ataque fullscreen, orbit na vitória, cutscene de entrada, DoF, números de dano. VFX real é do autor.

## T11 — IA Prata/Ouro, Rival, Boss, PVP com elo · esforço máximo
Fila automática por elo, desafio manual, IA com score, Rival adaptativo.

## T12 — Kits dos 19 bonecos · esforço médio (um boneco por prompt)
Um boneco por vez, só com efeitos já implementados. Efeito futuro: simplificar ou adiar (perguntar ao autor).

---

## Decisões pendentes do autor (perguntar, não inventar)
- Cadência final de Burn/Bleed (3s vs 9s).
- S3 só no Lv5: o que acontece no Lv1–4?
- Kits que usam efeitos futuros (Stun, Vulnerabilidade, Clean).
- Dupla Bruford/Tarkus: custo e slot de Alternar.
- Pesos da Caixa de Sorte.
- Crítico ×1.5 e timeouts: provisórios.

## Feito só no Studio (autor)
Rigs, animações e markers (`Hit1..N`, `FollowUp`, `End`), VFX, UI final, arena, sons.
Markers só disparam visual. Tempo do marker = tempo no SkillData.

## Fim de cada tarefa (checklist)
- [ ] `npx rbxtsc` sem erro
- [ ] Simulador sem assert (se mexeu no núcleo)
- [ ] Testado no Studio (F5) quando for client
- [ ] `docs/HANDOFF.md` atualizado
- [ ] Commit
