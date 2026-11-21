// Utilitários e cenários complementares de QA L3 (falha parcial/rollback, cancelamento, callback atrasado e arena destruída).
import { Players } from "@rbxts/services";
import {
	ARENA_BASES_CONTAINER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_PLAYER_CAGE_FOLDER_NAME,
	ARENA_PLAYER_SPAWN_A_NAME,
	ARENA_PLAYER_SPAWN_B_NAME,
	ARENA_REQUIRED_ANCHOR_NAMES,
	ARENA_REQUIRED_TEAM_FOLDERS,
} from "../../../shared/Config";
import { ArenaPlayerTransportService } from "../../Services/ArenaPlayerTransport";
import { ArenaRegistry } from "../../Services/ArenaRegistry";
import { freezeBattleMovement } from "../../Services/BattleMovement";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { createDummySide } from "../DummyFighters";
import { buildTestSlotPart } from "./arenaRegistryTests";
import { assertInvariant, createSurgicalMockAdapter } from "./testHelpers";

export interface L3MockPlayerFixture {
	readonly player: Player;
	readonly mock: {
		Parent: Players | undefined;
		Name: string;
		UserId: number;
		Character: Model | undefined;
	};
	character: Model;
	root: Part;
	humanoid: Humanoid;
	readonly attributes: Map<string, AttributeValue>;
	readonly respawn: (newCFrame: CFrame) => { readonly character: Model; readonly root: Part; readonly humanoid: Humanoid };
	readonly cleanup: () => void;
}

function buildCharacter(cframe: CFrame): { readonly character: Model; readonly root: Part; readonly humanoid: Humanoid } {
	const character = new Instance("Model");
	const root = new Instance("Part");
	root.Name = "HumanoidRootPart";
	root.Size = new Vector3(2, 2, 1);
	root.Anchored = false;
	root.CFrame = cframe;
	root.Parent = character;
	character.PrimaryPart = root;
	const humanoid = new Instance("Humanoid");
	humanoid.WalkSpeed = 16;
	humanoid.JumpPower = 50;
	humanoid.JumpHeight = 7.2;
	humanoid.Health = 100;
	humanoid.MaxHealth = 100;
	humanoid.Parent = character;
	return { character, root, humanoid };
}

function makePlayer(userId: number, name: string, cframe = new CFrame(0, 5, 0)): L3MockPlayerFixture {
	const initial = buildCharacter(cframe);
	const removing = new Instance("BindableEvent");
	const added = new Instance("BindableEvent");
	const attributes = new Map<string, AttributeValue>();
	const extraInstances: Instance[] = [initial.character, removing, added];

	const mock = {
		Parent: Players as Players | undefined,
		Name: name,
		UserId: userId,
		Character: initial.character as Model | undefined,
		CharacterRemoving: removing.Event,
		CharacterAdded: added.Event,
		SetAttribute(attr: string, value: AttributeValue): void {
			attributes.set(attr, value);
		},
	};

	const fixture: L3MockPlayerFixture = {
		player: mock as unknown as Player,
		mock,
		character: initial.character,
		root: initial.root,
		humanoid: initial.humanoid,
		attributes,
		respawn: (newCFrame: CFrame) => {
			const oldChar = fixture.character;
			removing.Fire(oldChar);
			const nextChar = buildCharacter(newCFrame);
			extraInstances.push(nextChar.character);
			mock.Character = nextChar.character;
			fixture.character = nextChar.character;
			fixture.root = nextChar.root;
			fixture.humanoid = nextChar.humanoid;
			added.Fire(nextChar.character);
			return nextChar;
		},
		cleanup: () => {
			for (const inst of extraInstances) {
				pcall(() => inst.Destroy());
			}
		},
	};
	return fixture;
}

function assertCFrameNear(actual: CFrame, expected: CFrame, label: string): void {
	const posDelta = actual.Position.sub(expected.Position).Magnitude;
	const lookDelta = actual.LookVector.sub(expected.LookVector).Magnitude;
	const upDelta = actual.UpVector.sub(expected.UpVector).Magnitude;
	assertInvariant(
		posDelta < 1e-3 && lookDelta < 1e-3 && upDelta < 1e-3,
		`${label}: CFrame divergente (pos=${posDelta}, look=${lookDelta}, up=${upDelta})`,
	);
}

