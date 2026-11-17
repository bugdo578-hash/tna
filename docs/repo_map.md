# Repo Map — Tiny Adventures (Mundo 1)

Roblox RPG ATB 1v1 com tag (3 bonecos por lado). roblox-ts + Rojo.
Leia este arquivo primeiro. Não escaneie o projeto. Não leia o GDD inteiro.

## Regras para o agente
- Edite só `src/`. Nunca `out/` nem `node_modules/`.
- Leia só os arquivos necessários.
- Mudanças pequenas. Sem refatorar sem pedir.
- CLIENT = visual. SERVER = gameplay (dano, ATB, hit/dodge, compra, troca).
- Client nunca calcula dano.
- Itens marcados FUTURO: não implementar.
- Dúvida de regra: pergunte. Não invente número.

## Stack
- TS → Luau. Rojo sync. `npm run watch` + `rojo serve`.

## Estrutura (confirme caminhos reais)
- `src/server/`: Services (Arena, Battle, ATB, Damage, Tag, AI, PlayerData, NPC, Shop, Crate), Components (Fighter, Skill, Arena, AIBrain)
- `src/client/`: Controllers (Input, BattleHUD, Camera, VFX, Cutscene, Sound, Crate), `UI/CombatVisualConfig` (constantes visuais de combate)
- `src/shared/`: FighterData, SkillData, ClassData, TypeDefs, ShopData, Signal, Config (`configs/`: AI, Animation, Combat, Dev, Economy, Network, Persistence, Progression, Pvp, World), MathUtils
- Remotes: Battle, ATB, Tag, VFX, Skill, Shop, Crate
- Arenas: ServerStorage/Arenas (npc, pvp, boss), clonadas por batalha, destruídas ao fim
- Init: `init.server` / `init.client` (ordem Init → Start)

## Estados de batalha
- IDLE → PREPARE → ATTACK → RETURN → IDLE
- Ação e troca só em IDLE. Troca grátis.
- PREPARE/ATTACK/RETURN pausam ATB dos dois lados.
- CARREGANDO: pausa só ATB do caster (dano ×1.5).
- CAÍDO: pausa só ATB de quem caiu.
- Morte: troca automática aleatória, ATB do novo = 0.
- Derrota: todos os selecionados mortos.

## ATB
- Uma barra por lado, range 0–10.
- `BASE_ATB_SPEED = 0.588` (constante, só calibração de dano).
- `fighter.currentAtbSpeed` (variável de runtime) enche a barra.
- Troca mantém ATB. Morte zera.

## Fórmulas
- Roll `t` (0–1) por slot, na oferta. Define custo E mult juntos. Permanente no `itemUuid`.
- `custo = lerp(custoMin, custoMax, t)`
- Custos: S1 0.75–3.0 | S2 4.0–7.0 | S3 8.0–10.0
- `mult = D_slot * (custo / BASE_ATB_SPEED)`
- `D_slot`: S1 0.2145 | S2 0.1373 | S3 0.1825
- `levelScale = 0.5 + ((level - 1) / 29) * 0.5`
- `dano = round(ATK_final * mult * levelScale)`
- Animação nunca entra na fórmula de dano.
- Counter de classe: ×1.175 (`COUNTER_DAMAGE_MULTIPLIER`).
- Cura: `ATK_cura = base + alocado + chips` (sem buffs, sem levelScale)
  - `cura = round(min(ATK_cura * healMult, HP_MAX * capHP))`
  - healMult: S1 0.55 | S2 1.10 | S3 1.40
  - capHP: S1 20% | S2 30% | S3 45%
  - AoE: `curaSingle / aliadosVivos`
- Hamon: ×1.30 / 1.8 / 2.20 por slot. 3 cargas. Multi-hit gasta 2.
- BuffMulti: `capFinal * min(aplicações,4) / 4`; `dano += dano * BuffMulti`
- WeakMulti: `dano *= (1 - capFinal * min(aplicações,4)/4)`; mínimo 1 de dano
- Bleed 25% / Burn 20% do dano REAL. 3 ticks, 1/s (3s — decisão final fechada pelo autor). Renovam, não empilham.
  Tick < 1: acumula; último tick garante ≥ 1. Nunca mostrar "0".

## Dodge e hit
- Server rola Dodge ANTES da animação, por hit e por alvo.
- Envia `{ hit, damage, target }`. Client só toca animação.
- Projétil/delay: roll no impacto real.
- Dodge: 1 ponto = 1%. Crit: 1 ponto = 1.5%.

## Classes (`ClassData.ts`)
- Triângulo: Fury → Menace → Dominator → Fury.
- Support/Controller: soft counter FUTURO.
- Ranges base (hp / atk / dodge / crit):
  - Fury 13–17 / 8–12 / 5–8 / 8–12
  - Support 8–15 / 4–7 / 8–14 / 3–6
  - Controller 16–20 / 6–10 / 5–8 / 5–8
  - Dominator 14–18 / 7–11 / 3–6 / 6–10
  - Menace 12–16 / 9–13 / 4–7 / 7–11
- Roll de baseStats é separado do roll de custo/mult.

