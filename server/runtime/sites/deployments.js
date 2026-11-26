'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MODES = ['ip-port', 'iis'];
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const operations = new Map();
let dataDir;
let logger;

function router(manager, settings, appLogger) {
    dataDir = path.join(settings.workDir, 'deployments');
    logger = appLogger;
    const app = express.Router({ mergeParams: true });
    const endpoint = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

    app.use(express.json({ limit: '1mb' }));

    app.get('/', endpoint((req, res) => {
        const site = findSite(manager, req.params.site_id);
        const saved = readSite(site.name);
        res.json({ data: { target: saved.target || null, latest: (saved.history || [])[0] || null }, meta: { site_id: site.name } });
    }));

    app.put('/target', endpoint((req, res) => {
        const site = findSite(manager, req.params.site_id);
        const target = validateTarget(req.body);
        const saved = readSite(site.name);
        saved.target = target;
        writeSite(site.name, saved);
        res.json({ data: target, meta: { site_id: site.name } });
    }));

    app.post('/preflight', endpoint(async (req, res) => {
        const site = findSite(manager, req.params.site_id);
        const result = await preflight(manager, site, readSite(site.name).target);
        res.status(result.ok ? 200 : 422).json({ data: result, meta: { site_id: site.name } });
    }));

    app.get('/package', endpoint(async (req, res) => {
            const site = findSite(manager, req.params.site_id);
            const result = await preflight(manager, site, readSite(site.name).target, { checkAgent: false, requireTarget: false });
            if (!result.ok) {
                return res.status(422).json({ error: 'preflight_failed', data: result });
            }
            const release = await manager.packageSite(site);
            const date = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
            const version = `${date}-${crypto.createHash('sha256').update(release.buffer).digest('hex').slice(0, 8)}`;
            res.set({
                'Content-Type': 'application/zip',
                'Content-Length': release.buffer.length,
                'Content-Disposition': `attachment; filename="FUXA_${site.name}_${version}.zip"`,
                'X-Release-Version': version,
                'X-Release-SHA256': crypto.createHash('sha256').update(release.buffer).digest('hex')
            });
            res.end(release.buffer);
    }));

    app.post('/publish', endpoint(async (req, res) => {
        const site = findSite(manager, req.params.site_id);
        const saved = readSite(site.name);
        if (!saved.target) {
            return res.status(400).json({ error: 'target_missing', message: 'Configure a deployment target first.' });
        }
        const check = await preflight(manager, site, saved.target);
        if (!check.ok) {
            return res.status(422).json({ error: 'preflight_failed', data: check });
        }
        const operation = makeOperation(site.name);
        operations.set(operation.operation_id, operation);
        res.status(202).json({ data: operation, meta: { site_id: site.name } });
        publish(manager, site, saved.target, operation).catch(error => {
            if (logger) {
                logger.error(`site deployment ${operation.operation_id}: ${error.message}`);
            }
            updateOperation(operation, 'failed', 100, error.message);
        });
    }));

    app.get('/operations/:operation_id', endpoint((req, res) => {
        const operation = operations.get(req.params.operation_id);
        if (!operation || operation.site_id !== req.params.site_id) {
            return res.status(404).json({ error: 'operation_not_found' });
        }
        res.json({ data: operation, meta: { site_id: operation.site_id } });
    }));

    app.get('/status', endpoint(async (req, res) => {
        const site = findSite(manager, req.params.site_id);
        const saved = readSite(site.name);
        if (!saved.target) {
            return res.status(404).json({ error: 'target_missing' });
        }
        try {
            const data = await agentRequest(saved.target, '/api/deployments/' + encodeURIComponent(site.name));
            res.json({ data, meta: { site_id: site.name } });
        } catch (error) {
            res.status(502).json({ error: 'agent_unavailable', message: error.message });
        }
    }));

    app.post('/rollback', endpoint(async (req, res) => {
        const site = findSite(manager, req.params.site_id);
        const target = readSite(site.name).target;
        if (!target) {
            return res.status(400).json({ error: 'target_missing' });
        }
        try {
            const data = await agentRequest(target, `/api/deployments/${encodeURIComponent(site.name)}/rollback`, { method: 'POST' });
            recordRelease(site.name, { action: 'rollback', time: new Date().toISOString(), release: data.current, url: data.url });
            res.json({ data, meta: { site_id: site.name } });
        } catch (error) {
            res.status(502).json({ error: 'rollback_failed', message: error.message });
        }
    }));

    app.use((error, req, res, next) => {
        if (res.headersSent) {
            return next(error);
        }
        res.status(error.status || 500).json({ error: error.code || 'deployment_error', message: error.message });
    });

    return app;
}

