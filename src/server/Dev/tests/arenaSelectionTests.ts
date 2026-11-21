// Testes L1.6: catálogo universal, seleção aleatória, não repetição imediata, reutilização simultânea e slots físicos.
import { Workspace } from "@rbxts/services";
import {
	ARENA_BASES_CONTAINER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_INSTANCE_ID_ATTRIBUTE,
	ARENA_SESSION_ID_ATTRIBUTE,
	ARENA_SLOT_ID_ATTRIBUTE,
	PLAYER_DATA_SCHEMA_VERSION,
	PVP_INVITE_INTERVAL_SECONDS,
} from "../../../shared/Config";
import type { BattleStartedPayload } from "../../../shared/Remotes";
import { ArenaRegistry } from "../../Services/ArenaRegistry";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import { InMemoryDataStore } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { PvpService } from "../../Services/PvpService";
import { createDummySide } from "../DummyFighters";
import { buildTestArenaTemplate, buildTestSlotPart, makeArenaMockPlayer } from "./arenaRegistryTests";
import { assertInvariant, createSurgicalMockAdapter } from "./testHelpers";

function makeSequenceRng(values: readonly number[]): () => number {
	let idx = 0;
	return () => {
		const v = values[idx % values.size()];
		idx += 1;
		return v;
	};
}

function validateUniversalCatalogAndNameIndependence(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Name = "L16TemplatesCatalog";
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Name = "L16SlotsCatalog";
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Name = "L16ActiveCatalog";
	activeParent.Parent = root;

	// Nomes visuais diversos (incluindo nomes que parecem PvP/Boss) NÃO definem tipo nem ArenaId
	const t1 = buildTestArenaTemplate(templates, "Arena_01", "island_stable", new CFrame(10, 5, -20));
	const t2 = buildTestArenaTemplate(templates, "PVP_Only_VisualName", "ruins_stable", new CFrame(50, 2, 10));
	const t3 = buildTestArenaTemplate(templates, "Boss_VisualName", "volcano_stable", new CFrame(-30, 8, 40));

	buildTestSlotPart(slots, "Slot_01", new CFrame(0, 10, 0));
	buildTestSlotPart(slots, "Slot_02", new CFrame(350, 10, 0));
	buildTestSlotPart(slots, "Slot_03", new CFrame(700, 10, 0));

	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: activeParent,
		rng: makeSequenceRng([0.0, 0.5, 0.99]),
		warnFn: () => {},
	});
	registry.start();

	const discovered = registry.getRegisteredTemplates();
	assertInvariant(discovered.size() === 3, `catálogo universal deve descobrir 3 templates, encontrou ${discovered.size()}`);

	// Renomear Model.Name após descoberta NÃO altera ArenaId estável
	t1.Name = "Arena_Renamed_Visual";
	t2.Name = "OutroNomeQualquer";
	t3.Name = "TerceiroNome";

	// PvE, PvP e Boss selecionam livremente do mesmo catálogo universal
	const rPve = registry.reserveForSession("cat-pve", "PVE", { rng: () => 0.0 });
	const rPvp = registry.reserveForSession("cat-pvp", "PVP", { rng: () => 0.5 });
	const rBoss = registry.reserveForSession("cat-boss", "BOSS", { rng: () => 0.99 });
	assertInvariant(rPve.ok && rPve.reservation?.arenaId === "island_stable", "PVE selecionou island_stable independente de Name");
	assertInvariant(rPvp.ok && rPvp.reservation?.arenaId === "ruins_stable", "PVP selecionou ruins_stable do catálogo comum");
	assertInvariant(rBoss.ok && rBoss.reservation?.arenaId === "volcano_stable", "BOSS selecionou volcano_stable do catálogo comum");
	assertInvariant(
		rPve.reservation!.instance.GetAttribute(ARENA_ID_ATTRIBUTE) === "island_stable" &&
			rPvp.reservation!.instance.GetAttribute(ARENA_ID_ATTRIBUTE) === "ruins_stable" &&
			rBoss.reservation!.instance.GetAttribute(ARENA_ID_ATTRIBUTE) === "volcano_stable",
		"ArenaId estável preservado nos atributos mesmo após renomear templates",
	);

	// Re-descoberta após renomeação mantém exatamente os mesmos ArenaIds
	const rediscovered = registry.discoverTemplates();
	assertInvariant(
		rediscovered.size() === 3 &&
			rediscovered.some((r) => r.arenaId === "island_stable") &&
			rediscovered.some((r) => r.arenaId === "ruins_stable") &&
			rediscovered.some((r) => r.arenaId === "volcano_stable"),
		"ArenaId independe de Model.Name também na redescoberta",
	);

	registry.destroy();
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

