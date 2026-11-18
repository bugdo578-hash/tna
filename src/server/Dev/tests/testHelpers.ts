// Helpers, constantes, RNG determinístico e mocks compartilhados pela suíte de testes do servidor.
import { doesClassCounter } from "../../../shared/ClassData";
import { ATB_MAX, ATB_MIN, MIN_LEVEL, S3_UNLOCK_LEVEL } from "../../../shared/Config";
import { calcXpForNextLevel } from "../../../shared/ProgressionMath";
import type { BattleEndedPayload, BattleStartedPayload } from "../../../shared/Remotes";
import type { BattleGlobalState, FighterInventoryItem, SkillSlot } from "../../../shared/TypeDefs";
import { BattleSide, type FighterIndex } from "../../Components/BattleSide";
import { Fighter } from "../../Components/Fighter";
import { BattleService } from "../../Services/BattleService";
import { InMemoryDataStore } from "../../Services/PlayerDataValidation";
import { ProgressionService } from "../../Services/ProgressionService";
import type { BattleRemoteAdapter } from "../../Services/RemoteService";
import { createDummySide } from "../DummyFighters";

export const SIMULATION_DT = 0.05;
export const SIMULATION_COUNT = 1000;
export const FIRST_SIMULATION_SEED = 20261112;
export const MAX_SIMULATION_STEPS = 200000;
export const MIN_HIT_DAMAGE = 1;
export const LOW_HP_SWITCH_RATIO = 0.3;
export const SWITCH_COOLDOWN_STEPS = 120;
export const SLOT_1_PROBABILITY = 0.4;
export const SLOT_2_CUMULATIVE_PROBABILITY = 0.75;

export interface SimulationResult {
	readonly winner: BattleSide;
	readonly winnerIndex: 0 | 1;
	readonly duration: number;
	readonly damageBySide: readonly [number, number];
}

export function createSeededRng(initialSeed: number): () => number {
	let seed = initialSeed;
	const nextRandom = (): number => {
		seed = (seed * 48271) % 2147483647;
		return seed / 2147483647;
	};
	nextRandom();
	nextRandom();
	return nextRandom;
}

export function assertInvariant(condition: boolean, message: string): void {
	if (!condition) error(`BattleSimulator assertion failed: ${message}`);
}

export function isPausedState(state: BattleGlobalState): boolean {
	return state === "PREPARE" || state === "ATTACK" || state === "RETURN";
}

export function formatSide(side: BattleSide, firstSide: BattleSide): string {
	return side === firstSide ? "A" : "B";
}

export function pickNextSlot(rng: () => number): SkillSlot {
	const roll = rng();
	if (roll < SLOT_1_PROBABILITY) return 1;
	if (roll < SLOT_2_CUMULATIVE_PROBABILITY) return 2;
	return 3;
}

export function findBestSwitchIndex(side: BattleSide, enemyActive: Fighter): FighterIndex | undefined {
	const active = side.getActiveFighter();
	const isLowHp = active.hp <= active.hpMax * LOW_HP_SWITCH_RATIO;
	const isCountered = doesClassCounter(enemyActive.className, active.className);
	if (!isLowHp && !isCountered) return undefined;

	let bestCounterIndex: FighterIndex | undefined;
	let bestHealthyIndex: FighterIndex | undefined;

	for (const index of $range(0, 2)) {
		const candidateIndex = index as FighterIndex;
		if (candidateIndex === side.activeIndex) continue;
		const candidate = side.fighters[candidateIndex];
		if (!candidate.isAlive() || candidate.hp <= candidate.hpMax * LOW_HP_SWITCH_RATIO) continue;

		if (doesClassCounter(candidate.className, enemyActive.className)) {
			bestCounterIndex = candidateIndex;
			break;
		}
		if (!doesClassCounter(enemyActive.className, candidate.className) && candidate.hp > active.hp) {
			bestHealthyIndex = candidateIndex;
		}
	}

	if (bestCounterIndex !== undefined) return bestCounterIndex;
	if (isLowHp && bestHealthyIndex !== undefined) return bestHealthyIndex;
	return undefined;
}


