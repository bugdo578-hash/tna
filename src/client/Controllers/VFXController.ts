import { ReplicatedStorage, RunService, UserInputService, Workspace } from "@rbxts/services";
import type { PartIclesApi } from "../types/Part_Icles";
import { WORKSPACE_BATTLE_FOLDER_NAME } from "../UI/CombatVisualConfig";
import {
	VFX_ATTR_IGNORAR_CULLING,
	VFX_ATTR_PRIORIDADE,
	VFX_DEBUG,
	VFX_DISTANCIA_MAXIMA_STUDS,
	VFX_DISTANCIA_MINIMA_STUDS,
	VFX_FPS_REFERENCIA_MINIMA,
	VFX_FRACAO_FPS_CORTE,
	VFX_FRACAO_FPS_SAUDAVEL,
	VFX_HISTERESE_DISTANCIA,
	VFX_INTERVALO_AJUSTE_SEGUNDOS,
	VFX_INTERVALO_VARREDURA_SEGUNDOS,
	VFX_JANELA_AMOSTRAS,
	VFX_LIMITE_ESSENCIAIS_EXTRA,
	VFX_LIMITE_MAXIMO,
	VFX_LIMITE_MINIMO,
	VFX_LIMITE_MINIMO_MOBILE,
	VFX_LIMITE_MOBILE,
	VFX_MODULE_NAME,
	VFX_PARTICULAS_MAXIMO,
	VFX_PARTICULAS_MINIMO,
	VFX_PARTICULAS_MOBILE,
	VFX_PARTICULAS_PASSO,
	VFX_PRIORIDADE_ESSENCIAL,
	VFX_PRIORIDADE_NORMAL,
	VFX_REMOTE_BUCKET_CAPACITY,
	VFX_REMOTE_EVENT_NAME,
	VFX_REMOTE_RATE_LIMIT_TOLERANCE,
	VFX_REMOTE_REFILL_PER_SECOND,
} from "../UI/VFXConfig";

export type VfxPrioridade = typeof VFX_PRIORIDADE_ESSENCIAL | typeof VFX_PRIORIDADE_NORMAL;
export type VfxOrigem = Vector3 | CFrame | BasePart | Attachment | Model;

export type VfxMotivoDescarte =
	| "culling"
	| "orcamento"
	| "pastaInvalida"
	| "moduloAusente"
	| "emitFalhou"
	| "origemInvalida"
	| "rateLimit";

export interface VfxDebugStats {
	readonly culling: number;
	readonly orcamento: number;
	readonly pastaInvalida: number;
	readonly moduloAusente: number;
	readonly emitFalhou: number;
	readonly origemInvalida: number;
	readonly rateLimit: number;
}

export interface VfxReplicatedStorageLike {
	FindFirstChild(name: string): Instance | undefined;
	readonly ChildAdded: RBXScriptSignal<(child: Instance) => void>;
}

export interface VfxUserGameSettingsLike {
	SavedQualityLevel: Enum.SavedQualitySetting;
	FramerateCap?: number;
	GetPropertyChangedSignal(property: string): RBXScriptSignal;
}

export interface VFXControllerDeps {
	readonly partIcles?: PartIclesApi;
	readonly resolvePartIcles?: () => PartIclesApi | undefined;
	readonly replicatedStorage?: VfxReplicatedStorageLike;
	readonly heartbeat?: RBXScriptSignal<(dt: number) => void>;
	readonly userGameSettings?: VfxUserGameSettingsLike;
	readonly isMobile?: boolean;
	readonly getCamera?: () => Camera | undefined;
	readonly debug?: boolean;
	readonly isStudio?: boolean;
	readonly clock?: () => number;
}

interface VfxEstadoPasta {
	tocando: boolean;
	pendingReemit: boolean;
	emissao: number;
	pendingTask: thread | undefined;
}

interface VfxEntradaAtiva {
	readonly pasta: Instance;
	readonly estado: VfxEstadoPasta;
	prioridade: VfxPrioridade;
	origem: VfxOrigem | undefined;
	semCulling: boolean;
	ordem: number;
}

/** Controlador client-side de VFX via `Part_Icles` com orçamento adaptativo, prioridade e culling de mundo. */
export class VFXController {
	private readonly deps: VFXControllerDeps;
	private readonly pareceMobile: boolean;
	private readonly limiteMinimoVfx: number;
	private readonly clock: () => number;
	private readonly debugEnabled: boolean;

	private readonly estados = new Map<Instance, VfxEstadoPasta>();
	private readonly ativos = new Map<Instance, VfxEntradaAtiva>();
	private readonly referencias = new Map<Instance, BasePart | Attachment>();
	private readonly destroyingConnections = new Map<Instance, RBXScriptConnection>();
	private readonly preloadGenerations = new Map<Instance, number>();
	private readonly pendingTasks = new Set<thread>();
	private readonly lifetimeConnections: RBXScriptConnection[] = [];
	private readonly historicoFrames: number[] = table.create(VFX_JANELA_AMOSTRAS, 0);
	private readonly motivosAvisados = new Set<VfxMotivoDescarte>();
	private readonly descartes = {
		culling: 0,
		orcamento: 0,
		pastaInvalida: 0,
		moduloAusente: 0,
		emitFalhou: 0,
		origemInvalida: 0,
		rateLimit: 0,
	};

