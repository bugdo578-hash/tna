# Infraestrutura de Cutscenes de Câmera em Combate (L4.2)

Este documento descreve a infraestrutura client-side de cutscenes cinematográficas de câmera para habilidades no **Tiny Adventures**. Neste lote (**L4.2**), o catálogo de produção permanece intencionalmente vazio: nenhuma cutscene falsa ou placeholder visual é executada quando uma skill não tem cutscene cadastrada.

## 1. Arquitetura e Prioridade de Câmera

Somente `CombatCameraController` escreve `CFrame`, `FieldOfView` e `FieldOfViewMode` em `Workspace.CurrentCamera`, eliminando escritas simultâneas entre intro, cutscene e enquadramento adaptativo.

Ordem estrita de prioridade (`CombatCameraMode`):

1. **`intro`** — Loading, cobertura, arco cinematográfico e countdown `3–2–1–GO` (`BattleIntroController` + `CombatCameraIntro`). Nenhuma cutscene pode iniciar antes do `GO`.
2. **`cutscene`** — Cutscene opcional de habilidade cadastrada (`CombatCutsceneController`). Enquanto ativa, mudanças de `ViewportSize` continuam recalculando `lastAppliedFrame` em segundo plano sem sobrescrever a câmera da cutscene.
3. **`adaptive`** — Enquadramento adaptativo L2.2 normal (`CombatCameraFraming`).

Módulos responsáveis (todos client-only em `src/client/Controllers/`):

- `CombatCutsceneTypes.ts`: contratos de keyframes, definições, poses, espaços de referência e motivos de cancelamento.
- `CombatCutsceneFormat.ts`: validação/ordenação de keyframes, interpolação de `CFrame`/FOV, referencial estável da arena e conversores de animações do Studio.
- `CombatCutsceneRegistry.ts`: catálogo opcional por `(fighterId, slot)` ou por `skillId` estável (`defaultCombatCutsceneRegistry`).
- `CombatCutsceneController.ts`: ciclo de vida, guarda por `(generation, battleId, attackToken)`, blend-in/blend-out suave para L2.2, cancelamento imediato e loop `RunService.PreRender`.

## 2. Formato dos Keyframes

As cutscenes **nunca** usam coordenadas mundiais fixas. Cada keyframe define um `CFrame` **relativo** ao `referenceSpace` escolhido:

- `"attacker"`: relativo ao pivot (`model.GetPivot()`) do lutador atacante.
- `"target"`: relativo ao pivot (`model.GetPivot()`) do lutador alvo.
- `"arena"`: relativo ao referencial estável da arena atual (`computeArenaReferenceCFrame`, calculado a partir de `Current_Fighter_A` e `Current_Fighter_B` no clone em `Workspace.ActiveArenas`).
- `"adaptiveCamera"`: relativo ao `CFrame` do enquadramento adaptativo L2.2 atual.

```ts
export interface CameraCutsceneKeyframe {
	readonly time: number; // segundos (0 <= time <= duration)
	readonly cframe: CFrame; // relativo ao referenceSpace
	readonly fieldOfView?: number; // FOV vertical opcional (clamped 20..120)
	readonly easingStyle?: Enum.EasingStyle; // padrão Linear
	readonly easingDirection?: Enum.EasingDirection; // padrão InOut
	readonly hold?: boolean; // true = corte seco até o próximo keyframe
}
```

## 3. Como Cadastrar uma Cutscene Futura (sem editar controllers)

Crie um módulo de dados dedicado (por exemplo, `src/client/Controllers/cutscenes/JotaroCutscenes.ts`) e registre no `defaultCombatCutsceneRegistry` durante a inicialização do client:

