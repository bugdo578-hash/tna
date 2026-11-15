import {
	DAY_NIGHT_ATTRIBUTES,
	DAY_NIGHT_DEFAULT_DURATION_SECONDS,
	DAY_NIGHT_DEFAULT_START_HOUR,
	DAY_NIGHT_EFFECT_PROPERTIES,
	DAY_NIGHT_EPSILON,
	DAY_NIGHT_LIGHTING_PROPERTIES,
	DAY_NIGHT_MIN_DURATION_SECONDS,
	DAY_NIGHT_SKY_FACE_PROPERTIES,
	DAY_NIGHT_SKY_NUMBER_PROPERTIES,
} from "./Config";

interface NumberBinding {
	readonly instance: unknown;
	readonly property: string;
	readonly day: number;
	readonly night: number;
	lastValue: number;
	readonly integer: boolean;
}

interface ColorBinding {
	readonly instance: unknown;
	readonly property: string;
	readonly day: Color3;
	readonly night: Color3;
}

interface GeneralBinding {
	readonly instance: unknown;
	readonly property: string;
	readonly day: unknown;
	readonly night: unknown;
	readonly valueType: string;
}

export interface DayNightWorkspaceLike {
	GetAttribute(name: string): AttributeValue | undefined;
}

export interface DayNightLightingLike {
	ClockTime: number;
	GlobalShadows: boolean;
	GetChildren(): Instance[];
	adoptEffect?(effect: Instance): void;
}

const HOURS_PER_DAY = 24;
const INITIAL_NUMBER_SENTINEL = -1e9;

function isFiniteNumber(value: unknown): value is number {
	return typeIs(value, "number") && value === value && value !== math.huge && value !== -math.huge;
}

function getInstanceProperty(target: unknown, property: string): unknown {
	return (target as Record<string, unknown>)[property];
}

function setInstanceProperty(target: unknown, property: string, value: unknown): void {
	(target as Record<string, unknown>)[property] = value;
}

function findChildByClass(container: { GetChildren(): Instance[] }, className: string): Instance | undefined {
	for (const child of container.GetChildren()) {
		if (child.ClassName === className) return child;
	}
	return undefined;
}

function attachChild(lighting: DayNightLightingLike, child: Instance): void {
	if (typeIs(lighting, "Instance")) {
		child.Parent = lighting;
	} else {
		lighting.adoptEffect?.(child);
	}
}

function getOrCreateLightingEffect(lighting: DayNightLightingLike, dayTemplate: Instance): Instance {
	let sameClassFallback: Instance | undefined;
	for (const obj of lighting.GetChildren()) {
		if (obj.ClassName === dayTemplate.ClassName) {
			if (obj.Name === dayTemplate.Name) return obj;
			sameClassFallback ??= obj;
		}
	}
	if (sameClassFallback !== undefined) return sameClassFallback;

	const clone = dayTemplate.Clone();
	attachChild(lighting, clone);
	return clone;
}

