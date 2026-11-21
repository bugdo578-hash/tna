import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
} from "../../shared/Config";
import type { BattleFighterSnapshot, BattleStartedPayload } from "../../shared/Remotes";
import { CombatCameraController } from "./CombatCameraController";
import { CombatController } from "./CombatController";

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
	root.Name = "L2_FakeAssets";
	const assets = new Instance("Folder");
	assets.Name = "Assets";
	assets.Parent = root;
	const fighters = new Instance("Folder");
	fighters.Name = "Fighters";
	fighters.Parent = assets;

	for (const fighterId of ["jotaro", "anubis", "dummy"]) {
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

function makeArenaClone(
	parent: Instance | undefined,
	instanceId: string,
	origin: CFrame,
	options?: {
		arenaId?: string;
		omitCameraA?: boolean;
		omitCameraB?: boolean;
		duplicateCameraB?: boolean;
		invalidCameraAType?: boolean;
	},
): { model: Model; timeA: Folder; timeB: Folder; activeA: Part; activeB: Part; cameraA?: Part; cameraB?: Part } {
	const model = new Instance("Model");
	model.Name = instanceId;
	model.SetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE, instanceId);
	model.SetAttribute(ARENA_ID_ATTRIBUTE, options?.arenaId ?? "Arena_01");

	const bases = new Instance("Folder");
	bases.Name = "Arena_bases";
	bases.Parent = model;

	const timeA = new Instance("Folder");
	timeA.Name = "Time A";
	timeA.Parent = bases;
	const activeA = makePart("Current_Fighter_A", timeA, origin.mul(new CFrame(0, 0, -6)));
	makePart("Waiting_Fighter_A", timeA, origin.mul(new CFrame(-4, 0, -8)));
	makePart("Waiting_Fighter_A_2", timeA, origin.mul(new CFrame(4, 0, -8)));

	let cameraA: Part | undefined;
	if (options?.invalidCameraAType) {
		const folderCam = new Instance("Folder");
		folderCam.Name = "Camera_A";
		folderCam.Parent = timeA;
	} else if (!options?.omitCameraA) {
		cameraA = makePart("Camera_A", timeA, origin.mul(new CFrame(0, 5, -14)).mul(CFrame.Angles(math.rad(-10), 0, 0)));
	}

	const timeB = new Instance("Folder");
	timeB.Name = "Time B";
	timeB.Parent = bases;
	const activeB = makePart("Current_Fighter_B", timeB, origin.mul(new CFrame(0, 0, 6)).mul(CFrame.Angles(0, math.pi, 0)));
	makePart("Waiting_Fighter_B", timeB, origin.mul(new CFrame(-4, 0, 8)));
	makePart("Waiting_Fighter_B_2", timeB, origin.mul(new CFrame(4, 0, 8)));

	let cameraB: Part | undefined;
	if (!options?.omitCameraB) {
		cameraB = makePart(
			"Camera_B",
			timeB,
			origin.mul(new CFrame(0, 5, 14)).mul(CFrame.Angles(math.rad(-12), math.pi, 0)),
		);
	}
	if (options?.duplicateCameraB) {
		makePart("Camera_B", timeB, origin.mul(new CFrame(2, 5, 14)));
	}

	model.Parent = parent;
	return { model, timeA, timeB, activeA, activeB, cameraA, cameraB };
}

function makeFighters(sideA: string, sideB: string): BattleFighterSnapshot[] {
	return [
		{
			sideId: sideA,
			targetId: `${sideA}-1`,
			fighterId: "jotaro",
			className: "Fury",
			level: 1,
			s3Unlocked: false,
			hp: 100,
			hpMax: 100,
			active: true,
			slotCosts: [2, 3, 5],
		},
		{
			sideId: sideB,
			targetId: `${sideB}-1`,
			fighterId: "anubis",
			className: "Menace",
			level: 1,
			s3Unlocked: false,
			hp: 100,
			hpMax: 100,
			active: true,
			slotCosts: [2, 3, 5],
		},
	];
}

