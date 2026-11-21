// Testes L1.5 (migrados ao contrato L1.6): ArenaRegistry, catálogo universal, slots físicos, rollback, lifecycle e PvP canônico.
import { CollectionService, Players, Workspace } from "@rbxts/services";
import {
	ACTIVE_ARENAS_FOLDER_NAME,
	ARENA_BASES_CONTAINER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
	ARENA_SESSION_ID_ATTRIBUTE,
	ARENA_SLOT_ID_ATTRIBUTE,
	ARENA_TYPE_ATTRIBUTE,
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	BATTLE_NPC_TAG,
	BATTLE_STALL_TIMEOUT_SECONDS,
	NPC_BATTLE_ACTIVE_ATTRIBUTE,
} from "../../../shared/Config";
import type {
	BattleEndedPayload,
	BattleStartedPayload,
	ChallengeStatusPayload,
	NpcBattleNoticePayload,
} from "../../../shared/Remotes";
import { ArenaRegistry } from "../../Services/ArenaRegistry";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { NpcService } from "../../Services/NpcService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import { InMemoryDataStore } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { PvpService } from "../../Services/PvpService";
import { createDummySide } from "../DummyFighters";
import { assertInvariant, createSurgicalMockAdapter, SIMULATION_DT } from "./testHelpers";

function makeAnchorPart(name: string, parent: Instance, cf: CFrame): Part {
	const part = new Instance("Part");
	part.Name = name;
	part.Size = new Vector3(2, 0.2, 2);
	part.Anchored = true;
	part.CanCollide = false;
	part.CFrame = cf;
	part.Parent = parent;
	return part;
}

export function buildTestArenaTemplate(
	parent: Instance,
	modelName: string,
	arenaId: unknown,
	origin: CFrame,
	includeOptionalAnchors = true,
	legacyArenaType?: unknown,
): Model {
	const model = new Instance("Model");
	model.Name = modelName;
	if (arenaId !== undefined) model.SetAttribute(ARENA_ID_ATTRIBUTE, arenaId as AttributeValue);
	if (legacyArenaType !== undefined) model.SetAttribute(ARENA_TYPE_ATTRIBUTE, legacyArenaType as AttributeValue);

	const bases = new Instance("Part");
	bases.Name = ARENA_BASES_CONTAINER_NAME;
	bases.Size = new Vector3(25, 0.1, 25);
	bases.Anchored = true;
	bases.CanCollide = false;
	bases.CFrame = origin;
	bases.Parent = model;
	model.PrimaryPart = bases;

	const timeA = new Instance("Folder");
	timeA.Name = "Time A";
	timeA.Parent = bases;
	makeAnchorPart("Current_Fighter_A", timeA, origin.mul(new CFrame(0, 0.15, -6)));
	makeAnchorPart("Waiting_Fighter_A", timeA, origin.mul(new CFrame(-4, 0.15, -9)));
	makeAnchorPart("Waiting_Fighter_A_2", timeA, origin.mul(new CFrame(4, 0.15, -9)));
	if (includeOptionalAnchors) {
		makeAnchorPart("Camera_A", timeA, origin.mul(new CFrame(0, 5, -12)));
		makeAnchorPart("AoE_Target_A_1", timeA, origin.mul(new CFrame(-2, 0.15, -6)));
		makeAnchorPart("AoE_Target_A_2", timeA, origin.mul(new CFrame(2, 0.15, -6)));
	}

	const timeB = new Instance("Folder");
	timeB.Name = "Time B";
	timeB.Parent = bases;
	makeAnchorPart("Current_Fighter_B", timeB, origin.mul(new CFrame(0, 0.15, 6)).mul(CFrame.Angles(0, math.pi, 0)));
	makeAnchorPart("Waiting_Fighter_B", timeB, origin.mul(new CFrame(-4, 0.15, 9)).mul(CFrame.Angles(0, math.pi, 0)));
	makeAnchorPart("Waiting_Fighter_B_2", timeB, origin.mul(new CFrame(4, 0.15, 9)).mul(CFrame.Angles(0, math.pi, 0)));
	if (includeOptionalAnchors) {
		makeAnchorPart("Camera_B", timeB, origin.mul(new CFrame(0, 5, 12)).mul(CFrame.Angles(0, math.pi, 0)));
		makeAnchorPart("AoE_Target_B_1", timeB, origin.mul(new CFrame(-2, 0.15, 6)));
		makeAnchorPart("AoE_Target_B_2", timeB, origin.mul(new CFrame(2, 0.15, 6)));
	}

	model.Parent = parent;
	return model;
}