	private partIcles: PartIclesApi | undefined;
	private userGameSettings: VfxUserGameSettingsLike | undefined;
	private cameraAtual: Camera | undefined;
	private vfxEventAtual: RemoteEvent | undefined;
	private vfxEventConnection: RBXScriptConnection | undefined;

	private loadAttempted = false;
	private warnedMissingModule = false;
	private started = false;
	private destroyed = false;

	private limiteVfxSimultaneos: number;
	private limiteParticulas: number;
	private tetoVfxQualidade: number | undefined;
	private tetoParticulasQualidade: number | undefined;

	private indiceHistorico = 0;
	private framesColetados = 0;
	private somaFrames = 0;
	private tempoDesdeAjuste = 0;
	private fpsMaximoMedido = 0;
	private remoteTokens: number;
	private remoteUltimoRefill: number;

	private ordemEmissao = 0;
	private nextPreloadGeneration = 0;
	private scanThread: thread | undefined;

	public constructor(deps?: VFXControllerDeps) {
		this.deps = deps ?? {};
		this.pareceMobile =
			this.deps.isMobile ?? (UserInputService.TouchEnabled && !UserInputService.KeyboardEnabled);
		this.limiteMinimoVfx = this.pareceMobile ? VFX_LIMITE_MINIMO_MOBILE : VFX_LIMITE_MINIMO;
		this.limiteVfxSimultaneos = this.pareceMobile ? VFX_LIMITE_MOBILE : VFX_LIMITE_MAXIMO;
		this.limiteParticulas = this.pareceMobile ? VFX_PARTICULAS_MOBILE : VFX_PARTICULAS_MAXIMO;
		this.clock = this.deps.clock ?? (() => os.clock());
		const emStudio = this.deps.isStudio ?? RunService.IsStudio();
		this.debugEnabled = (this.deps.debug ?? VFX_DEBUG) && emStudio;
		this.remoteTokens = VFX_REMOTE_BUCKET_CAPACITY;
		this.remoteUltimoRefill = this.clock();
	}

	public start(): void {
		if (this.started || this.destroyed) return;
		this.started = true;

		this.ensurePartIcles();
		this.inicializarConfiguracoes();
		this.inicializarCamera();
		this.inicializarVfxEvent();

		const heartbeat = this.deps.heartbeat ?? RunService.Heartbeat;
		this.lifetimeConnections.push(
			heartbeat.Connect((dt) => {
				this.processarFrameFps(dt);
			}),
		);
	}

	/** Emite uma pasta/efeito do Part_Icles respeitando culling (só mundo), orçamento por FPS e prioridade. */
	public emit(
		pasta: Instance,
		origem?: VfxOrigem,
		prioridade?: VfxPrioridade,
		ignorarCulling?: boolean,
	): boolean {
		if (this.destroyed) return false;
		if (!this.instanciaValidaComParent(pasta)) {
			this.registrarDescarte("pastaInvalida", "Pasta/instância de VFX inválida ou sem Parent.");
			return false;
		}
		if (!this.origemValida(origem)) {
			this.registrarDescarte("origemInvalida", "Origem de VFX inválida.");
			return false;
		}
		if (!this.ensurePartIcles()) {
			this.registrarDescarte("moduloAusente", "Módulo Part_Icles ausente ou inválido.");
			return false;
		}

		const prioridadeEfetiva = this.resolverPrioridade(pasta, prioridade);
		const semCulling =
			ignorarCulling === true || this.temAtributoIgnorarCulling(pasta) || this.estaNoPalcoBatalha(pasta);

		if (!semCulling && !this.estaPerto(pasta, origem, 1)) {
			this.registrarDescarte("culling", "VFX descartado por culling de distância.");
			return false;
		}

		const estado = this.obterEstado(pasta);
		const entradaExistente = this.ativos.get(pasta);

		if (entradaExistente !== undefined || estado.tocando || estado.pendingReemit) {
			// Combo rápido (ex.: ORA ORA): reaproveita o próprio slot, cancela pendência anterior e reemite após o disable.
			this.cancelarTaskPasta(estado);
			estado.emissao += 1;
			const idEmissao = estado.emissao;
			estado.tocando = false;
			estado.pendingReemit = true;

			this.ordemEmissao += 1;
			const entrada: VfxEntradaAtiva = entradaExistente ?? {
				pasta,
				estado,
				prioridade: prioridadeEfetiva,
				origem,
				semCulling,
				ordem: this.ordemEmissao,
			};
			entrada.prioridade = prioridadeEfetiva;
			entrada.origem = origem;
			entrada.semCulling = semCulling;
			entrada.ordem = this.ordemEmissao;
			this.ativos.set(pasta, entrada);

			this.desativarVfxSilencioso(pasta);
			this.iniciarVarreduraSeNecessario();

			const deferThread = this.agendarDefer(estado, () => {
				if (this.destroyed || !pasta.Parent || estado.emissao !== idEmissao) {
					if (!pasta.Parent) {
						this.removerPastaDestruida(pasta);
					}
					return;
				}
				estado.pendingReemit = false;
				this.iniciarEmissao(pasta, estado, idEmissao, entrada);
			});
			estado.pendingTask = deferThread;
			return true;
		}

		if (!this.garantirEspacoOrcamento(prioridadeEfetiva)) {
			this.registrarDescarte("orcamento", "VFX descartado por limite de orçamento simultâneo.");
			return false;
		}

		this.cancelarTaskPasta(estado);
		estado.emissao += 1;
		const idEmissao = estado.emissao;
		estado.tocando = false;
		estado.pendingReemit = false;

		this.ordemEmissao += 1;
		const novaEntrada: VfxEntradaAtiva = {
			pasta,
			estado,
			prioridade: prioridadeEfetiva,
			origem,
			semCulling,
			ordem: this.ordemEmissao,
		};
		this.ativos.set(pasta, novaEntrada);
		this.iniciarEmissao(pasta, estado, idEmissao, novaEntrada);
		return this.ativos.has(pasta);
	}