async function preflight(manager, site, target, options) {
    const errors = [];
    const warnings = [];
    const checks = [];
    if (!site.running) {
        errors.push('Le runtime du site source est arrêté.');
    }
    checks.push({ name: 'runtime-source', ok: !!site.running });
    if (!target && (!options || options.requireTarget !== false)) {
        errors.push('Aucune cible de déploiement n’est configurée.');
        return { ok: false, errors, warnings, checks };
    }
    if (target) {
        warnings.push('La publication expose directement le runtime cible : configurez son authentification indépendamment des comptes centraux.');
    }
    if ((!options || options.checkAgent !== false) &&
        (!process.env.FUXA_DEPLOYMENT_TOKEN || Buffer.byteLength(process.env.FUXA_DEPLOYMENT_TOKEN) < 32)) {
        errors.push('Le secret FUXA_DEPLOYMENT_TOKEN doit contenir au moins 32 caractères sur le serveur de contrôle.');
    }
    try {
        const project = await manager.request(site, 'GET', '/api/project');
        const views = project && project.hmi && project.hmi.views;
        if (!Array.isArray(views) || !views.length) {
            errors.push('Le projet ne contient aucune page synoptique.');
        }
        const devices = Object.values((project && project.devices) || {});
        checks.push({ name: 'project', ok: Array.isArray(views) && views.length > 0, pages: views ? views.length : 0, devices: devices.length });
        const diagnostic = await manager.request(site, 'GET', '/api/v1/diagnostic');
        const disconnected = (diagnostic.data && diagnostic.data.devices || []).filter(device => device.enabled && !device.connected);
        if (disconnected.length) {
            warnings.push(`${disconnected.length} équipement(s) activé(s) ne communiquent pas actuellement.`);
        }
        checks.push({ name: 'communications', ok: disconnected.length === 0, disconnected: disconnected.map(device => device.name) });
    } catch (error) {
        errors.push(`Impossible de vérifier le projet source : ${error.message}`);
    }
    if (!options || options.checkAgent !== false) {
        try {
            const agent = await agentRequest(target, '/api/preflight', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ siteId: site.name, mode: target.mode, runtimePort: target.runtimePort, https: target.https, certificateThumbprint: target.certificateThumbprint })
            });
            checks.push({ name: 'deployment-agent', ok: true });
            checks.push(...agent.checks);
            errors.push(...agent.errors);
        } catch (error) {
            if (error.response && error.response.checks) {
                checks.push({ name: 'deployment-agent', ok: true });
                checks.push(...error.response.checks);
                errors.push(...error.response.errors);
                return { ok: errors.length === 0, errors, warnings, checks };
            }
            errors.push(`Agent de déploiement inaccessible : ${error.message}`);
            checks.push({ name: 'deployment-agent', ok: false });
        }
    }
    return { ok: errors.length === 0, errors, warnings, checks };
}

