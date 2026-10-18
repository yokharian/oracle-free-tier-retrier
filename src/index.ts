#!/usr/bin/env node
// allow: SIZE_OK — PRD §27 mandates the entire MVP application in one file.
//
// oci-free-vm — deploy an OCI VM and automatically retry when capacity is unavailable.
// Boring infrastructure, excellent CLI UX.

import { createHash, createPrivateKey, createSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

// ------------------------------------------------------------------ constants

const APP = { name: 'oci-free-vm', version: '0.1.0' } as const;

const DEFAULT_CONFIG_FILE = 'oci-free-vm.yaml';
const LOGS_DIR = 'oci-free-vm-logs';

const LIMITS = {
  storageWarnGb: 200,
  diskMinGb: 50,
  diskMaxGb: 32_768,
  ocpusMax: 64,
  memoryMaxGbs: 1024,
  defaultIntervalSeconds: 900,
  defaultOcpus: 1,
  defaultMemoryGbs: 6,
  defaultDiskGb: 100,
  defaultName: 'devbox',
  defaultVcnName: 'oci-free-vm-vcn',
  defaultVcnCidr: '10.0.0.0/16',
  defaultSubnetCidr: '10.0.0.0/24',
  requestTimeoutMs: 30_000,
} as const;

const EXIT = {
  success: 0,
  deployFailed: 1,
  invalidConfig: 2,
  auth: 3,
  cancelled: 4,
  unexpected: 5,
} as const;

type Architecture = 'arm64' | 'x86_64';
type NetworkMode = 'existing' | 'create';
type FailureKind = 'capacity' | 'transient' | 'auth' | 'invalid' | 'fatal';
type FailureCode = 'OUT_OF_CAPACITY' | 'TRANSIENT' | 'AUTH' | 'CONFIG' | 'DEPLOY' | 'UNEXPECTED';

function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------- errors

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class OciConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OciConfigError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export class OciHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly operation: string;
  constructor(operation: string, status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'OciHttpError';
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface Failure {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly code: FailureCode;
  readonly message: string;
}

export function classifyFailure(error: unknown): Failure {
  if (error instanceof OciConfigError) {
    return { kind: 'auth', retryable: false, exitCode: EXIT.auth, code: 'AUTH', message: error.message };
  }
  if (error instanceof ConfigError) {
    return { kind: 'invalid', retryable: false, exitCode: EXIT.invalidConfig, code: 'CONFIG', message: error.message };
  }
  if (error instanceof NetworkError) {
    return { kind: 'transient', retryable: true, exitCode: EXIT.deployFailed, code: 'TRANSIENT', message: error.message };
  }
  if (error instanceof OciHttpError) {
    if (error.code === 'NotAuthorizedOrNotFound') {
      return { kind: 'auth', retryable: false, exitCode: EXIT.auth, code: 'AUTH', message: `${error.operation}: ${error.message}` };
    }
    const text = `${error.code ?? ''} ${error.message}`.toLowerCase();
    const failure: Omit<Failure, 'message'> = /out of (host )?capacity/.test(text)
      ? { kind: 'capacity', retryable: true, exitCode: EXIT.deployFailed, code: 'OUT_OF_CAPACITY' }
      : error.status === 429 || error.status >= 500
        ? { kind: 'transient', retryable: true, exitCode: EXIT.deployFailed, code: 'TRANSIENT' }
        : error.status === 401 || error.status === 403
          ? { kind: 'auth', retryable: false, exitCode: EXIT.auth, code: 'AUTH' }
          : error.status === 400
            ? { kind: 'invalid', retryable: false, exitCode: EXIT.invalidConfig, code: 'CONFIG' }
            : { kind: 'fatal', retryable: false, exitCode: EXIT.deployFailed, code: 'DEPLOY' };
    return { ...failure, message: `${error.operation}: ${error.message}` };
  }
  return {
    kind: 'fatal',
    retryable: false,
    exitCode: EXIT.unexpected,
    code: 'UNEXPECTED',
    message: error instanceof Error ? error.message : String(error),
  };
}

function failureAdvice(kind: FailureKind): string {
  switch (kind) {
    case 'capacity':
      return 'Capacity failures are retried automatically across Availability Domains.';
    case 'transient':
      return 'Transient OCI or network failures are retried automatically.';
    case 'auth':
      return 'Your OCI login is valid, but the user lacks permission for this operation in the selected compartment, or the OCID is wrong. Check the IAM policy, or select a different compartment.';
    case 'invalid':
      return 'Fix the reported configuration value and run again.';
    case 'fatal':
      return 'This error is not retryable.';
    default:
      return assertNever(kind);
  }
}

// ------------------------------------------------------------ secret sanitizing

/** Removes PEM blocks and OCI request-signature material from text bound for logs. */
export function sanitize(text: string): string {
  return text
    .replace(/-----BEGIN[ A-Z0-9]*-----[\s\S]*?-----END[ A-Z0-9]*-----/g, '[redacted key material]')
    .replace(/signature="[^"]+"/g, 'signature="[redacted]"')
    .replace(/pass[_-]?phrase\s*=\s*\S+/gi, 'pass_phrase=[redacted]');
}

// ------------------------------------------------------------------ yaml config

const networkDefaultsSchema = z.object({
  mode: z.enum(['existing', 'create']).optional(),
  vcn_id: z.string().optional(),
  subnet_id: z.string().optional(),
});

const defaultsSchema = z.object({
  region: z.string().optional(),
  architecture: z.enum(['arm64', 'x86_64']).optional(),
  compartment_id: z.string().optional(),
  network: networkDefaultsSchema.optional(),
  instance: z
    .object({
      name: z.string().optional(),
      shape: z.string().optional(),
      ocpus: z.number().optional(),
      memory_gbs: z.number().optional(),
      disk_gbs: z.number().optional(),
      assign_public_ip: z.boolean().optional(),
    })
    .optional(),
  ssh: z.object({ public_key_file: z.string().optional() }).optional(),
  retry: z.object({ interval_seconds: z.number().optional() }).optional(),
});

const lastDeploymentSchema = z
  .object({
    status: z.string().optional(),
    timestamp: z.string().optional(),
    instance_id: z.string().optional(),
    instance_name: z.string().optional(),
    availability_domain: z.string().optional(),
    architecture: z.enum(['arm64', 'x86_64']).optional(),
    shape: z.string().optional(),
    disk_gbs: z.number().optional(),
  })
  .optional();

const lastErrorSchema = z
  .object({
    timestamp: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .optional();

const yamlConfigSchema = z
  .object({
    defaults: defaultsSchema.optional(),
    state: z.object({ last_deployment: lastDeploymentSchema }).optional(),
    last_error: lastErrorSchema,
  })
  .passthrough();

export type YamlConfig = z.infer<typeof yamlConfigSchema>;
export type YamlDefaults = NonNullable<YamlConfig['defaults']>;
export type LastErrorOut = NonNullable<z.infer<typeof lastErrorSchema>>;

export async function loadYamlConfig(path: string): Promise<{ data: YamlConfig; raw: Record<string, unknown> }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { data: {}, raw: {} };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${path}: invalid YAML (${error instanceof Error ? error.message : String(error)})`);
  }
  if (parsed === null || parsed === undefined) return { data: {}, raw: {} };
  const result = yamlConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? '' : ` (${issue.path.join('.')}: ${issue.message})`;
    throw new ConfigError(`${path}: invalid configuration${where}`);
  }
  return { data: result.data, raw: result.data };
}

export async function saveYamlConfig(
  path: string,
  raw: Record<string, unknown>,
  sections: {
    defaults: Record<string, unknown>;
    state: Record<string, unknown>;
    last_error: Record<string, unknown>;
  },
): Promise<void> {
  const merged: Record<string, unknown> = { ...raw, ...sections };
  await writeFile(path, stringifyYaml(merged), 'utf8');
}

// ------------------------------------------------------------------ CLI parsing

export interface CliOverrides {
  readonly configPath?: string | undefined;
  readonly profile?: string | undefined;
  readonly jsonMode: boolean;
  readonly yes: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly region?: string | undefined;
  readonly compartmentId?: string | undefined;
  readonly architecture?: Architecture | undefined;
  readonly networkMode?: NetworkMode | undefined;
  readonly vcnId?: string | undefined;
  readonly subnetId?: string | undefined;
  readonly shape?: string | undefined;
  readonly ocpus?: number | undefined;
  readonly memoryGbs?: number | undefined;
  readonly diskGbs?: number | undefined;
  readonly instanceName?: string | undefined;
  readonly sshKeyFile?: string | undefined;
  readonly assignPublicIp?: boolean | undefined;
  readonly intervalSeconds?: number | undefined;
}

function toPositiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`--${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

function toPositiveNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`--${name} must be a positive number (got "${raw}")`);
  }
  return value;
}

const BOOLEAN_FLAGS = new Set(['help', 'json', 'version', 'yes']);
const VALUE_FLAGS = new Set([
  'config',
  'profile',
  'region',
  'compartment-id',
  'arch',
  'shape',
  'ocpus',
  'memory',
  'disk',
  'name',
  'ssh-key',
  'public-ip',
  'interval-seconds',
  'network-mode',
  'vcn-id',
  'subnet-id',
]);

export function parseCliArgs(argv: readonly string[]): CliOverrides {
  const values = new Map<string, string | boolean>();
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === '--') throw new ConfigError('positional arguments are not supported');
    if (!arg.startsWith('--')) throw new ConfigError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === '') throw new ConfigError(`unexpected argument "${arg}"`);
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) throw new ConfigError(`unknown option --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) {
        const explicit = arg.slice(eq + 1);
        if (explicit !== 'true' && explicit !== 'false') throw new ConfigError(`--${name} must be "true" or "false"`);
        values.set(name, explicit === 'true');
      } else {
        values.set(name, true);
      }
    } else if (eq !== -1) {
      values.set(name, arg.slice(eq + 1));
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new ConfigError(`--${name} requires a value`);
      values.set(name, next);
      index += 1;
    }
    index += 1;
  }
  const str = (name: string): string | undefined => {
    const value = values.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  const nonEmpty = (name: string): string | undefined => {
    const value = str(name);
    return value === '' ? undefined : value;
  };
  const archValue = str('arch');
  let architecture: Architecture | undefined;
  if (archValue === 'arm64' || archValue === 'x86_64') architecture = archValue;
  else if (archValue !== undefined) throw new ConfigError(`--arch must be "arm64" or "x86_64" (got "${archValue}")`);
  const publicIpValue = str('public-ip');
  let assignPublicIp: boolean | undefined;
  if (publicIpValue === 'true') assignPublicIp = true;
  else if (publicIpValue === 'false') assignPublicIp = false;
  else if (publicIpValue !== undefined) throw new ConfigError(`--public-ip must be "true" or "false" (got "${publicIpValue}")`);
  const networkModeValue = str('network-mode');
  let networkMode: NetworkMode | undefined;
  if (networkModeValue === 'existing' || networkModeValue === 'create') networkMode = networkModeValue;
  else if (networkModeValue !== undefined) throw new ConfigError(`--network-mode must be "existing" or "create" (got "${networkModeValue}")`);
  return {
    configPath: nonEmpty('config'),
    profile: nonEmpty('profile'),
    jsonMode: values.get('json') === true,
    yes: values.get('yes') === true,
    help: values.get('help') === true,
    version: values.get('version') === true,
    region: nonEmpty('region'),
    compartmentId: nonEmpty('compartment-id'),
    architecture,
    networkMode,
    vcnId: nonEmpty('vcn-id'),
    subnetId: nonEmpty('subnet-id'),
    shape: nonEmpty('shape'),
    ocpus: toPositiveInt('ocpus', str('ocpus')),
    memoryGbs: toPositiveNumber('memory', str('memory')),
    diskGbs: toPositiveInt('disk', str('disk')),
    instanceName: nonEmpty('name'),
    sshKeyFile: nonEmpty('ssh-key'),
    assignPublicIp,
    intervalSeconds: toPositiveInt('interval-seconds', str('interval-seconds')),
  };
}

function printUsage(): void {
  process.stdout.write(
    [
      `${APP.name} v${APP.version} — deploy an OCI VM and automatically retry when capacity is unavailable.`,
      '',
      'Usage:',
      '  oci-free-vm [options]',
      '',
      'Options:',
      '  --config <path>           configuration file (default: ./oci-free-vm.yaml)',
      '  --profile <name>          OCI config profile (default: DEFAULT)',
      '  --json                    machine-readable JSON output, non-interactive',
      '  --yes                     skip confirmation prompts',
      '  --name <name>             instance name',
      '  --region <region>         OCI region (default: from ~/.oci/config)',
      '  --compartment-id <ocid>   compartment OCID',
      '  --arch <arch>             arm64 | x86_64',
      '  --shape <shape>           instance shape (e.g. VM.Standard.A1.Flex)',
      '  --ocpus <n>               OCPUs (flexible shapes)',
      '  --memory <gb>             memory in GB (flexible shapes)',
      '  --disk <gb>               boot volume size in GB',
      '  --ssh-key <path>          SSH public key file (default: ~/.ssh/id_ed25519.pub)',
      '  --public-ip <bool>         "true" or "false"',
      '  --interval-seconds <n>    retry interval between full AD cycles (default: 900)',
      '  --network-mode <mode>     existing | create',
      '  --vcn-id <ocid>           existing VCN OCID',
      '  --subnet-id <ocid>        existing subnet OCID',
      '  --version                 print version',
      '  --help                    print this help',
      '',
      'Precedence: CLI arguments > YAML defaults > interactive prompts > application defaults.',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------- oci ~/.oci/config

export function parseOciConfigText(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let current = 'DEFAULT';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section !== null) {
      current = section[1] ?? 'DEFAULT';
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const record = sections.get(current) ?? {};
    record[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    sections.set(current, record);
  }
  return sections;
}

export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export interface OciAuth {
  readonly user: string;
  readonly tenancy: string;
  readonly fingerprint: string;
  readonly region: string;
  readonly keyFile: string;
  readonly privateKey: KeyObject;
}

export async function loadOciAuth(profileName: string | undefined): Promise<OciAuth> {
  const configPath = process.env['OCI_CONFIG_FILE'] ?? join(homedir(), '.oci', 'config');
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    throw new OciConfigError(`OCI configuration not found at ${configPath}`);
  }
  const sections = parseOciConfigText(text);
  const profile = profileName ?? process.env['OCI_CONFIG_PROFILE'] ?? 'DEFAULT';
  const section = sections.get(profile) ?? sections.get('DEFAULT');
  if (section === undefined) {
    throw new OciConfigError(`profile "${profile}" not found in ${configPath}`);
  }
  const required = ['user', 'tenancy', 'fingerprint', 'region', 'key_file'] as const;
  for (const key of required) {
    if (section[key] === undefined || section[key] === '') {
      throw new OciConfigError(`profile "${profile}" in ${configPath} is missing "${key}"`);
    }
  }
  const keyFile = expandTilde(section['key_file'] ?? '');
  let pem: string;
  try {
    pem = await readFile(keyFile, 'utf8');
  } catch {
    throw new OciConfigError(`private key file "${keyFile}" (key_file in ${configPath}) is not readable`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new OciConfigError(`private key file "${keyFile}" is not a valid PEM RSA key`);
  }
  return {
    user: section['user'] ?? '',
    tenancy: section['tenancy'] ?? '',
    fingerprint: section['fingerprint'] ?? '',
    region: section['region'] ?? '',
    keyFile,
    privateKey,
  };
}

export function probeBinary(name: string): boolean {
  const result = spawnSync(name, ['--version'], { stdio: 'ignore' });
  return result.error === undefined;
}

// -------------------------------------------------------------- request signing

/** OCI request signing, signature version 1 (RFC 1945 style date, RSA-SHA256). */
export function buildSignedHeaders(args: {
  method: 'GET' | 'POST' | 'PUT';
  url: URL;
  key: KeyObject;
  keyId: string;
  body?: string | undefined;
  date: Date;
}): Record<string, string> {
  const date = args.date.toUTCString();
  const target = `${args.method.toLowerCase()} ${args.url.pathname}${args.url.search}`;
  const lines: string[] = [`date: ${date}`, `(request-target): ${target}`, `host: ${args.url.host}`];
  const names = ['date', '(request-target)', 'host'];
  let digest: string | undefined;
  if (args.body !== undefined) {
    digest = createHash('sha256').update(args.body).digest('base64');
    lines.push(`content-type: application/json`, `content-length: ${Buffer.byteLength(args.body)}`, `x-content-sha256: ${digest}`);
    names.push('content-type', 'content-length', 'x-content-sha256');
  }
  const signer = createSign('RSA-SHA256');
  signer.update(lines.join('\n'));
  const signature = signer.sign(args.key, 'base64');
  const headers: Record<string, string> = {
    date,
    authorization: `Signature version="1",keyId="${args.keyId}",algorithm="rsa-sha256",signature="${signature}",headers="${names.join(' ')}"`,
  };
  if (digest !== undefined) {
    headers['content-type'] = 'application/json';
    headers['x-content-sha256'] = digest;
  }
  return headers;
}

// ------------------------------------------------------------------- OCI client

type Service = 'identity' | 'network' | 'compute';
const SERVICE_HOST_PREFIX = { identity: 'identity', network: 'iaas', compute: 'iaas' } as const satisfies Record<Service, string>;

const compartmentSchema = z.object({ id: z.string(), name: z.string(), lifecycleState: z.string() }).passthrough();
const vcnSchema = z
  .object({
    id: z.string(),
    displayName: z.string().nullable(),
    defaultRouteTableId: z.string().nullish(),
    defaultSecurityListId: z.string().nullish(),
  })
  .passthrough();
const subnetSchema = z
  .object({ id: z.string(), displayName: z.string().nullable(), vcnId: z.string(), availabilityDomain: z.string().nullish() })
  .passthrough();
const shapeSchema = z.object({ shape: z.string() }).passthrough();
const imageSchema = z
  .object({
    id: z.string(),
    operatingSystem: z.string(),
    operatingSystemVersion: z.string(),
    timeCreated: z.string().nullish(),
  })
  .passthrough();
const instanceSchema = z.object({ id: z.string(), displayName: z.string().nullable(), lifecycleState: z.string() }).passthrough();
const bootVolumeSchema = z.object({ sizeInGBs: z.number().nullish(), displayName: z.string().nullish() }).passthrough();
const idObjectSchema = z.object({ id: z.string() }).passthrough();
const routeTableSchema = z.object({ id: z.string(), routeRules: z.array(z.record(z.string(), z.unknown())).nullish() }).passthrough();
const securityListSchema = z
  .object({
    id: z.string(),
    ingressSecurityRules: z.array(z.record(z.string(), z.unknown())).nullish(),
    egressSecurityRules: z.array(z.record(z.string(), z.unknown())).nullish(),
  })
  .passthrough();
const errorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough();

export type Compartment = z.infer<typeof compartmentSchema>;
export type Vcn = z.infer<typeof vcnSchema>;
export type Subnet = z.infer<typeof subnetSchema>;
export type Image = z.infer<typeof imageSchema>;
export type Instance = z.infer<typeof instanceSchema>;
export type RouteTable = z.infer<typeof routeTableSchema>;
export type SecurityList = z.infer<typeof securityListSchema>;

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // no-excuse-ok: catch — non-JSON body falls back to a plain message
  }
}

export interface LaunchInstanceDetails {
  readonly availabilityDomain: string;
  readonly compartmentId: string;
  readonly displayName: string;
  readonly shape: string;
  readonly shapeConfig?: { readonly ocpus: number; readonly memoryInGBs: number };
  readonly sourceDetails: { readonly sourceType: 'image'; readonly imageId: string; readonly bootVolumeSizeInGBs: number };
  readonly createVnicDetails: { readonly subnetId: string; readonly assignPublicIp: 'YES' | 'NO' };
  readonly metadata: { readonly ssh_authorized_keys: string };
}

export function buildLaunchBody(args: {
  availabilityDomain: string;
  compartmentId: string;
  displayName: string;
  shape: string;
  shapeIsFlex: boolean;
  ocpus: number | null;
  memoryGbs: number | null;
  diskGbs: number;
  subnetId: string;
  assignPublicIp: boolean;
  imageId: string;
  sshPublicKey: string;
}): LaunchInstanceDetails {
  const body: {
    availabilityDomain: string;
    compartmentId: string;
    displayName: string;
    shape: string;
    shapeConfig?: { ocpus: number; memoryInGBs: number };
    sourceDetails: { sourceType: 'image'; imageId: string; bootVolumeSizeInGBs: number };
    createVnicDetails: { subnetId: string; assignPublicIp: 'YES' | 'NO' };
    metadata: { ssh_authorized_keys: string };
  } = {
    availabilityDomain: args.availabilityDomain,
    compartmentId: args.compartmentId,
    displayName: args.displayName,
    shape: args.shape,
    ...(args.shapeIsFlex && args.ocpus !== null && args.memoryGbs !== null
      ? { shapeConfig: { ocpus: args.ocpus, memoryInGBs: args.memoryGbs } }
      : {}),
    sourceDetails: { sourceType: 'image', imageId: args.imageId, bootVolumeSizeInGBs: args.diskGbs },
    createVnicDetails: { subnetId: args.subnetId, assignPublicIp: args.assignPublicIp ? 'YES' : 'NO' },
    metadata: { ssh_authorized_keys: args.sshPublicKey },
  };
  return body;
}

export class Oci {
  private readonly auth: OciAuth;
  private readonly fetchFn: typeof fetch;
  private readonly endpointOverride: string | undefined;
  private readonly now: () => Date;

  constructor(
    auth: OciAuth,
    deps: { fetchFn?: typeof fetch | undefined; endpointOverride?: string | undefined; now?: (() => Date) | undefined } = {},
  ) {
    this.auth = auth;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.endpointOverride = deps.endpointOverride ?? process.env['OCI_FREE_VM_ENDPOINT'];
    this.now = deps.now ?? (() => new Date());
  }

  private baseUrl(service: Service): string {
    if (this.endpointOverride !== undefined) {
      return this.endpointOverride.replace(/\/+$/, '');
    }
    return `https://${SERVICE_HOST_PREFIX[service]}.${this.auth.region}.oraclecloud.com`;
  }

  private async request<S extends z.ZodType>(
    service: Service,
    method: 'GET' | 'POST' | 'PUT',
    operation: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown; schema: S },
  ): Promise<z.infer<S>> {
    const url = new URL(this.baseUrl(service) + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers = buildSignedHeaders({
      method,
      url,
      key: this.auth.privateKey,
      keyId: `${this.auth.tenancy}/${this.auth.user}/${this.auth.fingerprint}`,
      body,
      date: this.now(),
    });
    let response: Response;
    try {
      response = await this.fetchFn(url, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(LIMITS.requestTimeoutMs) });
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))) {
        throw new NetworkError(`${operation}: ${error.message}`);
      }
      throw error;
    }
    const text = await response.text();
    if (!response.ok) {
      const parsed = safeJsonParse(text);
      const checked = parsed === undefined ? null : errorBodySchema.safeParse(parsed);
      const code = checked?.success ? checked.data.code : undefined;
      const message = checked?.success && checked.data.message !== undefined ? checked.data.message : `${operation} failed (HTTP ${response.status})`;
      throw new OciHttpError(operation, response.status, code, sanitize(message));
    }
    if (text.trim() === '') return opts.schema.parse([]);
    return opts.schema.parse(safeJsonParse(text));
  }

  listCompartments(): Promise<Compartment[]> {
    return this.request('identity', 'GET', 'ListCompartments', '/20160918/compartments', {
      query: {
        compartmentId: this.auth.tenancy,
        compartmentIdInSubtree: 'true',
        accessLevel: 'ACCESSIBLE',
        lifecycleState: 'ACTIVE',
      },
      schema: z.array(compartmentSchema),
    });
  }

  listAvailabilityDomains(compartmentId: string): Promise<string[]> {
    return this.request('identity', 'GET', 'ListAvailabilityDomains', '/20160918/availabilityDomains', {
      query: { compartmentId },
      schema: z.array(z.object({ name: z.string() }).passthrough()),
    }).then((ads) => ads.map((ad) => ad.name));
  }

  listVcns(compartmentId: string): Promise<Vcn[]> {
    return this.request('network', 'GET', 'ListVcns', '/20160916/vcns', {
      query: { compartmentId },
      schema: z.array(vcnSchema),
    });
  }

  listSubnets(compartmentId: string, vcnId: string): Promise<Subnet[]> {
    return this.request('network', 'GET', 'ListSubnets', '/20160916/subnets', {
      query: { compartmentId, vcnId },
      schema: z.array(subnetSchema),
    });
  }

  listShapes(compartmentId: string, availabilityDomain: string): Promise<string[]> {
    return this.request('compute', 'GET', 'ListShapes', '/20160916/shapes', {
      query: { compartmentId, availabilityDomain },
      schema: z.array(shapeSchema),
    }).then((shapes) => [...new Set(shapes.map((s) => s.shape))].sort());
  }

  listImages(compartmentId: string, shape: string): Promise<Image[]> {
    return this.request('compute', 'GET', 'ListImages', '/20160916/images', {
      query: { compartmentId, operatingSystem: 'Canonical Ubuntu', shape, sortOrder: 'DESC' },
      schema: z.array(imageSchema),
    });
  }

  listInstances(compartmentId: string, displayName?: string): Promise<Instance[]> {
    return this.request('compute', 'GET', 'ListInstances', '/20160916/instances', {
      query: { compartmentId, displayName },
      schema: z.array(instanceSchema),
    });
  }

  listBootVolumes(compartmentId: string, availabilityDomain: string): Promise<z.infer<typeof bootVolumeSchema>[]> {
    return this.request('compute', 'GET', 'ListBootVolumes', '/20160916/bootVolumes', {
      query: { compartmentId, availabilityDomain },
      schema: z.array(bootVolumeSchema),
    });
  }

  launchInstance(details: LaunchInstanceDetails): Promise<Instance> {
    return this.request('compute', 'POST', 'LaunchInstance', '/20160916/instances/', {
      body: details,
      schema: instanceSchema,
    });
  }

  createVcn(args: { compartmentId: string; displayName: string; cidr: string }): Promise<Vcn> {
    return this.request('network', 'POST', 'CreateVcn', '/20160916/vcns', {
      body: { compartmentId: args.compartmentId, displayName: args.displayName, cidrBlocks: [args.cidr] },
      schema: vcnSchema,
    });
  }

  createInternetGateway(args: { compartmentId: string; vcnId: string; displayName: string }): Promise<z.infer<typeof idObjectSchema>> {
    return this.request('network', 'POST', 'CreateInternetGateway', '/20160916/internetGateways', {
      body: { compartmentId: args.compartmentId, vcnId: args.vcnId, displayName: args.displayName, isEnabled: true },
      schema: idObjectSchema,
    });
  }

  updateRouteTable(id: string, routeRules: RouteTable['routeRules']): Promise<RouteTable> {
    return this.request('network', 'PUT', 'UpdateRouteTable', `/20160916/routeTables/${id}`, {
      body: { routeRules: routeRules ?? [] },
      schema: routeTableSchema,
    });
  }

  getSecurityList(id: string): Promise<SecurityList> {
    return this.request('network', 'GET', 'GetSecurityList', `/20160916/securityLists/${id}`, {
      schema: securityListSchema,
    });
  }

  updateSecurityList(id: string, ingress: SecurityList['ingressSecurityRules'], egress: SecurityList['egressSecurityRules']): Promise<SecurityList> {
    return this.request('network', 'PUT', 'UpdateSecurityList', `/20160916/securityLists/${id}`, {
      body: { ingressSecurityRules: ingress ?? [], egressSecurityRules: egress ?? [] },
      schema: securityListSchema,
    });
  }

  createSubnet(args: { compartmentId: string; vcnId: string; displayName: string; cidr: string }): Promise<Subnet> {
    return this.request('network', 'POST', 'CreateSubnet', '/20160916/subnets', {
      body: {
        compartmentId: args.compartmentId,
        vcnId: args.vcnId,
        displayName: args.displayName,
        cidrBlock: args.cidr,
        prohibitPublicIpOnVcn: false,
      },
      schema: subnetSchema,
    });
  }
}

