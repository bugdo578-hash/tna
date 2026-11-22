import { Workspace } from "@rbxts/services";
import { ACTIVE_ARENAS_FOLDER_NAME } from "../../shared/Config";
import type {
	AttackStartedPayload,
	BattleStartedPayload,
	FighterDiedPayload,
	HitResolvedPayload,
	SwitchPerformedPayload,
} from "../../shared/Remotes";
import { cameraFramingTestFixtures } from "./CombatCameraFramingTests";
import {
	computeArenaReferenceCFrame,
	convertKeyframeSequenceToCutscene,
	sampleWorldCameraCFramesToCutscene,
} from "./CombatCutsceneFormat";
import { CombatCutsceneRegistry, defaultCombatCutsceneRegistry } from "./CombatCutsceneRegistry";
import type { CameraCutsceneDefinition } from "./CombatCutsceneTypes";
import { CombatController } from "./CombatController";

type CombatControllerProbe = {
	onBattleStarted(payload: BattleStartedPayload): void;
	onAttackStarted(payload: AttackStartedPayload): void;
	onHitResolved(payload: HitResolvedPayload): void;
	onFighterDied(payload: FighterDiedPayload): void;
	onSwitchPerformed(payload: SwitchPerformedPayload): void;
	cameraController: {
		prepareIntro(sideIndex: 0 | 1): boolean;
		setIntroProgress(progress: number): boolean;
		beginCutscene(generation: number, battleId: string): boolean;
		applyCutscenePose(generation: number, battleId: string, pose: { cframe: CFrame; fieldOfView: number; fieldOfViewMode: Enum.FieldOfViewMode }): boolean;
	};
};

function probe(controller: CombatController): CombatControllerProbe {
	return controller as unknown as CombatControllerProbe;
}

function assertNearCFrame(actual: CFrame, expected: CFrame, label: string, posTol = 1e-2, rotTol = 1e-2): void {
	const posDelta = actual.Position.sub(expected.Position).Magnitude;
	const lookDelta = actual.LookVector.sub(expected.LookVector).Magnitude;
	const upDelta = actual.UpVector.sub(expected.UpVector).Magnitude;
	assert(
		posDelta <= posTol && lookDelta <= rotTol && upDelta <= rotTol,
		`${label}: CFrame mismatch (pos=${posDelta}, look=${lookDelta}, up=${upDelta})`,
	);
}

function assertNearNumber(actual: number, expected: number, label: string, tol = 1e-2): void {
	assert(math.abs(actual - expected) <= tol, `${label}: esperado ${expected}, obtido ${actual}`);
}