function validateSameTemplateSimultaneousAndPhysicalSeparation(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Name = "L16TemplatesSingle";
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Name = "L16SlotsSeparation";
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Name = "L16ActiveSeparation";
	activeParent.Parent = root;

	const templateOrigin = new CFrame(120, 15, -80);
	const singleTemplate = buildTestArenaTemplate(templates, "Arena_01", "shared_island", templateOrigin);
	const origBases = singleTemplate.FindFirstChild(ARENA_BASES_CONTAINER_NAME) as BasePart;
	const origCurA = origBases.FindFirstChild("Time A")!.FindFirstChild("Current_Fighter_A") as BasePart;
	const origCurB = origBases.FindFirstChild("Time B")!.FindFirstChild("Current_Fighter_B") as BasePart;
	const relAnchorA = singleTemplate.GetPivot().ToObjectSpace(origCurA.CFrame);
	const relAnchorB = singleTemplate.GetPivot().ToObjectSpace(origCurB.CFrame);

	// Suporte tanto a BasePart direto quanto a Attachment dentro de um BasePart suporte
	const slot1CF = new CFrame(400, 20, -200).mul(CFrame.Angles(0, math.rad(35), 0));
	buildTestSlotPart(slots, "Slot_Part_01", slot1CF, "slot_alpha");

	const holder = new Instance("Part");
	holder.Name = "AttachmentHolder";
	holder.Anchored = true;
	holder.CanCollide = false;
	holder.CFrame = new CFrame(800, 30, 150);
	holder.Parent = slots;
	const att1 = new Instance("Attachment");
	att1.Name = "Slot_Att_01";
	att1.CFrame = new CFrame(0, 5, 0).mul(CFrame.Angles(0, math.rad(-90), 0));
	att1.SetAttribute(ARENA_SLOT_ID_ATTRIBUTE, "slot_beta");
	att1.Parent = holder;

	// Marcador coincidente com Slot_Part_01 deve ser rejeitado na descoberta (nunca sobrepor!)
	buildTestSlotPart(slots, "CoincidentSlot", slot1CF, "slot_coincident");

	const warnings: string[] = [];
	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: activeParent,
		rng: () => 0.5,
		warnFn: (msg) => warnings.push(msg),
	});
	registry.start();

	assertInvariant(registry.getRegisteredTemplates().size() === 1, "1 template válido registrado");
	assertInvariant(registry.getRegisteredSlots().size() === 2, `2 slots físicos válidos (coincidente rejeitado), encontrou ${registry.getRegisteredSlots().size()}`);
	assertInvariant(warnings.size() >= 1, "coincidência de slot gera diagnóstico");

	// Duas batalhas simultâneas (PVE e PVP) clonando o MESMO template em espaços físicos distintos
	const r1 = registry.reserveForSession("same-1", "PVE", { participantKeys: ["u:1"] });
	const r2 = registry.reserveForSession("same-2", "PVP", { participantKeys: ["u:2", "u:3"] });
	assertInvariant(r1.ok && r1.reservation !== undefined, "reserva 1 no único template");
	assertInvariant(r2.ok && r2.reservation !== undefined, "reserva 2 simultânea no MESMO template");
	assertInvariant(r1.reservation!.arenaId === "shared_island" && r2.reservation!.arenaId === "shared_island", "mesmo ArenaId simultâneo");
	assertInvariant(r1.reservation!.instanceId !== r2.reservation!.instanceId, "ArenaInstanceId exclusivos");
	assertInvariant(r1.reservation!.instance !== r2.reservation!.instance, "Models clonados exclusivos");
	assertInvariant(r1.reservation!.slotId !== r2.reservation!.slotId, "slots físicos distintos");
	assertInvariant(
		registry.getReservationByInstanceId(r1.reservation!.instanceId)?.sessionId === "same-1" &&
			registry.getReservationByInstanceId(r2.reservation!.instanceId)?.sessionId === "same-2",
		"exclusividade por ArenaInstanceId e BattleSessionId",
	);

	// Verifica posicionamento sem sobreposição e preservação exata do layout interno
	const p1 = r1.reservation!.instance.GetPivot();
	const p2 = r2.reservation!.instance.GetPivot();
	assertInvariant(p1.Position.sub(slot1CF.Position).Magnitude < 1e-3, "clone 1 alinhado ao BasePart Slot_Part_01");
	assertInvariant(p2.Position.sub(att1.WorldCFrame.Position).Magnitude < 1e-3, "clone 2 alinhado ao Attachment Slot_Att_01");
	assertInvariant(p1.Position.sub(p2.Position).Magnitude > 300, "clones simultâneos fisicamente separados sem sobreposição");

	const c1CurA = r1.reservation!.instance.FindFirstChild(ARENA_BASES_CONTAINER_NAME)!.FindFirstChild("Time A")!.FindFirstChild("Current_Fighter_A") as BasePart;
	const c2CurB = r2.reservation!.instance.FindFirstChild(ARENA_BASES_CONTAINER_NAME)!.FindFirstChild("Time B")!.FindFirstChild("Current_Fighter_B") as BasePart;
	assertInvariant(p1.ToObjectSpace(c1CurA.CFrame).Position.sub(relAnchorA.Position).Magnitude < 1e-2, "layout interno de anchor A preservado no clone 1");
	assertInvariant(p2.ToObjectSpace(c2CurB.CFrame).Position.sub(relAnchorB.Position).Magnitude < 1e-2, "layout interno de anchor B preservado no clone 2");

	// Template original não foi movido nem alterado
	assertInvariant(singleTemplate.GetPivot().Position.sub(templateOrigin.Position).Magnitude < 1e-3, "template original intacto");

	// Capacidade física esgotada (2/2 slots ocupados)
	const r3 = registry.reserveForSession("same-3", "BOSS");
	assertInvariant(!r3.ok && r3.reason === "no_slot_available", "3ª batalha bloqueada por capacidade física esgotada");

	// Libera 1 e reutiliza o único template no slot liberado (não promete alternância impossível com 1 template)
	assertInvariant(registry.releaseReservation(r1.reservation!), "libera clone 1");
	const r4 = registry.reserveForSession("same-4", "PVE", { participantKeys: ["u:1"] });
	assertInvariant(r4.ok && r4.reservation?.arenaId === "shared_island", "único template reutilizado sem erro mesmo repetindo último ArenaId");
	assertInvariant(r4.reservation!.slotId === r1.reservation!.slotId, "slot físico liberado foi reutilizado");
	assertInvariant(!registry.releaseReservation(r1.reservation!), "cleanup atrasado da reserva antiga não afeta r4");
	assertInvariant(r4.reservation!.instance.Parent !== undefined, "r4 permanece ativo após tentativa de cleanup atrasado");

	// Sem container de slots: nunca inventa coordenadas silenciosamente
	const noSlotWarnings: string[] = [];
	const noSlotsRegistry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: undefined,
		activeArenasParent: activeParent,
		warnFn: (msg) => noSlotWarnings.push(msg),
	});
	// Injeta pasta vazia para simular ausência de marcadores sem tocar Workspace global
	const emptySlots = new Instance("Folder");
	emptySlots.Name = "EmptySlots";
	emptySlots.Parent = root;
	const emptySlotsRegistry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: emptySlots,
		activeArenasParent: activeParent,
		warnFn: (msg) => noSlotWarnings.push(msg),
	});
	const noMarkerRes = emptySlotsRegistry.reserveForSession("no-slot-session", "PVE");
	assertInvariant(!noMarkerRes.ok && noMarkerRes.reason === "no_slot_available", "sem marcadores físicos não inventa posição");
	assertInvariant(noSlotWarnings.size() >= 1, "ausência de marcadores registra diagnóstico");

	noSlotsRegistry.destroy();
	emptySlotsRegistry.destroy();
	emptySlots.Destroy();
	registry.destroy();
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

