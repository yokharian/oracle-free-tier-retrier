#!/usr/bin/env node
// oci-free-vm — deploy an OCI VM and automatically retry when capacity is unavailable.
// Entry point and domain logic; shared types live in types.ts, pure helpers in utils.ts.

import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import process from 'node:process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as ociCommon from 'oci-common';
import * as ociCore from 'oci-core';
import * as ociIdentity from 'oci-identity';
import { APP, DEFAULT_CONFIG_FILE, LOGS_DIR, LIMITS, EXIT, APP_DEFAULTS } from './types.ts';
import type { Architecture, BootVolume, CliOverrides, Compartment, DeploymentPlan, Failure, Image, Instance, IO, LaunchInstanceDetails, LastErrorOut, NetworkMode, OciAuth, ResolvedConfig, RouteTable, SecurityList, SelectOption, StorageReport, Subnet, Vcn, YamlConfig } from './types.ts';
import {
  CancelledError, ConfigError, NetworkError, OciConfigError, OciHttpError, appVersion, assertNever, attemptLogFileName, buildAttemptLog, buildLaunchBody, classifyFailure, detectSshPublicKeyFile, expandTilde, failureAdvice, isFlexShape, loadOciAuth, loadYamlConfig, parseCliArgs, pickUbuntuImage, probeBinary, projectStorage, readSshPublicKey, resolveConfig, sanitize, saveYamlConfig, shortAd, stripNulls, validateDisk, validateFlexResources,
} from './utils.ts';

export * from './types.ts';
export * from './utils.ts';

function cleanIngressRule(rule: ociCore.models.IngressSecurityRule): ociCore.models.IngressSecurityRule {
  const serialized = ociCommon.ObjectSerializer.serialize(rule, 'IngressSecurityRule');
  const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  return JSON.parse(JSON.stringify(stripNulls(parsed)));
}

function cleanEgressRule(rule: ociCore.models.EgressSecurityRule): ociCore.models.EgressSecurityRule {
  const serialized = ociCommon.ObjectSerializer.serialize(rule, 'EgressSecurityRule');
  const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  return JSON.parse(JSON.stringify(stripNulls(parsed)));
}


export class Oci {
  private readonly auth: OciAuth;
  private readonly identityClient: ociIdentity.IdentityClient;
  private readonly networkClient: ociCore.VirtualNetworkClient;
  private readonly computeClient: ociCore.ComputeClient;
  private readonly blockstorageClient: ociCore.BlockstorageClient;

  constructor(
    auth: OciAuth,
    deps: { endpointOverride?: string | undefined } = {},
  ) {
    this.auth = auth;
    const provider = new ociCommon.SimpleAuthenticationDetailsProvider(
      auth.tenancy,
      auth.user,
      auth.fingerprint,
      auth.privateKeyPem,
      auth.passphrase ?? null,
      ociCommon.Region.fromRegionId(auth.region),
    );
    this.identityClient = new ociIdentity.IdentityClient({ authenticationDetailsProvider: provider });
    this.networkClient = new ociCore.VirtualNetworkClient({ authenticationDetailsProvider: provider });
    this.computeClient = new ociCore.ComputeClient({ authenticationDetailsProvider: provider });
    this.blockstorageClient = new ociCore.BlockstorageClient({ authenticationDetailsProvider: provider });
    const endpoint = deps.endpointOverride ?? process.env['OCI_FREE_VM_ENDPOINT'];
    if (endpoint !== undefined) {
      for (const client of [this.identityClient, this.networkClient, this.computeClient, this.blockstorageClient]) {
        client.endpoint = endpoint;
      }
    }
  }

