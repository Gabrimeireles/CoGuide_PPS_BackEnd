import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

type Args = {
  envFile: string;
  repo: string;
  only: string | null;
  exclude: string | null;
  allowEmpty: boolean;
  dryRun: boolean;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    envFile: '.env',
    repo: process.env.GITHUB_REPOSITORY ?? '',
    only: null,
    exclude: null,
    allowEmpty: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env-file') {
      args.envFile = argv[i + 1];
      i += 1;
    } else if (arg === '--repo') {
      args.repo = argv[i + 1];
      i += 1;
    } else if (arg === '--only') {
      args.only = argv[i + 1];
      i += 1;
    } else if (arg === '--exclude') {
      args.exclude = argv[i + 1];
      i += 1;
    } else if (arg === '--allow-empty') {
      args.allowEmpty = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }

  return args;
};

const parseEnvFile = (filePath: string): Record<string, string> => {
  const content = fs.readFileSync(filePath, 'utf8');
  const data: Record<string, string> = {};
  content.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) return;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  });
  return data;
};

const syncHomologVersionToPackageJson = (homologVersion: string) => {
  const packagePath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(packagePath)) return;

  const raw = fs.readFileSync(packagePath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (!pkg.version || pkg.version === homologVersion) return;

  pkg.version = homologVersion;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`package.json version updated to ${homologVersion}`);
};

const runGh = (cmd: string[]) => execFileSync('gh', cmd, { stdio: 'pipe', encoding: 'utf8' });

const main = () => {
  console.warn(
    '[DEPRECATED] sync-env-to-secrets.ts deve ser usado apenas para bootstrap emergencial.',
  );
  console.warn(
    '[DEPRECATED] Fluxo recomendado: usar GitHub Environments + secret unico RUNTIME_ENV_FILE.',
  );

  const args = parseArgs(process.argv);
  const envPath = args.envFile;

  if (!fs.existsSync(envPath)) {
    console.error(`env file not found: ${envPath}`);
    process.exit(1);
  }
  if (!args.repo) {
    console.error('repo not provided. Use --repo owner/repo or set GITHUB_REPOSITORY.');
    process.exit(1);
  }

  try {
    runGh(['--version']);
  } catch {
    console.error('gh CLI not found. Install GitHub CLI and authenticate (gh auth login).');
    process.exit(1);
  }

  let data = parseEnvFile(envPath);
  const packagePath = path.join(process.cwd(), 'package.json');
  if (!data.HOMOLOG_VERSION && fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
    if (pkg.version) {
      data.HOMOLOG_VERSION = pkg.version;
      console.log(`HOMOLOG_VERSION not found in env; using package.json version ${pkg.version}`);
    }
  }
  if (data.HOMOLOG_VERSION) {
    syncHomologVersionToPackageJson(data.HOMOLOG_VERSION);
  }

  if (args.only) {
    const only = new Set(
      args.only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    data = Object.fromEntries(Object.entries(data).filter(([k]) => only.has(k)));
  }
  if (args.exclude) {
    const exclude = new Set(
      args.exclude
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    data = Object.fromEntries(Object.entries(data).filter(([k]) => !exclude.has(k)));
  }

  const entries = Object.entries(data);
  if (entries.length === 0) {
    console.log('no keys to sync.');
    process.exit(0);
  }

  for (const [key, value] of entries) {
    if (!args.allowEmpty && value === '') {
      console.log(`skip ${key}: empty value`);
      continue;
    }
    if (args.dryRun) {
      console.log(`[dry-run] set secret ${key} in ${args.repo}`);
      continue;
    }
    try {
      runGh(['secret', 'set', key, '--repo', args.repo, '--body', value]);
      console.log(`set secret ${key}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`failed to set ${key}: ${message}`);
      process.exit(1);
    }
  }
};

main();