export function runBattleWithSides(
	firstSide: BattleSide,
	secondSide: BattleSide,
	rng: () => number,
	verbose: boolean,
): SimulationResult {
	const sides: readonly [BattleSide, BattleSide] = [firstSide, secondSide];
	const battle = new BattleService(firstSide, secondSide, rng);
	const damageBySide: [number, number] = [0, 0];
	const deathInStep: [boolean, boolean] = [false, false];
	const plannedSlots: [SkillSlot, SkillSlot] = [pickNextSlot(rng), pickNextSlot(rng)];
	const lastSwitchStep: [number, number] = [-SWITCH_COOLDOWN_STEPS, -SWITCH_COOLDOWN_STEPS];
	let winner: BattleSide | undefined;
	let duration = 0;

	battle.events.state.connect((state) => {
		assertInvariant(winner === undefined, `mudança de estado (${state}) após o fim da luta`);
		if (verbose) print(`estado: ${state}`);
	});

	battle.events.attackStarted.connect(({ attacker, target, slot }) => {
		assertInvariant(attacker.isAlive(), "lutador morto iniciou um ataque");
		if (verbose) print(`attackStarted: ${attacker.fighterId} (${attacker.className}) S${slot} -> ${target.fighterId} (${target.className})`);
	});

	battle.events.hitResolved.connect(({ hitIndex, hit, crit, damage, target, followUpCancelled }) => {
		assertInvariant(hitIndex >= 1, "hitIndex deve começar em 1");
		if (hit) {
			assertInvariant(damage >= MIN_HIT_DAMAGE, "dano de acerto abaixo do mínimo");
			assertInvariant(!followUpCancelled, "acerto não pode cancelar follow-up");
		} else {
			assertInvariant(!crit && damage === 0, "hit esquivado não pode ser crítico nem causar dano");
		}
		const targetSideIndex = sides[0].fighters.includes(target) ? 0 : 1;
		damageBySide[1 - targetSideIndex] += damage;
		if (verbose) {
			print(
				`hitResolved: hitIndex=${hitIndex}, hit=${hit}, crit=${crit}, damage=${damage}, followUpCancelled=${followUpCancelled}, target=${target.fighterId}`,
			);
		}
	});

	battle.events.effectApplied.connect(({ side, target, effect, duration: effectDuration, totalDamage, renewed }) => {
		assertInvariant(target.isAlive() && target.localState !== "CAIDO", "efeito aplicado em lutador caído");
		assertInvariant(target.hasStatusEffect(effect), "efeito aplicado não consta no lutador");
		assertInvariant(target.statusEffects.size() <= 3, "efeitos empilharam indevidamente");
		if (effect === "Bleed" || effect === "Burn") {
			assertInvariant(totalDamage > 0, "DoT aplicado sem dano real");
		}
		if (verbose) {
			print(
				`effectApplied: lado ${formatSide(side, firstSide)}, ${target.fighterId} [${effect}] dur=${effectDuration}s renewed=${renewed}`,
			);
		}
	});

	battle.events.effectTick.connect(({ side, target, effect, damage, remainingTicks }) => {
		assertInvariant(battle.state === "IDLE", `DoT rodou fora de IDLE (${battle.state})`);
		assertInvariant(damage >= MIN_HIT_DAMAGE, "tick de DoT nunca pode ser 0");
		const targetSideIndex = side === firstSide ? 0 : 1;
		damageBySide[1 - targetSideIndex] += damage;
		if (verbose) {
			print(
				`effectTick: lado ${formatSide(side, firstSide)}, ${target.fighterId} [${effect}] dmg=${damage} restam=${remainingTicks}`,
			);
		}
	});

	battle.events.effectExpired.connect(({ side, target, effect }) => {
		assertInvariant(!target.hasStatusEffect(effect), "efeito expirado permaneceu no lutador");
		if (verbose) {
			print(`effectExpired: lado ${formatSide(side, firstSide)}, ${target.fighterId} [${effect}]`);
		}
	});

	battle.events.death.connect(({ side, fighter, nextActive }) => {
		const sideIndex = side === firstSide ? 0 : 1;
		deathInStep[sideIndex] = true;
		plannedSlots[sideIndex] = pickNextSlot(rng);
		assertInvariant(side.atb === 0, "ATB não zerou após a morte");
		if (!side.isDefeated()) {
			assertInvariant(
				(battle.state === "ATTACK" && nextActive === undefined && side.getActiveFighter() === fighter) ||
				(nextActive !== undefined && nextActive.isAlive() && side.getActiveFighter() === nextActive),
				"troca automática por morte falhou (deve ignorar Root)",
			);
		}
		if (verbose) print(`morte: lado ${formatSide(side, firstSide)}, ${fighter.fighterId}; próximo=${nextActive?.fighterId ?? "nenhum"}`);
	});

	battle.events.battleEnd.connect((winningSide) => {
		assertInvariant(winningSide !== undefined, "luta terminou sem vencedor");
		if (winningSide === undefined) return;
		winner = winningSide;
		if (verbose) print(`fim: vencedor lado ${formatSide(winningSide, firstSide)}`);
	});

	for (let stepIndex = 0; stepIndex < MAX_SIMULATION_STEPS && winner === undefined; stepIndex++) {
		if (battle.state === "IDLE") {
			const firstDecisionIndex = rng() < 0.5 ? 0 : 1;
			for (let offset = 0; offset < sides.size(); offset++) {
				const sideIndex = (firstDecisionIndex + offset) % sides.size();
				const side = sides[sideIndex];
				const enemySide = sides[1 - sideIndex];
				if (side.isDefeated() || enemySide.isDefeated()) continue;

				if (stepIndex - lastSwitchStep[sideIndex] >= SWITCH_COOLDOWN_STEPS) {
					const switchIndex = findBestSwitchIndex(side, enemySide.getActiveFighter());
					if (switchIndex !== undefined) {
						const previousFighter = side.getActiveFighter();
						const wasRooted = previousFighter.isRooted();
						const switched = battle.requestSwitch(side, switchIndex);
						if (wasRooted) {
							assertInvariant(!switched, "Root falhou em bloquear a troca");
						} else if (switched) {
							lastSwitchStep[sideIndex] = stepIndex;
							if (verbose) {
								print(
									`troca: lado ${formatSide(side, firstSide)}, ${previousFighter.fighterId} -> ${side.getActiveFighter().fighterId}`,
								);
							}
						}
					}
				}

				if (plannedSlots[sideIndex] === 3 && side.getActiveFighter().level < S3_UNLOCK_LEVEL) {
					plannedSlots[sideIndex] = rng() < SLOT_1_PROBABILITY / SLOT_2_CUMULATIVE_PROBABILITY ? 1 : 2;
				}
				const targetSlot = plannedSlots[sideIndex];
				const requiredAtb = side.getActiveFighter().slots[targetSlot - 1].cost;
				if (side.atb >= requiredAtb && battle.requestSkill(side, targetSlot)) {
					plannedSlots[sideIndex] = pickNextSlot(rng);
					break;
				}
			}
		}

		deathInStep[0] = false;
		deathInStep[1] = false;
		const previousAtb: [number, number] = [firstSide.atb, secondSide.atb];
		battle.step(SIMULATION_DT);
		duration += SIMULATION_DT;

		for (let sideIndex = 0; sideIndex < sides.size(); sideIndex++) {
			const side = sides[sideIndex];
			assertInvariant(side.atb >= ATB_MIN && side.atb <= ATB_MAX, "ATB saiu do intervalo permitido");
			if (deathInStep[sideIndex]) {
				assertInvariant(side.atb === 0, "ATB do lado do morto diferente de 0 após a morte");
			} else if (isPausedState(battle.state)) {
				assertInvariant(side.atb === previousAtb[sideIndex], `ATB mudou durante ${battle.state}`);
			}
		}
	}

	if (winner === undefined) error("BattleSimulator assertion failed: luta excedeu o limite de passos");
	return { winner, winnerIndex: winner === firstSide ? 0 : 1, duration, damageBySide };
}

