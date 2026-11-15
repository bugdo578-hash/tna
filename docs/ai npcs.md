## 🧠 Sistema de AI — 3 Níveis de Dificuldade

---

### Visão Geral

```
⭐ BRONZE
   "Iniciante burro"
   → Reage devagar
   → Troca aleatória
   → Não analisa nada
   → Player aprende o sistema tranquilo
entre 50-150 moedas

⭐⭐ PRATA
   "Jogador mediano"
   → Reage no tempo certo
   → Pressiona quando pode
   → Começa a ler o player
   → Player precisa pensar
entre 150-250 moedas

⭐⭐⭐ OURO
   "Veterano adaptativo"
   → Reage rápido e otimizado
   → Prevê trocas e skills
   → Counter-pick de classes
   → Adapta estratégia em tempo real
   → Player precisa ser muito bom
entre 170-350 moedas


```

---

### ⭐ AI BRONZE — "O Iniciante"

```
FILOSOFIA: O NPC é burro de propósito.
Serve pra ensinar o sistema ao player sem frustrar.

QUANDO USAR SKILL:
  ├─ ATB encheu o suficiente pra QUALQUER skill?
  │   → Espera 1.5~3.0 segundos (delay PROPOSITAL)
  │   → Escolhe skill ALEATÓRIA entre as disponíveis
  │   → Não prioriza nada, não analisa nada
  │
  └─ Chance de "errar" a decisão:
      → 30% chance de usar skill fraca (Slot 1: ATK ×0.55)
        mesmo tendo ATB pra skill forte (Slot 2 ou 3)
      → Parece que o NPC "não sabe jogar"

QUANDO TROCAR BONECO:
  ├─ Boneco ativo com menos de 25% HP?
  │   → 50% chance de trocar (às vezes nem troca!)
  │   → Se trocar: escolhe ALEATÓRIO entre os 2
  │   → Sem lógica, sem counter-pick de classe
  │
  └─ Se não tá morrendo:
      → Troca aleatória a cada 20~30 segundos
      → Só pra dar variedade, sem estratégia

USO DE ULTIMATE:
  ├─ ATB chegou no custo da Slot 3?
  │   → Espera 2~4 segundos
  │   → Usa (não guarda pra momento estratégico)
  │
  └─ Basicamente: desperdiça o ultimate
     em momentos aleatórios

RESULTADO:
  Player ganha 80~90% das vezes
  Serve pra: aprender skills, entender troca,
  acostumar com a câmera e VFX
```

```
RESUMO BRONZE:

  Delay pra agir:     1.5 ~ 3.0 segundos
  Escolha de skill:   Aleatória
  Chance de "errar":  30%
  Troca de boneco:    Aleatória, só quando morrendo (50%)
  Troca por tempo:    Aleatória a cada 20~30s
  Ultimate:           Usa assim que pode (desperdiça)
  Analisa player:     NÃO
  Counter-pick:       NÃO
  Adaptação:          NENHUMA
```

---

### ⭐⭐ AI PRATA — "O Pensador"

```
FILOSOFIA: O NPC joga como um player mediano.
Pressiona quando tem vantagem, recua quando tá perdendo.
Começa a LER o estilo do player.

QUANDO USAR SKILL:
  ├─ Delay reduzido: 0.5~1.5 segundos
  │
  ├─ PRIORIDADE de skills:
  │   → Se inimigo com HP baixo (<30%):
  │     PRIORIZA skill com multiplicador maior (tenta matar)
  │     Ex: ATB suficiente pra Slot 2 (×1.10)? Usa pra fechar kill
  │   → Se próprio HP baixo (<40%) E tem cura:
  │     PRIORIZA cura (HP_MAX × 0.15/0.25/0.40 conforme slot)
  │   → Se nenhum caso especial:
  │     Escolhe a skill de MELHOR custo-benefício
  │     (multiplicador de dano por ponto de ATB gasto)
  │     Ex: Slot 1 = ×0.55 por 2.50 ATB = 0.22/ATB
  │         Slot 2 = ×1.10 por 5.50 ATB = 0.20/ATB
  │         → Slot 1 é mais eficiente por ATB
  │
  └─ Chance de "errar": 10% (quase sempre acerta)

QUANDO TROCAR BONECO:
  ├─ Boneco ativo com menos de 30% HP:
  │   → 85% chance de trocar
  │   → Escolhe o boneco com MAIS HP (não aleatório!)
  │
  ├─ Se tem boneco curador na reserva E time machucado:
  │   → Troca pro curador (Josuke/Giorno/Foo Fighters)
  │   → Usa cura
  │   → Troca de volta pro atacante
  │   (combo de 3 ações pensadas!)
  │   (ATB mantém ao trocar = possibilita esse combo)
  │
  └─ Troca por tempo: a cada 15~25 segundos
     → MAS só se fizer sentido (não troca atoa)

LEITURA DO PLAYER (básica):
  ├─ Conta quantas vezes o player usou cada skill
  │
  ├─ Se player SEMPRE usa Slot 1 quando ATB chega em 2.50:
  │   → AI sabe: "ele vai atacar quando ATB bater 2.50"
  │   → AI tenta trocar boneco 0.5s ANTES
  │   → Parece que a AI "leu" o player
  │
  └─ Se player sempre troca boneco quando HP < 40%:
      → AI pressiona mais forte quando HP do
        player tá perto de 40%
      → Tenta matar antes da troca

MEMÓRIA DENTRO DA LUTA:
  ├─ Guarda: qual skill o player mais usa
  ├─ Guarda: quando o player costuma trocar
  ├─ Guarda: se o player investiga marcas da barra inimiga
  └─ NÃO guarda entre lutas (reseta a cada batalha)

RESULTADO:
  Player ganha 50~65% das vezes
  Luta sente JUSTA e desafiadora
  Player percebe: "esse NPC tá me lendo"
```