function validateRandomSelectionAndNonRepetition(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Name = "L16TemplatesRandom";
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Name = "L16SlotsRandom";
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Name = "L16ActiveRandom";
	activeParent.Parent = root;

	buildTestArenaTemplate(templates, "Arena_01", "arena_a", new CFrame(0, 0, 0));
	buildTestArenaTemplate(templates, "Arena_02", "arena_b", new CFrame(0, 0, 0));
	buildTestArenaTemplate(templates, "Arena_03", "arena_c", new CFrame(0, 0, 0));
	buildTestSlotPart(slots, "Slot_01", new CFrame(0, 0, 0));
	buildTestSlotPart(slots, "Slot_02", new CFrame(300, 0, 0));

	// 1) Distribuição aleatória entre vários templates + não repetição imediata para PvE (1 participante)
	let failNextClone = false;
	const registry = new ArenaRegistry({
		templatesContainer: templates,
		slotsContainer: slots,
		activeArenasParent: activeParent,
		rng: makeSequenceRng([0.0, 0.0, 0.99, 0.0, 0.99, 0.5]),
		cloneTemplate: (template) => {
			if (failNextClone) {
				failNextClone = false;
				error("rollback sem poluir histórico");
			}
			return template.Clone();
		},
		warnFn: () => {},
	});
	registry.start();

	const seenIds = new Set<string>();
	let prevArenaId: string | undefined;
	for (const i of $range(1, 6)) {
		const res = registry.reserveForSession(`pve-seq-${i}`, "PVE", { participantKeys: ["u:500"] });
		assertInvariant(res.ok && res.reservation !== undefined, `reserva sequencial ${i}`);
		const currentId = res.reservation!.arenaId;
		seenIds.add(currentId);
		if (prevArenaId !== undefined) {
			assertInvariant(currentId !== prevArenaId, `não deve repetir imediatamente ${prevArenaId} na batalha ${i}`);
		}
		prevArenaId = currentId;
		registry.releaseReservation(res.reservation!);
	}
	assertInvariant(seenIds.size() === 3, `seleção aleatória deve cobrir os 3 templates, cobriu ${seenIds.size()}`);

	// Rollback de clone NÃO altera o último ArenaId registrado para o participante
	const lastBeforeFail = registry.getLastArenaIdForParticipant("u:500");
	failNextClone = true;
	const failed = registry.reserveForSession("pve-fail-hist", "PVE", { participantKeys: ["u:500"] });
	assertInvariant(!failed.ok && failed.reason === "clone_failed", "falha simulada de clone");
	assertInvariant(registry.getLastArenaIdForParticipant("u:500") === lastBeforeFail, "rollback não polui último ArenaId");

	// 2) PvP com 2 participantes evita repetir o último ArenaId de AMBOS quando há 3ª opção
	const rP1 = registry.reserveForSession("prep-p1", "PVE", { participantKeys: ["u:601"], rng: () => 0.0 }); // arena_a
	registry.releaseReservation(rP1.reservation!);
	const rP2 = registry.reserveForSession("prep-p2", "PVE", { participantKeys: ["u:602"], rng: () => 0.4 }); // arena_b
	registry.releaseReservation(rP2.reservation!);
	assertInvariant(rP1.reservation!.arenaId === "arena_a" && rP2.reservation!.arenaId === "arena_b", "históricos distintos preparados");

	const rPvp = registry.reserveForSession("pvp-avoid-both", "PVP", { participantKeys: ["u:601", "u:602"], rng: () => 0.0 });
	assertInvariant(rPvp.ok && rPvp.reservation!.arenaId === "arena_c", "PvP evita o último ArenaId de ambos os participantes quando há 3ª opção");
	registry.releaseReservation(rPvp.reservation!);

	// 3) Integração BattleSessionService: desconexão limpa histórico do participante e payload envia ArenaId + ArenaInstanceId
	const p1 = makeArenaMockPlayer(7701, "HistPlayer1");
	const payloads: BattleStartedPayload[] = [];
	const sessions = new BattleSessionService(
		createSurgicalMockAdapter({
			onBattleStarted: (_, payload) => payloads.push(payload),
		}),
		undefined,
		undefined,
		registry,
	);
	const rng = () => 0.5;
	assertInvariant(sessions.createSession(p1.player, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"), "sessão 1 p1");
	const firstId = payloads[0].arena!.arenaId;
	assertInvariant(
		payloads[0].arena!.instanceId.size() > 0 && payloads[0].arena!.arenaId === firstId,
		"BattleStarted envia ArenaInstanceId e ArenaId",
	);
	sessions.requestQuit(p1.player);

	assertInvariant(sessions.createSession(p1.player, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"), "sessão 2 p1");
	const secondId = payloads[1].arena!.arenaId;
	assertInvariant(secondId !== firstId, "segunda batalha do mesmo jogador via BattleSessionService evita repetição imediata");
	assertInvariant(registry.getLastArenaIdForParticipant("u:7701") === secondId, "histórico rastreado por participante");

	// Desconexão libera clone, slot e limpa histórico do participante
	p1.mock.Parent = undefined;
	sessions.destroySessionForPlayer(p1.player);
	assertInvariant(registry.getActiveReservations().size() === 0, "desconexão libera reserva");
	assertInvariant(registry.getLastArenaIdForParticipant("u:7701") === undefined, "desconexão limpa histórico do participante");

	// 4) Com apenas 2 templates e 2 jogadores cobrindo ambos no histórico, faz fallback limpo sem falhar
	templates.FindFirstChild("Arena_03")!.Destroy();
	registry.discoverTemplates();
	const a1 = registry.reserveForSession("two-p1", "PVE", { participantKeys: ["u:801"], rng: () => 0.0 });
	registry.releaseReservation(a1.reservation!);
	const a2 = registry.reserveForSession("two-p2", "PVE", { participantKeys: ["u:802"], rng: () => 0.99 });
	registry.releaseReservation(a2.reservation!);
	const bothCovered = registry.reserveForSession("two-pvp", "PVP", { participantKeys: ["u:801", "u:802"], rng: () => 0.0 });
	assertInvariant(bothCovered.ok && bothCovered.reservation !== undefined, "fallback limpo quando 2 templates estão ambos no histórico de PvP");
	registry.releaseReservation(bothCovered.reservation!);

	p1.cleanup();
	registry.destroy();
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

function validatePvpRandomPhysicalSidesWithArena(root: Folder): void {
	const templates = new Instance("Folder");
	templates.Name = "L2PvpTemplates";
	templates.Parent = root;
	const slots = new Instance("Folder");
	slots.Name = "L2PvpSlots";
	slots.Parent = root;
	const activeParent = new Instance("Folder");
	activeParent.Name = "L2PvpActive";
	activeParent.Parent = root;

	buildTestArenaTemplate(templates, "Arena_PvP", "pvp_arena_1", new CFrame(0, 0, 0));
	buildTestSlotPart(slots, "Slot_01", new CFrame(0, 0, 0));

	const registry = new ArenaRegistry({ templatesContainer: templates, slotsContainer: slots, activeArenasParent: activeParent });
	registry.discoverTemplates();

	const p1 = makeArenaMockPlayer(8801, "PvpDrawP1");
	const p2 = makeArenaMockPlayer(8802, "PvpDrawP2");
	let now = 1000;
	let currentRoll = 0.1;
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, {
		dataStore: new InMemoryDataStore(),
		serverId: "PvpDrawArena",
		now: () => now,
		waitFn: () => {},
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	assertInvariant(data.loadPlayer(p1.player).ok && data.loadPlayer(p2.player).ok, "load jogadores sorteio PvP");
	const p2Orig = progression.getPlayerData(p2.player)!.inventory[0];
	progression.loadValidatedPlayerData(p2.player, {
		version: PLAYER_DATA_SCHEMA_VERSION,
		inventory: [{ ...p2Orig, level: 30 }],
	});

	const starts = new Map<Player, BattleStartedPayload>();
	const sessions = new BattleSessionService(
		createSurgicalMockAdapter({ onBattleStarted: (player, payload) => starts.set(player, payload) }),
		undefined,
		progression,
		registry,
	);
	let inviteId = "";
	const pvp = new PvpService(
		sessions,
		data,
		progression,
		(_, payload) => { inviteId = payload.inviteId; },
		() => {},
		() => now,
		() => currentRoll,
	);

	// Sequência comprova sorteio inicial 50/50 (A), repetição permitida (A->A e B->B com roll >= 0.9) e alternância 90% (A->B e B->A)
	const sequence: readonly { readonly roll: number; readonly p1IsSideA: boolean }[] = [
		{ roll: 0.1, p1IsSideA: true },
		{ roll: 0.95, p1IsSideA: true },
		{ roll: 0.2, p1IsSideA: false },
		{ roll: 0.95, p1IsSideA: false },
		{ roll: 0.2, p1IsSideA: true },
	];
	for (const step of sequence) {
		const roll = step.roll;
		currentRoll = roll;
		starts.clear();
		now += PVP_INVITE_INTERVAL_SECONDS + 1;
		assertInvariant(pvp.challenge(p1.player, p2.player), `convite PvP roll=${roll}`);
		assertInvariant(pvp.respond(p2.player, { inviteId, accept: true }), `aceite PvP roll=${roll}`);

		const s1 = starts.get(p1.player)!;
		const s2 = starts.get(p2.player)!;
		assertInvariant(s1.arena !== undefined && s2.arena !== undefined, `payload.arena presente roll=${roll}`);
		assertInvariant(s1.arena!.instanceId === s2.arena!.instanceId, `mesmo clone roll=${roll}`);
		assertInvariant(
			s1.arena!.physicalSides[0] === s2.arena!.physicalSides[0] &&
				s1.arena!.physicalSides[1] === s2.arena!.physicalSides[1],
			`physicalSides idênticos roll=${roll}`,
		);
		const p1IsSideA = step.p1IsSideA;
		const expectedP1Side = p1IsSideA ? s1.arena!.physicalSides[0] : s1.arena!.physicalSides[1];
		const expectedP2Side = p1IsSideA ? s1.arena!.physicalSides[1] : s1.arena!.physicalSides[0];
		assertInvariant(s1.sides[0] === expectedP1Side && s2.sides[0] === expectedP2Side, `sides relativos batem com sorteio físico roll=${roll}`);
		assertInvariant(
			s1.fighters.find((f) => f.sideId === expectedP1Side)!.level === 1 &&
				s2.fighters.find((f) => f.sideId === expectedP2Side)!.level === 30,
			`fighters, HUD e physicalSides/câmera usam o mesmo sorteio roll=${roll}`,
		);

		sessions.requestQuit(p1.player);
	}

	p1.cleanup();
	p2.cleanup();
	registry.destroy();
	templates.Destroy();
	slots.Destroy();
	activeParent.Destroy();
}

export function validateArenaSelectionL16(): void {
	const root = new Instance("Folder");
	root.Name = "ArenaSelectionL16TestRoot";
	root.Parent = Workspace;
	const [ok, failure] = pcall(() => {
		validateUniversalCatalogAndNameIndependence(root);
		validateSameTemplateSimultaneousAndPhysicalSeparation(root);
		validateRandomSelectionAndNonRepetition(root);
		validatePvpRandomPhysicalSidesWithArena(root);
	});
	root.Destroy();
	if (!ok) {
		error(failure);
	}
	print("ARENA_SELECTION_L1_6_PASSED");
}
