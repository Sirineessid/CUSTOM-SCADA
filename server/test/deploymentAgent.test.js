'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zip = require('../runtime/sites/zip');
const { create } = require('../deployment-agent/agent');

describe('FUXA deployment agent', function () {
    this.timeout(15000);

    let tempDir;
    let agent;
    let server;
    let baseUrl;
    let runtimePort;
    const token = 'local-deployment-agent-test-token-123456';

    before(async function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-deployment-agent-'));
        const runtimeDir = path.join(tempDir, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(path.join(runtimeDir, 'main.js'),
            "const http=require('http');const i=process.argv.indexOf('--port');const port=Number(process.argv[i+1]);http.createServer((req,res)=>{res.statusCode=200;if(req.url==='/deployment-test'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({site:process.env.FUXA_SITE,host:process.env.FUXA_SITE_BIND_HOST}))}res.end('healthy')}).listen(port,'0.0.0.0');");
        runtimePort = await freePort();
        agent = create({ root: path.join(tempDir, 'agent-data'), runtimeDir, token });
        server = http.createServer(agent.app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async function () {
        if (agent) {
            await agent.close();
        }
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('authenticates requests and verifies the FUXA runtime target', async function () {
        const denied = await fetch(`${baseUrl}/health`);
        assert.strictEqual(denied.status, 401);

        const result = await request('/api/preflight', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteId: 'siteA', mode: 'ip-port', runtimePort })
        });
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.ok, true);

        const httpsResult = await request('/api/preflight', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteId: 'siteA', mode: 'ip-port', runtimePort, https: true })
        });
        assert.strictEqual(httpsResult.status, 422);
        assert.strictEqual(httpsResult.body.checks.some(check => check.name === 'runtime-tls' && !check.ok), true);
    });

    it('publishes a release, serves it, and rolls back to the previous version', async function () {
        const first = await publish('release-one');
        assert.strictEqual(first.status, 201);
        assert.strictEqual(first.body.current, 'release-one');
        assert.strictEqual(first.body.running, true);
        const runtime = await fetch(`http://127.0.0.1:${runtimePort}/deployment-test`).then(response => response.json());
        assert.strictEqual(runtime.site, 'siteA');
        assert.strictEqual(runtime.host, '0.0.0.0');

        const second = await publish('release-two');
        assert.strictEqual(second.status, 201);
        assert.strictEqual(second.body.current, 'release-two');
        assert.strictEqual(second.body.previous, 'release-one');

        const rollback = await request('/api/deployments/siteA/rollback', { method: 'POST' });
        assert.strictEqual(rollback.status, 200);
        assert.strictEqual(rollback.body.current, 'release-one');
        assert.strictEqual(rollback.body.previous, 'release-two');
    });

    it('rejects archive path traversal before writing release files', async function () {
        const archive = zip.create([
            { name: 'siteA/site.json', data: '{}' },
            { name: 'siteA/_appdata/project.json', data: '{}' },
            { name: 'siteA/../outside.txt', data: 'no' }
        ]);
        const response = await request('/api/deployments/siteA/release', {
            method: 'PUT',
            body: archive,
            headers: releaseHeaders('unsafe-release', archive)
        });
        assert.strictEqual(response.status, 400);
        assert.strictEqual(fs.existsSync(path.join(tempDir, 'agent-data', 'sites', 'outside.txt')), false);
    });

    async function publish(version) {
        const archive = zip.create([
            { name: 'siteA/site.json', data: JSON.stringify({ name: 'siteA' }) },
            { name: 'siteA/_appdata/project.json', data: JSON.stringify({ hmi: { views: [] } }) }
        ]);
        return request('/api/deployments/siteA/release', {
            method: 'PUT',
            body: archive,
            headers: releaseHeaders(version, archive)
        });
    }

    function releaseHeaders(version, archive) {
        return {
            'Content-Type': 'application/zip',
            'X-Release-Version': version,
            'X-Release-SHA256': crypto.createHash('sha256').update(archive).digest('hex'),
            'X-Hosting-Mode': 'ip-port',
            'X-Runtime-Port': String(runtimePort),
            'X-Public-Host': '127.0.0.1'
        };
    }

    async function request(route, options) {
        const settings = options || {};
        const response = await fetch(`${baseUrl}${route}`, Object.assign({}, settings, {
            headers: Object.assign({ Authorization: `Bearer ${token}` }, settings.headers || {})
        }));
        const text = await response.text();
        let body;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
        return { status: response.status, body };
    }

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
});