/** Fixtures isolados exclusivamente para QA (nunca habilitados em produção). */
function buildTestCutsceneFixtures(): {
	readonly registry: CombatCutsceneRegistry;
	readonly attackerCutscene: CameraCutsceneDefinition;
	readonly arenaCutscene: CameraCutsceneDefinition;
	readonly targetCutscene: CameraCutsceneDefinition;
} {
	const registry = new CombatCutsceneRegistry();

	const attackerCutscene: CameraCutsceneDefinition = {
		id: "qa_attacker_s2",
		duration: 0.4,
		referenceSpace: "attacker",
		blendInDuration: 0,
		blendOutDuration: 0.2,
		followReference: true,
		keyframes: [
			{ time: 0, cframe: CFrame.lookAt(new Vector3(3, 2, -5), new Vector3(0, 1.5, 0)), fieldOfView: 55 },
			{
				time: 0.2,
				cframe: CFrame.lookAt(new Vector3(-3, 2.5, -5), new Vector3(0, 1.5, 0)),
				fieldOfView: 60,
				easingStyle: Enum.EasingStyle.Sine,
				easingDirection: Enum.EasingDirection.InOut,
			},
			{ time: 0.4, cframe: CFrame.lookAt(new Vector3(0, 3, -7), new Vector3(0, 1.5, 0)), fieldOfView: 65 },
		],
	};

	const arenaCutscene: CameraCutsceneDefinition = {
		id: "qa_arena_timestop",
		duration: 0.4,
		referenceSpace: "arena",
		blendInDuration: 0,
		blendOutDuration: 0.2,
		followReference: true,
		keyframes: [
			{ time: 0, cframe: CFrame.lookAt(new Vector3(0, 6, 10), new Vector3(0, 1.5, 0)), fieldOfView: 50, hold: true },
			{ time: 0.2, cframe: CFrame.lookAt(new Vector3(4, 5, 8), new Vector3(0, 1.5, 0)), fieldOfView: 58 },
			{ time: 0.4, cframe: CFrame.lookAt(new Vector3(-4, 5, 8), new Vector3(0, 1.5, 0)), fieldOfView: 64 },
		],
	};

	const targetCutscene: CameraCutsceneDefinition = {
		id: "qa_target_anubis_s1",
		duration: 0.3,
		referenceSpace: "target",
		blendInDuration: 0,
		blendOutDuration: 0.15,
		followReference: true,
		keyframes: [
			{ time: 0, cframe: CFrame.lookAt(new Vector3(2, 2.5, -4), new Vector3(0, 1.5, 0)), fieldOfView: 52 },
			{ time: 0.3, cframe: CFrame.lookAt(new Vector3(-2, 2.5, -4), new Vector3(0, 1.5, 0)), fieldOfView: 62 },
		],
	};

	assert(registry.registerByFighterSlot("jotaro", 2, attackerCutscene), "Fixture: registrar jotaro S2");
	assert(registry.registerBySkillId("Time Stop", arenaCutscene), "Fixture: registrar Time Stop por skillId");
	assert(registry.registerByFighterSlot("anubis", 1, targetCutscene), "Fixture: registrar anubis S1");
	return { registry, attackerCutscene, arenaCutscene, targetCutscene };
}

function verifyStudioConversionHelpers(): void {
	const refA = new CFrame(120, 15, -80).mul(CFrame.Angles(0, math.rad(42), 0));
	const local0 = new CFrame(2, 3, -6).mul(CFrame.Angles(math.rad(-10), math.rad(15), 0));
	const local1 = new CFrame(-2, 4, -8).mul(CFrame.Angles(math.rad(-12), math.rad(-15), 0));
	const sampled = sampleWorldCameraCFramesToCutscene(
		[
			{ time: 0, cameraCFrame: refA.mul(local0), referenceCFrame: refA, fieldOfView: 56 },
			{ time: 0.5, cameraCFrame: refA.mul(local1), referenceCFrame: refA, fieldOfView: 64 },
		],
		{ id: "sampled_test", referenceSpace: "attacker" },
	);
	assert(sampled !== undefined && sampled.keyframes.size() === 2, "sampleWorldCameraCFramesToCutscene deve gerar 2 keyframes");
	assertNearCFrame(sampled.keyframes[0].cframe, local0, "Conversion sample[0] relativo");
	assertNearCFrame(sampled.keyframes[1].cframe, local1, "Conversion sample[1] relativo");

	const seq = new Instance("KeyframeSequence");
	seq.Name = "StudioCameraSeq";
	const kf0 = new Instance("Keyframe");
	kf0.Time = 0;
	const pose0 = new Instance("Pose");
	pose0.Name = "Camera";
	pose0.CFrame = local0;
	pose0.EasingStyle = Enum.PoseEasingStyle.Constant;
	pose0.SetAttribute("FieldOfView", 54);
	pose0.Parent = kf0;
	kf0.Parent = seq;

	const kf1 = new Instance("Keyframe");
	kf1.Time = 0.6;
	const pose1 = new Instance("Pose");
	pose1.Name = "Camera";
	pose1.CFrame = local1;
	pose1.EasingStyle = Enum.PoseEasingStyle.Cubic;
	pose1.Parent = kf1;
	kf1.Parent = seq;

	const converted = convertKeyframeSequenceToCutscene(seq, { referenceSpace: "arena" });
	seq.Destroy();
	assert(converted !== undefined && converted.keyframes.size() === 2, "convertKeyframeSequenceToCutscene deve converter 2 keyframes");
	assert(converted.keyframes[0].hold === true, "PoseEasingStyle.Constant deve virar hold=true");
	assertNearNumber(converted.keyframes[0].fieldOfView ?? 0, 54, "FieldOfView convertido do atributo");
	assertNearCFrame(converted.keyframes[0].cframe, local0, "KeyframeSequence pose0 relativa");
	assertNearCFrame(converted.keyframes[1].cframe, local1, "KeyframeSequence pose1 relativa");
}