```
RESUMO PRATA:

  Delay pra agir:     0.5 ~ 1.5 segundos
  Escolha de skill:   Prioridade (mata > cura > eficiência por ATB)
  Chance de "errar":  10%
  Troca de boneco:    Estratégica (mais HP, curador)
  Troca por tempo:    15~25s (só se fizer sentido)
  Ultimate:           Guarda pra momento bom
  Analisa player:     SIM (padrões de skill e troca)
  Counter-pick:       NÃO (bonecos pré-definidos)
  Adaptação:          LEVE (dentro da mesma luta)
```

---

### ⭐⭐⭐ AI OURO — "O Predador"

```
FILOSOFIA: O NPC joga pra GANHAR.
Prevê suas ações, adapta estratégia, counter-picka suas classes.
Sente como jogar contra alguém muito bom.

QUANDO USAR SKILL:
  ├─ Delay MÍNIMO: 0.2~0.8 segundos
  │   (reage quase instantâneo, mas não inumano)
  │
  ├─ SISTEMA DE DECISÃO AVANÇADO:
  │
  │   Avalia CADA skill disponível com score:
  │
  │   Score = (ATK × multiplicadorSlot × vantagem de classe)
  │         + (pressãoBonus se inimigo HP baixo)
  │         + (curaUrgencia se próprio HP baixo)
  │         - (desperdicioATB se sobra pouca barra)
  │
  │   Escolhe a skill com MAIOR score
  │
  │   Exemplos de decisão:
  │   → "Inimigo com 15% HP, meu Slot 1 (ATK ×0.55) mata?
  │      Calcula: ATK 10 × 0.55 = 5.5 dano. HP dele = 3.
  │      SIM → usa Slot 1 (não gasta ATB atoa com Slot 3)"
  │   → "Inimigo ACABOU de trocar boneco novo com HP cheio
  │      → não gasta ultimate agora, espera ele gastar
  │      HP primeiro"
  │   → "Meu curador tá na reserva e tô com 35% HP
  │      → troco pro curador, curo, e volto
  │      (troca mantém ATB = posso curar na hora)"
  │
  └─ Chance de "errar": 0% (nunca erra de propósito)
     MAS: tem 5% de chance de fazer jogada "ousada"
     (usar ultimate cedo pra surpreender)

QUANDO TROCAR BONECO:
  ├─ COUNTER-SWAP (reativo — usa triângulo de classes):
  │   → Player trocou pra boneco Fúria?
  │   → AI troca pra boneco Domínio (+15~20% dano contra Fúria)
  │   → Player trocou pra Intimidação?
  │   → AI troca pra Fúria (+15~20% dano contra Intimidação)
  │   → Parece que a AI "counter-pickou"
  │
  ├─ TROCA PREVENTIVA:
  │   → AI calcula: "se inimigo usar Slot 3 (ATK × ×2.33~×3.53),
  │      meu boneco sobrevive?"
  │   → NÃO → troca pra boneco com mais HP ANTES do ataque
  │   → Player: "como ele sabia?!"
  │
  ├─ TROCA OFENSIVA:
  │   → Inimigo tá com HP baixo
  │   → AI troca pro boneco com Slot que MATA
  │   → Calcula: "preciso de X dano. Boneco Y tem
  │      ATK 12 × Slot 2 (×1.10) = 13.2. HP dele = 10.
  │      Mata. Troco pra ele."
  │
  └─ NUNCA troca aleatoriamente
     Toda troca tem uma RAZÃO calculada

LEITURA DO PLAYER (avançada):
  ├─ PADRÃO DE SKILLS:
  │   → Conta uso de cada skill
  │   → Detecta: "player favorece Slot 1 do Giorno (Life Drain)"
  │   → Resposta: mantém boneco com HP alto (Life Drain cura menos)
  │
  ├─ PADRÃO DE TROCA:
  │   → Detecta: "player troca quando HP < 35%"
  │   → Resposta: pressiona HARD quando HP perto de 35%
  │   → OU: poupa ATB e espera a troca pra dar all-in
  │     no boneco novo (que entra com ATB mantido mas HP cheio)
  │
  ├─ PADRÃO DE TIMING:
  │   → Detecta: "player usa skill assim que tem ATB"
  │     (impaciente)
  │   → Resposta: guarda skills pra reagir depois
  │   → OU detecta: "player acumula ATB pra Slot 3"
  │     → Resposta: pressiona antes que ATB chegue no custo
  │
  └─ PADRÃO DE INVESTIGAÇÃO:
      → Player clicou nas marcas da barra inimiga?
      → NÃO → AI sabe que player não tá preparado
        → pode usar skills surpresa
      → SIM → AI sabe que player tá atento
        → varia mais o padrão pra confundir

COUNTER-PICK DE CLASSES (pré-batalha):
  ├─ AI vê o time do player no menu de seleção
  │   (server sabe os 3 bonecos escolhidos)
  │
  ├─ AI escolhe 3 bonecos que COUNTERAM por classe:
  │   → Player tem Fúria? AI pega Domínio (+15~20% dano)
  │   → Player tem Intimidação? AI pega Fúria
  │   → Player tem Domínio? AI pega Intimidação
  │   → Player tem Suporte (curador)? AI pega boneco com
  │     multi-hit (countera escudo, pressiona antes da cura)
  │   → Player tem Controle? AI pega boneco com Dodge alto
  │     (debuffs erram mais com Dodge)
  │
  └─ Tabela de counter-pick:
      Fúria       → countered by Domínio
      Intimidação → countered by Fúria
      Domínio     → countered by Intimidação
      Suporte     → countered by pressão (multi-hit + ATK alto)
      Controle    → countered by Dodge alto + troca frequente

ADAPTAÇÃO DURANTE A LUTA:
  ├─ A cada 3 ciclos de skill: AI reavalia estratégia
  │
  ├─ Fase 1 (início): "Testar"
  │   → Usa skills variadas
  │   → Observa como player reage
  │   → Coleta dados
  │
  ├─ Fase 2 (meio): "Adaptar"
  │   → Já tem padrão do player
  │   → Começa a explorar fraquezas
  │   → Pressiona nos momentos certos
  │
  └─ Fase 3 (final): "Dominar"
      → Sabe exatamente o que player faz
      → Prevê ações 1-2 skills antes
      → Joga pra fechar a luta
      → Se tá perdendo: muda estratégia
        completamente pra surpreender

RESULTADO:
  Player ganha 30~45% das vezes
  Luta sente INTENSA e recompensadora quando ganha
  Player sente: "essa AI tá jogando CONTRA mim"
  Exige que player varie estratégia constantemente
```