/** Normaliza qualquer hora finita para o intervalo `[0, 24)`. */
export function normalizeCycleHour(hour: number): number {
	if (!isFiniteNumber(hour)) return DAY_NIGHT_DEFAULT_START_HOUR;
	const wrapped = ((hour % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
	if (wrapped >= HOURS_PER_DAY || wrapped === 0) return 0;
	return wrapped;
}

/** Quintic smoothstep (C2 contínuo) restrito ao intervalo `[0, 1]`. */
export function smoothstepQuintic(x: number): number {
	if (x !== x) return 0;
	const c = math.min(math.max(x, 0), 1);
	return c * c * c * (c * (c * 6 - 15) + 10);
}

/** Fator `t` de transição dia→noite (`0` = pleno dia, `1` = plena noite). */
export function calcNightAlpha(hour: number): number {
	const h = normalizeCycleHour(hour);
	if (h >= 8 && h < 16) return 0;
	if (h >= 16 && h < 20) return smoothstepQuintic((h - 16) * 0.25);
	if (h >= 20 || h < 4) return 1;
	return 1 - smoothstepQuintic((h - 4) * 0.25);
}

/** Calcula a hora solar atual `[0, 24)` a partir da hora inicial, tempo decorrido e duração do ciclo. */
export function calcSolarHour(startHour: number, elapsedSeconds: number, cycleDurationSeconds: number): number {
	const safeStart = isFiniteNumber(startHour) ? startHour : DAY_NIGHT_DEFAULT_START_HOUR;
	const safeElapsed = isFiniteNumber(elapsedSeconds) ? elapsedSeconds : 0;
	const safeDuration = isFiniteNumber(cycleDurationSeconds)
		? math.max(DAY_NIGHT_MIN_DURATION_SECONDS, cycleDurationSeconds)
		: DAY_NIGHT_DEFAULT_DURATION_SECONDS;
	return normalizeCycleHour(safeStart + (safeElapsed * HOURS_PER_DAY) / safeDuration);
}

/** Interpolação de cor em espaço Gamma 2.0 (evita tons acinzentados no crepúsculo). */
export function lerpColor3Gamma(c1: Color3, c2: Color3, t: number): Color3 {
	if (t <= 0) return c1;
	if (t >= 1) return c2;
	const invT = 1 - t;
	const r = math.sqrt(math.max(0, c1.R * c1.R * invT + c2.R * c2.R * t));
	const g = math.sqrt(math.max(0, c1.G * c1.G * invT + c2.G * c2.G * t));
	const b = math.sqrt(math.max(0, c1.B * c1.B * invT + c2.B * c2.B * t));
	return new Color3(r, g, b);
}

/** Decide se o passo de interpolação pode ser pulado mantendo o snap exato em `0` e `1`. */
export function shouldSkipInterpolation(t: number, lastT: number, epsilon = DAY_NIGHT_EPSILON): boolean {
	if (math.abs(t - lastT) < epsilon && t !== 0 && t !== 1) return true;
	return t === lastT;
}

/** Pré-cache plano de propriedades e aplicador de transição dia/noite sobre `Lighting`. */
export class DayNightCycleApplier {
	private readonly numberBindings: NumberBinding[] = [];
	private readonly colorBindings: ColorBinding[] = [];
	private readonly generalBindings: GeneralBinding[] = [];
	private activeGrading: ColorGradingEffect | undefined;
	private dayTonemapperPreset: Enum.TonemapperPreset | undefined;
	private nightTonemapperPreset: Enum.TonemapperPreset | undefined;
	private daySky: Sky | undefined;
	private nightSky: Sky | undefined;
	private activeSky: Sky | undefined;
	private lastT = -1;
	private binaryNightState: boolean | undefined;
	private fallbackStartTime: number | undefined;

	public constructor(
		private readonly lighting: DayNightLightingLike,
		dayProfile: Instance,
		nightProfile: Instance,
		private readonly workspaceTarget: DayNightWorkspaceLike,
		private readonly getServerTimeNow: () => number,
	) {
		this.buildBindings(dayProfile, nightProfile);
	}

	private registerBinding(instance: unknown, property: string, dayValue: unknown, nightValue: unknown): void {
		if (dayValue === undefined && nightValue === undefined) return;
		const a = dayValue !== undefined ? dayValue : nightValue;
		const b = nightValue !== undefined ? nightValue : dayValue;

		// Valores idênticos entre dia e noite são aplicados uma vez e ficam fora do loop
		if (a === b) {
			setInstanceProperty(instance, property, a);
			return;
		}

		if (typeIs(a, "number") && typeIs(b, "number")) {
			this.numberBindings.push({
				instance,
				property,
				day: a,
				night: b,
				lastValue: INITIAL_NUMBER_SENTINEL,
				integer: property === "StarCount",
			});
		} else if (typeIs(a, "Color3") && typeIs(b, "Color3")) {
			this.colorBindings.push({
				instance,
				property,
				day: a,
				night: b,
			});
		} else {
			this.generalBindings.push({
				instance,
				property,
				day: a,
				night: b,
				valueType: typeOf(a),
			});
		}
	}

	private buildBindings(dayProfile: Instance, nightProfile: Instance): void {
		const shadows = dayProfile.GetAttribute("Lighting_GlobalShadows");
		if (typeIs(shadows, "boolean")) {
			this.lighting.GlobalShadows = shadows;
		}

		for (const prop of DAY_NIGHT_LIGHTING_PROPERTIES) {
			const defaultVal = getInstanceProperty(this.lighting, prop);
			const dayAttr = dayProfile.GetAttribute(`Lighting_${prop}`);
			const nightAttr = nightProfile.GetAttribute(`Lighting_${prop}`);
			this.registerBinding(
				this.lighting,
				prop,
				dayAttr !== undefined ? dayAttr : defaultVal,
				nightAttr !== undefined ? nightAttr : defaultVal,
			);
		}

		// Perfis no Studio usam nomes próprios (ex.: Bloom, JoJoBackgroundDepth); busca por classe garante correspondência
		for (const [className, properties] of pairs(DAY_NIGHT_EFFECT_PROPERTIES)) {
			const dayEffect = findChildByClass(dayProfile, className);
			const nightEffect = findChildByClass(nightProfile, className);
			if (dayEffect !== undefined && nightEffect !== undefined && dayEffect.ClassName === nightEffect.ClassName) {
				const inst = getOrCreateLightingEffect(this.lighting, dayEffect);
				if (inst.IsA("PostEffect")) {
					inst.Enabled = true;
				}
				for (const prop of properties) {
					this.registerBinding(
						inst,
						prop,
						getInstanceProperty(dayEffect, prop),
						getInstanceProperty(nightEffect, prop),
					);
				}
			}
		}

		const dayGrading = dayProfile.FindFirstChild("ColorGrading") ?? findChildByClass(dayProfile, "ColorGradingEffect");
		const nightGrading =
			nightProfile.FindFirstChild("ColorGrading") ?? findChildByClass(nightProfile, "ColorGradingEffect");
		if (dayGrading !== undefined && nightGrading !== undefined && dayGrading.ClassName === nightGrading.ClassName) {
			const grading = getOrCreateLightingEffect(this.lighting, dayGrading);
			if (grading.IsA("PostEffect")) {
				grading.Enabled = true;
			}
			if (grading.IsA("ColorGradingEffect")) {
				this.activeGrading = grading;
			}
			const [ok, presets] = pcall(() => [
				(dayGrading as ColorGradingEffect).TonemapperPreset,
				(nightGrading as ColorGradingEffect).TonemapperPreset,
			]);
			if (ok) {
				this.dayTonemapperPreset = presets[0];
				this.nightTonemapperPreset = presets[1];
			}
		}

		const skyDay = findChildByClass(dayProfile, "Sky");
		const skyNight = findChildByClass(nightProfile, "Sky");
		if (skyDay !== undefined && skyNight !== undefined && skyDay.IsA("Sky") && skyNight.IsA("Sky")) {
			this.daySky = skyDay;
			this.nightSky = skyNight;

			let activeSky = findChildByClass(this.lighting, "Sky");
			if (activeSky === undefined) {
				activeSky = skyDay.Clone();
				attachChild(this.lighting, activeSky);
			}
			if (activeSky.IsA("Sky")) {
				this.activeSky = activeSky;
				activeSky.CelestialBodiesShown = skyDay.CelestialBodiesShown;
				for (const prop of DAY_NIGHT_SKY_NUMBER_PROPERTIES) {
					this.registerBinding(
						activeSky,
						prop,
						getInstanceProperty(skyDay, prop),
						getInstanceProperty(skyNight, prop),
					);
				}
			}
		}
	}

	/** Aplica o estado solar e interpola propriedades visuais para o instante atual. */
	public update(nowOverride?: number): void {
		if (this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.paused) === true) return;

		const now = nowOverride ?? this.getServerTimeNow();
		const rawDuration = this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.duration);
		const duration = isFiniteNumber(rawDuration) ? rawDuration : DAY_NIGHT_DEFAULT_DURATION_SECONDS;

		const rawStartHour = this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.startHour);
		const startHour = isFiniteNumber(rawStartHour) ? rawStartHour : DAY_NIGHT_DEFAULT_START_HOUR;

		const rawStartTime = this.workspaceTarget.GetAttribute(DAY_NIGHT_ATTRIBUTES.startTime);
		let startTime: number;
		if (isFiniteNumber(rawStartTime)) {
			startTime = rawStartTime;
		} else {
			this.fallbackStartTime ??= now;
			startTime = this.fallbackStartTime;
		}

		const hour = calcSolarHour(startHour, now - startTime, duration);
		const t = calcNightAlpha(hour);

		if (math.abs(this.lighting.ClockTime - hour) > DAY_NIGHT_EPSILON) {
			this.lighting.ClockTime = hour;
		}

		if (shouldSkipInterpolation(t, this.lastT, DAY_NIGHT_EPSILON)) return;
		this.lastT = t;

		for (const binding of this.numberBindings) {
			let value = binding.day + (binding.night - binding.day) * t;
			if (binding.integer) {
				value = math.round(value);
			}
			if (math.abs(value - binding.lastValue) > DAY_NIGHT_EPSILON) {
				binding.lastValue = value;
				setInstanceProperty(binding.instance, binding.property, value);
			}
		}

		for (const binding of this.colorBindings) {
			setInstanceProperty(binding.instance, binding.property, lerpColor3Gamma(binding.day, binding.night, t));
		}

		for (const binding of this.generalBindings) {
			if (binding.valueType === "Vector3" && typeIs(binding.day, "Vector3") && typeIs(binding.night, "Vector3")) {
				setInstanceProperty(binding.instance, binding.property, binding.day.Lerp(binding.night, t));
			} else {
				setInstanceProperty(binding.instance, binding.property, t < 0.5 ? binding.day : binding.night);
			}
		}

		const isNight = t >= 0.5;
		if (isNight !== this.binaryNightState) {
			this.binaryNightState = isNight;

			if (this.activeSky !== undefined && this.daySky !== undefined && this.nightSky !== undefined) {
				const sourceSky = isNight ? this.nightSky : this.daySky;
				for (const prop of DAY_NIGHT_SKY_FACE_PROPERTIES) {
					setInstanceProperty(this.activeSky, prop, getInstanceProperty(sourceSky, prop));
				}
			}

			if (
				this.activeGrading !== undefined &&
				this.dayTonemapperPreset !== undefined &&
				this.nightTonemapperPreset !== undefined
			) {
				this.activeGrading.TonemapperPreset = isNight ? this.nightTonemapperPreset : this.dayTonemapperPreset;
			}
		}
	}

	/** Retorna quantos bindings dinâmicos estão registrados (útil para validação em testes). */
	public getBindingCounts(): { numbers: number; colors: number; generals: number } {
		return {
			numbers: this.numberBindings.size(),
			colors: this.colorBindings.size(),
			generals: this.generalBindings.size(),
		};
	}
}
