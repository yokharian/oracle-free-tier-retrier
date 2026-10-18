import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import process from 'node:process';
import {
  ConfigError,
  NetworkError,
  Oci,
  OciConfigError,
  OciHttpError,
  attemptLogFileName,
  buildLaunchBody,
  buildSignedHeaders,
  classifyFailure,
  deployWithRetry,
  jsonIo,
  loadYamlConfig,
  parseCliArgs,
  parseOciConfigText,
  projectStorage,
  resolveConfig,
  run,
  sanitize,
  saveYamlConfig,
  shortAd,
  validateDisk,
  validateFlexResources,
  type CliOverrides,
  type IO,
  type OciAuth,
  type YamlDefaults,
} from './index.ts';

const FIXED_DATE = new Date('2026-10-18T10:00:00Z');
const KEY_PAIR = generateKeyPairSync('rsa', { modulusLength: 2048 });

function makeAuth(): OciAuth {
  return {
    user: 'ocid1.user.oc1..test',
    tenancy: 'ocid1.tenancy.oc1..test',
    fingerprint: 'aa:bb:cc:dd',
    region: 'us-ashburn-1',
    keyFile: 'test-key.pem',
    privateKey: KEY_PAIR.privateKey,
  };
}

interface LaunchFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

class MockOci {
  readonly launchRequests: unknown[] = [];
  readonly authorizationSeen: string[] = [];
  instances: { id: string; displayName: string; lifecycleState: string }[] = [];
  bootVolumes: { displayName: string; sizeInGBs: number }[] = [];
  launchFailures: LaunchFailure[] = [];
  private readonly server: http.Server;
  readonly url: string;

  private constructor(server: http.Server, url: string) {
    this.server = server;
    this.url = url;
  }