export function buildTestSlotPart(parent: Instance, name: string, cf: CFrame, slotIdAttr?: unknown): Part {
	const part = new Instance("Part");
	part.Name = name;
	part.Size = new Vector3(4, 0.5, 4);
	part.Anchored = true;
	part.CanCollide = false;
	part.CFrame = cf;
	if (slotIdAttr !== undefined) part.SetAttribute(ARENA_SLOT_ID_ATTRIBUTE, slotIdAttr as AttributeValue);
	part.Parent = parent;
	return part;
}

export function makeArenaMockPlayer(userId: number, name: string, pos = new Vector3(0, 0, 0)) {
	const character = new Instance("Model");
	const root = new Instance("Part");
	root.Name = "HumanoidRootPart";
	root.Anchored = true;
	root.Position = pos;
	root.Parent = character;
	const humanoid = new Instance("Humanoid");
	humanoid.WalkSpeed = 16;
	humanoid.JumpPower = 50;
	humanoid.JumpHeight = 7.2;
	humanoid.Parent = character;
	const removing = new Instance("BindableEvent");
	const attributes = new Map<string, AttributeValue>();
	const mock = {
		Parent: Players as Players | undefined, Name: name, UserId: userId, Character: character, CharacterRemoving: removing.Event,
		SetAttribute(attr: string, value: AttributeValue): void { attributes.set(attr, value); },
	};
	return {
		player: mock as unknown as Player, mock, character, humanoid, removing, attributes,
		cleanup(): void { removing.Destroy(); character.Destroy(); },
	};
}

function validateTemplateDiscoveryAndIds(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Name = "TemplatesValidation";
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Name = "SlotsValidation";
	slots.Parent = root;
	buildTestSlotPart(slots, "Slot_01", new CFrame(0, 0, 0));

	const subfolder = new Instance("Folder");
	subfolder.Name = "SubCatalog";
	subfolder.Parent = templates;

	// Válidos: sem ArenaType e com ArenaType legado (não é requisito nem filtro)
	buildTestArenaTemplate(subfolder, "Arena_01", "arena_beach", new CFrame(0, 0, 0), false);
	buildTestArenaTemplate(templates, "Arena_02", "arena_ruins", new CFrame(100, 0, 0), true, "PVP");
	// Duplicados (ambos devem ser rejeitados por ambiguidade)
	buildTestArenaTemplate(templates, "DupA", "dup_id", new CFrame(200, 0, 0));
	buildTestArenaTemplate(templates, "DupB", "dup_id", new CFrame(300, 0, 0));
	// IDs inválidos, Archivable=false e estrutura quebrada
	buildTestArenaTemplate(templates, "EmptyId", "", new CFrame(400, 0, 0));
	buildTestArenaTemplate(templates, "SpaceId", "bad id", new CFrame(450, 0, 0));
	const nonArchivable = buildTestArenaTemplate(templates, "NoArchive", "no_archive", new CFrame(600, 0, 0));
	nonArchivable.Archivable = false;
	const broken = buildTestArenaTemplate(templates, "Broken", "broken_arena", new CFrame(650, 0, 0));
	broken.FindFirstChild(ARENA_BASES_CONTAINER_NAME)?.FindFirstChild("Time B")?.Destroy();

	const warnings: string[] = [];
	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: root,
		warnFn: (msg) => warnings.push(msg),
	});
	const valid = registry.discoverTemplates();
	assertInvariant(valid.size() === 2, `esperado 2 templates válidos, encontrado ${valid.size()}`);
	assertInvariant(
		valid.some((t) => t.arenaId === "arena_beach"),
		"arena_beach sem ArenaType e sem anchors AoE opcionais deve ser válida",
	);
	assertInvariant(
		valid.some((t) => t.arenaId === "arena_ruins"),
		"arena_ruins deve ser válida no catálogo universal",
	);
	assertInvariant(!valid.some((t) => t.arenaId === "dup_id"), "ArenaId duplicado deve ser rejeitado");
	assertInvariant(warnings.size() >= 5, "diagnósticos de validação devem ser registrados");

	registry.destroy();
	templates.Destroy();
	slots.Destroy();
}

