/**
 * custom-SCADA: users and traceability in the FUXA instance of a site
 *
 * The main FUXA checks every request (accounts-http.js) and sends the user, signed with the secret it gives
 * to the site (SCADA_AUTH_SECRET), in the header x-scada-user: { username, name, role, equipments }.
 * - middleware(): user of the request (req.scadaUser); the last user who changed the project is kept for
 *   the versions (who changed the pages, the tags...)
 * - socket(): values written from the supervision (setpoints, commands of the synoptics): role operateur at
 *   least and equipment allowed, each write is kept in _appdata/journal-consignes.jsonl (user, tag, old and new value)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HEADER = 'x-scada-user';
const ROLES = ['consultation', 'operateur', 'ingenieur', 'administrateur'];
const PROJECT_WRITE = /\/api\/(projectData|project|device|v1\/config|v1\/versions|v1\/alarms\/config|v1\/simulator)/;

var runtime;
var logger;
var journalFile;
var last = null;        // { user, time } last change of the project

function init(_runtime, settings, _logger) {
    runtime = _runtime;
    logger = _logger;
    journalFile = path.join(path.dirname(settings.workDir), '_appdata', 'journal-consignes.jsonl');
}

/** user sent by the main FUXA, null if missing or not signed with the secret of the site */
function verify(value) {
    const secret = process.env.SCADA_AUTH_SECRET;
    if (!value || !secret || typeof value !== 'string' || !value.includes('.')) {
        return null;
    }
    const [payload, sig] = value.split('.');
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return null;
    }
    try {
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (err) {
        return null;
    }
}

function middleware(req, res, next) {
    const user = verify(req.headers[HEADER]);
    req.scadaUser = user;
    if (user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && PROJECT_WRITE.test(req.originalUrl || req.url)) {
        last = { user: user.username, name: user.name, time: Date.now() };
    }
    next();
}

/** user of the last change of the project (2 minutes at most before the version) */
function lastUser() {
    return last && Date.now() - last.time < 120000 ? last.user : null;
}

function write(event) {
    if (!journalFile) {
        return;
    }
    try {
        fs.appendFileSync(journalFile, JSON.stringify(Object.assign({ time: Date.now() }, event)) + '\n');
    } catch (err) {
        logger.error(`audit: ${err.message}`);
    }
}

/** tag and its connection (device) from the variable written by the supervision */
function tagInfo(source, id) {
    try {
        const devices = runtime.project.getDevices() || {};
        const device = devices[source] || Object.values(devices).find(d => d.tags && d.tags[id]);
        const tag = device && device.tags && device.tags[id];
        return { device: device ? device.name : source, tag: tag ? tag.name : id };
    } catch (err) {
        return { device: source, tag: id };
    }
}

function socket(io) {
    io.on('connection', s => {
        const user = verify(s.handshake.headers[HEADER]);
        s.use((packet, next) => {
            const [event, message] = packet;
            if (event !== 'device-values' || !message || message.cmd !== 'set' || !message.var) {
                return next();
            }
            const info = tagInfo(message.var.source, message.var.id);
            let old = null;
            try {
                const current = runtime.devices.getTagValue(message.var.id, true);
                old = current ? current.value : null;
            } catch (err) {
                // no value yet
            }
            const entry = { type: 'consigne', user: user ? user.username : null, tag: info.tag, device: info.device, old, value: message.var.value };
            if (user) {
                const allowedRole = ROLES.indexOf(user.role) >= ROLES.indexOf('operateur');
                const allowedDevice = !user.equipments || !user.equipments.length || user.equipments.includes(info.device);
                if (!allowedRole || !allowedDevice) {
                    write(Object.assign(entry, { action: 'écriture refusée', result: 'refus',
                        detail: !allowedRole ? `rôle ${user.role || 'aucun'}` : `équipement ${info.device} non autorisé` }));
                    s.emit('device-values', { cmd: 'set-unauthorized', var: message.var });
                    return next(new Error('unauthorized'));
                }
            }
            write(Object.assign(entry, { action: 'écriture', result: 'ok' }));
            next();
        });
    });
}

/** journal of the writes of the site, newest first */
function readJournal() {
    try {
        return fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(l => l).map(l => {
            try { return JSON.parse(l); } catch (err) { return null; }
        }).filter(e => e).reverse();
    } catch (err) {
        return [];
    }
}

module.exports = {
    init,
    verify,
    middleware,
    socket,
    lastUser,
    readJournal,
    write
};
