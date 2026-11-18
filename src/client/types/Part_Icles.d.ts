/** Tipagem da API pública do módulo externo `ReplicatedStorage.Part_Icles` (Qwinkle's Part-Icles). */
export interface PartIclesApi {
	MAX_ACTIVE_PARTICLES: number;
	Activate(this: PartIclesApi): void;
	Preload(this: PartIclesApi, root: Instance, force?: boolean): void;
	Deload(this: PartIclesApi, root: Instance, force?: boolean): void;
	AbsoluteEmit(this: PartIclesApi, item: Instance, parentFiredPE?: boolean, emitCtx?: unknown): number | undefined;
	AbsoluteDisable(this: PartIclesApi, item: Instance, parentCovered?: boolean): void;
}