	/** Pré-carrega texturas no Part_Icles e associa à geração informada (ou nova geração monotônica). */
	public preload(pasta: Instance, geracao?: number): number {
		if (this.destroyed) return 0;
		if (!this.ensurePartIcles()) return 0;
		if (!this.instanciaValidaComParent(pasta)) return 0;

		const api = this.partIcles;
		if (api === undefined) return 0;

		let gen = geracao;
		if (gen === undefined) {
			this.nextPreloadGeneration += 1;
			gen = this.nextPreloadGeneration;
		} else if (gen > this.nextPreloadGeneration) {
			this.nextPreloadGeneration = gen;
		}

		const atual = this.preloadGenerations.get(pasta);
		if (atual !== undefined && atual > gen) {
			return atual;
		}

		this.preloadGenerations.set(pasta, gen);
		this.garantirConexaoDestroying(pasta);
		pcall(() => api.Preload(pasta));
		return gen;
	}

	/** Libera texturas no Part_Icles; se `geracao` for informada, ignora gerações antigas já substituídas. */
	public deload(pasta: Instance, geracao?: number): boolean {
		if (this.destroyed) return false;
		if (!this.ensurePartIcles()) return false;
		if (!this.instanciaValida(pasta)) return false;

		const api = this.partIcles;
		if (api === undefined) return false;

		const atual = this.preloadGenerations.get(pasta);
		if (geracao !== undefined && (atual === undefined || atual !== geracao)) {
			return false;
		}

		this.preloadGenerations.delete(pasta);
		this.limparConexaoDestroyingSeOcioso(pasta);
		pcall(() => api.Deload(pasta));
		return true;
	}

	/** Cancela todas as tasks/delays/varredura e desabilita todas as emissões ativas imediatamente. */
	public clear(): void {
		if (this.scanThread !== undefined) {
			const scan = this.scanThread;
			this.scanThread = undefined;
			pcall(() => task.cancel(scan));
		}

		for (const thread of this.pendingTasks) {
			pcall(() => task.cancel(thread));
		}
		this.pendingTasks.clear();

		for (const [pasta, entrada] of this.ativos) {
			entrada.estado.emissao += 1;
			entrada.estado.tocando = false;
			entrada.estado.pendingReemit = false;
			entrada.estado.pendingTask = undefined;
			this.desativarVfxSilencioso(pasta);
		}
		this.ativos.clear();

		for (const [pasta, estado] of this.estados) {
			estado.emissao += 1;
			estado.tocando = false;
			estado.pendingReemit = false;
			estado.pendingTask = undefined;
			if (!pasta.Parent) {
				this.limparRegistrosPasta(pasta);
			}
		}
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.clear();
		this.destroyed = true;
		this.desconectarVfxEvent();

		for (const connection of this.lifetimeConnections) {
			pcall(() => connection.Disconnect());
		}
		this.lifetimeConnections.clear();

		for (const [, connection] of this.destroyingConnections) {
			pcall(() => connection.Disconnect());
		}
		this.destroyingConnections.clear();

		this.estados.clear();
		this.referencias.clear();
		this.preloadGenerations.clear();
		this.partIcles = undefined;
	}

	/** Retorna cópia dos contadores de descarte por motivo para diagnóstico no client. */
	public debugStats(): VfxDebugStats {
		return {
			culling: this.descartes.culling,
			orcamento: this.descartes.orcamento,
			pastaInvalida: this.descartes.pastaInvalida,
			moduloAusente: this.descartes.moduloAusente,
			emitFalhou: this.descartes.emitFalhou,
			origemInvalida: this.descartes.origemInvalida,
			rateLimit: this.descartes.rateLimit,
		};
	}

	public getActiveCount(): number {
		return this.ativos.size();
	}