  private async call<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ociCommon.OciError) {
        const code = error.serviceCode === '' ? undefined : error.serviceCode;
        throw new OciHttpError(operation, error.statusCode, code, sanitize(error.message));
      }
      if (
        error instanceof TypeError ||
        (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
        (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E(CONN|TIMEDOUT|NOTFOUND|AI_AGAIN|CONNREFUSED|CONNRESET|HOSTUNREACH)/.test(error.code))
      ) {
        throw new NetworkError(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  async listCompartments(): Promise<Compartment[]> {
    return this.call('ListCompartments', async () => {
      const response = await this.identityClient.listCompartments({
        compartmentId: this.auth.tenancy,
        compartmentIdInSubtree: true,
        accessLevel: ociIdentity.requests.ListCompartmentsRequest.AccessLevel.Accessible,
        lifecycleState: ociIdentity.models.Compartment.LifecycleState.Active,
      });
      return (response.items ?? []).map(
        (compartment): Compartment => ({
          id: compartment.id ?? '',
          name: compartment.name ?? '',
          lifecycleState: compartment.lifecycleState ?? '',
        }),
      );
    });
  }

  async listAvailabilityDomains(compartmentId: string): Promise<string[]> {
    return this.call('ListAvailabilityDomains', async () => {
      const response = await this.identityClient.listAvailabilityDomains({ compartmentId });
      return (response.items ?? []).map((ad) => ad.name ?? '');
    });
  }

  async listVcns(compartmentId: string): Promise<Vcn[]> {
    return this.call('ListVcns', async () => {
      const response = await this.networkClient.listVcns({ compartmentId });
      return (response.items ?? []).map(
        (vcn): Vcn => ({
          id: vcn.id ?? '',
          displayName: vcn.displayName ?? null,
          defaultRouteTableId: vcn.defaultRouteTableId ?? undefined,
          defaultSecurityListId: vcn.defaultSecurityListId ?? undefined,
        }),
      );
    });
  }

  async listSubnets(compartmentId: string, vcnId: string): Promise<Subnet[]> {
    return this.call('ListSubnets', async () => {
      const response = await this.networkClient.listSubnets({ compartmentId, vcnId });
      return (response.items ?? []).map(
        (subnet): Subnet => ({
          id: subnet.id ?? '',
          displayName: subnet.displayName ?? null,
          vcnId: subnet.vcnId ?? '',
          availabilityDomain: subnet.availabilityDomain ?? undefined,
        }),
      );
    });
  }

  async listShapes(compartmentId: string, availabilityDomain: string): Promise<string[]> {
    return this.call('ListShapes', async () => {
      const response = await this.computeClient.listShapes({ compartmentId, availabilityDomain });
      return [...new Set((response.items ?? []).map((shape) => shape.shape ?? ''))].filter((s) => s !== '').sort();
    });
  }

  async listImages(compartmentId: string, shape: string): Promise<Image[]> {
    return this.call('ListImages', async () => {
      const response = await this.computeClient.listImages({
        compartmentId,
        operatingSystem: 'Canonical Ubuntu',
        shape,
        sortOrder: ociCore.requests.ListImagesRequest.SortOrder.Desc,
      });
      return (response.items ?? []).map(
        (image): Image => ({
          id: image.id ?? '',
          operatingSystem: image.operatingSystem ?? '',
          operatingSystemVersion: image.operatingSystemVersion ?? '',
          timeCreated:
            image.timeCreated === undefined || image.timeCreated === null
              ? undefined
              : image.timeCreated instanceof Date
                ? image.timeCreated.toISOString()
                : String(image.timeCreated),
        }),
      );
    });
  }

  async listInstances(compartmentId: string, displayName?: string): Promise<Instance[]> {
    return this.call('ListInstances', async () => {
      const response = await this.computeClient.listInstances({
        compartmentId,
        ...(displayName === undefined ? {} : { displayName }),
      });
      return (response.items ?? []).map(
        (instance): Instance => ({
          id: instance.id ?? '',
          displayName: instance.displayName ?? null,
          lifecycleState: instance.lifecycleState ?? '',
        }),
      );
    });
  }

  async listBootVolumes(compartmentId: string, availabilityDomain: string): Promise<BootVolume[]> {
    return this.call('ListBootVolumes', async () => {
      const response = await this.blockstorageClient.listBootVolumes({ compartmentId, availabilityDomain });
      return (response.items ?? []).map(
        (volume): BootVolume => ({ displayName: volume.displayName ?? null, sizeInGBs: volume.sizeInGBs ?? null }),
      );
    });
  }

  async launchInstance(details: LaunchInstanceDetails): Promise<Instance> {
    return this.call('LaunchInstance', async () => {
      const response = await this.computeClient.launchInstance({
        launchInstanceDetails: {
          availabilityDomain: details.availabilityDomain,
          compartmentId: details.compartmentId,
          displayName: details.displayName,
          shape: details.shape,
          ...(details.shapeConfig === undefined ? {} : { shapeConfig: details.shapeConfig }),
          sourceDetails: details.sourceDetails,
          createVnicDetails: details.createVnicDetails,
          metadata: details.metadata,
        },
      });
      const instance = response.instance;
      return { id: instance?.id ?? '', displayName: instance?.displayName ?? null, lifecycleState: instance?.lifecycleState ?? '' };
    });
  }

  async createVcn(args: { compartmentId: string; displayName: string; cidr: string }): Promise<Vcn> {
    return this.call('CreateVcn', async () => {
      const response = await this.networkClient.createVcn({
        createVcnDetails: {
          compartmentId: args.compartmentId,
          displayName: args.displayName,
          cidrBlocks: [args.cidr],
        },
      });
      const vcn = response.vcn;
      return {
        id: vcn?.id ?? '',
        displayName: vcn?.displayName ?? null,
        defaultRouteTableId: vcn?.defaultRouteTableId ?? undefined,
        defaultSecurityListId: vcn?.defaultSecurityListId ?? undefined,
      };
    });
  }

  async createInternetGateway(args: { compartmentId: string; vcnId: string; displayName: string }): Promise<{ readonly id: string }> {
    return this.call('CreateInternetGateway', async () => {
      const response = await this.networkClient.createInternetGateway({
        createInternetGatewayDetails: {
          compartmentId: args.compartmentId,
          vcnId: args.vcnId,
          displayName: args.displayName,
          isEnabled: true,
        },
      });
      return { id: response.internetGateway?.id ?? '' };
    });
  }

  async updateRouteTable(id: string, routeRules: readonly ociCore.models.RouteRule[]): Promise<RouteTable> {
    return this.call('UpdateRouteTable', async () => {
      const response = await this.networkClient.updateRouteTable({
        rtId: id,
        updateRouteTableDetails: {
          routeRules: [...routeRules],
        },
      });
      return { id: response.routeTable?.id ?? '', routeRules: response.routeTable?.routeRules ?? [] };
    });
  }

  async getSecurityList(id: string): Promise<SecurityList> {
    return this.call('GetSecurityList', async () => {
      const response = await this.networkClient.getSecurityList({ securityListId: id });
      const securityList = response.securityList;
      return {
        id: securityList?.id ?? '',
        ingressSecurityRules: (securityList?.ingressSecurityRules ?? []).map(cleanIngressRule),
        egressSecurityRules: (securityList?.egressSecurityRules ?? []).map(cleanEgressRule),
      };
    });
  }

  async updateSecurityList(
    id: string,
    ingress: readonly ociCore.models.IngressSecurityRule[],
    egress: readonly ociCore.models.EgressSecurityRule[],
  ): Promise<SecurityList> {
    return this.call('UpdateSecurityList', async () => {
      const response = await this.networkClient.updateSecurityList({
        securityListId: id,
        updateSecurityListDetails: {
          ingressSecurityRules: [...ingress],
          egressSecurityRules: [...egress],
        },
      });
      const securityList = response.securityList;
      return {
        id: securityList?.id ?? '',
        ingressSecurityRules: securityList?.ingressSecurityRules ?? [],
        egressSecurityRules: securityList?.egressSecurityRules ?? [],
      };
    });
  }

  async createSubnet(args: { compartmentId: string; vcnId: string; displayName: string; cidr: string }): Promise<Subnet> {
    return this.call('CreateSubnet', async () => {
      const response = await this.networkClient.createSubnet({
        createSubnetDetails: {
          compartmentId: args.compartmentId,
          vcnId: args.vcnId,
          displayName: args.displayName,
          cidrBlock: args.cidr,
          prohibitPublicIpOnVnic: false,
        },
      });
      const subnet = response.subnet;
      return {
        id: subnet?.id ?? '',
        displayName: subnet?.displayName ?? null,
        vcnId: subnet?.vcnId ?? '',
        availabilityDomain: subnet?.availabilityDomain ?? undefined,
      };
    });
  }
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


async function writeAttemptLog(dir: string, fileName: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, content, 'utf8');
  return path;
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


function architectureForShape(shape: string): Architecture {
  return shape.startsWith('VM.Standard.A1') ? 'arm64' : 'x86_64';
}

function shapesForArchitecture(shapes: readonly string[], architecture: Architecture): string[] {
  return shapes.filter((shape) => architectureForShape(shape) === architecture);
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
    const name = await io.text('VCN name', { initial: APP_DEFAULTS.vcnName, validate: (v) => (v.trim() === '' ? 'required' : undefined) });
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
          destinationType: ociCore.models.RouteRule.DestinationType.CidrBlock,
          networkEntityId: gateway.id,
          routeType: ociCore.models.RouteRule.RouteType.Static,
        },
      ]);
    }
    if (vcn.defaultSecurityListId !== null && vcn.defaultSecurityListId !== undefined) {
      const securityList = await oci.getSecurityList(vcn.defaultSecurityListId);
      const sshRule: ociCore.models.IngressSecurityRule = {
        source: '0.0.0.0/0',
        sourceType: ociCore.models.IngressSecurityRule.SourceType.CidrBlock,
        protocol: '6',
        isStateless: false,
        tcpOptions: { destinationPortRange: { min: 22, max: 22 }, sourcePortRange: { min: 1, max: 65535 } },
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
  readonly endpointOverride?: string | undefined;
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
    const oci = new Oci(auth, { endpointOverride: deps.endpointOverride });

    io.intro(`${APP.name} v${appVersion()}`);
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
    process.stdout.write(`${appVersion()}\n`);
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