async function publish(manager, site, target, operation) {
    updateOperation(operation, 'packaging', 10, 'Validation du projet terminée.');
    const release = await manager.packageSite(site);
    const sha256 = crypto.createHash('sha256').update(release.buffer).digest('hex');
    const version = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${sha256.slice(0, 8)}`;
    manager.createBackup(site, `Avant publication ${version}`);
    updateOperation(operation, 'transferring', 45, `Transfert du package (${release.buffer.length} octets).`);
    const data = await agentRequest(target, `/api/deployments/${encodeURIComponent(site.name)}/release`, {
        method: 'PUT',
        body: release.buffer,
        headers: {
            'Content-Type': 'application/zip',
            'X-Release-Version': version,
            'X-Release-SHA256': sha256,
            'X-Hosting-Mode': target.mode,
            'X-Runtime-Port': String(target.runtimePort),
            'X-Public-Host': target.publicHost,
            'X-Public-Https': String(target.https),
            'X-IIS-Site': target.iisSiteName || '',
            'X-IIS-Port': String(target.iisPort || ''),
            'X-IIS-Host': target.iisHost || '',
            'X-IIS-Certificate': target.certificateThumbprint || ''
        },
        timeout: 10 * 60 * 1000
    });
    updateOperation(operation, 'published', 100, `Publié : ${data.url}`);
    operation.release = data.current;
    operation.url = data.url;
    const saved = readSite(site.name);
    saved.history = [{ action: 'publish', time: new Date().toISOString(), release: data.current, url: data.url, checksum: sha256 }].concat(saved.history || []).slice(0, 100);
    writeSite(site.name, saved);
}

function agentRequest(target, route, options) {
    const settings = options || {};
    const url = new URL(route, target.agentUrl.endsWith('/') ? target.agentUrl : `${target.agentUrl}/`);
    const timeout = settings.timeout || 10000;
    return fetch(url, {
        method: settings.method || 'GET',
        headers: Object.assign({
            Authorization: `Bearer ${process.env.FUXA_DEPLOYMENT_TOKEN}`
        }, settings.headers || {}),
        body: settings.body,
        signal: AbortSignal.timeout(timeout)
    }).then(async response => {
        const text = await response.text();
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (error) {
                throw new Error(`Deployment agent returned invalid JSON: ${error.message}`);
            }
        }
        if (!response.ok) {
            const details = data && typeof data === 'object' ? data : {};
            const error = new Error(details.message || details.error || `HTTP ${response.status}`);
            error.response = data;
            throw error;
        }
        if (!data || typeof data !== 'object') {
            throw new Error('Deployment agent returned an empty or invalid response.');
        }
        return data;
    });
}

function validateTarget(input) {
    const target = input && typeof input === 'object' ? input : {};
    const agentUrl = String(target.agentUrl || '').trim().replace(/\/+$/, '');
    let url;
    try { url = new URL(agentUrl); } catch (_) { throw httpError(400, 'invalid_agent_url', 'Agent URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw httpError(400, 'invalid_agent_url', 'Agent URL must be an HTTP(S) URL without credentials or query parameters.');
    }
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLoopback) {
        throw httpError(400, 'https_required', 'Remote deployment agents must use HTTPS.');
    }
    const mode = String(target.mode || '');
    if (!['ip-port', 'iis'].includes(mode)) {
        throw httpError(400, 'invalid_mode', 'Choose IP/port or IIS hosting.');
    }
    const runtimePort = Number(target.runtimePort);
    if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) {
        throw httpError(400, 'invalid_port', 'Runtime port must be between 1 and 65535.');
    }
    const publicHost = String(target.publicHost || '').trim();
    if (!HOST.test(publicHost)) {
        throw httpError(400, 'invalid_host', 'Enter a valid public host name or IP address.');
    }
    const result = {
        agentUrl: url.toString().replace(/\/+$/, ''),
        mode,
        runtimePort,
        publicHost,
        https: target.https === true,
        iisSiteName: String(target.iisSiteName || '').trim(),
        iisPort: target.iisPort ? Number(target.iisPort) : (target.https ? 443 : 80),
        iisHost: String(target.iisHost || '').trim(),
        certificateThumbprint: String(target.certificateThumbprint || '').trim()
    };
    if (mode === 'iis' && (!result.iisSiteName || !Number.isInteger(result.iisPort) || result.iisPort < 1 || result.iisPort > 65535)) {
        throw httpError(400, 'invalid_iis_target', 'IIS mode requires a site name and valid binding port.');
    }
    if (result.https && mode === 'iis' && !result.certificateThumbprint) {
        throw httpError(400, 'certificate_required', 'HTTPS on IIS requires a certificate thumbprint.');
    }
    return result;
}

function findSite(manager, id) {
    if (!SITE_ID.test(String(id || ''))) {
        throw httpError(400, 'invalid_site', 'Invalid site identifier.');
    }
    const site = manager.get(id);
    if (!site) {
        throw httpError(404, 'site_not_found', `Site "${id}" not found.`);
    }
    return site;
}

function readSite(site) {
    const file = path.join(dataDir, `${site}.json`);
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Deployment data must be a JSON object.');
        }
        return value;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw new Error(`Unable to read deployment data for ${site}: ${error.message}`);
    }
}
function writeSite(site, value) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, `${site}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
}
function makeOperation(siteId) {
    return { operation_id: crypto.randomUUID(), site_id: siteId, state: 'queued', progress: 0, logs: [], created_at: new Date().toISOString() };
}
function updateOperation(operation, state, progress, message) {
    operation.state = state;
    operation.progress = progress;
    operation.logs.push({ time: new Date().toISOString(), message });
    operation.logs = operation.logs.slice(-100);
}
function recordRelease(site, entry) {
    const saved = readSite(site);
    saved.history = [entry].concat(saved.history || []).slice(0, 100);
    writeSite(site, saved);
}
function httpError(status, code, message) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

module.exports = { router, validateTarget, preflight };