	public getBudgetSnapshot(): {
		readonly limiteVfxSimultaneos: number;
		readonly limiteParticulas: number;
		readonly limiteEssenciaisTeto: number;
		readonly ativos: number;
		readonly disponivel: boolean;
		readonly scanAtiva: boolean;
	} {
		return {
			limiteVfxSimultaneos: this.limiteVfxSimultaneos,
			limiteParticulas: this.limiteParticulas,
			limiteEssenciaisTeto: this.limiteVfxSimultaneos + VFX_LIMITE_ESSENCIAIS_EXTRA,
			ativos: this.ativos.size(),
			disponivel: this.partIcles !== undefined,
			scanAtiva: this.scanThread !== undefined,
		};
	}

	private ensurePartIcles(): boolean {
		if (this.partIcles !== undefined) return true;
		if (this.loadAttempted || this.destroyed) return false;
		this.loadAttempted = true;

		if (this.deps.partIcles !== undefined) {
			const [okActivate, errActivate] = pcall(() => this.deps.partIcles!.Activate());
			if (!okActivate) {
				this.warnMissingOnce(`Falha ao ativar Part_Icles: ${tostring(errActivate)}`);
				return false;
			}
			this.partIcles = this.deps.partIcles;
			this.aplicarLimites();
			return true;
		}

		if (this.deps.resolvePartIcles !== undefined) {
			const [okResolve, resolved] = pcall(() => this.deps.resolvePartIcles!());
			if (!okResolve || resolved === undefined) {
				this.warnMissingOnce(
					okResolve
						? "Módulo Part_Icles ausente; VFXController operando em modo no-op."
						: `Falha ao carregar Part_Icles: ${tostring(resolved)}`,
				);
				return false;
			}
			const [okActivate, errActivate] = pcall(() => resolved.Activate());
			if (!okActivate) {
				this.warnMissingOnce(`Falha ao ativar Part_Icles: ${tostring(errActivate)}`);
				return false;
			}
			this.partIcles = resolved;
			this.aplicarLimites();
			return true;
		}

		const storage = this.getStorage();
		const moduleInstance = storage.FindFirstChild(VFX_MODULE_NAME);
		if (moduleInstance === undefined || !moduleInstance.IsA("ModuleScript")) {
			this.warnMissingOnce(`ReplicatedStorage.${VFX_MODULE_NAME} não encontrado; VFXController em modo no-op.`);
			return false;
		}

		const [okRequire, loaded] = pcall(() => require(moduleInstance));
		if (!okRequire || !typeIs(loaded, "table")) {
			this.warnMissingOnce(`Falha ao requerer ${VFX_MODULE_NAME}: ${tostring(loaded)}`);
			return false;
		}

		const candidate = loaded as Partial<PartIclesApi>;
		if (
			!typeIs(candidate.Activate, "function") ||
			!typeIs(candidate.AbsoluteEmit, "function") ||
			!typeIs(candidate.AbsoluteDisable, "function") ||
			!typeIs(candidate.Preload, "function") ||
			!typeIs(candidate.Deload, "function")
		) {
			this.warnMissingOnce(`Módulo ${VFX_MODULE_NAME} com API incompleta; VFXController em modo no-op.`);
			return false;
		}

		const api = candidate as PartIclesApi;
		const [okActivate, errActivate] = pcall(() => api.Activate());
		if (!okActivate) {
			this.warnMissingOnce(`Falha ao ativar ${VFX_MODULE_NAME}: ${tostring(errActivate)}`);
			return false;
		}

		this.partIcles = api;
		this.aplicarLimites();
		return true;
	}

	private warnMissingOnce(message: string): void {
		if (this.warnedMissingModule) return;
		this.warnedMissingModule = true;
		this.motivosAvisados.add("moduloAusente");
		warn(`[VFXController] ${message}`);
	}

	private registrarDescarte(motivo: VfxMotivoDescarte, detalhe: string): void {
		this.descartes[motivo] += 1;
		if (!this.debugEnabled || this.motivosAvisados.has(motivo)) {
			return;
		}
		this.motivosAvisados.add(motivo);
		warn(`[VFXController][${motivo}] ${detalhe}`);
	}

	private getStorage(): VfxReplicatedStorageLike {
		return this.deps.replicatedStorage ?? ReplicatedStorage;
	}

	private inicializarVfxEvent(): void {
		const storage = this.getStorage();
		const existente = storage.FindFirstChild(VFX_REMOTE_EVENT_NAME);
		if (existente !== undefined) {
			this.tentarConectarVfxEvent(existente);
		}
		this.lifetimeConnections.push(
			storage.ChildAdded.Connect((child) => {
				if (this.destroyed) return;
				this.tentarConectarVfxEvent(child);
			}),
		);
	}

	private tentarConectarVfxEvent(candidate: Instance): void {
		if (this.destroyed) return;
		if (candidate.Name !== VFX_REMOTE_EVENT_NAME) return;

		const [okIsA, isRemote] = pcall(() => candidate.IsA("RemoteEvent"));
		if (!okIsA || !isRemote) return;

		const remote = candidate as RemoteEvent;
		if (
			this.vfxEventAtual === remote &&
			this.vfxEventConnection !== undefined &&
			this.vfxEventConnection.Connected
		) {
			return;
		}

		this.desconectarVfxEvent();
		this.vfxEventAtual = remote;
		const [okConn, conn] = pcall(() =>
			remote.OnClientEvent.Connect((pasta: unknown, origem: unknown) => {
				this.processarEventoRemoto(pasta, origem);
			}),
		);
		if (okConn && conn !== undefined) {
			this.vfxEventConnection = conn;
		} else {
			this.vfxEventAtual = undefined;
		}
	}

