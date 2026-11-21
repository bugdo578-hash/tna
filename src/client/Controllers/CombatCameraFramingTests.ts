import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
} from "../../shared/Config";
import type { BattleFighterSnapshot, BattleStartedPayload } from "../../shared/Remotes";
import {
	CAMERA_MAX_HORIZONTAL_FOV,
	CAMERA_MAX_VERTICAL_FOV,
	PLACEHOLDER_HIT_KNOCKBACK_STUDS,
} from "../UI/CombatVisualConfig";
import { hasRelevantViewportChange } from "./CombatCameraFraming";
import { CombatController } from "./CombatController";

interface ProjectedBounds {
	readonly minU: number;
	readonly maxU: number;
	readonly minV: number;
	readonly maxV: number;
	readonly minDepth: number;
}

function makePart(name: string, parent: Instance, cframe: CFrame, size = new Vector3(1, 0.2, 1)): Part {
	const part = new Instance("Part");
	part.Name = name;
	part.Anchored = true;
	part.Size = size;
	part.CFrame = cframe;
	part.Parent = parent;
	return part;
}

function makeAssetsWithStandAndWeapon(): Folder {
	const root = new Instance("Folder");
	root.Name = "L2_2_FakeAssets";
	const assets = new Instance("Folder");
	assets.Name = "Assets";
	assets.Parent = root;
	const fighters = new Instance("Folder");
	fighters.Name = "Fighters";
	fighters.Parent = assets;

	// Jotaro com Stand atrás/ao lado (similar ao rig real)
	const jotaro = new Instance("Model");
	jotaro.Name = "jotaro";
	const jHrp = new Instance("Part");
	jHrp.Name = "HumanoidRootPart";
	jHrp.Anchored = true;
	jHrp.Size = new Vector3(1.5, 2.3, 0.9);
	jHrp.CFrame = new CFrame(0, 1.15, 0);
	jHrp.Parent = jotaro;
	const jGround = new Instance("Attachment");
	jGround.Name = "GroundContact";
	jGround.Position = new Vector3(0, -1.15, 0);
	jGround.Parent = jHrp;
	const stand = new Instance("Model");
	stand.Name = "Stand";
	stand.Parent = jotaro;
	const standBody = new Instance("Part");
	standBody.Name = "StandBody";
	standBody.Anchored = false;
	standBody.Size = new Vector3(1.7, 2.8, 1.1);
	standBody.CFrame = new CFrame(-0.5, 1.7, 1.05);
	standBody.Parent = stand;
	const standWeld = new Instance("WeldConstraint");
	standWeld.Part0 = jHrp;
	standWeld.Part1 = standBody;
	standWeld.Parent = standBody;
	jotaro.PrimaryPart = jHrp;
	jotaro.Parent = fighters;

	// Anubis com espada projetada à frente e bainha atrás
	const anubis = new Instance("Model");
	anubis.Name = "anubis";
	const aHrp = new Instance("Part");
	aHrp.Name = "HumanoidRootPart";
	aHrp.Anchored = true;
	aHrp.Size = new Vector3(1.6, 2.0, 1.0);
	aHrp.CFrame = new CFrame(0, 1.0, 0);
	aHrp.Parent = anubis;
	const aGround = new Instance("Attachment");
	aGround.Name = "GroundContact";
	aGround.Position = new Vector3(0, -1.0, 0);
	aGround.Parent = aHrp;
	const sword = new Instance("Part");
	sword.Name = "Sword";
	sword.Anchored = false;
	sword.Size = new Vector3(0.3, 0.3, 4.3);
	sword.CFrame = new CFrame(0, 1.0, -0.6);
	sword.Parent = anubis;
	const swordWeld = new Instance("WeldConstraint");
	swordWeld.Part0 = aHrp;
	swordWeld.Part1 = sword;
	swordWeld.Parent = sword;
	anubis.PrimaryPart = aHrp;
	anubis.Parent = fighters;

	return root;
}

