/**
 * Interfaz común de los proveedores de infraestructura (ADR 050). Cada
 * adaptador traduce su API oficial a estos tipos; el resto del sistema no
 * conoce al proveedor. Las operaciones que un proveedor no ofrece por API se
 * declaran en `capabilities` y el panel lo dice en vez de simularlas.
 */

export type InfraKind = 'HETZNER';

export interface InfraCredentials { token: string }

export interface Money { net: string; gross: string }

export interface InfraLocation { name: string; description: string; country: string; city: string; networkZone: string | null }

export interface InfraServerType {
  name: string; description: string; cores: number; memoryGb: number; diskGb: number; cpuType: string | null; architecture: string | null;
  /** Precio por ubicación, con y sin impuesto, en la moneda del proveedor */
  prices: { location: string; hourly: Money; monthly: Money; includedTrafficBytes: number | null }[];
  /** Ubicaciones donde se puede crear ahora (false = sin stock) */
  availableIn: string[];
  deprecated: boolean;
}

export type ServerState = 'initializing' | 'starting' | 'running' | 'stopping' | 'off' | 'deleting' | 'migrating' | 'rebuilding' | 'unknown';

export interface RemoteServer {
  externalId: string; name: string; status: ServerState; serverType: string; location: string; image: string | null;
  ipv4: string | null; ipv6: string | null; createdAt: string; labels: Record<string, string>;
  firewalls: string[];
  traffic: { includedBytes: number | null; outgoingBytes: number | null; ingoingBytes: number | null };
}

export interface FirewallRule { direction: 'in' | 'out'; protocol: 'tcp' | 'udp' | 'icmp'; port?: string; sourceIps: string[]; description: string }

export interface CreateServerInput {
  name: string; serverType: string; location: string; image: string;
  sshKeyIds: string[]; firewallId: string | null; labels: Record<string, string>; userData?: string;
}

export interface ActionRef { id: string; status: 'running' | 'success' | 'error'; progress: number; error: string | null }

export type PowerAction = 'poweron' | 'shutdown' | 'poweroff' | 'reboot';

export interface MetricsResult { start: string; end: string; step: number; series: Record<string, [number, string][]> }

/** Resultado de verificar credenciales (sin crear nada) */
export interface VerifyResult {
  ok: boolean;
  status: 'CONNECTED' | 'AUTH_ERROR' | 'PERMISSION_DENIED' | 'UNAVAILABLE';
  message: string;
  /** Datos que el proveedor sí informa (cantidad de servidores, moneda…) */
  details?: Record<string, string | number | null>;
}

export class InfraError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

export interface Capabilities {
  /** Listar proyectos: Hetzner no (cada token pertenece a un proyecto) */
  projects: boolean;
  /** Factura o gasto real del mes por API */
  billing: boolean;
  metrics: boolean;
  firewalls: boolean;
}

export interface InfraAdapter {
  readonly kind: InfraKind;
  readonly label: string;
  readonly capabilities: Capabilities;
  /** Formato básico del token antes de llamar al proveedor */
  validateToken(token: string): string | null;
  verify(c: InfraCredentials): Promise<VerifyResult>;
  currency(c: InfraCredentials): Promise<{ currency: string; vatRate: string | null }>;
  locations(c: InfraCredentials): Promise<InfraLocation[]>;
  serverTypes(c: InfraCredentials): Promise<InfraServerType[]>;
  listServers(c: InfraCredentials): Promise<RemoteServer[]>;
  getServer(c: InfraCredentials, externalId: string): Promise<RemoteServer | null>;
  ensureSshKey(c: InfraCredentials, name: string, publicKey: string): Promise<{ externalId: string; fingerprint: string }>;
  createFirewall(c: InfraCredentials, name: string, rules: FirewallRule[], labels: Record<string, string>): Promise<{ externalId: string }>;
  createServer(c: InfraCredentials, input: CreateServerInput): Promise<{ server: RemoteServer; action: ActionRef | null; rootPasswordReturned: boolean }>;
  power(c: InfraCredentials, externalId: string, action: PowerAction): Promise<ActionRef>;
  deleteServer(c: InfraCredentials, externalId: string): Promise<ActionRef | null>;
  action(c: InfraCredentials, actionId: string): Promise<ActionRef>;
  metrics(c: InfraCredentials, externalId: string, types: ('cpu' | 'disk' | 'network')[], start: Date, end: Date): Promise<MetricsResult>;
}

export const hintOf = (secret: string) => `…${secret.slice(-4)}`;