export function runBattle(seed: number, verbose: boolean): SimulationResult {
	const rng = createSeededRng(seed);
	const firstSide = createDummySide(rng);
	const secondSide = createDummySide(rng);
	return runBattleWithSides(firstSide, secondSide, rng, verbose);
}


/** Contador de chamadas a `addXp` para provar que inelegibilidade não distribuem XP. */
export class SpyProgressionService extends ProgressionService {
	public addXpCalls = 0;

	public override addXp(player: Player, itemUuid: string, amount: number): FighterInventoryItem | undefined {
		this.addXpCalls += 1;
		return super.addXp(player, itemUuid, amount);
	}
}

export function xpToReach(level: number): number {
	let total = 0;
	for (const current of $range(MIN_LEVEL, level - 1)) total += calcXpForNextLevel(current);
	return total;
}

export function assertStoredEqual(actual: unknown, expected: unknown, message: string): void {
	if (typeOf(actual) !== "table" || typeOf(expected) !== "table") {
		assertInvariant(actual === expected, message);
		return;
	}
	const a = actual as Record<string, unknown>;
	const b = expected as Record<string, unknown>;
	for (const [key, value] of pairs(a)) assertStoredEqual(value, b[key as string], message);
	for (const [key] of pairs(b)) assertInvariant(a[key as string] !== undefined, message);
}

export function findBackupKey(store: InMemoryDataStore, timestamp: number, previousKeys: ReadonlySet<string>): string {
	const prefix = `C_${timestamp}_`;
	const keys = store.getKeysForTest().filter((key) => key.sub(1, prefix.size()) === prefix && !previousKeys.has(key));
	assertInvariant(keys.size() === 1, "deve existir exatamente um novo backup para este cenário");
	return keys[keys.size() - 1];
}

export interface SurgicalAdapterHooks {
	readonly onBattleStarted?: (player: Player, payload: BattleStartedPayload) => void;
	readonly onBattleEnded?: (player: Player, payload: BattleEndedPayload) => void;
	readonly onEffectTick?: (player: Player) => void;
	readonly onAtbSync?: (player: Player) => void;
}

export function createSurgicalMockAdapter(hooks: SurgicalAdapterHooks): BattleRemoteAdapter {
	return {
		bindRequests() {},
		forgetPlayer() {},
		sendBattleStarted(player, payload) {
			hooks.onBattleStarted?.(player, payload);
		},
		sendStateChanged() {},
		sendSwitchPerformed() {},
		sendAttackStarted() {},
		sendHitResolved() {},
		sendEffectApplied() {},
		sendEffectTick(player) {
			hooks.onEffectTick?.(player);
		},
		sendEffectExpired() {},
		sendFighterDied() {},
		sendBattleEnded(player, payload) {
			hooks.onBattleEnded?.(player, payload);
		},
		sendAtbSync(player) {
			hooks.onAtbSync?.(player);
		},
	};
}

export interface RemoteServiceTestInternals {
	consumeRequest(player: Player): boolean;
	readSkillSlot(payload: unknown): SkillSlot | undefined;
}
