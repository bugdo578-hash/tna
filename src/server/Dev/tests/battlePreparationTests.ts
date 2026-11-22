import { Players } from "@rbxts/services";
import {
	BATTLE_CAMERA_ARC_SECONDS,
	BATTLE_COUNTDOWN_SECONDS,
	BATTLE_COVER_TIMEOUT_SECONDS,
	BATTLE_EXIT_COVER_TIMEOUT_SECONDS,
	BATTLE_LOADING_TIMEOUT_SECONDS,
} from "../../../shared/configs/BattleIntro";
import type { BattleEndedPayload, BattleTransitionAck, BattleTransitionPayload } from "../../../shared/Remotes";
import type { BattleSessionRecord } from "../../Services/BattleSessionRecord";
import { BattleSessionService } from "../../Services/BattleSessionService";
import { createDummySide } from "../DummyFighters";
import { assertInvariant, createSurgicalMockAdapter } from "./testHelpers";

const first = { Parent: Players, UserId: 993011, Name: "IntroA" } as unknown as Player;
const second = { Parent: Players, UserId: 993012, Name: "IntroB" } as unknown as Player;
const outsider = { Parent: Players, UserId: 993013, Name: "IntroOther" } as unknown as Player;
const rng = () => 0.5;

function createFixture() {
	let now = 1000;
	let starts = 0;
	let releases = 0;
	let attacks = 0;
	let syncs = 0;
	let finishCount = 0;
	const endings: BattleEndedPayload[] = [];
	const schedules = new Map<Player, Extract<BattleTransitionPayload, { phase: "schedule" }>>();
	const covers = new Map<Player, number>();
	const adapter = createSurgicalMockAdapter({
		onBattleStarted: () => { starts += 1; },
		onBattleEnded: (_, payload) => { endings.push(payload); },
		onAtbSync: () => { syncs += 1; },
	});
	const service = new BattleSessionService({
		...adapter,
		transition: {
			bind: () => {},
			send: (player, payload) => {
				if (payload.phase === "cover") covers.set(player, payload.id);
				if (payload.phase === "schedule") schedules.set(player, payload);
			},
		},
		sendAttackStarted() { attacks += 1; },
		sendStateChanged(_, payload) { if (payload.battleReleased !== undefined) releases += 1; },
	}, undefined, undefined, undefined, undefined, () => now);
	const internals = service as unknown as {
		readonly activeSessions: readonly BattleSessionRecord[];
		receiveTransition(player: Player, id: number, ack: BattleTransitionAck): void;
		handleSkillRequest(player: Player, slot: 1): void;
	};
	return {
		service, endings, schedules, covers,
		stats: () => ({ starts, attacks, syncs, releases, finishCount }),
		start: (opponent?: Player, boss = false) => service.createSession(
			first, opponent, createDummySide(rng), createDummySide(rng), rng, opponent === undefined ? "PVE" : "PVP",
			() => { finishCount += 1; }, boss ? "BOSS" : undefined,
		),
		ack: (player: Player, ack: BattleTransitionAck, id = covers.get(player) ?? -1) => internals.receiveTransition(player, id, ack),
		skill: (player: Player) => internals.handleSkillRequest(player, 1),
		active: () => internals.activeSessions[0],
		elapse: (seconds = 0) => { now += seconds; service.step(seconds); },
		at: (time: number) => { now = time; service.step(0.25); },
	};
}

