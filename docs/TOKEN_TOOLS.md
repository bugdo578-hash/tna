# Ferramentas locais para economizar contexto

Os executaveis ficam em `.tools/`, ignorado pelo Git. Nao sao dependencias do jogo.

## RTK 1.2.0

Instalado a partir do release oficial Windows x64, com SHA256 conferido contra
`checksums.txt` do mesmo release:
https://github.com/rtk-ai/rtk/releases/tag/v1.2.0

No PowerShell:

```powershell
./.tools/rtk/rtk.exe git status
./.tools/rtk/rtk.exe git diff --stat
./.tools/rtk/rtk.exe gain
```

`AGENTS.md` orienta o uso explicito. `.codex/hooks.json` registra a integracao
local gerada por `rtk init --codex`, usando o executavel do projeto.
Reabra a sessao para o host carregar o hook; se pedir confianca, revise e aceite
na interface. O suporte a hooks depende do host. Nesta sessao, use o caminho
explicito. O aviso de hook global ausente nao impede os comandos diretos.

## Headroom 0.44.0

Ambiente Python isolado, pacote base, sem extras de ML ou proxy:

```powershell
python -m venv .tools/headroom
./.tools/headroom/Scripts/python.exe -m pip install -r tools/headroom-requirements.txt
./.tools/headroom/Scripts/python.exe tools/compress-log.py caminho/arquivo.log
```

O script ativa `HEADROOM_OFFLINE=1`, mostra os tokens antes/depois em stderr e
imprime o log comprimido. Preserva o arquivo original para investigar contexto
omitido. Nao configura proxy, nao altera a conversa atual e nao exige chave de IA.
Use para logs grandes; para codigo, prefira buscas e leituras direcionadas.

O build continua sendo `npx.cmd rbxtsc` no Windows PowerShell.
