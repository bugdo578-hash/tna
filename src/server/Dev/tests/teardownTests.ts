// Testes de ciclo de vida de teardown de sessão de batalha, exigência de Players.Parent e isolamento de erros entre sessões.
import { Players } from "@rbxts/services";
import {
	ATB_MIN,
	BATTLE_INACTIVITY_TIMEOUT_SECONDS,
	NPC_BATTLE_ACTIVE_ATTRIBUTE,
	PVP_DAILY_XP_CAP,
} from "../../../shared/Config";
import type { BattleEndedPayload, BattleStartedPayload } from "../../../shared/Remotes";
import { BattleSide } from "../../Components/BattleSide";
import { AIService } from "../../Services/AIService";
import { freezeBattleMovement } from "../../Services/BattleMovement";
import { BattleService } from "../../Services/BattleService";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { TinyesService } from "../../Services/TinyesService";
import { createDummySide } from "../DummyFighters";
import {
	assertInvariant,
	createSeededRng,
	createSurgicalMockAdapter,
	FIRST_SIMULATION_SEED,
} from "./testHelpers";

/** End-of-session notifications cannot depend on rewards or optional cleanup succeeding. Studio mocks only. */
export function validateBattleTeardownLifecycle(): void {
	for (const outcome of ["pveWin", "pveLoss", "pveQuit", "pvpWin", "pvpQuit", "disconnect", "respawn",
		"error", "timeout", "startError", "rewardError", "xpError", "sendError", "cleanupError"] as const) {
		const makePlayer = (id: number) => {
			const humanoid = new Instance("Humanoid");
			humanoid.WalkSpeed = 23; humanoid.JumpPower = 61; humanoid.JumpHeight = 9;
			const removing = new Instance("BindableEvent");
			const attributes = new Map<string, AttributeValue>();
			const mock = { Parent: Players as Players | undefined, Name: `Teardown${id}`, UserId: id,
				CharacterRemoving: removing.Event,
				SetAttribute(name: string, value: AttributeValue): void { attributes.set(name, value); } };
			return { player: mock as unknown as Player, mock, humanoid, removing, attributes };
		};
		const a = makePlayer(993001); const b = makePlayer(993002);
		const pve = outcome === "pveWin" || outcome === "pveLoss" || outcome === "pveQuit";
		const participants = pve ? [a] : [a, b];
		const attempts: { player: Player; payload: BattleEndedPayload }[] = [];
		const adapter = createSurgicalMockAdapter({
			onBattleStarted: (player) => { if (outcome === "startError" && player === b.player) error("teardown start injection"); },
			onBattleEnded: (player, payload) => {
				attempts.push({ player, payload });
				if (outcome === "sendError" && player === a.player) error("teardown send injection");
			},
		});
		const tinyes = { awardPvpWin: () => {
			if (outcome === "rewardError") error("teardown reward injection");
			return { amount: 100 };
		}, getRemainingPvpXp: () => PVP_DAILY_XP_CAP, recordPvpXp: () => {}, syncBalance: () => {}, addTinyes: () => ({ ok: true }) } as unknown as TinyesService;
		const sessions = new BattleSessionService(adapter, tinyes);
		const rng = () => 0.5;
		const releases = participants.map(p => freezeBattleMovement(p.player, p.humanoid, () => sessions.destroySessionForPlayer(p.player)));
		let releaseCount = 0;
		const created = sessions.createSession(a.player, pve ? undefined : b.player, createDummySide(rng), createDummySide(rng), rng,
			pve ? "PVE" : "PVP", () => { releaseCount++; for (const release of releases) release(); });
		const internals = sessions as unknown as { activeSessions: { battle: BattleService; sides: [BattleSide, BattleSide];
			resolvedHits: number; disconnectors: (() => void)[]; aiControllers: AIService[] }[]; awardSessionXp(): void };
		if (outcome !== "startError") {
			assertInvariant(created && attempts.size() === 0 && releaseCount === 0, `${outcome}: no premature end`);
			for (const p of participants) assertInvariant(sessions.hasActiveSession(p.player) && p.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === true &&
				p.humanoid.WalkSpeed === 0, `${outcome}: battle remains active`);
			const record = internals.activeSessions[0];
			record.resolvedHits = 99;
			// Fixture da trava de dano; a contagem de dano real é exercitada nos testes PVP.
			for (const fighter of record.sides[0].fighters) (fighter as unknown as { itemUuid: string }).itemUuid = `teardown-${fighter.fighterId}`;
			record.battle.getDamageDealt = () => 100;
			if (outcome === "xpError") internals.awardSessionXp = () => error("teardown XP injection");
			if (outcome === "cleanupError") {
				record.aiControllers.push({ destroy: () => error("teardown AI injection") } as unknown as AIService);
				record.disconnectors.push(() => error("teardown connection injection"));
			}
			if (outcome === "pveQuit") sessions.requestQuit(a.player);
			else if (outcome === "pvpQuit" || outcome === "rewardError" || outcome === "xpError") sessions.requestQuit(b.player);
			else if (outcome === "disconnect") { b.mock.Parent = undefined; sessions.destroySessionForPlayer(b.player); }
			else if (outcome === "respawn") { b.removing.Fire(); task.wait(); }
			else if (outcome === "error") { record.battle.step = () => error("teardown step injection"); sessions.step(0.1); }
			else if (outcome === "timeout") sessions.step(BATTLE_INACTIVITY_TIMEOUT_SECONDS);
			else { record.battle.events.battleEnd.fire(record.sides[outcome === "pveLoss" ? 1 : 0]); sessions.step(0); }
		}
		for (const p of participants) {
			const events = attempts.filter(event => event.player === p.player);
			assertInvariant(events.size() === (p.mock.Parent === Players ? 1 : 0), `${outcome}: every connected participant notified exactly once`);
			assertInvariant(!sessions.hasActiveSession(p.player) && p.attributes.get(NPC_BATTLE_ACTIVE_ATTRIBUTE) === false,
				`${outcome}: no session and NpcBattleActive false`);
			assertInvariant(p.humanoid.WalkSpeed === 23 && p.humanoid.JumpPower === 61 && p.humanoid.JumpHeight === 9,
				`${outcome}: movement restored`);
			if (outcome === "error" || outcome === "timeout" || outcome === "startError") assertInvariant(events[0].payload.winnerSideId === undefined &&
				events[0].payload.xpRewards === undefined, `${outcome}: no winner or XP`);
			p.humanoid.Destroy(); p.removing.Destroy();
		}
		assertInvariant(releaseCount === 1 && internals.activeSessions.size() === 0, `${outcome}: cleanup once`);
	}
	print("BATTLE_TEARDOWN_LIFECYCLE_PASSED");
}

