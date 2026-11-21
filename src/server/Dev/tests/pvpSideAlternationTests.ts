// Testes dedicados de alternância inteligente de lados físicos (90/10) no PvP (L2.1).
import { Players } from "@rbxts/services";
import {
	ARENA_BASES_CONTAINER_NAME,
	ARENA_ID_ATTRIBUTE,
	ARENA_OPTIONAL_CAMERA_NAMES,
	ARENA_REQUIRED_ANCHOR_NAMES,
	ARENA_REQUIRED_TEAM_FOLDERS,
	ARENA_SLOT_ID_ATTRIBUTE,
	PLAYER_DATA_SCHEMA_VERSION,
	PVP_INVITE_EXPIRY_SECONDS,
	PVP_INVITE_INTERVAL_SECONDS,
	PVP_PROMPT_MAX_DISTANCE,
} from "../../../shared/Config";
import type { BattleStartedPayload, ChallengeReceivedPayload } from "../../../shared/Remotes";
import { ArenaRegistry } from "../../Services/ArenaRegistry";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { PlayerDataService } from "../../Services/PlayerDataService";
import { InMemoryDataStore } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import { PvpService, type PvpPhysicalSide } from "../../Services/PvpService";
import { createDummySide } from "../DummyFighters";
import { assertInvariant, createSeededRng, createSurgicalMockAdapter } from "./testHelpers";

interface MockPlayerFixture {
	readonly player: Player;
	readonly mock: { Parent: Players | undefined; Name: string; UserId: number };
	readonly root: Part;
	readonly destroy: () => void;
}

function makeMockPlayer(userId: number, name: string): MockPlayerFixture {
	const character = new Instance("Model");
	const root = new Instance("Part");
	root.Name = "HumanoidRootPart"; root.Anchored = true; root.Parent = character;
	const humanoid = new Instance("Humanoid");
	humanoid.Parent = character;
	const removing = new Instance("BindableEvent");
	const mock = {
		Parent: Players as Players | undefined, Name: name, UserId: userId, Character: character,
		CharacterRemoving: removing.Event, SetAttribute(_name: string, _value: AttributeValue): void {},
	};
	return { player: mock as unknown as Player, mock, root, destroy: () => { character.Destroy(); removing.Destroy(); } };
}

function createArenaFixture(slotCount: number): { readonly registry: ArenaRegistry; readonly cleanup: () => void } {
	const root = new Instance("Folder");
	const templates = new Instance("Folder"); templates.Parent = root;
	const slots = new Instance("Folder"); slots.Parent = root;
	const activeParent = new Instance("Folder"); activeParent.Parent = root;
	const model = new Instance("Model");
	model.Name = "Arena_L21_Template"; model.SetAttribute(ARENA_ID_ATTRIBUTE, "Arena_L21_01");
	const bases = new Instance("Folder"); bases.Name = ARENA_BASES_CONTAINER_NAME; bases.Parent = model;
	const makePart = (name: string, position: Vector3, parent: Instance): Part => {
		const part = new Instance("Part");
		part.Name = name; part.Anchored = true; part.CFrame = new CFrame(position); part.Parent = parent;
		return part;
	};
	let primaryPart: Part | undefined;
	for (const teamIndex of [0, 1] as const) {
		const dir = teamIndex === 0 ? -1 : 1;
		const teamFolder = new Instance("Folder"); teamFolder.Name = ARENA_REQUIRED_TEAM_FOLDERS[teamIndex]; teamFolder.Parent = bases;
		const anchors = ARENA_REQUIRED_ANCHOR_NAMES[teamIndex];
		const active = makePart(anchors.active, new Vector3(10 * dir, 0, 0), teamFolder);
		if (primaryPart === undefined) primaryPart = active;
		makePart(anchors.waiting[0], new Vector3(14 * dir, 0, -4), teamFolder);
		makePart(anchors.waiting[1], new Vector3(14 * dir, 0, 4), teamFolder);
		makePart(ARENA_OPTIONAL_CAMERA_NAMES[teamIndex], new Vector3(20 * dir, 8, 0), teamFolder);
	}
	model.PrimaryPart = primaryPart; model.Parent = templates;
	for (let i = 1; i <= slotCount; i++) {
		const slot = makePart(`Slot_${i}`, new Vector3(i * 500, 0, 0), slots);
		slot.SetAttribute(ARENA_SLOT_ID_ATTRIBUTE, `Slot_${i}`);
	}
	const registry = new ArenaRegistry({ templatesContainer: templates, slotsContainer: slots, activeArenasParent: activeParent, rng: createSeededRng(2101) });
	return { registry, cleanup: () => root.Destroy() };
}

