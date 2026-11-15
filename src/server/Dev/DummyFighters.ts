import { makeRealFighter } from "../Services/BattleTeamFactory";
export { makeRealFighter, createPlayerInventorySide } from "../Services/BattleTeamFactory";
import { BASE_ATB_SPEED, DEV_OPPONENT_SEED, MIN_LEVEL } from "../../shared/Config";
import { type RealFighterId } from "../../shared/FighterData";
import { calcSkillSlotRoll } from "../../shared/MathUtils";
import type { SkillDataSlots } from "../../shared/SkillData";
import type { ClassName, SkillSlots, StatBlock } from "../../shared/TypeDefs";
import { BattleSide, type FighterLineup } from "../Components/BattleSide";
import { Fighter } from "../Components/Fighter";

const DUMMY_HP = 100;
const DUMMY_LEVEL = 10;

/** dev: somente os rolls do oponente usam seed fixa; RNG da luta continua independente. */
export function createDevOpponentSide(rng: () => number): BattleSide {
	const random = new Random(DEV_OPPONENT_SEED);
	const rollRng = () => random.NextNumber();
	return new BattleSide([
		makeRealFighter("anubis", rollRng),
		makeRealFighter("anubis", rollRng),
		makeRealFighter("anubis", rollRng),
	], rng);
}

export const DUMMY_SKILL_DATA: SkillDataSlots = [
	{
		prepareTime: 0.2,
		hits: [{ time: 0.1, damageShare: 1, followUp: false }],
		returnTime: 0.25,
		dodgeReturnTime: 0.1,
		statusEffects: ["Bleed"],
	},
	{
		prepareTime: 0.3,
		hits: [
			{ time: 0.1, damageShare: 0.5, followUp: true },
			{ time: 0.3, damageShare: 0.5, followUp: false },
		],
		returnTime: 0.3,
		dodgeReturnTime: 0.1,
		statusEffects: ["Burn"],
	},
	{
		prepareTime: 0.4,
		hits: [{ time: 0.2, damageShare: 1, followUp: false }],
		returnTime: 0.35,
		dodgeReturnTime: 0.15,
		statusEffects: ["Root"],
	},
];

export function makeDummyFighter(className: ClassName): Fighter {
	const stats: StatBlock = { hp: DUMMY_HP, atk: 10, dodge: 5, crit: 5 };
	const slots: SkillSlots = [
		calcSkillSlotRoll(1, 0.5),
		calcSkillSlotRoll(2, 0.5),
		calcSkillSlotRoll(3, 0.5),
	];
	return new Fighter({
		fighterId: className.lower(),
		hp: DUMMY_HP,
		hpMax: DUMMY_HP,
		stats,
		level: DUMMY_LEVEL,
		className,
		slots,
		skillData: DUMMY_SKILL_DATA,
		currentAtbSpeed: BASE_ATB_SPEED,
	});
}

export function createDummySide(rng: () => number): BattleSide {
	const fighters: FighterLineup = [
		makeDummyFighter("Fury"),
		makeDummyFighter("Menace"),
		makeDummyFighter("Dominator"),
	];
	return new BattleSide(fighters, rng);
}

/** Função de teste que monta um time (3 slots) com um lutador real (`jotaro` ou `anubis`). */
export function createRealFighterSide(
	fighterId: RealFighterId,
	rng: () => number,
	level = MIN_LEVEL,
): BattleSide {
	const fighters: FighterLineup = [
		makeRealFighter(fighterId, rng, level),
		makeRealFighter(fighterId, rng, level),
		makeRealFighter(fighterId, rng, level),
	];
	return new BattleSide(fighters, rng);
}

/** Função de teste que monta os dois lados da luta com Jotaro vs Anubis. */
export function createJotaroVsAnubisSides(
	rng: () => number,
	level = MIN_LEVEL,
): readonly [BattleSide, BattleSide] {
	return [createRealFighterSide("jotaro", rng, level), createRealFighterSide("anubis", rng, level)];
}

