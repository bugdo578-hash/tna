import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
} from "../../shared/Config";
import type {
	BattleEndedPayload,
	BattleFighterSnapshot,
	BattleStartedPayload,
	BattleTransitionPayload,
	StateChangedPayload,
} from "../../shared/Remotes";
import { AMBIENT_VFX_ATTRIBUTES, AMBIENT_VFX_STATE_NODE_NAME } from "../UI/CombatVisualConfig";
import { CombatAmbientVfxState, resolveLocalPhysicalSide } from "./CombatAmbientVfxState";
import { CombatController } from "./CombatController";
import { CombatCutsceneRegistry } from "./CombatCutsceneRegistry";

interface FakeArenaFixture {
	readonly model: Model;
	readonly activeA: Part;
	readonly activeB: Part;
	readonly greenVfx: Part;
	readonly redVfx: Part;
	readonly cameraA: Part;
	readonly cameraB: Part;
}

interface CombatTestHandle {
	onBattleTransition(payload: BattleTransitionPayload): void;
	onBattleStarted(payload: BattleStartedPayload): void;
	onStateChanged(payload: StateChangedPayload): void;
	onBattleEnded(payload: BattleEndedPayload): void;
	onAttackStarted(payload: { attackerId: string; targetId: string; slot: 1 | 2 | 3 }): void;
}

function makePart(name: string, parent: Instance, cframe: CFrame, size = new Vector3(4, 1, 4)): Part {
	const part = new Instance("Part");
	part.Name = name;
	part.Anchored = true;
	part.Size = size;
	part.CFrame = cframe;
	part.Parent = parent;
	return part;
}

function makeFakeAssetsRoot(): Folder {
	const root = new Instance("Folder");
	root.Name = "L414_FakeAssets";
	const assets = new Instance("Folder");
	assets.Name = "Assets";
	assets.Parent = root;
	const fighters = new Instance("Folder");
	fighters.Name = "Fighters";
	fighters.Parent = assets;

	for (const fighterId of ["jotaro", "anubis"]) {
		const model = new Instance("Model");
		model.Name = fighterId;
		const hrp = new Instance("Part");
		hrp.Name = "HumanoidRootPart";
		hrp.Anchored = true;
		hrp.Size = new Vector3(2, 4, 2);
		hrp.Parent = model;
		const ground = new Instance("Attachment");
		ground.Name = "GroundContact";
		ground.Position = new Vector3(0, -2, 0);
		ground.Parent = hrp;
		model.PrimaryPart = hrp;
		model.Parent = fighters;
	}
	return root;
}

function makeArenaWithAmbientVfx(parent: Instance, instanceId: string, origin: CFrame): FakeArenaFixture {
	const model = new Instance("Model");
	model.Name = instanceId;
	model.SetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE, instanceId);
	model.SetAttribute(ARENA_ID_ATTRIBUTE, "Arena_01");

	const bases = new Instance("Folder");
	bases.Name = "Arena_bases";
	bases.Parent = model;

	const center = origin.PointToWorldSpace(new Vector3(0, 1.5, 0));
	const timeA = new Instance("Folder");
	timeA.Name = "Time A";
	timeA.Parent = bases;
	const activeA = makePart("Current_Fighter_A", timeA, origin.mul(new CFrame(0, 0, -6)));
	makePart("Waiting_Fighter_A", timeA, origin.mul(new CFrame(-4, 0, -8)));
	makePart("Waiting_Fighter_A_2", timeA, origin.mul(new CFrame(4, 0, -8)));
	const cameraA = makePart("Camera_A", timeA, CFrame.lookAt(origin.PointToWorldSpace(new Vector3(0, 6, -18)), center));
	const greenVfx = makePart("Current_Figther_A_vfx_green", activeA, activeA.CFrame.mul(new CFrame(0, 0.5, 0)), new Vector3(1, 1, 1));

	const timeB = new Instance("Folder");
	timeB.Name = "Time B";
	timeB.Parent = bases;
	const activeB = makePart("Current_Fighter_B", timeB, origin.mul(new CFrame(0, 0, 6)).mul(CFrame.Angles(0, math.pi, 0)));
	makePart("Waiting_Fighter_B", timeB, origin.mul(new CFrame(-4, 0, 8)));
	makePart("Waiting_Fighter_B_2", timeB, origin.mul(new CFrame(4, 0, 8)));
	const cameraB = makePart("Camera_B", timeB, CFrame.lookAt(origin.PointToWorldSpace(new Vector3(0, 6, 18)), center));
	const redVfx = makePart("Current_Figther_B_vfx_red", activeB, activeB.CFrame.mul(new CFrame(0, 0.5, 0)), new Vector3(1, 1, 1));

	model.Parent = parent;
	return { model, activeA, activeB, greenVfx, redVfx, cameraA, cameraB };
}