export function validateBattlePreparation(): void {
	const pvp = createFixture();
	assertInvariant(pvp.start(second), "PvP aceita preparação");
	pvp.ack(first, "covered");
	pvp.ack(outsider, "covered", pvp.covers.get(first));
	pvp.ack(second, "covered", 19);
	pvp.elapse(1);
	assertInvariant(pvp.stats().starts === 0, "ambas as coberturas válidas antecedem BattleStarted");
	pvp.ack(second, "covered");
	pvp.elapse();
	assertInvariant(pvp.stats().starts === 2, "ambos recebem BattleStarted");
	pvp.ack(first, "ready");
	pvp.ack(first, "ready");
	pvp.elapse(BATTLE_LOADING_TIMEOUT_SECONDS - 1);
	assertInvariant(pvp.schedules.size() === 0, "prontidão incompleta não agenda");
	pvp.ack(second, "ready");
	pvp.elapse();
	const a = pvp.schedules.get(first)!;
	const b = pvp.schedules.get(second)!;
	assertInvariant(a.arcAt === b.arcAt && a.goAt === b.goAt, "PvP usa o mesmo relógio nos dois clientes");
	assertInvariant(math.abs(a.goAt - a.arcAt - BATTLE_CAMERA_ARC_SECONDS - BATTLE_COUNTDOWN_SECONDS) < 1e-6, "arco seguido por três segundos de countdown");
	pvp.ack(first, "scheduled");
	pvp.ack(second, "scheduled");
	pvp.at(a.goAt - 0.001);
	assertInvariant(pvp.active().secondsWithoutAction === 0 && pvp.active().secondsOutsideIdle === 0, "timers parados na preparação");
	assertInvariant(pvp.service.getSideAtb(first, 0) === 0 && pvp.stats().syncs === 0, "sem ATB antes de GO");
	const side = pvp.active().sides[0];
	side.setAtb(10);
	pvp.skill(first);
	assertInvariant(side.atb === 10 && pvp.stats().attacks === 0, "pedidos recusados mesmo com ATB suficiente antes de GO");
	side.setAtb(0);
	pvp.at(a.goAt);
	assertInvariant(pvp.stats().releases === 2 && pvp.service.getSideAtb(first, 0) === 0, "mesma liberação, sem contabilizar frame anterior ao GO");
	pvp.elapse(0.5);
	assertInvariant(pvp.service.getSideAtb(first, 0) > 0 && pvp.stats().syncs > 0, "ATB começa depois de GO");
	pvp.service.quit(second, true);
	pvp.ack(first, "exitCovered");
	pvp.elapse();
	assertInvariant(pvp.stats().finishCount === 1 && !pvp.service.hasActiveSession(first), "saída PvP após desconexão");

	for (const scenario of ["cover", "load", "delivery", "failure", "arc", "countdown"] as const) {
		const test = createFixture();
		assertInvariant(test.start(undefined, scenario === "load"), "cria preparação PvE/Boss");
		assertInvariant(!test.service.requestPause(first), "pause bloqueado antes de GO");
		const ai = test.service.attachSideAI(first, 1, rng);
		assertInvariant(ai !== undefined, "IA pode ser registrada enquanto carrega");
		assertInvariant(!test.service.triggerSideSkill(first, 1, 1), "gatilho da IA bloqueado");
		if (scenario !== "cover") {
			test.ack(first, "covered");
			test.elapse();
		}
		if (scenario === "cover") test.elapse(BATTLE_COVER_TIMEOUT_SECONDS);
		if (scenario === "load") test.elapse(BATTLE_LOADING_TIMEOUT_SECONDS);
		if (scenario === "failure") test.ack(first, "failed");
		if (scenario === "delivery" || scenario === "arc" || scenario === "countdown") {
			test.ack(first, "ready");
			test.elapse();
			const schedule = test.schedules.get(first)!;
			if (scenario === "delivery") test.at(schedule.arcAt);
			else {
				test.ack(first, "scheduled");
				test.at(scenario === "arc" ? schedule.arcAt + 1 : schedule.goAt - 1);
				if (scenario === "arc") test.service.requestQuit(first);
				else test.service.quit(first, true);
			}
		}
		test.elapse(BATTLE_EXIT_COVER_TIMEOUT_SECONDS);
		assertInvariant(test.stats().releases === 0 && test.stats().finishCount === 1, `recuperação única: ${scenario}`);
		assertInvariant(test.endings.size() === 1 && test.endings[0].winnerSideId === undefined, `cancelamento sem vencedor: ${scenario}`);
		assertInvariant(test.start(), `nova batalha depois de ${scenario}`);
		test.ack(first, "covered", test.covers.get(first)! - 1);
		test.elapse();
		assertInvariant(test.stats().starts === (scenario === "cover" ? 0 : 1), "ack antigo não libera outra sessão");
	}
}
