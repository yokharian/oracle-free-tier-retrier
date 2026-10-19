// oci-free-vm — pure helpers: errors, classification, config, validation, naming.

import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { LIMITS, EXIT, BOOLEAN_FLAGS, VALUE_FLAGS, yamlConfigSchema } from './types.ts';
import type { Architecture, CliOverrides, Failure, FailureCode, FailureKind, Image, LaunchInstanceDetails, NetworkMode, OciAuth, ResolvedConfig, StorageReport, YamlConfig, YamlDefaults } from './types.ts';

export function assertNever(value: never): never {
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

export function failureAdvice(kind: FailureKind): string {
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

export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripNulls(item));
  if (value !== null && typeof value === 'object') {
    const kept: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== null) kept[key] = stripNulls(entry);
    }
    return kept;
  }
  return value;
}

/** Removes PEM blocks and OCI request-signature material from text bound for logs. */
export function sanitize(text: string): string {
  return text
    .replace(/-----BEGIN[ A-Z0-9]*-----[\s\S]*?-----END[ A-Z0-9]*-----/g, '[redacted key material]')
    .replace(/signature="[^"]+"/g, 'signature="[redacted]"')
    .replace(/pass[_-]?phrase\s*=\s*\S+/gi, 'pass_phrase=[redacted]');
}


let cachedAppVersion: string | undefined;

export function appVersion(): string {
  if (cachedAppVersion === undefined) {
    const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || !('version' in parsed) || typeof parsed.version !== 'string') {
      throw new Error('package.json has no valid version');
    }
    cachedAppVersion = parsed.version;
  }
  return cachedAppVersion;
}


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
    privateKeyPem: pem,
    ...(section['pass_phrase'] === undefined || section['pass_phrase'] === '' ? {} : { passphrase: section['pass_phrase'] }),
  };
}
export function probeBinary(name: string): boolean {
  const result = spawnSync(name, ['--version'], { stdio: 'ignore' });
  return result.error === undefined;
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
    createVnicDetails: { subnetId: string; assignPublicIp: boolean };
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
    createVnicDetails: { subnetId: args.subnetId, assignPublicIp: args.assignPublicIp },
    metadata: { ssh_authorized_keys: args.sshPublicKey },
  };
  return body;
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


export function isFlexShape(shape: string): boolean {
  return shape.includes('Flex');
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

export async function readSshPublicKey(file: string): Promise<string> {
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

export function pickUbuntuImage(images: readonly Image[]): Image {
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