  static async start(): Promise<MockOci> {
    let instance: MockOci | undefined;
    const server = http.createServer((req, res) => {
      if (instance === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      void instance.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      throw new Error('mock server did not get a port');
    }
    instance = new MockOci(server, `http://127.0.0.1:${address.port}`);
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string') this.authorizationSeen.push(authorization);
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && path === '/20160918/compartments') {
      return send(200, [{ id: 'ocid1.compartment.oc1..sandbox', name: 'sandbox', lifecycleState: 'ACTIVE' }]);
    }
    if (req.method === 'GET' && path === '/20160918/availabilityDomains') {
      return send(200, [
        { name: 'fNXZ:US-ASHBURN-AD-1' },
        { name: 'fNXZ:US-ASHBURN-AD-2' },
        { name: 'fNXZ:US-ASHBURN-AD-3' },
      ]);
    }
    if (req.method === 'GET' && path === '/20160916/vcns') {
      return send(200, [
        {
          id: 'ocid1.vcn.oc1..v1',
          displayName: 'production-vcn',
          defaultRouteTableId: 'ocid1.routetable..rt1',
          defaultSecurityListId: 'ocid1.securitylist..sl1',
        },
      ]);
    }
    if (req.method === 'GET' && path === '/20160916/subnets') {
      return send(200, [{ id: 'ocid1.subnet.oc1..s1', displayName: 'public-subnet', vcnId: 'ocid1.vcn.oc1..v1', availabilityDomain: null }]);
    }
    if (req.method === 'GET' && path === '/20160916/shapes') {
      return send(200, [{ shape: 'VM.Standard.A1.Flex' }, { shape: 'VM.Standard.E2.1.Micro' }, { shape: 'VM.Standard.E4.Flex' }]);
    }
    if (req.method === 'GET' && path === '/20160916/images') {
      return send(200, [
        {
          id: 'ocid1.image.oc1..ubuntu2204',
          operatingSystem: 'Canonical Ubuntu',
          operatingSystemVersion: '22.04',
          timeCreated: '2025-06-01T00:00:00Z',
        },
        {
          id: 'ocid1.image.oc1..ubuntu2404',
          operatingSystem: 'Canonical Ubuntu',
          operatingSystemVersion: '24.04',
          timeCreated: '2026-01-01T00:00:00Z',
        },
      ]);
    }
    if (req.method === 'GET' && path === '/20160916/instances') {
      const want = url.searchParams.get('displayName');
      const found = want === null ? this.instances : this.instances.filter((instance) => instance.displayName === want);
      return send(200, found);
    }
    if (req.method === 'GET' && path === '/20160916/bootVolumes') return send(200, this.bootVolumes);
    if (req.method === 'POST' && path === '/20160916/instances/') {
      const parsed: unknown = JSON.parse(bodyText);
      const displayName =
        parsed !== null && typeof parsed === 'object' && 'displayName' in parsed && typeof parsed.displayName === 'string'
          ? parsed.displayName
          : 'instance';
      this.launchRequests.push(parsed);
      const failure = this.launchFailures.shift();
      if (failure !== undefined) return send(failure.status, { code: failure.code, message: failure.message });
      const instance = { id: `ocid1.instance.oc1..${this.instances.length + 1}`, displayName, lifecycleState: 'PROVISIONING' };
      this.instances.push(instance);
      return send(200, instance);
    }
    return send(404, { code: 'NotFound', message: `no route for ${req.method ?? ''} ${path}` });
  }
}

let fixture: { configPath: string; sshKeyPath: string } | undefined;

async function getFixture(): Promise<{ configPath: string; sshKeyPath: string }> {
  if (fixture !== undefined) return fixture;
  const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-test-'));
  const keyPath = join(dir, 'oci_key.pem');
  const exported = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' });
  if (typeof exported !== 'string') throw new Error('expected PEM string export');
  await writeFile(keyPath, exported, 'utf8');
  const configPath = join(dir, 'config');
  await writeFile(
    configPath,
    [
      '[DEFAULT]',
      'user=ocid1.user.oc1..test',
      'fingerprint=aa:bb:cc:dd',
      'tenancy=ocid1.tenancy.oc1..test',
      'region=us-ashburn-1',
      `key_file=${keyPath}`,
      '',
    ].join('\n'),
    'utf8',
  );
  const sshKeyPath = join(dir, 'id_ed25519.pub');
  await writeFile(sshKeyPath, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestmq oci-free-vm-test\n', 'utf8');
  fixture = { configPath, sshKeyPath };
  return fixture;
}

async function withOciConfigEnv(test: () => Promise<void>): Promise<void> {
  const f = await getFixture();
  const previous = process.env['OCI_CONFIG_FILE'];
  process.env['OCI_CONFIG_FILE'] = f.configPath;
  try {
    await test();
  } finally {
    if (previous === undefined) delete process.env['OCI_CONFIG_FILE'];
    else process.env['OCI_CONFIG_FILE'] = previous;
  }
}

function overrides(partial: Partial<CliOverrides>): CliOverrides {
  return {
    jsonMode: partial.jsonMode ?? false,
    yes: partial.yes ?? false,
    help: partial.help ?? false,
    version: partial.version ?? false,
    configPath: partial.configPath,
    profile: partial.profile,
    region: partial.region,
    compartmentId: partial.compartmentId,
    architecture: partial.architecture,
    networkMode: partial.networkMode,
    vcnId: partial.vcnId,
    subnetId: partial.subnetId,
    shape: partial.shape,
    ocpus: partial.ocpus,
    memoryGbs: partial.memoryGbs,
    diskGbs: partial.diskGbs,
    instanceName: partial.instanceName,
    sshKeyFile: partial.sshKeyFile,
    assignPublicIp: partial.assignPublicIp,
    intervalSeconds: partial.intervalSeconds,
  };
}

function recordingIo(lines: string[]): IO {
  const push = (text: string): void => {
    lines.push(text);
  };
  return {
    interactive: false,
    intro: push,
    outro: (message) => push(message ?? ''),
    message: push,
    step: push,
    success: push,
    warn: push,
    error: push,
    select: () => {
      throw new Error('select in recording io');
    },
    text: () => {
      throw new Error('text in recording io');
    },
    confirm: () => {
      throw new Error('confirm in recording io');
    },
  };
}

describe('sanitize', () => {
  it('redacts PEM blocks, signatures, and pass phrases', () => {
    assert.equal(sanitize('-----BEGIN PRIVATE KEY-----\nMIIx\n-----END PRIVATE KEY-----'), '[redacted key material]');
    assert.equal(sanitize('signature="abc123=="'), 'signature="[redacted]"');
    assert.equal(sanitize('pass_phrase=hunter2'), 'pass_phrase=[redacted]');
  });
});

describe('shortAd / attemptLogFileName', () => {
  it('shortens full availability domain names', () => {
    assert.equal(shortAd('fNXZ:US-ASHBURN-AD-1'), 'AD-1');
    assert.equal(shortAd('weird ad name'), 'weird-ad-name');
  });
  it('produces windows-safe, padded, deterministic filenames', () => {
    const name = attemptLogFileName('2026-10-05T18:30:00.123Z', 3, 'fNXZ:US-ASHBURN-AD-1');
    assert.equal(name, '2026-10-05T18-30-00-123Z-attempt-003-AD-1.log');
    assert.equal(name.includes(':'), false);
  });
});

describe('classifyFailure', () => {
  it('maps OCI capacity errors to retryable capacity', () => {
    const failure = classifyFailure(new OciHttpError('LaunchInstance', 500, 'InternalError', 'Out of host capacity'));
    assert.equal(failure.kind, 'capacity');
    assert.equal(failure.retryable, true);
    assert.equal(failure.code, 'OUT_OF_CAPACITY');
  });
  it('maps rate limits and 5xx to retryable transient', () => {
    for (const error of [new OciHttpError('LaunchInstance', 429, 'TooManyRequests', 'slow down'), new OciHttpError('LaunchInstance', 503, 'ServiceUnavailable', 'later'), new NetworkError('LaunchInstance: ECONNREFUSED')]) {
      const failure = classifyFailure(error);
      assert.equal(failure.retryable, true);
      assert.equal(failure.code, 'TRANSIENT');
    }
  });
  it('maps auth errors to exit 3', () => {
    for (const status of [401, 403]) {
      const failure = classifyFailure(new OciHttpError('LaunchInstance', status, 'NotAuthorizedOrNotFound', 'denied'));
      assert.equal(failure.kind, 'auth');
      assert.equal(failure.retryable, false);
      assert.equal(failure.exitCode, 3);
    }
    const missing = classifyFailure(new OciConfigError('no ~/.oci/config'));
    assert.equal(missing.kind, 'auth');
    assert.equal(missing.exitCode, 3);
  });
  it('maps invalid parameters to exit 2 and other 4xx to fatal exit 1', () => {
    const invalid = classifyFailure(new OciHttpError('LaunchInstance', 400, 'InvalidParameter', 'bad shape'));
    assert.equal(invalid.kind, 'invalid');
    assert.equal(invalid.exitCode, 2);
    const fatal = classifyFailure(new OciHttpError('LaunchInstance', 404, 'NotFound', 'gone'));
    assert.equal(fatal.kind, 'fatal');
    assert.equal(fatal.retryable, false);
    assert.equal(fatal.exitCode, 1);
  });
  it('maps configuration and unexpected errors', () => {
    assert.equal(classifyFailure(new ConfigError('bad yaml')).exitCode, 2);
    const unexpected = classifyFailure(new Error('boom'));
    assert.equal(unexpected.code, 'UNEXPECTED');
    assert.equal(unexpected.exitCode, 5);
  });
});

describe('projectStorage', () => {
  it('projects totals and warns strictly above 200 GB', () => {
    const over = projectStorage(180, [{ name: 'api-01', gb: 180 }], 50);
    assert.equal(over.projectedGb, 230);
    assert.equal(over.exceedsWarn, true);
    const atLimit = projectStorage(180, [], 20);
    assert.equal(atLimit.projectedGb, 200);
    assert.equal(atLimit.exceedsWarn, false);
  });
  it('treats unknown existing storage as no warning', () => {
    const unknown = projectStorage(null, [], 250);
    assert.equal(unknown.projectedGb, null);
    assert.equal(unknown.exceedsWarn, false);
  });
});

describe('validateDisk / validateFlexResources', () => {
  it('enforces OCI boot volume bounds', () => {
    assert.equal(validateDisk(50), 50);
    assert.equal(validateDisk(250), 250);
    assert.equal(validateDisk(32768), 32768);
    assert.throws(() => validateDisk(49), ConfigError);
    assert.throws(() => validateDisk(32769), ConfigError);
  });
  it('requires ocpus/memory only for flexible shapes', () => {
    assert.deepEqual(validateFlexResources(true, 1, 6), { ocpus: 1, memoryGbs: 6 });
    assert.deepEqual(validateFlexResources(false, 1, 6), { ocpus: null, memoryGbs: null });
    assert.throws(() => validateFlexResources(true, 0, 6), ConfigError);
    assert.throws(() => validateFlexResources(true, 1, 0), ConfigError);
  });
});

describe('parseOciConfigText', () => {
  it('parses sections, defaults, and comments', () => {
    const sections = parseOciConfigText('# top comment\n[DEFAULT]\nuser=u\ntenancy=t\n\n[ADMIN]\nregion=us-phoenix-1');
    assert.equal(sections.get('DEFAULT')?.['user'], 'u');
    assert.equal(sections.get('ADMIN')?.['region'], 'us-phoenix-1');
    const noSection = parseOciConfigText('user=inline');
    assert.equal(noSection.get('DEFAULT')?.['user'], 'inline');
  });
});

describe('buildSignedHeaders', () => {
  it('signs POST bodies verifiably with the OCI v1 header list', () => {
    const url = new URL('https://iaas.us-ashburn-1.oraclecloud.com/20160916/instances/?compartmentId=ocid1');
    const body = '{"displayName":"devbox"}';
    const headers = buildSignedHeaders({ method: 'POST', url, key: KEY_PAIR.privateKey, keyId: 'tenancy/user/fp', body, date: FIXED_DATE });
    const authorization = headers['authorization'] ?? '';
    assert.match(
      authorization,
      /^Signature version="1",keyId="tenancy\/user\/fp",algorithm="rsa-sha256",signature="[^"]+",headers="date \(request-target\) host content-type content-length x-content-sha256"$/,
    );
    assert.equal(headers['x-content-sha256'], createHash('sha256').update(body).digest('base64'));
    const signingString = [
      `date: ${FIXED_DATE.toUTCString()}`,
      '(request-target): post /20160916/instances/?compartmentId=ocid1',
      'host: iaas.us-ashburn-1.oraclecloud.com',
      'content-type: application/json',
      `content-length: ${Buffer.byteLength(body)}`,
      `x-content-sha256: ${headers['x-content-sha256']}`,
    ].join('\n');
    const signature = /signature="([^"]+)"/.exec(authorization)?.[1] ?? '';
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingString);
    assert.equal(verifier.verify(KEY_PAIR.publicKey, signature, 'base64'), true);
  });
  it('signs GET requests with the minimal header list', () => {
    const url = new URL('https://identity.us-ashburn-1.oraclecloud.com/20160918/compartments');
    const headers = buildSignedHeaders({ method: 'GET', url, key: KEY_PAIR.privateKey, keyId: 'tenancy/user/fp', date: FIXED_DATE });
    assert.equal('x-content-sha256' in headers, false);
    assert.match(headers['authorization'] ?? '', /headers="date \(request-target\) host"$/);
  });
});