/** Item 1: createSession recusa jogador fora de Players (primeiro ou segundo). */
export function validateCreateSessionRequiresPlayersParent(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	const startedEvents: { player: Player; payload: BattleStartedPayload }[] = [];
	const sessionService = new BattleSessionService(
		createSurgicalMockAdapter({ onBattleStarted: (player, payload) => startedEvents.push({ player, payload }) }),
	);
	const insidePlayer = { Parent: Players, Name: "InsidePlayer" } as unknown as Player;
	const outsidePlayer = { Name: "OutsidePlayer" } as unknown as Player;

	assertInvariant(
		!sessionService.createSession(outsidePlayer, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
		"createSession deve recusar primeiro jogador fora de Players",
	);
	assertInvariant(
		!sessionService.createSession(insidePlayer, outsidePlayer, createDummySide(rng), createDummySide(rng), rng, "PVP"),
		"createSession deve recusar segundo jogador fora de Players",
	);
	assertInvariant(
		!sessionService.hasActiveSession(outsidePlayer) && !sessionService.hasActiveSession(insidePlayer),
		"sessão recusada não pode registrar nenhum participante",
	);
	assertInvariant(startedEvents.size() === 0, "sessão recusada não pode emitir BattleStarted");

	// Controle: jogador em Players cria sessão; o id não foi consumido pelas recusas
	assertInvariant(
		sessionService.createSession(insidePlayer, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
		"createSession deve aceitar jogador em Players",
	);
	assertInvariant(
		startedEvents.size() === 1 && startedEvents[0].payload.sides[0] === "battle-0-A",
		"recusas não podem consumir id de sessão",
	);
	sessionService.requestQuit(insidePlayer);
	assertInvariant(!sessionService.hasActiveSession(insidePlayer), "sessão de controle deve ser limpa");
	print("SURGICAL_1_CREATE_SESSION_PLAYERS_PASSED");
}

/** Item 2: erro em uma sessão (step ou syncAtb) encerra só ela; as outras continuam avançando. */
export function validateSessionErrorIsolation(): void {
	const rng = createSeededRng(FIRST_SIMULATION_SEED);
	const stepFailPlayer = { Parent: Players, Name: "StepFailPlayer" } as unknown as Player;
	const syncFailPlayer = { Parent: Players, Name: "SyncFailPlayer" } as unknown as Player;
	const healthyPlayer = { Parent: Players, Name: "HealthyPlayer" } as unknown as Player;
	const endedEvents: { player: Player; payload: BattleEndedPayload }[] = [];
	let healthySyncCount = 0;

	const sessionService = new BattleSessionService(
		createSurgicalMockAdapter({
			onBattleEnded: (player, payload) => endedEvents.push({ player, payload }),
			onEffectTick: (player) => {
				if (player === stepFailPlayer) error("falha simulada dentro do step");
			},
			onAtbSync: (player) => {
				if (player === syncFailPlayer) error("falha simulada dentro do syncAtb");
				if (player === healthyPlayer) healthySyncCount += 1;
			},
		}),
	);

	const stepFailSide = createDummySide(rng);
	stepFailSide.fighters[0].applyStatusEffect("Bleed", 1, 12); // tick em 1s dispara sendEffectTick dentro do step
	assertInvariant(
		sessionService.createSession(stepFailPlayer, undefined, stepFailSide, createDummySide(rng), rng, "PVE"),
		"deveria criar sessão que falha no step",
	);
	assertInvariant(
		sessionService.createSession(syncFailPlayer, undefined, createDummySide(rng), createDummySide(rng), rng, "PVE"),
		"deveria criar sessão que falha no syncAtb",
	);
	const healthySide = createDummySide(rng);
	assertInvariant(
		sessionService.createSession(healthyPlayer, undefined, healthySide, createDummySide(rng), rng, "PVE"),
		"deveria criar sessão saudável",
	);

	// 1º step: syncAtb da sessão syncFail lança erro (antes da sessão saudável no loop)
	sessionService.step(0.5);
	assertInvariant(!sessionService.hasActiveSession(syncFailPlayer), "sessão com erro em syncAtb deve ser destruída");
	assertInvariant(sessionService.hasActiveSession(stepFailPlayer), "sessão sem erro ainda deve estar ativa");
	assertInvariant(sessionService.hasActiveSession(healthyPlayer), "sessão saudável deve continuar ativa");
	const healthyAtbAfterFirstStep = healthySide.atb;
	const healthySyncsAfterFirstStep = healthySyncCount;
	assertInvariant(
		healthyAtbAfterFirstStep > ATB_MIN && healthySyncsAfterFirstStep > 0,
		"sessão saudável deve avançar ATB e sincronizar mesmo após erro de outra sessão",
	);

	// 2º step: tick de Bleed lança erro dentro do battle.step da sessão stepFail (primeira do loop)
	sessionService.step(0.6);
	assertInvariant(!sessionService.hasActiveSession(stepFailPlayer), "sessão com erro em step deve ser destruída");
	assertInvariant(sessionService.hasActiveSession(healthyPlayer), "sessão saudável deve continuar ativa");
	assertInvariant(
		healthySide.atb > healthyAtbAfterFirstStep && healthySyncCount > healthySyncsAfterFirstStep,
		"sessão saudável deve seguir avançando após erro em step de outra sessão",
	);

	let syncFailEnded = 0;
	let stepFailEnded = 0;
	let healthyEnded = 0;
	for (const event of endedEvents) {
		if (event.player === syncFailPlayer && event.payload.winnerSideId === undefined) syncFailEnded += 1;
		if (event.player === stepFailPlayer && event.payload.winnerSideId === undefined) stepFailEnded += 1;
		if (event.player === healthyPlayer) healthyEnded += 1;
	}
	assertInvariant(
		syncFailEnded === 1 && stepFailEnded === 1 && healthyEnded === 0,
		"sessões com erro devem receber BattleEnded sem vencedor exatamente uma vez; saudável nenhuma",
	);
	sessionService.requestQuit(healthyPlayer);
	assertInvariant(!sessionService.hasActiveSession(healthyPlayer), "sessão saudável deve ser limpa no fim");
	print("SURGICAL_2_SESSION_ERROR_ISOLATION_PASSED");
}
