// Testes L3: transporte físico autoritativo dos jogadores para as gaiolas da arena e restauração segura.
import { Players, Workspace } from "@rbxts/services";
import {
	ARENA_BASES_CONTAINER_NAME, ARENA_ID_ATTRIBUTE, ARENA_OPTIONAL_CAMERA_NAMES,
	ARENA_PLAYER_CAGE_FOLDER_NAME, ARENA_PLAYER_CAGE_MAX_DRIFT_STUDS,
	ARENA_PLAYER_SPAWN_A_NAME, ARENA_PLAYER_SPAWN_B_NAME,
	ARENA_REQUIRED_ANCHOR_NAMES, ARENA_REQUIRED_TEAM_FOLDERS,
	BATTLE_INACTIVITY_TIMEOUT_SECONDS, BATTLE_STALL_TIMEOUT_SECONDS,
	NPC_BATTLE_ACTIVE_ATTRIBUTE, PVP_INVITE_INTERVAL_SECONDS,
} from "../../../shared/Config";
import type { BattleStartedPayload, ChallengeReceivedPayload } from "../../../shared/Remotes";
import { ArenaPlayerTransportService } from "../../Services/ArenaPlayerTransport";
import { ArenaRegistry } from "../../Services/ArenaRegistry";
import { BattleMovement } from "./arenaPlayerTransportTestUtils";
import type { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import { InMemoryDataStore } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { PvpService } from "../../Services/PvpService";
import { createDummySide } from "../DummyFighters";
import { buildTestSlotPart } from "./arenaRegistryTests";
import { assertInvariant, createSeededRng, createSurgicalMockAdapter, SIMULATION_DT } from "./testHelpers";

interface CageTemplateOptions {
	readonly spawnKind?: "Attachment" | "Part";
	readonly shuffleCageChildren?: boolean;
}

function assertCFrameNear(actual: CFrame, expected: CFrame, label: string): void {
	const posDelta = actual.Position.sub(expected.Position).Magnitude;
	const lookDelta = actual.LookVector.sub(expected.LookVector).Magnitude;
	const upDelta = actual.UpVector.sub(expected.UpVector).Magnitude;
	assertInvariant(posDelta < 1e-3 && lookDelta < 1e-3 && upDelta < 1e-3, `${label}: CFrame divergente`);
}

function buildCageArenaTemplate(
	parent: Instance,
	modelName: string,
	arenaId: string,
	origin: CFrame,
	options: CageTemplateOptions = {},
): Model {
	const model = new Instance("Model");
	model.Name = modelName;
	model.SetAttribute(ARENA_ID_ATTRIBUTE, arenaId);
	const bases = new Instance("Part");
	bases.Name = ARENA_BASES_CONTAINER_NAME;
	bases.Size = new Vector3(25, 0.1, 25);
	bases.Anchored = true;
	bases.CanCollide = false;
	bases.CFrame = origin;
	bases.Parent = model;
	model.PrimaryPart = bases;

	for (const sideIdx of [0, 1] as const) {
		const dir = sideIdx === 0 ? 1 : -1;
		const folder = new Instance("Folder");
		folder.Name = ARENA_REQUIRED_TEAM_FOLDERS[sideIdx];
		folder.Parent = bases;
		const names = ARENA_REQUIRED_ANCHOR_NAMES[sideIdx];
		const active = new Instance("Part");
		active.Name = names.active;
		active.Size = new Vector3(0.5, 0.05, 0.5);
		active.Anchored = true;
		active.CanCollide = false;
		active.CFrame = origin.mul(new CFrame(7 * dir, 0.03, 0));
		active.Parent = folder;

		const vfxNode = new Instance("Part");
		vfxNode.Name = sideIdx === 0 ? "Current_Figther_A_vfx_green" : "Current_Figther_B_vfx_red";
		vfxNode.Size = new Vector3(0.2, 0.2, 0.2);
		vfxNode.Anchored = true;
		vfxNode.CanCollide = false;
		vfxNode.CFrame = active.CFrame;
		vfxNode.Parent = active;

		for (const [wIdx, wName] of [[0, names.waiting[0]], [1, names.waiting[1]]] as const) {
			const wPart = new Instance("Part");
			wPart.Name = wName;
			wPart.Size = new Vector3(0.5, 0.05, 0.5);
			wPart.Anchored = true;
			wPart.CanCollide = false;
			wPart.CFrame = origin.mul(new CFrame(7.5 * dir, -3, wIdx === 0 ? 4.5 : -4.5));
			wPart.Parent = folder;
		}
		const cam = new Instance("Part");
		cam.Name = ARENA_OPTIONAL_CAMERA_NAMES[sideIdx];
		cam.Size = new Vector3(1, 1, 1);
		cam.Anchored = true;
		cam.CanCollide = false;
		cam.CFrame = origin.mul(new CFrame(0, 2.5, sideIdx === 0 ? -6 : 6)).mul(CFrame.Angles(0, sideIdx === 0 ? math.pi : 0, 0));
		cam.Parent = folder;
	}

	const cage = new Instance("Folder");
	cage.Name = ARENA_PLAYER_CAGE_FOLDER_NAME;
	cage.Parent = bases;
	const wallOffsets = [
		new CFrame(10.2, -20, 0).mul(CFrame.Angles(math.rad(-90), math.rad(90), 0)),
		new CFrame(0.2, -20, 12.2).mul(CFrame.Angles(math.rad(-90), 0, 0)),
		new CFrame(-10.4, -20, 0).mul(CFrame.Angles(math.rad(-90), math.rad(90), 0)),
		new CFrame(0.2, -20, -10.6).mul(CFrame.Angles(math.rad(-90), 0, 0)),
	];
	const walls: Part[] = [];
	for (const wallCf of wallOffsets) {
		const wall = new Instance("Part");
		wall.Name = "gaiola players";
		wall.Size = new Vector3(25, 1, 25);
		wall.Anchored = true;
		wall.CanCollide = true;
		wall.CFrame = origin.mul(wallCf);
		walls.push(wall);
	}

	const floor = new Instance("SpawnLocation");
	floor.Name = "SpawnLocation";
	floor.Size = new Vector3(25, 1, 25);
	floor.Anchored = true;
	floor.CanCollide = true;
	floor.Enabled = false;
	floor.CFrame = origin.mul(new CFrame(0, -22.3, 0)).mul(CFrame.Angles(0, math.rad(90), 0));

	const spawnACfLocal = new CFrame(6, -18.8, 0).mul(CFrame.Angles(0, math.rad(90), 0));
	const spawnBCfLocal = new CFrame(-6, -18.8, 0).mul(CFrame.Angles(0, math.rad(-90), 0));
	const extraChildren: Instance[] = [];
	if ((options.spawnKind ?? "Attachment") === "Attachment") {
		const attA = new Instance("Attachment");
		attA.Name = ARENA_PLAYER_SPAWN_A_NAME;
		attA.CFrame = floor.CFrame.ToObjectSpace(origin.mul(spawnACfLocal));
		attA.Parent = floor;
		const attB = new Instance("Attachment");
		attB.Name = ARENA_PLAYER_SPAWN_B_NAME;
		attB.CFrame = floor.CFrame.ToObjectSpace(origin.mul(spawnBCfLocal));
		attB.Parent = floor;
	} else {
		for (const [sName, sCf] of [[ARENA_PLAYER_SPAWN_A_NAME, spawnACfLocal], [ARENA_PLAYER_SPAWN_B_NAME, spawnBCfLocal]] as const) {
			const part = new Instance("Part");
			part.Name = sName;
			part.Size = new Vector3(2, 0.5, 2);
			part.Anchored = true;
			part.CanCollide = false;
			part.Transparency = 1;
			part.CFrame = origin.mul(sCf);
			extraChildren.push(part);
		}
	}

	const ordered = options.shuffleCageChildren
		? [...extraChildren, walls[2], floor, walls[0], walls[3], walls[1]]
		: [walls[0], walls[1], walls[2], floor, walls[3], ...extraChildren];
	for (const item of ordered) item.Parent = cage;
	model.Parent = parent;
	return model;
}

function getExpectedSpawnCFrame(arenaModel: Model, sideIndex: 0 | 1): CFrame {
	const cage = arenaModel.FindFirstChild(ARENA_BASES_CONTAINER_NAME)!.FindFirstChild(ARENA_PLAYER_CAGE_FOLDER_NAME)!;
	const name = sideIndex === 0 ? ARENA_PLAYER_SPAWN_A_NAME : ARENA_PLAYER_SPAWN_B_NAME;
	const direct = cage.FindFirstChild(name);
	if (direct !== undefined && direct.IsA("BasePart")) return direct.CFrame;
	const floor = cage.FindFirstChild("SpawnLocation") as BasePart;
	const att = floor.FindFirstChild(name) as Attachment;
	return att.WorldCFrame;
}

function validatePvePvpAlternationAndRotation(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Parent = root;

	buildCageArenaTemplate(templates, "Arena_L3_Att", "arena_l3_att", new CFrame(100, 10, 50), {
		spawnKind: "Attachment",
		shuffleCageChildren: true,
	});
	buildCageArenaTemplate(templates, "Arena_L3_Part", "arena_l3_part", new CFrame(-200, 20, 80), {
		spawnKind: "Part",
		shuffleCageChildren: true,
	});

	const slot1Cf = new CFrame(1250, 85, -940).mul(CFrame.Angles(0, math.rad(135), 0));
	const slot2Cf = new CFrame(-1800, 40, 620).mul(CFrame.Angles(0, math.rad(-60), 0));
	buildTestSlotPart(slots, "Slot_01", slot1Cf);
	buildTestSlotPart(slots, "Slot_02", slot2Cf);

	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: activeParent,
		rng: createSeededRng(3001),
		warnFn: () => {},
	});
	registry.start();

	const p1Orig = new CFrame(12, 4, -18).mul(CFrame.Angles(0, math.rad(25), 0));
	const p2Orig = new CFrame(18, 4, -14).mul(CFrame.Angles(0, math.rad(-40), 0));
	const p3Orig = new CFrame(-45, 4, 30);
	const p4Orig = new CFrame(-40, 4, 32);
	const p1 = BattleMovement.makePlayer(996001, "L3_P1", p1Orig);
	const p2 = BattleMovement.makePlayer(996002, "L3_P2", p2Orig);
	const p3 = BattleMovement.makePlayer(996003, "L3_P3", p3Orig);
	const p4 = BattleMovement.makePlayer(996004, "L3_P4", p4Orig);

	const progression = new ProgressionService();
	let now = 1000;
	let pvpRoll = 0.1;
	const data = new PlayerDataService(progression, {
		dataStore: new InMemoryDataStore(),
		serverId: "L3TransportServer",
		now: () => now,
		waitFn: () => {},
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	for (const p of [p1, p2, p3, p4]) assertInvariant(data.loadPlayer(p.player).ok, `load ${p.mock.Name}`);

	const starts = new Map<Player, BattleStartedPayload>();
	const sessions = new BattleSessionService(
		createSurgicalMockAdapter({ onBattleStarted: (pl, payload) => starts.set(pl, payload) }),
		undefined,
		progression,
		registry,
	);
	let lastInvite: ChallengeReceivedPayload | undefined;
	const pvp = new PvpService(
		sessions,
		data,
		progression,
		(_, payload) => { lastInvite = payload; },
		() => {},
		() => now,
		() => pvpRoll,
	);

	// 1) PvE e Boss transportam apenas o jogador humano para PlayerSpawn_A (Attachment e Part, arena rotacionada)
	for (const kind of ["PVE", "BOSS"] as const) {
		const rng = () => 0.5;
		const rel = BattleMovement.freeze(p1.player, p1.humanoid, () => sessions.destroySessionForPlayer(p1.player));
		assertInvariant(
			sessions.createSession(p1.player, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE", rel, kind),
			`cria ${kind}`,
		);
		const res = sessions.getSessionArenaReservation(p1.player)!;
		const expectedA = getExpectedSpawnCFrame(res.instance, 0);
		assertCFrameNear(p1.root.CFrame, expectedA, `${kind} transportado para PlayerSpawn_A rotacionado`);
		assertCFrameNear(p2.root.CFrame, p2Orig, `${kind} não move outros jogadores`);

		const bases = res.instance.FindFirstChild(ARENA_BASES_CONTAINER_NAME)!;
		const cage = bases.FindFirstChild(ARENA_PLAYER_CAGE_FOLDER_NAME)!;
		const walls = cage.GetChildren().filter((c) => c.Name === "gaiola players");
		assertInvariant(walls.size() === 4 && cage.FindFirstChild("SpawnLocation") !== undefined, "4 gaiola players e SpawnLocation preservados");
		assertInvariant(
			bases.FindFirstChild("Time A")?.FindFirstChild("Camera_A") !== undefined &&
				bases.FindFirstChild("Time B")?.FindFirstChild("Camera_B") !== undefined &&
				bases.FindFirstChild("Time A")?.FindFirstChild("Current_Fighter_A")?.FindFirstChild("Current_Figther_A_vfx_green") !== undefined &&
				bases.FindFirstChild("Time B")?.FindFirstChild("Current_Fighter_B")?.FindFirstChild("Current_Figther_B_vfx_red") !== undefined,
			"câmeras L2 e contrato VFX preservados",
		);

		assertInvariant(!p1.root.Anchored, "HumanoidRootPart não fica ancorado permanentemente");
		p1.root.CFrame = expectedA.mul(new CFrame(ARENA_PLAYER_CAGE_MAX_DRIFT_STUDS + 5, 0, 0));
		sessions.step(SIMULATION_DT);
		assertCFrameNear(p1.root.CFrame, expectedA, "contenção física devolve jogador que saiu da gaiola");

		sessions.requestQuit(p1.player);
		assertCFrameNear(p1.root.CFrame, p1Orig, `${kind} restaura CFrame original ao sair`);
		assertInvariant(p1.humanoid.WalkSpeed === 16 && !p1.root.Anchored, `${kind} restaura movimento`);
	}

	// 2, 3 e 4) PvP + Alternância L2.1 (90/10) + Duas arenas simultâneas sem misturar jogadores
	now += PVP_INVITE_INTERVAL_SECONDS + 1;
	pvpRoll = 0.1;
	assertInvariant(pvp.challenge(p1.player, p2.player) && pvp.respond(p2.player, { inviteId: lastInvite!.inviteId, accept: true }), "PvP match 1");
	const resMatch1 = sessions.getSessionArenaReservation(p1.player)!;
	assertCFrameNear(p1.root.CFrame, getExpectedSpawnCFrame(resMatch1.instance, 0), "Match 1: p1 em PlayerSpawn_A");
	assertCFrameNear(p2.root.CFrame, getExpectedSpawnCFrame(resMatch1.instance, 1), "Match 1: p2 em PlayerSpawn_B");

	pvpRoll = 0.8;
	assertInvariant(pvp.challenge(p3.player, p4.player) && pvp.respond(p4.player, { inviteId: lastInvite!.inviteId, accept: true }), "PvP simultâneo match 2");
	const resMatch2 = sessions.getSessionArenaReservation(p3.player)!;
	assertInvariant(resMatch1.instanceId !== resMatch2.instanceId, "clones distintos simultâneos");
	const m2SpawnA = getExpectedSpawnCFrame(resMatch2.instance, 0);
	const m2SpawnB = getExpectedSpawnCFrame(resMatch2.instance, 1);
	assertCFrameNear(p3.root.CFrame, m2SpawnB, "Arena 2: p3 em PlayerSpawn_B do clone 2");
	assertCFrameNear(p4.root.CFrame, m2SpawnA, "Arena 2: p4 em PlayerSpawn_A do clone 2");
	assertInvariant(p1.root.Position.sub(p3.root.Position).Magnitude > 500, "arenas simultâneas fisicamente isoladas");

	sessions.requestQuit(p2.player);
	assertCFrameNear(p1.root.CFrame, p1Orig, "p1 restaurado após Match 1");
	assertCFrameNear(p2.root.CFrame, p2Orig, "p2 restaurado após Match 1");
	assertCFrameNear(p3.root.CFrame, m2SpawnB, "p3 permanece intacto na Arena 2");
	assertCFrameNear(p4.root.CFrame, m2SpawnA, "p4 permanece intacto na Arena 2");

	now += PVP_INVITE_INTERVAL_SECONDS + 1;
	pvpRoll = 0.2;
	p1.root.CFrame = p1Orig;
	p2.root.CFrame = p2Orig;
	assertInvariant(pvp.challenge(p1.player, p2.player) && pvp.respond(p2.player, { inviteId: lastInvite!.inviteId, accept: true }), "PvP revanche L2.1");
	const resRematch = sessions.getSessionArenaReservation(p1.player)!;
	assertCFrameNear(p1.root.CFrame, getExpectedSpawnCFrame(resRematch.instance, 1), "Revanche L2.1: p1 alternou para PlayerSpawn_B");
	assertCFrameNear(p2.root.CFrame, getExpectedSpawnCFrame(resRematch.instance, 0), "Revanche L2.1: p2 alternou para PlayerSpawn_A");

	sessions.requestQuit(p1.player);
	sessions.requestQuit(p3.player);
	assertCFrameNear(p1.root.CFrame, p1Orig, "p1 restaurado pós-revanche");
	assertCFrameNear(p2.root.CFrame, p2Orig, "p2 restaurado pós-revanche");
	assertCFrameNear(p3.root.CFrame, p3Orig, "p3 restaurado pós-Arena 2");
	assertCFrameNear(p4.root.CFrame, p4Orig, "p4 restaurado pós-Arena 2");

	for (const p of [p1, p2, p3, p4]) {
		pvp.forgetPlayer(p.player);
		data.handlePlayerRemoving(p.player);
		p.cleanup();
	}
	registry.destroy();
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

function validateTerminationOutcomesRespawnAndRollback(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Parent = root;

	buildCageArenaTemplate(templates, "Arena_L3_Life", "arena_l3_life", new CFrame(0, 15, 0));
	buildTestSlotPart(slots, "Slot_01", new CFrame(500, 30, -300));
	buildTestSlotPart(slots, "Slot_02", new CFrame(-500, 30, 300));

	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: activeParent,
		rng: () => 0.0,
		warnFn: () => {},
	});
	registry.start();

	const outcomes = [
		"victory",
		"defeat",
		"quit",
		"stallTimeout",
		"inactivityTimeout",
		"stepError",
		"startError",
		"pvpDisconnect",
	] as const;

	let uid = 996100;
	for (const outcome of outcomes) {
		const origA = new CFrame(10, 5, 20).mul(CFrame.Angles(0, math.rad(15), 0));
		const origB = new CFrame(14, 5, 22).mul(CFrame.Angles(0, math.rad(-30), 0));
		const a = BattleMovement.makePlayer(uid++, `LifeA_${outcome}`, origA);
		const b = BattleMovement.makePlayer(uid++, `LifeB_${outcome}`, origB);
		const isPvp = outcome === "pvpDisconnect" || outcome === "startError";

		const restoreEvents: { player: Player; arenaMounted: boolean }[] = [];
		const transport = new ArenaPlayerTransportService({
			warnFn: () => {},
			onParticipantRestored: (player, _, arenaStillMounted) => {
				restoreEvents.push({ player, arenaMounted: arenaStillMounted });
			},
		});
		const adapter = createSurgicalMockAdapter({
			onBattleStarted: (player) => {
				if (outcome === "startError" && player === b.player) error("startError L3 rollback");
			},
		});
		const sessions = new BattleSessionService(adapter, undefined, undefined, registry, transport);
		const rng = () => 0.5;
		const sideA = createDummySide(rng);
		const sideB = createDummySide(rng);
		const relA = BattleMovement.freeze(a.player, a.humanoid, () => sessions.destroySessionForPlayer(a.player));
		const relB = isPvp
			? BattleMovement.freeze(b.player, b.humanoid, () => sessions.destroySessionForPlayer(b.player))
			: () => {};

		const created = sessions.createSession(
			a.player,
			isPvp ? b.player : undefined,
			sideA,
			sideB,
			rng,
			isPvp ? "PVP" : "PVE",
			() => { relA(); relB(); },
		);

		if (outcome === "startError") {
			assertInvariant(!created, "startError deve retornar false");
		} else {
			assertInvariant(created, `${outcome}: sessão criada`);
			const active = (sessions as unknown as { activeSessions: { battle: BattleService }[] }).activeSessions[0];
			if (outcome === "victory") {
				active.battle.events.battleEnd.fire(sideA);
				sessions.step(0);
			} else if (outcome === "defeat") {
				active.battle.events.battleEnd.fire(sideB);
				sessions.step(0);
			} else if (outcome === "quit") {
				sessions.requestQuit(a.player);
			} else if (outcome === "stallTimeout") {
				(active.battle as unknown as { state: string }).state = "ATTACK";
				active.battle.step = () => {};
				sessions.step(BATTLE_STALL_TIMEOUT_SECONDS + 1);
			} else if (outcome === "inactivityTimeout") {
				sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS + 1);
			} else if (outcome === "stepError") {
				active.battle.step = () => error("stepError L3");
				sessions.step(SIMULATION_DT);
			} else if (outcome === "pvpDisconnect") {
				b.mock.Parent = undefined;
				b.character.Destroy();
				sessions.destroySessionForPlayer(b.player);
			}
		}

		assertCFrameNear(a.root.CFrame, origA, `${outcome}: jogador A restaurado ao CFrame original`);
		assertInvariant(
			a.humanoid.WalkSpeed === 16 &&
				a.humanoid.JumpPower === 50 &&
				!a.root.Anchored &&
				a.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false,
			`${outcome}: jogador A livre e com movimento restaurado`,
		);
		const aRestores = restoreEvents.filter((e) => e.player === a.player);
		assertInvariant(aRestores.size() === 1 && aRestores[0].arenaMounted === true, `${outcome}: A restaurado 1x com arena ainda montada`);
		if (outcome === "startError") {
			assertCFrameNear(b.root.CFrame, origB, "startError: jogador B também restaurado no rollback");
			const bRestores = restoreEvents.filter((e) => e.player === b.player);
			assertInvariant(bRestores.size() === 1 && bRestores[0].arenaMounted === true, "startError: B restaurado 1x");
		}
		if (outcome === "pvpDisconnect") {
			assertInvariant(transport.getActiveParticipantSnapshot(b.player) === undefined, "pvpDisconnect: B limpo sem Character");
		}

		const countBefore = transport.getTotalRestoreCount();
		a.root.CFrame = new CFrame(99, 5, 99);
		sessions.requestQuit(a.player);
		sessions.destroySessionForPlayer(a.player);
		transport.restoreSession("battle-0");
		assertInvariant(transport.getTotalRestoreCount() === countBefore, `${outcome}: cleanup idempotente sem duplo teleporte`);
		assertCFrameNear(a.root.CFrame, new CFrame(99, 5, 99), `${outcome}: segundo teardown não move jogador`);

		a.cleanup();
		b.cleanup();
	}

	// 7) Respawn durante a batalha: não teletransporta Character novo para estado antigo nem de volta à gaiola
	{
		const origCf = new CFrame(33, 5, 44);
		const respawnCf = new CFrame(-120, 6, -80);
		const p = BattleMovement.makePlayer(uid++, "RespawnPlayer", origCf);
		const transport = new ArenaPlayerTransportService({ warnFn: () => {} });
		const sessions = new BattleSessionService(createSurgicalMockAdapter({}), undefined, undefined, registry, transport);
		const rng = () => 0.5;
		assertInvariant(sessions.createSession(p.player, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"), "cria sessão respawn");

		const newChar = p.respawn(respawnCf);
		sessions.step(SIMULATION_DT);
		assertCFrameNear(newChar.root.CFrame, respawnCf, "step após respawn não puxa Character novo para a gaiola");

		sessions.requestQuit(p.player);
		assertCFrameNear(newChar.root.CFrame, respawnCf, "encerramento após respawn não teletransporta Character novo para CFrame antigo");
		assertInvariant(transport.getTotalRestoreCount() === 0, "nenhum teleporte de restauração em Character respawnado");
		p.cleanup();
	}

	BattleMovement.validatePartialFailuresAndStaleCallbacks(root, registry, uid);

	registry.destroy();
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

export function validateArenaPlayerTransportL3(): void {
	const root = new Instance("Folder");
	root.Name = "ArenaPlayerTransportL3TestRoot";
	root.Parent = Workspace;
	const [ok, failure] = pcall(() => {
		validatePvePvpAlternationAndRotation(root);
		validateTerminationOutcomesRespawnAndRollback(root);
	});
	root.Destroy();
	if (!ok) error(failure);
	print("ARENA_PLAYER_TRANSPORT_L3_PASSED");
}