describe('buildLaunchBody', () => {
  const base = {
    availabilityDomain: 'fNXZ:US-ASHBURN-AD-1',
    compartmentId: 'ocid1.compartment.oc1..sandbox',
    displayName: 'devbox',
    shape: 'VM.Standard.A1.Flex',
    diskGbs: 250,
    subnetId: 'ocid1.subnet.oc1..s1',
    assignPublicIp: true,
    imageId: 'ocid1.image.oc1..ubuntu2404',
    sshPublicKey: 'ssh-ed25519 AAAAtest test',
  };
  it('includes shape config for flexible shapes', () => {
    const body = buildLaunchBody({ ...base, shapeIsFlex: true, ocpus: 4, memoryGbs: 24 });
    assert.deepEqual(body.shapeConfig, { ocpus: 4, memoryInGBs: 24 });
    assert.deepEqual(body.sourceDetails, { sourceType: 'image', imageId: 'ocid1.image.oc1..ubuntu2404', bootVolumeSizeInGBs: 250 });
    assert.deepEqual(body.createVnicDetails, { subnetId: 'ocid1.subnet.oc1..s1', assignPublicIp: 'YES' });
    assert.deepEqual(body.metadata, { ssh_authorized_keys: 'ssh-ed25519 AAAAtest test' });
  });
  it('omits shape config for fixed shapes and maps public ip off', () => {
    const body = buildLaunchBody({ ...base, shape: 'VM.Standard.E2.1.Micro', shapeIsFlex: false, ocpus: 1, memoryGbs: 1, assignPublicIp: false });
    assert.equal('shapeConfig' in body, false);
    assert.deepEqual(body.createVnicDetails, { subnetId: 'ocid1.subnet.oc1..s1', assignPublicIp: 'NO' });
  });
});

