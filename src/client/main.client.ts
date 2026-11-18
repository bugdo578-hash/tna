import { InventoryController } from "./Controllers/InventoryController";
import { ShopController } from "./Controllers/ShopController";
let shop: ShopController | undefined;
const inventory = new InventoryController(() => shop?.close(), (open) => shop?.setInventoryOpen(open));
inventory.start();
shop = new ShopController(() => inventory.close());
shop.start();

import "./UI/TinyesDisplay";
import "./Controllers/BattleRemotes";
import "./Controllers/BattleNpcController";
import { BattleHUD } from "./Controllers/BattleHUD";
import { CombatController } from "./Controllers/CombatController";
import { DayNightController } from "./Controllers/DayNightController";
import { PvpController } from "./Controllers/PvpController";
import { ChallengePromptController } from "./Controllers/ChallengePromptController";
import { CharacterAnimationController } from "./Controllers/CharacterAnimationController";
import { VFXController } from "./Controllers/VFXController";

new CharacterAnimationController().start();

const challengePromptController = new ChallengePromptController();
challengePromptController.start();

const dayNightController = new DayNightController();
dayNightController.start();

const pvpController = new PvpController();
pvpController.start();

const vfxController = new VFXController();
vfxController.start();

const combatController = new CombatController(vfxController);
combatController.start();

const battleHud = new BattleHUD(combatController, vfxController);
battleHud.start();
