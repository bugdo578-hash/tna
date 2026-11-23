import { BASE_ATB_SPEED, MAX_ACTIVE_TEAM_SIZE, MIN_LEVEL } from "../../shared/Config";
import { findFighterDefinition, getFighterDefinition, rollClassBaseStats, type RealFighterId } from "../../shared/FighterData";
import { calcSkillSlotRoll } from "../../shared/MathUtils";
import { calcEffectiveStats } from "../../shared/ProgressionMath";
import type { FighterInventoryItem, SkillSlots } from "../../shared/TypeDefs";
import { BattleSide } from "../Components/BattleSide";
import { Fighter } from "../Components/Fighter";
import type { PlayerDataService } from "../Services/PlayerDataService";
import type { ProgressionService } from "../Services/ProgressionService";

/** Copia os rolls salvos; combate nunca compartilha estado mutável com o inventário. */
function makeInventoryFighter(item: FighterInventoryItem): Fighter | undefined {
	if (item.unavailable) return undefined;
	const definition = findFighterDefinition(item.fighterId);
	if (definition === undefined) return undefined;
	const stats = calcEffectiveStats(item.baseStats, item.allocatedStats);
	return new Fighter({
		itemUuid: item.itemUuid,
		fighterId: definition.fighterId,
		hp: stats.hp,
		hpMax: stats.hp,
		stats,
		level: item.level,
		className: definition.className,
		slots: [{ ...item.skills[0] }, { ...item.skills[1] }, { ...item.skills[2] }],
		skillData: definition.skills,
		currentAtbSpeed: BASE_ATB_SPEED,
		hamonConfig: definition.hamonConfig,
		isVampire: definition.isVampire,
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
		hamonConfig: definition.hamonConfig,
		isVampire: definition.isVampire,
	});
}

