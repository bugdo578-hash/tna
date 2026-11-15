import "./UI/TinyesDisplay";
import "./Controllers/BattleRemotes";
import { BattleHUD } from "./Controllers/BattleHUD";
import { CombatController } from "./Controllers/CombatController";

const combatController = new CombatController();
combatController.start();

const battleHud = new BattleHUD(combatController);
battleHud.start();