describe('parseCliArgs', () => {
  it('parses boolean, valued, and = style flags', () => {
    const cli = parseCliArgs(['--json', '--name', 'devbox', '--ocpus=2', '--public-ip', 'false', '--disk', '250']);
    assert.equal(cli.jsonMode, true);
    assert.equal(cli.instanceName, 'devbox');
    assert.equal(cli.ocpus, 2);
    assert.equal(cli.assignPublicIp, false);
    assert.equal(cli.diskGbs, 250);
  });
  it('rejects unknown options, missing values, and bad enums', () => {
    assert.throws(() => parseCliArgs(['--bogus']), ConfigError);
    assert.throws(() => parseCliArgs(['--name']), ConfigError);
    assert.throws(() => parseCliArgs(['--arch', 'riscv']), ConfigError);
    assert.throws(() => parseCliArgs(['--public-ip', 'maybe']), ConfigError);
    assert.throws(() => parseCliArgs(['--disk', '0']), ConfigError);
  });
});

describe('resolveConfig', () => {
  it('applies CLI over YAML, leaving the rest null', () => {
    const yaml: YamlDefaults = {
      region: 'us-ashburn-1',
      architecture: 'arm64',
      instance: { name: 'from-yaml', disk_gbs: 100 },
    };
    const resolved = resolveConfig(yaml, parseCliArgs(['--name', 'from-cli']));
    assert.equal(resolved.instanceName, 'from-cli');
    assert.equal(resolved.diskGbs, 100);
    assert.equal(resolved.region, 'us-ashburn-1');
    assert.equal(resolved.compartmentId, null);
  });
  it('resolves nothing from an empty config', () => {
    const resolved = resolveConfig(undefined, parseCliArgs([]));
    assert.equal(resolved.instanceName, null);
    assert.equal(resolved.architecture, null);
  });
});

