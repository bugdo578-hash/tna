import { BASE_ATB_SPEED, DEV_OPPONENT_SEED, MAX_ACTIVE_TEAM_SIZE, MIN_LEVEL } from "../../shared/Config";
import { getFighterDefinition, rollClassBaseStats, type RealFighterId } from "../../shared/FighterData";
import { calcSkillSlotRoll } from "../../shared/MathUtils";
import { calcEffectiveStats } from "../../shared/ProgressionMath";
import type { SkillDataSlots } from "../../shared/SkillData";
import type { ClassName, FighterInventoryItem, SkillSlots, StatBlock } from "../../shared/TypeDefs";
import { BattleSide, type FighterLineup } from "../Components/BattleSide";
import { Fighter } from "../Components/Fighter";
import type { PlayerDataService } from "../Services/PlayerDataService";
import type { ProgressionService } from "../Services/ProgressionService";

const DUMMY_HP = 100;
const DUMMY_LEVEL = 10;

/** Copia os rolls salvos; combate nunca compartilha estado mutável com o inventário. */
function makeInventoryFighter(item: FighterInventoryItem): Fighter | undefined {
	if (item.unavailable || (item.fighterId !== "jotaro" && item.fighterId !== "anubis")) return undefined;
	const definition = getFighterDefinition(item.fighterId);
	const stats = calcEffectiveStats(item.baseStats, item.allocatedStats);
	return new Fighter({
		itemUuid: item.itemUuid,
		fighterId: item.fighterId,
		hp: stats.hp,
		hpMax: stats.hp,
		stats,
		level: item.level,
		className: definition.className,
		slots: [{ ...item.skills[0] }, { ...item.skills[1] }, { ...item.skills[2] }],
		skillData: definition.skills,
		currentAtbSpeed: BASE_ATB_SPEED,
	});
}

/** Usa somente os UUIDs selecionados, na ordem de activeTeam, sem completar vagas. */
export function createPlayerInventorySide(
	player: Player,
	progressionService: ProgressionService,
	playerDataService: PlayerDataService,
	rng: () => number,
): BattleSide | undefined {
	const activeTeam = playerDataService.getActiveTeam(player);
	if (activeTeam === undefined) return undefined;
	const fighters: Fighter[] = [];
	for (const itemUuid of activeTeam) {
		if (fighters.size() >= MAX_ACTIVE_TEAM_SIZE) break;
		const item = progressionService.getFighter(player, itemUuid);
		const fighter = item !== undefined ? makeInventoryFighter(item) : undefined;
		if (fighter !== undefined) fighters.push(fighter);
	}
	const first = fighters[0] as Fighter | undefined;
	if (first === undefined) return undefined;
	return new BattleSide([first, ...fighters.filter((_, index) => index > 0)], rng);
}

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

/**
 * Cria uma instância de lutador real (`jotaro` ou `anubis`):
 * - `baseStats` vêm do roll da classe (`ClassData`).
 * - Custo e multiplicador de cada slot vêm de `calcSkillSlotRoll`.
 */
export function makeRealFighter(fighterId: RealFighterId, rng: () => number, level = MIN_LEVEL): Fighter {
	const definition = getFighterDefinition(fighterId);
	const baseStats = rollClassBaseStats(definition.className, rng);
	const slots: SkillSlots = [
		calcSkillSlotRoll(1, rng()),
		calcSkillSlotRoll(2, rng()),
		calcSkillSlotRoll(3, rng()),
	];
	return new Fighter({
		fighterId: definition.fighterId,
		hp: baseStats.hp,
		hpMax: baseStats.hp,
		stats: baseStats,
		level,
		className: definition.className,
		slots,
		skillData: definition.skills,
		currentAtbSpeed: BASE_ATB_SPEED,
	});
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