```ts
import { defaultCombatCutsceneRegistry } from "../CombatCutsceneRegistry";

// Cadastro por (fighterId, slot S1=1 | S2=2 | S3=3):
defaultCombatCutsceneRegistry.registerByFighterSlot("jotaro", 3, {
	id: "jotaro_time_stop",
	duration: 1.2,
	referenceSpace: "attacker",
	blendInDuration: 0.1,
	blendOutDuration: 0.25,
	followReference: true,
	cancelOnKo: true,
	cancelOnSwitch: true,
	keyframes: [
		{ time: 0.0, cframe: CFrame.lookAt(new Vector3(3, 2, -5), new Vector3(0, 1.8, 0)), fieldOfView: 55 },
		{
			time: 0.6,
			cframe: CFrame.lookAt(new Vector3(-3, 2.2, -4.5), new Vector3(0, 1.8, 0)),
			fieldOfView: 48,
			easingStyle: Enum.EasingStyle.Sine,
			easingDirection: Enum.EasingDirection.InOut,
		},
		{ time: 1.2, cframe: CFrame.lookAt(new Vector3(0, 3, -7), new Vector3(0, 1.8, 0)), fieldOfView: 65 },
	],
});

// Ou por identificador de habilidade estável (ex.: timeline.name em SkillRegistry):
defaultCombatCutsceneRegistry.registerBySkillId("Time Stop", { /* ... */ });
```

Prioridade de resolução: `(fighterId, slot)` tem precedência sobre `skillId`. Não é necessário alterar `CombatController`, `CombatCameraController` nem `CombatCutsceneController`.

## 4. Como Exportar ou Converter Animações do Roblox Studio

> **Importante:** `AnimationTrack` de `Humanoid`/`Animator` anima juntas (`Motor6D.Transform`) de um rig e **não** anima `Workspace.CurrentCamera` diretamente. Por isso, animações de câmera criadas no Studio devem ser convertidas em keyframes de `CFrame` relativos.

Nenhum plugin específico é obrigatório. Dois fluxos suportados nativamente por `CombatCutsceneFormat.ts`:

### Fluxo A — Animation Editor nativo (`KeyframeSequence`)
1. No Studio, crie um rig simples de referência com uma junta/part chamada `"Camera"` (posicionada em relação ao pivot do lutador ou ao centro da arena) e anime-a no **Animation Editor**.
2. Opcionalmente, adicione um atributo numérico `FieldOfView` (ou um `NumberValue` filho chamado `FieldOfView`) nos `Pose`/`Keyframe` desejados.
3. Converta a `KeyframeSequence` salva (ex.: em `ReplicatedStorage/Assets/CameraCutscenes`) usando:
   ```ts
   const def = convertKeyframeSequenceToCutscene(keyframeSequence, {
       referenceSpace: "attacker", // ou "arena" / "target"
       cameraPoseName: "Camera",
   });
   ```
   `PoseEasingStyle.Constant` é convertido automaticamente para `hold: true` (corte seco).

### Fluxo B — Amostragem de `CFrame` (Studio Command Bar / rig de câmera)
1. Durante a prévia no Studio, colete amostras `{ time, cameraCFrame, referenceCFrame, fieldOfView? }` (onde `referenceCFrame` é o pivot do atacante, alvo ou `computeArenaReferenceCFrame(anchors)`).
2. Converta para keyframes relativos com:
   ```ts
   const def = sampleWorldCameraCFramesToCutscene(samples, {
       id: "minha_skill",
       referenceSpace: "arena",
   });
   ```
   O helper calcula `referenceCFrame:ToObjectSpace(cameraCFrame)` para cada amostra e pode ter seus valores serializados diretamente em um módulo TypeScript de keyframes.

## 5. Cancelamento e Segurança

- **Multi-hit:** `CombatCutsceneController.tryStartForAttack` é disparado exclusivamente a partir de `AttackStarted` e deduplicado por `(generation, battleId, attackToken)`; múltiplos eventos `HitResolved` nunca reiniciam a cutscene.
- **KO / Troca / Modelo destruído:** cancela imediatamente e restaura o enquadramento adaptativo L2.2 (validando que o evento pertence à batalha atual).
- **Fim da batalha / Teardown / Quit / Vitória / Derrota / Timeout / Desconexão / Respawn:** cancela imediatamente (`BattleTransition exit`, `BattleEnded` e `cleanupStage`), desconecta `PreRender` e delega a restauração completa de `CameraType`, `CameraSubject`, `CFrame`, `FieldOfView` e `FieldOfViewMode` ao `CombatCameraController.restore()`.