// --------------------------------------------------------------------- storage

export interface StorageReport {
  readonly existingGb: number | null;
  readonly items: readonly { readonly name: string; readonly gb: number }[];
  readonly newGb: number;
  readonly projectedGb: number | null;
  readonly exceedsWarn: boolean;
}

export function projectStorage(existingGb: number | null, items: readonly { name: string; gb: number }[], newGb: number): StorageReport {
  const projectedGb = existingGb === null ? null : existingGb + newGb;
  return {
    existingGb,
    items,
    newGb,
    projectedGb,
    exceedsWarn: projectedGb === null ? false : projectedGb > LIMITS.storageWarnGb,
  };
}

async function computeExistingStorage(
  oci: Oci,
  compartmentId: string,
  availabilityDomains: readonly string[],
): Promise<{ totalGb: number | null; items: { name: string; gb: number }[] }> {
  try {
    const items: { name: string; gb: number }[] = [];
    for (const ad of availabilityDomains) {
      const volumes = await oci.listBootVolumes(compartmentId, ad);
      for (const volume of volumes) {
        items.push({ name: volume.displayName ?? 'boot-volume', gb: volume.sizeInGBs ?? 0 });
      }
    }
    return { totalGb: items.reduce((sum, item) => sum + item.gb, 0), items };
  } catch {
    return { totalGb: null, items: [] }; // no-excuse-ok: catch — storage is best-effort (§9 "when possible")
  }
}

