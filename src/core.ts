// oci-free-vm — deployment core: OCI client, JSON plan building, networking, the retry
// engine, and the run orchestrator. The CLI shell (prompts, interactive plan, rendering,
// entry point) is index.ts; small pure helpers live in utils.ts.

import process from 'node:process';
import * as ociCommon from 'oci-common';
import * as ociCore from 'oci-core';
import * as ociIdentity from 'oci-identity';
import { APP, DEFAULT_CONFIG_FILE, LOGS_DIR, EXIT, APP_DEFAULTS } from './types.ts';
import type { AdSkipReason, Architecture, AvailabilityDomainSpec, BootVolume, CliOverrides, Compartment, DeployOutcome, DeploymentPlan, EngineDeps, Failure, Image, Instance, IO, LaunchInstanceDetails, LastErrorOut, NetworkResult, OciAuth, OciServiceError, ResolvedConfig, RouteTable, RunDeps, SecurityList, SkippedAd, Subnet, Vcn, YamlConfig } from './types.ts';
import {
  CancelledError, ConfigError, NetworkError, OciConfigError, OciHttpError, appVersion, assertNever, buildAttemptLog, buildLaunchBody, classifyFailure, detectSshPublicKeyFile, describeThrown, failureAdvice, isFlexShape, isOciRetrierError, loadOciAuth, loadYamlConfig, pickUbuntuImage, probeBinary, projectStorage, readSshPublicKey, resolveConfig, sanitize, saveYamlConfig, shortAd, stripNulls, validateDisk, validateFlexResources,
  appendAttemptLog, formatNextRetry, humanizeInterval, sortAdsHighestFirst, validateInstanceName, writeJson,
} from './utils.ts';

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


/**
 * oci-core and oci-identity pin oci-common to an exact version, so npm can install a second
 * copy next to ours and the SDK then throws an OciError whose class is not the one we imported.
 * Match the error shape instead of the class identity so status and service code stay available
 * for failure classification.
 */
