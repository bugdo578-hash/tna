import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
	ARENA_TYPE_ATTRIBUTE,
} from "../../shared/Config";
import { CombatArenaAnchorResolver } from "./CombatArenaAnchors";
import { CombatCameraController } from "./CombatCameraController";

function makePart(name: string, parent: Instance, cframe: CFrame): Part {
	const part = new Instance("Part");
	part.Name = name;
	part.Anchored = true;
	part.CFrame = cframe;
	part.Parent = parent;
	return part;
}

function makeArenaClone(
	activeArenasFolder: Folder,
	instanceId: string,
	origin: CFrame,
	options?: {
		omitCameraA?: boolean;
		duplicateCameraB?: boolean;
		invalidCameraAType?: boolean;
	},
): { model: Model; cameraA?: Part; cameraB?: Part } {
	const model = new Instance("Model");
	model.Name = instanceId;
	model.SetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE, instanceId);
	model.SetAttribute(ARENA_ID_ATTRIBUTE, "Arena_01");
	model.SetAttribute(ARENA_TYPE_ATTRIBUTE, "PVE");

	const bases = new Instance("Folder");
	bases.Name = "Arena_bases";
	bases.Parent = model;

	const timeA = new Instance("Folder");
	timeA.Name = "Time A";
	timeA.Parent = bases;
	makePart("Current_Fighter_A", timeA, origin.mul(new CFrame(0, 0, -6)));
	makePart("Waiting_Fighter_A", timeA, origin.mul(new CFrame(-4, 0, -8)));
	makePart("Waiting_Fighter_A_2", timeA, origin.mul(new CFrame(4, 0, -8)));

	let cameraA: Part | undefined;
	if (options?.invalidCameraAType) {
		const folderCam = new Instance("Folder");
		folderCam.Name = "Camera_A";
		folderCam.Parent = timeA;
	} else if (!options?.omitCameraA) {
		cameraA = makePart("Camera_A", timeA, origin.mul(new CFrame(0, 5, -14)));
	}

	const timeB = new Instance("Folder");
	timeB.Name = "Time B";
	timeB.Parent = bases;
	makePart("Current_Fighter_B", timeB, origin.mul(new CFrame(0, 0, 6)));
	makePart("Waiting_Fighter_B", timeB, origin.mul(new CFrame(-4, 0, 8)));
	makePart("Waiting_Fighter_B_2", timeB, origin.mul(new CFrame(4, 0, 8)));

	const cameraB = makePart(
		"Camera_B",
		timeB,
		origin.mul(new CFrame(0, 5, 14)).mul(CFrame.Angles(0, math.pi, 0)),
	);
	if (options?.duplicateCameraB) {
		makePart("Camera_B", timeB, origin.mul(new CFrame(2, 5, 14)));
	}

	model.Parent = activeArenasFolder;
	return { model, cameraA, cameraB };
}

function assertNearCFrame(actual: CFrame, expected: CFrame, label: string): void {
	const posDelta = actual.Position.sub(expected.Position).Magnitude;
	const lookDelta = actual.LookVector.sub(expected.LookVector).Magnitude;
	assert(posDelta < 1e-3 && lookDelta < 1e-3, `${label}: CFrame mismatch (posDelta=${posDelta}, lookDelta=${lookDelta})`);
}

/**
 * Executa a suíte QA L2 para câmeras dinâmicas por arena.
 * Retorna true se todos os cenários passarem.
 */
