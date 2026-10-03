import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const artifactRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const constants = Object.freeze({
  guid: '20be089a-e364-59fe-9bf1-70ea22b78d3f',
  leaf: 'Luheng Office Agent',
  helperSHA256: 'fcfaf03a4f140ced8839cee5f81c6639d52fb2cf0963c48720e5795dae9684c4',
  prefix: 'luheng-nsis-functional-',
});
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function sourceContract() {
  const helperPath = path.join(artifactRoot, 'helper', 'current-user-install-directory.nsh');
  const helperBytes = fs.readFileSync(helperPath);
  if (sha256(helperBytes) !== constants.helperSHA256) throw new Error('Exact helper hash mismatch');
  const source = fs.readFileSync(path.join(artifactRoot, 'fixture.nsi'), 'utf8');
  for (const forbidden of [/^\s*WriteUninstaller\b/im, /^\s*WriteReg\w*\b/im,
    /^\s*DeleteReg\w*\b/im, /^\s*(?:Exec|ExecWait|ExecShell|File|CreateDirectory|RMDir|Delete)\b/im,
    /AdjustTokenPrivileges|SetSecurityInfo|SetNamedSecurityInfo|WRITE_DAC|WRITE_OWNER/]) {
    if (forbidden.test(source)) throw new Error(`Forbidden fixture operation: ${forbidden}`);
  }
  if (!source.includes('RequestExecutionLevel user')) throw new Error('Fixture must use the existing user token');
  if (!source.includes('!insertmacro customHeader')) throw new Error('Missing delayed helper declarations');
  for (const name of ['luhengPreflightDirectory', 'luhengCreateDirectory', 'luhengFinishDirectory']) {
    if (source.match(new RegExp(`^\\s*Call ${name}$`, 'gm'))?.length !== 1) {
      throw new Error(`Expected one direct real call: ${name}`);
    }
  }
  if (/Function \.(?:onGUIEnd|onInstFailed|onUserAbort)\b/.test(source)) throw new Error('Helper/MUI callback conflict');
  return { kind: 'source-contract', helperSHA256: constants.helperSHA256,
    fixtureSHA256: sha256(Buffer.from(source)), compiled: false, windowsRuntimeExecuted: false };
}