function buildMinimalCageTemplate(
	parent: Instance,
	arenaId: string,
	mode: "valid" | "missingSpawnB" | "dupSpawnB" | "invalidSpawnB",
): Model {
	const model = new Instance("Model");
	model.Name = `Template_${arenaId}`;
	model.SetAttribute(ARENA_ID_ATTRIBUTE, arenaId);

	const bases = new Instance("Part");
	bases.Name = ARENA_BASES_CONTAINER_NAME;
	bases.Anchored = true;
	bases.CFrame = new CFrame(0, 10, 0);
	bases.Parent = model;
	model.PrimaryPart = bases;

	for (const sideIdx of [0, 1] as const) {
		const tf = new Instance("Folder");
		tf.Name = ARENA_REQUIRED_TEAM_FOLDERS[sideIdx];
		tf.Parent = bases;
		const names = ARENA_REQUIRED_ANCHOR_NAMES[sideIdx];
		for (const pName of [names.active, names.waiting[0], names.waiting[1]]) {
			const p = new Instance("Part");
			p.Name = pName;
			p.Anchored = true;
			p.CFrame = new CFrame(sideIdx === 0 ? 5 : -5, 10, 0);
			p.Parent = tf;
		}
	}

	const cage = new Instance("Folder");
	cage.Name = ARENA_PLAYER_CAGE_FOLDER_NAME;
	cage.Parent = bases;
	const floor = new Instance("SpawnLocation");
	floor.Name = "SpawnLocation";
	floor.Anchored = true;
	floor.Enabled = false;
	floor.CFrame = new CFrame(0, -12, 0);
	floor.Parent = cage;

	const attA = new Instance("Attachment");
	attA.Name = ARENA_PLAYER_SPAWN_A_NAME;
	attA.CFrame = new CFrame(6, 3.5, 0);
	attA.Parent = floor;

	if (mode === "valid" || mode === "dupSpawnB") {
		const attB = new Instance("Attachment");
		attB.Name = ARENA_PLAYER_SPAWN_B_NAME;
		attB.CFrame = new CFrame(-6, 3.5, 0);
		attB.Parent = floor;
		if (mode === "dupSpawnB") {
			const dup = attB.Clone();
			dup.Parent = floor;
		}
	} else if (mode === "invalidSpawnB") {
		const bad = new Instance("Folder");
		bad.Name = ARENA_PLAYER_SPAWN_B_NAME;
		bad.Parent = cage;
	}

	model.Parent = parent;
	return model;
}