interface MatchResult {
	readonly accepted: boolean;
	readonly challengerSide?: PvpPhysicalSide;
	readonly targetSide?: PvpPhysicalSide;
	readonly challengerPayload?: BattleStartedPayload;
	readonly targetPayload?: BattleStartedPayload;
}

function createHarness(options?: {
	readonly arenaRegistry?: ArenaRegistry;
	readonly onBattleStarted?: (player: Player, payload: BattleStartedPayload) => void;
}) {
	let now = 1000;
	let rollFn: () => number = () => 0.25;
	const progression = new ProgressionService();
	const data = new PlayerDataService(progression, {
		dataStore: new InMemoryDataStore(),
		serverId: "PvpSideL21",
		now: () => now,
		waitFn: () => {},
		warnFn: () => {},
		disableStudioAutoFallbackOnInjectedStore: true,
	});
	const starts = new Map<Player, BattleStartedPayload>();
	const sessions = new BattleSessionService(
		createSurgicalMockAdapter({
			onBattleStarted: (player, payload) => {
				starts.set(player, payload);
				options?.onBattleStarted?.(player, payload);
			},
		}),
		undefined,
		progression,
		options?.arenaRegistry,
	);
	const inviteBox: { current?: ChallengeReceivedPayload } = {};
	const pvp = new PvpService(
		sessions,
		data,
		progression,
		(_, payload) => {
			inviteBox.current = payload;
		},
		() => {},
		() => now,
		() => rollFn(),
	);

	const players: MockPlayerFixture[] = [];
	let nextUserId = 997000;
	const addPlayer = (label: string, level = 1): MockPlayerFixture => {
		const fixture = makeMockPlayer(nextUserId++, label);
		players.push(fixture);
		assertInvariant(data.loadPlayer(fixture.player).ok, `load ${label}`);
		if (level !== 1) {
			const original = progression.getPlayerData(fixture.player)!.inventory[0];
			progression.loadValidatedPlayerData(fixture.player, {
				version: PLAYER_DATA_SCHEMA_VERSION,
				inventory: [{ ...original, level }],
			});
		}
		return fixture;
	};

	const sideFromPayload = (payload: BattleStartedPayload): PvpPhysicalSide => {
		if (payload.arena !== undefined) {
			if (payload.sides[0] === payload.arena.physicalSides[0]) return "A";
			if (payload.sides[0] === payload.arena.physicalSides[1]) return "B";
			error("sides[0] nao corresponde a physicalSides");
		}
		return payload.sides[0].sub(-2) === "-A" ? "A" : "B";
	};

	const startMatch = (challenger: Player, target: Player, autoFinish = true): MatchResult => {
		now += PVP_INVITE_INTERVAL_SECONDS;
		starts.delete(challenger);
		starts.delete(target);
		inviteBox.current = undefined;
		if (!pvp.challenge(challenger, target)) return { accepted: false };
		const invite = inviteBox.current as ChallengeReceivedPayload | undefined;
		if (invite === undefined) return { accepted: false };
		const accepted = pvp.respond(target, { inviteId: invite.inviteId, accept: true });
		if (!accepted) return { accepted: false };
		const challengerPayload = starts.get(challenger)!;
		const targetPayload = starts.get(target)!;
		const challengerSide = sideFromPayload(challengerPayload);
		const targetSide = sideFromPayload(targetPayload);
		assertInvariant(challengerSide !== targetSide, "jogadores nunca podem cair no mesmo lado fisico");
		if (autoFinish) sessions.requestQuit(target);
		return { accepted: true, challengerSide, targetSide, challengerPayload, targetPayload };
	};

	const cleanup = () => {
		for (const fixture of players) {
			fixture.mock.Parent = Players;
			pvp.forgetPlayer(fixture.player);
			data.handlePlayerRemoving(fixture.player);
			fixture.destroy();
		}
	};

	return {
		pvp,
		sessions,
		addPlayer,
		setRoll: (fn: () => number) => { rollFn = fn; },
		advanceTime: (seconds: number) => { now += seconds; },
		startMatch,
		cleanup,
		getLastInvite: () => inviteBox.current,
	};
}