// ------------------------------------------------------------------- log files

export function shortAd(ad: string): string {
  const match = /AD-(\d+)\b/.exec(ad);
  return match === null ? ad.replace(/[^A-Za-z0-9-]/g, '-').slice(-30) : `AD-${match[1] ?? ''}`;
}

/** Windows-safe attempt log filename (§20): YYYY-MM-DDTHH-mm-ss-SSSZ-attempt-NNN-<ad>.log */
export function attemptLogFileName(isoTimestamp: string, attempt: number, availabilityDomain: string): string {
  const ts = isoTimestamp.replace(/[:.]/g, '-');
  const ad = shortAd(availabilityDomain).replace(/[^A-Za-z0-9-]/g, '-');
  return `${ts}-attempt-${String(attempt).padStart(3, '0')}-${ad}.log`;
}

export function buildAttemptLog(args: {
  timestamp: string;
  attempt: number;
  availabilityDomain: string;
  instance: string;
  architecture: string;
  shape: string;
  ocpus: number | null;
  memory: number | null;
  disk: number;
  operation: 'LaunchInstance';
  result: 'SUCCEEDED' | 'FAILED';
  errorCode?: string;
  error?: string;
}): string {
  const lines = [
    `Timestamp: ${args.timestamp}`,
    `Attempt: ${args.attempt}`,
    `Availability Domain: ${args.availabilityDomain}`,
    `Instance: ${args.instance}`,
    `Architecture: ${args.architecture}`,
    `Shape: ${args.shape}`,
    `OCPUs: ${args.ocpus ?? 'n/a'}`,
    `Memory: ${args.memory === null ? 'n/a' : `${args.memory} GB`}`,
    `Disk: ${args.disk} GB`,
    '',
    `Operation: ${args.operation}`,
    '',
    `Result: ${args.result}`,
  ];
  if (args.errorCode !== undefined) lines.push(`Error code: ${sanitize(args.errorCode)}`);
  if (args.error !== undefined) lines.push(`Error: ${sanitize(args.error)}`);
  return lines.join('\n') + '\n';
}