export function requireWindows({ githubActions = false } = {}) {
  if (process.platform !== 'win32') throw new Error('This operation requires actual Windows; no simulated Windows result is accepted');
  if (githubActions && (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows')) {
    throw new Error('--github-actions requires GITHUB_ACTIONS=true and RUNNER_OS=Windows');
  }
}

export function controlledPaths(root, nonce, temp = os.tmpdir()) {
  if (!/^[0-9a-f]{32}$/.test(nonce ?? '')) throw new Error('Nonce must be 32 lowercase hex characters');
  const tempRoot = path.win32.resolve(temp);
  const expectedRoot = path.win32.join(tempRoot, `${constants.prefix}${nonce}`);
  if (!/^[A-Za-z]:\\/.test(root ?? '') || root.toLowerCase() !== expectedRoot.toLowerCase()
    || root.toLowerCase() !== path.win32.resolve(root).toLowerCase()) throw new Error('Invalid fixed TEMP ROOT');
  const parent = path.win32.join(root, 'parent');
  return { root, parent, target: path.win32.join(parent, constants.leaf),
    evidence: path.win32.join(root, 'evidence'), marker: path.win32.join(root, 'ownership.ini'), nonce };
}

export function markerText(p) {
  const data = { schema: '1', nonce: p.nonce, app_guid: constants.guid, app_leaf: constants.leaf,
    helper_sha256: constants.helperSHA256, root: p.root, parent: p.parent, target: p.target, evidence: p.evidence };
  for (const value of Object.values(data)) if (/[\r\n\0]/.test(value)) throw new Error('Invalid marker value');
  return `[fixture]\r\n${Object.entries(data).map(([key, value]) => `${key}=${value}`).join('\r\n')}\r\n`;
}

function powershellPreflight(p, registryOnly = false) {
  const program = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(artifactRoot, 'scripts', 'preflight.ps1')];
  // Respect the current execution policy. Never add an execution-policy bypass.
  if (registryOnly) args.push('-RegistryOnly');
  else args.push('-Root', p.root, '-Nonce', p.nonce);
  const result = spawnSync(program, args, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Windows preflight refused: ${result.error?.message ?? result.stderr.trim()}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

export function parseTrace(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new Error('Expected UTF-16LE INI evidence');
  const text = bytes.subarray(2).toString('utf16le');
  const data = Object.create(null);
  let section;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const heading = /^\[([a-z_]+)\]$/.exec(line);
    if (heading) {
      section = heading[1];
      if (Object.hasOwn(data, section)) throw new Error('Duplicate evidence section');
      data[section] = Object.create(null);
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (!section || !entry || Object.hasOwn(data[section], entry[1])) throw new Error('Malformed pure-data evidence');
    data[section][entry[1]] = entry[2];
  }
  return data;
}

export function validateTrace(data, p) {
  if (data.meta?.nonce !== p.nonce || data.meta?.root !== p.root || data.meta?.target !== p.target
    || data.meta?.helperSHA256 !== constants.helperSHA256 || data.meta?.appGUID !== constants.guid
    || data.meta?.appLeaf !== constants.leaf) throw new Error('Evidence ownership or source mismatch');
  const expectedStages = ['preflight_enter', 'preflight_exit', 'create_enter', 'create_exit', 'finish_enter', 'finish_exit', 'flow_final'];
  const stages = Object.keys(data).filter(key => key !== 'meta' && key !== 'result');
  const observedCalls = stages.filter(key => key !== 'flow_final');
  if (stages.at(-1) !== 'flow_final' || ![2, 4, 6].includes(observedCalls.length)
    || observedCalls.some((stage, i) => stage !== expectedStages[i])) throw new Error('Unexpected stage order');
  const success = data.result?.outcome === 'helper-flow-succeeded';
  if (success) {
    if (stages.length !== expectedStages.length) throw new Error('Incomplete success trace');
    for (const stage of ['preflight_exit', 'create_exit', 'finish_exit', 'flow_final']) {
      if (data[stage]?.luidError !== '') throw new Error('Success claimed with helper failure');
    }
    if (data.create_exit.nativeInformation !== '2' || data.create_exit.nativeStatus !== '0') throw new Error('No actual FILE_CREATED evidence');
    if (!/^S-1-/.test(data.create_exit.currentSID) || data.create_exit.currentSID !== data.create_exit.ownerSID
      || data.create_exit.aceCount !== '3' || !data.create_exit.sddl
      || (Number(data.create_exit.daclControl) & 0x1004) !== 0x1004) throw new Error('Missing owner/DACL evidence');
    if (data.create_exit.ownedIdentity !== data.finish_exit.checkIdentity
      || data.result.createdIdentity !== data.create_exit.ownedIdentity) throw new Error('Identity changed');
    if (data.finish_exit.nativeHandle !== '0' || data.finish_exit.ownedHandle !== '0' || data.finish_exit.ready !== '0') {
      throw new Error('Finish cleanup globals are not closed');
    }
  }
  return { evidenceKind: 'actual-windows-fixture-trace', helperFlowSucceeded: success,
    cleanupConfirmed: data.result?.cleanup === 'removed-known-empty-directory-by-handle', data };
}

export function compilerInvocation(makensis) {
  if (!path.win32.isAbsolute(makensis) || path.win32.basename(makensis).toLowerCase() !== 'makensis.exe') {
    throw new Error('Compiler must be an absolute path to the installed makensis.exe');
  }
  return { program: makensis, args: ['/V3', 'fixture.nsi'], options: { cwd: artifactRoot, encoding: 'utf8', shell: false, windowsHide: true } };
}

function optionsFor(command, args) {
  const allowed = { contract: [], compile: ['makensis', 'github-actions'], prepare: ['github-actions'],
    preflight: ['root', 'nonce', 'github-actions'], report: ['root', 'nonce', 'github-actions'] }[command];
  if (!allowed) throw new Error('Commands: contract, compile, prepare, preflight, report. There is no run command.');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const option = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.includes(option) || Object.hasOwn(options, option)) throw new Error(`Unknown/duplicate option: ${args[i]}`);
    options[option] = option === 'github-actions' ? true : args[++i];
    if (options[option] === undefined) throw new Error(`Missing value for --${option}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const [command = 'contract', ...args] = argv;
  const options = optionsFor(command, args);
  const contract = sourceContract();
  if (command === 'contract') return contract;
  requireWindows({ githubActions: options['github-actions'] });
  if (command === 'compile') {
    const candidate = options.makensis ?? [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
      .filter(Boolean).map(base => path.join(base, 'NSIS', 'makensis.exe')).find(file => fs.existsSync(file));
    if (!candidate) throw new Error('Installed NSIS compiler not found. Supply --makensis with its absolute path.');
    const invocation = compilerInvocation(candidate);
    const result = spawnSync(invocation.program, invocation.args, invocation.options);
    if (result.error || result.status !== 0) throw new Error(`makensis compile failed: ${result.error?.message ?? result.stdout + result.stderr}`);
    const executable = path.join(artifactRoot, 'fixture.exe');
    const bytes = fs.readFileSync(executable);
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('Compiler output is not a PE executable');
    return { ...contract, compiled: true, executable, executableSHA256: sha256(bytes), compilerOutput: result.stdout.trim(), windowsRuntimeExecuted: false };
  }
  if (command === 'prepare') {
    const registry = powershellPreflight(null, true);
    const nonce = crypto.randomBytes(16).toString('hex');
    const p = controlledPaths(path.win32.join(path.win32.resolve(os.tmpdir()), `${constants.prefix}${nonce}`), nonce);
    fs.mkdirSync(p.root); // No recursive creation, reuse, ownership or ACL edits.
    fs.mkdirSync(p.parent);
    fs.mkdirSync(p.evidence);
    fs.writeFileSync(p.marker, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(markerText(p), 'utf16le')]), { flag: 'wx' });
    const preflight = powershellPreflight(p);
    const data = { ...p, executable: path.join(artifactRoot, 'fixture.exe'),
      argv: ['/S', `/ROOT=${p.root}`, `/NONCE=${nonce}`], registry, preflight,
      note: 'Prepared only. Publisher/operator must run the exact fixture separately on Windows.' };
    fs.writeFileSync(path.join(p.root, 'run-config.json'), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    return data;
  }
  const p = controlledPaths(options.root, options.nonce);
  if (command === 'preflight') return powershellPreflight(p);
  const result = validateTrace(parseTrace(fs.readFileSync(path.join(p.evidence, 'trace.ini'))), p);
  const output = path.join(p.evidence, 'result.json');
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return { output, helperFlowSucceeded: result.helperFlowSucceeded, cleanupConfirmed: result.cleanupConfirmed, evidenceKind: result.evidenceKind };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(), null, 2) + '\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