export function runL2CameraTests(): boolean {
	const root = new Instance("Folder");
	root.Name = "L2_TestRoot";
	const activeArenas = new Instance("Folder");
	activeArenas.Name = ACTIVE_ARENAS_FOLDER_NAME;
	activeArenas.Parent = root;

	const testCamera = new Instance("Camera");
	const initialCFrame = new CFrame(10, 20, 30);
	testCamera.CameraType = Enum.CameraType.Custom;
	testCamera.CFrame = initialCFrame;

	try {
		// 1. PvE com Camera_A correta + arena movida e rotacionada
		const origin1 = new CFrame(100, 10, -50).mul(CFrame.Angles(0, math.rad(35), 0));
		const arena1 = makeArenaClone(activeArenas, "arena_1", origin1);
		const resolver = new CombatArenaAnchorResolver(root);
		const camCtrl = new CombatCameraController(() => testCamera);

		const res1 = resolver.resolveForReservedArena(
			{
				instanceId: "arena_1",
				arenaId: "Arena_01",
				arenaType: "PVE",
				physicalSides: ["P1", "ENEMY"],
			},
			() => true,
			0.2,
		);
		assert(res1.ok, "PvE arena_1 deveria resolver");
		const camA = resolver.getCameraAnchorPart(0);
		assert(camA !== undefined && arena1.cameraA !== undefined, "Camera_A deveria existir");
		const activated = camCtrl.activateForArenaPart(camA, 1, () => true);
		assert(activated, "CameraController deveria ativar");
		assert((testCamera.CameraType as Enum.CameraType) === Enum.CameraType.Scriptable, "CameraType deveria ser Scriptable");
		assertNearCFrame(testCamera.CFrame, arena1.cameraA.CFrame, "PvE Camera_A");

		// 2. Encerramento (vitória/quit/teardown) restaura câmera
		camCtrl.restore();
		assert(testCamera.CameraType === Enum.CameraType.Custom, "CameraType deveria restaurar para Custom");
		assertNearCFrame(testCamera.CFrame, initialCFrame, "Restauração CFrame");
		assert(!camCtrl.isActive(), "CameraController não deve permanecer ativo");

		// 3. PvP: dois clones simultâneos sem mistura de câmeras + lado físico B
		const origin2 = new CFrame(-200, 5, 120).mul(CFrame.Angles(0, math.rad(-90), 0));
		const arena2 = makeArenaClone(activeArenas, "arena_2", origin2);
		const res2 = resolver.resolveForReservedArena(
			{
				instanceId: "arena_2",
				arenaId: "Arena_01",
				arenaType: "PVP",
				physicalSides: ["P1", "P2"],
			},
			() => true,
			0.2,
		);
		assert(res2.ok, "PvP arena_2 deveria resolver");
		const camB = resolver.getCameraAnchorPart(1);
		assert(camB !== undefined && arena2.cameraB !== undefined, "Camera_B deveria existir");
		camCtrl.activateForArenaPart(camB, 2, () => true);
		assertNearCFrame(testCamera.CFrame, arena2.cameraB.CFrame, "PvP Camera_B");
		camCtrl.restore();

		// 4. Câmera ausente, duplicada ou inválida rejeitada com diagnóstico
		makeArenaClone(activeArenas, "arena_missing", new CFrame(), { omitCameraA: true });
		const resMissing = resolver.resolveForReservedArena(
			{ instanceId: "arena_missing", arenaId: "Arena_01", arenaType: "PVE", physicalSides: ["A", "B"] },
			() => true,
			0.05,
		);
		assert(!resMissing.ok, "Arena sem Camera_A deve falhar");

		makeArenaClone(activeArenas, "arena_dup", new CFrame(), { duplicateCameraB: true });
		const resDup = resolver.resolveForReservedArena(
			{ instanceId: "arena_dup", arenaId: "Arena_01", arenaType: "PVE", physicalSides: ["A", "B"] },
			() => true,
			0.05,
		);
		assert(!resDup.ok, "Arena com Camera_B duplicada deve falhar");

		makeArenaClone(activeArenas, "arena_invalid", new CFrame(), { invalidCameraAType: true });
		const resInvalid = resolver.resolveForReservedArena(
			{ instanceId: "arena_invalid", arenaId: "Arena_01", arenaType: "PVE", physicalSides: ["A", "B"] },
			() => true,
			0.05,
		);
		assert(!resInvalid.ok, "Arena com Camera_A não-BasePart deve falhar");

		// 5. Geração antiga não sobrescreve câmera atual
		const staleActivated = camCtrl.activateForArenaPart(arena1.cameraA, 1, () => false);
		assert(!staleActivated, "Geração antiga não deve ativar câmera");
		assert(testCamera.CameraType === Enum.CameraType.Custom, "CameraType deve permanecer Custom");

		return true;
	} finally {
		testCamera.Destroy();
		root.Destroy();
	}
}