async function writeAttemptLog(dir: string, fileName: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, content, 'utf8');
  return path;
}

// -------------------------------------------------------------------------- IO

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface IO {
  readonly interactive: boolean;
  intro(title: string): void;
  outro(message?: string): void;
  message(text: string): void;
  step(text: string): void;
  success(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  select(message: string, options: readonly SelectOption[], initial?: string | undefined): Promise<string>;
  text(message: string, opts?: { initial?: string | undefined; validate?: ((value: string) => string | undefined) | undefined }): Promise<string>;
  confirm(message: string, initial: boolean): Promise<boolean>;
}

export function interactiveIo(): IO {
  return {
    interactive: true,
    intro: (title) => p.intro(title),
    outro: (message) => p.outro(message),
    message: (text) => console.log(text),
    step: (text) => console.log(pc.green('✓') + ' ' + text),
    success: (text) => console.log(pc.green('✓') + ' ' + text),
    warn: (text) => console.log(pc.yellow('⚠') + ' ' + text),
    error: (text) => console.log(pc.red('✗') + ' ' + text),
    async select(message, options, initial) {
      const result = await p.select({
        message,
        options: options.map((option) => ({ value: option.value, label: option.label, ...(option.hint === undefined ? {} : { hint: option.hint }) })),
        ...(initial === undefined ? {} : { initialValue: initial }),
      });
      if (p.isCancel(result)) throw new CancelledError();
      return result;
    },
    async text(message, opts) {
      const result = await p.text({
        message,
        ...(opts?.initial === undefined ? {} : { initialValue: opts.initial }),
        ...(opts?.validate === undefined ? {} : { validate: (value: string | undefined) => opts?.validate?.(value ?? '') ?? undefined }),
      });
      if (p.isCancel(result)) throw new CancelledError();
      return result.trim();
    },
    async confirm(message, initial) {
      const result = await p.confirm({ message, initialValue: initial });
      if (p.isCancel(result)) throw new CancelledError();
      return result;
    },
  };
}

export function jsonIo(): IO {
  const silence = (): void => undefined;
  return {
    interactive: false,
    intro: silence,
    outro: silence,
    message: silence,
    step: silence,
    success: silence,
    warn: silence,
    error: silence,
    async select() {
      throw new Error('internal error: select prompt in --json mode');
    },
    async text() {
      throw new Error('internal error: text prompt in --json mode');
    },
    async confirm() {
      throw new Error('internal error: confirm prompt in --json mode');
    },
  };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// ------------------------------------------------------------------- resolution

export interface ResolvedConfig {
  readonly region: string | null;
  readonly compartmentId: string | null;
  readonly architecture: Architecture | null;
  readonly networkMode: NetworkMode | null;
  readonly vcnId: string | null;
  readonly subnetId: string | null;
  readonly shape: string | null;
  readonly ocpus: number | null;
  readonly memoryGbs: number | null;
  readonly diskGbs: number | null;
  readonly instanceName: string | null;
  readonly sshKeyFile: string | null;
  readonly assignPublicIp: boolean | null;
  readonly intervalSeconds: number | null;
}

export function resolveConfig(yaml: YamlDefaults | undefined, cli: CliOverrides): ResolvedConfig {
  return {
    region: cli.region ?? yaml?.region ?? null,
    compartmentId: cli.compartmentId ?? yaml?.compartment_id ?? null,
    architecture: cli.architecture ?? yaml?.architecture ?? null,
    networkMode: cli.networkMode ?? yaml?.network?.mode ?? null,
    vcnId: cli.vcnId ?? yaml?.network?.vcn_id ?? null,
    subnetId: cli.subnetId ?? yaml?.network?.subnet_id ?? null,
    shape: cli.shape ?? yaml?.instance?.shape ?? null,
    ocpus: cli.ocpus ?? yaml?.instance?.ocpus ?? null,
    memoryGbs: cli.memoryGbs ?? yaml?.instance?.memory_gbs ?? null,
    diskGbs: cli.diskGbs ?? yaml?.instance?.disk_gbs ?? null,
    instanceName: cli.instanceName ?? yaml?.instance?.name ?? null,
    sshKeyFile: cli.sshKeyFile ?? yaml?.ssh?.public_key_file ?? null,
    assignPublicIp: cli.assignPublicIp ?? yaml?.instance?.assign_public_ip ?? null,
    intervalSeconds: cli.intervalSeconds ?? yaml?.retry?.interval_seconds ?? null,
  };
}

const APP_DEFAULTS = {
  architecture: 'arm64',
  shape: { arm64: 'VM.Standard.A1.Flex', x86_64: 'VM.Standard.E2.1.Micro' },
  diskGbs: LIMITS.defaultDiskGb,
  ocpus: LIMITS.defaultOcpus,
  memoryGbs: LIMITS.defaultMemoryGbs,
  instanceName: LIMITS.defaultName,
  assignPublicIp: true,
  intervalSeconds: LIMITS.defaultIntervalSeconds,
  networkMode: 'existing',
  vcnName: LIMITS.defaultVcnName,
  vcnCidr: LIMITS.defaultVcnCidr,
  subnetCidr: LIMITS.defaultSubnetCidr,
} as const;

export function isFlexShape(shape: string): boolean {
  return shape.includes('Flex');
}

function architectureForShape(shape: string): Architecture {
  return shape.startsWith('VM.Standard.A1') ? 'arm64' : 'x86_64';
}

function shapesForArchitecture(shapes: readonly string[], architecture: Architecture): string[] {
  return shapes.filter((shape) => architectureForShape(shape) === architecture);
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null; // no-excuse-ok: catch — existence probe
  }
}

export async function detectSshPublicKeyFile(): Promise<string | null> {
  for (const candidate of ['~/.ssh/id_ed25519.pub', '~/.ssh/id_rsa.pub']) {
    if ((await readFileOrNull(expandTilde(candidate))) !== null) return candidate;
  }
  return null;
}

async function readSshPublicKey(file: string): Promise<string> {
  const expanded = expandTilde(file);
  let content: string;
  try {
    content = await readFile(expanded, 'utf8');
  } catch {
    throw new ConfigError(`cannot read SSH public key file: ${expanded}`);
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith('ssh-') && !trimmed.startsWith('ecdsa-')) {
    throw new ConfigError(`${expanded} does not look like an SSH public key file`);
  }
  return trimmed;
}

function pickUbuntuImage(images: readonly Image[]): Image {
  const ubuntu = images.filter((image) => image.operatingSystem === 'Canonical Ubuntu');
  const best = [...ubuntu].sort((a, b) => {
    const versionA = Number.parseFloat(a.operatingSystemVersion);
    const versionB = Number.parseFloat(b.operatingSystemVersion);
    if (versionA !== versionB) return versionB - versionA;
    return (b.timeCreated ?? '').localeCompare(a.timeCreated ?? '');
  });
  const chosen = best[0];
  if (chosen === undefined) {
    throw new ConfigError('no Canonical Ubuntu image is available for the selected shape');
  }
  return chosen;
}

// ------------------------------------------------------------------- deployment plan

export interface DeploymentPlan {
  readonly region: string;
  readonly compartmentId: string;
  readonly compartmentName: string | null;
  readonly networkMode: NetworkMode;
  readonly vcnId: string | null;
  readonly vcnName: string | null;
  readonly subnetId: string | null;
  readonly subnetName: string | null;
  readonly newVcn: { name: string; cidr: string; subnetCidr: string } | null;
  readonly architecture: Architecture;
  readonly shape: string;
  readonly shapeIsFlex: boolean;
  readonly ocpus: number | null;
  readonly memoryGbs: number | null;
  readonly diskGbs: number;
  readonly instanceName: string;
  readonly assignPublicIp: boolean;
  readonly sshKeyFile: string;
  readonly sshPublicKey: string;
  readonly intervalSeconds: number;
  readonly image: Image;
}

export function validateDisk(diskGbs: number): number {
  if (!Number.isInteger(diskGbs) || diskGbs < LIMITS.diskMinGb || diskGbs > LIMITS.diskMaxGb) {
    throw new ConfigError(`disk size must be an integer between ${LIMITS.diskMinGb} and ${LIMITS.diskMaxGb} GB (got ${diskGbs})`);
  }
  return diskGbs;
}

export function validateFlexResources(shapeIsFlex: boolean, ocpus: number | null, memoryGbs: number | null): { ocpus: number | null; memoryGbs: number | null } {
  if (!shapeIsFlex) return { ocpus: null, memoryGbs: null };
  if (ocpus === null || ocpus < 1 || ocpus > LIMITS.ocpusMax) throw new ConfigError(`OCPUs must be an integer between 1 and ${LIMITS.ocpusMax}`);
  if (memoryGbs === null || memoryGbs < 1 || memoryGbs > LIMITS.memoryMaxGbs) throw new ConfigError(`memory must be between 1 and ${LIMITS.memoryMaxGbs} GB`);
  return { ocpus, memoryGbs };
}

function validateInstanceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new ConfigError('instance name must not be empty');
  if (trimmed.length > 255) throw new ConfigError('instance name must be at most 255 characters');
  return trimmed;
}