function validateConcurrencyRollbackAndStaleRelease(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Name = "TemplatesConcurrency";
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Name = "SlotsConcurrency";
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Name = "ActiveParentConcurrency";
	activeParent.Parent = root;

	buildTestArenaTemplate(templates, "Arena_01", "arena_1", new CFrame(0, 0, 0));
	buildTestArenaTemplate(templates, "Arena_02", "arena_2", new CFrame(0, 0, 0));
	buildTestSlotPart(slots, "Slot_01", new CFrame(0, 0, 0));
	buildTestSlotPart(slots, "Slot_02", new CFrame(300, 0, 0));
	buildTestSlotPart(slots, "Slot_03", new CFrame(600, 0, 0));

	let releaseCallbackCount = 0;
	let failNextClone = false;
	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: activeParent,
		rng: () => 0.0,
		cloneTemplate: (template) => {
			if (failNextClone) {
				failNextClone = false;
				error("falha de clonagem intencional");
			}
			return template.Clone();
		},
		onReleased: () => {
			releaseCallbackCount += 1;
		},
		warnFn: () => {},
	});
	registry.start();

	// 1. PVE, BOSS e PVP compartilham catálogo universal em slots físicos distintos
	const rPve = registry.reserveForSession("battle-10", "PVE");
	const rBoss = registry.reserveForSession("battle-11", "BOSS");
	const rPvp = registry.reserveForSession("battle-12", "PVP");
	assertInvariant(rPve.ok && rPve.reservation !== undefined, "reserva PVE 1");
	assertInvariant(rBoss.ok && rBoss.reservation !== undefined, "reserva BOSS");
	assertInvariant(rPvp.ok && rPvp.reservation !== undefined, "reserva PVP");
	assertInvariant(
		rPve.reservation!.instance !== rBoss.reservation!.instance &&
			rBoss.reservation!.instance !== rPvp.reservation!.instance,
		"clones distintos em ActiveArenas",
	);
	assertInvariant(
		rPve.reservation!.slotId !== rBoss.reservation!.slotId &&
			rBoss.reservation!.slotId !== rPvp.reservation!.slotId &&
			rPve.reservation!.slotId !== rPvp.reservation!.slotId,
		"3 batalhas simultâneas em 3 slots físicos distintos",
	);

	// Reserva duplicada para mesma sessão rejeitada
	const dupSession = registry.reserveForSession("battle-10", "PVE");
	assertInvariant(!dupSession.ok && dupSession.reason === "duplicate_session", "impede reserva duplicada da sessão");

	// Capacidade física esgotada (3/3 slots ocupados)
	const noSlot = registry.reserveForSession("battle-13", "PVE");
	assertInvariant(!noSlot.ok && noSlot.reason === "no_slot_available", "recusa quando capacidade física esgotada");
	assertInvariant(registry.getAvailableCount() === 0, "capacidade disponível zero quando slots cheios");

	// Destruir uma arena ativa NÃO altera as outras
	const activeFolder = activeParent.FindFirstChild(ACTIVE_ARENAS_FOLDER_NAME) as Folder;
	assertInvariant(activeFolder !== undefined && activeFolder.GetChildren().size() === 3, "3 clones ativos");
	const bossInstance = rBoss.reservation!.instance;
	const bossBases = bossInstance.FindFirstChild(ARENA_BASES_CONTAINER_NAME);
	assertInvariant(registry.releaseReservation(rPve.reservation!), "libera primeira arena");
	assertInvariant(!registry.releaseReservation(rPve.reservation!), "segunda liberação é no-op (exatamente uma vez)");
	assertInvariant(!registry.releaseSession("battle-10"), "releaseSession repetido é no-op");
	assertInvariant(releaseCallbackCount === 1 && registry.getReleaseCount() === 1, "exatamente 1 liberação contabilizada");
	assertInvariant(rPve.reservation!.instance.Parent === undefined, "clone liberado foi destruído");
	assertInvariant(bossInstance.Parent === activeFolder && bossBases?.Parent === bossInstance, "outra arena permanece intacta");

	// Falha de clonagem faz rollback sem deixar clone órfão e mantendo slot físico livre
	failNextClone = true;
	const cloneFail = registry.reserveForSession("battle-17", "PVE");
	assertInvariant(!cloneFail.ok && cloneFail.reason === "clone_failed", "falha de clone reportada");
	assertInvariant(activeFolder.GetChildren().size() === 2, "rollback sem clone órfão");
	assertInvariant(registry.getAvailableSlotCount() === 1, "slot físico continua disponível após rollback de clone");

	// Nova reserva após liberação e rollback reutiliza o slot físico liberado com novo instanceId
	const rReused = registry.reserveForSession("battle-18", "PVE");
	assertInvariant(rReused.ok && rReused.reservation !== undefined, "nova reserva após liberação");
	assertInvariant(rReused.reservation!.slotId === rPve.reservation!.slotId, "reutiliza slot físico liberado");
	assertInvariant(rReused.reservation!.instanceId !== rPve.reservation!.instanceId, "gera novo instanceId");
	assertInvariant(
		rReused.reservation!.instance.GetAttribute(ARENA_SESSION_ID_ATTRIBUTE) === "battle-18" &&
			rReused.reservation!.instance.GetAttribute(ARENA_INSTANCE_ID_ATTRIBUTE) === rReused.reservation!.instanceId &&
			rReused.reservation!.instance.GetAttribute(ARENA_SLOT_ID_ATTRIBUTE) === rReused.reservation!.slotId,
		"atributos da nova instância corretos",
	);

	// Liberação antiga nunca afeta reserva nova no mesmo ArenaId ou slot físico
	assertInvariant(!registry.releaseReservation(rPve.reservation!), "reserva antiga não libera reserva nova");
	assertInvariant(rReused.reservation!.instance.Parent === activeFolder, "nova instância permanece ativa");

	registry.destroy();
	assertInvariant(activeFolder.GetChildren().size() === 0, "destroy limpa todos os clones");
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