```
RESUMO OURO:

  Delay pra agir:     0.2 ~ 0.8 segundos
  Escolha de skill:   Score system (ATK × multiplicador × classe × contexto)
  Chance de "errar":  0% (5% "ousadia" proposital)
  Troca de boneco:    Counter-swap por classe, preventiva, ofensiva
  Troca por tempo:    NUNCA aleatória (sempre com razão)
  Ultimate:           Guarda pro momento PERFEITO
  Analisa player:     SIM (skills, troca, timing, investigação)
  Counter-pick:       SIM (triângulo de classes + pressão em Suporte/Controle)
  Adaptação:          TOTAL (3 fases: testar → adaptar → dominar)
```

---

### 📊 Comparação Direta

```
                    ⭐ BRONZE       ⭐⭐ PRATA        ⭐⭐⭐ OURO

Delay              1.5~3.0s        0.5~1.5s         0.2~0.8s
Skill choice       Aleatória       Prioridade       Score system
Erro proposital    30%             10%              0%
Troca              Aleatória       HP + curador     Counter-swap por classe
Counter-pick       Não             Não              Sim (triângulo de classes)
Lê o player        Não             Padrões básicos  Padrões avançados
Adapta             Não             Leve             3 fases
Ultimate           Desperdiça      Momento bom      Momento PERFEITO
Winrate player     80~90%          50~65%           30~45%
Sensação           "Fácil demais"  "Justo"          "Essa AI é boa"
```

---

### 🧠 O Que a AI "Vê" (Dados Disponíveis)

