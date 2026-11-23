// Constantes exclusivas do client para orçamento adaptativo, prioridade, culling e assets de VFX (Part_Icles).

/** Nome do ModuleScript de terceiros em `ReplicatedStorage`. */
export const VFX_MODULE_NAME = "Part_Icles";
export const VFX_TEMPLATES_FOLDER_NAME = "vfxs";
export const BATTLE_SPAWN_VFX_TEMPLATE_NAME = "spawnvfx";

/** Nome do RemoteEvent opcional de VFX de mundo em `ReplicatedStorage`. */
export const VFX_REMOTE_EVENT_NAME = "VFXEvent";

/** Flag de diagnóstico dev (false por padrão; warnings por motivo só rodam no Studio). */
export const VFX_DEBUG = false;

/** Rate limit leve provisório no client para chamadas de `VFXEvent.OnClientEvent` (token bucket). */
export const VFX_REMOTE_BUCKET_CAPACITY = 12;
export const VFX_REMOTE_REFILL_PER_SECOND = 10;
export const VFX_REMOTE_RATE_LIMIT_TOLERANCE = 1e-6;

/** Nome da subpasta de VFX dentro de `ReplicatedStorage/Assets` ou de um modelo de lutador. */
export const VFX_ASSETS_FOLDER_NAME = "VFX";

/** Nomes padrão de pastas globais de VFX de combate dentro de `Assets/VFX`. */
export const VFX_GLOBAL_HIT_NAME = "Hit";
export const VFX_GLOBAL_CRIT_NAME = "Crit";
export const VFX_GLOBAL_KO_NAME = "KO";

/** Atributos opcionais reconhecidos nas pastas de VFX no Studio. */
export const VFX_ATTR_IGNORAR_CULLING = "IgnorarCulling";
export const VFX_ATTR_PRIORIDADE = "Prioridade";

/** Valores canônicos de prioridade de emissão. */
export const VFX_PRIORIDADE_ESSENCIAL = "essencial";
export const VFX_PRIORIDADE_NORMAL = "normal";

/** Frações da referência de FPS (teto do aparelho ou FramerateCap) para cortar ou recuperar orçamento. */
export const VFX_FPS_REFERENCIA_MINIMA = 30;
export const VFX_FRACAO_FPS_CORTE = 0.85;
export const VFX_FRACAO_FPS_SAUDAVEL = 0.92;

/** Limites de emissões simultâneas e partículas ativas por plataforma/FPS. */
export const VFX_LIMITE_MINIMO = 6;
export const VFX_LIMITE_MINIMO_MOBILE = 3;
export const VFX_LIMITE_MAXIMO = 12;

/** Teto extra provisório reservado acima do orçamento normal para emissões essenciais (hit, crit, KO). */
export const VFX_LIMITE_ESSENCIAIS_EXTRA = 4;

/** Parâmetros da janela móvel de FPS e ajuste periódico. */
export const VFX_JANELA_AMOSTRAS = 30;
export const VFX_INTERVALO_AJUSTE_SEGUNDOS = 0.5;

/** Orçamento de partículas simuladas (`Part_Icles.MAX_ACTIVE_PARTICLES`). */
export const VFX_PARTICULAS_MINIMO = 300;
export const VFX_PARTICULAS_MAXIMO = 5000;
export const VFX_PARTICULAS_PASSO = 150;

/** Valores iniciais reduzidos para dispositivos móveis. */
export const VFX_LIMITE_MOBILE = 4;
export const VFX_PARTICULAS_MOBILE = 400;

/** Culling por distância (aplicado somente a VFX do mundo, a partir da câmera atual). */
export const VFX_DISTANCIA_MAXIMA_STUDS = 600;
export const VFX_DISTANCIA_MINIMA_STUDS = 250;
export const VFX_HISTERESE_DISTANCIA = 1.25;
export const VFX_INTERVALO_VARREDURA_SEGUNDOS = 0.5;
