// oci-free-vm — shared types, constants, and configuration schemas.

import type { KeyObject } from 'node:crypto';
import * as ociCore from 'oci-core';
import { z } from 'zod';

export const APP = { name: 'oci-free-vm' } as const;
export const DEFAULT_CONFIG_FILE = 'oci-free-vm.yaml';
export const LOGS_DIR = 'oci-free-vm-logs';

export const LIMITS = {
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
} as const;

export const EXIT = {
  success: 0,
  deployFailed: 1,
  invalidConfig: 2,
  auth: 3,
  cancelled: 4,
  unexpected: 5,
} as const;

export type Architecture = 'arm64' | 'x86_64';
export type NetworkMode = 'existing' | 'create';
export type FailureKind = 'capacity' | 'transient' | 'auth' | 'invalid' | 'fatal';
export type FailureCode = 'OUT_OF_CAPACITY' | 'TRANSIENT' | 'AUTH' | 'CONFIG' | 'DEPLOY' | 'UNEXPECTED';


export interface Failure {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly code: FailureCode;
  readonly message: string;
}
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


export const BOOLEAN_FLAGS = new Set(['help', 'json', 'version', 'yes']);
export const VALUE_FLAGS = new Set([
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


export interface OciAuth {
  readonly user: string;
  readonly tenancy: string;
  readonly fingerprint: string;
  readonly region: string;
  readonly keyFile: string;
  readonly privateKey: KeyObject;
  readonly privateKeyPem: string;
  readonly passphrase?: string | undefined;
}
// ------------------------------------------------------------ official SDK types

export interface Compartment {
  readonly id: string;
  readonly name: string;
  readonly lifecycleState: string;
}

export interface Vcn {
  readonly id: string;
  readonly displayName: string | null;
  readonly defaultRouteTableId?: string | null | undefined;
  readonly defaultSecurityListId?: string | null | undefined;
}

export interface Subnet {
  readonly id: string;
  readonly displayName: string | null;
  readonly vcnId: string;
  readonly availabilityDomain?: string | null | undefined;
}

export interface Image {
  readonly id: string;
  readonly operatingSystem: string;
  readonly operatingSystemVersion: string;
  readonly timeCreated?: string | null | undefined;
}

export interface Instance {
  readonly id: string;
  readonly displayName: string | null;
  readonly lifecycleState: string;
}

export interface BootVolume {
  readonly displayName: string | null;
  readonly sizeInGBs: number | null;
}

export interface RouteTable {
  readonly id: string;
  readonly routeRules?: readonly unknown[] | null | undefined;
}

export interface SecurityList {
  readonly id: string;
  readonly ingressSecurityRules: readonly ociCore.models.IngressSecurityRule[];
  readonly egressSecurityRules: readonly ociCore.models.EgressSecurityRule[];
}


export interface LaunchInstanceDetails {
  readonly availabilityDomain: string;
  readonly compartmentId: string;
  readonly displayName: string;
  readonly shape: string;
  readonly shapeConfig?: { readonly ocpus: number; readonly memoryInGBs: number };
  readonly sourceDetails: { readonly sourceType: 'image'; readonly imageId: string; readonly bootVolumeSizeInGBs: number };
  readonly createVnicDetails: { readonly subnetId: string; readonly assignPublicIp: boolean };
  readonly metadata: { readonly ssh_authorized_keys: string };
}
export interface StorageReport {
  readonly existingGb: number | null;
  readonly items: readonly { readonly name: string; readonly gb: number }[];
  readonly newGb: number;
  readonly projectedGb: number | null;
  readonly exceedsWarn: boolean;
}
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
export const APP_DEFAULTS = {
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

export const yamlConfigSchema = z
  .object({
    defaults: defaultsSchema.optional(),
    state: z.object({ last_deployment: lastDeploymentSchema }).optional(),
    last_error: lastErrorSchema,
  })
  .passthrough();

export type YamlConfig = z.infer<typeof yamlConfigSchema>;
export type YamlDefaults = NonNullable<YamlConfig['defaults']>;
export type LastErrorOut = NonNullable<z.infer<typeof lastErrorSchema>>;


