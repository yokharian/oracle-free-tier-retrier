// oci-free-vm — pure helpers: errors, classification, config, validation, naming.

import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { LIMITS, EXIT, LOG_FILE_NAME, yamlConfigSchema } from './types.ts';
import type { Architecture, CliOverrides, Failure, FailureKind, Image, LaunchInstanceDetails, OciAuth, ResolvedConfig, StorageReport, YamlConfig, YamlDefaults } from './types.ts';

export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}


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

interface OciRetrierError {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestEndpoint?: unknown;
  readonly troubleshootingPage?: unknown;
}

/** oci-common throws this plain object when its transport retrier gives up. */
export function isOciRetrierError(error: unknown): error is OciRetrierError {
  return typeof error === 'object' && error !== null && 'requestEndpoint' in error && 'troubleshootingPage' in error;
}

const LOCAL_FILE_ERROR_CODES = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE']);

function isLocalFileError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && LOCAL_FILE_ERROR_CODES.has(error.code);
}

/** Readable text for Error instances and the plain objects OCI tooling throws. */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === 'string' && candidate.code !== '' ? candidate.code : undefined;
    const message = typeof candidate.message === 'string' && candidate.message !== '' ? candidate.message : undefined;
    if (code !== undefined && message !== undefined) return `${code}: ${message}`;
    if (message !== undefined) return message;
    if (code !== undefined) return code;
    try {
      const json = JSON.stringify(error);
      if (json !== undefined && json !== '{}') return json;
    } catch {
      return 'unknown OCI transport error'; // no-excuse-ok: catch — diagnostics must not throw
    }
    return 'unknown OCI transport error';
  }
  return String(error);
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
  if (isOciRetrierError(error)) {
    return { kind: 'transient', retryable: true, exitCode: EXIT.deployFailed, code: 'TRANSIENT', message: `transport: ${describeThrown(error)}` };
  }
  if (isLocalFileError(error)) {
    return { kind: 'local', retryable: false, exitCode: EXIT.unexpected, code: 'LOCAL', message: describeThrown(error) };
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
    message: describeThrown(error),
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
    case 'local':
      return 'A local file operation failed. Free disk space or fix permissions for ~/.oci and ~/.ssh, then run again.';
    case 'fatal':
      return 'This error is not retryable.';
    default:
      return assertNever(kind);
  }
}


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
    defaults?: Record<string, unknown>;
    state?: Record<string, unknown>;
    last_error?: Record<string, unknown>;
  },
): Promise<void> {
  const merged: Record<string, unknown> = {
    ...raw,
    ...(sections.defaults === undefined ? {} : { defaults: sections.defaults }),
    ...(sections.state === undefined ? {} : { state: sections.state }),
    ...(sections.last_error === undefined ? {} : { last_error: sections.last_error }),
  };
  await writeFile(path, stringifyYaml(merged), 'utf8');
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

export function nextSshKeyPath(sshDir: string): string {
  const base = join(sshDir, 'id_ed25519');
  if (!existsSync(base) && !existsSync(`${base}.pub`)) return base;
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = suffix === 1 ? `${base}-oci-free-vm` : `${base}-oci-free-vm-${suffix}`;
    if (!existsSync(candidate) && !existsSync(`${candidate}.pub`)) return candidate;
  }
  throw new ConfigError(`no unused SSH key file name found in ${sshDir}`);
}

export async function generateSshKeyPair(privateKeyPath: string, comment = 'oci-free-vm'): Promise<string> {
  await mkdir(dirname(privateKeyPath), { recursive: true });
  const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', privateKeyPath, '-q'], {
    stdio: 'ignore',
    timeout: 30_000,
  });
  if (result.error !== undefined) {
    throw new ConfigError(`ssh-keygen is not available (${result.error.message}); install OpenSSH or pass --ssh-key <path> with an existing public key`);
  }
  if (result.status !== 0) {
    throw new ConfigError(`ssh-keygen failed with exit code ${result.status ?? 'unknown'}; run it manually: ssh-keygen -t ed25519 -f ${privateKeyPath}`);
  }
  return `${privateKeyPath}.pub`;
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



export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}


export function architectureForShape(shape: string): Architecture {
  return shape.startsWith('VM.Standard.A1') ? 'arm64' : 'x86_64';
}


export function shapesForArchitecture(shapes: readonly string[], architecture: Architecture): string[] {
  return shapes.filter((shape) => architectureForShape(shape) === architecture);
}


export function validateInstanceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new ConfigError('instance name must not be empty');
  if (trimmed.length > 255) throw new ConfigError('instance name must be at most 255 characters');
  return trimmed;
}


export async function appendAttemptLog(dir: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, LOG_FILE_NAME);
  await appendFile(path, `\n${'='.repeat(72)}\n${content.trimEnd()}\n`, 'utf8');
  return path;
}


export function humanizeInterval(seconds: number): string {
  return seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
}


export function formatNextRetry(now: Date, intervalSeconds: number): string {
  return new Date(now.getTime() + intervalSeconds * 1000).toTimeString().slice(0, 8);
}


export function adOrdinal(ad: string): number {
  const match = /-AD-(\d+)\s*$/i.exec(ad);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** Higher-numbered ADs first: AD-3, AD-2, AD-1. Unknown names keep their API order. */
export function sortAdsHighestFirst<T extends { readonly ad: string }>(targets: readonly T[]): T[] {
  return [...targets].sort((left, right) => adOrdinal(right.ad) - adOrdinal(left.ad));
}
