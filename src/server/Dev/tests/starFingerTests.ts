import { ATB_MAX } from "../../../shared/Config";
import { BattleService, type HitResolvedEvent } from "../../Services/BattleService";
import { createJotaroVsAnubisSides } from "../DummyFighters";
import { assertInvariant } from "./testHelpers";

export function validateStarFinger(): void {
	const alwaysHitWithoutCrit = () => 0.99;
	const [jotaroSide, anubisSide] = createJotaroVsAnubisSides(alwaysHitWithoutCrit);
	const target = anubisSide.getActiveFighter();
	const initialHp = target.hp;
	const battle = new BattleService(jotaroSide, anubisSide, alwaysHitWithoutCrit);
	const hits: HitResolvedEvent[] = [];
	const disconnect = battle.events.hitResolved.connect((event) => hits.push(event));

	jotaroSide.setAtb(ATB_MAX);
	assertInvariant(battle.requestSkill(jotaroSide, 1), "Jotaro deve conseguir usar Star Finger no S1");
	battle.step(1);
	disconnect();

	assertInvariant(battle.state === "IDLE", "Star Finger deve concluir o ataque e retornar a IDLE");
	assertInvariant(hits.size() === 1, `Star Finger deve emitir 1 HitResolved (emitidos: ${hits.size()})`);
	const hit = hits[0];
	assertInvariant(
		hit.hitIndex === 1 && hit.target === target && hit.hit && !hit.crit && !hit.followUpCancelled,
		"Star Finger deve acertar o alvo ativo com o primeiro hit, sem crítico nem cancelamento",
	);
	assertInvariant(hit.damage > 0 && target.hp === initialHp - hit.damage, "Star Finger deve aplicar o dano emitido uma vez");
}