	private desconectarVfxEvent(): void {
		const conn = this.vfxEventConnection;
		this.vfxEventConnection = undefined;
		this.vfxEventAtual = undefined;
		if (conn !== undefined) {
			pcall(() => conn.Disconnect());
		}
	}

	private processarEventoRemoto(pasta: unknown, origem: unknown): void {
		if (this.destroyed) return;
		if (!this.instanciaValidaComParent(pasta)) {
			this.registrarDescarte("pastaInvalida", "VFXEvent descartado: pasta inválida ou sem Parent.");
			return;
		}
		if (!this.origemValida(origem)) {
			this.registrarDescarte("origemInvalida", "VFXEvent descartado: origem inválida.");
			return;
		}
		if (!this.consumirTokenRemoto()) {
			this.registrarDescarte("rateLimit", "VFXEvent descartado por rate limit no client.");
			return;
		}

		this.emit(pasta, origem, VFX_PRIORIDADE_NORMAL, false);
	}

	private consumirTokenRemoto(): boolean {
		if (VFX_REMOTE_BUCKET_CAPACITY <= 0) return false;
		const agora = this.clock();
		const decorrido = math.max(0, agora - this.remoteUltimoRefill);
		this.remoteTokens = math.min(
			VFX_REMOTE_BUCKET_CAPACITY,
			this.remoteTokens + decorrido * VFX_REMOTE_REFILL_PER_SECOND,
		);
		this.remoteUltimoRefill = agora;
		if (this.remoteTokens + VFX_REMOTE_RATE_LIMIT_TOLERANCE < 1) {
			return false;
		}
		this.remoteTokens = math.max(0, this.remoteTokens - 1);
		return true;
	}

	private inicializarConfiguracoes(): void {
		if (this.deps.userGameSettings !== undefined) {
			this.userGameSettings = this.deps.userGameSettings;
		} else {
			const [ok, settings] = pcall(() => UserSettings().GetService("UserGameSettings"));
			if (ok) {
				this.userGameSettings = settings as unknown as VfxUserGameSettingsLike;
			}
		}

		if (this.userGameSettings === undefined) {
			this.aplicarLimites();
			return;
		}

		const settings = this.userGameSettings;
		this.recalcularTetoQualidade();
		pcall(() => {
			this.lifetimeConnections.push(
				settings.GetPropertyChangedSignal("SavedQualityLevel").Connect(() => {
					this.recalcularTetoQualidade();
				}),
			);
		});
		pcall(() => {
			this.lifetimeConnections.push(
				settings.GetPropertyChangedSignal("FramerateCap").Connect(() => {
					this.aplicarLimites();
				}),
			);
		});
	}

	private inicializarCamera(): void {
		if (this.deps.getCamera !== undefined) {
			this.cameraAtual = this.deps.getCamera();
			return;
		}
		this.cameraAtual = Workspace.CurrentCamera;
		this.lifetimeConnections.push(
			Workspace.GetPropertyChangedSignal("CurrentCamera").Connect(() => {
				this.cameraAtual = Workspace.CurrentCamera;
			}),
		);
	}

	private readFramerateCap(): number | undefined {
		const settings = this.userGameSettings;
		if (settings === undefined) return undefined;
		const [ok, raw] = pcall(() => settings.FramerateCap);
		if (!ok || !typeIs(raw, "number") || raw <= 0) return undefined;
		return raw;
	}

	private recalcularTetoQualidade(): void {
		const settings = this.userGameSettings;
		this.tetoVfxQualidade = undefined;
		this.tetoParticulasQualidade = undefined;

		if (settings !== undefined) {
			const [okNivel, nivelSalvo] = pcall(() => settings.SavedQualityLevel);
			if (okNivel && nivelSalvo !== undefined && nivelSalvo !== Enum.SavedQualitySetting.Automatic) {
				let maiorNivel = 0;
				for (const item of Enum.SavedQualitySetting.GetEnumItems()) {
					if (item.Value > maiorNivel) {
						maiorNivel = item.Value;
					}
				}
				if (maiorNivel > 0) {
					const fracao = nivelSalvo.Value / maiorNivel;
					this.tetoVfxQualidade = math.max(
						this.limiteMinimoVfx,
						math.floor(VFX_LIMITE_MAXIMO * fracao),
					);
					this.tetoParticulasQualidade = math.max(
						VFX_PARTICULAS_MINIMO,
						math.floor(VFX_PARTICULAS_MAXIMO * fracao),
					);
				}
			}
		}

		this.aplicarLimites();
	}

