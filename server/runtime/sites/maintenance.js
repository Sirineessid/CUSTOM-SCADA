/**
 * Site-scoped CMMS records and equipment documents.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const api = require('./api');
const { ApiError, badRequest, notFound, send, handle, body, period, jsonErrors } = require('./api-v1-common');

const MAX_HISTORY = 366 * 24 * 3600 * 1000;
const DEFAULT_PERIOD = 30 * 24 * 3600 * 1000;
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const COLLECTIONS = ['assets', 'workOrders', 'schedules', 'parts'];
const ID_PATTERN = /^[a-f0-9-]{36}$/i;

function router(runtime, settings, siteId) {
    const app = express.Router();
    const logger = runtime.logger;
    const siteDir = path.dirname(settings.workDir);
    const appDataDir = path.join(siteDir, '_appdata');
    const documentDir = path.join(appDataDir, 'maintenance-documents');
    const dataFile = path.join(appDataDir, 'maintenance.json');
    const source = require('./history').create(runtime, settings);
    const meta = extra => Object.assign({ site_id: siteId }, extra || {});
    const h = fnc => handle(fnc, logger);

    function ensureDirectories() {
        fs.mkdirSync(documentDir, { recursive: true });
    }

    function emptyData() {
        return { assets: [], workOrders: [], schedules: [], parts: [] };
    }

    function readData() {
        ensureDirectories();
        if (!fs.existsSync(dataFile)) {
            return emptyData();
        }
        const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        const data = emptyData();
        COLLECTIONS.forEach(key => {
            if (Array.isArray(parsed[key])) {
                data[key] = parsed[key];
            }
        });
        return data;
    }

    function writeData(data) {
        ensureDirectories();
        const temporary = `${dataFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx' });
            fs.renameSync(temporary, dataFile);
        } catch (err) {
            if (fs.existsSync(temporary)) {
                fs.unlinkSync(temporary);
            }
            throw err;
        }
    }

    function text(value, field, max, required) {
        const result = value === undefined || value === null ? '' : String(value).trim();
        if ((required && !result) || result.length > max) {
            throw badRequest(`${field} ${required && !result ? 'est obligatoire' : `ne peut pas dépasser ${max} caractères`}.`, { field });
        }
        return result;
    }

    function number(value, field, min, max, fallback) {
        if (value === undefined || value === null || value === '') {
            return fallback;
        }
        const result = Number(value);
        if (!Number.isFinite(result) || result < min || result > max) {
            throw badRequest(`${field} doit être un nombre compris entre ${min} et ${max}.`, { field });
        }
        return result;
    }

    function date(value, field, optional) {
        if (optional && (value === undefined || value === null || value === '')) {
            return null;
        }
        const timestamp = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(timestamp)) {
            throw badRequest(`${field} doit être une date valide.`, { field });
        }
        return new Date(timestamp).toISOString();
    }

    async function allTags() {
        return api.allTags(await runtime.project.getProject(null, -1));
    }

    function normalizeAsset(input, existing, tags) {
        const value = Object.assign({}, existing || {}, input || {});
        const tagIds = new Set(tags.map(tag => tag.id));
        const optionalTag = (key, label) => {
            const id = text(value[key], label, 100, false);
            if (id && !tagIds.has(id)) {
                throw badRequest(`${label} n'existe pas dans ce site.`, { field: key });
            }
            return id || null;
        };
        return Object.assign({}, existing || {}, {
            id: (existing && existing.id) || crypto.randomUUID(),
            name: text(value.name, 'Le nom de l’équipement', 120, true),
            equipmentType: text(value.equipmentType, 'Le type', 80, false),
            manufacturer: text(value.manufacturer, 'Le fabricant', 100, false),
            model: text(value.model, 'Le modèle', 100, false),
            serialNumber: text(value.serialNumber, 'Le numéro de série', 100, false),
            location: text(value.location, 'L’emplacement', 120, false),
            commissionedAt: date(value.commissionedAt, 'La date de mise en service', true),
            description: text(value.description, 'La fiche technique', 4000, false),
            deviceTagId: optionalTag('deviceTagId', 'Le tag de liaison'),
            runtimeTagId: optionalTag('runtimeTagId', 'Le compteur horaire'),
            runStateTagId: optionalTag('runStateTagId', 'Le tag de marche'),
            faultTagId: optionalTag('faultTagId', 'Le tag de défaut'),
            runningThreshold: number(value.runningThreshold, 'Le seuil de marche', -1e12, 1e12, 0.5),
            operatingHoursManual: number(value.operatingHoursManual, 'Les heures cumulées', 0, 1e9, 0),
            documents: existing ? existing.documents || [] : [],
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }

    function normalizeWorkOrder(input, existing, data) {
        const value = Object.assign({}, existing || {}, input || {});
        const assetId = text(value.assetId, 'L’équipement', 36, true);
        if (!data.assets.some(asset => asset.id === assetId)) {
            throw badRequest('L’équipement associé est introuvable.', { field: 'assetId' });
        }
        const kind = value.kind || 'intervention';
        const status = value.status || 'closed';
        if (!['intervention', 'failure'].includes(kind)) {
            throw badRequest('Le type doit être intervention ou failure.', { field: 'kind' });
        }
        if (!['open', 'in_progress', 'closed'].includes(status)) {
            throw badRequest('Le statut doit être open, in_progress ou closed.', { field: 'status' });
        }
        const parts = Array.isArray(value.partsUsed) ? value.partsUsed.map(used => {
            const partId = text(used.partId, 'La pièce', 36, true);
            if (!data.parts.some(part => part.id === partId)) {
                throw badRequest('Une pièce consommée est introuvable.', { field: 'partsUsed' });
            }
            return { partId, quantity: number(used.quantity, 'La quantité consommée', 0.001, 1e9, 0) };
        }) : [];
        return {
            id: (existing && existing.id) || crypto.randomUUID(),
            assetId,
            kind,
            title: text(value.title, 'Le titre', 160, true),
            description: text(value.description, 'La description', 4000, false),
            occurredAt: date(value.occurredAt, 'La date de l’intervention', false),
            technician: text(value.technician, 'Le technicien', 120, false),
            durationHours: number(value.durationHours, 'La durée', 0, 1e6, 0),
            cost: number(value.cost, 'Le coût', 0, 1e12, 0),
            status,
            partsUsed: parts,
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    function normalizeSchedule(input, existing, data) {
        const value = Object.assign({}, existing || {}, input || {});
        const assetId = text(value.assetId, 'L’équipement', 36, true);
        if (!data.assets.some(asset => asset.id === assetId)) {
            throw badRequest('L’équipement associé est introuvable.', { field: 'assetId' });
        }
        const intervalDays = number(value.intervalDays, 'La périodicité en jours', 0, 36500, 0);
        const intervalHours = number(value.intervalHours, 'La périodicité en heures', 0, 1e9, 0);
        if (!intervalDays && !intervalHours) {
            throw badRequest('Définissez une périodicité en jours ou en heures.', { field: 'intervalDays' });
        }
        return {
            id: (existing && existing.id) || crypto.randomUUID(),
            assetId,
            title: text(value.title, 'Le titre de maintenance', 160, true),
            intervalDays,
            intervalHours,
            lastDoneAt: date(value.lastDoneAt, 'La dernière maintenance', true),
            lastDoneHours: number(value.lastDoneHours, 'Le compteur lors de la maintenance', 0, 1e9, 0),
            assignedTo: text(value.assignedTo, 'Le responsable', 120, false),
            notes: text(value.notes, 'Les consignes', 2000, false),
            enabled: value.enabled !== false,
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    function normalizePart(input, existing) {
        const value = Object.assign({}, existing || {}, input || {});
        return {
            id: (existing && existing.id) || crypto.randomUUID(),
            name: text(value.name, 'Le nom de la pièce', 160, true),
            sku: text(value.sku, 'La référence', 100, false),
            quantity: number(value.quantity, 'Le stock', 0, 1e9, 0),
            minimumQuantity: number(value.minimumQuantity, 'Le seuil minimum', 0, 1e9, 0),
            unit: text(value.unit, 'L’unité', 30, false) || 'unité',
            location: text(value.location, 'L’emplacement', 120, false),
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    function dueSchedules(data, metrics, now) {
        return data.schedules.filter(schedule => schedule.enabled).map(schedule => {
            const asset = data.assets.find(item => item.id === schedule.assetId);
            const metric = metrics[schedule.assetId] || {};
            const nextDueAt = schedule.intervalDays
                ? (schedule.lastDoneAt ? Date.parse(schedule.lastDoneAt) : asset && asset.commissionedAt ? Date.parse(asset.commissionedAt) : Date.parse(schedule.createdAt)) +
                    schedule.intervalDays * 86400000
                : null;
            const nextDueHours = schedule.intervalHours
                ? Number(schedule.lastDoneHours || 0) + schedule.intervalHours
                : null;
            const dateDue = nextDueAt !== null && nextDueAt <= now;
            const hoursDue = nextDueHours !== null && metric.operatingHours !== null && metric.operatingHours >= nextDueHours;
            const dateSoon = nextDueAt !== null && nextDueAt <= now + 30 * 86400000;
            const hoursRemaining = nextDueHours !== null && metric.operatingHours !== null
                ? nextDueHours - metric.operatingHours
                : null;
            const hoursSoon = hoursRemaining !== null && hoursRemaining >= 0 &&
                hoursRemaining <= Math.max(5, schedule.intervalHours * 0.1);
            return Object.assign({}, schedule, {
                assetName: asset ? asset.name : 'Équipement supprimé',
                nextDueAt: nextDueAt === null ? null : new Date(nextDueAt).toISOString(),
                nextDueHours,
                due: dateDue || hoursDue,
                dueSoon: !dateDue && !hoursDue && (dateSoon || hoursSoon)
            });
        });
    }

    app.get('/', h(async (req, res) => {
        const data = readData();
        const tags = await allTags();
        send(res, Object.assign(data, {
            tags: tags.map(tag => ({ id: tag.id, name: tag.name, device: tag.deviceName, type: tag.type || '' })),
            schedules: data.schedules
        }), meta({ count: Object.fromEntries(COLLECTIONS.map(key => [key, data[key].length])) }));
    }));

    app.get('/metrics', h(async (req, res) => {
        const { from, to } = period(req.query, DEFAULT_PERIOD, MAX_HISTORY);
        const data = readData();
        const prj = await runtime.project.getProject(null, -1);
        const tags = api.allTags(prj);
        const byId = Object.fromEntries(tags.map(tag => [tag.id, tag]));
        const metrics = {};
        for (const asset of data.assets) {
            const runtimeTag = asset.runtimeTagId && byId[asset.runtimeTagId];
            const runTag = asset.runStateTagId && byId[asset.runStateTagId];
            const faultTag = asset.faultTagId && byId[asset.faultTagId];
            const current = tagId => tagId ? runtime.devices.getTagValue(tagId, true) : null;
            const currentRuntime = runtimeTag ? current(runtimeTag.id) : null;
            const runtimeHours = currentRuntime && currentRuntime.value !== null && currentRuntime.value !== undefined && currentRuntime.value !== ''
                ? Number(currentRuntime.value) : NaN;
            const meterHours = Number.isFinite(runtimeHours) && runtimeHours >= 0
                ? runtimeHours
                : null;
            let runningHoursPeriod = null;
            let availabilityPercent = null;
            let dataCoveragePercent = null;
            let liveRunValue = runTag ? current(runTag.id) : null;
            if (runTag) {
                const values = await source.values(runTag, from, to);
                const points = (values || []).filter(point => Number.isFinite(Number(point.t)) && Number(point.t) >= from && Number(point.t) <= to)
                    .map(point => ({ t: Number(point.t), v: point.v }))
                    .sort((a, b) => a.t - b.t);
                const device = Object.values(prj.devices || {}).find(item => item.tags && item.tags[runTag.id]);
                const gapLimit = Math.max(60000, Number(device && device.polling || 3000) * 10);
                let observed = 0;
                let running = 0;
                for (let i = 0; i < points.length; i++) {
                    const start = Math.max(from, points[i].t);
                    const next = i + 1 < points.length ? points[i + 1].t : Math.min(to, points[i].t + gapLimit);
                    const end = Math.min(to, next, points[i].t + gapLimit);
                    if (end <= start) {
                        continue;
                    }
                    const duration = end - start;
                    observed += duration;
                    const value = points[i].v;
                    const isRunning = isOn(value, asset.runningThreshold);
                    if (isRunning) {
                        running += duration;
                    }
                }
                runningHoursPeriod = running / 3600000;
                dataCoveragePercent = observed ? observed / (to - from) * 100 : 0;
                availabilityPercent = observed ? running / observed * 100 : null;
                if (!liveRunValue && points.length) {
                    liveRunValue = { value: points[points.length - 1].v, timestamp: points[points.length - 1].t };
                }
            }
            const currentFault = faultTag ? current(faultTag.id) : null;
            const runningValue = liveRunValue && liveRunValue.value;
            const runningTimestamp = liveRunValue && (liveRunValue.timestamp || liveRunValue.ts);
            const runtimeTimestamp = currentRuntime && (currentRuntime.timestamp || currentRuntime.ts);
            const timestampMs = value => {
                if (typeof value === 'number') {
                    return value;
                }
                const numeric = Number(value);
                return Number.isFinite(numeric) ? numeric : Date.parse(value);
            };
            metrics[asset.id] = {
                operatingHours: meterHours === null ? Number(asset.operatingHoursManual || 0) : meterHours,
                operatingHoursSource: meterHours === null ? 'manual' : 'tag',
                runningHoursPeriod,
                availabilityPercent,
                dataCoveragePercent,
                state: !runTag || runningValue === null || runningValue === undefined || runningValue === '' ? 'unknown' :
                    isOn(runningValue, asset.runningThreshold) ? 'running' : 'stopped',
                faultActive: !!(currentFault && isOn(currentFault.value, 0)),
                lastCommunicationAt: [runningTimestamp, runtimeTimestamp]
                    .map(timestampMs)
                    .filter(Number.isFinite).sort((a, b) => b - a)[0] || null
            };
        }
        const schedules = dueSchedules(data, metrics, Date.now());
        send(res, {
            from, to, metrics,
            schedules,
            summary: {
                assets: data.assets.length,
                activeFailures: data.workOrders.filter(order => order.kind === 'failure' && order.status !== 'closed').length,
                overdueMaintenance: schedules.filter(item => item.due).length,
                lowStock: data.parts.filter(part => part.quantity <= part.minimumQuantity).length
            }
        }, meta({ from, to }));
    }));

    app.post('/assets', h(async (req, res) => {
        const tags = await allTags();
        const data = readData();
        const asset = normalizeAsset(body(req), null, tags);
        data.assets.push(asset);
        writeData(data);
        send(res, asset, meta(), 201);
    }));

    app.put('/assets/:id', h(async (req, res) => {
        const tags = await allTags();
        const data = readData();
        const index = data.assets.findIndex(item => item.id === req.params.id);
        if (index < 0) {
            throw notFound('asset_not_found', 'Équipement introuvable.');
        }
        data.assets[index] = normalizeAsset(body(req), data.assets[index], tags);
        writeData(data);
        send(res, data.assets[index], meta());
    }));

    app.delete('/assets/:id', h((req, res) => {
        const data = readData();
        const asset = data.assets.find(item => item.id === req.params.id);
        if (!asset) {
            throw notFound('asset_not_found', 'Équipement introuvable.');
        }
        if (data.workOrders.some(item => item.assetId === asset.id) || data.schedules.some(item => item.assetId === asset.id)) {
            throw new ApiError(409, 'asset_in_use', 'Supprimez d’abord l’historique et les maintenances associés à cet équipement.');
        }
        data.assets = data.assets.filter(item => item.id !== asset.id);
        writeData(data);
        asset.documents.forEach(document => removeDocument(document));
        send(res, { id: asset.id, deleted: true }, meta());
    }));

    const rawDocument = express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES });
    app.post('/assets/:asset_id/documents', (req, res, next) => {
        rawDocument(req, res, err => err ? jsonErrors(err, req, res, next) : next());
    }, h((req, res) => {
        if (!req.is('application/pdf')) {
            throw badRequest('Le document doit être envoyé avec le type application/pdf.');
        }
        const data = readData();
        const asset = data.assets.find(item => item.id === req.params.asset_id);
        if (!asset) {
            throw notFound('asset_not_found', 'Équipement introuvable.');
        }
        const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!content.length || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
            throw badRequest('Le fichier transmis n’est pas un PDF valide.');
        }
        const originalName = path.basename(String(req.query.name || req.get('x-file-name') || 'document.pdf').replace(/^.*[\\/]/, '')).slice(0, 160);
        const document = { id: crypto.randomUUID(), name: originalName || 'document.pdf', uploadedAt: new Date().toISOString() };
        const file = path.join(documentDir, `${document.id}.pdf`);
        fs.writeFileSync(file, content, { flag: 'wx' });
        asset.documents = (asset.documents || []).concat(document);
        try {
            writeData(data);
        } catch (err) {
            fs.unlinkSync(file);
            throw err;
        }
        send(res, document, meta(), 201);
    }));

    app.get('/documents/:id', h((req, res) => {
        if (!ID_PATTERN.test(req.params.id)) {
            throw notFound('document_not_found', 'Document introuvable.');
        }
        const data = readData();
        const document = data.assets.flatMap(asset => asset.documents || []).find(item => item.id === req.params.id);
        if (!document) {
            throw notFound('document_not_found', 'Document introuvable.');
        }
        const file = path.join(documentDir, `${document.id}.pdf`);
        if (!fs.existsSync(file)) {
            throw notFound('document_file_not_found', 'Le fichier PDF associé est introuvable.');
        }
        res.type('application/pdf');
        res.set('Content-Disposition', `inline; filename="${document.name.replace(/[^A-Za-z0-9._ -]/g, '_')}"`);
        fs.createReadStream(file).on('error', err => {
            logger.error(`maintenance document read failed: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).end();
            } else {
                res.destroy(err);
            }
        }).pipe(res);
    }));

    app.delete('/documents/:id', h((req, res) => {
        if (!ID_PATTERN.test(req.params.id)) {
            throw notFound('document_not_found', 'Document introuvable.');
        }
        const data = readData();
        let found = false;
        data.assets.forEach(asset => {
            const before = asset.documents || [];
            asset.documents = before.filter(document => {
                if (document.id === req.params.id) {
                    found = true;
                    return false;
                }
                return true;
            });
        });
        if (!found) {
            throw notFound('document_not_found', 'Document introuvable.');
        }
        writeData(data);
        const file = path.join(documentDir, `${req.params.id}.pdf`);
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
        send(res, { id: req.params.id, deleted: true }, meta());
    }));

    app.post('/work-orders', h((req, res) => {
        const data = readData();
        const order = normalizeWorkOrder(body(req), null, data);
        applyPartUsage(data, null, order);
        data.workOrders.push(order);
        writeData(data);
        send(res, order, meta(), 201);
    }));

    app.put('/work-orders/:id', h((req, res) => {
        const data = readData();
        const index = data.workOrders.findIndex(item => item.id === req.params.id);
        if (index < 0) {
            throw notFound('work_order_not_found', 'Intervention introuvable.');
        }
        const updated = normalizeWorkOrder(body(req), data.workOrders[index], data);
        applyPartUsage(data, data.workOrders[index], updated);
        data.workOrders[index] = updated;
        writeData(data);
        send(res, updated, meta());
    }));

    app.delete('/work-orders/:id', h((req, res) => {
        const data = readData();
        const order = data.workOrders.find(item => item.id === req.params.id);
        if (!order) {
            throw notFound('work_order_not_found', 'Intervention introuvable.');
        }
        applyPartUsage(data, order, null);
        data.workOrders = data.workOrders.filter(item => item.id !== order.id);
        writeData(data);
        send(res, { id: order.id, deleted: true }, meta());
    }));

    app.post('/schedules', h((req, res) => {
        const data = readData();
        const schedule = normalizeSchedule(body(req), null, data);
        data.schedules.push(schedule);
        writeData(data);
        send(res, schedule, meta(), 201);
    }));

    app.put('/schedules/:id', h((req, res) => {
        const data = readData();
        const index = data.schedules.findIndex(item => item.id === req.params.id);
        if (index < 0) {
            throw notFound('schedule_not_found', 'Planification introuvable.');
        }
        data.schedules[index] = normalizeSchedule(body(req), data.schedules[index], data);
        writeData(data);
        send(res, data.schedules[index], meta());
    }));

    app.delete('/schedules/:id', h((req, res) => {
        const data = readData();
        const previous = data.schedules.length;
        data.schedules = data.schedules.filter(item => item.id !== req.params.id);
        if (data.schedules.length === previous) {
            throw notFound('schedule_not_found', 'Planification introuvable.');
        }
        writeData(data);
        send(res, { id: req.params.id, deleted: true }, meta());
    }));

    app.post('/parts', h((req, res) => {
        const data = readData();
        const part = normalizePart(body(req), null);
        data.parts.push(part);
        writeData(data);
        send(res, part, meta(), 201);
    }));

    app.put('/parts/:id', h((req, res) => {
        const data = readData();
        const index = data.parts.findIndex(item => item.id === req.params.id);
        if (index < 0) {
            throw notFound('part_not_found', 'Pièce de rechange introuvable.');
        }
        data.parts[index] = normalizePart(body(req), data.parts[index]);
        writeData(data);
        send(res, data.parts[index], meta());
    }));

    app.delete('/parts/:id', h((req, res) => {
        const data = readData();
        if (data.workOrders.some(order => (order.partsUsed || []).some(item => item.partId === req.params.id))) {
            throw new ApiError(409, 'part_in_use', 'Cette pièce est référencée dans l’historique des interventions.');
        }
        const previous = data.parts.length;
        data.parts = data.parts.filter(item => item.id !== req.params.id);
        if (data.parts.length === previous) {
            throw notFound('part_not_found', 'Pièce de rechange introuvable.');
        }
        writeData(data);
        send(res, { id: req.params.id, deleted: true }, meta());
    }));

    app.use(h(req => {
        throw notFound('unknown_maintenance_service', `Service de maintenance inconnu : ${req.method} ${req.path}`);
    }));
    return app;

    function applyPartUsage(data, previous, next) {
        const quantityByPart = order => {
            const result = {};
            ((order && order.partsUsed) || []).forEach(item => {
                result[item.partId] = (result[item.partId] || 0) + item.quantity;
            });
            return result;
        };
        const oldUsage = quantityByPart(previous);
        const newUsage = quantityByPart(next);
        for (const part of data.parts) {
            const delta = (newUsage[part.id] || 0) - (oldUsage[part.id] || 0);
            if (part.quantity < delta) {
                throw new ApiError(409, 'insufficient_stock', `Stock insuffisant pour « ${part.name} ».`, { available: part.quantity, requested: delta });
            }
            part.quantity -= delta;
            part.updatedAt = new Date().toISOString();
        }
    }

    function removeDocument(document) {
        const file = path.join(documentDir, `${document.id}.pdf`);
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
}

function isOn(value, threshold) {
    if (value === true || value === 'true') {
        return true;
    }
    if (value === false || value === 'false' || value === null || value === undefined || value === '') {
        return false;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > threshold;
}

module.exports = { router };
