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

const dayNightController = new DayNightController();
dayNightController.start();

const combatController = new CombatController();
combatController.start();

const battleHud = new BattleHUD(combatController);
battleHud.start();
