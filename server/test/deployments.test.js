'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zip = require('../runtime/sites/zip');
const { create: createAgent } = require('../deployment-agent/agent');
const { router, validateTarget } = require('../runtime/sites/deployments');

describe('site deployment control plane', function () {
    let tempDir;
    let server;
    let baseUrl;
    const site = { name: 'siteA', running: true };

    before(async function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-deployment-control-'));
        const app = express();
        const manager = {
            get: () => site,
            request: async (_site, _method, route) => route === '/api/project'
                ? { hmi: { views: ['overview'] }, devices: {} }
                : { data: { devices: [] } },
            packageSite: async () => ({ buffer: Buffer.from('test deployment package') })
        };
        app.use('/api/v1/sites/:site_id/deployment', router(manager, { workDir: tempDir }, null));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/sites/siteA/deployment`;
    });

    after(async function () {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('saves and returns a target from JSON requests', async function () {
        const target = {
            agentUrl: 'http://127.0.0.1:1882',
            mode: 'ip-port',
            runtimePort: 1881,
            publicHost: 'localhost',
            https: false
        };
        const saved = await fetch(`${baseUrl}/target`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(target)
        });
        assert.strictEqual(saved.status, 200);
        assert.strictEqual((await saved.json()).data.agentUrl, target.agentUrl);

        const response = await fetch(baseUrl);
        assert.strictEqual(response.status, 200);
        assert.strictEqual((await response.json()).data.target.runtimePort, 1881);
    });

    it('exports a package without requiring a configured agent target', async function () {
        const packageDir = path.join(tempDir, 'package-case');
        const app = express();
        const manager = {
            get: () => site,
            request: async (_site, _method, route) => route === '/api/project'
                ? { hmi: { views: ['overview'] }, devices: {} }
                : { data: { devices: [] } },
            packageSite: async () => ({ buffer: Buffer.from('test deployment package') })
        };
        app.use('/api/v1/sites/:site_id/deployment', router(manager, { workDir: packageDir }, null));
        const packageServer = http.createServer(app);
        await new Promise(resolve => packageServer.listen(0, '127.0.0.1', resolve));
        try {
            const response = await fetch(`http://127.0.0.1:${packageServer.address().port}/api/v1/sites/siteA/deployment/package`);
            assert.strictEqual(response.status, 200);
            assert.strictEqual(await response.text(), 'test deployment package');
        } finally {
            await new Promise(resolve => packageServer.close(resolve));
        }
    });

    it('rejects insecure remote agent URLs and invalid ports', function () {
        assert.throws(() => validateTarget({
            agentUrl: 'http://deployment.example.com',
            mode: 'ip-port',
            runtimePort: 1881,
            publicHost: 'scada.example.com'
        }), /HTTPS/);
        assert.throws(() => validateTarget({
            agentUrl: 'http://127.0.0.1:1882',
            mode: 'ip-port',
            runtimePort: 70000,
            publicHost: 'localhost'
        }), /port/i);
    });

    it('publishes a package through the control plane to a local deployment agent', async function () {
        const publishDir = path.join(tempDir, 'publish-case');
        const runtimeDir = path.join(publishDir, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(path.join(runtimeDir, 'main.js'),
            "const http=require('http');const i=process.argv.indexOf('--port');http.createServer((req,res)=>{res.statusCode=200;res.end('healthy')}).listen(Number(process.argv[i+1]),'0.0.0.0');");

        const token = 'local-control-agent-integration-token-123456';
        const priorToken = process.env.FUXA_DEPLOYMENT_TOKEN;
        process.env.FUXA_DEPLOYMENT_TOKEN = token;
        const runtimePort = await freePort();
        const agent = createAgent({ root: path.join(publishDir, 'agent-data'), runtimeDir, token });
        const agentServer = http.createServer(agent.app);
        const controlApp = express();
        const manager = {
            get: () => site,
            request: async (_site, _method, route) => route === '/api/project'
                ? { hmi: { views: ['overview'] }, devices: {} }
                : { data: { devices: [] } },
            packageSite: async () => ({
                buffer: zip.create([
                    { name: 'siteA/site.json', data: JSON.stringify({ name: 'siteA' }) },
                    { name: 'siteA/_appdata/project.json', data: JSON.stringify({ hmi: { views: ['overview'] } }) }
                ])
            }),
            createBackup: () => ({})
        };
        controlApp.use('/api/v1/sites/:site_id/deployment', router(manager, { workDir: publishDir }, null));
        const controlServer = http.createServer(controlApp);
        try {
            await Promise.all([
                new Promise(resolve => agentServer.listen(0, '127.0.0.1', resolve)),
                new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve))
            ]);
            const baseUrl = `http://127.0.0.1:${controlServer.address().port}/api/v1/sites/siteA/deployment`;
            const saved = await fetch(`${baseUrl}/target`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentUrl: `http://127.0.0.1:${agentServer.address().port}`,
                    mode: 'ip-port',
                    runtimePort,
                    publicHost: '127.0.0.1',
                    https: false
                })
            });
            assert.strictEqual(saved.status, 200);

            const started = await fetch(`${baseUrl}/publish`, { method: 'POST' });
            assert.strictEqual(started.status, 202);
            const operationId = (await started.json()).data.operation_id;
            let operation;
            for (let attempt = 0; attempt < 100; attempt++) {
                const response = await fetch(`${baseUrl}/operations/${operationId}`);
                operation = (await response.json()).data;
                if (['published', 'failed'].includes(operation.state)) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.strictEqual(operation.state, 'published', operation.logs.map(entry => entry.message).join('; '));

            const status = await fetch(`${baseUrl}/status`);
            assert.strictEqual(status.status, 200);
            assert.strictEqual((await status.json()).data.current, operation.release);
        } finally {
            await agent.close();
            await Promise.all([
                closeServer(agentServer),
                closeServer(controlServer)
            ]);
            if (priorToken === undefined) {
                delete process.env.FUXA_DEPLOYMENT_TOKEN;
            } else {
                process.env.FUXA_DEPLOYMENT_TOKEN = priorToken;
            }
        }
    });

    function freePort() {
        return new Promise((resolve, reject) => {
            const listener = net.createServer();
            listener.once('error', reject);
            listener.listen(0, '127.0.0.1', () => {
                const port = listener.address().port;
                listener.close(error => error ? reject(error) : resolve(port));
            });
        });
    }

    function closeServer(serverToClose) {
        return new Promise((resolve, reject) => {
            serverToClose.close(error => error ? reject(error) : resolve());
        });
    }
});
