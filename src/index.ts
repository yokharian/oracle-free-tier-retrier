#!/usr/bin/env node
// oci-free-vm — CLI shell: terminal I/O, prompts, interactive plan building, the deployment
// summary, usage text, and the entry point. The deployment engine lives in core.ts;
// small pure helpers live in utils.ts.

import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { APP, EXIT, LIMITS, APP_DEFAULTS, BOOLEAN_FLAGS, VALUE_FLAGS } from './types.ts';
import type { Architecture, CliOverrides, DeploymentPlan, IO, NetworkMode, OciAuth, ResolvedConfig, SelectOption, StorageReport } from './types.ts';
import { CancelledError, ConfigError, appVersion, classifyFailure, detectSshPublicKeyFile, expandTilde, generateSshKeyPair, isFlexShape, nextSshKeyPath, probeBinary, readSshPublicKey, shapesForArchitecture, shortAd, validateDisk, validateFlexResources, validateInstanceName, writeJson } from './utils.ts';
import { listShapesForCompartment, resolveImage, run } from './core.ts';
import type { Oci } from './core.ts';

export * from './types.ts';
export * from './utils.ts';
export * from './core.ts';

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

function validateRequired(value: string): string | undefined {
  return value.trim() === '' ? 'required' : undefined;
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
  const compartmentDisplayName = (id: string): string => {
    const found = compartments.find((c) => c.id === id);
    return found?.name ?? (id === auth.tenancy ? 'Tenancy (root)' : id);
  };
  let compartmentId =
    resolved.compartmentId ??
    (await io.select('Select a compartment', compartmentOptions, compartments[0]?.id ?? auth.tenancy));
  let compartmentName = compartmentDisplayName(compartmentId);

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
    const name = await io.text('VCN name', { initial: APP_DEFAULTS.vcnName, validate: validateRequired });
    const cidr = await io.text('VCN CIDR', { initial: APP_DEFAULTS.vcnCidr });
    const subnetCidr = await io.text('Subnet CIDR', { initial: APP_DEFAULTS.subnetCidr });
    newVcn = { name: name.trim(), cidr: cidr.trim(), subnetCidr: subnetCidr.trim() };
  } else {
    for (;;) {
      try {
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
        break;
      } catch (error) {
        const failure = classifyFailure(error);
        if (failure.kind !== 'auth') throw error;
        io.warn(`Network discovery failed in "${compartmentName}": ${error instanceof Error ? error.message : String(error)}`);
        compartmentId = await io.select('Select a different compartment and try again', compartmentOptions, auth.tenancy);
        compartmentName = compartmentDisplayName(compartmentId);
      }
    }
  }

  const architecture: Architecture = resolved.architecture ?? (await selectArchitecture(io));

  let shape = resolved.shape;
  if (shape === null) {
    const ads = await oci.listAvailabilityDomains(compartmentId);
    if (ads.length === 0) throw new ConfigError('no Availability Domains found in this compartment');
    const allShapes = await listShapesForCompartment(oci, compartmentId);
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
        validate: validateRequired,
      })),
  );

  const detectedKey = await detectSshPublicKeyFile();
  const sshKeyFile = resolved.sshKeyFile ?? (await promptSshKeyFile(io, detectedKey));

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

export async function promptSshKeyFile(
  io: IO,
  detectedKey: string | null,
  deps: { keygenAvailable?: boolean | undefined; sshDir?: string | undefined } = {},
): Promise<string> {
  const keygenAvailable = deps.keygenAvailable ?? probeBinary('ssh-keygen');
  const sshDir = deps.sshDir ?? expandTilde('~/.ssh');
  const options: SelectOption[] = [];
  if (detectedKey !== null) options.push({ value: 'use-existing', label: 'Use existing key', hint: detectedKey });
  if (keygenAvailable) options.push({ value: 'generate', label: 'Generate a new ed25519 key pair', hint: join(sshDir, 'id_ed25519') });
  options.push({ value: 'other', label: 'Enter the path to a public key file' });
  const choice = await io.select('SSH public key', options, options[0]?.value);
  if (choice === 'generate') {
    const privateKeyPath = nextSshKeyPath(sshDir);
    const publicKeyPath = await generateSshKeyPair(privateKeyPath);
    io.success(`SSH key pair generated: ${publicKeyPath}`);
    io.message(`Private key (keep it — you need it to SSH into the instance): ${privateKeyPath}\n`);
    return publicKeyPath;
  }
  if (choice === 'use-existing') {
    if (detectedKey === null) throw new Error('internal error: "use-existing" selected without a detected key');
    return detectedKey;
  }
  return io.text('SSH public key file', {
    initial: detectedKey ?? '~/.ssh/id_ed25519.pub',
    validate: validateRequired,
  });
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
  const delay = str('delay');
  const intervalSeconds =
    delay !== undefined ? toPositiveInt('delay', delay) : toPositiveInt('interval-seconds', str('interval-seconds'));
  if (intervalSeconds !== undefined && intervalSeconds > LIMITS.maxIntervalSeconds) {
    throw new ConfigError(`--delay must be at most ${LIMITS.maxIntervalSeconds} seconds`);
  }
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
    intervalSeconds,
  };
}