describe('yaml config round trip', () => {
  it('saves sections and preserves unknown top-level keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-yaml-'));
    try {
      const path = join(dir, 'oci-free-vm.yaml');
      await saveYamlConfig(path, { custom_key: 'keep-me' }, {
        defaults: { region: 'us-ashburn-1', architecture: 'arm64' },
        state: { last_deployment: { status: 'succeeded', instance_id: 'ocid1.instance.oc1..1' } },
        last_error: { timestamp: '2026-10-05T18:10:00Z', code: 'OUT_OF_CAPACITY', message: 'Out of capacity' },
      });
      const { data, raw } = await loadYamlConfig(path);
      assert.equal(data.defaults?.region, 'us-ashburn-1');
      assert.equal(data.state?.last_deployment?.status, 'succeeded');
      assert.equal(data.last_error?.code, 'OUT_OF_CAPACITY');
      assert.equal(raw['custom_key'], 'keep-me');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('tolerates a missing file and rejects invalid YAML or structure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-yaml-'));
    try {
      const missing = await loadYamlConfig(join(dir, 'absent.yaml'));
      assert.deepEqual(missing.data, {});
      await writeFile(join(dir, 'broken.yaml'), 'defaults: [unclosed', 'utf8');
      await assert.rejects(loadYamlConfig(join(dir, 'broken.yaml')), ConfigError);
      await writeFile(join(dir, 'bad-shape.yaml'), 'defaults:\n  architecture: riscv\n', 'utf8');
      await assert.rejects(loadYamlConfig(join(dir, 'bad-shape.yaml')), ConfigError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Oci client against a local fake', () => {
  it('sends signed requests and maps non-2xx responses to OciHttpError', async () => {
    const mock = await MockOci.start();
    try {
      const oci = new Oci(makeAuth(), { endpointOverride: mock.url });
      const compartments = await oci.listCompartments();
      assert.equal(compartments[0]?.name, 'sandbox');
      assert.match(mock.authorizationSeen[0] ?? '', /^Signature version="1",keyId="ocid1\.tenancy\.oc1\.\.test\/ocid1\.user\.oc1\.\.test\/aa:bb:cc:dd",algorithm="rsa-sha256"/);
      await assert.rejects(oci.getSecurityList('ocid1.securitylist..missing'), (error: unknown) => {
        assert.equal(error instanceof OciHttpError, true);
        if (error instanceof OciHttpError) {
          assert.equal(error.status, 404);
          assert.equal(error.code, 'NotFound');
        }
        return true;
      });
    } finally {
      await mock.close();
    }
  });
});

describe('deployWithRetry', () => {
  it('advances to the next AD after a capacity failure', async () => {
    const mock = await MockOci.start();
    const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-engine-'));
    try {
      mock.launchFailures.push({ status: 500, code: 'InternalError', message: 'Out of host capacity' });
      const lines: string[] = [];
      const sleeps: number[] = [];
      const outcome = await deployWithRetry(
        {
          compartmentId: 'ocid1.compartment.oc1..sandbox',
          displayName: 'devbox',
          shape: 'VM.Standard.A1.Flex',
          shapeIsFlex: true,
          ocpus: 1,
          memoryGbs: 6,
          diskGbs: 250,
          subnetId: 'ocid1.subnet.oc1..s1',
          assignPublicIp: true,
          imageId: 'ocid1.image.oc1..ubuntu2404',
          architecture: 'arm64',
          sshPublicKey: 'ssh-ed25519 AAAAtest test',
        },
        ['fNXZ:US-ASHBURN-AD-1', 'fNXZ:US-ASHBURN-AD-2'],
        900,
        {
          io: recordingIo(lines),
          oci: new Oci(makeAuth(), { endpointOverride: mock.url }),
          now: () => FIXED_DATE,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          signal: undefined,
          logsDir: dir,
          onCycleFailed: async () => {},
        },
      );
      assert.equal(outcome.kind, 'succeeded');
      assert.equal(outcome.attempt, 2);
      assert.deepEqual(sleeps, []);
      const logs = (await readdir(dir)).sort();
      assert.equal(logs.length, 2);
      const first = await readFile(join(dir, logs[0] ?? ''), 'utf8');
      assert.match(first, /Result: FAILED/);
      assert.match(first, /OUT_OF_CAPACITY/);
      assert.equal(first.includes('ssh-ed25519'), false);
      const second = await readFile(join(dir, logs[1] ?? ''), 'utf8');
      assert.match(second, /Result: SUCCEEDED/);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('waits between full AD cycles and persists the failure via callback', async () => {
    const mock = await MockOci.start();
    const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-engine-'));
    try {
      mock.launchFailures.push(
        { status: 500, code: 'InternalError', message: 'Out of host capacity' },
        { status: 500, code: 'InternalError', message: 'Out of host capacity' },
      );
      const sleeps: number[] = [];
      const cycleErrors: { message: string; code: string }[] = [];
      const outcome = await deployWithRetry(
        {
          compartmentId: 'ocid1.compartment.oc1..sandbox',
          displayName: 'devbox',
          shape: 'VM.Standard.A1.Flex',
          shapeIsFlex: true,
          ocpus: 1,
          memoryGbs: 6,
          diskGbs: 100,
          subnetId: 'ocid1.subnet.oc1..s1',
          assignPublicIp: true,
          imageId: 'ocid1.image.oc1..ubuntu2404',
          architecture: 'arm64',
          sshPublicKey: 'ssh-ed25519 AAAAtest test',
        },
        ['fNXZ:US-ASHBURN-AD-1', 'fNXZ:US-ASHBURN-AD-2'],
        900,
        {
          io: recordingIo([]),
          oci: new Oci(makeAuth(), { endpointOverride: mock.url }),
          now: () => FIXED_DATE,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          signal: undefined,
          logsDir: dir,
          onCycleFailed: async (message, code) => {
            cycleErrors.push({ message, code });
          },
        },
      );
      assert.equal(outcome.kind, 'succeeded');
      assert.equal(outcome.attempt, 3);
      assert.deepEqual(sleeps, [900_000]);
      assert.deepEqual(cycleErrors, [{ message: 'Out of host capacity', code: 'OUT_OF_CAPACITY' }]);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts immediately on non-retryable failures', async () => {
    const mock = await MockOci.start();
    const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-engine-'));
    try {
      mock.launchFailures.push({ status: 401, code: 'NotAuthenticated', message: 'bad signature' });
      const sleeps: number[] = [];
      const outcome = await deployWithRetry(
        {
          compartmentId: 'ocid1.compartment.oc1..sandbox',
          displayName: 'devbox',
          shape: 'VM.Standard.A1.Flex',
          shapeIsFlex: true,
          ocpus: 1,
          memoryGbs: 6,
          diskGbs: 100,
          subnetId: 'ocid1.subnet.oc1..s1',
          assignPublicIp: true,
          imageId: 'ocid1.image.oc1..ubuntu2404',
          architecture: 'arm64',
          sshPublicKey: 'ssh-ed25519 AAAAtest test',
        },
        ['fNXZ:US-ASHBURN-AD-1', 'fNXZ:US-ASHBURN-AD-2'],
        900,
        {
          io: recordingIo([]),
          oci: new Oci(makeAuth(), { endpointOverride: mock.url }),
          now: () => FIXED_DATE,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          signal: undefined,
          logsDir: dir,
          onCycleFailed: async () => {},
        },
      );
      assert.equal(outcome.kind, 'failed');
      assert.equal(outcome.failure.kind, 'auth');
      assert.deepEqual(sleeps, []);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects an existing instance before any launch attempt', async () => {
    const mock = await MockOci.start();
    const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-engine-'));
    try {
      mock.instances.push({ id: 'ocid1.instance.oc1..exists', displayName: 'devbox', lifecycleState: 'RUNNING' });
      const outcome = await deployWithRetry(
        {
          compartmentId: 'ocid1.compartment.oc1..sandbox',
          displayName: 'devbox',
          shape: 'VM.Standard.A1.Flex',
          shapeIsFlex: true,
          ocpus: 1,
          memoryGbs: 6,
          diskGbs: 100,
          subnetId: 'ocid1.subnet.oc1..s1',
          assignPublicIp: true,
          imageId: 'ocid1.image.oc1..ubuntu2404',
          architecture: 'arm64',
          sshPublicKey: 'ssh-ed25519 AAAAtest test',
        },
        ['fNXZ:US-ASHBURN-AD-1', 'fNXZ:US-ASHBURN-AD-2'],
        900,
        {
          io: recordingIo([]),
          oci: new Oci(makeAuth(), { endpointOverride: mock.url }),
          now: () => FIXED_DATE,
          sleep: async () => {},
          signal: undefined,
          logsDir: dir,
          onCycleFailed: async () => {},
        },
      );
      assert.equal(outcome.kind, 'exists');
      assert.equal(outcome.instanceId, 'ocid1.instance.oc1..exists');
      assert.equal(mock.launchRequests.length, 0);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('run in --json mode against a local fake', () => {
  it('deploys after a capacity failure, persists state, and logs attempts', async () => {
    await withOciConfigEnv(async () => {
      const f = await getFixture();
      const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-run-'));
      const mock = await MockOci.start();
      try {
        mock.bootVolumes = [
          { displayName: 'api-01', sizeInGBs: 100 },
          { displayName: 'worker-01', sizeInGBs: 80 },
        ];
        mock.launchFailures.push({ status: 500, code: 'InternalError', message: 'Out of host capacity' });
        const code = await run(
          overrides({
            jsonMode: true,
            configPath: join(dir, 'oci-free-vm.yaml'),
            compartmentId: 'ocid1.compartment.oc1..sandbox',
            vcnId: 'ocid1.vcn.oc1..v1',
            subnetId: 'ocid1.subnet.oc1..s1',
            instanceName: 'devbox',
            shape: 'VM.Standard.A1.Flex',
            ocpus: 1,
            memoryGbs: 6,
            diskGbs: 250,
            sshKeyFile: f.sshKeyPath,
            intervalSeconds: 1,
          }),
          jsonIo(),
          { endpointOverride: mock.url, logsDir: join(dir, 'logs'), sleep: async () => {}, now: () => FIXED_DATE },
        );
        assert.equal(code, 0);
        assert.equal(mock.launchRequests.length, 2);
        assert.equal(JSON.stringify(mock.launchRequests[0]).includes('"bootVolumeSizeInGBs":250'), true);
        assert.equal(JSON.stringify(mock.launchRequests[0]).includes('"ocpus":1'), true);
        const { data } = await loadYamlConfig(join(dir, 'oci-free-vm.yaml'));
        assert.equal(data.state?.last_deployment?.status, 'succeeded');
        assert.equal(data.state?.last_deployment?.instance_name, 'devbox');
        assert.equal(data.defaults?.instance?.disk_gbs, 250);
        assert.equal(data.defaults?.network?.vcn_id, 'ocid1.vcn.oc1..v1');
        const logs = (await readdir(join(dir, 'logs'))).sort();
        assert.equal(logs.length, 2);
        const failedLog = await readFile(join(dir, 'logs', logs[0] ?? ''), 'utf8');
        assert.match(failedLog, /Result: FAILED/);
        assert.match(failedLog, /OUT_OF_CAPACITY/);
        assert.equal(failedLog.includes('ssh-ed25519'), false);
        assert.equal(failedLog.includes('BEGIN PRIVATE KEY'), false);
      } finally {
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('exits 0 without launching when the instance already exists', async () => {
    await withOciConfigEnv(async () => {
      const f = await getFixture();
      const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-run-'));
      const mock = await MockOci.start();
      try {
        mock.instances.push({ id: 'ocid1.instance.oc1..exists', displayName: 'devbox', lifecycleState: 'RUNNING' });
        const code = await run(
          overrides({
            jsonMode: true,
            configPath: join(dir, 'oci-free-vm.yaml'),
            compartmentId: 'ocid1.compartment.oc1..sandbox',
            vcnId: 'ocid1.vcn.oc1..v1',
            subnetId: 'ocid1.subnet.oc1..s1',
            instanceName: 'devbox',
            diskGbs: 100,
            sshKeyFile: f.sshKeyPath,
          }),
          jsonIo(),
          { endpointOverride: mock.url, logsDir: join(dir, 'logs'), sleep: async () => {}, now: () => FIXED_DATE },
        );
        assert.equal(code, 0);
        assert.equal(mock.launchRequests.length, 0);
      } finally {
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('exits 3 when the OCI configuration is missing', async () => {
    const previous = process.env['OCI_CONFIG_FILE'];
    process.env['OCI_CONFIG_FILE'] = '/nonexistent/.oci/config';
    try {
      const code = await run(overrides({ jsonMode: true }), jsonIo(), {});
      assert.equal(code, 3);
    } finally {
      if (previous === undefined) delete process.env['OCI_CONFIG_FILE'];
      else process.env['OCI_CONFIG_FILE'] = previous;
    }
  });

  it('exits 4 when the run is aborted before the first attempt', async () => {
    await withOciConfigEnv(async () => {
      const f = await getFixture();
      const dir = await mkdtemp(join(tmpdir(), 'oci-free-vm-run-'));
      const mock = await MockOci.start();
      try {
        const controller = new AbortController();
        controller.abort();
        const code = await run(
          overrides({
            jsonMode: true,
            configPath: join(dir, 'oci-free-vm.yaml'),
            compartmentId: 'ocid1.compartment.oc1..sandbox',
            vcnId: 'ocid1.vcn.oc1..v1',
            subnetId: 'ocid1.subnet.oc1..s1',
            instanceName: 'devbox',
            diskGbs: 100,
            sshKeyFile: f.sshKeyPath,
          }),
          jsonIo(),
          { endpointOverride: mock.url, logsDir: join(dir, 'logs'), sleep: async () => {}, now: () => FIXED_DATE, signal: controller.signal },
        );
        assert.equal(code, 4);
        assert.equal(mock.launchRequests.length, 0);
        const { data } = await loadYamlConfig(join(dir, 'oci-free-vm.yaml'));
        assert.equal(data.defaults?.instance?.name, 'devbox');
      } finally {
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