/**
 * Monta uma arena 3v3 aberta com 6 lutadores visíveis em ambos os lados e Camera_A/Camera_B
 * orientadas de frente para o palco (semelhante à geometria real de batalha).
 */
function makeOpen3v3Arena(
	parent: Instance,
	instanceId: string,
	origin: CFrame,
	cameraDistance = 6,
): { model: Model; cameraA: Part; cameraB: Part; activeA: Part; activeB: Part } {
	const model = new Instance("Model");
	model.Name = instanceId;
	model.SetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE, instanceId);
	model.SetAttribute(ARENA_ID_ATTRIBUTE, "Arena_01");

	const bases = new Instance("Folder");
	bases.Name = "Arena_bases";
	bases.Parent = model;

	const timeA = new Instance("Folder");
	timeA.Name = "Time A";
	timeA.Parent = bases;
	const activeA = makePart("Current_Fighter_A", timeA, origin.mul(new CFrame(-7, 0, 0)).mul(CFrame.Angles(0, -math.pi * 0.5, 0)));
	makePart("Waiting_Fighter_A", timeA, origin.mul(new CFrame(-8.5, 0, -2.5)).mul(CFrame.Angles(0, -math.pi * 0.5, 0)));
	makePart("Waiting_Fighter_A_2", timeA, origin.mul(new CFrame(-8.5, 0, 2.5)).mul(CFrame.Angles(0, -math.pi * 0.5, 0)));
	// Camera_A posicionada em +Z olhando para -Z (eixo local padrão de LookVector)
	const cameraA = makePart("Camera_A", timeA, origin.mul(new CFrame(0, 2.5, cameraDistance)));

	const timeB = new Instance("Folder");
	timeB.Name = "Time B";
	timeB.Parent = bases;
	const activeB = makePart("Current_Fighter_B", timeB, origin.mul(new CFrame(7, 0, 0)).mul(CFrame.Angles(0, math.pi * 0.5, 0)));
	makePart("Waiting_Fighter_B", timeB, origin.mul(new CFrame(8.5, 0, -2.5)).mul(CFrame.Angles(0, math.pi * 0.5, 0)));
	makePart("Waiting_Fighter_B_2", timeB, origin.mul(new CFrame(8.5, 0, 2.5)).mul(CFrame.Angles(0, math.pi * 0.5, 0)));
	// Camera_B posicionada em -Z olhando para +Z
	const cameraB = makePart("Camera_B", timeB, origin.mul(new CFrame(0, 2.5, -cameraDistance)).mul(CFrame.Angles(0, math.pi, 0)));

	model.Parent = parent;
	return { model, cameraA, cameraB, activeA, activeB };
}

function make3v3Fighters(sideA: string, sideB: string): BattleFighterSnapshot[] {
	return [
		{ sideId: sideA, targetId: `${sideA}-1`, fighterId: "jotaro", className: "Fury", level: 5, s3Unlocked: false, hp: 100, hpMax: 100, active: true, slotCosts: [2, 4, 8] },
		{ sideId: sideA, targetId: `${sideA}-2`, fighterId: "anubis", className: "Menace", level: 5, s3Unlocked: false, hp: 100, hpMax: 100, active: false, slotCosts: [2, 4, 8] },
		{ sideId: sideA, targetId: `${sideA}-3`, fighterId: "jotaro", className: "Fury", level: 5, s3Unlocked: false, hp: 100, hpMax: 100, active: false, slotCosts: [2, 4, 8] },
		{ sideId: sideB, targetId: `${sideB}-1`, fighterId: "anubis", className: "Menace", level: 5, s3Unlocked: false, hp: 100, hpMax: 100, active: true, slotCosts: [2, 4, 8] },
		{ sideId: sideB, targetId: `${sideB}-2`, fighterId: "jotaro", className: "Fury", level: 5, s3Unlocked: false, hp: 100, hpMax: 100, active: false, slotCosts: [2, 4, 8] },
		{ sideId: sideB, targetId: `${sideB}-3`, fighterId: "anubis", className: "Menace", level: 5, s3Unlocked: false, hp: 100, hpMax: 100, active: false, slotCosts: [2, 4, 8] },
	];
}