function makeFighters(sideA: string, sideB: string): BattleFighterSnapshot[] {
	return [
		{
			sideId: sideA,
			targetId: `${sideA}-1`,
			fighterId: "jotaro",
			className: "Fury",
			level: 5,
			s3Unlocked: false,
			hp: 100,
			hpMax: 100,
			active: true,
			slotCosts: [2, 4, 8],
		},
		{
			sideId: sideB,
			targetId: `${sideB}-1`,
			fighterId: "anubis",
			className: "Menace",
			level: 5,
			s3Unlocked: false,
			hp: 100,
			hpMax: 100,
			active: true,
			slotCosts: [2, 4, 8],
		},
	];
}

function asHandle(controller: CombatController): CombatTestHandle {
	return controller as unknown as CombatTestHandle;
}

function assertNodeMatchesSnapshot(controller: CombatController, label: string): void {
	const snap = controller.getAmbientVfxSnapshot();
	const node = controller.getAmbientVfxStateInstance();
	const attrs = AMBIENT_VFX_ATTRIBUTES;
	assert(node.Name === AMBIENT_VFX_STATE_NODE_NAME, `${label}: nome do nó inválido`);
	assert(node.GetAttribute(attrs.active) === snap.active, `${label}: atributo Active diverge`);
	assert(node.GetAttribute(attrs.battleId) === snap.battleId, `${label}: atributo BattleId diverge`);
	assert(node.GetAttribute(attrs.generation) === snap.generation, `${label}: atributo Generation diverge`);
	assert(node.GetAttribute(attrs.transitionId) === snap.transitionId, `${label}: atributo TransitionId diverge`);
	assert(node.GetAttribute(attrs.arenaInstanceId) === snap.arenaInstanceId, `${label}: atributo ArenaInstanceId diverge`);
	assert(node.GetAttribute(attrs.localSide) === snap.localSide, `${label}: atributo LocalSide diverge`);
	assert(node.GetAttribute(attrs.localSideIndex) === snap.localSideIndex, `${label}: atributo LocalSideIndex diverge`);
	assert(node.GetAttribute(attrs.fightersReady) === snap.fightersReady, `${label}: atributo FightersReady diverge`);
	assert(node.GetAttribute(attrs.goOccurred) === snap.goOccurred, `${label}: atributo GoOccurred diverge`);
	assert(node.GetAttribute(attrs.revision) === snap.revision, `${label}: atributo Revision diverge`);
}

