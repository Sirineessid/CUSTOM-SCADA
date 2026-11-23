'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const siteApi = require('../../runtime/sites/api-v1-site');

describe('site maintenance API', function () {
    let server;
    let siteDir;
    let asset;
    let part;

    function request(method, url, body, contentType) {
        return new Promise((resolve, reject) => {
            const binary = Buffer.isBuffer(body);
            const data = body === undefined ? null : binary ? body : Buffer.from(JSON.stringify(body));
            const headers = {};
            if (data) {
                headers['Content-Type'] = contentType || (binary ? 'application/pdf' : 'application/json');
                headers['Content-Length'] = Buffer.byteLength(data);
            }
            const req = http.request({
                host: '127.0.0.1',
                port: server.address().port,
                method,
                path: url,
                headers
            }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    let result = buffer;
                    if (String(response.headers['content-type'] || '').includes('application/json')) {
                        result = JSON.parse(buffer.toString('utf8'));
                    }
                    resolve({ status: response.statusCode, headers: response.headers, body: result });
                });
            });
            req.on('error', reject);
            if (data) {
                req.write(data);
            }
            req.end();
        });
    }

    beforeEach(async function () {
        siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-maintenance-'));
        const runtimeTag = { id: 'tag-runtime', name: 'pump_hours', type: 'real', deviceName: 'PLC' };
        const runTag = { id: 'tag-run', name: 'pump_running', type: 'bool', deviceName: 'PLC' };
        const project = {
            devices: {
                plc: { name: 'PLC', polling: 3600000, tags: { [runtimeTag.id]: runtimeTag, [runTag.id]: runTag } }
            }
        };
        const runtime = {
            logger: { error() {}, info() {} },
            project: { getProject: async () => project },
            devices: {
                getTagValue: id => id === runtimeTag.id
                    ? { value: 1200, timestamp: Date.now() }
                    : id === runTag.id ? { value: false, timestamp: Date.now() } : null
            },
            daqStorage: {
                getNodeValues: async (tagId, from) => tagId === runTag.id
                    ? [{ dt: from, value: true }, { dt: from + 1800000, value: false }]
                    : []
            }
        };
        const app = express();
        app.use(express.json());
        app.use('/api/v1', siteApi.router(runtime, {
            secureEnabled: false,
            workDir: path.join(siteDir, '_db', 'fuxa.db')
        }, 'test-site'));
        server = await new Promise(resolve => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
    });

    afterEach(async function () {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(siteDir, { recursive: true, force: true });
    });

    it('persists equipment, schedules and parts and reports overdue maintenance', async function () {
        const initial = await request('GET', '/api/v1/maintenance');
        assert.strictEqual(initial.status, 200);
        assert.deepStrictEqual(initial.body.data.assets, []);

        const createdAsset = await request('POST', '/api/v1/maintenance/assets', {
            name: 'Pompe P1',
            runtimeTagId: 'tag-runtime',
            operatingHoursManual: 20
        });
        assert.strictEqual(createdAsset.status, 201);
        asset = createdAsset.body.data;

        const invalidTag = await request('POST', '/api/v1/maintenance/assets', {
            name: 'Pompe invalide',
            runtimeTagId: 'missing-tag'
        });
        assert.strictEqual(invalidTag.status, 400);

        const createdPart = await request('POST', '/api/v1/maintenance/parts', {
            name: 'Joint',
            sku: 'J-1',
            quantity: 3,
            minimumQuantity: 1
        });
        assert.strictEqual(createdPart.status, 201);
        part = createdPart.body.data;

        const order = await request('POST', '/api/v1/maintenance/work-orders', {
            assetId: asset.id,
            kind: 'failure',
            title: 'Remplacement du joint',
            occurredAt: new Date().toISOString(),
            status: 'closed',
            partsUsed: [{ partId: part.id, quantity: 2 }]
        });
        assert.strictEqual(order.status, 201);

        const insufficientStock = await request('POST', '/api/v1/maintenance/work-orders', {
            assetId: asset.id,
            kind: 'intervention',
            title: 'Stock insuffisant',
            occurredAt: new Date().toISOString(),
            partsUsed: [{ partId: part.id, quantity: 2 }]
        });
        assert.strictEqual(insufficientStock.status, 409);

        const schedule = await request('POST', '/api/v1/maintenance/schedules', {
            assetId: asset.id,
            title: 'Contrôle périodique',
            intervalDays: 30,
            lastDoneAt: new Date(Date.now() - 40 * 86400000).toISOString()
        });
        assert.strictEqual(schedule.status, 201);

        const hourSchedule = await request('POST', '/api/v1/maintenance/schedules', {
            assetId: asset.id,
            title: 'Révision au compteur',
            intervalHours: 1000,
            lastDoneHours: 0
        });
        assert.strictEqual(hourSchedule.status, 201);

        const metrics = await request('GET', '/api/v1/maintenance/metrics');
        assert.strictEqual(metrics.status, 200);
        assert.strictEqual(metrics.body.data.summary.overdueMaintenance, 2);
        assert.strictEqual(metrics.body.data.schedules.find(item => item.id === hourSchedule.body.data.id).due, true);
        assert.strictEqual(metrics.body.data.metrics[asset.id].operatingHours, 1200);
        assert.strictEqual(metrics.body.data.metrics[asset.id].operatingHoursSource, 'tag');

        const saved = await request('GET', '/api/v1/maintenance');
        assert.strictEqual(saved.body.data.workOrders.length, 1);
        assert.strictEqual(saved.body.data.parts[0].quantity, 1);
    });

    it('stores, serves and deletes PDF documents without accepting non-PDF content', async function () {
        const created = await request('POST', '/api/v1/maintenance/assets', { name: 'Pompe documentation' });
        asset = created.body.data;

        const invalid = await request('POST', `/api/v1/maintenance/assets/${asset.id}/documents?name=bad.pdf`, Buffer.from('not a PDF'));
        assert.strictEqual(invalid.status, 400);

        const pdf = Buffer.from('%PDF-1.4\nmaintenance test\n%%EOF');
        const uploaded = await request('POST', `/api/v1/maintenance/assets/${asset.id}/documents?name=fiche.pdf`, pdf);
        assert.strictEqual(uploaded.status, 201);
        const document = uploaded.body.data;

        const download = await request('GET', `/api/v1/maintenance/documents/${document.id}`);
        assert.strictEqual(download.status, 200);
        assert.strictEqual(download.headers['content-type'], 'application/pdf');
        assert.deepStrictEqual(download.body, pdf);

        const removed = await request('DELETE', `/api/v1/maintenance/documents/${document.id}`);
        assert.strictEqual(removed.status, 200);
        assert.strictEqual((await request('GET', `/api/v1/maintenance/documents/${document.id}`)).status, 404);
    });

    it('calculates running hours, availability and historian coverage from the linked state tag', async function () {
        const created = await request('POST', '/api/v1/maintenance/assets', {
            name: 'Pompe avec état',
            runStateTagId: 'tag-run'
        });
        assert.strictEqual(created.status, 201);

        const to = Date.now();
        const from = to - 3600000;
        const response = await request('GET', `/api/v1/maintenance/metrics?from=${from}&to=${to}`);
        const metric = response.body.data.metrics[created.body.data.id];
        assert.strictEqual(response.status, 200);
        assert.strictEqual(metric.state, 'stopped');
        assert.strictEqual(metric.runningHoursPeriod, 0.5);
        assert.strictEqual(metric.availabilityPercent, 50);
        assert.strictEqual(metric.dataCoveragePercent, 100);
    });
});