function projectModel(model: Model, cameraCFrame: CFrame, verticalFov: number, viewportSize: Vector2, extraOffset = Vector3.zero): ProjectedBounds {
	const [bbCF, bbSize] = model.GetBoundingBox();
	const half = bbSize.mul(0.5);
	const aspect = viewportSize.X / viewportSize.Y;
	const tanV = math.tan(math.rad(verticalFov * 0.5));
	const tanH = tanV * aspect;

	let minU = math.huge;
	let maxU = -math.huge;
	let minV = math.huge;
	let maxV = -math.huge;
	let minDepth = math.huge;

	for (const sx of [-1, 1]) {
		for (const sy of [-1, 1]) {
			for (const sz of [-1, 1]) {
				const worldPt = bbCF.PointToWorldSpace(new Vector3(sx * half.X, sy * half.Y, sz * half.Z)).add(extraOffset);
				const rel = cameraCFrame.PointToObjectSpace(worldPt);
				const depth = -rel.Z;
				if (depth < minDepth) minDepth = depth;
				const u = 0.5 + (rel.X / (depth * tanH)) * 0.5;
				const v = 0.5 - (rel.Y / (depth * tanV)) * 0.5;
				if (u < minU) minU = u;
				if (u > maxU) maxU = u;
				if (v < minV) minV = v;
				if (v > maxV) maxV = v;
			}
		}
	}

	return { minU, maxU, minV, maxV, minDepth };
}

function assertPreservesReferenceAxis(actual: CFrame, reference: CFrame, label: string): number {
	const rightDelta = actual.RightVector.sub(reference.RightVector).Magnitude;
	const upDelta = actual.UpVector.sub(reference.UpVector).Magnitude;
	const lookDelta = actual.LookVector.sub(reference.LookVector).Magnitude;
	assert(
		rightDelta < 1e-4 && upDelta < 1e-4 && lookDelta < 1e-4,
		`${label}: orientação de referência alterada (r=${rightDelta}, u=${upDelta}, l=${lookDelta})`,
	);
	const localPos = reference.PointToObjectSpace(actual.Position);
	assert(
		math.abs(localPos.X) < 1e-3 && math.abs(localPos.Y) < 1e-3 && localPos.Z >= -1e-3,
		`${label}: posição fora do eixo -LookVector de referência (local=${tostring(localPos)})`,
	);
	return localPos.Z;
}

function dispatchBattleStarted(controller: CombatController, payload: BattleStartedPayload): void {
	(controller as unknown as { onBattleStarted(p: BattleStartedPayload): void }).onBattleStarted(payload);
}

/**
 * Executa a suíte QA L2.2 para enquadramento adaptativo da câmera em múltiplas resoluções:
 * PC 16:9, janela estreita, 4:3, celular 9:16 e tela larga, além de PvP, resize e teardown de FOV/FieldOfViewMode.
 */
