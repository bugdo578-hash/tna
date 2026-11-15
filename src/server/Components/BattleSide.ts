import { ATB_MAX, ATB_MIN } from "../../shared/Config";
import type { Fighter } from "./Fighter";

export type FighterIndex = 0 | 1 | 2;
export type FighterLineup = readonly [Fighter, ...Fighter[]];

export class BattleSide {
	atb = ATB_MIN;
	activeIndex: FighterIndex;
	readonly fighters: FighterLineup;

	public constructor(fighters: FighterLineup, rng: () => number, activeIndex: FighterIndex = 0) {
		this.fighters = fighters;
		this.activeIndex = fighters[activeIndex].isAlive() ? activeIndex : (this.findRandomLivingIndex(rng) ?? activeIndex);
	}

	public getActiveFighter(): Fighter {
		return this.fighters[this.activeIndex];
	}

	public trocar(index: FighterIndex): boolean {
		if (!(index >= 0 && index < this.fighters.size()) || math.floor(index) !== index) return false;
		const target = this.fighters[index] as Fighter | undefined;
		if (target === undefined || !target.isAlive()) return false;
		if (this.getActiveFighter().isRooted()) return false;
		if (index === this.activeIndex) return false;
		this.activeIndex = index;
		return true;
	}

	public isDefeated(): boolean {
		return this.fighters.every((fighter) => !fighter.isAlive());
	}

	public onActiveFighterDeath(rng: () => number): FighterIndex | undefined {
		if (this.getActiveFighter().isAlive()) return undefined;
		const nextIndex = this.findRandomLivingIndex(rng);
		this.atb = ATB_MIN;
		if (nextIndex !== undefined) this.activeIndex = nextIndex;
		return nextIndex;
	}

	public resetAtb(): void {
		this.atb = ATB_MIN;
	}

	public setAtb(value: number): void {
		this.atb = math.min(math.max(value, ATB_MIN), ATB_MAX);
	}

	private findRandomLivingIndex(rng: () => number): FighterIndex | undefined {
		const living: FighterIndex[] = [];
		for (const index of $range(0, this.fighters.size() - 1)) {
			const fighterIndex = index as FighterIndex;
			if (this.fighters[fighterIndex].isAlive()) living.push(fighterIndex);
		}
		if (living.size() === 0) return undefined;
		const roll = math.min(math.max(rng(), 0), 1);
		const choice = math.min(math.floor(roll * living.size()), living.size() - 1);
		return living[choice];
	}
}
