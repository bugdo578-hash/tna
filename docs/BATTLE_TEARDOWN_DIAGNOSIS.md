# Encerramento da batalha — diagnóstico e validação (2026-11-16)

## Reprodução antes da correção

Lidos `CLAUDE.md`, `docs/HANDOFF.md`, `BattleHUD.ts`, `CombatController.ts` e `BattleSessionService.ts`, além dos consumidores e da liberação de movimento. Reprodução dos handlers em Play no Studio com controllers isolados e payloads de cada cenário, antes das alterações. Não foi um duelo manual entre dois clientes reais.

| Cenário | Client ao receber BattleEnded, antes | BattleHUD que sobrava | ClientBattleStage | Cards XP |
| --- | --- | --- | --- | --- |
| Vitória PVE | Marca fim e abre resultado de vitória | Habilitado; “Fechar e reiniciar” escondia só o overlay e deixava o HUD se nenhuma nova luta começasse | Presente imediatamente, destruído após 2s no caminho normal | Presentes quando recebidos; animação até fechar/concluir |
| Derrota PVE | Marca fim e abre derrota | Habilitado até fechar o resultado | Mesmo atraso de 2s | Ausentes |
| Quit PVE | O clique apenas enviava RequestQuit; BattleEnded abria derrota | Habilitado até fechar o resultado | Mesmo atraso de 2s | Ausentes |
| Vitória PVP | Marca fim e abre vitória | Habilitado até fechar o resultado | Mesmo atraso de 2s | Presentes quando recebidos; bloqueio de prêmio pode omiti-los |
| Quit PVP | Abre derrota de quem sai e vitória do outro participante | Habilitado nos dois clientes que recebem o fim | Mesmo atraso de 2s | Somente vencedor elegível |
| Desconexão do oponente | Abre vitória de quem continua | Habilitado até fechar o resultado | Mesmo atraso de 2s | Somente vencedor elegível |
| Erro sem vencedor/XP | PVE abre derrota; PVP usa resultado sem vencedor | Habilitado até fechar o resultado | Mesmo atraso de 2s | Ausentes |

Em todos os caminhos normais, `clearHpTweens()` cancelava os tweens de HP. Os tweens de combate (movimento, Stand e popups) não eram registrados nem cancelados explicitamente. Markers de animação não tinham desconexão explícita; callbacks atrasados dependiam de tokens ou da existência dos modelos. Cards de XP mantinham suas próprias conexões/tweens enquanto o resultado estava aberto.

O caminho sem vencedor foi reproduzido em PVE antes da correção; a apresentação PVP sem vencedor foi identificada em `applyPvpResult` e validada após a correção nos testes isolados e por RemoteEvents.

Falha de renderização de XP injetada **antes da correção**: `onBattleEnded` lançou erro e deixou `battleActive=true`, `battleEnded=false`, pois `xpCards.show()` precedia a transição de estado. A inspeção mostrou mais dois pontos de interrupção: o guard `hasResultGui()` retornava sem limpar o restante do HUD e `flushPendingDeaths()`/banner podiam falhar antes de agendar a destruição do palco.

## Servidor

Os caminhos de vitória, derrota, Quit, desconexão, timeout, falha no início e erro de step/pedido convergiam para `finishSession`/`destroySession`. `releaseSession` chamava o callback que libera movimento/atributo em NPC/PVP. Duas lacunas:

- Concessão de XP/Tinyes ficava fora do `pcall` de envio. Reprodução PVP com erro na recompensa do vencedor: sessão removida e callback de liberação executado, mas **zero BattleEnded** aos dois participantes conectados. `session.ended=true` também impedia outra tentativa de fim.
- `destroySessionForPlayer` é usado em `CharacterRemoving`, além de saída do jogo. O parâmetro de exclusão omitia o próprio jogador ainda conectado durante respawn.

Agora recompensas e envios são isolados por participante, mantendo `rewardPaid` e as regras econômicas anteriores. Todos com `Parent === Players` recebem uma tentativa privada de `BattleEnded`; quem efetivamente saiu de Players é ignorado. Falha de envio é avisada, não impede o envio aos outros, e não pode garantir entrega ao destinatário com transporte falho. Liberação de WalkSpeed, JumpPower, JumpHeight, UseJumpPower e NpcBattleActive tem proteção e aviso independentes. Erro ao destruir IA/desconectar evento não impede a remoção das referências da sessão.

## Comportamento corrigido