async function resolveImage(oci: Oci, compartmentId: string, architecture: Architecture, shape: string): Promise<Image> {
  const shapes = await oci.listShapes(compartmentId, (await oci.listAvailabilityDomains(compartmentId))[0] ?? '');
  if (!shapes.includes(shape)) {
    throw new ConfigError(`shape ${shape} is not available for this compartment (architecture ${architecture})`);
  }
  return pickUbuntuImage(await oci.listImages(compartmentId, shape));
}

async function selectArchitecture(io: IO): Promise<Architecture> {
  const choice = await io.select('CPU architecture', [
    { value: 'arm64', label: 'ARM64' },
    { value: 'x86_64', label: 'x86_64' },
  ]);
  return choice === 'x86_64' ? 'x86_64' : 'arm64';
}

async function buildPlanInteractive(
  io: IO,
  oci: Oci,
  auth: OciAuth,
  resolved: ResolvedConfig,
): Promise<DeploymentPlan> {
  const compartments = await oci.listCompartments();
  const compartmentOptions: SelectOption[] = [
    ...compartments.map((c) => ({ value: c.id, label: c.name })),
    { value: auth.tenancy, label: 'Tenancy (root)' },
  ];
  const compartmentId =
    resolved.compartmentId ??
    (await io.select('Select a compartment', compartmentOptions, compartments[0]?.id ?? auth.tenancy));
  const compartment = compartments.find((c) => c.id === compartmentId);
  const compartmentName = compartment?.name ?? (compartmentId === auth.tenancy ? 'Tenancy (root)' : compartmentId);

  let networkMode = resolved.networkMode;
  let vcnId = resolved.vcnId;
  let vcnName: string | null = null;
  let subnetId = resolved.subnetId;
  let subnetName: string | null = null;
  let newVcn: { name: string; cidr: string; subnetCidr: string } | null = null;

  if (networkMode === null) {
    const choice = await io.select('Network configuration', [
      { value: 'existing', label: 'Use an existing VCN' },
      { value: 'create', label: 'Create a new VCN' },
    ]);
    networkMode = choice === 'create' ? 'create' : 'existing';
  }
  if (networkMode === 'create') {
    const name = await io.text('VCN name', { initial: APP_DEFAULTS.vcnName, validate: (v) => (v.trim() === '' ? 'required' : undefined) });
    const cidr = await io.text('VCN CIDR', { initial: APP_DEFAULTS.vcnCidr });
    const subnetCidr = await io.text('Subnet CIDR', { initial: APP_DEFAULTS.subnetCidr });
    newVcn = { name: name.trim(), cidr: cidr.trim(), subnetCidr: subnetCidr.trim() };
  } else {
    const vcns = await oci.listVcns(compartmentId);
    if (vcnId === null) {
      if (vcns.length === 0) throw new ConfigError('no VCNs found in this compartment; choose "Create a new VCN"');
      vcnId = await io.select(
        'Available VCNs',
        vcns.map((vcn) => ({ value: vcn.id, label: vcn.displayName ?? vcn.id })),
      );
    }
    const vcn = vcns.find((v) => v.id === vcnId);
    if (vcn === undefined) throw new ConfigError(`VCN ${vcnId} not found in compartment ${compartmentName}`);
    vcnName = vcn.displayName ?? vcn.id;
    const subnets = await oci.listSubnets(compartmentId, vcn.id);
    if (subnetId === null) {
      if (subnets.length === 0) throw new ConfigError(`no subnets found in VCN ${vcnName}`);
      subnetId = await io.select(
        'Subnet',
        subnets.map((s) => ({ value: s.id, label: s.displayName ?? s.id })),
      );
    }
    const subnet = subnets.find((s) => s.id === subnetId);
    if (subnet === undefined) throw new ConfigError(`subnet ${subnetId} not found in VCN ${vcnName}`);
    subnetName = subnet.displayName ?? subnet.id;
  }

  const architecture: Architecture = resolved.architecture ?? (await selectArchitecture(io));

  let shape = resolved.shape;
  if (shape === null) {
    const ads = await oci.listAvailabilityDomains(compartmentId);
    const firstAd = ads[0];
    if (firstAd === undefined) throw new ConfigError('no Availability Domains found in this compartment');
    const allShapes = await oci.listShapes(compartmentId, firstAd);
    const compatible = shapesForArchitecture(allShapes, architecture);
    if (compatible.length === 0) throw new ConfigError(`no shapes found for architecture ${architecture}`);
    shape = await io.select(
      'Shape',
      compatible.map((s) => ({ value: s, label: s })),
      compatible.includes(APP_DEFAULTS.shape[architecture]) ? APP_DEFAULTS.shape[architecture] : undefined,
    );
  }
  const shapeIsFlex = isFlexShape(shape);
  const ocpusInput =
    shapeIsFlex && resolved.ocpus === null
      ? Number(
          await io.text('OCPUs', {
            initial: String(APP_DEFAULTS.ocpus),
            validate: (v) => {
              const n = Number(v);
              return Number.isInteger(n) && n >= 1 && n <= LIMITS.ocpusMax ? undefined : `OCPUs must be an integer between 1 and ${LIMITS.ocpusMax}`;
            },
          }),
        )
      : resolved.ocpus;
  const memoryInput =
    shapeIsFlex && resolved.memoryGbs === null
      ? Number(
          await io.text('Memory (GB)', {
            initial: String(APP_DEFAULTS.memoryGbs),
            validate: (v) => {
              const n = Number(v);
              return Number.isFinite(n) && n >= 1 && n <= LIMITS.memoryMaxGbs ? undefined : `memory must be between 1 and ${LIMITS.memoryMaxGbs} GB`;
            },
          }),
        )
      : resolved.memoryGbs;
  const { ocpus, memoryGbs } = validateFlexResources(shapeIsFlex, ocpusInput, memoryInput);

  const diskGbs = validateDisk(
    resolved.diskGbs ??
      Number(
        await io.text('Disk size (GB)', {
          initial: String(APP_DEFAULTS.diskGbs),
          validate: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < LIMITS.diskMinGb || n > LIMITS.diskMaxGb) {
              return `disk size must be an integer between ${LIMITS.diskMinGb} and ${LIMITS.diskMaxGb} GB`;
            }
            return undefined;
          },
        }),
      ),
  );

  const instanceName = validateInstanceName(
    resolved.instanceName ??
      (await io.text('Instance name', {
        initial: APP_DEFAULTS.instanceName,
        validate: (v) => (v.trim() === '' ? 'required' : undefined),
      })),
  );

  const detectedKey = await detectSshPublicKeyFile();
  const sshKeyFile =
    resolved.sshKeyFile ??
    detectedKey ??
    (await io.text('SSH public key file', {
      initial: '~/.ssh/id_ed25519.pub',
      validate: (v) => (v.trim() === '' ? 'required' : undefined),
    }));

  const assignPublicIp = resolved.assignPublicIp ?? (await io.confirm('Assign a public IP address?', true));

  const intervalSeconds = resolved.intervalSeconds ?? APP_DEFAULTS.intervalSeconds;
  const region = resolved.region ?? auth.region;
  const image = await resolveImage(oci, compartmentId, architecture, shape);
  const sshPublicKey = await readSshPublicKey(sshKeyFile);

  return {
    region,
    compartmentId,
    compartmentName,
    networkMode,
    vcnId,
    vcnName,
    subnetId,
    subnetName,
    newVcn,
    architecture,
    shape,
    shapeIsFlex,
    ocpus,
    memoryGbs,
    diskGbs,
    instanceName,
    assignPublicIp,
    sshKeyFile,
    sshPublicKey,
    intervalSeconds,
    image,
  };
}