function runPureStateUnitTests(): void {
	const host = new Instance("Folder");
	host.Name = "L414_PureHost";
	try {
		assert(resolveLocalPhysicalSide("A", ["A", "B"])?.side === "A", "U1: lado A");
		assert(resolveLocalPhysicalSide("A", ["A", "B"])?.sideIndex === 1, "U1: sideIndex 1");
		assert(resolveLocalPhysicalSide("B", ["A", "B"])?.side === "B", "U1: lado B");
		assert(resolveLocalPhysicalSide("B", ["A", "B"])?.sideIndex === 2, "U1: sideIndex 2");
		assert(resolveLocalPhysicalSide("C", ["A", "B"]) === undefined, "U1: lado desconhecido");
		assert(resolveLocalPhysicalSide("A", ["A", "A"]) === undefined, "U1: physicalSides duplicado");
		assert(resolveLocalPhysicalSide("", ["A", "B"]) === undefined, "U1: side vazio");

		const state = new CombatAmbientVfxState(host);
		assert(state.getSnapshot().active === false, "U2: inicia inativo");

		assert(
			state.beginBattle({
				generation: 1,
				battleId: "1:arena_1:A:B",
				transitionId: 10,
				arenaInstanceId: "arena_1",
				ownSideId: "B",
				physicalSides: ["A", "B"],
			}),
			"U2: beginBattle válido",
		);
		assert(state.getSnapshot().active === false, "U2: inativo antes de lutadores e GO");
		assert(state.getSnapshot().localSide === "B" && state.getSnapshot().localSideIndex === 2, "U2: lado B fixado");

		// GO antes de lutadores prontos não ativa
		assert(state.markGoOccurred(1, "1:arena_1:A:B", 10) === false, "U3: GO sem lutadores não ativa");
		assert(state.getSnapshot().active === false, "U3: ainda inativo");

		// Stale battleId / generation / transitionId rejeitados
		assert(state.markFightersReady(99, "1:arena_1:A:B", true) === false, "U4: geração errada rejeitada");
		assert(state.markFightersReady(1, "other", true) === false, "U4: battleId errado rejeitado");

		// Agora lutadores ficam prontos -> ativa
		assert(state.markFightersReady(1, "1:arena_1:A:B", true) === true, "U5: ativa com lutadores + GO");
		assert(state.getSnapshot().active === true, "U5: snapshot ativo");

		// Exit antigo ignorado
		state.deactivateForBattleEnd(9);
		assert(state.getSnapshot().active === true, "U6: exit de transitionId antigo ignorado");

		// Exit atual limpa imediatamente
		state.deactivateForBattleEnd(10);
		assert(state.getSnapshot().active === false, "U7: exit atual desativa imediatamente");

		// Geração antiga após clear é rejeitada
		state.clear(2);
		assert(
			!state.beginBattle({
				generation: 1,
				battleId: "1:old:A:B",
				transitionId: 10,
				arenaInstanceId: "arena_1",
				ownSideId: "A",
				physicalSides: ["A", "B"],
			}),
			"U8: geração antiga não sobrescreve estado após clear",
		);
		state.destroy();
	} finally {
		host.Destroy();
	}
}

/**
 * Valida toda a infraestrutura cliente-local L4.1.4 (lado físico autoritativo, prontidão, GO!,
 * imunidade à câmera L4.1.3 e cutscenes L4.2, isolamento multi-arena e limpeza imediata).
 */
