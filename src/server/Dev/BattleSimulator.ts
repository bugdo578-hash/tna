// Ponto de entrada da suíte de testes e simulação do servidor (re-exporta validações públicas e executa runSimulation).
import { validateArenaPlayerTransportL3 } from "./tests/arenaPlayerTransportTests";
import { validateArenaRegistry } from "./tests/arenaRegistryTests";
import { validateArenaSelectionL16 } from "./tests/arenaSelectionTests";
import { validateBattlePreparation } from "./tests/battlePreparationTests";
import { validateDamageAuditSlotsHamonMultihit } from "./tests/damageAuditTests";
import { validateN1DotSessions, validateN1DotSkillTimeline, validateN1DotTicks } from "./tests/dotN1Tests";
import { validateN2HamonSystem } from "./tests/hamonN2Tests";
import { validateJonathanN31 } from "./tests/jonathanN31Tests";
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
import {
	validateLotMA05AtbBenchDeath,
	validateLotMC06RateLimitBoundaries,
	validateLotMFighterRegistry,
} from "./tests/lotMTests";
import { validateNpcBattles, validateNpcRematchCooldown } from "./tests/npcTests";
import {
	validateJsonRoundTripPersistence,
	validateLoadExhaustionKick,
} from "./tests/dataStoreIntegrityTests";
import {
	validateCorruptionBackupAndInventory,
	validateLeavingDuringLoad,
	validateLoadGuardsAndInvalidLock,
	validatePlayerDataPersistence,
	validateSessionTokensAndConfirmations,
	validateSetRetryShutdownBudget,
	validateSlowAutosaveLogoutRetry,
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
import { validatePvpBattles, validatePvpDailyXpAndMinimumFight, validatePvpPairAntiFarmWithTinyesCap } from "./tests/pvpTests";
import { validatePvpSideAlternationL21 } from "./tests/pvpSideAlternationTests";
import {
	validatePurchaseAndAllocationResults,
	validateShop,
	validateShopSynchronization,
} from "./tests/shopTests";
import { validateSkillRegistry } from "./tests/skillRegistryTests";
import { validateStarFinger } from "./tests/starFingerTests";
import {
	validateBattleTeardownLifecycle,
	validateQuitRequestRateLimit,
	validateCreateSessionRequiresPlayersParent,
	validateSessionErrorIsolation,
} from "./tests/teardownTests";

export { validateArenaPlayerTransportL3 } from "./tests/arenaPlayerTransportTests";
export { validateArenaRegistry } from "./tests/arenaRegistryTests";
export { validateArenaSelectionL16 } from "./tests/arenaSelectionTests";
export {
	validateLotMA05AtbBenchDeath,
	validateLotMC06RateLimitBoundaries,
	validateLotMFighterRegistry,
} from "./tests/lotMTests";
export { validateDayNightCycle } from "./tests/coreTests";
export { validateNpcBattles, validateNpcRematchCooldown } from "./tests/npcTests";
export { validatePostBattleXp, validateTinyesEconomy } from "./tests/progressionTests";
export { validatePvpBattles, validatePvpDailyXpAndMinimumFight, validatePvpPairAntiFarmWithTinyesCap } from "./tests/pvpTests";
export { validatePvpSideAlternationL21 } from "./tests/pvpSideAlternationTests";
export { validatePurchaseAndAllocationResults, validateShop } from "./tests/shopTests";
export { validateStarFinger } from "./tests/starFingerTests";
export { validateN2HamonSystem } from "./tests/hamonN2Tests";
export { validateBattleTeardownLifecycle } from "./tests/teardownTests";
export { validateQuitRequestRateLimit } from "./tests/teardownTests";
export { validateSlowAutosaveLogoutRetry } from "./tests/persistenceTests";
export { validateJsonRoundTripPersistence, validateLoadExhaustionKick } from "./tests/dataStoreIntegrityTests";

export function runSimulation(): void {
	validateDamageAuditSlotsHamonMultihit();
	validateJonathanN31();
	validateBattlePreparation();
	validateSkillRegistry();
	validateStarFinger();
	validateMultiHitDeath();
	validateBattleTeardownLifecycle();
	validateQuitRequestRateLimit();
	validateDayNightCycle();
	validateNpcBattles();
	validateNpcRematchCooldown();
	validatePvpBattles();
	validatePvpDailyXpAndMinimumFight();
	validatePvpPairAntiFarmWithTinyesCap();
	validatePurchaseAndAllocationResults();
	validateShopSynchronization();
	validateShop();
	validatePostBattleXp();
	validateS3Unlock();
	validateProgressionSnapshots();
	validateInventoryTestBattles();
	validateTinyesEconomy();
	validateSetRetryShutdownBudget();
	validateSlowAutosaveLogoutRetry();
	validateLoadExhaustionKick();
	validateJsonRoundTripPersistence();
	validateLoadGuardsAndInvalidLock();
	validateLeavingDuringLoad();
	validateCorruptionBackupAndInventory();
	validateSessionTokensAndConfirmations();
	validateCritDamageMultiplier();
	validateStatusEffectRules();
	validateN1DotSkillTimeline();
	validateN1DotTicks();
	validateN1DotSessions();
	validateN2HamonSystem();
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
	validateArenaRegistry();
	validateArenaSelectionL16();
	validatePvpSideAlternationL21();
	validateArenaPlayerTransportL3();
	validateLotMA05AtbBenchDeath();
	validateLotMC06RateLimitBoundaries();
	validateLotMFighterRegistry();
	print("SIMULATION_ALL_PASSED");
}