async function buildPlanJson(oci: Oci, auth: OciAuth, resolved: ResolvedConfig): Promise<DeploymentPlan> {
  if (resolved.compartmentId === null) throw new ConfigError('--json mode requires --compartment-id');
  const networkMode = resolved.networkMode ?? APP_DEFAULTS.networkMode;
  const vcnId = resolved.vcnId;
  const subnetId = resolved.subnetId;
  const newVcn: { name: string; cidr: string; subnetCidr: string } | null =
    networkMode === 'create'
      ? { name: APP_DEFAULTS.vcnName, cidr: APP_DEFAULTS.vcnCidr, subnetCidr: APP_DEFAULTS.subnetCidr }
      : null;
  if (networkMode === 'existing') {
    if (vcnId === null) throw new ConfigError('--json mode requires --vcn-id for network mode "existing"');
    if (subnetId === null) throw new ConfigError('--json mode requires --subnet-id for network mode "existing"');
  }
  const architecture = resolved.architecture ?? APP_DEFAULTS.architecture;
  const shape = resolved.shape ?? APP_DEFAULTS.shape[architecture];
  const { ocpus, memoryGbs } = validateFlexResources(isFlexShape(shape), resolved.ocpus ?? APP_DEFAULTS.ocpus, resolved.memoryGbs ?? APP_DEFAULTS.memoryGbs);
  const diskGbs = validateDisk(resolved.diskGbs ?? APP_DEFAULTS.diskGbs);
  const instanceName = validateInstanceName(resolved.instanceName ?? APP_DEFAULTS.instanceName);
  const detected = await detectSshPublicKeyFile();
  const sshKeyFile = resolved.sshKeyFile ?? detected;
  if (sshKeyFile === null) throw new ConfigError('--json mode requires --ssh-key when no default SSH public key is detected');
  const intervalSeconds = resolved.intervalSeconds ?? APP_DEFAULTS.intervalSeconds;
  const region = resolved.region ?? auth.region;
  const image = await resolveImage(oci, resolved.compartmentId, architecture, shape);
  const sshPublicKey = await readSshPublicKey(sshKeyFile);
  return {
    region,
    compartmentId: resolved.compartmentId,
    compartmentName: null,
    networkMode,
    vcnId,
    vcnName: vcnId,
    subnetId,
    subnetName: subnetId,
    newVcn,
    architecture,
    shape,
    shapeIsFlex: isFlexShape(shape),
    ocpus,
    memoryGbs,
    diskGbs,
    instanceName,
    assignPublicIp: resolved.assignPublicIp ?? APP_DEFAULTS.assignPublicIp,
    sshKeyFile,
    sshPublicKey,
    intervalSeconds,
    image,
  };
}

// ------------------------------------------------------------------- networking

interface NetworkResult {
  readonly vcnId: string;
  readonly subnetId: string;
  readonly vcnName: string;
  readonly subnetName: string;
  readonly subnetAd: string | null;
  readonly created: boolean;
}

async function prepareNetwork(oci: Oci, compartmentId: string, plan: DeploymentPlan): Promise<NetworkResult> {
  if (plan.networkMode === 'create') {
    const spec = plan.newVcn ?? { name: APP_DEFAULTS.vcnName, cidr: APP_DEFAULTS.vcnCidr, subnetCidr: APP_DEFAULTS.subnetCidr };
    const vcn = await oci.createVcn({ compartmentId, displayName: spec.name, cidr: spec.cidr });
    const gateway = await oci.createInternetGateway({ compartmentId, vcnId: vcn.id, displayName: `${spec.name}-igw` });
    if (vcn.defaultRouteTableId !== null && vcn.defaultRouteTableId !== undefined) {
      await oci.updateRouteTable(vcn.defaultRouteTableId, [
        {
          destination: '0.0.0.0/0',
          destinationType: 'CIDR_BLOCK',
          networkEntityId: gateway.id,
          routeType: 'STATIC',
        },
      ]);
    }
    if (vcn.defaultSecurityListId !== null && vcn.defaultSecurityListId !== undefined) {
      const securityList = await oci.getSecurityList(vcn.defaultSecurityListId);
      const sshRule = {
        source: '0.0.0.0/0',
        sourceType: 'CIDR',
        protocol: '6',
        isStateless: false,
        tcpOptions: { destinationPortRange: { min: 22, max: 22, sourcePortRange: { min: 1, max: 65535 } } },
      };
      await oci.updateSecurityList(
        vcn.defaultSecurityListId,
        [...(securityList.ingressSecurityRules ?? []), sshRule],
        securityList.egressSecurityRules ?? [],
      );
    }
    const subnetName = `${spec.name}-subnet`;
    const subnet = await oci.createSubnet({ compartmentId, vcnId: vcn.id, displayName: subnetName, cidr: spec.subnetCidr });
    return { vcnId: vcn.id, subnetId: subnet.id, vcnName: spec.name, subnetName, subnetAd: subnet.availabilityDomain ?? null, created: true };
  }
  const vcnId = plan.vcnId ?? '';
  const subnetId = plan.subnetId ?? '';
  if (vcnId === '' || subnetId === '') {
    throw new ConfigError('existing network mode requires a VCN and a subnet');
  }
  const vcns = await oci.listVcns(compartmentId);
  const vcn = vcns.find((v) => v.id === vcnId);
  if (vcn === undefined) throw new ConfigError(`VCN ${vcnId} not found in the selected compartment`);
  const subnets = await oci.listSubnets(compartmentId, vcnId);
  const subnet = subnets.find((s) => s.id === subnetId);
  if (subnet === undefined) throw new ConfigError(`subnet ${subnetId} not found in VCN ${vcn.displayName ?? vcnId}`);
  return {
    vcnId,
    subnetId,
    vcnName: vcn.displayName ?? vcnId,
    subnetName: subnet.displayName ?? subnetId,
    subnetAd: subnet.availabilityDomain ?? null,
    created: false,
  };
}

// ---------------------------------------------------------------------- engine

export type DeployOutcome =
  | { readonly kind: 'succeeded'; readonly instanceId: string; readonly ad: string; readonly attempt: number; readonly logPath: string }
  | { readonly kind: 'exists'; readonly instanceId: string }
  | { readonly kind: 'failed'; readonly failure: Failure; readonly message: string; readonly logPath: string | null }
  | { readonly kind: 'cancelled'; readonly logPath: string | null };

async function findExistingInstance(oci: Oci, compartmentId: string, displayName: string): Promise<Instance | undefined> {
  const instances = await oci.listInstances(compartmentId, displayName);
  return instances.find(
    (instance) => instance.displayName === displayName && instance.lifecycleState !== 'TERMINATED' && instance.lifecycleState !== 'TERMINATING',
  );
}

function humanizeInterval(seconds: number): string {
  return seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
}

function formatNextRetry(now: Date, intervalSeconds: number): string {
  return new Date(now.getTime() + intervalSeconds * 1000).toTimeString().slice(0, 8);
}

export interface EngineDeps {
  readonly io: IO;
  readonly oci: Oci;
  readonly now: () => Date;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal | undefined;
  readonly logsDir: string;
  readonly onCycleFailed: (message: string, code: string) => Promise<void>;
}