export function runL4_1_4AmbientVfxTests(): boolean {
	runPureStateUnitTests();

	const root = new Instance("Folder");
	root.Name = "L414_TestRoot";
	const activeArenas = new Instance("Folder");
	activeArenas.Name = ACTIVE_ARENAS_FOLDER_NAME;
	activeArenas.Parent = root;
	const hostA = new Instance("Folder");
	hostA.Name = "ClientHostA";
	hostA.Parent = root;
	const hostB = new Instance("Folder");
	hostB.Name = "ClientHostB";
	hostB.Parent = root;

	const fakeAssets = makeFakeAssetsRoot();
	const camA = new Instance("Camera");
	const camB = new Instance("Camera");
	camA.CameraType = Enum.CameraType.Custom;
	camB.CameraType = Enum.CameraType.Custom;

	const cutsceneRegistry = new CombatCutsceneRegistry();
	cutsceneRegistry.registerByFighterSlot("jotaro", 3, {
		id: "l414_test_cutscene",
		duration: 0.3,
		referenceSpace: "arena",
		blendInDuration: 0.02,
		blendOutDuration: 0.05,
		keyframes: [
			// Posiciona câmera propositalmente atrás do Time B (adversário do jogador A)
			{ time: 0, cframe: CFrame.lookAt(new Vector3(0, 4, 16), new Vector3(0, 1.5, -6)), fieldOfView: 55 },
			{ time: 0.3, cframe: CFrame.lookAt(new Vector3(4, 4, 15), new Vector3(0, 1.5, -6)), fieldOfView: 60 },
		],
	});

	const cA = new CombatController(undefined, fakeAssets, root, 0.2, () => camA, () => new Vector2(1920, 1080), cutsceneRegistry, hostA);
	const cB = new CombatController(undefined, fakeAssets, root, 0.2, () => camB, () => new Vector2(1920, 1080), cutsceneRegistry, hostB);

	try {
		// 1. PvE no Time A com intro L4.1.3 (arco de 180°): invisível durante loading/arco/countdown, ativo apenas após GO!
		const arenaPve = makeArenaWithAmbientVfx(activeArenas, "arena_pve_l414", new CFrame(100, 10, -50));
		asHandle(cA).onBattleTransition({ id: 1, phase: "cover" });
		assert(cA.getAmbientVfxSnapshot().active === false, "T1: inativo durante cover");
		assertNodeMatchesSnapshot(cA, "T1 cover");

		asHandle(cA).onBattleStarted({
			transitionId: 1,
			sides: ["PVE_A", "PVE_B"],
			fighters: makeFighters("PVE_A", "PVE_B"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: arenaPve.model.Name, arenaId: "Arena_01", physicalSides: ["PVE_A", "PVE_B"] },
		});
		task.wait(0.05);
		assert(cA.getCameraMode() === "intro", "T1: câmera deve estar no modo intro após preparação");

		const snapLoading = cA.getAmbientVfxSnapshot();
		assert(snapLoading.active === false, "T1: VFX ocultos durante loading/preparação");
		assert(snapLoading.fightersReady === true, "T1: lutadores carregados detectados");
		assert(snapLoading.goOccurred === false, "T1: GO ainda não ocorreu");
		assert(snapLoading.arenaInstanceId === "arena_pve_l414", "T1: arena correta");
		assert(snapLoading.localSide === "A" && snapLoading.localSideIndex === 1, "T1: Time A fixo");
		assertNodeMatchesSnapshot(cA, "T1 loading");

		// Durante o arco de 180° (começa perto de Camera_B e atravessa a arena), estado permanece inativo e Side = A
		const camCtrl = (cA as unknown as { cameraController: { setIntroProgress(p: number): boolean } }).cameraController;
		camCtrl.setIntroProgress(0);
		assert(cA.getAmbientVfxSnapshot().active === false, "T1: VFX ocultos no início do arco (lado adversário)");
		assert(cA.getAmbientVfxSnapshot().localSide === "A", "T1: lado não inverte no início do arco");
		camCtrl.setIntroProgress(0.5);
		assert(cA.getAmbientVfxSnapshot().active === false, "T1: VFX ocultos no meio do arco 180°");
		assert(cA.getAmbientVfxSnapshot().localSide === "A", "T1: lado não inverte no meio do arco");
		camCtrl.setIntroProgress(1);
		assert(cA.getAmbientVfxSnapshot().active === false, "T1: VFX ainda ocultos após estabilizar câmera antes do GO!");
		// Força cameraFinal na intro para que L4.2 possa executar após GO!
		const introCurrent = (cA.introduction as unknown as { current?: { cameraFinal: boolean } }).current;
		if (introCurrent !== undefined) introCurrent.cameraFinal = true;

		// StateChanged antigo (transitionId diferente) é ignorado
		asHandle(cA).onStateChanged({ state: "IDLE", battleReleased: 999 });
		assert(cA.getAmbientVfxSnapshot().active === false, "T1: battleReleased de batalha errada ignorado");

		// GO! autoritativo do servidor
		asHandle(cA).onStateChanged({ state: "IDLE", battleReleased: 1 });
		const snapGo = cA.getAmbientVfxSnapshot();
		assert(snapGo.active === true && snapGo.goOccurred === true && snapGo.fightersReady === true, "T1: ativa após GO! + lutadores prontos");
		assert(snapGo.localSide === "A" && snapGo.localSideIndex === 1, "T1: Time A mantido após GO!");
		assertNodeMatchesSnapshot(cA, "T1 go");

		// 2. Cutscene de habilidade L4.2 (câmera move para lado adversário) não inverte nem desativa lado local
		asHandle(cA).onAttackStarted({ attackerId: "PVE_A-1", targetId: "PVE_B-1", slot: 3 });
		assert(cA.getCameraMode() === "cutscene", "T2: cutscene L4.2 deve iniciar após GO!");
		cA.getCutsceneController().step(0.15);
		assert(cA.getAmbientVfxSnapshot().active === true, "T2: VFX permanecem ativos durante cutscene L4.2");
		assert(cA.getAmbientVfxSnapshot().localSide === "A" && cA.getAmbientVfxSnapshot().localSideIndex === 1, "T2: cutscene não inverte lado");
		assert(cA.getAmbientVfxSnapshot().arenaInstanceId === "arena_pve_l414", "T2: cutscene não altera arena");

		// 3. Exit / BattleEnded limpa imediatamente (antes mesmo de cleanupStage)
		asHandle(cA).onBattleTransition({ id: 1, phase: "exit" });
		assert(cA.getAmbientVfxSnapshot().active === false, "T3: exit limpa imediatamente");
		assertNodeMatchesSnapshot(cA, "T3 exit");
		cA.cleanupStage();
		assert(cA.getAmbientVfxSnapshot().active === false && cA.getAmbientVfxSnapshot().arenaInstanceId === "", "T3: cleanup zera estado");

		// 4. PvP com dois clientes na mesma arena em lados opostos (A = verde/B = vermelho para cA; B = verde/A = vermelho para cB)
		const arenaPvp = makeArenaWithAmbientVfx(activeArenas, "arena_pvp_l414", new CFrame(-120, 5, 80));
		asHandle(cA).onBattleTransition({ id: 2, phase: "cover" });
		asHandle(cB).onBattleTransition({ id: 2, phase: "cover" });
		asHandle(cA).onBattleStarted({
			transitionId: 2,
			sides: ["PVP_A", "PVP_B"],
			fighters: makeFighters("PVP_A", "PVP_B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_pvp_l414", arenaId: "Arena_01", physicalSides: ["PVP_A", "PVP_B"] },
		});
		asHandle(cB).onBattleStarted({
			transitionId: 2,
			sides: ["PVP_B", "PVP_A"],
			fighters: makeFighters("PVP_A", "PVP_B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_pvp_l414", arenaId: "Arena_01", physicalSides: ["PVP_A", "PVP_B"] },
		});
		task.wait(0.05);

		assert(cA.getAmbientVfxSnapshot().active === false && cB.getAmbientVfxSnapshot().active === false, "T4: ambos ocultos antes do GO");
		// Move câmeras para lados trocados durante intro
		camA.CFrame = arenaPvp.cameraB.CFrame;
		camB.CFrame = arenaPvp.cameraA.CFrame;

		asHandle(cA).onStateChanged({ state: "IDLE", battleReleased: 2 });
		asHandle(cB).onStateChanged({ state: "IDLE", battleReleased: 2 });
		assert(cA.getAmbientVfxSnapshot().active === true && cA.getAmbientVfxSnapshot().localSide === "A" && cA.getAmbientVfxSnapshot().localSideIndex === 1,
			"T4: PvP cliente A mantém Time A = verde");
		assert(cB.getAmbientVfxSnapshot().active === true && cB.getAmbientVfxSnapshot().localSide === "B" && cB.getAmbientVfxSnapshot().localSideIndex === 2,
			"T4: PvP cliente B mantém Time B = verde");
		assert(cA.getAmbientVfxSnapshot().arenaInstanceId === "arena_pvp_l414" && cB.getAmbientVfxSnapshot().arenaInstanceId === "arena_pvp_l414",
			"T4: ambos apontam para arena_pvp_l414");

		// 5. Troca de batalha + duas batalhas simultâneas em arenas distintas
		asHandle(cA).onBattleEnded({ transitionId: 2, reason: "victory" });
		asHandle(cB).onBattleEnded({ transitionId: 2, reason: "victory" });
		assert(cA.getAmbientVfxSnapshot().active === false && cB.getAmbientVfxSnapshot().active === false, "T5: BattleEnded desativa imediatamente");
		cA.cleanupStage();
		cB.cleanupStage();

		makeArenaWithAmbientVfx(activeArenas, "arena_sim_l414_1", new CFrame(300, 0, 0));
		makeArenaWithAmbientVfx(activeArenas, "arena_sim_l414_2", new CFrame(340, 0, 0));
		asHandle(cA).onBattleTransition({ id: 3, phase: "cover" });
		asHandle(cB).onBattleTransition({ id: 4, phase: "cover" });
		asHandle(cA).onBattleStarted({
			transitionId: 3,
			sides: ["S1_A", "S1_B"],
			fighters: makeFighters("S1_A", "S1_B"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_sim_l414_1", arenaId: "Arena_01", physicalSides: ["S1_A", "S1_B"] },
		});
		asHandle(cB).onBattleStarted({
			transitionId: 4,
			sides: ["S2_B", "S2_A"],
			fighters: makeFighters("S2_A", "S2_B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_sim_l414_2", arenaId: "Arena_01", physicalSides: ["S2_A", "S2_B"] },
		});
		task.wait(0.05);
		asHandle(cA).onStateChanged({ state: "IDLE", battleReleased: 3 });
		// cB ainda não recebeu GO!
		assert(cA.getAmbientVfxSnapshot().active === true && cA.getAmbientVfxSnapshot().arenaInstanceId === "arena_sim_l414_1",
			"T5: arena 1 ativa após GO da batalha 3");
		assert(cB.getAmbientVfxSnapshot().active === false && cB.getAmbientVfxSnapshot().arenaInstanceId === "arena_sim_l414_2",
			"T5: arena 2 permanece oculta enquanto batalha 4 não recebeu GO");
		asHandle(cB).onStateChanged({ state: "IDLE", battleReleased: 4 });
		assert(cB.getAmbientVfxSnapshot().active === true && cB.getAmbientVfxSnapshot().localSide === "B",
			"T5: arena 2 ativa somente após GO da batalha 4 no lado B");

		// 6. Lutadores incompletos (falta lado B) nunca ativam VFX mesmo se GO tentar disparar
		cA.cleanupStage();
		asHandle(cA).onBattleTransition({ id: 5, phase: "cover" });
		asHandle(cA).onBattleStarted({
			transitionId: 5,
			sides: ["INC_A", "INC_B"],
			fighters: [makeFighters("INC_A", "INC_B")[0]],
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_sim_l414_1", arenaId: "Arena_01", physicalSides: ["INC_A", "INC_B"] },
		});
		task.wait(0.05);
		asHandle(cA).onStateChanged({ state: "IDLE", battleReleased: 5 });
		assert(cA.getAmbientVfxSnapshot().fightersReady === false && cA.getAmbientVfxSnapshot().active === false,
			"T6: lutadores incompletos impedem ativação dos VFX");

		cA.cleanupStage();
		cB.cleanupStage();
		assert(cA.getAmbientVfxSnapshot().active === false && cB.getAmbientVfxSnapshot().active === false, "T7: teardown final limpo");

		print("L4_1_4_AMBIENT_VFX_TESTS_ALL_PASSED");
		return true;
	} finally {
		cA.cleanupStage();
		cB.cleanupStage();
		camA.Destroy();
		camB.Destroy();
		fakeAssets.Destroy();
		root.Destroy();
	}
}
