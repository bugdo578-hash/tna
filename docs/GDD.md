##  TINY ADVENTURES — GDD MUNDO 1 / LANÇAMENTO
### Versão 1.1 — Foco: Lançamento Inicial
(revisão: economia em Tinyes, loja, UI, kits dos 19 bonecos, regras globais de combate, roadmap e pendências)

---

###  VISÃO GERAL

**Nome:** Tiny Adventures
**Plataforma:** Roblox (Luau)
**Gênero:** RPG de turnos com ATB + mundo aberto
**Estilo visual:** Bonecos estilo Teeny Titans 2 — personagens de JoJo transformados em brinquedos
**Lançamento:** Mundo 1 apenas (Partes 1, 2 e 3)

---

###  LORE (MUNDO 1)

Um Stand misterioso chamado **Voodoo Doll** roubou as almas de todos os personagens de JoJo Partes 1-3 em brinquedos, roubando seus poderes, e o player precisa ajudá-los a derrotar o vilão e restaurar seus poderes.
o dono do Voodoo Doll utilizando as almas roubadas criou uma franquia de bonecos revelando assim pra todas as pessoas normais a existencia de stands, porem como agora sao brinquedos todos querem adiquirir os seus proprios ( isso explica os npcs com bonecos.
com a dolls's store criada, ele vende diversas fraçoes dos poderes originais cada uma unica com uma % do poder (isso explica a melhoria de habilidades, e os uuids)

**Progressão do vilão no Mundo 1:**
- Fraco, subestima o player
- Usa stands roubados das Partes 1-3
- Recua após derrota no torneio, absorve poder dos bonecos derrotados

---

### ️ ESTRUTURA DE MUNDOS (LANÇAMENTO)

```
MUNDO 1 — Partes 1, 2 e 3
  Personagens: Dio (Pt1), Jonathan, Zeppeli, Bruford/Tarkus, 
                Joseph, Caesar, Lisa Lisa, Stroheim, 
                Kars/Esidisi/Wamuu (Kars pode evoluir para Kars Perfeito),
                Jotaro, Avdol, Kakyoin, Polnareff, 
                Joseph Pt3, Iggy, DIO
  Dificuldade livre: muito baixa | Modo história: baixa
  Torneio (atualização futura): 3 lutas contra vilão com stands roubados
```

**Torneio:**
- Player leva bag de 6 bonecos
- Conteúdo planejado para uma atualização futura
- Não há recuperação automática de HP entre lutas
- Ao perder uma batalha, a tentativa do torneio termina e recomeça da primeira luta, mesmo que ainda haja 3 bonecos vivos na bag
- Ao vencer com bonecos mortos, eles continuam mortos nas próximas lutas até serem revividos por uma Rokaka ou o torneio terminar
- Entre lutas: pode trocar bonecos mortos por outros da bag
- Pode mudar o trio inteiro entre lutas somente com o time q vc levou durante o torneio

---

### ️ FLUXO COMPLETO DO JOGO (LANÇAMENTO)

```
TUTORIAL (Mundo 1 — entrada)
  → Player testa bonecos aleatórios (2 com Stand + 1 sem)
  → Presencia e entende a mecânica naturalmente
  → Passa o tutorial → ganha 300 Tinyes
  → Compra personagem base comum → começa a jornada

MUNDO ABERTO (Cidade Principal)
  → Player anda, encontra NPCs de JoJo com Stands visíveis
  → NPCs têm rotas de patrulha aleatória (PathfindingService + waypoints)
  → NPCs mudam por spawn controlado (os.time ou eventos)
  → ProximityPrompt [E] → Diálogo padrão para TODO NPC (ver seção UI):
      letterbox desce, câmera atrás do player, caixa com foto + texto digitando,
      opções: Sair / Conversar mais / Batalhar
  → Caixas de Sorte brilhando pelo mapa (exploração recompensada)
  → Rival aparece aleatoriamente no mapa (único NPC com uma estrela sobre a cabeça)
      ↓
MENU DE SELEÇÃO (console estilo Teeny Titans)
  → Usa o mesmo HUD de bonecos do jogo: 6 slots (bag). Fora da pré-luta os slots só exibem;
    na pré-luta, clicar num slot mostra os status do boneco
  → Campo de grama (estilo seleção do novo Dragon Ball) com 3 círculos amarelos de beam (VFX):
    o player arrasta os bonecos e encaixa nos círculos; o boneco encaixado faz uma pose
  → Player escolhe 1 a 3 bonecos; Bruford e Tarkus ocupam juntos 1 slot
  → [ATUALIZAÇÃO FUTURA] reorganizar skills na barra ATB e equipar chips — fora do lançamento
  → ENQUANTO FAZ ISSO: bonecos e arena são pré-carregados em background (server pré-carrega a arena)
  → Ready Check (PVP): botão GO + timer de 240s ao lado; depois de apertar GO dá para cancelar;
    se o oponente não apertar até o tempo acabar, a sala fecha sozinha; X no topo para desistir antes
  → PVE: direto, sem Ready Check → teleporte instantâneo
      ↓
ARENA INVISÍVEL
  → Server move player + NPC para uma arena isolada (até o limite operacional de 50000 studs da cidade)
  → Server sorteia lado aleatoriamente (SpawnA ou SpawnB)
  → Client: cidade some (StreamingEnabled), arena aparece
  → Culling seletivo: só participantes veem a arena
  → Cada arena tem SkyboxFake próprio (6 Parts com Decal temático)
      ↓
CUTSCENE DE ENTRADA (~6 segundos)
  → Bonecos já estão carregados desde o Menu de Seleção (nada carrega durante a cutscene)
  → Câmera cinematográfica começa na direita, faz arco por trás do time do player
    e para no ângulo do time do player
  → Durante o arco: animação de entrada dos 3 bonecos aparecendo com VFX,
    com a contagem "3... 2... 1... GO" por cima
  → Shake dramático → flash → split screen (HUD de batalha)
  → Poses JoJo, ゴゴゴゴ menacing
  → No GO: os 2 bonecos de reserva recuam para trás/baixo da arena; só o primeiro fica ativo
  → Dolly Zoom NÃO faz parte da entrada padrão (reservado para momentos raros: boss/rival)
      ↓
BATALHA ATB
      ↓
RESULTADO
  → Fim: todos os bonecos de um lado mortos, ou desistência
  → Câmera foca no boneco ativo do vencedor e orbita lentamente; ele faz uma dança aleatória (pool)
  → Texto VICTORY (vencedor) / DEFEAT (perdedor); mostra os Tinyes ganhos
  → Boss/Rival podem dar recompensas na hora
  → Ao fechar: time usado com barras de XP enchendo; boneco que subiu de nível fica piscando
  → Distribuição de pontos NÃO é uma tela do resultado: é feita depois, no Inventário
  → Arena destruída (Destroy()) → volta à cidade
```

---

###  ECONOMIA E EXPLORAÇÃO

**Moeda: Tinyes** (ganha jogando; também compra-se com Robux na loja)
```
Ganho por vitória em batalha padrão: 55–150 Tinyes
Boss = mini-torneio solo: 2 capangas + boss, instância PESSOAL por player
       (cada player luta sua própria cópia; reaproveita o combate 1v1 já existente)
Tutorial entrega 300 Tinyes (cobre o primeiro Comum)
```

**Preços de bonecos (ponto de partida; calibrar em playtest):**
```
Raridade  | Vitórias (~) | Tinyes        | Robux (10% fixo)
Comum     | 2–3          | 200–300       | 20–30
Rara      | 6–8          | 600–800       | 60–80
Épica     | 15–20        | 1.500–2.000   | 150–200
Lendária  | 35–50+       | 3.500–5.000+  | 350–500
```
- Mesma pool para quem paga em Tinyes ou Robux: Robux compra conveniência (tempo), nunca poder exclusivo.
- Compra é direta (o player escolhe o boneco, sem sorteio) → não é "Paid Random Item" do Roblox.
- Raridades altas também exigem gate de progressão (história/Disco), então o preço não precisa carregar sozinho a dificuldade.

**Caixas de Sorte (Daily Hype):**
```
O que são:  Modelo parcialmente enterrado no mapa com VFX brilhante (objeto do mundo, não é UI)
Prêmios:    Tinyes, Boneco ou Chip
  Tinyes → valor fixo aleatório entre 250 e 550 (independe do saldo; sem % do saldo)
  Boneco → gacha orgânico, com a mesma animação de baú da loja
  Chip   → mostra o chip + descrição do que faz

Gratuitas: abrir não custa Tinyes nem Robux, então ficam fora da regra de
Paid Random Items do Roblox. Se um dia a caixa/chave for vendida por Robux (ou Tinyes
comprados com Robux): declarar odds e checar PolicyService.

Anti-farm:
  → Caixas são LOCAIS (cada player tem as suas)
  → Limite diário: 5 caixas; chance de boneco só nessas 5
  → Depois do limite: só Tinyes (com cooldown de respawn)
  → Teto diário previsível (~5 × 400 médio ≈ 2.000 Tinyes), sem crescimento composto

Resgate (UI): ver seção UI. Pesos de chance Tinyes/Boneco/Chip: a definir.
```

---

###  SISTEMA DE LOJA

```
LOJA DE BONECOS (progressiva):
  → Começa com bonecos Comuns/Raros e alguns Épicos escassos
  → Bonecos fortes só aparecem na vitrine após requisitos:
    • Derrotar o personagem no modo história
    • OU achar o "Disco" dele no mapa
  → Kars Perfeito é a evolução de Kars e NÃO aparece diretamente na loja
    • É necessário ter Kars e realizar a evolução pelo menos 1 vez
  → DIO Pt3 e Joseph Pt3 são versões próprias do elenco, não evoluções
```

**Regra das ofertas (estoque pessoal por client):**
```
Cada player tem o SEU estoque dentro do servidor:
  → Mesmas posições físicas das estantes, conteúdo individual
    (o player A vê Jotaro na estante 3, o player B vê Polnareff na mesma estante)
  → Cada oferta tem um offerId (UUID) único DAQUELE estoque
  → Comprar remove só a oferta do comprador; não existe corrida entre players
  → Vitrine rerrola quando a oferta é comprada ou no reset programado
```

**Fluxo físico da loja:**
```
- Loja 3D onde o player entra; cada boneco fica numa caixa em estante
- Clicar abre uma telinha: boneco 3D dentro da caixa (gira com o mouse), gráfico radar
  de stats atrás dele, UUID, status base e classe
- Opções: colocar no carrinho, comprar direto na telinha, ou devolver
- Carrinho virtual com botão Comprar; não dá para sair da loja com itens no carrinho
- Pagamento em Tinyes ou Robux, validado no SERVER (saldo, oferta existente) antes de
  qualquer animação de sucesso
- Animação de compra: a caixa fica branca e explode; o boneco fica na tela; ao fechar a UI
  ele já está no inventário com seu itemUuid
- Girar/olhar é 100% client; a decisão de compra é do server
```

---

###  SISTEMA DE UUIDs

```
fighterId  = quem é o boneco (ex: "jotaro") — template
offerId    = identifica UMA oferta específica da loja
itemUuid   = identifica O BONECO DO INVENTÁRIO do player (permanente)
```

---



bonecos Mundo 1  19 bonecos
#	Boneco	        Classe	           Stand/Poder	
1	DIO Pt1	        Menace	           Vampiro	
2	Jonathan	Fury	           Hamon	
3	Antonio Zeppeli Support	   Hamon	
4	Bruford	Controller	         Dupla (c/ Tarkus)	
5	Tarkus	     Dominator              Dupla (c/ Bruford)	
6	Joseph Pt2	Fury	          Hamon	
7	Caesar	        Dominator         Hamon	
8	Lisa Lisa	Support	          Hamon	
9	Stroheim        Menace	          Cyborg	
10	Kars	      Controller	  Pillar Man (evolução: Kars Perfeito)	
11	Esidisi	      Controller	  Pillar Man	
12	Wamuu	      Dominator               	Pillar Man	
13	Jotaro	       Fury	                   Star Platinum	
14	Avdol	        Controller	Magician's Red	
15	Kakyoin	       Controller	Hierophant Green	
16	Polnareff	Fury	     Silver Chariot	
17	Joseph Pt3	Fury	      Hermit Purple	
18	Iggy	    Controller	        The Fool	
19	DIO Pt3	    Menace	        The World	

Kars Perfeito é uma evolução e não faz parte dos 19 bonecos base do lançamento.
DIO Pt3 e Joseph Pt3 são versões próprias do elenco, não evoluções.
Bruford e Tarkus ocupam juntos um único slot da equipe, mas cada um tem HP separado.
Enquanto um está ativo, ele recebe 100% do dano e o parceiro recebe 34%.
Quando um deles morre, o outro continua com 1/3 da vida total e ganha +10% de dano.
  → Esse 1/3 vira o novo HP_MAX do sobrevivente até o fim da luta (cura nunca passa disso).
  → A Dupla só conta como 1 morte do time quando os dois caírem.
  → Bruford = Controller e Tarkus = Dominator (intencional): a vantagem de classe muda
    conforme quem está ativo.
  → "Alternar" (troca entre os dois) é uma skill paga em ATB; na versão evoluída deixa de custar ATB.

Triângulo de Counter:
	Fury      → counter Menace
	Menace     → counter Dominator
	Dominator  → counter Fury
	Support    → soft counter Controller via Clean (planejado para atualização futura)
	Controller → counter Support ao sobrecarregar o Clean (planejado para atualização futura)
Vantagem de classe = +15 a 20% de dano

Identidade das classes (guia de design, definido por "feeling", não por regra rígida):
  Fury       → pressão direta, kit simples, 1 efeito complementar
  Menace     → poder alto com contrapartida/risco pessoal embutido
  Dominator  → compromisso ou força que domina o ritmo da luta (canais, força bruta)
  Support    → ferramentas de time (cura, limpeza, buff, utilidade)
  Controller → negação de ação/recursos (Root, Counter, drenos, sensores)

Exemplos de matchup:
  Jonathan/Jotaro/Joseph vs Dio/Stroheim  (Fury > Menace)
  Dio/Stroheim vs Kars/Esidisi/Wamuu      (Menace > Dominator)
  Kars/Esidisi/Wamuu vs Jonathan/Jotaro/Joseph  (Dominator > Fury)

Progressão:
  Lv max: 30
  Lv1: somente baseStats rolados na loja, sem pontos adicionais
  Lv2→30: +2 pontos por nível | Total no lv30: 58 pontos
  Cap de pontos alocados em cada stat = nível atual do boneco
  S3 (habilidade 3) só é desbloqueada a partir do Lv5 (decisão do autor; ver Pendências)
  Referência Lv5 (build equilibrada, 2 pts em cada stat): HP 40, ATK ~12; um S3 tira ~42–53% do HP

XP pós-batalha:
  XP total é dividido em 3 (um terço por slot do time)
  Boneco que morreu mas o time venceu: recebe 50% do seu terço; o restante vai para os vivos
  Boneco que não causou nenhum dano: também perde 50%
  Os dois cortes acumulam (morreu E não causou dano = 25%)
  Subir de nível: o boneco pisca; os pontos são distribuídos depois, no Inventário

  HP:    +12.5 por ponto
  ATK:   +1 por ponto
  Dodge: +1 por ponto (1p = 1%)
  Crit:  +1 por ponto (1p = 1.5%)

Sistema de Pares (builds forçadas):
  Casal 1: ATK + Dodge → diferença máxima de 5 pontos
  Casal 2: HP  + Crit  → diferença máxima de 5 pontos

  Se tentar ATK 20 e Dodge 14 → diff 6 — bloqueado
  Se tentar ATK 20 e Dodge 15 → diff 5 — permitido

Exemplos de alocação dos 58 pontos no lv30:
  Glass Cannon:  ATK 25, Dodge 20, HP 9,  Crit 4
  Tanque Crítico: HP 25,  Crit 20,  ATK 9, Dodge 4
  Equilibrado:   ATK 15, Dodge 15, HP 14, Crit 14


CLASS DATA:

    Fury = hp = {13, 17}, atk = {8, 12}, dodge {5, 8}  | crit {8, 12}

    Support = hp = {8, 15}, atk = {4, 7}, dodge {8, 14} | crit {3, 6}

    Controller = hp = {16, 20}, atk = {6, 10}, dodge {5, 8}  | crit {5, 8}

    Dominator = hp = {14, 18}, atk = {7, 11}, dodge {3, 6}  | crit {6, 10} 

    Menace = hp = {12, 16}, atk = {9, 13}, dodge {4, 7}  | crit {7, 11} 

---

###  CÂMERA e ATTACKS

**Estados globais da sequência de ataque:**
```
IDLE:    câmera dividida; ATB pode carregar; ações e troca liberadas
PREPARE: linhas pretas descem; câmera transiciona para o atacante
ATTACK:  ataque e cinema acontecem
RETURN:  câmera retorna ao split; ambos os ATBs continuam pausados
```

**Estados locais do boneco (não substituem o estado global):**
```
CARREGANDO ATAQUE:
  → só o ATB do atacante que está fazendo casting fica pausado
  → o ATB inimigo continua carregando normalmente
  → ao concluir, entra na sequência PREPARE → ATTACK → RETURN
  → habilidades com casting causam 1.5× de dano

CAÍDO:
  → recuperação curta entre o final de RETURN e a volta completa ao IDLE
  → só o ATB do boneco caído fica pausado
  → o outro lado pode carregar ATB normalmente quando a sequência global acabar
  → boneco caído não pode agir nem trocar até terminar a recuperação
```

**Timing:**
```
Carregado: IDLE + CARREGANDO → PREPARE → ATTACK → RETURN → IDLE
Com queda: IDLE → PREPARE → ATTACK → RETURN → CAÍDO curto → IDLE
```

**Profundidade de campo (Depth of Field) na batalha:**
```
- Um DepthOfFieldEffect por câmera fixa (cam1 e cam2, uma de cada lado); só o da câmera ativa fica Enabled
- Câmeras a ~12 studs uma da outra (6 de cada lado do centro); bonecos a ~5 do centro (10 entre si)
- Valores de partida: FocusDistance = 6, InFocusRadius = 5, NearIntensity = 0, FarIntensity = 0.8
- Criado/ligado só no CLIENT dos participantes (CameraController) ao entrar na arena; desligado ao sair
- Atmosphere (neblina) afeta todo o mundo, em qualquer distância da origem
```

---

### ️ SISTEMA DE ARENA INVISÍVEL

```
Cidade: (0, 0, 0)
Primeira posição de arena: (0, -100, 20000)
Espaçamento: 1000 studs no eixo X
Arena N: (N × 1000, -100, 20000)
Se o eixo X ficar muito ocupado, novas fileiras podem ser empilhadas com cerca de 1000 studs de espaçamento no eixo Y.
50000 studs é o LIMITE operacional de afastamento, não a posição fixa.
O alocador só cria uma arena se sua posição continuar dentro desse limite.

3 Camadas de proteção:
1. StreamingEnabled
2. LocalScript — RemoteEvent só pros participantes
3. Server — valida quem tá em qual arena
```

---

### ️ SISTEMA DE BATALHA — ATB + TAG

**Formato:** 1v1 com tag system. Cada lado tem 3 slots de equipe e 1 personagem ativo por vez. Bruford e Tarkus ocupam juntos 1 slot.

**Barra ATB:**
```
- UMA barra compartilhada pelos 3 bonecos de cada lado
- Range: 0 a 10 | Velocidade base: 0.588 (≈17s para 0→10; era 25s com 0.4)
- A skill gasta o custo ATB rolado e permanente daquele slot
- Ranges: S1 0.75–3.0 | S2 4.0–7.0 | S3 8.0–10.0
- Trocar boneco → ATB mantém o valor
- Boneco morre → ATB reseta para 0
- Ambos os players veem as duas barras
- PREPARE/ATTACK/RETURN → ATB dos dois lados pausado
- O carregamento global só volta quando a batalha retorna a IDLE
- CARREGANDO e CAÍDO são pausas locais, conforme a seção de câmera
```

**Estados de Posição:**
```
IDLE → PREPARE → ATTACK → RETURN → IDLE

IDLE:    5 studs | ATB enchendo | Swap liberado
PREPARE: 5→8/10 studs | ATB pausada | Swap bloqueado
ATTACK:  câmera fullscreen | HUD escondido
RETURN:  8/10→5 studs | ATB ainda pausado | HUD voltando; ATB retoma somente em IDLE
```

**Troca (Tag):**
```
- Custo: GRÁTIS (0 ATB)
- Bloqueada durante: CARREGANDO, PREPARE, ATTACK, RETURN, CAÍDO e Root
- Só no estado IDLE
- Animação ~0.5s
```

---

###  TARGETING E DANO

```
Normal: SÓ acerta boneco ATIVO
AoE: Os 3 sobem no PREPARE, todos levam, descem no RETURN
Delay: Acerta quem ESTIVER na posição quando explode
Escudo: Desvia do primeiro hit. Multi-hit passa pelo restante.
```

---

###  MORTE E DERROTA

```
1. Animação de KO
2. Troca automática aleatória (server escolhe)
3. ATB reseta pra 0

Todos os bonecos selecionados mortos = DERROTA INSTANTÂNEA, mesmo que o time tenha menos de 3.
```

---

###  SISTEMA DE CURA

```
[DECISÃO FECHADA — FÓRMULA HÍBRIDA ATK + LIMITE DE HP]

ATK_cura = baseStats.atk + allocatedATK + bônus de ATK dos chips
Buffs temporários de habilidade NÃO entram em ATK_cura.
levelScale de dano NÃO é aplicado à cura.

curaBruta  = ATK_cura × healMult_do_slot
curaSingle = arredonda(min(curaBruta, HP_MAX × capHP_do_slot))

Slot | healMult | capHP
S1   | 0.55     | 20% do HP_MAX
S2   | 1.10     | 30% do HP_MAX
S3   | 1.40     | 45% do HP_MAX

Cura single e autocura:
  Aplicam curaSingle somente ao alvo/usuário ativo.

Cura AoE:
  curaPorAlvo = arredonda(curaSingle / quantidade_de_aliados_vivos)
  O total é dividido; não duplica cura ao adicionar mais aliados.

Referência validada — base HP 15, base ATK 10, build equilibrada:
  Lv1:  HP 15    | ATK_cura 10 → S1 3  | S2 5  | S3 7
  Lv15: HP 102.5 | ATK_cura 17 → S1 9  | S2 19 | S3 24
  Lv30: HP 202.5 | ATK_cura 25 → S1 14 | S2 28 | S3 35

Comportamento desejado:
  No início, capHP impede autocura exagerada.
  Depois, allocatedATK melhora a cura gradualmente sem escalar só por HP.
```

---



###  SISTEMA DE SLOTS DE HABILIDADES

```
[ATUALIZAÇÃO FUTURA] No lançamento cada skill fica fixa no slot definido no kit do personagem.
A reorganização de skills entre slots está planejada para depois e funciona assim:
Habilidades NÃO são fixas nos slots — o player poderá reorganizar.
Mudar uma skill de slot muda seu range de custo, dano e efeito.

Slot 1 → custo ATB 0.75–3.0 | healMult 0.55
Slot 2 → custo ATB 4.0–7.0  | healMult 1.10
Slot 3 → custo ATB 8.0–10.0 | healMult 1.40

O damageMult não é fixo: custo e mult vêm juntos do roll daquele slot.
Dano = arredonda(ATK_final × mult_do_roll × levelScale)
Cura = arredonda(min(ATK_cura × healMult, HP_MAX × capHP)); ver seção "Sistema de Cura"
```

---

###  SISTEMA HAMON

```
Hamon é auto-buff — não afeta o time
Multiplicador por slot:
  [1] = 1.30
  [2] = 1.8
  [3] = 2.20

3 cargas — cada ataque consome 1 carga
Multi-hit consome 2 cargas
Upgrade: +1 carga (total 4)
Não acumula — reativa renova cargas
Não é passiva: precisa ser ativada (skill de carga). É uma barra temporária de ~30s
(ou ≈ o tempo de a ATB encher 3 vezes); se não for usada, expira. Atacar gasta as cargas.
(valor exato da duração: ajustar em playtest)
```

---

### SISTEMA DE EFFECTS

**BuffMulti:**
```
Recurso acumulado que amplifica o próximo ataque
Cada aplicação avança um estágio do medidor de 4 estágios.

Slot Multipliers (cap por tier de ATK):
  Slot 1: Lv1-10 → +7.5% (+15% upgrade)| Lv11-20 → +12.5% (+25% upgrade)| Lv21-30 → +25%  (+50% upgrade)
  Slot 2: Lv1-10 → +22.5% (+40% upgrade)| Lv11-20 → +37,5% (+50% upgrade)| Lv21-30 → +75%  (+100% upgrade)
  Slot 3: Lv1-10 → +45% (+75% upgrade)| Lv11-20 → +75% (+87% upgrade)| Lv21-30 → +150% (+175% upgrade)

Fórmula:
  O slot da habilidade que concede o buff define capDoTier.
  capFinal = capDoTier ajustado por chips e modos ativos.
  Cada aplicação preenche 1 de 4 estágios:
  BuffMulti = capFinal × min(aplicações, 4) / 4
  Dano final = dano base + (dano base × BuffMulti acumulado)

Regras de acúmulo:
  O cap da tabela é o limite total acumulado por slot e tier, antes dos modificadores.
  Chips e modos podem alterar o cap final antes de calcular os quatro estágios.
  Cada uso que concede BuffMulti conta como uma aplicação, mesmo em multi-hit.
  Ao alcançar 4 aplicações, o efeito chega ao cap e aplicações extras não aumentam o valor.
  Duração: até consumir
  Visual: fogo dourado nas habilidades
  Nome de apresentação (UI): "Dark Determination" (olhos brilhando em azul). BuffMulti é só o nome técnico.
```

**WeakMulti:**
```
Recurso que enfraquece o próximo ataque inimigo
Cada aplicação avança um estágio do medidor de 4 estágios.

WeakMulti seguindo mesma lógica do BuffMulti:

Slot 1: Lv1-10 → -3.5% (-7% upgrade) | Lv11-20 → -6% (-12% upgrade) | Lv21-30 → -20% (-30% upgrade)
Slot 2: Lv1-10 → -7.5% (-15% upgrade) | Lv11-20 → -13% (-22% upgrade) | Lv21-30 → -30% (-40% upgrade)
Slot 3: Lv1-10 → -10% (-20% upgrade) | Lv11-20 → -20% (-30% upgrade) | Lv21-30 → -40% (-50% upgrade)

Fórmula:
  O slot da habilidade que concede o efeito define capDoTier.
  capFinal = abs(capDoTier) ajustado por chips e modos ativos.
  Cada aplicação preenche 1 de 4 estágios:
  WeakMulti = capFinal × min(aplicações, 4) / 4
  Dano final = dano base × (1 - WeakMulti acumulado)

Regras de acúmulo:
  O cap negativo da tabela é o limite total acumulado por slot e tier, antes dos modificadores.
  Chips e modos podem alterar o cap final antes de calcular os quatro estágios.
  Cada uso que concede WeakMulti conta como uma aplicação, mesmo em multi-hit.
  Ao alcançar 4 aplicações, o efeito chega ao cap e aplicações extras não aumentam o valor.
  Duração: até consumir ou Clean
  Cap mínimo: sempre dá 1 de dano
  Visual: aura cinza/escura no inimigo
```

**Burn e Bleed (únicos DoTs do sistema):**
```
Bleed: 25% do dano do hit que o aplicou | Burn: 20%
3 ticks em 3s (1 tick por segundo)   [cadência a confirmar: ver Pendências]
Não acumulam: nova aplicação renova a duração (Bleed: confirmar, igual ao Burn)
Calculados sobre o dano REAL aplicado (hit esquivado não gera DoT; multi-hit usa só os hits que conectaram)
Valor por tick < 1 (início do jogo): o valor acumula, nenhum "0" aparece na tela, e o último
  tick garante pelo menos 1 de dano. O número de dano só aparece quando for > 0; o VFX roda em todos os ticks.
Burn condicional = só em vampiros ou classes em desvantagem (Hamon e afins)
```

**Block (planejado para atualização futura):**
```
Bloqueia qualquer efeito positivo — curas, buffs, nada passa
No lançamento: os efeitos de status previstos são Burn, Bleed e Root.
Block, Stun, Silence, Weaken e Clean ficam para atualizações futuras.
Quando existir: Block anula qualquer efeito positivo, inclusive invocações de buff (o Sensor do Avdol
nasce e quebra na hora). Convive com os DoTs (um alvo pode estar em Block e queimando).
```

---

### ️ MÉTRICAS DE DANO

O sistema usa um roll único por slot que define, ao mesmo tempo, o custo em ATB e o multiplicador de dano da habilidade. Esses valores nascem quando a oferta aparece na vitrine e ficam fixos para sempre após a compra.

**Regra canônica: custo ATB define o multiplicador. Animação não define dano.**

---

#### 1. O Roll (`t`)

No momento em que uma oferta nasce na vitrine, cada slot sorteia seu próprio `t` (0 a 1), de forma independente:

```
t = 0    → valor mínimo do range
t = 0.5  → meio do range
t = 1    → valor máximo do range
```

Esse único `t` determina **custo e multiplicador juntos** — nunca são rolados separadamente. Isso impede um boneco de nascer com custo baixo *e* multiplicador alto ao mesmo tempo, o que o tornaria objetivamente superior aos demais.

```
roll baixo → barato e fraco
roll alto  → caro e forte
```

O roll muda o *ritmo* de uso da habilidade, nunca cria uma versão estritamente melhor da mesma skill.

---

#### 2. Custo em ATB

```
custo = lerp(custo_min, custo_max, t)
```

| Slot | Range de custo |
|---|---|
| S1 | 0.75 – 3.0 |
| S2 | 4.0 – 7.0 |
| S3 | 8.0 – 10.0 |

Exemplo (Slot 1): t=0 → 0.75 | t=0.5 → 1.875 | t=1 → 3.0

---

#### 3. Multiplicador de Dano

```
mult = D_slot × (custo / BASE_ATB_SPEED)   ← sempre 0.588, nunca muda

ai na batalha
-- Constante de calibração, nunca muda
local BASE_ATB_SPEED = 0.588

-- Variável de runtime por boneco, muda com skills/efeitos
fighter.currentAtbSpeed = 0.588 -- pode virar 0.6, 0.2, etc

-- Fórmula de dano sempre usa a constante fixa
mult = D_slot * (custo / BASE_ATB_SPEED)

-- Velocidade de enchimento da barra usa a variável do boneco
fighter.atb += fighter.currentAtbSpeed * deltaTime
```

Onde `BASE_ATB_SPEED = 0.588` e `D_slot` é uma constante de potência calibrada por slot (ver seção 4).

Como o multiplicador cresce linearmente com o custo, dois rolls do mesmo slot entregam aproximadamente o mesmo valor ofensivo por ATB gasto — o roll caro só demora mais para ficar disponível, não é matematicamente melhor.

**Animação não entra nessa conta.** PREPARE, ATTACK e RETURN pausam o ATB dos dois lados igualmente, então uma animação mais longa não representa custo real a mais para quem ataca — o oponente espera o mesmo tempo. Por isso `anim_duration`, `attackCycleTime`, `projectileTravelTime`, `prepareTime`, `attackHoldTime` e `returnTime` existem apenas para apresentação (câmera, VFX, timing visual) e nunca entram na fórmula de dano.

---

#### 4. Calibrando `D_slot`

`D_slot` é decidido por playtest, não pela fórmula. Processo:

1. Escolha um ponto de referência do slot (recomendado: `t = 0.5`)
2. Decida, jogando, qual multiplicador esse ponto deveria ter
3. Calcule `D_slot = mult_desejado / (custo_ref / BASE_ATB_SPEED)`
4. Esse `D_slot` vira constante para todos os rolls daquele slot — não muda por personagem, nível, tipo de ataque ou duração de animação

**Calibração atual** (preservando os multiplicadores de referência do protótipo original):

| Slot | Custo ref (t=0.5) | Mult ref | D_slot | Mult mínimo  | Mult máximo  |
|---   |---                |---       |---     |---           |---           |
| S1   | 1.875             | 0.684    | 0.2145 | 0.274 (@0.75)| 1.094 (@3.0) |
| S2   | 5.500             | 1.284    | 0.1373 | 0.934 (@4.0) | 1.634 (@7.0) |
| S3   | 9.000             | 2.794    | 0.1825 | 2.484 (@8.0) | 3.104 (@10.0)|

---

#### 5. Escala por Nível

```
levelScale = 0.5 + (((level - 1) / 29) × 0.5)
```

Lv1 = ×0.500 | Lv15 ≈ ×0.741 | Lv30 = ×1.000

O dano cresce por duas fontes independentes: `ATK_final` (progressão de pontos — 0 no Lv1, +2/nível até 58 no Lv30) e `levelScale` (libera gradualmente o potencial da própria habilidade). Nenhum bônus existe acima de 100%.

**Fórmula final:**
```
danoFinal = arredonda(ATK_final × mult × levelScale)
```

**Exemplo validado (Lv1, Fury média, ATK_final=10, levelScale=0.5):**
- S1: 10 × 0.684 × 0.5 = 3.42 → **3**
- S2: 10 × 1.284 × 0.5 = 6.42 → **6**
- S3: 10 × 2.794 × 0.5 = 13.97 → **14**

---

#### 6. Persistência

O roll acontece só quando a oferta nasce na vitrine. Após a compra, custo e multiplicador ficam permanentes naquele `itemUuid` — nunca há reroll no inventário. Uma nova oferta sorteia valores independentes.

---

###  SISTEMA DE CHIPS

```
1 slot por boneco, equipado no menu de seleção
[ATUALIZAÇÃO FUTURA: equipar chips fica junto com reorganizar skills; fora do lançamento]

Tipos:
  Stat: aumenta HP, ATK, Dodge ou Crit
  Passiva: habilidade passiva de outro personagem
  Trigger: ativa por condição

Passivas universais:
  Dodge: 1p = 1%
  Crit: 1p = 1.5%
  Resistência: reduz dano 50% por X tempo
  Vulnerabilidade: aumenta dano aplicado 1.25x por X tempo
```

---

###  VFX ESTILO JOJO

```
ゴゴゴゴ Menacing: BillboardGui, texto tremendo
Speed Lines: ParticleEmitter radial ou ImageLabel fullscreen
Onomatopeias: "ORA!" "MUDA!" — BillboardGui no impacto
Impact Frames: freeze 0.1s + screen shake + flash branco 1 frame
Aura do Stand: ParticleEmitter no torso, cor do Stand
Bleed: trilha de quadradinhos vermelhos saindo do corpo (transparência 0.6, aspecto de líquido), que deixam marcas no chão
Burn: mesma linguagem em laranja, com quadradinhos de fogo; só o Burn ganha aura de fogo ao redor do boneco
Transições: entrada=tela racha, ultimate=cores invertem, KO=slow motion+fade

Layering: GUI (5) → Onomatopeias (4) → Speed Lines (3) → Partículas (2) → Chars (1) → Arena (0)
```

---

###  SISTEMA DE AI — 3 Níveis

```
⭐ BRONZE (Mundo 1 — Tutorial/Primeiras Lutas)
  Delay: 1.5~3.0s | Skill: aleatória | Erro: 30%
  Troca: aleatória, só quando morrendo (50%)
  Ultimate: desperdiça | Winrate player: 80~90%

⭐⭐ PRATA (Mundo 1 — NPCs Comuns)
  Delay: 0.5~1.5s | Skill: prioridade (mata > cura > eficiência) | Erro: 10%
  Troca: estratégica | Lê padrões básicos | Winrate player: 50~65%

⭐⭐⭐ OURO (Mundo 1 — Bosses/Rival)
  Delay: 0.2~0.8s | Skill: score system | Erro: 0% (5% ousadia)
  Counter-swap, preventiva, ofensiva | 3 fases: Testar → Adaptar → Dominar
  Winrate player: 30~45%
```

---

###  RIVAL PVE

```
NPC com skin de amigo do player. Aparece 2-3x por sessão.
Sua personalidade/adaptação pertence ao sistema próprio do Rival, não aos tiers da AI comum.

Comportamento:
  → Escala com o player (mesmo nível)
  → Monta time que countera o seu time mais usado
  → Cada derrota volta com estratégia diferente
  → Recompensa: Tinyes boas + chance de chip raro
```

---

###  ANTI-EXPLOIT

```
REGRA DE OURO:
  CLIENT = VISUAL
  SERVER = GAMEPLAY

Proteções:
  Rate Limit: max 10 requests/segundo
  ATB Server-Side: client mostra, server calcula
  Dano Server-Side: client NUNCA calcula dano
  Estado Validado: server checa IDLE/PREPARE/ATTACK
  Troca Validada: server checa se boneco tá vivo + estado IDLE
  Arena Isolada: server só manda dados da SUA batalha
  Compra Validada: server confere saldo/oferta antes de qualquer animação de sucesso
  Hit/Dodge Resolvido no Server: o client só recebe o resultado e toca a animação correspondente
```

---

### ️ FRAMEWORK — Estrutura do Projeto

```
ServerScriptService/Server/
  ├─ init.server.luau
  ├─ Services/
  │    ├─ ArenaService · BattleService · ATBService · DamageService
  │    ├─ TagService · AIService · PlayerDataService · NPCService
  │    ├─ ShopService · CrateService
  ├─ Components/
  │    ├─ Fighter · Skill · Arena · AIBrain
  └─ Shared/
       ├─ Signal · Config · MathUtils

StarterPlayerScripts/Client/
  ├─ init.client.luau
  └─ Controllers/
       ├─ InputController · BattleHUD · CameraController
       ├─ VFXController · CutsceneController · SoundController
       └─ CrateController

ReplicatedStorage/
  ├─ Remotes/ (Battle, ATB, Tag, VFX, Skill, Shop, Crate)
  ├─ SharedModules/ (FighterData, SkillData, ClassData, Signal, Config, TypeDefs, ShopData)
  └─ Assets/ (VFX, Sounds, Animations)

ServerStorage/Arenas/ (battle_arena_npc, battle_arena_pvp, battle_arena_boss)
```

---

###  DECISÕES CANÔNICAS — MUNDO 1

```
COMBATE
- PVE e PVP usam a mesma lógica; apenas os modelos/controladores mudam.
- Estados da batalha: IDLE → PREPARE → ATTACK → RETURN.
- Ações e trocas só são aceitas em IDLE. A troca é gratuita.
- PREPARE/ATTACK/RETURN pausam o ATB dos dois lados; ele só retoma em IDLE.
- CARREGANDO pausa apenas o ATB do caster; CAÍDO pausa apenas o ATB de quem caiu.
- Velocidade ATB base: 0.588; habilidades podem modificá-la temporariamente.
- Ataques com impacto atrasado acertam quem estiver na posição no momento
  do impacto, não necessariamente o alvo presente no início da animação.
- Morte: troca automática para um aliado vivo e ATB do novo ativo começa em 0.
- A batalha termina em derrota quando todos os bonecos selecionados morrerem, mesmo em equipes com menos de 3.
- Dodge é passivo automático; não ocupa slot de habilidade.
- Relação defensiva: multi-hit vence escudo; redução de dano vence multi-hit;
  escudo vence golpe único.
- Burn não acumula stacks: uma nova aplicação apenas renova a duração.
- Dodge é resolvido por hit e por alvo no server, antes da animação de impacto (ver Regras Globais).
- Compra com Robux ou Tinyes é direta (sem sorteio). Caixas de Sorte são gratuitas.
- Freeze de ATB fica para uma atualização futura; a fila aceita no máximo 2 efeitos e ignora aplicações extras.

DANO, ATB E PROGRESSÃO
- Cada personagem possui três slots com ranges de custo ATB:
    S1: 0.75–3.0 | S2: 4.0–7.0 | S3: 8.0–10.0
- Ao surgir na vitrine, cada slot recebe um roll t independente entre 0 e 1.
  O mesmo t define custo e multiplicador; eles nunca são rolados separados.
- Fórmula do multiplicador:
    mult = D_slot × (custo / BASE_ATB_SPEED)
- BASE_ATB_SPEED é a constante fixa 0.588. Não usar a velocidade ATB atual
  do boneco, que pode mudar temporariamente por habilidades ou efeitos.
- Duração de animação, projétil e sequência não entra no multiplicador.
  PREPARE, ATTACK e RETURN pausam o ATB dos dois lados, então esses tempos
  servem somente à apresentação e ao timing visual.
- D_slot é constante por slot. Rolls baratos/fracos e caros/fortes convergem
  para o mesmo DPS médio do slot ao longo de lutas suficientemente longas.
- Fórmula final do dano:
    levelScale = 0.5 + (((level - 1) / 29) × 0.5)
    dano = arredonda(ATK_final × mult_do_roll × levelScale)
- levelScale: lv1 = 0.5 | lv15 ≈ 0.741 | lv30 = 1.0.
- Lv1 usa somente os baseStats recebidos na loja. Do lv2 ao lv30, ganha
  +2 pontos por nível: 58 pontos de progressão disponíveis no lv30.
- HP recebe +12.5 por ponto; ATK, Dodge e Crit recebem +1 por ponto.
- Cap de pontos alocados em cada stat = nível atual do personagem.
- Dodge: cada ponto final vale 1%. Crit: cada ponto final vale 1.5%.

CURA, CHIPS E HABILIDADES
- Cura single afeta somente o personagem ativo.
- Cura AoE é dividida pela quantidade de aliados vivos.
- Cura híbrida: arredonda(min(ATK_cura × healMult, HP_MAX × capHP)).
- Caps: S1 20% | S2 30% | S3 45%; levelScale e buffs temporários não entram.
- ATK_cura inclui baseStats, pontos alocados em ATK e bônus de chips.
- Cada personagem equipa 1 chip no menu de seleção.
- Melhorias de skills ficam para uma atualização futura. Cada melhoria pode ser obtida com Robux ou com uma duplicata mais ouro; os efeitos de cada melhoria serão definidos depois.
- Resistência e Vulnerabilidade ficam para atualizações futuras, junto com outros efeitos além de Burn, Bleed e Root.

LOJA, CLASSES E PERSISTÊNCIA
- ClassData centraliza ranges de HP/ATK/Dodge/Crit e regras das classes;
  FighterData declara apenas qual classe o personagem utiliza.
- O roll de baseStats da classe é separado do roll de custo/mult das skills.
- Após a compra, baseStats, custos e multiplicadores ficam permanentes no
  DataStore daquele itemUuid; nunca são rerrolados no personagem comprado.
- Uma nova oferta rola seus valores ao nascer na vitrine. A vitrine rerrola
  quando a oferta é comprada ou no reset programado da loja.
- offerId identifica a oferta temporária; itemUuid identifica o personagem
  permanente no inventário.
- Estoque da loja é pessoal por client (mesmas estantes, conteúdo individual): uma compra remove só
  a oferta do comprador e aciona o reabastecimento do estoque dele.
- ShopState vive na memória do servidor; inventário comprado vive no DataStore.
- Loja progressiva libera personagens conforme história/discos.
- Raridades: Comum, Rara, Épica e Lendária.
- Classes: Fury, Menace, Dominator, Support e Controller.

ARQUITETURA E APRESENTAÇÃO
- Servidor é a fonte da verdade e valida ATB, estado, custo, alvo, dano,
  troca, morte, compra e persistência. O client prevê e apresenta a UI.
- Framework usa Signal para comunicação; init.server e init.client controlam
  a ordem Init → Start.
- Arenas são clonadas do ServerStorage para cada batalha e destruídas ao fim.
- Lados da arena são sorteados; cada jogador enxerga a câmera pelo próprio lado.
- Ataques usam câmera cinematográfica fullscreen; ultimates seguem a mesma
  estrutura, com duração e apresentação maiores.
- As marcas da barra são os ícones dos slots, visíveis para os dois lados. Interagir revela a descrição;
  dano e custo de ativação só aparecem para o dono. Os efeitos de Buff/Weak aparecem para ambos.
- HUD de troca abre ao clicar no personagem ativo; PVE pausa durante o menu.
- Menu de seleção libera GO quando existe pelo menos 1 personagem selecionado.
- AI comum possui tiers Bronze/Prata/Ouro.
- A personalidade adaptativa é exclusiva do Rival PVE e usa sistema separado.
- Números de dano usam pool de BillboardGuis; multi-hit exibe um número por hit
  e DoTs próximos podem ser agrupados visualmente.
- Torneio é conteúdo de atualização futura: equipe de 6, troca de bonecos e sem recuperação automática de HP entre lutas.
- Perder uma batalha encerra a tentativa do torneio, que recomeça da primeira luta; bonecos mortos continuam mortos até serem revividos por uma Rokaka ou o torneio terminar.
```

---

### REGRAS GLOBAIS DE COMBATE (adições desta revisão)

```
RESOLUÇÃO DE HIT, DODGE E ANIMAÇÃO
- Cada boneco tem uma hitbox (retângulo) que os ataques miram.
- O server resolve o resultado ANTES de tocar a animação de impacto: rola o Dodge e envia ao client
  { hit, damage, target }. O client escolhe a sequência: acerto → animação de golpe;
  Dodge → animação de esquiva + "DODGE" sobre o ataque, sem dano. Nunca se interrompe uma animação no meio.
- Multi-hit: 1 roll de Dodge por hit (Esquilos do Kars, Thompson do Joseph).
- AoE: 1 roll por alvo atingido.
- Projétil/delay: o roll acontece no impacto real, não no lançamento.
- Dodge bem-sucedido desliga a hitbox daquele hit.
- VFX e dano disparam por marcadores na timeline da animação (GetMarkerReachedSignal).

TIME STOP (exclusivo de DIO Pt3 e Jotaro)
- Conjurado 2 vezes: a segunda conjuração ativa o poder.
- Duração por slot: DIO 3/5/7s | Jotaro 3/4/5s. Limite de 2 ações dentro do TS (melhoria futura: 3).
- Durante o TS a ATB do dono carrega a 75% da velocidade base (0.441 com base 0.588; era 0.3 sobre 0.4).
- Ações dentro do TS ignoram Dodge; só o Escudo ainda bloqueia o primeiro hit.
- "Tempo parado" dentro de animações de skills é puramente visual (a ATB dos dois lados já está pausada
  pelo estado de animação); só o TS real (S3) muda as regras.

COUNTER (Kars Perfeito)
- Entra em PREPARE por 1–1.5s. Se ninguém atacar nesse tempo, volta ao IDLE (ATB gasto, nada acontece).
- Se for atingido (qualquer ataque): ATTACK (resposta) → RETURN. Dano escala com o slot, como qualquer ataque.
- Resposta corpo a corpo e resposta à distância têm animações diferentes; o dano é o mesmo.
- Quem ataca dentro da postura toma o counter, inclusive o Iggy em Fly.

ESCUDO / ROOT / STUN
- Escudo (ex.: barreira do Kakyoin): bloqueia o próximo hit; multi-hit passa pelo restante.
- Root: impede só a TROCA; o alvo ainda age, esquiva e ataca. Durações 5/8/12s por slot (Joseph Pt2, Avdol).
- Stun (planejado): o alvo não age nem troca. Em AoE todos os alvos recebem o timer ao mesmo tempo
  (quando o do ativo acaba, os do banco já acabaram). O Dodge do alvo ainda pode evitar o golpe que aplicaria o Stun.

MINI-BONECOS DE CAMPO
- Invocações (ex.: Sensor do Avdol) são bonecos temporários com HP 1 e hitbox normal; usam o mesmo
  pipeline de dano/morte; qualquer dano (inclusive AoE) as destrói; Block as impede de nascer.

SKILLS: TEXTO DE DESCRIÇÃO
- Descrições curtas, que também servem de tutorial (ler ao segurar a skill).
- Piadas ficam entre parênteses e NUNCA carregam informação mecânica obrigatória.

EMOTES / DANÇAS
- Vitória: dança aleatória do pool, automática, feita pelo BONECO.
- Provocação em luta: o player ativa; o boneco faz o emote; a ATB continua enchendo; sem proteção.
  Interrompe se trocar de dança ou tomar dano; um Dodge bem-sucedido não interrompe.
- Fora de luta: emotes do avatar do player. Emotes extras vendáveis: pós-lançamento.
```

---

### KITS DOS PERSONAGENS (Mundo 1)

```
Convenções: S1/S2/S3 seguem a ordem do kit. "Melhoria" = upgrade futuro (adiciona/melhora efeito, não aumenta dano).
⚠ = depende de efeito que a lista de lançamento marca como futuro (ver Pendências).
"Condicional" = Burn só em vampiros ou classes em desvantagem.
```

**1. DIO Pt1 — Menace (Vampiro)**
- S1 Raio laser: AoE; o dano total se divide pelos alvos vivos do time inimigo (até ÷3)
- S2 Drenar: avança, agarra o peito e suga vitalidade; dano + cura pela fórmula híbrida padrão
- S3 Congelar: reseta o ATB do oponente para 35% / 45% / 60% do valor atual (por slot); sem efeito útil contra ATB baixo

**2. Jonathan — Fury (Hamon)**
- S1 Barragem de Sunlight Yellow Overdrive: com carga de Hamon, Burn condicional (melhoria: Burn nativo). Consome 2 cargas
- S2 Luck & Pluck carregada de Hamon: cortes com Burn condicional (a espada vem do Bruford, lore)
- S3 Respira e carrega Hamon: 3 cargas, aumenta os próximos 3 hits

**3. Will Anthonio Zeppeli — Support (Hamon)**
- S1 Braço esticado + Sunlight Yellow Overdrive: dano + Burn condicional
- S2 Respira e carrega Hamon (3 cargas): sem dano; paga ATB médio para multiplicar os próximos 3 hits
- S3 Sapo: sapo aparece sobre o alvo, Anthonio avança e o soco com Hamon atravessa o sapo (ileso); setup + dano alto

**4. Bruford — Controller / 5. Tarkus — Dominator (Dupla, 1 slot)**
- Bruford S1: cabelo estica e dá rasteira (melhoria: fraqueza / perda de dano)
- Bruford S2: arremessa a Luck & Pluck, salta e pega de volta (retorno é animação cômica, sem efeito mecânico)
- Bruford S3: Alternar para Tarkus
- Tarkus S1: avança com a mão aumentada e soca | S2: correntes do chão, AoE + Bleed | S3: Alternar para Bruford
- Alternar: base custa ATB; evoluído não custa. Posição final do slot a definir (S2 cogitado)

**6. Joseph Pt2 — Fury (Hamon)**
- S1 Tampinha com Hamon: dano + Burn condicional
- S2 Boleadeiras com Hamon: dano + Burn condicional + Root (5/8/12s por slot)
- S3 Thompson: 30 tiros na animação, 7 hits reais fracionados (Dodge por hit)
- Passivo: ao esquivar, pose + frase de efeito e 1 efeito aleatório do pool {buff leve de ATK, buff leve de Crit,
  cura leve, 1 carga de BuffMulti}; só reativa depois de mais 1 Dodge sem bônus

**7. Caesar — Dominator (Hamon)**
- S1 Bolhas prendem o alvo e explodem: Burn condicional
- S2 Bolhas de alta rotação: dano + Bleed leve
- S3 Bolhas orbitando (canal): cast de ~1s (qualquer hit, DoT ou stun nesse 1s cancela e o ATB se perde);
  depois do cast o canal é intocável até acabar. Reutilizar renova o tempo, não empilha
```
Tabela do canal (ATK 15)       slot | custo ATB | mult/tick | duração | ticks | dano total
                                  1 | 2.50      | 2.33      | 4s      | 2     | 14.0 (7 por bolha)
                                  2 | 5.50      | 1.10      | 7.5s    | 5     | 16.5 (3.3 por bolha)
                                  3 | 8.75      | 0.55      | 16s     | 12    | 19.8 (1.65 por bolha)
Uma bolha a cada 1.5s. Esta skill usa números fixos (sem roll); S1 e S2 usam o multiplicador do roll.
Só vale a tabela por slot quando as skills puderem ser reorganizadas (futuro).
```

**8. Lisa Lisa — Support (Hamon)**
- S1 Chute giratório (melhoria: Slow na ATB, velocidade 0.2 por alguns instantes)
- S2 Libera Hamon e remove efeitos negativos do time ⚠ (Clean mais fraco que a Flecha: dura menos, sem imunidade,
  e alguns efeitos ficam sem poder ser limpos — lista a definir). Melhoria: cura cada aliado vivo pela fórmula híbrida padrão
- S3 Puxa com o cachecol e acerta o peito com Hamon (melhoria: Vulnerabilidade ⚠ 10/20/30s por slot, +25% de dano recebido)

**9. Stroheim — Menace (Cyborg)**
- S1 Laser ultravioleta: Burn leve em vampiros
- S2 Granada: ele e o alvo tomam o mesmo dano (pode matar o Stroheim); depois ganha reserva de BuffMulti padrão
  (decidir se é base ou só melhoria)
- S3 Canhões UV (AoE): em vampiros Burn + Stun ⚠, nas classes em desvantagem só Burn. O Stun atinge os 3 do time em paralelo

**10. Kars — Controller (Pillar Man; evolui para Kars Perfeito)**
- V1 S1: pula e chuta, dano reduzido + Stun ⚠ com duração lerp(0.5s, 1.5s, t) (mesmo t do roll do slot)
- V1 S2: lâminas, combo de cortes + Bleed
- V1 S3: corte em linha reta, dano em grupo (AoE)
- Combo possível: guardar ATB, usar S1 e emendar S2 durante o Stun (o Dodge ainda age contra o S1)
- Kars Perfeito S1: soco de Hamon perfeito, dano + Burn
- Kars Perfeito S2: Counter (ver Regras Globais)
- Kars Perfeito S3: dois esquilos mordem os pés (2 hits, cada um com metade do dano, Dodge por hit); Bleed calculado
  sobre o dano que realmente conectou
- Evolução (só pelo jogo, não vem da loja): com Kars, Esidisi e Wamuu no mesmo time, em qualquer modo —
  (a) Wamuu dá o golpe final num Caesar; (b) Esidisi dá o golpe final em qualquer boneco (ordem livre, em partidas
  diferentes se quiser); e, na MESMA partida, Esidisi e Wamuu morrem e o Kars vence vivo. Ganha a pedra e evolui

**11. Esidisi — Controller (Pillar Man)**
- S1 Bolas de sangue quente: Burn leve | S2 Veias sugam vitalidade: dano + cura | S3 Puxa com as veias e chuta

**12. Wamuu — Dominator (Pillar Man)**
- S1 Divine Sandstorm: dano
- S2 Chifre puxa o alvo e destroços: dano em ticks; gasta TODO o ATB atual do Wamuu aos poucos, a cadência de hits
  aumenta perto de zero; qualquer hit/DoT/stun cancela e o ATB gasto se perde
- S3 Redemoinho-chicote: levanta o alvo, bate no chão e segue batendo

**13. Jotaro — Fury (Star Platinum)**
- S1 Dedinhos: dano + cegueira (o alvo tem mais chance de errar o próximo ataque por alguns segundos)
- S2 ORA ORA: série de golpes; com Time Stop ativo, Star Platinum bate no chão e causa Stun leve ⚠ quando o tempo volta
- S3 Time Stop (ver Regras Globais)

**14. Avdol — Controller (Magician's Red)**
- S1 Sensor de Calor (mini-boneco HP 1): dura 15/25/35s por slot; a cada 5s detecta vida e dá ao time um buff
  aleatório de dano ou HP; máximo de 2 sensores
- S2 Cross Fire Hurricane: linha reta, explode em área, Burn no boneco ativo (se o alvo trocar, o Burn continua no novo ativo)
- S3 Chicotes de fogo: Root 5/8/12s (melhoria: Root mais longo + Burn leve)

**15. Kakyoin — Controller (Hierophant Green)**
- S1 Emerald Splash: 3 hits
- S2 Barreira de tentáculos: Escudo que bloqueia o próximo hit
- S3 Zona de 20m por 20s: sempre que o inimigo ataca, devolve parte do dano (até 40% no S3; os outros slots devolvem menos, valor a definir);
  vale para o time todo e persiste se o Kakyoin sair; o reflect pode ser esquivado ou bloqueado

**16. Polnareff — Fury (Silver Chariot)**
- S1 Ponta da espada: dano rápido (melhoria: Vulnerabilidade ⚠ no alvo)
- S2 Tira a armadura: ATB sobe a 1.5× a velocidade base por 10/15/22.5s (por slot), mas fica com -40% de defesa
  (vulnerável); buff só dele (ao trocar a ATB volta ao normal; ao voltar retoma até acabar)
- S3 Vários cortes: Bleed; mais dano se estiver sem armadura

**17. Joseph Pt3 — Fury (Hermit Purple)**
- S1 Quebra a câmera e vê o futuro: 100% de esquiva no próximo ataque recebido (dura até ser consumido; contra multi-hit
  desvia 25% dos golpes). Interação futura com "ignora Dodge": 50% de chance de anular
- S2 Hackeia o controle e chama um drone que explode o time inimigo (AoE)
- S3 Hermit Purple enrola o alvo e solta descarga de Hamon: Burn condicional

**18. Iggy — Controller (The Fool)**
- Modelo: Humanoid padrão menor com mesh de cachorro por cima e a hitbox padrão; animações próprias
- S1 Mordida no rosto + peido (melhoria: o peido dá buff de ataque ao time)
- S2 Plana, intocável por 4/5/6s (por slot), mas ainda pode atacar; não limpa efeitos já aplicados; sofre Counter se bater na postura
- S3 Agarra o alvo, sobe e desce girando, batendo no chão

**19. DIO Pt3 — Menace (The World)**
- S1 Facas: 6 facas, base 2 inescapáveis / 4 dodgeáveis (melhoria: 4 / 2)
- S2 Placa de stop: 3 hits, o último com Stun leve ⚠; durante Time Stop vira Rolo Compressor (mais dano, sem Stun)
- S3 Time Stop (ver Regras Globais)

**Personagens futuros (mini-updates)**
- Prioridade: Enya the Hag (fecha com a lore das bonecas) e Vanilla Ice. Fila: Hol Horse, Rageed Man, Gray Fly, N'Doul, Pet Shop.
- Anubis (Menace; hospedeiro = espadachim genérico amaldiçoado, modelo fixo e colecionável):
  S1 boomerang | S2 "possessão" (tudo numa animação: dano no alvo + dano espalhado nos outros do time) |
  S3 Modo de Adaptação 10/15/25s: cada hit direto recebido dá 1 stack temporário de BuffMulti padrão e +1 de força
  permanente até o fim da batalha, sem limite (multi-hit conta como 1 evento; DoT não conta)

---

### UI — TELAS E COMPONENTES

```
TODA a UI será terceirizada; este bloco é o briefing.

HUD DO MUNDO ABERTO (tela inicial permanente)
- Caixinha com o saldo de Tinyes sempre visível
- Atalhos (inventário, loja, ...): ainda a definir (pendente)

DIÁLOGO COM NPC (igual para todos, inclusive Rival e NPCs de história)
- [E] → barras pretas descem → câmera atrás do player (parte da cabeça + corpo do NPC)
- Caixa embaixo com a foto do NPC e o texto digitando
- Ao terminar: Sair / Conversar mais / Batalhar (Batalhar leva ao Menu de Seleção)

CAIXA DE SORTE (resgate)
- Abre um viewport com o modelo do prêmio
- Moeda: o valor aparece pulando na tela | Boneco: animação de baú da loja, clica para abrir e clica para fechar e receber
- Chip: mostra o chip e, embaixo, a descrição

MENU DE SELEÇÃO: ver o fluxo (6 slots, campo com 3 círculos, Ready Check de 240s).

HUD DE BATALHA
- Barras ATB (alguém vai fazer), uma cor diferente por boneco; ambos veem as duas barras
- Troca (Tag): caixinha com os desenhos dos bonecos no canto esquerdo das barras; clicar sobe e mostra os 3;
  mortos ficam cinza com um X
- Marcas na barra = ícones dos slots (descrição só do dono para dano/custo; ver Decisões Canônicas)
- Efeitos de Buff/Weak mostram VFX de UI para os dois lados
- Números de dano: pool de BillboardGuis; sem "0"; onomatopeias e impacto ficam como VFX (barra preta etc.)

INVENTÁRIO
- Lista/grade de bonecos; clicar abre status + gráfico radar de 4 eixos (HP, ATK, Dodge, Crit)
- Distribuir pontos aqui (respeitando o Sistema de Pares e o cap por nível); o radar atualiza em tempo real
- Boneco que subiu de nível aparece piscando

LOJA: telinha de detalhe com o radar atrás do boneco (ver Sistema de Loja).

PVP (duas formas)
- Fila automática: servidor escolhe o oponente por elo próximo; a GUI só anuncia "oponente encontrado" e segue
  para o Ready Check. É o único modo que conta para ranking/elo
- Desafio manual: lista de players online (filtro por elo) + convite que o outro aceita. Casual: sem elo,
  só XP normal e Tinyes de vitória
```

---

### VFX, ANIMAÇÃO E RIG

```
- Todos os bonecos usam um Humanoid padrão; os VFX nascem no RootPart ou em Attachments padronizados
- O VFX pergunta ao Fighter onde fica o ponto ("Peito", "MaoDireita", ...) em vez de depender da
  estrutura de cada rig; qualquer boneco novo precisa trazer os mesmos Attachments
- Tempo: marcador de animação → dispara o VFX/dano. Posição: Attachment (WorldCFrame).
  Com Qwinkle's Particles: :EnableEmitAt(item, CFrame) para nascer num ponto, :AbsoluteEmit(rig)
  para um rig de VFX completo
- VFX compostos são fases encadeadas (sai da mão → viaja → chega → nasce → explode); o dano já foi
  resolvido pelo server antes
- Iggy: mesmo esqueleto Humanoid, mas animações próprias (proporções diferentes)
```

---

### ROADMAP PÓS-LANÇAMENTO E LONGEVIDADE

```
Princípio: mundo novo é raro; o motor de retenção é conteúdo vertical (profundidade do que já existe).
1. Melhorias de skill por slot (estilo evolução do Clash Royale): mudam o EFEITO, não o dano. Custo em
   duplicatas escala com a força do efeito e a raridade (efeitos tipo "ignora Dodge" custam mais)
2. Season/Ranking PVP com reset + matchmaking por elo + modo espectador (visão completa, câmera própria)
3. Battle Pass e missões diárias/semanais
4. Skins, cosméticos e emotes (puramente visuais)
5. Boss rotativo semanal (mesma instância pessoal, regras que mudam), guildas/clãs, universos alternativos
6. Companheiros: Stands que não lutam e são ativados temporariamente (ex.: Sun)
7. Torneio (bag de 6), Block, Stun, Clean e demais efeitos hoje marcados como futuros
Ideias a decidir depois do primeiro playtest:
- Tempo de luta: tempo normal + overtime (mais rápido ou dano contínuo até a morte) só para Ranked/Torneio;
  o overtime precisa bloquear/neutralizar cura para não virar exploit de Support; PVE sem limite
- Playtest antes de fixar qualquer número de duração, Vulnerabilidade, Iggy, Anubis
- Com ATB 0.588, revisar efeitos medidos em segundos (Root, zona do Kakyoin, Fly do Iggy) e DoTs/Sensor
- Renomear BASE_ATB_SPEED para DAMAGE_CALIBRATION_SPEED (é diferente da velocidade atual do boneco)
```

---

### PENDÊNCIAS E CONFLITOS (decisões para você confirmar)

```
1. Cadência de Burn/Bleed: apliquei 3s com 1 tick/s (o que você confirmou). Você também falou em "tick a cada 3s";
   a alternativa 9s/3 ticks segue em aberto. Bleed também não empilha? (supus que sim)
2. Estoque da loja: apliquei ESTOQUE PESSOAL por client (sua ideia inicial e minha recomendação). O GDD antigo dizia
   "compra remove a oferta para todos". Confirma?
3. Kits usam efeitos que a lista de lançamento marca como futuros (Stun, Vulnerabilidade, Clean). Escolher: antecipar
   os efeitos, trocar por outros, ou aceitar que essas skills ficam incompletas até o update
4. Chips adiados vs. chip como prêmio de caixa/Rival
5. S3 "bloqueado até o Lv5": o slot fica travado, ou só a skill? O que o boneco faz no Lv1–4?
6. HUD de troca: o GDD diz "clicar no personagem ativo"; a conversa definiu uma caixinha à esquerda das ATBs
7. Cutscene: "VS splash / BATTLE START!" foi substituído pelo 3-2-1-GO?
8. Dupla: sua regra (parceiro recebe 34%, +10% de dano ao sobreviver) mudou o "HP extra completo" que discutimos;
   revisar o custo de Alternar e em qual slot ele fica
9. Lisa Lisa S2: cura AoE é dividida pelos vivos (regra geral) ou valor cheio por aliado?
10. Esidisi S2 é igual ao DIO Pt1 S2 (dreno + cura); Jonathan e Anthonio ainda se sobrepõem. Diferenciar
11. Polnareff: com base 0.588, qual a velocidade do buff (1.5× ≈ 0.88)? O timer corre enquanto ele está no banco?
12. Time Stop × Counter do Kars; duração do Stun do Stroheim; Kakyoin S3 nos outros slots
13. Evolução do Kars: o progresso de (a)/(b) fica salvo para sempre? Stroheim S2: buff vem de base ou melhoria?
14. Caixa de Sorte: pesos Tinyes/Boneco/Chip; Tinyes na derrota
15. Vulnerabilidade 10/20/30s (Lisa), invulnerabilidade do Iggy e scaling sem teto da Anubis: monitorar em playtest
```

---

*GDD focado no Mundo 1 / Lançamento. Mundo 2 e 3 serão adicionados em updates futuros.*