export async function deployWithRetry(
  ctx: {
    compartmentId: string;
    displayName: string;
    shape: string;
    shapeIsFlex: boolean;
    ocpus: number | null;
    memoryGbs: number | null;
    diskGbs: number;
    subnetId: string;
    assignPublicIp: boolean;
    imageId: string;
    architecture: Architecture;
    sshPublicKey: string;
  },
  availabilityDomains: readonly string[],
  intervalSeconds: number,
  deps: EngineDeps,
): Promise<DeployOutcome> {
  let attempt = 0;
  let lastLogPath: string | null = null;
  let lastMessage = '';
  let lastCode = '';
  for (;;) {
    const existing = await findExistingInstance(deps.oci, ctx.compartmentId, ctx.displayName);
    if (existing !== undefined) return { kind: 'exists', instanceId: existing.id };

    for (const ad of availabilityDomains) {
      if (deps.signal?.aborted) return { kind: 'cancelled', logPath: lastLogPath };
      attempt += 1;
      const timestamp = deps.now().toISOString();
      const logBase = {
        timestamp,
        attempt,
        availabilityDomain: ad,
        instance: ctx.displayName,
        architecture: ctx.architecture,
        shape: ctx.shape,
        ocpus: ctx.ocpus,
        memory: ctx.memoryGbs,
        disk: ctx.diskGbs,
        operation: 'LaunchInstance' as const,
      };
      lastLogPath = join(deps.logsDir, attemptLogFileName(timestamp, attempt, ad));
      deps.io.message(`Trying ${shortAd(ad)}...`);
      try {
        const instance = await deps.oci.launchInstance(
          buildLaunchBody({ ...ctx, availabilityDomain: ad }),
        );
        await writeAttemptLog(deps.logsDir, attemptLogFileName(timestamp, attempt, ad), buildAttemptLog({ ...logBase, result: 'SUCCEEDED' }));
        return { kind: 'succeeded', instanceId: instance.id, ad, attempt, logPath: lastLogPath };
      } catch (error) {
        const failure = classifyFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        lastMessage = message;
        lastCode = failure.code;
        await writeAttemptLog(
          deps.logsDir,
          attemptLogFileName(timestamp, attempt, ad),
          buildAttemptLog({ ...logBase, result: 'FAILED', errorCode: failure.code, error: message }),
        );
        if (!failure.retryable) {
          return { kind: 'failed', failure, message, logPath: lastLogPath };
        }
        deps.io.error(`${shortAd(ad)}: ${failure.code === 'OUT_OF_CAPACITY' ? 'Out of capacity' : message}`);
      }
    }

    await deps.onCycleFailed(lastMessage, lastCode);
    deps.io.message('\nNo Availability Domain currently has capacity.\n');
    deps.io.message(`Retrying in ${humanizeInterval(intervalSeconds)}.\n`);
    deps.io.message(`  Attempt:       ${attempt}`);
    deps.io.message(`  Last error:    ${lastMessage}`);
    deps.io.message(`  Next retry:    ${formatNextRetry(deps.now(), intervalSeconds)}\n`);
    deps.io.message('Press Ctrl+C to stop.\n');
    await deps.sleep(intervalSeconds * 1000, deps.signal);
    if (deps.signal?.aborted) return { kind: 'cancelled', logPath: lastLogPath };
  }
}

// ------------------------------------------------------------------ yaml output

function buildDefaultsOut(plan: DeploymentPlan, region: string, network: NetworkResult): Record<string, unknown> {
  return {
    region,
    architecture: plan.architecture,
    compartment_id: plan.compartmentId,
    network: { mode: 'existing', vcn_id: network.vcnId, subnet_id: network.subnetId },
    instance: {
      name: plan.instanceName,
      shape: plan.shape,
      ...(plan.ocpus === null ? {} : { ocpus: plan.ocpus }),
      ...(plan.memoryGbs === null ? {} : { memory_gbs: plan.memoryGbs }),
      disk_gbs: plan.diskGbs,
      assign_public_ip: plan.assignPublicIp,
    },
    ssh: { public_key_file: plan.sshKeyFile },
    retry: { interval_seconds: plan.intervalSeconds },
  };
}

// ------------------------------------------------------------------------ run

export interface RunDeps {
  readonly fetchFn?: typeof fetch;
  readonly endpointOverride?: string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly logsDir?: string;
}

export async function run(cli: CliOverrides, io: IO, deps: RunDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((res) => {
        if (signal?.aborted) {
          res();
          return;
        }
        const timer = setTimeout(() => res(), ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          res();
        }, { once: true });
      }));
  const configPath = cli.configPath ?? DEFAULT_CONFIG_FILE;
  const logsDir = deps.logsDir ?? LOGS_DIR;
  let plan: DeploymentPlan | null = null;
  let loaded: { data: YamlConfig; raw: Record<string, unknown> } | null = null;
  let lastLogPath: string | null = null;

  try {
    loaded = await loadYamlConfig(configPath);
    const resolved = resolveConfig(loaded.data.defaults, cli);
    const auth = await loadOciAuth(cli.profile);
    const oci = new Oci(auth, { fetchFn: deps.fetchFn, endpointOverride: deps.endpointOverride, now });

    io.intro(`${APP.name} v${APP.version}`);
    plan = cli.jsonMode ? await buildPlanJson(oci, auth, resolved) : await buildPlanInteractive(io, oci, auth, resolved);

    const allAds = await oci.listAvailabilityDomains(plan.compartmentId);
    const existing = await computeExistingStorage(oci, plan.compartmentId, allAds);
    const storage = projectStorage(existing.totalGb, existing.items, plan.diskGbs);

    if (io.interactive) {
      renderStorageWarning(io, storage);
      if (storage.exceedsWarn && !cli.yes) {
        const proceed = await io.confirm('Continue?', true);
        if (!proceed) throw new CancelledError();
      }
      renderSummary(io, plan, storage, allAds);
      if (!cli.yes) {
        const deploy = await io.confirm('Deploy this infrastructure?', true);
        if (!deploy) throw new CancelledError();
      }
    }

    io.message('Starting deployment...\n');
    io.step('Configuration validated');
    io.step('OCI connection verified');
    const network = await prepareNetwork(oci, plan.compartmentId, plan);
    io.step('Network ready');
    const engineAds = network.subnetAd === null || network.subnetAd === undefined ? allAds : [network.subnetAd];
    io.step(`Found ${engineAds.length} Availability Domains`);

    const outcome = await deployWithRetry(
      {
        compartmentId: plan.compartmentId,
        displayName: plan.instanceName,
        shape: plan.shape,
        shapeIsFlex: plan.shapeIsFlex,
        ocpus: plan.ocpus,
        memoryGbs: plan.memoryGbs,
        diskGbs: plan.diskGbs,
        subnetId: network.subnetId,
        assignPublicIp: plan.assignPublicIp,
        imageId: plan.image.id,
        architecture: plan.architecture,
        sshPublicKey: plan.sshPublicKey,
      },
      engineAds,
      plan.intervalSeconds,
      {
        io,
        oci,
        now,
        sleep,
        signal: deps.signal,
        logsDir,
        onCycleFailed: async (message, code) => {
          if (plan !== null && loaded !== null) {
            const lastError: LastErrorOut = { timestamp: now().toISOString(), code, message };
            loaded = { raw: loaded.raw, data: { ...loaded.data, last_error: lastError } };
            await saveYamlConfig(configPath, loaded.raw, {
              defaults: buildDefaultsOut(plan, plan.region, network),
              state: loaded.data.state ?? {},
              last_error: lastError,
            });
          }
        },
      },
    );

    switch (outcome.kind) {
      case 'exists': {
        io.success(`Instance "${plan.instanceName}" already exists.\n\n  OCID: ${outcome.instanceId}\n\nNothing else to do.`);
        io.outro('Done.');
        if (cli.jsonMode) {
          writeJson({ status: 'exists', instance_id: outcome.instanceId, instance_name: plan.instanceName });
        }
        return EXIT.success;
      }
      case 'succeeded': {
        lastLogPath = outcome.logPath;
        const state = {
          last_deployment: {
            status: 'succeeded',
            timestamp: now().toISOString(),
            instance_id: outcome.instanceId,
            instance_name: plan.instanceName,
            availability_domain: outcome.ad,
            architecture: plan.architecture,
            shape: plan.shape,
            disk_gbs: plan.diskGbs,
            ...(plan.ocpus === null ? {} : { ocpus: plan.ocpus }),
            ...(plan.memoryGbs === null ? {} : { memory_gbs: plan.memoryGbs }),
            public_ip: plan.assignPublicIp,
            vcn_id: network.vcnId,
            subnet_id: network.subnetId,
          },
        };
        await saveYamlConfig(configPath, loaded.raw, {
          defaults: buildDefaultsOut(plan, plan.region, network),
          state,
          last_error: loaded.data.last_error ?? {},
        });
        io.success('Instance created');
        io.message('\nDeployment successful\n');
        io.message(`  Instance:       ${plan.instanceName}`);
        io.message(`  Instance OCID:  ${outcome.instanceId}`);
        io.message(`  Architecture:   ${plan.architecture === 'arm64' ? 'ARM64' : 'x86_64'}`);
        io.message(`  Shape:          ${plan.shape}`);
        io.message(`  AD:             ${shortAd(outcome.ad)}`);
        io.message(`\nConfiguration saved to:\n  ${configPath}`);
        io.outro('Done.');
        if (cli.jsonMode) {
          writeJson({
            status: 'succeeded',
            instance_id: outcome.instanceId,
            instance_name: plan.instanceName,
            availability_domain: outcome.ad,
            architecture: plan.architecture,
            shape: plan.shape,
            ocpus: plan.ocpus,
            memory_gbs: plan.memoryGbs,
            disk_gbs: plan.diskGbs,
            public_ip: plan.assignPublicIp,
            network: { mode: plan.networkMode, vcn_id: network.vcnId, subnet_id: network.subnetId, created: network.created },
            attempts: outcome.attempt,
            config_path: configPath,
            last_log: outcome.logPath,
          });
        }
        return EXIT.success;
      }
      case 'cancelled': {
        lastLogPath = outcome.logPath;
        return finishCancelled(cli, io, configPath, loaded, plan, network, lastLogPath, now);
      }
      case 'failed': {
        lastLogPath = outcome.logPath;
        await saveFailureState(configPath, loaded, plan, network, outcome.failure, outcome.message, now);
        io.error('Deployment failed\n');
        io.message(`Reason:\n  ${outcome.message}\n`);
        io.message('This error is not retryable.\n');
        io.message(`${failureAdvice(outcome.failure.kind)}\n`);
        if (outcome.logPath !== null) io.message(`Attempt log:\n  ${outcome.logPath}`);
        io.outro('Failed.');
        if (cli.jsonMode) {
          writeJson({ error: { code: outcome.failure.code, message: outcome.message, attempt_log: outcome.logPath } });
        }
        return outcome.failure.exitCode;
      }
      default:
        return assertNever(outcome);
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      return finishCancelled(cli, io, configPath, loaded, plan, null, lastLogPath, now);
    }
    const failure = classifyFailure(error);
    if (plan !== null && loaded !== null) {
      await saveFailureState(configPath, loaded, plan, null, failure, failure.message, now);
    }
    if (error instanceof OciConfigError) {
      io.error('OCI configuration not found.\n');
      if (!probeBinary('oci')) {
        io.message('The OCI CLI is not installed. Install it first:\n');
        io.message('  https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm\n');
      }
      io.message('Configure OCI first:\n');
      io.message('  oci setup config\n');
      io.message('\nThen run:\n');
      io.message('  bunx oci-free-vm\n');
    } else {
      io.error(failure.message);
      io.message(`${failureAdvice(failure.kind)}\n`);
      if (lastLogPath !== null) io.message(`Attempt log:\n  ${lastLogPath}`);
    }
    if (cli.jsonMode) {
      const cliHint =
        error instanceof OciConfigError && !probeBinary('oci')
          ? ' Install the OCI CLI first: https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm'
          : '';
      writeJson({ error: { code: failure.code, message: `${failure.message}${cliHint}` } });
    } else {
      io.outro('Failed.');
    }
    return failure.exitCode;
  }
}