export async function setupOciConfigInteractive(io: IO): Promise<void> {
  io.intro('OCI Configuration Setup');
  io.message('No OCI configuration found. Let\'s create one.');
  io.message('');

  const user = await io.text('User OCID', { validate: validateRequired });
  const tenancy = await io.text('Tenancy OCID', { validate: validateRequired });
  const fingerprint = await io.text('API Key Fingerprint', { validate: validateRequired });
  const region = await io.select('Region', [
    { value: 'us-ashburn-1', label: 'us-ashburn-1 (US East - Ashburn)' },
    { value: 'us-phoenix-1', label: 'us-phoenix-1 (US West - Phoenix)' },
    { value: 'eu-frankfurt-1', label: 'eu-frankfurt-1 (Germany Central - Frankfurt)' },
    { value: 'uk-london-1', label: 'uk-london-1 (UK South - London)' },
    { value: 'ap-tokyo-1', label: 'ap-tokyo-1 (Japan East - Tokyo)' },
    { value: 'ap-sydney-1', label: 'ap-sydney-1 (Australia East - Sydney)' },
    { value: 'sa-saopaulo-1', label: 'sa-saopaulo-1 (Brazil East - Sao Paulo)' },
    { value: 'ca-toronto-1', label: 'ca-toronto-1 (Canada Southeast - Toronto)' },
    { value: 'ap-seoul-1', label: 'ap-seoul-1 (South Korea Central - Seoul)' },
    { value: 'ap-mumbai-1', label: 'ap-mumbai-1 (India West - Mumbai)' },
    { value: 'ap-osaka-1', label: 'ap-osaka-1 (Japan Central - Osaka)' },
    { value: 'eu-zurich-1', label: 'eu-zurich-1 (Switzerland North - Zurich)' },
    { value: 'eu-madrid-1', label: 'eu-madrid-1 (Spain Central - Madrid)' },
    { value: 'me-jeddah-1', label: 'me-jeddah-1 (Saudi Arabia West - Jeddah)' },
    { value: 'me-dubai-1', label: 'me-dubai-1 (UAE East - Dubai)' },
    { value: 'ap-melbourne-1', label: 'ap-melbourne-1 (Australia Southeast - Melbourne)' },
    { value: 'ap-hyderabad-1', label: 'ap-hyderabad-1 (India South - Hyderabad)' },
  ], 'us-ashburn-1');

  const keyFile = join(homedir(), '.oci', 'oci_api_key.pem');
  const keyDir = dirname(keyFile);
  await mkdir(keyDir, { recursive: true });

  io.message('');
  io.message('Private key:');
  io.message('Paste your PEM-formatted RSA private key (including BEGIN/END lines).');
  io.message('Press Ctrl+D (or Ctrl+Z on Windows) when done.');
  io.message('');

  const privateKeyPem = await readPrivateKeyFromStdin();

  if (!privateKeyPem.trim().startsWith('-----BEGIN')) {
    throw new ConfigError('Private key must be in PEM format (start with -----BEGIN)');
  }

  try {
    createPrivateKey(privateKeyPem);
  } catch {
    throw new ConfigError('Invalid PEM private key');
  }

  await writeFile(keyFile, privateKeyPem, { mode: 0o600 });

  const configPath = join(homedir(), '.oci', 'config');
  const profile = process.env['OCI_CONFIG_PROFILE'] ?? 'DEFAULT';
  const configContent = '[' + profile + ']\n' +
    'user=' + user + '\n' +
    'tenancy=' + tenancy + '\n' +
    'fingerprint=' + fingerprint + '\n' +
    'region=' + region + '\n' +
    'key_file=' + keyFile + '\n';
  await writeFile(configPath, configContent, { mode: 0o600 });

  io.success('OCI configuration saved to ' + configPath);
  io.message('Private key saved to ' + keyFile);
  io.message('');
}

async function readPrivateKeyFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.resume();
  });
}

function printUsage(): void {
  process.stdout.write(
    [
      `${APP.name} v${appVersion()} — deploy an OCI VM and automatically retry when capacity is unavailable.`,
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
      '  --delay <n>               retry delay in seconds between AD cycles (default: 900)',
      '  --interval-seconds <n>    alias for --delay',
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
    process.stdout.write(`${appVersion()}\n`);
    process.exit(EXIT.success);
  }
  const io = cli.jsonMode ? jsonIo() : interactiveIo();
  if (io.interactive && process.stdout.isTTY !== true) {
    process.stderr.write('✗ oci-free-vm needs an interactive terminal. Use --json for non-interactive use.\n');
    process.exit(EXIT.invalidConfig);
  }
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const code = await run(cli, io, {
    signal: controller.signal,
    setupOciConfig: setupOciConfigInteractive,
    buildInteractivePlan: buildPlanInteractive,
    render: { storageWarning: renderStorageWarning, summary: renderSummary },
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
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