## Progressão
- Lv máx 30. Lv1 sem pontos. +2 pontos/nível (58 no Lv30).
- HP +12.5/ponto. ATK +1/ponto, Dodge +1/ponto (1%/pt), Crit +1/ponto (1.5%/pt).
- Cap por stat = nível atual.
- Pares: |ATK−Dodge| ≤ 5 e |HP−Crit| ≤ 5.
- S3 desbloqueia no Lv5 (decisão em aberto).
- XP pós-batalha só em vitória PvE: pool `75 + 15 * nível médio inimigo`, sem teto no pool; nível médio não finito ou fora de `[MIN_LEVEL, MAX_LEVEL]` (1–30) gera 0 XP.
- Divisão entre lutadores válidos: 1 = 100%; 2 = 50%/50%; 3 = 50% ao maior `damageDealt` e 25%/25% aos demais. Empate favorece o menor índice de slot; dano inválido vale 0. Slots vazios, inválidos ou UUIDs duplicados são ignorados pelo serviço antes da divisão.
- Ordem: fração do pool → multiplicador individual por `diff = nível do lutador - nível médio inimigo` → `max(1, floor(rawXp))` se positivo → teto útil derivado de `sum(calcXpForNextLevel(1..29))`. Multiplicadores: diff ≤ -3: 1.35; ≤ -1: 1.15; ≤ 1: 1; ≤ 3: 0.60; ≤ 5: 0.25; acima: 0.05.
- Curva: `100 * nível` para subir; teto útil total 43.500 XP. `addXp`/`resolveXpAndLevelUp` limitam XP útil e resolvem múltiplos níveis, zerando o residual no Lv30.

## Economia de Tinyes (valores provisórios, decisão do autor em 2026-11-14)
- `TINYES_WIN_BY_TIER`: Bronze 50–150, Prata 150–250, Ouro 170–350. Só Bronze está ligado; substitui o antigo 55–150.
- `TINYES_MAX_ADD_PER_CALL = 1000`; gasto não usa esse teto: inteiro positivo, até `MAX_SAVED_NUMBER` e limitado pelo saldo.
- Saldo único em PlayerDataService; TinyesService valida/delega, sem save próprio. Autosave e saída persistem.
- Vitória natural PVE contra IA paga uma vez; derrota, Quit, desconexão, timeout, erro e jogador fora de Players não pagam.
- `TinyesChanged { balance }` e `BattleEnded.tinyesReward?` são enviados só ao respectivo jogador.
- Decisão definitiva do autor (2026-11-16): não haverá teto diário de recompensa Bronze. Reenfrentar usa `NpcData.rematchCooldownSeconds` por jogador/npcId, contado ESTRITAMENTE do fim de uma vitória natural do jogador. Dar dano e sair, derrota, Quit, desconexão, respawn, timeout e erro NÃO geram cooldown. `bronze_trainer = 300s` provisório (faixa desejada: 5–15 min). Somente em memória: saída limpa e reentrada zera; sem schema novo. Recusa no Triggered sem sessão, aviso privado em NpcBattleNotice e texto em UITheme.Npc. Botão do resultado apenas fecha; não inicia `/testbattle` nem contorna o prompt.
- Loja: 3 prateleiras; pesos de nível 1/2/3 = `60%/30%/10%` (`SHOP_LEVEL_WEIGHTS`).
- TODO: PVP casual paga vitória, valor pendente; Rival paga mais que Ouro, valor pendente. Não implementar nesta etapa.

## IA Bronze
- Reação normal `1.5–3.0s`, Ultimate `2.0–4.0s`, erro `30%` (força S1), troca por HP `<25%` (`50%` de chance) e troca por tempo `20–30s` acumulados em `IDLE` (respeitando `Root`).

## IDs
- `fighterId`: template. `offerId`: oferta temporária. `itemUuid`: boneco permanente.
- ShopState em memória. Inventário no DataStore.
- Estoque da loja é pessoal por client.

## Dupla Bruford + Tarkus
- 1 slot, HP separado. Ativo 100% do dano, parceiro 34%.
- Sobrevivente: HP_MAX vira 1/3, +10% dano.
- Conta como 1 morte só quando os dois caírem.

## Time Stop (DIO Pt3, Jotaro)
- Conjura 2×. ATB do dono a 75% da velocidade base. Máx 2 ações.
- Ações dentro ignoram Dodge. Escudo ainda bloqueia o 1º hit.

## Efeitos no lançamento
- Só Burn, Bleed e Root.
- FUTURO: Block, Stun, Silence, Weaken, Clean, Vulnerabilidade, Resistência, Freeze, chips equipáveis, reorganizar skills, Torneio.

## Anti-exploit
- Rate limit 10 req/s.
- Server valida: ATB, estado, custo, alvo, dano, troca, morte, compra.
- Server só manda dados da SUA batalha.

## Convenções
- Tabs. `readonly`. Constantes nomeadas. Comentários em português.

## Arquivos de referência
- GDD completo: `docs/GDD.md` (grande — leia só a seção necessária).

principal:
- Scripts: só em src/ (Rojo). Não criar nem editar script pelo MCP.
- MCP: ler workspace, conferir rigs/Attachments, rodar playtest, ler Output.