	private aplicarLimites(): void {
		if (this.tetoVfxQualidade !== undefined) {
			this.limiteVfxSimultaneos = math.min(this.limiteVfxSimultaneos, this.tetoVfxQualidade);
		}
		if (this.tetoParticulasQualidade !== undefined) {
			this.limiteParticulas = math.min(this.limiteParticulas, this.tetoParticulasQualidade);
		}
		this.limiteVfxSimultaneos = math.max(this.limiteMinimoVfx, this.limiteVfxSimultaneos);
		this.limiteParticulas = math.max(VFX_PARTICULAS_MINIMO, this.limiteParticulas);

		if (this.partIcles !== undefined) {
			pcall(() => {
				this.partIcles!.MAX_ACTIVE_PARTICLES = this.limiteParticulas;
			});
		}
	}

	private processarFrameFps(dt: number): void {
		if (this.destroyed || dt <= 0) return;

		const slot = this.indiceHistorico;
		this.indiceHistorico = (this.indiceHistorico + 1) % VFX_JANELA_AMOSTRAS;
		this.somaFrames += dt - this.historicoFrames[slot];
		this.historicoFrames[slot] = dt;
		if (this.framesColetados < VFX_JANELA_AMOSTRAS) {
			this.framesColetados += 1;
		}

		this.tempoDesdeAjuste += dt;
		if (this.tempoDesdeAjuste < VFX_INTERVALO_AJUSTE_SEGUNDOS) return;
		this.tempoDesdeAjuste = 0;

		if (this.framesColetados < VFX_JANELA_AMOSTRAS || this.somaFrames <= 0) return;

		const fpsMedio = this.framesColetados / this.somaFrames;
		if (fpsMedio > this.fpsMaximoMedido) {
			this.fpsMaximoMedido = fpsMedio;
		}

		const cap = this.readFramerateCap();
		const baseReferencia = math.max(VFX_FPS_REFERENCIA_MINIMA, this.fpsMaximoMedido);
		const fpsReferencia = cap !== undefined ? math.min(baseReferencia, cap) : baseReferencia;

		if (fpsMedio < fpsReferencia * VFX_FRACAO_FPS_CORTE) {
			this.limiteVfxSimultaneos = math.max(this.limiteMinimoVfx, this.limiteVfxSimultaneos - 1);
			this.limiteParticulas = math.max(VFX_PARTICULAS_MINIMO, this.limiteParticulas - VFX_PARTICULAS_PASSO);
		} else if (fpsMedio >= fpsReferencia * VFX_FRACAO_FPS_SAUDAVEL) {
			this.limiteVfxSimultaneos = math.min(VFX_LIMITE_MAXIMO, this.limiteVfxSimultaneos + 1);
			this.limiteParticulas = math.min(VFX_PARTICULAS_MAXIMO, this.limiteParticulas + VFX_PARTICULAS_PASSO);
		}

		this.aplicarLimites();
	}

	private resolverPrioridade(pasta: Instance, prioridadeExplicita?: VfxPrioridade): VfxPrioridade {
		if (prioridadeExplicita !== undefined) return prioridadeExplicita;
		const attr = pasta.GetAttribute(VFX_ATTR_PRIORIDADE);
		if (attr === true) return VFX_PRIORIDADE_ESSENCIAL;
		if (typeIs(attr, "string") && attr.lower() === VFX_PRIORIDADE_ESSENCIAL) {
			return VFX_PRIORIDADE_ESSENCIAL;
		}
		return VFX_PRIORIDADE_NORMAL;
	}

	private temAtributoIgnorarCulling(pasta: Instance): boolean {
		return pasta.GetAttribute(VFX_ATTR_IGNORAR_CULLING) === true;
	}

	private estaNoPalcoBatalha(pasta: Instance): boolean {
		let atual: Instance | undefined = pasta;
		while (atual !== undefined && atual !== Workspace) {
			if (atual.Name === WORKSPACE_BATTLE_FOLDER_NAME) return true;
			atual = atual.Parent;
		}
		return false;
	}

	private distanciaMaximaAtual(): number {
		const fator = this.limiteVfxSimultaneos / VFX_LIMITE_MAXIMO;
		return math.max(VFX_DISTANCIA_MINIMA_STUDS, VFX_DISTANCIA_MAXIMA_STUDS * fator);
	}

	private acharReferencia(pasta: Instance): BasePart | Attachment | undefined {
		if (pasta.IsA("BasePart") || pasta.IsA("Attachment")) {
			return pasta;
		}
		for (const desc of pasta.GetDescendants()) {
			if (desc.IsA("BasePart") || desc.IsA("Attachment")) {
				return desc;
			}
		}
		return undefined;
	}

	private posicaoDe(pasta: Instance, origem?: VfxOrigem): Vector3 | undefined {
		if (origem !== undefined) {
			if (typeIs(origem, "Vector3")) return origem;
			if (typeIs(origem, "CFrame")) return origem.Position;
			if (typeIs(origem, "Instance")) {
				if (origem.IsA("BasePart")) return origem.Position;
				if (origem.IsA("Attachment")) return origem.WorldPosition;
				if (origem.IsA("Model")) return origem.GetPivot().Position;
			}
		}

		let ref = this.referencias.get(pasta);
		if (ref === undefined || !ref.Parent) {
			ref = this.acharReferencia(pasta);
			if (ref !== undefined) {
				this.referencias.set(pasta, ref);
			} else {
				this.referencias.delete(pasta);
			}
		}
		if (ref === undefined) return undefined;

		return ref.IsA("Attachment") ? ref.WorldPosition : ref.Position;
	}