function assertNearCFrame(actual: CFrame, expected: CFrame, label: string): void {
	const posDelta = actual.Position.sub(expected.Position).Magnitude;
	const lookDelta = actual.LookVector.sub(expected.LookVector).Magnitude;
	const upDelta = actual.UpVector.sub(expected.UpVector).Magnitude;
	assert(
		posDelta < 1e-3 && lookDelta < 1e-3 && upDelta < 1e-3,
		`${label}: CFrame mismatch (posDelta=${posDelta}, lookDelta=${lookDelta}, upDelta=${upDelta})`,
	);
}

function dispatchBattleStarted(controller: CombatController, payload: BattleStartedPayload): void {
	(controller as unknown as { onBattleStarted(p: BattleStartedPayload): void }).onBattleStarted(payload);
}

function getFightersMap(controller: CombatController): Map<string, { rootPart: BasePart }> {
	return (controller as unknown as { fightersByTargetId: Map<string, { rootPart: BasePart }> }).fightersByTargetId;
}

/**
 * Executa a suíte QA L2 completa para câmeras dinâmicas por arena.
 * Retorna true se todos os cenários passarem.
 */
export function runL2CameraTests(): boolean {
	const root = new Instance("Folder");
	root.Name = "L2_TestRoot";
	const activeArenas = new Instance("Folder");
	activeArenas.Name = ACTIVE_ARENAS_FOLDER_NAME;
	activeArenas.Parent = root;

	// Decoy Arena_bases na raiz para provar que nunca há fallback quando há ArenaInstanceId
	const decoyBases = new Instance("Folder");
	decoyBases.Name = "Arena_bases";
	decoyBases.Parent = root;
	const decoyTimeA = new Instance("Folder");
	decoyTimeA.Name = "Time A";
	decoyTimeA.Parent = decoyBases;
	makePart("Current_Fighter_A", decoyTimeA, new CFrame(999, 0, 999));
	makePart("Waiting_Fighter_A", decoyTimeA, new CFrame(995, 0, 999));
	makePart("Waiting_Fighter_A_2", decoyTimeA, new CFrame(1003, 0, 999));
	makePart("Camera_A", decoyTimeA, new CFrame(999, 50, 999));
	const decoyTimeB = new Instance("Folder");
	decoyTimeB.Name = "Time B";
	decoyTimeB.Parent = decoyBases;
	makePart("Current_Fighter_B", decoyTimeB, new CFrame(999, 0, 1010));
	makePart("Waiting_Fighter_B", decoyTimeB, new CFrame(995, 0, 1010));
	makePart("Waiting_Fighter_B_2", decoyTimeB, new CFrame(1003, 0, 1010));
	makePart("Camera_B", decoyTimeB, new CFrame(999, 50, 1010));

	const fakeAssets = makeFakeAssetsRoot();
	const cam1 = new Instance("Camera");
	const cam2 = new Instance("Camera");
	const subject1 = new Instance("Part");
	subject1.Parent = root;
	const initialCFrame1 = new CFrame(10, 20, 30);
	const initialCFrame2 = new CFrame(-15, 25, -35);
	cam1.CameraType = Enum.CameraType.Custom;
	cam1.CFrame = initialCFrame1;
	cam1.CameraSubject = subject1;
	cam2.CameraType = Enum.CameraType.Custom;
	cam2.CFrame = initialCFrame2;

	const c1 = new CombatController(undefined, fakeAssets, root, 0.2, () => cam1);
	const c2 = new CombatController(undefined, fakeAssets, root, 0.2, () => cam2);

	try {
		// 1. PvE com Camera_A correta + arena movida e rotacionada + lutadores/GroundContact preservados
		const origin1 = new CFrame(100, 10, -50).mul(CFrame.Angles(0, math.rad(35), 0));
		const arena1 = makeArenaClone(activeArenas, "arena_pve_1", origin1);
		dispatchBattleStarted(c1, {
			sides: ["P1", "ENEMY"],
			fighters: makeFighters("P1", "ENEMY"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_pve_1", arenaId: "Arena_01", physicalSides: ["P1", "ENEMY"] },
		});
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Scriptable, "S1: CameraType deve ser Scriptable");
		assertNearCFrame(cam1.CFrame, arena1.cameraA!.CFrame, "S1: PvE Camera_A rotacionada");
		assert(c1.getActiveCameraPart() === arena1.cameraA, "S1: Part ativa deve ser Camera_A da arena_pve_1");
		const f1 = getFightersMap(c1).get("P1-1");
		assert(f1 !== undefined, "S1: lutador P1-1 deve existir");
		const expectedGroundY = arena1.activeA.Position.Y + arena1.activeA.Size.Y * 0.5 + 2;
		assert(math.abs(f1.rootPart.Position.Y - expectedGroundY) < 1e-2, "S1: GroundContact preservado");

		// Guarda de CameraType durante combate
		cam1.CameraType = Enum.CameraType.Custom;
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Scriptable, "S1: guarda deve manter Scriptable durante batalha");

		// 2. Encerramento (Vitória / Quit / Desconexão / Teardown) restaura câmera e limpa referências
		c1.cleanupStage();
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S2: CameraType deve restaurar para Custom");
		assertNearCFrame(cam1.CFrame, initialCFrame1, "S2: CFrame deve restaurar");
		assert(cam1.CameraSubject === subject1, "S2: CameraSubject deve restaurar");
		assert(c1.getActiveCameraPart() === undefined, "S2: não deve manter referência à Part após teardown");

		// 3. PvP com dois jogadores no MESMO clone (sorteio 1: P1=A, P2=B e sorteio 2: P2=A, P1=B)
		const originPvp = new CFrame(-200, 5, 120).mul(CFrame.Angles(0, math.rad(-90), 0));
		const arenaPvp = makeArenaClone(activeArenas, "arena_pvp_1", originPvp);
		dispatchBattleStarted(c1, {
			sides: ["b1-A", "b1-B"],
			fighters: makeFighters("b1-A", "b1-B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_pvp_1", arenaId: "Arena_01", physicalSides: ["b1-A", "b1-B"] },
		});
		dispatchBattleStarted(c2, {
			sides: ["b1-B", "b1-A"],
			fighters: makeFighters("b1-A", "b1-B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_pvp_1", arenaId: "Arena_01", physicalSides: ["b1-A", "b1-B"] },
		});
		assertNearCFrame(cam1.CFrame, arenaPvp.cameraA!.CFrame, "S3a: PvP jogador no lado físico A usa Camera_A");
		assertNearCFrame(cam2.CFrame, arenaPvp.cameraB!.CFrame, "S3a: PvP jogador no lado físico B usa Camera_B");
		// Ambos os clientes colocam b1-A no lado físico A e b1-B no lado físico B
		assert(
			getFightersMap(c1).get("b1-A-1")!.rootPart.Position.sub(getFightersMap(c2).get("b1-A-1")!.rootPart.Position).Magnitude < 1e-3,
			"S3a: PvP não inverte lutadores físicos",
		);
		c1.cleanupStage();
		c2.cleanupStage();

		// Sorteio invertido: jogador 1 cai no lado físico B, jogador 2 cai no lado físico A
		dispatchBattleStarted(c1, {
			sides: ["b2-B", "b2-A"],
			fighters: makeFighters("b2-A", "b2-B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_pvp_1", arenaId: "Arena_01", physicalSides: ["b2-A", "b2-B"] },
		});
		dispatchBattleStarted(c2, {
			sides: ["b2-A", "b2-B"],
			fighters: makeFighters("b2-A", "b2-B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_pvp_1", arenaId: "Arena_01", physicalSides: ["b2-A", "b2-B"] },
		});
		assertNearCFrame(cam1.CFrame, arenaPvp.cameraB!.CFrame, "S3b: sorteio invertido jogador 1 usa Camera_B");
		assertNearCFrame(cam2.CFrame, arenaPvp.cameraA!.CFrame, "S3b: sorteio invertido jogador 2 usa Camera_A");
		c1.cleanupStage();
		c2.cleanupStage();

		// 4. Dois clones simultâneos em ArenaSlots distintos sem mistura de câmeras
		const arenaSim1 = makeArenaClone(activeArenas, "arena_sim_1", new CFrame(300, 0, 0));
		const arenaSim2 = makeArenaClone(activeArenas, "arena_sim_2", new CFrame(600, 0, 0).mul(CFrame.Angles(0, math.rad(45), 0)));
		dispatchBattleStarted(c1, {
			sides: ["S1A", "S1B"],
			fighters: makeFighters("S1A", "S1B"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_sim_1", arenaId: "Arena_01", physicalSides: ["S1A", "S1B"] },
		});
		dispatchBattleStarted(c2, {
			sides: ["S2A", "S2B"],
			fighters: makeFighters("S2A", "S2B"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_sim_2", arenaId: "Arena_01", physicalSides: ["S2A", "S2B"] },
		});
		assert(c1.getActiveCameraPart() === arenaSim1.cameraA, "S4: clone 1 usa apenas Camera_A do clone 1");
		assert(c2.getActiveCameraPart() === arenaSim2.cameraA, "S4: clone 2 usa apenas Camera_A do clone 2");
		assertNearCFrame(cam1.CFrame, arenaSim1.cameraA!.CFrame, "S4: cam1 == arena_sim_1.Camera_A");
		assertNearCFrame(cam2.CFrame, arenaSim2.cameraA!.CFrame, "S4: cam2 == arena_sim_2.Camera_A");
		c1.cleanupStage();
		c2.cleanupStage();

		// 5. Câmera ausente, duplicada e de tipo inválido rejeitadas sem fallback e com lutadores preservados
		makeArenaClone(activeArenas, "arena_missing_cam", new CFrame(0, 0, 400), { omitCameraA: true });
		dispatchBattleStarted(c1, {
			sides: ["MA", "MB"],
			fighters: makeFighters("MA", "MB"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_missing_cam", arenaId: "Arena_01", physicalSides: ["MA", "MB"] },
		});
		task.wait(0.28);
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S5a: câmera ausente não ativa Scriptable nem usa decoy");
		assert(c1.getLastCameraDiagnostics().size() > 0, "S5a: diagnóstico claro para câmera ausente");
		assert(getFightersMap(c1).size() === 2, "S5a: lutadores preservados mesmo sem Camera_A");
		c1.cleanupStage();

		makeArenaClone(activeArenas, "arena_dup_cam", new CFrame(0, 0, 500), { duplicateCameraB: true });
		dispatchBattleStarted(c1, {
			sides: ["DB", "DA"],
			fighters: makeFighters("DA", "DB"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_dup_cam", arenaId: "Arena_01", physicalSides: ["DA", "DB"] },
		});
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S5b: câmera duplicada não ativa Scriptable");
		assert(c1.getLastCameraDiagnostics().size() > 0, "S5b: diagnóstico claro para câmera duplicada");
		c1.cleanupStage();

		makeArenaClone(activeArenas, "arena_invalid_cam", new CFrame(0, 0, 600), { invalidCameraAType: true });
		dispatchBattleStarted(c1, {
			sides: ["IA", "IB"],
			fighters: makeFighters("IA", "IB"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_invalid_cam", arenaId: "Arena_01", physicalSides: ["IA", "IB"] },
		});
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S5c: câmera não-BasePart não ativa Scriptable");
		assert(c1.getLastCameraDiagnostics().size() > 0, "S5c: diagnóstico claro para tipo inválido");
		c1.cleanupStage();

		// 6a. Replicação atrasada do clone inteiro
		const delayedOrigin = new CFrame(0, 15, -400).mul(CFrame.Angles(0, math.rad(120), 0));
		const delayedArena = makeArenaClone(undefined, "arena_delayed_clone", delayedOrigin);
		task.spawn(() => {
			dispatchBattleStarted(c1, {
				sides: ["DA1", "DB1"],
				fighters: makeFighters("DA1", "DB1"),
				mode: "PVE",
				canPause: true,
				arena: { instanceId: "arena_delayed_clone", arenaId: "Arena_01", physicalSides: ["DA1", "DB1"] },
			});
		});
		task.wait(0.06);
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S6a: antes da replicação não ativa Scriptable");
		delayedArena.model.Parent = activeArenas;
		task.wait(0.12);
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Scriptable, "S6a: após replicação atrasada ativa Scriptable");
		assertNearCFrame(cam1.CFrame, delayedArena.cameraA!.CFrame, "S6a: câmera atrasada usa CFrame do clone");
		c1.cleanupStage();

		// 6b. Replicação atrasada especificamente de Camera_A
		const delayedCamArena = makeArenaClone(activeArenas, "arena_delayed_cam", new CFrame(0, 15, -500), { omitCameraA: true });
		dispatchBattleStarted(c1, {
			sides: ["DC1", "DC2"],
			fighters: makeFighters("DC1", "DC2"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_delayed_cam", arenaId: "Arena_01", physicalSides: ["DC1", "DC2"] },
		});
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S6b: aguarda Camera_A antes de ativar Scriptable");
		task.wait(0.05);
		const lateCamA = makePart("Camera_A", delayedCamArena.timeA, new CFrame(0, 22, -514).mul(CFrame.Angles(0, math.rad(15), 0)));
		task.wait(0.12);
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Scriptable, "S6b: ativa assim que Camera_A replica");
		assertNearCFrame(cam1.CFrame, lateCamA.CFrame, "S6b: CFrame de Camera_A atrasada");
		c1.cleanupStage();

		// 7. Encerramento durante espera (cancelamento por geração)
		const cancelledArena = makeArenaClone(undefined, "arena_cancelled_wait", new CFrame(0, 15, -600));
		task.spawn(() => {
			dispatchBattleStarted(c1, {
				sides: ["CA", "CB"],
				fighters: makeFighters("CA", "CB"),
				mode: "PVE",
				canPause: true,
				arena: { instanceId: "arena_cancelled_wait", arenaId: "Arena_01", physicalSides: ["CA", "CB"] },
			});
		});
		task.wait(0.05);
		c1.cleanupStage();
		cancelledArena.model.Parent = activeArenas;
		task.wait(0.12);
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S7: batalha encerrada durante espera não ativa Scriptable");
		assert(c1.getActiveCameraPart() === undefined, "S7: sem câmera ativa após cancelamento");

		// 8. Geração antiga no CombatCameraController não sobrescreve câmera atual
		const standaloneCamCtrl = new CombatCameraController(() => cam1);
		assert(!standaloneCamCtrl.activateForArenaPart(arena1.cameraA!, 1, () => false), "S8: geração antiga rejeitada");
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S8: CameraType permanece Custom");

		// 9. Nova batalha após encerramento funciona e restaura novamente
		const arenaNext = makeArenaClone(activeArenas, "arena_next", new CFrame(40, 5, 40).mul(CFrame.Angles(0, math.rad(180), 0)));
		dispatchBattleStarted(c1, {
			sides: ["N1", "N2"],
			fighters: makeFighters("N1", "N2"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_next", arenaId: "Arena_01", physicalSides: ["N1", "N2"] },
		});
		assertNearCFrame(cam1.CFrame, arenaNext.cameraA!.CFrame, "S9: nova batalha ativa nova Camera_A");
		c1.cleanupStage();
		assert((cam1.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "S9: nova batalha restaura Custom ao encerrar");
		assertNearCFrame(cam1.CFrame, initialCFrame1, "S9: nova batalha restaura CFrame original");

		print("L2_CAMERA_TESTS_ALL_PASSED");
		return true;
	} finally {
		c1.cleanupStage();
		c2.cleanupStage();
		cam1.Destroy();
		cam2.Destroy();
		fakeAssets.Destroy();
		root.Destroy();
	}
}
