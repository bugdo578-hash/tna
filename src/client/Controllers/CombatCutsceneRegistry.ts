import type { SkillSlot } from "../../shared/TypeDefs";
import { validateCutsceneDefinition } from "./CombatCutsceneFormat";
import type { CameraCutsceneDefinition, CutsceneSkillLookup } from "./CombatCutsceneTypes";

/** Gera a chave canônica `(fighterId, slot)` para cadastro de cutscenes opcionais. */
export function buildFighterSlotCutsceneKey(fighterId: string, slot: SkillSlot): string {
	return `${fighterId.lower()}:s${slot}`;
}

function normalizeSkillId(skillId: string): string {
	return skillId.lower();
}

/**
 * Catálogo client-side opcional de cutscenes de câmera por `(fighterId, slot)` ou por `skillId` estável.
 * Permanece vazio em produção até que cutscenes reais sejam cadastradas em lotes futuros.
 */
export class CombatCutsceneRegistry {
	private readonly byFighterSlot = new Map<string, CameraCutsceneDefinition>();
	private readonly bySkillId = new Map<string, CameraCutsceneDefinition>();

	public registerByFighterSlot(
		fighterId: string,
		slot: SkillSlot,
		definition: CameraCutsceneDefinition,
	): boolean {
		if (fighterId.size() === 0) {
			warn("[CombatCutsceneRegistry] fighterId vazio ao registrar cutscene.");
			return false;
		}
		const validation = validateCutsceneDefinition(definition);
		if (!validation.ok) {
			warn(`[CombatCutsceneRegistry] Cutscene inválida para ${fighterId} S${slot}: ${validation.reason ?? "desconhecido"}`);
			return false;
		}
		const key = buildFighterSlotCutsceneKey(fighterId, slot);
		this.byFighterSlot.set(key, {
			...definition,
			id: definition.id ?? key,
			keyframes: validation.keyframes!,
		});
		return true;
	}

	public registerBySkillId(skillId: string, definition: CameraCutsceneDefinition): boolean {
		if (skillId.size() === 0) {
			warn("[CombatCutsceneRegistry] skillId vazio ao registrar cutscene.");
			return false;
		}
		const validation = validateCutsceneDefinition(definition);
		if (!validation.ok) {
			warn(`[CombatCutsceneRegistry] Cutscene inválida para skill "${skillId}": ${validation.reason ?? "desconhecido"}`);
			return false;
		}
		const key = normalizeSkillId(skillId);
		this.bySkillId.set(key, {
			...definition,
			id: definition.id ?? skillId,
			keyframes: validation.keyframes!,
		});
		return true;
	}

	public unregisterByFighterSlot(fighterId: string, slot: SkillSlot): void {
		this.byFighterSlot.delete(buildFighterSlotCutsceneKey(fighterId, slot));
	}

	public unregisterBySkillId(skillId: string): void {
		this.bySkillId.delete(normalizeSkillId(skillId));
	}

	public clear(): void {
		this.byFighterSlot.clear();
		this.bySkillId.clear();
	}

	/**
	 * Resolve a cutscene cadastrada para um ataque.
	 * Prioridade: cadastro específico `(fighterId, slot)` -> cadastro por `skillId` estável.
	 */
	public resolve(query: CutsceneSkillLookup): CameraCutsceneDefinition | undefined {
		const slotKey = buildFighterSlotCutsceneKey(query.fighterId, query.slot);
		const bySlot = this.byFighterSlot.get(slotKey);
		if (bySlot !== undefined) return bySlot;

		if (query.skillId !== undefined && query.skillId.size() > 0) {
			return this.bySkillId.get(normalizeSkillId(query.skillId));
		}
		return undefined;
	}

	public getRegisteredCount(): number {
		return this.byFighterSlot.size() + this.bySkillId.size();
	}
}

/** Instância padrão de produção (vazia neste lote — sem cutscenes falsas nem placeholders). */
export const defaultCombatCutsceneRegistry = new CombatCutsceneRegistry();
