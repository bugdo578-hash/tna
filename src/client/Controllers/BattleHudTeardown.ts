import { battleCleanupStep } from "./BattleCleanup";
import type { CombatController } from "./CombatController";
import type { VFXController } from "./VFXController";

export interface BattleHudTeardownHost {
	readonly markBattleEnded: () => void;
	readonly getScreenGui: () => ScreenGui | undefined;
	readonly getResultScreenGui: () => ScreenGui | undefined;
	readonly getPauseOverlay: () => Frame | undefined;
	readonly getResultOverlay: () => Frame | undefined;
	readonly resetQuitConfirmState: () => void;
	readonly cancelQuitRetry: () => void;
	readonly clearHpTweens: () => void;
	readonly clearXpCards: () => void;
	readonly battleDisconnectors: (() => void)[];
	readonly consumeBattleVfxGeneration: () => number | undefined;
	readonly clearHudFighters: () => void;
	readonly getCombatController: () => CombatController | undefined;
	readonly getVfxController: () => VFXController | undefined;
}

/**
 * Executa o teardown completo da batalha no HUD, isolando cada etapa via `battleCleanupStep`
 * na mesma ordem original para impedir que uma falha bloqueie a limpeza dos demais recursos.
 */
export function runBattleHudTeardown(host: BattleHudTeardownHost, clearCurrentVfx = false): void {
	host.markBattleEnded();
	battleCleanupStep("hide HUD", () => {
		const screenGui = host.getScreenGui();
		if (screenGui !== undefined) screenGui.Enabled = false;
	});
	battleCleanupStep("hide result", () => {
		const resultScreenGui = host.getResultScreenGui();
		if (resultScreenGui !== undefined) resultScreenGui.Enabled = false;
	});
	battleCleanupStep("hide pause", () => {
		const pauseOverlay = host.getPauseOverlay();
		if (pauseOverlay !== undefined) pauseOverlay.Visible = false;
	});
	battleCleanupStep("hide result overlay", () => {
		const resultOverlay = host.getResultOverlay();
		if (resultOverlay !== undefined) resultOverlay.Visible = false;
	});
	battleCleanupStep("quit confirmation", () => host.resetQuitConfirmState());
	battleCleanupStep("quit retry", () => host.cancelQuitRetry());
	battleCleanupStep("HP tweens", () => host.clearHpTweens());
	battleCleanupStep("XP cards", () => host.clearXpCards());
	for (const disconnect of host.battleDisconnectors) {
		battleCleanupStep("HUD battle connection", disconnect);
	}
	host.battleDisconnectors.clear();
	const expectedVfxGeneration = clearCurrentVfx ? undefined : host.consumeBattleVfxGeneration();
	battleCleanupStep("HUD fighters", () => host.clearHudFighters());
	const combatController = host.getCombatController();
	if (combatController !== undefined) {
		battleCleanupStep("combat resources", () => combatController.cleanupStage(expectedVfxGeneration));
	} else {
		const vfxController = host.getVfxController();
		battleCleanupStep("vfx clear", () => vfxController?.clear());
	}
}
