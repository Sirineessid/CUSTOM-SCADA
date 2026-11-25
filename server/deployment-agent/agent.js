'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const zip = require('../runtime/sites/zip');

const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_RELEASE_SIZE = 256 * 1024 * 1024;
const MAX_RELEASE_FILES = 10000;
const MAX_RELEASE_CONTENT = 512 * 1024 * 1024;

function create(options) {
    const root = path.resolve(options.root);
    const runtimeDir = path.resolve(options.runtimeDir);
    const runtimeMain = path.join(runtimeDir, 'main.js');
    const runtimeTls = {
        key: options.runtimeTlsKey || '',
        cert: options.runtimeTlsCert || ''
    };
    const token = Buffer.from(options.token || '');
    const deploymentsFile = path.join(root, 'deployments.json');
    const childProcesses = new Map();
    const state = readState(deploymentsFile);
    const app = express();

    fs.mkdirSync(root, { recursive: true });

    function authorized(req, res, next) {
        const supplied = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
        if (!token.length || supplied.length !== token.length || !crypto.timingSafeEqual(supplied, token)) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        next();
    }

    app.get('/health', authorized, (req, res) => res.json({ ok: true, runtime: fs.existsSync(runtimeMain) }));
    app.use('/api/deployments', authorized);
    app.use(express.json({ limit: '16kb' }));
    app.post('/api/preflight', authorized, async (req, res) => {
        const checks = [];
        const errors = [];
        const mode = req.body && req.body.mode;
        const port = Number(req.body && req.body.runtimePort);
        const siteId = String(req.body && req.body.siteId || '');
        const runtimeReady = fs.existsSync(runtimeMain);
        checks.push({ name: 'runtime', ok: runtimeReady });
        if (!runtimeReady) {
            errors.push(`FUXA runtime not found at ${runtimeMain}.`);
        }
        let portReady = Number.isInteger(port) && port > 0 && port <= 65535;
        if (portReady) {
            const ownedByThisSite = state[siteId] && state[siteId].port === port;
            const usedByOtherSite = Object.entries(state).some(([name, deployment]) => name !== siteId && deployment.port === port);
            portReady = ownedByThisSite || (!usedByOtherSite && await isPortFree(port));
        }
        checks.push({ name: 'runtime-port', ok: portReady, port });
        if (!portReady) {
            errors.push('The selected runtime port is invalid or unavailable.');
        }
        if (mode === 'ip-port' && req.body && req.body.https) {
            const tlsReady = hasRuntimeTls();
            checks.push({ name: 'runtime-tls', ok: tlsReady });
            if (!tlsReady) {
                errors.push('HTTPS on an IP/port runtime requires FUXA_DEPLOYMENT_TLS_KEY and FUXA_DEPLOYMENT_TLS_CERT on the agent.');
            }
        }
        if (mode === 'iis') {
            if (process.platform !== 'win32') {
                checks.push({ name: 'iis', ok: false });
                errors.push('IIS publishing requires a Windows deployment agent.');
            } else {
                try {
                    await runPowerShell([
                        "$ErrorActionPreference = 'Stop'",
                        "Import-Module WebAdministration",
                        "if (-not (Get-Website -ErrorAction SilentlyContinue)) { throw 'IIS WebAdministration is unavailable.' }",
                        "Get-WebGlobalModule -Name RewriteModule -ErrorAction Stop | Out-Null",
                        "Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name enabled -ErrorAction Stop | Out-Null",
                        "if ($env:FUXA_IIS_HTTPS -eq 'true' -and -not (Test-Path ('Cert:\\LocalMachine\\My\\' + $env:FUXA_IIS_CERTIFICATE))) { throw 'HTTPS certificate not found in LocalMachine\\My.' }"
                    ].join('; '), {
                        FUXA_IIS_HTTPS: req.body.https ? 'true' : 'false',
                        FUXA_IIS_CERTIFICATE: String(req.body.certificateThumbprint || '')
                    });
                    checks.push({ name: 'iis-arr-rewrite', ok: true });
                } catch (error) {
                    checks.push({ name: 'iis-arr-rewrite', ok: false });
                    errors.push(`IIS, URL Rewrite, or ARR is unavailable: ${error.message}`);
                }
            }
        }
        res.status(errors.length ? 422 : 200).json({ ok: errors.length === 0, checks, errors });
    });
    app.put('/api/deployments/:siteId/release', express.raw({ type: 'application/zip', limit: MAX_RELEASE_SIZE }), async (req, res) => {
        try {
            const result = await deploy(req.params.siteId, req.body, {
                version: req.get('x-release-version'),
                sha256: req.get('x-release-sha256'),
                mode: req.get('x-hosting-mode'),
                port: req.get('x-runtime-port'),
                hostname: req.get('x-public-host'),
                https: req.get('x-public-https') === 'true',
                iisName: req.get('x-iis-site'),
                iisPort: req.get('x-iis-port'),
                iisHost: req.get('x-iis-host'),
                certificate: req.get('x-iis-certificate') || ''
            });
            res.status(201).json(result);
        } catch (error) {
            res.status(error.status || 500).json({ error: error.code || 'deployment_failed', message: error.message });
        }
    });
    app.get('/api/deployments/:siteId', (req, res) => {
        const deployment = state[req.params.siteId];
        if (!deployment) {
            return res.status(404).json({ error: 'deployment_not_found' });
        }
        res.json(publicStatus(deployment, childProcesses));
    });
    app.post('/api/deployments/:siteId/rollback', async (req, res) => {
        try {
            res.json(await rollback(req.params.siteId));
        } catch (error) {
            res.status(error.status || 500).json({ error: error.code || 'rollback_failed', message: error.message });
        }
    });
    app.post('/api/deployments/:siteId/stop', async (req, res) => {
        try {
            const deployment = state[req.params.siteId];
            if (!deployment) {
                return res.status(404).json({ error: 'deployment_not_found' });
            }
            await stopRuntime(req.params.siteId);
            res.json(publicStatus(deployment, childProcesses));
        } catch (error) {
            res.status(error.status || 500).json({ error: error.code || 'stop_failed', message: error.message });
        }
    });
    app.post('/api/deployments/:siteId/start', async (req, res) => {
        try {
            const deployment = state[req.params.siteId];
            if (!deployment) {
                return res.status(404).json({ error: 'deployment_not_found' });
            }
            await startRuntime(req.params.siteId, deployment.current, deployment.port, deployment.settings || settingsFromState(deployment));
            res.json(publicStatus(deployment, childProcesses));
        } catch (error) {
            res.status(error.status || 500).json({ error: error.code || 'start_failed', message: error.message });
        }
    });

    async function deploy(siteId, archive, config) {
        if (!SITE_ID.test(siteId) || !RELEASE_ID.test(config.version || '')) {
            throw httpError(400, 'invalid_release', 'Invalid site or release identifier.');
        }
        if (!Buffer.isBuffer(archive) || !archive.length || archive.length > MAX_RELEASE_SIZE) {
            throw httpError(400, 'invalid_archive', 'The release archive is missing or too large.');
        }
        if (!fs.existsSync(runtimeMain)) {
            throw httpError(503, 'runtime_missing', `FUXA runtime not found at ${runtimeMain}.`);
        }
        if (!['ip-port', 'iis'].includes(config.mode)) {
            throw httpError(400, 'invalid_hosting_mode', 'Hosting mode must be ip-port or iis.');
        }
        const port = validPort(config.port, 'runtime port');
        if (config.mode === 'ip-port' && config.https && !hasRuntimeTls()) {
            throw httpError(503, 'runtime_tls_missing', 'HTTPS on an IP/port runtime requires the agent TLS key and certificate.');
        }
        const digest = crypto.createHash('sha256').update(archive).digest('hex');
        if (!/^[a-f0-9]{64}$/i.test(String(config.sha256 || '')) ||
            !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(config.sha256).toLowerCase()))) {
            throw httpError(400, 'checksum_mismatch', 'The release checksum is invalid.');
        }

        const entries = zip.read(archive);
        if (entries.length > MAX_RELEASE_FILES ||
            entries.reduce((sum, entry) => sum + entry.data.length, 0) > MAX_RELEASE_CONTENT) {
            throw httpError(413, 'release_too_large', 'The uncompressed release exceeds the agent limits.');
        }
        const siteDir = path.join(root, 'sites', siteId, 'releases');
        const staging = path.join(siteDir, `.staging-${config.version}-${crypto.randomBytes(5).toString('hex')}`);
        const releaseDir = path.join(siteDir, config.version);
        if (fs.existsSync(releaseDir)) {
            throw httpError(409, 'release_exists', 'This release identifier is already installed.');
        }

        let projectFiles = 0;
        const safeEntries = entries.map(entry => {
            const parts = entry.name.split('/').filter(Boolean);
            if (parts[0] !== siteId || parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
                throw httpError(400, 'invalid_archive_path', 'The archive contains an invalid path.');
            }
            const relative = parts.slice(1).join(path.sep);
            if (!relative) {
                throw httpError(400, 'invalid_archive_path', 'The archive contains an empty file path.');
            }
            if (relative.startsWith(`_appdata${path.sep}`)) {
                projectFiles++;
            }
            return { relative, data: entry.data };
        });
        if (!safeEntries.some(entry => entry.relative === 'site.json') || !projectFiles) {
            throw httpError(400, 'invalid_release', 'The archive is missing site metadata or project data.');
        }

        fs.mkdirSync(staging, { recursive: true });
        try {
            safeEntries.forEach(entry => {
                const target = path.resolve(staging, entry.relative);
                if (!target.startsWith(staging + path.sep)) {
                    throw httpError(400, 'invalid_archive_path', 'The archive contains an invalid path.');
                }
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, entry.data, { flag: 'wx' });
            });
            fs.renameSync(staging, releaseDir);
        } catch (error) {
            fs.rmSync(staging, { recursive: true, force: true });
            throw error;
        }

        const previous = state[siteId];
        try {
            await stopRuntime(siteId);
            if (config.mode === 'iis') {
                await configureIis(siteId, config, port);
            }
            const settings = deploymentSettings(config, port);
            await startRuntime(siteId, config.version, port, settings);
            const deployment = {
                siteId,
                current: config.version,
                previous: previous ? previous.current : null,
                previousPort: previous ? previous.port : null,
                previousSettings: previous ? previous.settings || settingsFromState(previous) : null,
                port,
                settings,
                mode: settings.mode,
                hostname: settings.hostname,
                https: settings.https,
                iisName: settings.iisName,
                iisPort: settings.iisPort,
                iisHost: settings.iisHost,
                publishedAt: new Date().toISOString(),
                checksum: digest
            };
            state[siteId] = deployment;
            writeState(deploymentsFile, state);
            return publicStatus(deployment, childProcesses);
        } catch (error) {
            if (previous) {
                state[siteId] = previous;
            } else {
                delete state[siteId];
            }
            await stopRuntime(siteId);
            if (previous && previous.current) {
                const previousSettings = previous.settings || settingsFromState(previous);
                if (previousSettings.mode === 'iis') {
                    await configureIis(siteId, previousSettings, previous.port);
                }
                await startRuntime(siteId, previous.current, previous.port, previousSettings);
            }
            fs.rmSync(releaseDir, { recursive: true, force: true });
            throw error;
        }
    }

    async function rollback(siteId) {
        const deployment = state[siteId];
        if (!deployment || !deployment.previous) {
            throw httpError(409, 'no_rollback_release', 'There is no previous release to restore.');
        }
        const current = deployment.current;
        const currentSettings = deployment.settings || settingsFromState(deployment);
        const previousSettings = deployment.previousSettings || currentSettings;
        await stopRuntime(siteId);
        const previousPort = deployment.previousPort || deployment.port;
        try {
            if (previousSettings.mode === 'iis') {
                await configureIis(siteId, previousSettings, previousPort);
            }
            await startRuntime(siteId, deployment.previous, previousPort, previousSettings);
        } catch (error) {
            try {
                if (currentSettings.mode === 'iis') {
                    await configureIis(siteId, currentSettings, deployment.port);
                }
                await startRuntime(siteId, current, deployment.port, currentSettings);
            } catch (recoveryError) {
                throw new Error(`Rollback failed: ${error.message}. Current release recovery failed: ${recoveryError.message}`);
            }
            throw error;
        }
        deployment.current = deployment.previous;
        deployment.previous = current;
        deployment.previousPort = deployment.port;
        deployment.port = previousPort;
        deployment.previousSettings = currentSettings;
        deployment.settings = previousSettings;
        deployment.mode = previousSettings.mode;
        deployment.hostname = previousSettings.hostname;
        deployment.https = previousSettings.https;
        deployment.iisName = previousSettings.iisName;
        deployment.iisPort = previousSettings.iisPort;
        deployment.iisHost = previousSettings.iisHost;
        deployment.publishedAt = new Date().toISOString();
        writeState(deploymentsFile, state);
        return publicStatus(deployment, childProcesses);
    }

    async function startRuntime(siteId, version, port, settings) {
        if (!SITE_ID.test(siteId) || !RELEASE_ID.test(version || '')) {
            throw httpError(400, 'invalid_release', 'Invalid site or release identifier.');
        }
        const userDir = path.join(root, 'sites', siteId, 'releases', version);
        if (!fs.existsSync(path.join(userDir, '_appdata'))) {
            throw httpError(404, 'release_not_found', 'The release project files are missing.');
        }
        const runtimeSettings = settings || { mode: 'iis', https: false };
        const runtimeEnv = {
            BASE_PATH: '',
            NODE_ENV: 'prod',
            FUXA_SITE: siteId,
            FUXA_SITE_BIND_HOST: runtimeSettings.mode === 'ip-port' ? '0.0.0.0' : '127.0.0.1'
        };
        if (runtimeSettings.mode === 'ip-port' && runtimeSettings.https) {
            runtimeEnv.FUXA_SITE_HTTPS_KEY = runtimeTls.key;
            runtimeEnv.FUXA_SITE_HTTPS_CERT = runtimeTls.cert;
        }
        const child = spawn(options.nodePath || process.execPath, [runtimeMain, '--userDir', userDir, '--port', String(port)], {
            cwd: runtimeDir,
            env: Object.assign({}, process.env, runtimeEnv),
            windowsHide: true,
            stdio: 'ignore'
        });
        childProcesses.set(siteId, child);
        child.once('exit', () => {
            if (childProcesses.get(siteId) === child) {
                childProcesses.delete(siteId);
            }
        });
        try {
            await waitForRuntime(port, child, runtimeSettings.https && runtimeSettings.mode === 'ip-port');
        } catch (error) {
            childProcesses.delete(siteId);
            child.kill();
            throw error;
        }
    }

    async function stopRuntime(siteId) {
        const child = childProcesses.get(siteId);
        if (!child) {
            return;
        }
        childProcesses.delete(siteId);
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        await new Promise(resolve => {
            const timeout = setTimeout(() => {
                child.kill();
                resolve();
            }, 10000);
            child.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
            child.kill();
        });
    }

    async function waitForRuntime(port, child, secure) {
        const end = Date.now() + 45000;
        let lastError;
        while (Date.now() < end && child.exitCode === null && child.signalCode === null) {
            try {
                const protocol = secure ? 'https' : 'http';
                const status = await httpGet(`${protocol}://127.0.0.1:${port}/api/version`, secure);
                if (status >= 200 && status < 300) {
                    return;
                }
            } catch (error) {
                lastError = error;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        throw httpError(503, 'runtime_start_failed',
            `The FUXA runtime did not become healthy${lastError ? `: ${lastError.message}` : '.'}`);
    }

    async function configureIis(siteId, config, runtimePort) {
        if (process.platform !== 'win32') {
            throw httpError(501, 'iis_unavailable', 'IIS publishing requires a Windows deployment agent.');
        }
        const iisName = config.iisName || `FUXA-${siteId}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(iisName)) {
            throw httpError(400, 'invalid_iis_site', 'Invalid IIS site name.');
        }
        const iisPort = validPort(config.iisPort, 'IIS port');
        const iisHost = String(config.iisHost || '');
        if (iisHost && !/^[A-Za-z0-9.-]{1,253}$/.test(iisHost)) {
            throw httpError(400, 'invalid_iis_host', 'Invalid IIS host name.');
        }
        const physicalPath = path.join(root, 'iis', siteId);
        fs.mkdirSync(physicalPath, { recursive: true });
        fs.writeFileSync(path.join(physicalPath, 'web.config'), iisConfig(runtimePort), 'utf8');
        const script = [
            "$ErrorActionPreference = 'Stop'",
            "Import-Module WebAdministration",
            "$name = $env:FUXA_IIS_NAME",
            "$physical = $env:FUXA_IIS_PATH",
            "$port = [int]$env:FUXA_IIS_PORT",
            "$hostName = $env:FUXA_IIS_HOST",
            "$useHttps = $env:FUXA_IIS_HTTPS -eq 'true'",
            "$protocol = if ($useHttps) { 'https' } else { 'http' }",
            "$site = Get-Website -Name $name -ErrorAction SilentlyContinue",
            "if ($site -and [IO.Path]::GetFullPath($site.PhysicalPath) -ne [IO.Path]::GetFullPath($physical)) { throw 'IIS site exists outside deployment-agent ownership.' }",
            "if (-not $site) { New-Website -Name $name -PhysicalPath $physical -Port $port -HostHeader $hostName -Ssl:$useHttps -Force | Out-Null }",
            "$binding = Get-WebBinding -Name $name -Protocol $protocol -Port $port",
            "if (-not $binding) { New-WebBinding -Name $name -Protocol $protocol -Port $port -HostHeader $hostName | Out-Null; $binding = Get-WebBinding -Name $name -Protocol $protocol -Port $port }",
            "if ($useHttps) {",
            "  $thumb = $env:FUXA_IIS_CERTIFICATE",
            "  if (-not $thumb -or -not (Test-Path ('Cert:\\LocalMachine\\My\\' + $thumb))) { throw 'HTTPS certificate not found in LocalMachine\\My.' }",
            "  $binding = Get-WebBinding -Name $name -Protocol https -Port $port",
            "  if (-not $binding) { New-WebBinding -Name $name -Protocol https -Port $port -HostHeader $hostName | Out-Null; $binding = Get-WebBinding -Name $name -Protocol https -Port $port }",
            "  $binding.AddSslCertificate($thumb, 'My')",
            "}",
            "Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name enabled -Value $true"
        ].join('; ');
        await runPowerShell(script, {
            FUXA_IIS_NAME: iisName,
            FUXA_IIS_PATH: physicalPath,
            FUXA_IIS_PORT: String(iisPort),
            FUXA_IIS_HOST: iisHost,
            FUXA_IIS_HTTPS: config.https ? 'true' : 'false',
            FUXA_IIS_CERTIFICATE: String(config.certificate || '')
        });
    }

    function publicStatus(deployment, processes) {
        const mode = deployment.mode || 'ip-port';
        const host = deployment.hostname || 'localhost';
        const scheme = deployment.https ? 'https' : 'http';
        const url = mode === 'iis'
            ? `${scheme}://${deployment.iisHost || host}${deployment.iisPort && deployment.iisPort !== (deployment.https ? 443 : 80) ? ':' + deployment.iisPort : ''}/`
            : `${scheme}://${host}:${deployment.port}/`;
        return Object.assign({}, deployment, {
            running: !!(processes && processes.get(deployment.siteId) &&
                processes.get(deployment.siteId).exitCode === null &&
                processes.get(deployment.siteId).signalCode === null),
            url
        });
    }

    function deploymentSettings(config, port) {
        return {
            mode: config.mode,
            https: !!config.https,
            hostname: String(config.hostname || ''),
            port,
            iisName: String(config.iisName || ''),
            iisPort: config.iisPort ? validPort(config.iisPort, 'IIS port') : null,
            iisHost: String(config.iisHost || ''),
            certificate: String(config.certificate || '')
        };
    }

    function settingsFromState(deployment) {
        return {
            mode: deployment.mode || 'ip-port',
            https: !!deployment.https,
            hostname: deployment.hostname || '',
            port: deployment.port,
            iisName: deployment.iisName || '',
            iisPort: deployment.iisPort || null,
            iisHost: deployment.iisHost || '',
            certificate: deployment.certificate || ''
        };
    }

    function hasRuntimeTls() {
        const key = runtimeTls.key;
        const cert = runtimeTls.cert;
        if (!key || !cert) {
            return false;
        }
        try {
            return fs.statSync(key).isFile() && fs.statSync(cert).isFile();
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'EACCES') {
                return false;
            }
            throw error;
        }
    }

    function readState(file) {
        try {
            const value = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('Deployment state must be a JSON object.');
            }
            return value;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return {};
            }
            throw new Error(`Unable to read deployment state ${file}: ${error.message}`);
        }
    }
    function writeState(file, value) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
        fs.renameSync(temp, file);
    }

    function httpError(status, code, message) {
        const error = new Error(message);
        error.status = status;
        error.code = code;
        return error;
    }
    function validPort(value, label) {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw httpError(400, 'invalid_port', `Invalid ${label}.`);
        }
        return port;
    }
    function httpGet(url, secure) {
        return new Promise((resolve, reject) => {
            const transport = secure ? require('https') : http;
            const req = transport.get(url, secure ? { rejectUnauthorized: false } : {}, res => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            });
            req.setTimeout(3000, () => req.destroy(new Error('timeout')));
            req.on('error', reject);
        });
    }
    function isPortFree(port) {
        const net = require('net');
        return new Promise(resolve => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => server.close(() => resolve(true)));
            server.listen(port, '0.0.0.0');
        });
    }
    function runPowerShell(script, env) {
        return new Promise((resolve, reject) => {
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
                windowsHide: true,
                env: Object.assign({}, process.env, env),
                stdio: ['ignore', 'ignore', 'pipe']
            });
            let errorText = '';
            child.stderr.on('data', chunk => { errorText += chunk.toString(); });
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(httpError(503, 'iis_configuration_failed', errorText.trim() || `PowerShell exited with code ${code}.`)));
        });
    }
    function iisConfig(port) {
        return `<?xml version="1.0" encoding="UTF-8"?><configuration><system.webServer><webSocket enabled="true"/><rewrite><rules><rule name="FUXA runtime proxy" stopProcessing="true"><match url="(.*)"/><action type="Rewrite" url="http://127.0.0.1:${port}/{R:1}" appendQueryString="true"/></rule></rules></rewrite></system.webServer></configuration>`;
    }

    async function restoreRunning() {
        const errors = [];
        for (const [siteId, deployment] of Object.entries(state)) {
            try {
                await startRuntime(siteId, deployment.current, deployment.port, deployment.settings || settingsFromState(deployment));
            } catch (error) {
                errors.push(`${siteId}: ${error.message}`);
            }
        }
        writeState(deploymentsFile, state);
        if (errors.length) {
            throw new Error(`Unable to restore deployed runtimes: ${errors.join('; ')}`);
        }
    }

    return {
        app,
        restoreRunning,
        close: async () => {
            await Promise.all(Array.from(childProcesses.keys(), stopRuntime));
        }
    };
}

module.exports = { create };
