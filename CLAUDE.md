Crie a arquitetura base compartilhada do projeto Tiny Adventures em roblox-ts dentro de src/shared/ (TypeDefs.ts, Config.ts e ClassData.ts), garantindo zero 
 erros no rbxtsc:                                                                                                                                              
1. Config.ts:                                                                                                                                                  
    • BASE_ATB_SPEED = 0.588 (velocidade base da barra ATB de 0 a 10).                                                                                         
    • Ranges de custo ATB por slot: S1: [0.75, 3.0], S2: [4.0, 7.0], S3: [8.0, 10.0].                                                                          
    • Constantes D_slot: S1 = 0.2145, S2 = 0.1373, S3 = 0.1825.                                                                                                
    • Cura híbrida: S1: { healMult: 0.55, capHP: 0.20 }, S2: { healMult: 1.10, capHP: 0.30 }, S3: { healMult: 1.40, capHP: 0.45 }.                             
    • Progressão: MAX_LEVEL = 30, +2 pontos por nível (total 58), HP +12.5/pt, ATK +1/pt, Dodge +1%/pt, Crit +1.5%/pt, diferença máxima de 5 pontos nos pares  
(ATK/Dodge e HP/Crit).                                                                                                                                         
2. ClassData.ts:                                                                                                                                               
    • Ranges de baseStats:                                                                                                                                     
        • Fury: hp [13, 17], atk [8, 12], dodge [5, 8], crit [8, 12]                                                                                           
        • Support: hp [8, 15], atk [4, 7], dodge [8, 14], crit [3, 6]                                                                                          
        • Controller: hp [16, 20], atk [6, 10], dodge [5, 8], crit [5, 8]                                                                                      
        • Dominator: hp [14, 18], atk [7, 11], dodge [3, 6], crit [6, 10]                                                                                      
        • Menace: hp [12, 16], atk [9, 13], dodge [4, 7], crit [7, 11]                                                                                         
    • Triângulo de Counter (+17.5% de dano): Fury > Menace > Dominator > Fury.                                                                                 
3. TypeDefs.ts:                                                                                                                                                
    • Tipos estritos para ClassName, Rarity (Comum | Rara | Épica | Lendária), BattleGlobalState (IDLE | PREPARE | ATTACK | RETURN), FighterLocalState (NORMAL 
 | CARREGANDO | CAIDO), StatusEffect (Burn | Bleed | Root), SkillSlotRoll (t, cost, mult), FighterInventoryItem (itemUuid, fighterId, level, xp, baseStats,    
allocatedStats, skills, equippedChip) e estado especial da dupla Bruford/Tarkus (partnerHp, activeMember).                                                     
Escreva apenas código limpo, bem tipado e sem dependências externas desnecessárias.                                                                            
  c:\Users\Administrator\Desktop\Tiny_Adventures_GDD_Mundo1_Lancamento.txt # Regras do Projeto (roblox-ts + Rojo)                                              
                                                                                                                                                               
- Este é um projeto **roblox-ts** compilado para Luau via `rbxtsc` e sincronizado com o Roblox Studio via **Rojo**.                                            
- **NUNCA** use APIs de Node.js ou navegador (`setTimeout`, `fetch`, `fs`, `console.error` nativo, etc.). Use apenas `@rbxts/*` e os serviços nativos do       
Roblox (`Players`, `Workspace`, `ReplicatedStorage`, `RunService`).                                                                                            
- Use `task.wait()`, `task.spawn()` e `task.delay()` em vez de `wait()` ou `spawn()`.                                                                          
- Em arrays do `roblox-ts`, lembre-se que métodos mutáveis seguem o padrão do compilador (`arr.push()`, `arr.size()` em vez de `.length`).                     
- Sempre importe serviços usando `import { Players, ReplicatedStorage } from "@rbxts/services";`.                                                              
- Antes de concluir qualquer tarefa, rode `npx rbxtsc` no terminal para garantir que o código TypeScript compila para Luau sem nenhum erro de tipo.            
- Mantenha a arquitetura separada entre `src/server`, `src/client` e `src/shared`.                                                                             
-  Use sempre Workspace.Raycast() com RaycastParams e GetMarkerReachedSignal() para eventos de animação
-sempre salva o jogo a cada alteraçao pra evitar perdas de crash ou qualquer coisa

# Regras de Progressão / XP Pós-Batalha

- **Pool total:** `totalBattleXp = XP_BATTLE_BASE + (XP_BATTLE_PER_ENEMY_LEVEL * avgEnemyLevel)` (`75 + 15 × nível médio inimigo`), pago somente em vitória PvE (derrota, fuga, desconexão, timeout ou PvP = `0`).
- **Divisão oficial do pool por quantidade de lutadores válidos no time (100% do pool sempre aproveitado):**
  - **1 boneco = 100%** (`XP_SHARE_SOLO = 1.0`)
  - **2 bonecos = 50% / 50%** (`XP_SHARE_DUO_EACH = 0.5`)
  - **3 bonecos = 50% maior dano / 25% / 25%** (`XP_SHARE_TRIO_TOP_DAMAGE = 0.5` para quem causou mais `damageDealt`; `XP_SHARE_TRIO_OTHER = 0.25` para os demais; empate no maior dano desempata deterministicamente pela ordem dos slots: `índice 0 > índice 1 > índice 2`).
- **Slots vazios/inválidos/duplicados:** ignorados antes da divisão (não contam nem roubam percentual dos lutadores válidos).
- **Ordem do pipeline:** pool total -> fração por tamanho do time -> multiplicador individual por diferença de nível (`diff = charLevel - avgEnemyLevel`, tabela em `Config.ts`) -> `math.max(XP_MIN_AWARD, math.floor(rawXp))` se a fatia base > 0 (limitado ao teto útil até `MAX_LEVEL = 30`, residual zerado no cap).