/**
 * Executa a suíte QA L4.2 completa para infraestrutura de cutscenes de câmera em combate.
 * Usa exclusivamente fixtures isolados, garantindo que a produção permaneça sem cutscenes cadastradas.
 */
export function runL4_2CameraCutsceneTests(): boolean {
	// 1. Produção não tem cutscenes cadastradas nem placeholders visuais
	assert(
		defaultCombatCutsceneRegistry.getRegisteredCount() === 0,
		`Produção deve iniciar com 0 cutscenes cadastradas (encontradas: ${defaultCombatCutsceneRegistry.getRegisteredCount()})`,
	);
	verifyStudioConversionHelpers();

	const root = new Instance("Folder");
	root.Name = "L4_2_CutsceneTestRoot";
	const activeArenas = new Instance("Folder");
	activeArenas.Name = ACTIVE_ARENAS_FOLDER_NAME;
	activeArenas.Parent = root;

	const fakeAssets = cameraFramingTestFixtures.makeAssetsWithStandAndWeapon();
	const subjectA = new Instance("Part");
	subjectA.Parent = root;
	const subjectB = new Instance("Part");
	subjectB.Parent = root;

	const camA = new Instance("Camera");
	const camB = new Instance("Camera");
	const initCFA = new CFrame(12, 18, -25).mul(CFrame.Angles(0, math.rad(20), 0));
	const initCFB = new CFrame(-14, 22, 30).mul(CFrame.Angles(0, math.rad(-45), 0));

	const resetCamera = (cam: Camera, cf: CFrame, subj: BasePart, mode: Enum.FieldOfViewMode, fov: number) => {
		cam.CameraType = Enum.CameraType.Custom;
		cam.CameraSubject = subj;
		cam.CFrame = cf;
		cam.FieldOfViewMode = mode;
		cam.FieldOfView = fov;
	};
	resetCamera(camA, initCFA, subjectA, Enum.FieldOfViewMode.Diagonal, 74);
	resetCamera(camB, initCFB, subjectB, Enum.FieldOfViewMode.MaxAxis, 70);

	let viewportA = new Vector2(1920, 1080);
	let viewportB = new Vector2(1280, 720);

	const fixtures = buildTestCutsceneFixtures();
	const prodCtrl = new CombatController(undefined, fakeAssets, root, 0.2, () => camA, () => viewportA);
	const ctrlA = new CombatController(undefined, fakeAssets, root, 0.2, () => camA, () => viewportA, fixtures.registry);
	const ctrlB = new CombatController(undefined, fakeAssets, root, 0.2, () => camB, () => viewportB, fixtures.registry);

	const assertRestoredA = (label: string) => {
		assert((camA.CameraType as Enum.CameraType) === Enum.CameraType.Custom, `${label}: CameraType restaurado`);
		assert(camA.CameraSubject === subjectA, `${label}: CameraSubject restaurado`);
		assert((camA.FieldOfViewMode as Enum.FieldOfViewMode) === Enum.FieldOfViewMode.Diagonal, `${label}: FieldOfViewMode restaurado`);
		assertNearNumber(camA.FieldOfView, 74, `${label}: FieldOfView restaurado`);
		assertNearCFrame(camA.CFrame, initCFA, `${label}: CFrame restaurado`);
	};

	const arena1Origin = new CFrame(180, 12, -90).mul(CFrame.Angles(0, math.rad(37), 0));
	const arena2Origin = new CFrame(-320, 45, 260).mul(CFrame.Angles(0, math.rad(-118), 0));
	cameraFramingTestFixtures.makeOpen3v3Arena(activeArenas, "arena_l42_1", arena1Origin, 6);
	cameraFramingTestFixtures.makeOpen3v3Arena(activeArenas, "arena_l42_2", arena2Origin, 6);

	const startBattle = (
		ctrl: CombatController,
		arenaName: string,
		mode: "PVE" | "PVP",
		ownSideIndex: 0 | 1,
		sidePrefix = "S",
	): BattleStartedPayload => {
		const physA = `${sidePrefix}A`;
		const physB = `${sidePrefix}B`;
		const payload: BattleStartedPayload = {
			sides: ownSideIndex === 0 ? [physA, physB] : [physB, physA],
			fighters: cameraFramingTestFixtures.make3v3Fighters(physA, physB),
			mode,
			canPause: mode === "PVE",
			arena: { instanceId: arenaName, arenaId: "Arena_01", physicalSides: [physA, physB] },
		};
		probe(ctrl).onBattleStarted(payload);
		return payload;
	};

	try {
		// 2. Nenhuma cutscene cadastrada (registry de produção): câmera mantém exatamente o comportamento L2.2
		startBattle(prodCtrl, "arena_l42_1", "PVE", 0, "PROD");
		const prodAdaptive = prodCtrl.getLastAppliedCameraFrame()!;
		assert(prodCtrl.getCameraMode() === "adaptive", "Sem cutscene: modo deve ser adaptive");
		probe(prodCtrl).onAttackStarted({ attackerId: "PRODA-1", targetId: "PRODB-1", slot: 2 });
		assert(!prodCtrl.getCutsceneController().isActive(), "Sem cutscene: cutscene não deve ativar");
		assert(prodCtrl.getCameraMode() === "adaptive", "Sem cutscene: modo permanece adaptive");
		assertNearCFrame(camA.CFrame, prodAdaptive.cframe, "Sem cutscene: CFrame intacto");
		assertNearNumber(camA.FieldOfView, prodAdaptive.fieldOfView, "Sem cutscene: FOV intacto");
		prodCtrl.cleanupStage();
		assertRestoredA("Sem cutscene teardown");

		// 3. Reprodução relativa ao atacante + arena movida/rotacionada + duas arenas simultâneas + PvE/PvP lados A e B
		startBattle(ctrlA, "arena_l42_1", "PVE", 0, "SIM1");
		startBattle(ctrlB, "arena_l42_2", "PVP", 1, "SIM2");
		probe(ctrlA).onAttackStarted({ attackerId: "SIM1A-1", targetId: "SIM1B-1", slot: 2 });
		probe(ctrlB).onAttackStarted({ attackerId: "SIM2A-1", targetId: "SIM2B-1", slot: 2 });
		assert(ctrlA.getCameraMode() === "cutscene" && ctrlB.getCameraMode() === "cutscene", "Duas arenas simultâneas em cutscene");

		const attackerModel1 = ctrlA.getFighterModel("SIM1A-1")!;
		const attackerModel2 = ctrlB.getFighterModel("SIM2A-1")!;
		const rel1 = attackerModel1.GetPivot().ToObjectSpace(camA.CFrame);
		const rel2 = attackerModel2.GetPivot().ToObjectSpace(camB.CFrame);
		assertNearCFrame(rel1, fixtures.attackerCutscene.keyframes[0].cframe, "Arena 1 relativa ao atacante", 0.05, 0.05);
		assertNearCFrame(rel2, fixtures.attackerCutscene.keyframes[0].cframe, "Arena 2 rotacionada relativa ao atacante", 0.05, 0.05);
		assert(camA.CFrame.Position.sub(camB.CFrame.Position).Magnitude > 100, "Clones simultâneos em posições mundiais distintas");
		ctrlA.cleanupStage();
		ctrlB.cleanupStage();
		assertRestoredA("Simul teardown A");

		// 4. Reprodução relativa à arena (por skillId "Time Stop") em lados A e B no mesmo clone PvP + hold keyframe
		startBattle(ctrlA, "arena_l42_1", "PVP", 0, "PVP1");
		startBattle(ctrlB, "arena_l42_1", "PVP", 1, "PVP1");
		probe(ctrlA).onAttackStarted({ attackerId: "PVP1A-1", targetId: "PVP1B-1", slot: 3 });
		probe(ctrlB).onAttackStarted({ attackerId: "PVP1A-1", targetId: "PVP1B-1", slot: 3 });
		const arenaRefA = computeArenaReferenceCFrame(ctrlA.getResolvedArenaAnchors()!)!;
		const arenaRefB = computeArenaReferenceCFrame(ctrlB.getResolvedArenaAnchors()!)!;
		assertNearCFrame(arenaRefA.ToObjectSpace(camA.CFrame), fixtures.arenaCutscene.keyframes[0].cframe, "PvP lado A relativo à arena");
		assertNearCFrame(arenaRefB.ToObjectSpace(camB.CFrame), fixtures.arenaCutscene.keyframes[0].cframe, "PvP lado B relativo à arena");
		// Hold keyframe (0 -> 0.2) mantém pose fixa em t=0.1
		ctrlA.getCutsceneController().step(0.1);
		assertNearCFrame(arenaRefA.ToObjectSpace(camA.CFrame), fixtures.arenaCutscene.keyframes[0].cframe, "Hold keyframe mantém pose antes de 0.2s");
		assertNearNumber(camA.FieldOfView, 50, "Hold keyframe mantém FOV=50");
		ctrlA.cleanupStage();
		ctrlB.cleanupStage();

		// 5. Reprodução relativa ao alvo (Anubis S1 no lado físico B atacando lado físico A)
		startBattle(ctrlA, "arena_l42_2", "PVP", 1, "TGT");
		probe(ctrlA).onAttackStarted({ attackerId: "TGTB-1", targetId: "TGTA-1", slot: 1 });
		assert(ctrlA.getCameraMode() === "cutscene", "Anubis S1 ativa cutscene relativa ao alvo");
		const targetPivot = ctrlA.getFighterModel("TGTA-1")!.GetPivot();
		assertNearCFrame(targetPivot.ToObjectSpace(camA.CFrame), fixtures.targetCutscene.keyframes[0].cframe, "Pose relativa ao alvo", 0.05, 0.05);
		ctrlA.cleanupStage();

		// 6. Multi-hit (Jotaro S2 - 5 hits) sem múltiplos disparos + dano intacto + retorno suave com resize de viewport
		viewportA = new Vector2(1920, 1080);
		startBattle(ctrlA, "arena_l42_1", "PVE", 0, "MH");
		let hpUpdates = 0;
		let lastEnemyHp = 100;
		const unsubHp = ctrlA.onFighterHpVisualChanged((id, hp) => {
			if (id === "MHB-1") {
				hpUpdates += 1;
				lastEnemyHp = hp;
			}
		});
		probe(ctrlA).onAttackStarted({ attackerId: "MHA-1", targetId: "MHB-1", slot: 2 });
		assert(ctrlA.getCameraMode() === "cutscene", "Multi-hit inicia cutscene 1 vez");
		ctrlA.getCutsceneController().step(0.2);
		const midPose = camA.CFrame;
		for (const hitIndex of $range(1, 5)) {
			probe(ctrlA).onHitResolved({
				hitIndex,
				hit: true,
				crit: false,
				damage: 10,
				targetId: "MHB-1",
				followUpCancelled: false,
			});
		}
		assert(ctrlA.getCutsceneController().getState() === "playing", "HitResolved não reinicia nem cancela cutscene");
		// Mudança de viewport no meio da cutscene não sobrescreve a câmera, mas atualiza o alvo adaptativo L2.2
		viewportA = new Vector2(414, 736);
		assert(ctrlA.refreshCameraFraming(false), "Resize durante cutscene recalcula frame adaptativo");
		assert(ctrlA.getCameraMode() === "cutscene", "Resize não rouba posse da cutscene");
		assertNearCFrame(camA.CFrame, midPose, "Resize não sobrescreve pose ativa da cutscene");
		const portraitAdaptive = ctrlA.getLastAppliedCameraFrame()!;
		// Completa duração -> entra em blending_out -> retorna suavemente ao frame adaptativo 9:16
		ctrlA.getCutsceneController().step(0.21);
		assert(ctrlA.getCutsceneController().getState() === "blending_out", "Após duração entra em blending_out");
		ctrlA.getCutsceneController().step(0.1);
		assert(ctrlA.getCameraMode() === "cutscene", "Meio do blend-out mantém posse");
		ctrlA.getCutsceneController().step(0.15);
		assert(!ctrlA.getCutsceneController().isActive() && ctrlA.getCameraMode() === "adaptive", "Fim do blend-out devolve controle ao adaptive");
		assertNearCFrame(camA.CFrame, portraitAdaptive.cframe, "Blend-out termina exatamente no enquadramento adaptativo 9:16");
		assertNearNumber(camA.FieldOfView, portraitAdaptive.fieldOfView, "Blend-out restaura FOV adaptativo 9:16");
		// Confirma que os 5 hits continuam resolvendo dano normalmente (sem atraso nem perda)
		task.wait(0.65);
		assert(hpUpdates === 5 && lastEnemyHp === 50, `Multi-hit dano intacto (updates=${hpUpdates}, hp=${lastEnemyHp})`);
		unsubHp();
		ctrlA.cleanupStage();
		assertRestoredA("Multi-hit teardown");

		// 7. Cancelamento em KO, troca, destruição de atacante/alvo e batalha encerrada
		viewportA = new Vector2(1920, 1080);
		startBattle(ctrlA, "arena_l42_1", "PVE", 0, "CANC");
		const adaptiveCanc = ctrlA.getLastAppliedCameraFrame()!;
		probe(ctrlA).onAttackStarted({ attackerId: "CANCA-1", targetId: "CANCB-1", slot: 2 });
		assert(ctrlA.getCameraMode() === "cutscene", "Antes de KO em cutscene");
		probe(ctrlA).onFighterDied({ sideId: "CANCB", fighterId: "CANCB-1", nextActive: "CANCB-2" });
		assert(!ctrlA.getCutsceneController().isActive() && ctrlA.getCutsceneController().getLastCancelReason() === "ko", "KO cancela cutscene");
		assert(ctrlA.getCameraMode() === "adaptive", "KO retorna ao modo adaptive");
		assertNearCFrame(camA.CFrame, adaptiveCanc.cframe, "KO restaura CFrame adaptativo");

		// Troca no meio da cutscene (em batalha limpa, sem KO tween bloqueando novo ataque)
		startBattle(ctrlA, "arena_l42_1", "PVE", 0, "SWTC");
		const adaptiveSwtc = ctrlA.getLastAppliedCameraFrame()!;
		probe(ctrlA).onAttackStarted({ attackerId: "SWTCA-1", targetId: "SWTCB-1", slot: 3 });
		assert(ctrlA.getCameraMode() === "cutscene", "Antes de Switch em cutscene");
		probe(ctrlA).onSwitchPerformed({ sideId: "SWTCA", previousFighterId: "SWTCA-1", activeFighterId: "SWTCA-2" });
		assert(!ctrlA.getCutsceneController().isActive() && ctrlA.getCutsceneController().getLastCancelReason() === "switch", "Switch cancela cutscene");
		assertNearCFrame(camA.CFrame, adaptiveSwtc.cframe, "Switch restaura CFrame adaptativo");

		// Alvo destruído durante a cutscene
		probe(ctrlA).onAttackStarted({ attackerId: "SWTCA-2", targetId: "SWTCB-1", slot: 1 });
		assert(ctrlA.getCameraMode() === "cutscene", "Antes de target destruído");
		ctrlA.getFighterModel("SWTCB-1")!.Destroy();
		ctrlA.getCutsceneController().step(0.05);
		assert(!ctrlA.getCutsceneController().isActive() && ctrlA.getCutsceneController().getLastCancelReason() === "reference_invalid", "Target destruído cancela cutscene");
		assert(ctrlA.getCameraMode() === "adaptive", "Target destruído retorna ao modo adaptive");

		// Atacante destruído durante a cutscene
		probe(ctrlA).onAttackStarted({ attackerId: "SWTCA-2", targetId: "SWTCB-2", slot: 1 });
		assert(ctrlA.getCameraMode() === "cutscene", "Antes de attacker destruído");
		ctrlA.getFighterModel("SWTCA-2")!.Destroy();
		ctrlA.getCutsceneController().step(0.05);
		assert(!ctrlA.getCutsceneController().isActive() && ctrlA.getCutsceneController().getLastCancelReason() === "reference_invalid", "Attacker destruído cancela cutscene");
		assert(ctrlA.getCameraMode() === "adaptive", "Attacker destruído retorna ao modo adaptive");
		ctrlA.cleanupStage();
		assertRestoredA("Cancelamentos teardown");

		// 8. Prioridade de câmera: intro 3-2-1-GO bloqueia cutscene antes do GO; após GO libera
		startBattle(ctrlA, "arena_l42_1", "PVE", 0, "INTRO");
		assert(probe(ctrlA).cameraController.prepareIntro(0), "Prepara arco de intro L4.1.2");
		assert(ctrlA.getCameraMode() === "intro", "Modo durante intro deve ser intro");
		const introPose0 = camA.CFrame;
		probe(ctrlA).onAttackStarted({ attackerId: "INTROA-1", targetId: "INTROB-1", slot: 2 });
		assert(!ctrlA.getCutsceneController().isActive(), "Cutscene bloqueada durante arco de intro");
		assert(ctrlA.getCameraMode() === "intro", "Intro mantém prioridade 1 sobre cutscene");
		assertNearCFrame(camA.CFrame, introPose0, "Intro não sofre escrita da cutscene");
		// Avança intro até concluir (GO)
		assert(probe(ctrlA).cameraController.setIntroProgress(1), "Finaliza arco de intro");
		assert(ctrlA.getCameraMode() === "adaptive", "Após intro volta para adaptive");
		probe(ctrlA).onAttackStarted({ attackerId: "INTROA-1", targetId: "INTROB-1", slot: 3 });
		assert(ctrlA.getCutsceneController().isActive() && ctrlA.getCameraMode() === "cutscene", "Após GO cutscene é liberada");
		ctrlA.cleanupStage();
		assertRestoredA("Intro priority teardown");

		// 9. Eventos antigos (HitResolved/KO/Switch) e gerações antigas não afetam nova batalha
		startBattle(ctrlA, "arena_l42_1", "PVE", 0, "OLD");
		const oldGen = ctrlA.getBattleGeneration();
		probe(ctrlA).onAttackStarted({ attackerId: "OLDA-1", targetId: "OLDB-1", slot: 2 });
		assert(ctrlA.getCutsceneController().isActive(), "Batalha antiga iniciou cutscene");
		// Nova batalha começa sem cleanup prévio explícito (substituição direta)
		startBattle(ctrlA, "arena_l42_2", "PVE", 0, "NEW");
		assert(!ctrlA.getCutsceneController().isActive(), "Nova batalha cancela cutscene da batalha antiga");
		assert(!probe(ctrlA).cameraController.beginCutscene(oldGen, `${oldGen}:arena_l42_1:OLDA:OLDB`), "Geração antiga rejeitada pelo CameraController");
		// Eventos antigos (targetIds de OLD) não iniciam nem cancelam cutscene de NEW
		probe(ctrlA).onHitResolved({ hitIndex: 1, hit: true, crit: false, damage: 10, targetId: "OLDB-1", followUpCancelled: false });
		probe(ctrlA).onFighterDied({ sideId: "OLDB", fighterId: "OLDB-1", nextActive: "OLDB-2" });
		probe(ctrlA).onSwitchPerformed({ sideId: "OLDA", previousFighterId: "OLDA-1", activeFighterId: "OLDA-2" });
		assert(!ctrlA.getCutsceneController().isActive(), "Eventos antigos não iniciam cutscene em nova batalha");
		probe(ctrlA).onAttackStarted({ attackerId: "NEWA-1", targetId: "NEWB-1", slot: 2 });
		assert(ctrlA.getCutsceneController().isActive(), "Nova batalha inicia própria cutscene");
		probe(ctrlA).onFighterDied({ sideId: "OLDB", fighterId: "OLDB-1", nextActive: undefined });
		probe(ctrlA).onSwitchPerformed({ sideId: "OLDA", previousFighterId: "OLDA-1", activeFighterId: "OLDA-2" });
		assert(ctrlA.getCutsceneController().isActive(), "KO/Switch de batalha antiga não cancelam cutscene da nova batalha");
		ctrlA.cleanupStage();
		assertRestoredA("Generation guard teardown");

		// 10. Bloqueio por BattleIntroController antes do GO (simulado com schedule futuro)
		const introCtrl = ctrlA.introduction as unknown as {
			current?: {
				id: number;
				overlay: { gui: ScreenGui; cover: (c: boolean) => void };
				deadline: number;
				covered: boolean;
				coverFramePending: boolean;
				ready: boolean;
				cancelled: boolean;
				released: boolean;
				cameraFinal: boolean;
				fadeFinished: boolean;
				exitCovered: boolean;
			};
			schedule?: { id: number; phase: "schedule"; arcAt: number; goAt: number };
		};
		startBattle(ctrlA, "arena_l42_1", "PVE", 0, "PREGO");
		const dummyGui = new Instance("ScreenGui");
		const now = Workspace.GetServerTimeNow();
		introCtrl.current = {
			id: 99,
			overlay: { gui: dummyGui, cover: () => {} },
			deadline: now + 10,
			covered: true,
			coverFramePending: false,
			ready: true,
			cancelled: false,
			released: false,
			cameraFinal: true,
			fadeFinished: true,
			exitCovered: false,
		};
		introCtrl.schedule = { id: 99, phase: "schedule", arcAt: now - 1, goAt: now + 2 };
		assert(ctrlA.introduction.isBlockingCutscenes(), "Antes do GO isBlockingCutscenes deve ser true");
		probe(ctrlA).onAttackStarted({ attackerId: "PREGOA-1", targetId: "PREGOB-1", slot: 2 });
		assert(!ctrlA.getCutsceneController().isActive(), "Cutscene não pode começar antes do GO");
		// Libera GO no relógio e no estado
		introCtrl.current.released = true;
		introCtrl.schedule = { id: 99, phase: "schedule", arcAt: now - 3, goAt: now - 0.1 };
		assert(!ctrlA.introduction.isBlockingCutscenes(), "Após GO isBlockingCutscenes deve ser false");
		probe(ctrlA).onAttackStarted({ attackerId: "PREGOA-1", targetId: "PREGOB-1", slot: 3 });
		assert(ctrlA.getCutsceneController().isActive(), "Após GO cutscene inicia normalmente");
		ctrlA.cleanupStage();
		assertRestoredA("Pre-GO teardown");

		print("L4_2_CAMERA_CUTSCENE_TESTS_ALL_PASSED");
		return true;
	} finally {
		prodCtrl.cleanupStage();
		ctrlA.cleanupStage();
		ctrlB.cleanupStage();
		camA.Destroy();
		camB.Destroy();
		fakeAssets.Destroy();
		root.Destroy();
	}
}
