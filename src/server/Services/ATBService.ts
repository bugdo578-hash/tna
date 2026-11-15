import { ATB_MAX, ATB_MIN } from "../../shared/Config";
import { clamp } from "../../shared/MathUtils";
import type { BattleSide } from "../Components/BattleSide";

export class ATBService {
	public tick(side: BattleSide, dt: number): void {
		const fighter = side.getActiveFighter();
		if (!fighter.isAlive() || fighter.localState !== "NORMAL") return;
		side.setAtb(clamp(side.atb + fighter.currentAtbSpeed * math.max(dt, 0), ATB_MIN, ATB_MAX));
	}
}