function validateSessionLifecycleAndUnavailability(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Name = "TemplatesLifecycle";
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Name = "SlotsLifecycle";
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Name = "ActiveParentLifecycle";
	activeParent.Parent = root;

	buildTestArenaTemplate(templates, "Arena_01", "life_arena_1", new CFrame(0, 0, 0));
	buildTestSlotPart(slots, "Slot_01", new CFrame(0, 0, 0));

	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: activeParent,
		rng: () => 0.25,
		warnFn: () => {},
	});
	registry.start();

	const outcomes = ["victory", "defeat", "quit", "disconnect", "stallTimeout", "inactivityTimeout", "stepError", "startError"] as const;
	let expectedReleases = 0;
	let userId = 998100;

	for (const outcome of outcomes) {
		const p = makeArenaMockPlayer(userId++, `ArenaLife_${outcome}`);
		let startedPayload: BattleStartedPayload | undefined;
		const endedPayloads: BattleEndedPayload[] = [];
		const adapter = createSurgicalMockAdapter({
			onBattleStarted: (_, payload) => {
				startedPayload = payload;
				if (outcome === "startError") error("startError arena rollback");
			},
			onBattleEnded: (_, payload) => endedPayloads.push(payload),
		});
		const sessions = new BattleSessionService(adapter, undefined, undefined, registry);
		const rng = () => 0.5;
		const sideA = createDummySide(rng);
		const sideB = createDummySide(rng);
		const created = sessions.createSession(p.player, undefined, sideA, sideB, rng, "PVE");

		if (outcome === "startError") {
			assertInvariant(!created, "startError retorna false");
			expectedReleases += 1;
		} else {
			assertInvariant(created && startedPayload?.arena !== undefined, `${outcome}: sessão com arena reservada`);
			assertInvariant(
				registry.getActiveReservations().size() === 1 && registry.getAvailableSlotCount() === 0,
				`${outcome}: slot físico ocupado durante a sessão`,
			);
			const active = (sessions as unknown as { activeSessions: { battle: BattleService }[] }).activeSessions[0];
			if (outcome === "victory") {
				active.battle.events.battleEnd.fire(sideA);
				sessions.step(0);
			} else if (outcome === "defeat") {
				active.battle.events.battleEnd.fire(sideB);
				sessions.step(0);
			} else if (outcome === "quit") {
				sessions.requestQuit(p.player);
			} else if (outcome === "disconnect") {
				p.mock.Parent = undefined;
				sessions.destroySessionForPlayer(p.player);
			} else if (outcome === "stallTimeout") {
				(active.battle as unknown as { state: string }).state = "ATTACK";
				active.battle.step = () => {};
				sessions.step(BATTLE_STALL_TIMEOUT_SECONDS + 1);
			} else if (outcome === "inactivityTimeout") {
				sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS + 1);
			} else if (outcome === "stepError") {
				active.battle.step = () => error("stepError arena cleanup");
				sessions.step(SIMULATION_DT);
			}
			expectedReleases += 1;
			assertInvariant(!sessions.hasActiveSession(p.player), `${outcome}: sessão encerrada`);
			sessions.destroySessionForPlayer(p.player);
			sessions.requestQuit(p.player);
		}

		assertInvariant(registry.getActiveReservations().size() === 0, `${outcome}: 0 reservas ativas após fim`);
		assertInvariant(registry.getAvailableSlotCount() === 1, `${outcome}: slot físico voltou a ficar livre`);
		assertInvariant(registry.getReleaseCount() === expectedReleases, `${outcome}: liberada exatamente uma vez (${registry.getReleaseCount()}/${expectedReleases})`);
		const folder = registry.getActiveArenasFolder();
		assertInvariant(folder !== undefined && folder.GetChildren().size() === 0, `${outcome}: sem clones órfãos`);
		p.cleanup();
	}

	// PvP: dois jogadores recebem a MESMA instância física e lados físicos canônicos [A, B]
	const p1 = makeArenaMockPlayer(userId++, "PvpArena1", new Vector3(0, 0, 0));
	const p2 = makeArenaMockPlayer(userId++, "PvpArena2", new Vector3(2, 0, 0));
	const p3 = makeArenaMockPlayer(userId++, "PvpArena3", new Vector3(4, 0, 0));
	const p4 = makeArenaMockPlayer(userId++, "PvpArena4", new Vector3(6, 0, 0));
	const pvpStarted = new Map<Player, BattleStartedPayload>();
	const sessions = new BattleSessionService(
		createSurgicalMockAdapter({
			onBattleStarted: (player, payload) => pvpStarted.set(player, payload),
		}),
		undefined,
		undefined,
		registry,
	);
	const rng = () => 0.5;
	assertInvariant(sessions.createSession(p1.player, p2.player, createDummySide(rng), createDummySide(rng), rng, "PVP"), "sessão PVP 1");
	const s1 = pvpStarted.get(p1.player);
	const s2 = pvpStarted.get(p2.player);
	assertInvariant(s1?.arena !== undefined && s2?.arena !== undefined, "ambos clientes PVP recebem payload.arena");
	assertInvariant(s1!.arena!.instanceId === s2!.arena!.instanceId, "ambos clientes PVP usam a mesma instância física");
	assertInvariant(s1!.arena!.arenaId === "life_arena_1", "PVP usa catálogo universal");
	assertInvariant(s1!.arena!.arenaType === undefined, "payload L1.6 não exige nem envia arenaType");
	assertInvariant(
		s1!.sides[0] === s1!.arena!.physicalSides[0] &&
			s2!.sides[0] === s1!.arena!.physicalSides[1] &&
			s1!.arena!.physicalSides[0] === s2!.arena!.physicalSides[0] &&
			s1!.arena!.physicalSides[1] === s2!.arena!.physicalSides[1],
		"lados físicos canônicos idênticos entre clientes PVP sem inverter Time A/Time B",
	);

	// Fluxo real PvpService quando capacidade física está esgotada -> ChallengeStatus "indisponivel"
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, {
		dataStore: new InMemoryDataStore(),
		serverId: "ArenaPvpBusy",
		now: () => 1000,
		waitFn: () => {},
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	assertInvariant(data.loadPlayer(p3.player).ok && data.loadPlayer(p4.player).ok, "load jogadores PVP indisponível");
	let inviteId = "";
	const statuses: ChallengeStatusPayload[] = [];
	const pvpService = new PvpService(
		sessions,
		data,
		progression,
		(_, payload) => { inviteId = payload.inviteId; },
		(_, payload) => statuses.push(payload),
		() => 10,
		() => 0.5,
	);
	assertInvariant(pvpService.challenge(p3.player, p4.player), "convite PVP enviado");
	assertInvariant(!pvpService.respond(p4.player, { inviteId, accept: true }), "aceite PVP falha sem slot físico livre");
	assertInvariant(
		statuses.some((entry) => entry.inviteId === inviteId && entry.status === "indisponivel"),
		"PvpService envia ChallengeStatus indisponivel quando capacidade física está esgotada",
	);
	assertInvariant(
		p3.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false && p4.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false,
		"movimento restaurado após recusa PVP por falta de capacidade física",
	);

	// Fluxo real NpcService quando capacidade física está esgotada -> NpcBattleNotice "arena_indisponivel"
	const npc = new Instance("Model");
	npc.Name = "ArenaBusyNpc";
	const npcPart = new Instance("Part");
	npcPart.Anchored = true;
	npcPart.Position = new Vector3(4, 0, 0);
	npcPart.Parent = npc;
	npc.PrimaryPart = npcPart;
	npc.SetAttribute("NpcId", "bronze_trainer");
	CollectionService.AddTag(npc, BATTLE_NPC_TAG);
	npc.Parent = Workspace;
	const notices: NpcBattleNoticePayload[] = [];
	const npcService = new NpcService(sessions, data, progression, (_, payload) => notices.push(payload), () => 20, () => 0.5);
	npcService.bindNpc(npc);
	assertInvariant(!npcService.trigger(p3.player, npc), "NPC recusa sem slot físico disponível");
	assertInvariant(notices.size() > 0 && notices[notices.size() - 1].reason === "arena_indisponivel", "NpcService informa arena_indisponivel");
	assertInvariant(p3.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false, "movimento restaurado após recusa NPC por falta de capacidade");

	sessions.requestQuit(p1.player);
	npcService.destroy();
	npc.Destroy();
	pvpService.forgetPlayer(p3.player);
	pvpService.forgetPlayer(p4.player);
	p1.cleanup();
	p2.cleanup();
	p3.cleanup();
	p4.cleanup();
	registry.destroy();
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

export function validateArenaRegistry(): void {
	const root = new Instance("Folder");
	root.Name = "ArenaRegistryL15TestRoot";
	root.Parent = Workspace;
	const [ok, failure] = pcall(() => {
		validateTemplateDiscoveryAndIds(root);
		validateConcurrencyRollbackAndStaleRelease(root);
		validateSessionLifecycleAndUnavailability(root);
	});
	root.Destroy();
	if (!ok) {
		error(failure);
	}
	print("ARENA_REGISTRY_L1_5_PASSED");
}