export function runL2_2AdaptiveCameraTests(): boolean {
	const root = new Instance("Folder");
	root.Name = "L2_2_TestRoot";
	const activeArenas = new Instance("Folder");
	activeArenas.Name = ACTIVE_ARENAS_FOLDER_NAME;
	activeArenas.Parent = root;

	const fakeAssets = makeAssetsWithStandAndWeapon();
	const camA = new Instance("Camera");
	const camB = new Instance("Camera");
	const subjectA = new Instance("Part");
	subjectA.Parent = root;

	const initialCFA = new CFrame(5, 12, -20);
	const initialCFB = new CFrame(-8, 15, 25);
	camA.CameraType = Enum.CameraType.Custom;
	camA.CFrame = initialCFA;
	camA.CameraSubject = subjectA;
	camA.FieldOfViewMode = Enum.FieldOfViewMode.Diagonal;
	camA.FieldOfView = 74;

	camB.CameraType = Enum.CameraType.Custom;
	camB.CFrame = initialCFB;
	camB.FieldOfViewMode = Enum.FieldOfViewMode.MaxAxis;
	camB.FieldOfView = 70;

	let viewportA = new Vector2(1920, 1080);
	let viewportB = new Vector2(1024, 768);

	const ctrlA = new CombatController(undefined, fakeAssets, root, 0.2, () => camA, () => viewportA);
	const ctrlB = new CombatController(undefined, fakeAssets, root, 0.2, () => camB, () => viewportB);

	try {
		// 1. Arena rotacionada e transladada: testa 16:9, janela estreita, 4:3, celular 9:16 e tela larga
		const rotatedOrigin = new CFrame(180, 12, -90).mul(CFrame.Angles(0, math.rad(37), 0));
		const arenaClose = makeOpen3v3Arena(activeArenas, "arena_l22_close", rotatedOrigin, 6);

		const resolutions: readonly { readonly label: string; readonly size: Vector2 }[] = [
			{ label: "PC 16:9", size: new Vector2(1920, 1080) },
			{ label: "Janela estreita", size: new Vector2(1280, 900) },
			{ label: "PC 4:3", size: new Vector2(1024, 768) },
			{ label: "Celular 9:16", size: new Vector2(414, 736) },
			{ label: "Studio largo", size: new Vector2(1501, 586) },
		];

		dispatchBattleStarted(ctrlA, {
			sides: ["P1", "ENEMY"],
			fighters: make3v3Fighters("P1", "ENEMY"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_l22_close", arenaId: "Arena_01", physicalSides: ["P1", "ENEMY"] },
		});

		const fighterIds = ["P1-1", "P1-2", "P1-3", "ENEMY-1", "ENEMY-2", "ENEMY-3"];
		const pullbackByRes = new Map<string, number>();

		for (const res of resolutions) {
			viewportA = res.size;
			assert(ctrlA.refreshCameraFraming(false), `${res.label}: refreshCameraFraming deve recalcular`);
			assert((camA.CameraType as Enum.CameraType) === Enum.CameraType.Scriptable, `${res.label}: Scriptable ativo`);
			assert((camA.FieldOfViewMode as Enum.FieldOfViewMode) === Enum.FieldOfViewMode.Vertical, `${res.label}: modo Vertical durante batalha`);
			assert(camA.FieldOfView <= CAMERA_MAX_VERTICAL_FOV + 1e-3, `${res.label}: FOV vertical dentro do teto`);

			const aspect = res.size.X / res.size.Y;
			const horizFov = math.deg(2 * math.atan(math.tan(math.rad(camA.FieldOfView * 0.5)) * aspect));
			if (res.label !== "Studio largo") {
				assert(
					horizFov <= math.max(CAMERA_MAX_HORIZONTAL_FOV, 125) + 1e-2,
					`${res.label}: FOV horizontal razoável (${horizFov})`,
				);
			}

			const pullback = assertPreservesReferenceAxis(camA.CFrame, arenaClose.cameraA.CFrame, res.label);
			pullbackByRes.set(res.label, pullback);

			for (const tid of fighterIds) {
				const model = ctrlA.getFighterModel(tid);
				assert(model !== undefined, `${res.label}: modelo ${tid} existe`);
				const proj = projectModel(model, camA.CFrame, camA.FieldOfView, res.size);
				assert(proj.minDepth > 0.5, `${res.label}: ${tid} na frente da câmera (depth=${proj.minDepth})`);
				assert(
					proj.minU >= 0 && proj.maxU <= 1 && proj.minV >= 0 && proj.maxV <= 1,
					`${res.label}: ${tid} cortado (u=[${proj.minU},${proj.maxU}], v=[${proj.minV},${proj.maxV}])`,
				);
			}

			// Margem de animação (knockback crítico no ativo) também permanece dentro da tela
			const activeModel = ctrlA.getFighterModel("P1-1")!;
			const knockDir = arenaClose.activeA.CFrame.LookVector.mul(-PLACEHOLDER_HIT_KNOCKBACK_STUDS * 1.4);
			const projKnock = projectModel(activeModel, camA.CFrame, camA.FieldOfView, res.size, knockDir);
			assert(
				projKnock.minU >= 0 && projKnock.maxU <= 1 && projKnock.minV >= 0 && projKnock.maxV <= 1,
				`${res.label}: ativo em knockback cortado (u=[${projKnock.minU},${projKnock.maxU}], v=[${projKnock.minV},${projKnock.maxV}])`,
			);
		}

		// Tela larga não pode ficar mais afastada que 16:9 ou 9:16
		assert(
			pullbackByRes.get("Studio largo")! <= pullbackByRes.get("PC 16:9")! + 1e-2,
			"Tela larga não deve afastar mais que 16:9",
		);
		assert(
			pullbackByRes.get("PC 16:9")! < pullbackByRes.get("Celular 9:16")!,
			"Celular 9:16 deve recuar mais que PC 16:9 para manter ambos os times visíveis",
		);

		// GroundContact preservado no ativo
		const activeP1 = ctrlA.getFighterModel("P1-1")!;
		const expectedY = arenaClose.activeA.Position.Y + arenaClose.activeA.Size.Y * 0.5 + 1.15;
		assert(
			math.abs(activeP1.PrimaryPart!.Position.Y - expectedY) < 1e-2,
			"L2.2: GroundContact preservado",
		);

		// 2. Mudança irrelevante de ViewportSize (<2px) é ignorada; relevante recalcula
		assert(!hasRelevantViewportChange(new Vector2(1920, 1080), new Vector2(1921, 1080)), "Jitter de 1px ignorado");
		assert(hasRelevantViewportChange(new Vector2(1920, 1080), new Vector2(1024, 768)), "Troca 16:9->4:3 relevante");

		// Guarda de CameraType preserva o enquadramento adaptativo (não volta para Camera_A crua)
		viewportA = new Vector2(414, 736);
		ctrlA.refreshCameraFraming(false);
		const mobileCF = camA.CFrame;
		const mobileFov = camA.FieldOfView;
		camA.CameraType = Enum.CameraType.Custom;
		assert((camA.CameraType as Enum.CameraType) === Enum.CameraType.Scriptable, "Guarda mantém Scriptable");
		assert(camA.CFrame.Position.sub(mobileCF.Position).Magnitude < 1e-3, "Guarda preserva CFrame adaptativo");
		assert(math.abs(camA.FieldOfView - mobileFov) < 1e-3, "Guarda preserva FOV adaptativo");

		// 3. Teardown restaura CameraType, CFrame, CameraSubject, FieldOfView e FieldOfViewMode originais
		ctrlA.cleanupStage();
		assert((camA.CameraType as Enum.CameraType) === Enum.CameraType.Custom, "Teardown restaura CameraType");
		assert(camA.CFrame.Position.sub(initialCFA.Position).Magnitude < 1e-3, "Teardown restaura CFrame");
		assert(camA.CameraSubject === subjectA, "Teardown restaura CameraSubject");
		assert((camA.FieldOfViewMode as Enum.FieldOfViewMode) === Enum.FieldOfViewMode.Diagonal, "Teardown restaura FieldOfViewMode original");
		assert(math.abs(camA.FieldOfView - 74) < 1e-3, "Teardown restaura FieldOfView original");
		assert(!ctrlA.refreshCameraFraming(true), "Após teardown refreshCameraFraming é no-op");

		// 4. Quando a referência já comporta tudo em tela larga, não recua nem altera FOV
		const arenaWideRef = makeOpen3v3Arena(activeArenas, "arena_l22_wide_ref", new CFrame(-200, 0, 100), 18);
		viewportA = new Vector2(1920, 1080);
		camA.FieldOfViewMode = Enum.FieldOfViewMode.Vertical;
		camA.FieldOfView = 70;
		dispatchBattleStarted(ctrlA, {
			sides: ["W1", "W2"],
			fighters: make3v3Fighters("W1", "W2"),
			mode: "PVE",
			canPause: true,
			arena: { instanceId: "arena_l22_wide_ref", arenaId: "Arena_01", physicalSides: ["W1", "W2"] },
		});
		const wideFrame = ctrlA.getLastAppliedCameraFrame();
		assert(wideFrame !== undefined && !wideFrame.adjusted && wideFrame.pullbackStuds === 0, "Tela larga sem recuo desnecessário");
		assert(
			camA.CFrame.Position.sub(arenaWideRef.cameraA.CFrame.Position).Magnitude < 1e-3,
			"Sem recuo mantém posição exata da Part de referência",
		);
		assert(math.abs(camA.FieldOfView - 70) < 1e-3, "Sem recuo mantém FOV base");
		ctrlA.cleanupStage();

		// 5. PvP com dois clientes em resoluções diferentes (16:9 no lado B e 9:16 no lado A) + restauração independente
		const pvpOrigin = new CFrame(400, 5, 220).mul(CFrame.Angles(0, math.rad(-90), 0));
		const arenaPvp = makeOpen3v3Arena(activeArenas, "arena_l22_pvp", pvpOrigin, 6);
		viewportA = new Vector2(1920, 1080);
		viewportB = new Vector2(414, 736);
		dispatchBattleStarted(ctrlA, {
			sides: ["pvp-B", "pvp-A"],
			fighters: make3v3Fighters("pvp-A", "pvp-B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_l22_pvp", arenaId: "Arena_01", physicalSides: ["pvp-A", "pvp-B"] },
		});
		dispatchBattleStarted(ctrlB, {
			sides: ["pvp-A", "pvp-B"],
			fighters: make3v3Fighters("pvp-A", "pvp-B"),
			mode: "PVP",
			canPause: false,
			arena: { instanceId: "arena_l22_pvp", arenaId: "Arena_01", physicalSides: ["pvp-A", "pvp-B"] },
		});
		assertPreservesReferenceAxis(camA.CFrame, arenaPvp.cameraB.CFrame, "PvP cliente 1 lado B usa Camera_B");
		assertPreservesReferenceAxis(camB.CFrame, arenaPvp.cameraA.CFrame, "PvP cliente 2 lado A usa Camera_A");
		for (const tid of ["pvp-A-1", "pvp-A-2", "pvp-A-3", "pvp-B-1", "pvp-B-2", "pvp-B-3"]) {
			const pA = projectModel(ctrlA.getFighterModel(tid)!, camA.CFrame, camA.FieldOfView, viewportA);
			assert(pA.minU >= 0 && pA.maxU <= 1 && pA.minV >= 0 && pA.maxV <= 1, `PvP camA ${tid} visível`);
			const pB = projectModel(ctrlB.getFighterModel(tid)!, camB.CFrame, camB.FieldOfView, viewportB);
			assert(pB.minU >= 0 && pB.maxU <= 1 && pB.minV >= 0 && pB.maxV <= 1, `PvP camB ${tid} visível`);
		}
		ctrlA.cleanupStage();
		ctrlB.cleanupStage();
		assert((camB.FieldOfViewMode as Enum.FieldOfViewMode) === Enum.FieldOfViewMode.MaxAxis, "PvP teardown restaura FieldOfViewMode MaxAxis");
		assert(math.abs(camB.FieldOfView - 70) < 1e-3, "PvP teardown restaura FieldOfView");
		assert(camB.CFrame.Position.sub(initialCFB.Position).Magnitude < 1e-3, "PvP teardown restaura CFrame");

		print("L2_2_ADAPTIVE_CAMERA_TESTS_ALL_PASSED");
		return true;
	} finally {
		ctrlA.cleanupStage();
		ctrlB.cleanupStage();
		camA.Destroy();
		camB.Destroy();
		fakeAssets.Destroy();
		root.Destroy();
	}
}