/** Valida os 12 cenários obrigatórios de alternância de lados físicos no PvP (L2.1). */
export function validatePvpSideAlternationL21(): void {
	// 1) Primeiro PvP sem histórico: sorteio 50/50
	{
		const h = createHarness();
		for (const [roll, expected] of [[0.0, "A"], [0.4999, "A"], [0.5, "B"], [0.9999, "B"]] as const) {
			const a = h.addPlayer(`FirstA_${roll}`);
			const b = h.addPlayer(`FirstB_${roll}`);
			assertInvariant(h.pvp.getLastPhysicalSide(a.player) === undefined && h.pvp.getLastPhysicalSide(b.player) === undefined, "sem historico inicial");
			h.setRoll(() => roll);
			const res = h.startMatch(a.player, b.player);
			assertInvariant(res.accepted && res.challengerSide === expected, `primeiro PvP roll=${roll} -> ${expected}`);
			assertInvariant(h.pvp.getLastPhysicalSide(a.player) === expected && h.pvp.getLastPhysicalSide(b.player) === (expected === "A" ? "B" : "A"), "historico gravado");
		}
		const seeded = createSeededRng(21001);
		h.setRoll(seeded);
		let countA = 0;
		const a = h.addPlayer("StatFirstA");
		const b = h.addPlayer("StatFirstB");
		for (let i = 0; i < 400; i++) {
			h.pvp.forgetPlayer(a.player);
			h.pvp.forgetPlayer(b.player);
			const res = h.startMatch(a.player, b.player);
			assertInvariant(res.accepted, "estatistica sem historico");
			if (res.challengerSide === "A") countA += 1;
		}
		assertInvariant(countA >= 160 && countA <= 240, `primeiro PvP deve ser ~50/50 (A=${countA}/400)`);
		h.cleanup();
	}

	// 2, 3, 4 e 7) Apenas um jogador com histórico A ou B (desafiante ou desafiado): 90% alternância e 10% repetição
	for (const initialSide of ["A", "B"] as const) {
		const oppositeSide: PvpPhysicalSide = initialSide === "A" ? "B" : "A";
		for (const role of ["challenger", "target"] as const) {
			const h = createHarness();
			const seedOpp = h.addPlayer(`Seed_${initialSide}_${role}`);
			const tracked = h.addPlayer(`Hist_${initialSide}_${role}`);
			const freshOpp = h.addPlayer(`Fresh_${initialSide}_${role}`);
			const seedHistory = () => {
				h.pvp.forgetPlayer(tracked.player);
				h.pvp.forgetPlayer(seedOpp.player);
				h.setRoll(() => (initialSide === "A" ? 0.1 : 0.9));
				assertInvariant(h.startMatch(tracked.player, seedOpp.player).challengerSide === initialSide, "semeia historico");
			};
			for (const [roll, expectedSide] of [[0.0, oppositeSide], [0.8999, oppositeSide], [0.9, initialSide], [0.9999, initialSide]] as const) {
				seedHistory();
				h.pvp.forgetPlayer(freshOpp.player);
				h.setRoll(() => roll);
				const res = role === "challenger" ? h.startMatch(tracked.player, freshOpp.player) : h.startMatch(freshOpp.player, tracked.player);
				const actualSide = role === "challenger" ? res.challengerSide : res.targetSide;
				assertInvariant(res.accepted && actualSide === expectedSide, `unico=${initialSide} role=${role} roll=${roll} -> ${expectedSide}`);
				assertInvariant(h.pvp.getLastPhysicalSide(tracked.player) === expectedSide, "historico atualizado");
			}
			const seeded = createSeededRng(initialSide === "A" ? 21002 : 21003);
			let alternated = 0;
			let repeated = 0;
			for (let i = 0; i < 500; i++) {
				seedHistory();
				h.pvp.forgetPlayer(freshOpp.player);
				h.setRoll(seeded);
				const res = role === "challenger" ? h.startMatch(tracked.player, freshOpp.player) : h.startMatch(freshOpp.player, tracked.player);
				const actualSide = role === "challenger" ? res.challengerSide : res.targetSide;
				assertInvariant(res.accepted, "estatistica unico historico");
				if (actualSide === oppositeSide) alternated += 1;
				else repeated += 1;
			}
			assertInvariant(alternated >= 420 && alternated <= 480 && repeated > 0, `unico=${initialSide} role=${role} ~90% (alt=${alternated}, rep=${repeated})`);
			h.cleanup();
		}
	}

	// 5) Dois históricos opostos: uma escolha atende ambos simultaneamente (90/10)
	for (const firstRoll of [0.1, 0.9]) {
		const h = createHarness();
		const a = h.addPlayer(`OppA_${firstRoll}`);
		const b = h.addPlayer(`OppB_${firstRoll}`);
		const seedOpposite = () => {
			h.pvp.forgetPlayer(a.player);
			h.pvp.forgetPlayer(b.player);
			h.setRoll(() => firstRoll);
			assertInvariant(h.startMatch(a.player, b.player).accepted, "semeia opostos");
		};
		const prevA: PvpPhysicalSide = firstRoll < 0.5 ? "A" : "B";
		const altA: PvpPhysicalSide = prevA === "A" ? "B" : "A";
		for (const [roll, expectedA] of [[0.0, altA], [0.8999, altA], [0.9, prevA], [0.9999, prevA]] as const) {
			seedOpposite();
			h.setRoll(() => roll);
			const res = h.startMatch(a.player, b.player);
			assertInvariant(res.accepted && res.challengerSide === expectedA && res.targetSide !== expectedA, `opostos prevA=${prevA} roll=${roll}`);
		}
		const seeded = createSeededRng(firstRoll < 0.5 ? 21005 : 21006);
		let alternatedBoth = 0;
		for (let i = 0; i < 500; i++) {
			seedOpposite();
			h.setRoll(seeded);
			const res = h.startMatch(a.player, b.player);
			assertInvariant(res.accepted, "estatistica opostos");
			if (res.challengerSide === altA && res.targetSide === prevA) alternatedBoth += 1;
		}
		assertInvariant(alternatedBoth >= 420 && alternatedBoth <= 480, `opostos ~90% (${alternatedBoth}/500)`);
		h.cleanup();
	}

	// 6) Dois históricos iguais (conflito): sorteio justo 50/50 sem favorecer desafiante nem desafiado
	for (const sameSide of ["A", "B"] as const) {
		const h = createHarness();
		const a = h.addPlayer(`ConfA_${sameSide}`);
		const b = h.addPlayer(`ConfB_${sameSide}`);
		const h1 = h.addPlayer(`ConfH1_${sameSide}`);
		const h2 = h.addPlayer(`ConfH2_${sameSide}`);
		const seedConflict = () => {
			for (const p of [a, b, h1, h2]) h.pvp.forgetPlayer(p.player);
			h.setRoll(() => (sameSide === "A" ? 0.1 : 0.9));
			assertInvariant(h.startMatch(a.player, h1.player).challengerSide === sameSide, "semeia A conflito");
			assertInvariant(h.startMatch(b.player, h2.player).challengerSide === sameSide, "semeia B conflito");
		};
		for (const [roll, expectedChallenger] of [[0.0, "A"], [0.4999, "A"], [0.5, "B"], [0.9999, "B"]] as const) {
			seedConflict();
			h.setRoll(() => roll);
			const res = h.startMatch(a.player, b.player);
			assertInvariant(res.accepted && res.challengerSide === expectedChallenger && res.targetSide !== expectedChallenger, `conflito ${sameSide}/${sameSide} roll=${roll}`);
		}
		const seeded = createSeededRng(sameSide === "A" ? 21007 : 21008);
		let challengerA = 0;
		for (let i = 0; i < 400; i++) {
			seedConflict();
			h.setRoll(seeded);
			const res = i % 2 === 0 ? h.startMatch(a.player, b.player) : h.startMatch(b.player, a.player);
			assertInvariant(res.accepted && res.challengerSide !== res.targetSide, "conflito lados distintos");
			if (res.challengerSide === "A") challengerA += 1;
		}
		assertInvariant(challengerA >= 160 && challengerA <= 240, `conflito ${sameSide}/${sameSide} ~50/50 (${challengerA}/400)`);
		h.cleanup();
	}

	// 8) Falha ao criar batalha e tentativas recusadas/expiradas/sem arena não alteram histórico
	{
		let failStart = true;
		const h = createHarness({ onBattleStarted: () => { if (failStart) error("falha intencional"); } });
		const a = h.addPlayer("FailA");
		const b = h.addPlayer("FailB");
		h.setRoll(() => 0.1);
		assertInvariant(!h.startMatch(a.player, b.player).accepted, "erro inicial falha");
		assertInvariant(h.pvp.getLastPhysicalSide(a.player) === undefined && h.pvp.getLastPhysicalSide(b.player) === undefined, "erro inicial nao grava historico");

		failStart = false;
		assertInvariant(h.startMatch(a.player, b.player).challengerSide === "A", "partida valida grava A/B");
		failStart = true;
		assertInvariant(!h.startMatch(a.player, b.player).accepted, "segunda falha rejeita");
		assertInvariant(h.pvp.getLastPhysicalSide(a.player) === "A" && h.pvp.getLastPhysicalSide(b.player) === "B", "falha posterior preserva historico");

		failStart = false;
		h.advanceTime(PVP_INVITE_INTERVAL_SECONDS);
		assertInvariant(h.pvp.challenge(a.player, b.player) && h.pvp.respond(b.player, { inviteId: h.getLastInvite()!.inviteId, accept: false }), "recusa convite");
		assertInvariant(h.pvp.getLastPhysicalSide(a.player) === "A" && h.pvp.getLastPhysicalSide(b.player) === "B", "recusa preserva historico");

		h.advanceTime(PVP_INVITE_EXPIRY_SECONDS + PVP_INVITE_INTERVAL_SECONDS);
		assertInvariant(h.pvp.challenge(a.player, b.player), "convite para expirar");
		h.advanceTime(PVP_INVITE_EXPIRY_SECONDS + 1);
		assertInvariant(!h.pvp.respond(b.player, { inviteId: h.getLastInvite()!.inviteId, accept: true }), "expirado rejeita");
		assertInvariant(h.pvp.getLastPhysicalSide(a.player) === "A" && h.pvp.getLastPhysicalSide(b.player) === "B", "expiracao preserva historico");

		h.advanceTime(PVP_INVITE_INTERVAL_SECONDS);
		assertInvariant(h.pvp.challenge(a.player, b.player), "convite alcance");
		b.root.Position = new Vector3(PVP_PROMPT_MAX_DISTANCE + 5, 0, 0);
		assertInvariant(!h.pvp.respond(b.player, { inviteId: h.getLastInvite()!.inviteId, accept: true }), "alcance rejeita");
		assertInvariant(h.pvp.getLastPhysicalSide(a.player) === "A" && h.pvp.getLastPhysicalSide(b.player) === "B", "alcance preserva historico");
		h.cleanup();

		const emptyArena = createArenaFixture(0);
		const ha = createHarness({ arenaRegistry: emptyArena.registry });
		const x = ha.addPlayer("NoArenaA");
		const y = ha.addPlayer("NoArenaB");
		assertInvariant(!ha.startMatch(x.player, y.player).accepted, "sem slot falha");
		assertInvariant(ha.pvp.getLastPhysicalSide(x.player) === undefined && ha.pvp.getLastPhysicalSide(y.player) === undefined, "falha de arena nao grava historico");
		ha.cleanup();
		emptyArena.cleanup();
	}

	// 9) Reconexão limpa histórico
	{
		const h = createHarness();
		const a = h.addPlayer("ReconnA");
		const b = h.addPlayer("ReconnB");
		h.setRoll(() => 0.1);
		assertInvariant(h.startMatch(a.player, b.player).challengerSide === "A", "A no Time A");
		h.pvp.forgetPlayer(a.player);
		assertInvariant(h.pvp.getLastPhysicalSide(a.player) === undefined && h.pvp.getLastPhysicalSide(b.player) === "B", "saida limpa apenas A");
		h.pvp.forgetPlayer(b.player);
		h.setRoll(() => 0.49);
		assertInvariant(h.startMatch(a.player, b.player).challengerSide === "A", "pos-reconexao 0.49 -> A");
		h.pvp.forgetPlayer(a.player);
		h.pvp.forgetPlayer(b.player);
		h.setRoll(() => 0.51);
		assertInvariant(h.startMatch(a.player, b.player).challengerSide === "B", "pos-reconexao 0.51 -> B");
		const aRejoined = makeMockPlayer(a.mock.UserId, "ReconnA_New");
		assertInvariant(h.pvp.getLastPhysicalSide(aRejoined.player) === undefined, "nova instancia Player sem historico");
		aRejoined.destroy();
		h.cleanup();
	}

	// 10 e 11) Alinhamento payload/physicalSides/lutadores/câmeras e múltiplas sessões PvP simultâneas + guarda de reentrância
	{
		const arenaFixture = createArenaFixture(2);
		let reentrantAttempted = false;
		let reentrantResult = true;
		let hRef: ReturnType<typeof createHarness> | undefined;
		let reentrantTarget: Player | undefined;
		const h = createHarness({
			arenaRegistry: arenaFixture.registry,
			onBattleStarted: (player) => {
				if (!reentrantAttempted && hRef !== undefined && reentrantTarget !== undefined && player === reentrantTarget) {
					reentrantAttempted = true;
					const invite = hRef.getLastInvite();
					if (invite !== undefined) reentrantResult = hRef.pvp.respond(reentrantTarget, { inviteId: invite.inviteId, accept: true });
				}
			},
		});
		hRef = h;
		const p1 = h.addPlayer("AlignP1", 5);
		const p2 = h.addPlayer("AlignP2", 18);
		const p3 = h.addPlayer("MultiP3", 7);
		const p4 = h.addPlayer("MultiP4", 22);
		reentrantTarget = p2.player;

		h.setRoll(() => 0.1);
		const m1 = h.startMatch(p1.player, p2.player, false);
		const m2 = h.startMatch(p3.player, p4.player, false);
		assertInvariant(reentrantAttempted && !reentrantResult, "reentrancia bloqueada durante criacao");
		assertInvariant(m1.accepted && m2.accepted, "duas sessoes simultaneas criadas");

		const p1P1 = m1.challengerPayload!;
		const p2P1 = m1.targetPayload!;
		const p3P1 = m2.challengerPayload!;
		const p4P1 = m2.targetPayload!;
		assertInvariant(p1P1.arena!.instanceId === p2P1.arena!.instanceId && p1P1.arena!.instanceId !== p3P1.arena!.instanceId, "instancias isoladas por par");
		assertInvariant(p1P1.arena!.physicalSides[0] === p2P1.arena!.physicalSides[0] && p1P1.arena!.physicalSides[1] === p2P1.arena!.physicalSides[1], "physicalSides canonico");
		assertInvariant(p1P1.sides[0] === p1P1.arena!.physicalSides[0] && p2P1.sides[0] === p2P1.arena!.physicalSides[1], "Match 1 sides alinhado");
		assertInvariant(p1P1.fighters.find(f => f.sideId === p1P1.arena!.physicalSides[0])!.level === 5 && p1P1.fighters.find(f => f.sideId === p1P1.arena!.physicalSides[1])!.level === 18, "Match 1 lutadores alinhados");
		const res1 = h.sessions.getSessionArenaReservation(p1.player)!;
		assertInvariant(
			res1.instance.FindFirstChild(ARENA_BASES_CONTAINER_NAME)?.FindFirstChild(ARENA_REQUIRED_TEAM_FOLDERS[0])?.FindFirstChild(ARENA_OPTIONAL_CAMERA_NAMES[0]) !== undefined &&
				res1.instance.FindFirstChild(ARENA_BASES_CONTAINER_NAME)?.FindFirstChild(ARENA_REQUIRED_TEAM_FOLDERS[1])?.FindFirstChild(ARENA_OPTIONAL_CAMERA_NAMES[1]) !== undefined,
			"Camera_A e Camera_B preservadas no clone",
		);
		assertInvariant(p3P1.sides[0] === p3P1.arena!.physicalSides[0] && p4P1.sides[0] === p4P1.arena!.physicalSides[1], "par 2 alinhado");

		h.sessions.requestQuit(p2.player);
		h.setRoll(() => 0.1);
		const m1Rematch = h.startMatch(p1.player, p2.player, false);
		assertInvariant(m1Rematch.accepted && m1Rematch.challengerSide === "B" && m1Rematch.targetSide === "A", "revanche alterna p1->B e p2->A");
		const p1P2 = m1Rematch.challengerPayload!;
		const p2P2 = m1Rematch.targetPayload!;
		assertInvariant(p1P2.sides[0] === p1P2.arena!.physicalSides[1] && p2P2.sides[0] === p2P2.arena!.physicalSides[0], "revanche inverte physicalSides");
		assertInvariant(p1P2.fighters.find(f => f.sideId === p1P2.arena!.physicalSides[0])!.level === 18 && p1P2.fighters.find(f => f.sideId === p1P2.arena!.physicalSides[1])!.level === 5, "revanche lutadores alinhados");
		assertInvariant(h.sessions.hasActiveSession(p3.player) && h.pvp.getLastPhysicalSide(p3.player) === "A" && h.pvp.getLastPhysicalSide(p4.player) === "B", "par 2 sem interferencia");

		h.sessions.requestQuit(p2.player);
		h.sessions.requestQuit(p4.player);
		h.cleanup();
		arenaFixture.cleanup();
	}

	// 12) PvE e Boss sem alterações e sem interferir no histórico PvP
	{
		const arenaFixture = createArenaFixture(2);
		const pveStarts: BattleStartedPayload[] = [];
		const h = createHarness({
			arenaRegistry: arenaFixture.registry,
			onBattleStarted: (_, payload) => { if (payload.mode === "PVE") pveStarts.push(payload); },
		});
		const p1 = h.addPlayer("PveBossP1");
		const p2 = h.addPlayer("PveBossP2");

		for (const encounterKind of ["PVE", "BOSS"] as const) {
			assertInvariant(h.sessions.createSession(p1.player, undefined, createDummySide(() => 0.5), createDummySide(() => 0.5), () => 0.5, "PVE", undefined, encounterKind), `cria ${encounterKind}`);
			const payload = pveStarts[pveStarts.size() - 1];
			assertInvariant(payload.canPause === true && payload.mode === "PVE" && payload.sides[0] === payload.arena!.physicalSides[0], `${encounterKind} mantem Time A e pause`);
			assertInvariant(h.pvp.getLastPhysicalSide(p1.player) === undefined, `${encounterKind} nao grava historico PvP`);
			h.sessions.requestQuit(p1.player);
		}
		h.setRoll(() => 0.1);
		assertInvariant(h.startMatch(p1.player, p2.player).challengerSide === "A", "PvP inicial coloca p1 em A");
		for (const encounterKind of ["PVE", "BOSS"] as const) {
			assertInvariant(h.sessions.createSession(p1.player, undefined, createDummySide(() => 0.5), createDummySide(() => 0.5), () => 0.95, "PVE", undefined, encounterKind), `${encounterKind} apos PvP`);
			const payload = pveStarts[pveStarts.size() - 1];
			assertInvariant(payload.sides[0] === payload.arena!.physicalSides[0], `${encounterKind} apos PvP mantem Time A`);
			h.sessions.requestQuit(p1.player);
		}
		assertInvariant(h.pvp.getLastPhysicalSide(p1.player) === "A", "PvE/Boss preserva historico PvP");
		h.pvp.forgetPlayer(p2.player);
		h.setRoll(() => 0.85);
		assertInvariant(h.startMatch(p1.player, p2.player).challengerSide === "B", "PvP seguinte ainda alterna A -> B");
		h.cleanup();
		arenaFixture.cleanup();
	}

	print("PVP_SIDE_ALTERNATION_L2_1_PASSED");
}