	private estaPerto(pasta: Instance, origem: VfxOrigem | undefined, multiplicador: number): boolean {
		const cam = this.deps.getCamera !== undefined ? this.deps.getCamera() : this.cameraAtual ?? Workspace.CurrentCamera;
		if (cam === undefined) return true;

		const pos = this.posicaoDe(pasta, origem);
		if (pos === undefined) return true;

		const maximo = this.distanciaMaximaAtual() * multiplicador;
		const delta = pos.sub(cam.CFrame.Position);
		return delta.Dot(delta) <= maximo * maximo;
	}

	private obterEstado(pasta: Instance): VfxEstadoPasta {
		let estado = this.estados.get(pasta);
		if (estado === undefined) {
			estado = {
				tocando: false,
				pendingReemit: false,
				emissao: 0,
				pendingTask: undefined,
			};
			this.estados.set(pasta, estado);
			this.garantirConexaoDestroying(pasta);
		}
		return estado;
	}

	private garantirConexaoDestroying(pasta: Instance): void {
		if (this.destroyingConnections.has(pasta)) return;
		const [ok, conn] = pcall(() =>
			pasta.Destroying.Connect(() => {
				this.removerPastaDestruida(pasta);
			}),
		);
		if (ok && conn !== undefined) {
			this.destroyingConnections.set(pasta, conn);
		}
	}

	private limparConexaoDestroyingSeOcioso(pasta: Instance): void {
		if (this.estados.has(pasta) || this.preloadGenerations.has(pasta)) return;
		const conn = this.destroyingConnections.get(pasta);
		if (conn !== undefined) {
			this.destroyingConnections.delete(pasta);
			pcall(() => conn.Disconnect());
		}
	}

	private limparRegistrosPasta(pasta: Instance): void {
		const estado = this.estados.get(pasta);
		if (estado !== undefined) {
			estado.emissao += 1;
			this.cancelarTaskPasta(estado);
			estado.tocando = false;
			estado.pendingReemit = false;
			this.estados.delete(pasta);
		}
		this.ativos.delete(pasta);
		this.referencias.delete(pasta);
		this.preloadGenerations.delete(pasta);
		this.limparConexaoDestroyingSeOcioso(pasta);
	}

	private removerPastaDestruida(pasta: Instance): void {
		this.limparRegistrosPasta(pasta);
	}

	private garantirEspacoOrcamento(prioridade: VfxPrioridade): boolean {
		if (prioridade === VFX_PRIORIDADE_NORMAL) {
			return this.ativos.size() < this.limiteVfxSimultaneos;
		}

		// Essenciais nunca são descartados dentro do orçamento: expulsam primeiro os mais antigos de baixa prioridade.
		while (this.ativos.size() >= this.limiteVfxSimultaneos) {
			const maisAntigoNormal = this.encontrarMaisAntigo(VFX_PRIORIDADE_NORMAL);
			if (maisAntigoNormal === undefined) break;
			this.desativarEntrada(maisAntigoNormal.pasta, maisAntigoNormal, true);
		}

		// Teto duro para essenciais (limite + extra): acima disso expulsa o essencial mais antigo.
		const tetoEssenciais = this.limiteVfxSimultaneos + VFX_LIMITE_ESSENCIAIS_EXTRA;
		if (tetoEssenciais <= 0) return false;

		while (this.ativos.size() >= tetoEssenciais) {
			const candidato = this.encontrarMaisAntigo(VFX_PRIORIDADE_NORMAL) ?? this.encontrarMaisAntigo();
			if (candidato === undefined) break;
			this.desativarEntrada(candidato.pasta, candidato, true);
		}

		return this.ativos.size() < tetoEssenciais;
	}

	private encontrarMaisAntigo(filtroPrioridade?: VfxPrioridade): VfxEntradaAtiva | undefined {
		let escolhido: VfxEntradaAtiva | undefined;
		for (const [, entrada] of this.ativos) {
			if (filtroPrioridade !== undefined && entrada.prioridade !== filtroPrioridade) {
				continue;
			}
			if (escolhido === undefined || entrada.ordem < escolhido.ordem) {
				escolhido = entrada;
			}
		}
		return escolhido;
	}