`BattleHUD.teardownBattle()` é a entrada única para encerramento e fechamento do resultado. Oculta HUD/overlays, limpa confirmação de Quit, HP e XP, desconecta callbacks/Heartbeat da batalha e libera os recursos do CombatController. Cada etapa usa `battleCleanupStep` (`pcall` com `warn`); conexões, tasks, tweens e tracks também são liberados individualmente. O palco é destruído imediatamente, sem um timer de fim antigo capaz de atingir outra batalha. Os listeners de rede e botões que pertencem à vida do controller continuam disponíveis para a próxima luta; `destroy()` também os desconecta.

| Cenário | HUD após fim | Palco após fim | Resultado separado BattleResult | XP/tweens |
| --- | --- | --- | --- | --- |
| Vitória PVE | Oculto | Destruído | Vitória | Cards recebidos; animação de resultado, independente do combate |
| Derrota PVE | Oculto | Destruído | Derrota | Sem cards |
| Quit PVE | Oculto no clique confirmado | Destruído no BattleEnded | Nenhum por padrão | Recursos de combate/XP limpos |
| Vitória PVP | Oculto | Destruído | Vitória | Cards somente quando recebidos |
| Quit PVP | Oculto no clique confirmado de quem sai; oculto no fim para o outro | Destruído no BattleEnded | Quem sai: nenhum; vencedor: vitória | Cards somente do vencedor quando recebidos |
| Desconexão do oponente | Oculto | Destruído | Vitória de quem fica | Cards quando recebidos |
| Erro sem vencedor/XP | Oculto | Destruído | Nenhum | Recursos limpos |

O resultado normal permanece em `BattleResult`, separado do BattleHUD, para preservar recompensas. Fechar, “Fechar e reiniciar” ou iniciar outra batalha limpa cards, tweens e conexões desse resultado. `UITheme.ShowResultOnLocalQuit=false` é a política padrão, alterável pelo autor. O primeiro clique em Quit só pede confirmação; no segundo, somente o HUD fecha imediatamente. O palco e a sessão aguardam a confirmação do servidor. Fechar resultado/reiniciar e `/testxp` não encerram uma batalha ativa; nenhum timeout local decide seu fim.

## Testes executados

- `npx.cmd rbxtsc`: zero erros.
- `BattleSimulator.runSimulation()`: `SIMULATION_ALL_PASSED`, incluindo as 2.000 lutas e as regressões existentes. Novo `validateBattleTeardownLifecycle`: `BATTLE_TEARDOWN_LIFECYCLE_PASSED`, com 14 saídas/falhas, notificações a todos os conectados, limpeza única, movimento restaurado e NpcBattleActive falso. Ajustada uma fixture antiga de desconexão para realmente remover `Parent` de Players.
- `tools/battle-teardown-client-qa.luau`: `BATTLE_TEARDOWN_CLIENT_PASSED`, **526 verificações**, em Play novo com require limpo. Inclui os cenários pedidos, ambos os lados do PVP, Quit em dois cliques/política configurável, ausência de vencedor/XP, timeout, erro no renderizador/limpeza de XP, erro em tween/conexão/track, modal destruído, descarte de callbacks antigos, fechamento/reinício sem nova batalha e batalha seguinte viva além do antigo atraso.
- `tools/battle-teardown-live-qa.luau`: `BATTLE_TEARDOWN_LIVE_PASSED`. **Nove cenários por RemoteEvents reais** no cliente conectado: vitória/derrota/Quit PVE, vitória/Quit local/Quit adversário/desconexão PVP e erro sem vencedor PVE/PVP. Todos observaram `BattleHUD.Enabled=false`, palco ausente, `NpcBattleActive=false` e movimento original restaurado. XP sintético testa a GUI sem escrever perfis; derrota/Quit/erro não deixam cards. Probe temporário removido no fim.
- `git diff --check`: passou.

Limite do ambiente: MCP disponibiliza um client real. Destinatários e estado do segundo participante PVP foram exercitados com mock no servidor; não se declara playtest manual simultâneo com dois clientes reais. Nenhuma alteração de saldo/perfil nos testes novos.

Para repetir o teste live, criar no Server `ReplicatedStorage.BattleTeardownQAProbe` como RemoteFunction; executar o arquivo no Client para instalar o probe e depois no Server para rodar os cenários. O teste isolado roda diretamente no Client. Usar Play novo após `rbxtsc`/Rojo para evitar módulos antigos em cache.