function isOciServiceError(error: unknown): error is OciServiceError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { statusCode?: unknown; serviceCode?: unknown; message?: unknown };
  return typeof candidate.statusCode === 'number' && typeof candidate.serviceCode === 'string' && typeof candidate.message === 'string';
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
      if (isOciServiceError(error)) {
        const code = error.serviceCode === '' ? undefined : error.serviceCode;
        throw new OciHttpError(operation, error.statusCode, code, sanitize(error.message));
      }
      if (isOciRetrierError(error)) {
        throw new NetworkError(`${operation}: ${describeThrown(error)}`);
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


export async function listShapesForCompartment(oci: Oci, compartmentId: string): Promise<string[]> {
  const ads = await oci.listAvailabilityDomains(compartmentId);
  if (ads.length === 0) return [];
  const shapeSets = await Promise.all(ads.map((ad) => oci.listShapes(compartmentId, ad)));
  return [...new Set(shapeSets.flat())].sort();
}

export async function resolveImage(oci: Oci, compartmentId: string, architecture: Architecture, shape: string): Promise<Image> {
  const shapes = await listShapesForCompartment(oci, compartmentId);
  if (!shapes.includes(shape)) {
    throw new ConfigError(`shape ${shape} is not available for this compartment (architecture ${architecture})`);
  }
  return pickUbuntuImage(await oci.listImages(compartmentId, shape));
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

async function findExistingInstance(oci: Oci, compartmentId: string, displayName: string): Promise<Instance | undefined> {
  const instances = await oci.listInstances(compartmentId, displayName);
  return instances.find(
    (instance) => instance.displayName === displayName && instance.lifecycleState !== 'TERMINATED' && instance.lifecycleState !== 'TERMINATING',
  );
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
  availabilityDomains: readonly AvailabilityDomainSpec[],
  intervalSeconds: number,
  deps: EngineDeps,
): Promise<DeployOutcome> {
  let attempt = 0;
  let lastLogPath: string | null = null;
  let lastMessage = '';
  let lastCode = '';

  const writeLog = async (content: string): Promise<void> => {
    try {
      lastLogPath = await appendAttemptLog(deps.logsDir, content);
    } catch (error) {
      deps.io.warn(`Could not append attempt log: ${describeThrown(error)}`);
    }
  };

  const waitForNextCycle = async (reason: string): Promise<boolean> => {
    await deps.onCycleFailed(lastMessage, lastCode);
    deps.io.message(`\n${reason}\n`);
    deps.io.message(`Retrying in ${humanizeInterval(intervalSeconds)}.\n`);
    deps.io.message(`  Attempt:       ${attempt}`);
    deps.io.message(`  Last error:    ${lastMessage}`);
    deps.io.message(`  Next retry:    ${formatNextRetry(deps.now(), intervalSeconds)}\n`);
    deps.io.message('Press Ctrl+C to stop.\n');
    await deps.sleep(intervalSeconds * 1000, deps.signal);
    return deps.signal?.aborted === true;
  };

  for (;;) {
    let existing: Instance | undefined;
    try {
      existing = await findExistingInstance(deps.oci, ctx.compartmentId, ctx.displayName);
    } catch (error) {
      const failure = classifyFailure(error);
      if (!failure.retryable) throw error;
      lastMessage = failure.message;
      lastCode = failure.code;
      deps.io.error(`Availability check failed: ${failure.message}`);
      if (await waitForNextCycle('Availability check failed; retrying.')) {
        return { kind: 'cancelled', logPath: lastLogPath };
      }
      continue;
    }
    if (existing !== undefined) return { kind: 'exists', instanceId: existing.id };

    for (const target of availabilityDomains) {
      if (deps.signal?.aborted) return { kind: 'cancelled', logPath: lastLogPath };
      const ad = typeof target === 'string' ? target : target.ad;
      const targetSubnetId = typeof target === 'string' ? ctx.subnetId : target.subnetId;
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
      deps.io.message(`Trying ${shortAd(ad)}...`);
      try {
        const instance = await deps.oci.launchInstance(
          buildLaunchBody({ ...ctx, subnetId: targetSubnetId, availabilityDomain: ad }),
        );
        await writeLog(buildAttemptLog({ ...logBase, result: 'SUCCEEDED' }));
        return { kind: 'succeeded', instanceId: instance.id, ad, attempt, logPath: lastLogPath };
      } catch (error) {
        const failure = classifyFailure(error);
        const message = describeThrown(error);
        lastMessage = message;
        lastCode = failure.code;
        await writeLog(
          buildAttemptLog({ ...logBase, result: 'FAILED', errorCode: failure.code, error: message }),
        );
        if (!failure.retryable) {
          return { kind: 'failed', failure, message, logPath: lastLogPath };
        }
        deps.io.error(`${shortAd(ad)}: ${failure.code === 'OUT_OF_CAPACITY' ? 'Out of capacity' : message}`);
      }
    }

    if (await waitForNextCycle('No Availability Domain currently has capacity.')) {
      return { kind: 'cancelled', logPath: lastLogPath };
    }
  }
}

function describeAdSkip(reason: AdSkipReason, shape: string): string {
  switch (reason) {
    case 'shape-unavailable':
      return `shape ${shape} is not offered there`;
    case 'shape-lookup-failed':
      return 'the shape list could not be read there';
    case 'no-compatible-subnet':
      return 'no subnet in the VCN is usable in that Availability Domain';
    default:
      return assertNever(reason);
  }
}

export async function resolveEngineAds(
  oci: Oci,
  compartmentId: string,
  plan: Pick<DeploymentPlan, 'shape' | 'networkMode'>,
  network: NetworkResult,
): Promise<{ targets: { ad: string; subnetId: string }[]; skipped: SkippedAd[] }> {
  const allAds = await oci.listAvailabilityDomains(compartmentId);
  const subnets =
    plan.networkMode === 'existing' && network.vcnId !== ''
      ? await oci.listSubnets(compartmentId, network.vcnId)
      : [];

  const results: { ad: string; subnetId: string }[] = [];
  const skipped: SkippedAd[] = [];

  for (const ad of allAds) {
    try {
      const shapes = await oci.listShapes(compartmentId, ad);
      if (!shapes.includes(plan.shape)) {
        skipped.push({ ad, reason: 'shape-unavailable' });
        continue;
      }
    } catch {
      skipped.push({ ad, reason: 'shape-lookup-failed' });
      continue;
    }

    let subnetId: string | null = null;
    if (network.created || network.subnetAd === null) {
      subnetId = network.subnetId;
    } else if (subnets.length > 0) {
      const sel = subnets.find((s) => s.id === network.subnetId);
      if (sel && (sel.availabilityDomain === ad || sel.availabilityDomain === null || sel.availabilityDomain === undefined)) {
        subnetId = sel.id;
      } else {
        const match =
          subnets.find((s) => s.availabilityDomain === ad) ??
          subnets.find((s) => s.availabilityDomain === null || s.availabilityDomain === undefined);
        if (match) {
          subnetId = match.id;
        }
      }
    } else {
      subnetId = network.subnetId;
    }

    if (subnetId !== null) {
      results.push({ ad, subnetId });
    } else {
      skipped.push({ ad, reason: 'no-compatible-subnet' });
    }
  }

  if (results.length === 0) {
    const fallbackSubnetAd = network.subnetAd;
    const adsToUse = fallbackSubnetAd === null || fallbackSubnetAd === undefined ? allAds : [fallbackSubnetAd];
    // Fail open: a shape lookup or subnet match is best-effort, so try every AD rather than none.
    return { targets: sortAdsHighestFirst(adsToUse.map((ad) => ({ ad, subnetId: network.subnetId }))), skipped: [] };
  }

  return { targets: sortAdsHighestFirst(results), skipped };
}

function emptyNetwork(plan: DeploymentPlan): NetworkResult {
  return { vcnId: plan.vcnId ?? '', subnetId: plan.subnetId ?? '', vcnName: plan.vcnName ?? '', subnetName: plan.subnetName ?? '', subnetAd: null, created: false };
}

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

async function withTransientRetry<T>(
  label: string,
  io: IO,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const failure = classifyFailure(error);
      if (!failure.retryable || attempt >= maxAttempts) throw error;
      io.warn(`${label} failed (${failure.message}); retrying in ${attempt * 2}s.`);
      await sleep(attempt * 2000, signal);
      if (signal?.aborted === true) throw new CancelledError();
    }
  }
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
    let ociAuth: OciAuth;
    try {
      ociAuth = await loadOciAuth(cli.profile);
    } catch (error) {
      if (error instanceof OciConfigError && io.interactive) {
        const setupOciConfig = deps.setupOciConfig;
        if (setupOciConfig === undefined) throw new Error('internal error: interactive run requires an OCI setup handler');
        await setupOciConfig(io);
        ociAuth = await loadOciAuth(cli.profile);
      } else {
        throw error;
      }
    }
    const oci = new Oci(ociAuth, { endpointOverride: deps.endpointOverride });

    io.intro(`${APP.name} v${appVersion()}`);
    if (cli.jsonMode) {
      plan = await withTransientRetry('Loading the OCI plan', io, sleep, deps.signal, () => buildPlanJson(oci, ociAuth, resolved));
    } else {
      const buildInteractivePlan = deps.buildInteractivePlan;
      if (buildInteractivePlan === undefined) throw new Error('internal error: interactive run requires a plan builder');
      plan = await buildInteractivePlan(io, oci, ociAuth, resolved);
    }

    const activePlan = plan;
    const allAds = await withTransientRetry('Listing Availability Domains', io, sleep, deps.signal, () => oci.listAvailabilityDomains(activePlan.compartmentId));
    const availabilityDomainsState = { ...(loaded.data.state ?? {}), availability_domains: [...allAds] };
    await saveYamlConfig(configPath, loaded.raw, { state: availabilityDomainsState });
    loaded = {
      data: { ...loaded.data, state: availabilityDomainsState },
      raw: { ...loaded.raw, state: availabilityDomainsState },
    };
    const existing = await computeExistingStorage(oci, plan.compartmentId, allAds);
    const storage = projectStorage(existing.totalGb, existing.items, plan.diskGbs);

    if (io.interactive) {
      const render = deps.render;
      if (render === undefined) throw new Error('internal error: interactive run requires render callbacks');
      render.storageWarning(io, storage);
      if (storage.exceedsWarn && !cli.yes) {
        const proceed = await io.confirm('Continue?', true);
        if (!proceed) throw new CancelledError();
      }
      render.summary(io, plan, storage, allAds);
      if (!cli.yes) {
        const deploy = await io.confirm('Deploy this infrastructure?', true);
        if (!deploy) throw new CancelledError();
      }
    }

    io.message('Starting deployment...\n');
    io.step('Configuration validated');
    io.step('OCI connection verified');
    const network =
      activePlan.networkMode === 'existing'
        ? await withTransientRetry('Preparing the network', io, sleep, deps.signal, () => prepareNetwork(oci, activePlan.compartmentId, activePlan))
        : await prepareNetwork(oci, activePlan.compartmentId, activePlan);
    io.step('Network ready');
    const engine = await withTransientRetry(
      'Resolving Availability Domains',
      io,
      sleep,
      deps.signal,
      () => resolveEngineAds(oci, activePlan.compartmentId, activePlan, network),
    );
    const engineAds = engine.targets;
    const adNames = engineAds.map((target) => shortAd(target.ad)).join(', ');
    io.step(`Using ${engineAds.length} Availability Domain${engineAds.length === 1 ? '' : 's'}${adNames === '' ? '' : ` (${adNames})`}`);
    for (const entry of engine.skipped) {
      io.warn(`${shortAd(entry.ad)} skipped: ${describeAdSkip(entry.reason, plan.shape)}`);
    }
    const singleAd = allAds[0];
    if (allAds.length === 1 && singleAd !== undefined) {
      io.warn(`Region ${plan.region} exposes a single Availability Domain (${shortAd(singleAd)}); capacity retries will repeat there.`);
    }

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
          ...(loaded.data.state ?? {}),
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
        return finishCancelled(cli, io, configPath, loaded, plan, network, lastLogPath);
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
      return finishCancelled(cli, io, configPath, loaded, plan, null, lastLogPath);
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
      io.message('    npx oci-free-vm\n');
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
    defaults: buildDefaultsOut(plan, plan.region, network ?? emptyNetwork(plan)),
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
): Promise<number> {
  if (loaded !== null && plan !== null) {
    const previousError = loaded.data.last_error ?? {};
    await saveYamlConfig(configPath, loaded.raw, {
      defaults: buildDefaultsOut(plan, plan.region, network ?? emptyNetwork(plan)),
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