```
INFORMAÇÃO QUE A AI TEM ACESSO (server-side):

SOBRE O PLAYER:
  ├─ HP atual dos 3 bonecos
  ├─ Qual boneco tá ativo
  ├─ ATB atual do player (0 a 10)
  ├─ Quais skills o player já usou (histórico)
  ├─ Quantas vezes cada skill foi usada
  ├─ Quando o player costuma trocar (% HP)
  ├─ Quanto tempo o player demora pra agir
  ├─ Se o player clicou nas marcas da barra inimiga
  ├─ Quais bonecos o player escolheu (pré-batalha)
  ├─ Classes dos bonecos do player (Fúria/Intimidação/etc)
  └─ Nível e stats (ATK/HP/Dodge/Crit) dos bonecos do player

SOBRE SI MESMO:
  ├─ HP dos próprios bonecos
  ├─ ATB própria (0 a 10)
  ├─ Skills disponíveis, custos e multiplicadores
  ├─ Classes dos próprios bonecos
  └─ Buffs/debuffs ativos (Resistência, Vulnerabilidade)

O QUE A AI NÃO SABE (justo):
  ├─ ❌ O que o player VAI fazer (não lê input)
  ├─ ❌ Qual skill o player tá planejando
  ├─ ❌ Se o player vai trocar no próximo frame
  └─ ❌ Resultado de Dodge/Crit (é RNG no momento do hit)

  A AI PREVÊ baseado em PADRÃO, não em leitura
  de input. É previsão estatística, não trapaça.
```

---

### 🎯 Sistema de "Personalidade" por NPC

```
Além das estrelas, cada NPC pode ter uma
PERSONALIDADE que influencia a AI:

AGRESSIVO (ex: Dio, Diavolo):
  → Prioriza multiplicador alto (Slot 2 e 3)
  → Troca menos (confia no boneco ativo)
  → Usa ultimate mais cedo
  → Pressiona HP baixo MUITO forte
  → Ignora Resistência do inimigo (ataca mesmo assim)

DEFENSIVO (ex: Josuke, Bruno):
  → Prioriza cura (HP_MAX × %) e sobrevivência
  → Troca mais frequente (preserva bonecos)
  → Guarda ultimate pra emergência
  → Joga reativo (espera player agir primeiro)
  → Mantém Resistência ativa sempre que pode

TÁTICO (ex: Jotaro, Kira):
  → Equilibrado entre ataque e defesa
  → Usa combos de troca + skill
  → Aplica Vulnerabilidade antes de atacar forte
  → Varia muito pra ser imprevisível
  → Analisa mais antes de agir

CAÓTICO (ex: Polnareff, Okuyasu):
  → Decisões menos previsíveis
  → Às vezes genial, às vezes burro
  → Usa skills inesperadas
  → Troca em momentos estranhos
  → Mais divertido de lutar contra

Personalidade + Estrela = AI única por NPC

Dio ⭐     = Agressivo + Burro = ataca sem pensar, usa Slot 3 atoa
Dio ⭐⭐⭐ = Agressivo + Gênio = pressão implacável, mata antes de curar

Kira ⭐    = Tático + Burro = tenta armar combos mas erra
Kira ⭐⭐⭐ = Tático + Gênio = Vulnerabilidade → Slot 3 → kill perfeito
```

---

### 📋 Resumo Final da AI

```
┌────────────────────────────────────────────────────┐
│              SISTEMA DE AI — REGRAS                 │
├────────────────────────────────────────────────────┤
│                                                    │
│  3 NÍVEIS: Bronze (⭐), Prata (⭐⭐), Ouro (⭐⭐⭐)  │
│                                                    │
│  BRONZE:                                           │
│    Delay alto, escolha aleatória, 30% erro         │
│    Não analisa, não adapta, desperdiça ultimate     │
│    Player aprende o sistema                        │
│                                                    │
│  PRATA:                                            │
│    Delay médio, prioridade de skills, 10% erro     │
│    Lê padrões básicos do player                    │
│    Pressiona quando tem vantagem                   │
│    Player precisa pensar                           │
│                                                    │
│  OURO:                                             │
│    Delay baixo, score system, 0% erro              │
│    Leitura avançada, counter-pick por classe,      │
│    3 fases (testar → adaptar → dominar)            │
│    Prevê ações, adapta constantemente              │
│    Player precisa ser muito bom                    │
│                                                    │
│  PERSONALIDADE POR NPC:                            │
│    Agressivo / Defensivo / Tático / Caótico        │
│    Combina com estrela = AI única por NPC           │
│                                                    │
│  STATS QUE A AI USA PRA CALCULAR:                  │
│    ATK × multiplicador do Slot (×0.55/×1.10/×2.33) │
│    Vantagem de classe (+15~20%)                    │
│    HP atual vs dano calculado = "mata ou não?"     │
│    Dodge/Crit = RNG, AI não controla               │
│    Resistência/Vulnerabilidade = buffs temporários  │
│                                                    │
│  AI NÃO TRAPACEIA:                                 │
│    Não lê input do player                          │
│    Prevê por PADRÃO estatístico                    │
│    Toda informação é server-side legítima           │
│                                                    │
└────────────────────────────────────────────────────┘
```