	private iniciarEmissao(
		pasta: Instance,
		estado: VfxEstadoPasta,
		idEmissao: number,
		entrada: VfxEntradaAtiva,
	): void {
		const api = this.partIcles;
		if (api === undefined || this.destroyed || !pasta.Parent || estado.emissao !== idEmissao) {
			if (this.ativos.get(pasta) === entrada && estado.emissao === idEmissao) {
				this.ativos.delete(pasta);
			}
			return;
		}

		const [ok, duracao] = pcall(() => api.AbsoluteEmit(pasta));
		if (!ok || this.destroyed || estado.emissao !== idEmissao || !pasta.Parent) {
			if (!ok && !this.destroyed) {
				this.registrarDescarte("emitFalhou", `AbsoluteEmit falhou: ${tostring(duracao)}`);
			}
			if (this.ativos.get(pasta) === entrada) {
				this.ativos.delete(pasta);
			}
			estado.tocando = false;
			if (!pasta.Parent) {
				this.removerPastaDestruida(pasta);
			}
			return;
		}

		estado.tocando = true;
		this.ativos.set(pasta, entrada);
		this.iniciarVarreduraSeNecessario();

		if (duracao !== undefined && typeIs(duracao, "number")) {
			const delaySegundos = math.max(0, duracao);
			const delayThread = this.agendarDelay(delaySegundos, estado, () => {
				if (this.destroyed || estado.emissao !== idEmissao) return;
				this.desativarEntrada(pasta, entrada, false);
			});
			estado.pendingTask = delayThread;
		}
	}

	private desativarEntrada(pasta: Instance, entrada: VfxEntradaAtiva, incrementarEmissao: boolean): void {
		const estado = entrada.estado;
		if (incrementarEmissao) {
			estado.emissao += 1;
		}
		this.cancelarTaskPasta(estado);
		estado.tocando = false;
		estado.pendingReemit = false;
		if (this.ativos.get(pasta) === entrada) {
			this.ativos.delete(pasta);
		}
		this.desativarVfxSilencioso(pasta);
		if (!pasta.Parent) {
			this.limparRegistrosPasta(pasta);
		}
	}

	private desativarVfxSilencioso(pasta: Instance): void {
		const api = this.partIcles;
		if (api === undefined || !pasta.Parent) return;
		pcall(() => api.AbsoluteDisable(pasta));
	}

	private cancelarTaskPasta(estado: VfxEstadoPasta): void {
		const pendente = estado.pendingTask;
		if (pendente === undefined) return;
		estado.pendingTask = undefined;
		this.pendingTasks.delete(pendente);
		pcall(() => task.cancel(pendente));
	}

	private agendarDelay(segundos: number, estado: VfxEstadoPasta, callback: () => void): thread {
		let threadRef: thread | undefined;
		threadRef = task.delay(segundos, () => {
			if (threadRef !== undefined) {
				this.pendingTasks.delete(threadRef);
				if (estado.pendingTask === threadRef) {
					estado.pendingTask = undefined;
				}
			}
			callback();
		});
		this.pendingTasks.add(threadRef);
		return threadRef;
	}

	private agendarDefer(estado: VfxEstadoPasta, callback: () => void): thread {
		let threadRef: thread | undefined;
		threadRef = task.defer(() => {
			if (threadRef !== undefined) {
				this.pendingTasks.delete(threadRef);
				if (estado.pendingTask === threadRef) {
					estado.pendingTask = undefined;
				}
			}
			callback();
		});
		this.pendingTasks.add(threadRef);
		return threadRef;
	}

	private temAtivoCullable(): boolean {
		for (const [, entrada] of this.ativos) {
			if (!entrada.semCulling) return true;
		}
		return false;
	}

	private iniciarVarreduraSeNecessario(): void {
		if (this.scanThread !== undefined || this.destroyed || !this.temAtivoCullable()) {
			return;
		}

		this.scanThread = task.spawn(() => {
			while (!this.destroyed && this.temAtivoCullable()) {
				task.wait(VFX_INTERVALO_VARREDURA_SEGUNDOS);
				if (this.destroyed || !this.temAtivoCullable()) break;

				const snapshot: VfxEntradaAtiva[] = [];
				for (const [, entrada] of this.ativos) {
					snapshot.push(entrada);
				}

				for (const entrada of snapshot) {
					const pasta = entrada.pasta;
					if (this.ativos.get(pasta) !== entrada) continue;
					if (!pasta.Parent) {
						this.removerPastaDestruida(pasta);
					} else if (!entrada.semCulling && !this.estaPerto(pasta, entrada.origem, VFX_HISTERESE_DISTANCIA)) {
						this.desativarEntrada(pasta, entrada, true);
					}
				}
			}
			this.scanThread = undefined;
		});
	}

	private instanciaValida(instancia: unknown): instancia is Instance {
		return typeIs(instancia, "Instance");
	}

	private instanciaValidaComParent(instancia: unknown): instancia is Instance {
		return typeIs(instancia, "Instance") && instancia.Parent !== undefined;
	}

	private origemValida(origem: unknown): origem is VfxOrigem | undefined {
		if (origem === undefined) return true;
		if (typeIs(origem, "Vector3")) {
			return this.vetorFinito(origem);
		}
		if (typeIs(origem, "CFrame")) {
			return this.vetorFinito(origem.Position);
		}
		if (typeIs(origem, "Instance")) {
			return origem.IsA("BasePart") || origem.IsA("Attachment") || origem.IsA("Model");
		}
		return false;
	}

	private vetorFinito(v: Vector3): boolean {
		return (
			v.X === v.X &&
			v.Y === v.Y &&
			v.Z === v.Z &&
			math.abs(v.X) < math.huge &&
			math.abs(v.Y) < math.huge &&
			math.abs(v.Z) < math.huge
		);
	}
}
