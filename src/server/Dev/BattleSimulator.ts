// Ponto de entrada da suíte de testes e simulação do servidor (re-exporta validações públicas e executa runSimulation).
import {
	runDummy1000Battles,
	validateBronzeAI,
	validateCritDamageMultiplier,
	validateDayNightCycle,
	validateItemUuidLength,
	validateJotaroAndAnubis,
	validateMultiHitDeath,
	validatePauseAndQuitRules,
	validateSideTriggersRestrictions,
	validateSkillSlotValidation,
	validateStatusEffectRules,
	validateTokenBucketRateLimit,
	validateTrocarIndexValidation,
} from "./tests/coreTests";
import { validateNpcBattles, validateNpcRematchCooldown } from "./tests/npcTests";
import {
	validateCorruptionBackupAndInventory,
	validateLeavingDuringLoad,
	validateLoadGuardsAndInvalidLock,
	validatePlayerDataPersistence,
	validateSessionTokensAndConfirmations,
	validateSetRetryShutdownBudget,
} from "./tests/persistenceTests";
import {
	validateInventoryTestBattles,
	validatePostBattleXp,
	validateProgressionAndInventory,
	validateProgressionSnapshots,
	validateS3Unlock,
	validateTinyesEconomy,
	validateXpCurveAndTeamDistribution,
} from "./tests/progressionTests";
import { validatePvpBattles, validatePvpDailyXpAndMinimumFight } from "./tests/pvpTests";
import {
	validatePurchaseAndAllocationResults,
	validateShop,
	validateShopSynchronization,
} from "./tests/shopTests";
import {
	validateBattleTeardownLifecycle,
	validateCreateSessionRequiresPlayersParent,
	validateSessionErrorIsolation,
} from "./tests/teardownTests";

export { validateDayNightCycle } from "./tests/coreTests";
export { validateNpcBattles, validateNpcRematchCooldown } from "./tests/npcTests";
export { validatePostBattleXp, validateTinyesEconomy } from "./tests/progressionTests";
export { validatePvpBattles, validatePvpDailyXpAndMinimumFight } from "./tests/pvpTests";
export { validatePurchaseAndAllocationResults, validateShop } from "./tests/shopTests";
export { validateBattleTeardownLifecycle } from "./tests/teardownTests";

export function runSimulation(): void {
	validateMultiHitDeath();
	validateBattleTeardownLifecycle();
	validateDayNightCycle();
	validateNpcBattles();
	validateNpcRematchCooldown();
	validatePvpBattles();
	validatePvpDailyXpAndMinimumFight();
	validatePurchaseAndAllocationResults();
	validateShopSynchronization();
	validateShop();
	validatePostBattleXp();
	validateS3Unlock();
	validateProgressionSnapshots();
	validateInventoryTestBattles();
	validateTinyesEconomy();
	validateSetRetryShutdownBudget();
	validateLoadGuardsAndInvalidLock();
	validateLeavingDuringLoad();
	validateCorruptionBackupAndInventory();
	validateSessionTokensAndConfirmations();
	validateCritDamageMultiplier();
	validateStatusEffectRules();
	validatePauseAndQuitRules();
	validateBronzeAI();
	validateXpCurveAndTeamDistribution();
	validateProgressionAndInventory();
	validatePlayerDataPersistence();
	validateCreateSessionRequiresPlayersParent();
	validateSessionErrorIsolation();
	validateSkillSlotValidation();
	validateItemUuidLength();
	validateTokenBucketRateLimit();
	validateSideTriggersRestrictions();
	validateTrocarIndexValidation();
	runDummy1000Battles();
	validateJotaroAndAnubis();
}
