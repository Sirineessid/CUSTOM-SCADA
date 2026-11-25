'use strict';

const assert = require('assert');
const http = require('http');
const opcua2pgApi = require('../api/opcua2pg');

describe('OPC UA to PostgreSQL API authorization', function () {
    let server;
    let baseUrl;

    before(async function () {
        const runtime = {
            settings: { secureEnabled: true },
            logger: { info: function () {} }
        };
        opcua2pgApi.init(
            runtime,
            function (req, res, next) { next(); },
            function (req) { return req.headers['x-test-role'] === 'admin' ? -1 : 0; }
        );
        server = http.createServer(opcua2pgApi.app());
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async function () {
        opcua2pgApi.stop();
        if (server) {
            await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        }
    });

    it('denies non-admin access to the API and embedded UI', async function () {
        const apiResponse = await fetch(`${baseUrl}/api/opcua2pg/generator/status`);
        const uiResponse = await fetch(`${baseUrl}/opcua2pg/index.html`);

        assert.strictEqual(apiResponse.status, 401);
        assert.strictEqual(uiResponse.status, 401);
    });

    it('allows administrators to access the API and embedded UI', async function () {
        const headers = { 'x-test-role': 'admin' };
        const apiResponse = await fetch(`${baseUrl}/api/opcua2pg/generator/status`, { headers });
        const uiResponse = await fetch(`${baseUrl}/opcua2pg/index.html`, { headers });

        assert.strictEqual(apiResponse.status, 200);
        assert.strictEqual(uiResponse.status, 200);
    });
});