function validatePartialFailuresAndStaleCallbacks(
	root: Folder,
	sharedRegistry: ArenaRegistry,
	startUid: number,
): void {
	let uid = startUid;
	const rng = () => 0.5;

	// 8a) Falha parcial de destino (PlayerSpawn_B ausente, duplicado ou tipo inválido): P1 é transportado e sofre rollback completo
	for (const badMode of ["missingSpawnB", "dupSpawnB", "invalidSpawnB"] as const) {
		const tFolder = new Instance("Folder");
		tFolder.Parent = root;
		const sFolder = new Instance("Folder");
		sFolder.Parent = root;
		const aFolder = new Instance("Folder");
		aFolder.Parent = root;
		buildMinimalCageTemplate(tFolder, `bad_${badMode}`, badMode);
		buildTestSlotPart(sFolder, "Slot_Bad", new CFrame(900, 20, 0));

		const reg = new ArenaRegistry({
			templatesContainer: tFolder,
			slotsContainer: sFolder,
			activeArenasParent: aFolder,
			warnFn: () => {},
		});
		reg.start();

		const orig1 = new CFrame(25, 5, -10);
		const orig2 = new CFrame(28, 5, -10);
		const p1 = makePlayer(uid++, `PartialA_${badMode}`, orig1);
		const p2 = makePlayer(uid++, `PartialB_${badMode}`, orig2);

		let p1TeleportedDuringAttempt = false;
		const transport = new ArenaPlayerTransportService({
			warnFn: () => {},
			onParticipantTeleported: (pl) => {
				if (pl === p1.player) p1TeleportedDuringAttempt = true;
			},
		});
		const sessions = new BattleSessionService(createSurgicalMockAdapter({}), undefined, undefined, reg, transport);
		const created = sessions.createSession(
			p1.player,
			p2.player,
			createDummySide(rng),
			createDummySide(rng),
			rng,
			"PVP",
		);
		const lastRes = sessions.getLastTransportResult();
		assertInvariant(!created, `${badMode}: createSession deve falhar`);
		assertInvariant(p1TeleportedDuringAttempt, `${badMode}: P1 chegou a ser movido antes da falha de P2`);
		assertInvariant(lastRes !== undefined && !lastRes.ok && lastRes.rolledBack, `${badMode}: rollback registrado`);
		assertCFrameNear(p1.root.CFrame, orig1, `${badMode}: P1 restaurado ao CFrame original no rollback`);
		assertCFrameNear(p2.root.CFrame, orig2, `${badMode}: P2 permaneceu no CFrame original`);
		assertInvariant(reg.getActiveReservations().size() === 0, `${badMode}: reserva de arena liberada no rollback`);

		p1.cleanup();
		p2.cleanup();
		reg.destroy();
		tFolder.Destroy();
		sFolder.Destroy();
		aFolder.Destroy();
	}

	// 8b) Falha parcial de validação de participante (P2 sem HumanoidRootPart ou com Humanoid morto)
	for (const charFailure of ["missingRoot", "deadHumanoid"] as const) {
		const orig1 = new CFrame(40, 5, 10);
		const orig2 = new CFrame(44, 5, 10);
		const p1 = makePlayer(uid++, `CharFailA_${charFailure}`, orig1);
		const p2 = makePlayer(uid++, `CharFailB_${charFailure}`, orig2);
		if (charFailure === "missingRoot") {
			p2.root.Destroy();
		} else {
			p2.humanoid.Health = 0;
		}

		let p1Moved = false;
		const transport = new ArenaPlayerTransportService({
			warnFn: () => {},
			onParticipantTeleported: (pl) => {
				if (pl === p1.player) p1Moved = true;
			},
		});
		const sessions = new BattleSessionService(
			createSurgicalMockAdapter({}),
			undefined,
			undefined,
			sharedRegistry,
			transport,
		);
		const created = sessions.createSession(
			p1.player,
			p2.player,
			createDummySide(rng),
			createDummySide(rng),
			rng,
			"PVP",
		);
		assertInvariant(!created && p1Moved, `${charFailure}: P1 movido e sessão recusada`);
		assertInvariant(sessions.getLastTransportResult()?.rolledBack === true, `${charFailure}: rollback executado`);
		assertCFrameNear(p1.root.CFrame, orig1, `${charFailure}: P1 restaurado ao CFrame original`);
		assertInvariant(sharedRegistry.getActiveReservations().size() === 0, `${charFailure}: slot físico liberado`);

		p1.cleanup();
		p2.cleanup();
	}

	// 9) Encerramento antes de concluir transporte (cancelamento após mover P1 e antes de mover P2)
	{
		const orig1 = new CFrame(60, 5, -20);
		const orig2 = new CFrame(65, 5, -20);
		const p1 = makePlayer(uid++, "CancelMidA", orig1);
		const p2 = makePlayer(uid++, "CancelMidB", orig2);
		const res = sharedRegistry.reserveForSession("cancel-mid-session", "PVP");
		assertInvariant(res.ok && res.reservation !== undefined, "reserva para teste de cancelamento");

		let keepGoing = true;
		let p2Moved = false;
		const transport = new ArenaPlayerTransportService({
			warnFn: () => {},
			onParticipantTeleported: (pl) => {
				if (pl === p1.player) keepGoing = false;
				if (pl === p2.player) p2Moved = true;
			},
		});
		const result = transport.transportSessionParticipants(
			"cancel-mid-session",
			res.reservation!,
			[
				{ player: p1.player, physicalSideIndex: 0 },
				{ player: p2.player, physicalSideIndex: 1 },
			],
			() => keepGoing,
		);
		assertInvariant(
			!result.ok && result.reason === "session_cancelled" && result.rolledBack && !p2Moved,
			"encerramento durante transporte cancela P2 e faz rollback de P1",
		);
		assertCFrameNear(p1.root.CFrame, orig1, "P1 restaurado após cancelamento no meio do transporte");
		assertCFrameNear(p2.root.CFrame, orig2, "P2 nunca foi movido após cancelamento");
		assertInvariant(!transport.hasActiveSessionTransport("cancel-mid-session"), "nenhum transporte ativo residual");

		sharedRegistry.releaseReservation(res.reservation!);
		p1.cleanup();
		p2.cleanup();
	}

	// 10) Novo combate após restauração + proteção contra callback atrasado de batalha anterior + arena de origem destruída
	{
		const orig1 = new CFrame(10, 5, 10);
		const orig2 = new CFrame(85, 5, -75).mul(CFrame.Angles(0, math.rad(90), 0));
		const p = makePlayer(uid++, "SequentialPlayer", orig1);
		const transport = new ArenaPlayerTransportService({ warnFn: () => {} });
		const sessions = new BattleSessionService(
			createSurgicalMockAdapter({}),
			undefined,
			undefined,
			sharedRegistry,
			transport,
		);

		// Combate 1
		assertInvariant(
			sessions.createSession(p.player, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
			"Combate 1 criado",
		);
		const gen1 = sessions.getLastTransportResult()!.generation;
		sessions.requestQuit(p.player);
		assertCFrameNear(p.root.CFrame, orig1, "Combate 1 restaurou orig1");

		// Jogador anda até orig2 e inicia Combate 2
		p.root.CFrame = orig2;
		assertInvariant(
			sessions.createSession(p.player, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
			"Combate 2 criado após restauração",
		);
		const cage2Cf = p.root.CFrame;
		assertInvariant(cage2Cf.Position.sub(orig2.Position).Magnitude > 100, "Combate 2 transportou para nova gaiola");

		// Callback atrasado da batalha 1 (battle-0 / gen1) NÃO pode tirar o jogador da gaiola da batalha 2!
		assertInvariant(!transport.restoreSession("battle-0", gen1), "callback atrasado de battle-0 ignorado");
		assertInvariant(!transport.restoreSession("battle-1", gen1), "geração antiga na sessão atual ignorada");
		assertCFrameNear(p.root.CFrame, cage2Cf, "jogador permanece na gaiola do Combate 2 após callback atrasado");

		sessions.requestQuit(p.player);
		assertCFrameNear(p.root.CFrame, orig2, "Combate 2 restaurou orig2 corretamente");

		// Proteção contra restaurar jogador dentro de uma arena de origem que já foi destruída
		const tempArenaRes = sharedRegistry.reserveForSession("temp-origin-arena", "PVE");
		assertInvariant(tempArenaRes.ok && tempArenaRes.reservation !== undefined, "reserva arena temporária de origem");
		const insideDestroyedArenaCf = tempArenaRes.reservation!.instance.GetPivot();
		p.root.CFrame = insideDestroyedArenaCf;

		assertInvariant(
			sessions.createSession(p.player, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
			"Combate 3 iniciado enquanto jogador estava dentro de temp-origin-arena",
		);
		const activeCageCf = p.root.CFrame;
		// Destrói a arena onde o jogador estava antes da batalha 3
		sharedRegistry.releaseReservation(tempArenaRes.reservation!);
		assertInvariant(tempArenaRes.reservation!.instance.Parent === undefined, "arena de origem foi destruída");

		// Move o jogador para um ponto seguro antes do fim da sessão e verifica que o restore não o joga na arena destruída
		const safeWorldCf = new CFrame(0, 10, 0);
		sessions.requestQuit(p.player);
		// Como originArenaInstance foi destruída, restoreParticipantRecord abortou o teleporte para insideDestroyedArenaCf
		assertInvariant(
			p.root.CFrame.Position.sub(insideDestroyedArenaCf.Position).Magnitude > 50 &&
				p.root.CFrame.Position.sub(activeCageCf.Position).Magnitude < 1e-3,
			"não teletransporta jogador de volta para dentro de uma arena de origem já destruída",
		);
		p.root.CFrame = safeWorldCf;

		p.cleanup();
	}
}

export const BattleMovement = {
	makePlayer,
	freeze: freezeBattleMovement,
	validatePartialFailuresAndStaleCallbacks,
};