async function saveFailureState(
  configPath: string,
  loaded: { data: YamlConfig; raw: Record<string, unknown> },
  plan: DeploymentPlan,
  network: NetworkResult | null,
  failure: Failure,
  message: string,
  now: () => Date,
): Promise<void> {
  await saveYamlConfig(configPath, loaded.raw, {
    defaults: buildDefaultsOut(plan, plan.region, network ?? { vcnId: plan.vcnId ?? '', subnetId: plan.subnetId ?? '', vcnName: plan.vcnName ?? '', subnetName: plan.subnetName ?? '', subnetAd: null, created: false }),
    state: loaded.data.state ?? {},
    last_error: { timestamp: now().toISOString(), code: failure.code, message },
  });
}

async function finishCancelled(
  cli: CliOverrides,
  io: IO,
  configPath: string,
  loaded: { data: YamlConfig; raw: Record<string, unknown> } | null,
  plan: DeploymentPlan | null,
  network: NetworkResult | null,
  lastLogPath: string | null,
  now: () => Date,
): Promise<number> {
  if (loaded !== null && plan !== null) {
    const previousError = loaded.data.last_error ?? {};
    await saveYamlConfig(configPath, loaded.raw, {
      defaults: buildDefaultsOut(plan, plan.region, network ?? { vcnId: plan.vcnId ?? '', subnetId: plan.subnetId ?? '', vcnName: plan.vcnName ?? '', subnetName: plan.subnetName ?? '', subnetAd: null, created: false }),
      state: loaded.data.state ?? {},
      last_error: previousError,
    });
  }
  io.message('\nDeployment stopped.\n');
  io.message('No resources were deleted.\n');
  io.message(`Last state saved to:\n  ${configPath}\n`);
  if (lastLogPath !== null) io.message(`Last attempt log:\n  ${lastLogPath}\n`);
  io.outro('Stopped.');
  if (cli.jsonMode) {
    writeJson({ status: 'cancelled', config_path: configPath, ...(lastLogPath === null ? {} : { last_attempt_log: lastLogPath }) });
  }
  return EXIT.cancelled;
}

function renderStorageWarning(io: IO, storage: StorageReport): void {
  if (storage.existingGb === null) return;
  if (storage.exceedsWarn) {
    io.warn('Storage warning\n');
    if (storage.items.length > 0) {
      io.message('Existing instances:');
      for (const item of storage.items) io.message(`  ${item.name.padEnd(20)} ${item.gb} GB`);
      io.message('');
    }
    io.message(`Current total:  ${storage.existingGb} GB`);
    io.message(`New instance:   ${storage.newGb} GB`);
    io.message(`Projected total: ${storage.projectedGb} GB\n`);
    io.warn(`The projected total exceeds ${LIMITS.storageWarnGb} GB.`);
    io.message('This may exceed your intended storage limit.\n');
  } else {
    io.message('Storage\n');
    io.message(`Existing instances: ${storage.existingGb} GB`);
    io.message(`New instance:       ${storage.newGb} GB`);
    io.message(`Projected total:    ${storage.projectedGb} GB`);
    io.success(`Within ${LIMITS.storageWarnGb} GB.\n`);
  }
}

function renderSummary(io: IO, plan: DeploymentPlan, storage: StorageReport, ads: readonly string[]): void {
  io.message('Deployment summary\n');
  io.message(`  Region          ${plan.region}`);
  io.message(`  Compartment     ${plan.compartmentName ?? plan.compartmentId}`);
  io.message('');
  io.message('  Network');
  io.message(`    VCN           ${plan.vcnName ?? plan.vcnId ?? plan.newVcn?.name ?? ''}`);
  io.message(`    Subnet        ${plan.subnetName ?? plan.subnetId ?? plan.newVcn?.subnetCidr ?? ''}`);
  io.message(`    Mode          ${plan.networkMode === 'existing' ? 'Existing VCN' : 'New VCN'}`);
  io.message('');
  io.message('  Compute');
  io.message(`    Architecture  ${plan.architecture === 'arm64' ? 'ARM64' : 'x86_64'}`);
  io.message(`    Shape         ${plan.shape}`);
  if (plan.ocpus !== null) io.message(`    OCPUs         ${plan.ocpus}`);
  if (plan.memoryGbs !== null) io.message(`    Memory        ${plan.memoryGbs} GB`);
  io.message(`    Disk          ${plan.diskGbs} GB`);
  io.message(`    Public IP     ${plan.assignPublicIp ? 'yes' : 'no'}`);
  io.message(`    Instance      ${plan.instanceName}`);
  io.message(`    Image         ${plan.image.operatingSystem} ${plan.image.operatingSystemVersion}`);
  io.message('');
  io.message('  Availability Domains');
  for (const ad of ads) io.message(`    ${shortAd(ad)}`);
  io.message('');
  io.message('  Storage');
  io.message(`    Existing      ${storage.existingGb === null ? 'unknown' : `${storage.existingGb} GB`}`);
  io.message(`    New           ${storage.newGb} GB`);
  io.message(`    Projected     ${storage.projectedGb === null ? 'unknown' : `${storage.projectedGb} GB`}`);
  if (storage.exceedsWarn) io.warn(`Exceeds ${LIMITS.storageWarnGb} GB`);
  else io.success(`Within ${LIMITS.storageWarnGb} GB`);
  io.message('');
}

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let cli: CliOverrides;
  try {
    cli = parseCliArgs(argv);
  } catch (error) {
    const failure = error instanceof ConfigError ? { code: 'CONFIG', message: error.message } : { code: 'UNEXPECTED', message: String(error) };
    if (argv.includes('--json')) {
      writeJson({ error: failure });
      process.exit(EXIT.invalidConfig);
      return;
    }
    process.stderr.write(`✗ ${failure.message}\n`);
    process.exit(failure.code === 'CONFIG' ? EXIT.invalidConfig : EXIT.unexpected);
  }
  if (cli.help) {
    printUsage();
    process.exit(EXIT.success);
  }
  if (cli.version) {
    process.stdout.write(`${APP.version}\n`);
    process.exit(EXIT.success);
  }
  const io = cli.jsonMode ? jsonIo() : interactiveIo();
  if (io.interactive && process.stdout.isTTY !== true) {
    process.stderr.write('✗ oci-free-vm needs an interactive terminal. Use --json for non-interactive use.\n');
    process.exit(EXIT.invalidConfig);
  }
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);
  const code = await run(cli, io, { signal: controller.signal });
  process.off('SIGINT', onSigint);
  process.exit(code);
}

function invokedAsMain(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // no-excuse-ok: catch — fall back to not running (tests import this module)
  }
}

if (invokedAsMain()) {
  void main();
}
