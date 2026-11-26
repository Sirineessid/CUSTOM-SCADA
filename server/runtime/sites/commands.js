/**
 * custom-SCADA: remote commands of a site (runs in the FUXA instance of the site)
 *
 * A command is defined by an engineer: equipment, type (marche / arrêt, mode auto / manuel, consigne), tag written,
 * tag of the feedback (retour d'état), time allowed for the feedback, confirmation, password (critical command),
 * role needed, and interlocks (conditions on tags that block the command, for example « pompe en défaut »).
 *
 * Execution (POST /api/v1/commands/{id}/execute { value, confirmed }):
 *  1. checks: command active, role of the user, equipment allowed for the user, password confirmed (critical),
 *     confirmation (sensitive), value allowed (min / max), equipment connected, interlocks, no command of the
 *     same tag still waiting -> else the command is refused (and kept in the history with the reason)
 *  2. the value is written in the tag (the PLC keeps its own protections: the SCADA never bypasses them)
 *  3. the feedback tag is watched: executed when it gives the value asked, else expired (not executed) after the time
 * History: _appdata/commandes.jsonl (operator, command, value, result, reason, feedback, times).
 * Configuration: _appdata/commandes.json { commands: [...] }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['onoff', 'mode', 'setpoint'];
const OPS = ['>', '>=', '<', '<=', '=', '!='];
const ROLES = ['consultation', 'operateur', 'ingenieur', 'administrateur'];
const LABELS = { onoff: ['Arrêt', 'Marche'], mode: ['Manuel', 'Automatique'] };
const MAX_COMMANDS = 200;
const STEP = 500;

var runtime, logger, dir, audit = null;
var config = { commands: [] };
var pending = {};       // execution id: { record, def, expected, until }
var recent = [];        // last executions (newest first)
var timer = null;

function init(_runtime, settings, _logger, _audit) {
    runtime = _runtime;
    logger = _logger;
    audit = _audit || null;
    dir = path.join(path.dirname(settings.workDir), '_appdata');
    try {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'commandes.json'), 'utf8'));
        config = { commands: Array.isArray(saved.commands) ? saved.commands : [] };
    } catch (err) {
        // no command yet
    }
    recent = readHistory().slice(0, 200);
    clearInterval(timer);
    timer = setInterval(watch, STEP);
}

function httpError(status, code, message, details) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    err.details = details;
    return err;
}

// ---------------------------------------------------------------- tags
function tagsById() {
    const tags = {};
    try {
        Object.values(runtime.project.getDevices() || {}).forEach(d => Object.values(d.tags || {}).forEach(t => {
            if (!t.sysType) { tags[t.id] = { id: t.id, name: t.name, type: t.type, device: d.name, deviceId: d.id }; }
        }));
    } catch (err) {
        // project not loaded
    }
    return tags;
}

function valueOf(tagId) {
    try {
        const v = runtime.devices.getTagValue(tagId);
        if (v === true || v === 'true') { return 1; }
        if (v === false || v === 'false') { return 0; }
        const n = Number(v);
        return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
    } catch (err) {
        return null;
    }
}

function test(value, op, ref) {
    if (value === null) { return false; }
    switch (op) {
        case '>': return value > ref;
        case '>=': return value >= ref;
        case '<': return value < ref;
        case '<=': return value <= ref;
        case '=': return Math.abs(value - ref) < 1e-9;
        case '!=': return Math.abs(value - ref) >= 1e-9;
        default: return false;
    }
}

function deviceConnected(deviceId) {
    try {
        const s = (runtime.devices.getDevicesStatus() || {})[deviceId];
        const status = s ? String(s.status || s) : 'unknown';
        return status === 'connect-ok';
    } catch (err) {
        return false;
    }
}

// ---------------------------------------------------------------- configuration
function cleanCommands(list) {
    if (!Array.isArray(list) || list.length > MAX_COMMANDS) {
        throw httpError(400, 'invalid_request', `Liste des commandes invalide (${MAX_COMMANDS} au plus).`, { field: 'commands' });
    }
    const tags = tagsById();
    const byName = {};
    Object.values(tags).forEach(t => { byName[t.name] = t; });
    const findTag = (value, label, name, i, optional) => {
        if (optional && (value === undefined || value === null || value === '')) { return null; }
        const tag = tags[value] || byName[value];
        if (!tag) {
            throw httpError(400, 'invalid_request', `${name} : ${label} inconnu (${value || 'aucun'}).`, { index: i, field: label });
        }
        return tag.id;
    };
    const ids = new Set();
    return list.map((c, i) => {
        const name = String(c.name || '').trim().slice(0, 100);
        if (!name) {
            throw httpError(400, 'invalid_request', `Commande ${i + 1} : nom manquant.`, { index: i, field: 'name' });
        }
        if (!TYPES.includes(c.type)) {
            throw httpError(400, 'invalid_request', `${name} : type invalide (${TYPES.join(', ')}).`, { index: i, field: 'type' });
        }
        let id = /^[A-Za-z0-9_-]{1,40}$/.test(c.id || '') ? c.id : `cmd${Date.now().toString(36)}${i}`;
        while (ids.has(id)) { id += 'x'; }
        ids.add(id);
        const num = (v, def) => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? def : n; };
        const result = {
            id, name, type: c.type, enabled: c.enabled !== false,
            equipment: String(c.equipment || '').trim().slice(0, 80),
            tag: findTag(c.tag, 'tag', name, i),
            feedbackTag: findTag(c.feedbackTag, 'feedbackTag', name, i, true),
            timeout: Math.min(Math.max(num(c.timeout, 15), 1), 3600),
            tolerance: Math.max(num(c.tolerance, 1), 0),
            min: num(c.min, null), max: num(c.max, null), unit: String(c.unit || '').slice(0, 20),
            confirm: c.confirm !== false,
            critical: !!c.critical,
            minRole: ROLES.includes(c.minRole) && c.minRole !== 'consultation' ? c.minRole : 'operateur',
            interlocks: (Array.isArray(c.interlocks) ? c.interlocks : []).slice(0, 10).map((l, k) => {
                if (!OPS.includes(l.op)) {
                    throw httpError(400, 'invalid_request', `${name} : verrouillage ${k + 1}, opérateur invalide (${OPS.join(' ')}).`, { index: i, field: 'interlocks' });
                }
                const value = Number(l.value === true ? 1 : l.value === false ? 0 : l.value);
                if (!Number.isFinite(value)) {
                    throw httpError(400, 'invalid_request', `${name} : verrouillage ${k + 1}, valeur invalide.`, { index: i, field: 'interlocks' });
                }
                return {
                    tag: findTag(l.tag, 'tag du verrouillage', name, i), op: l.op, value,
                    text: String(l.text || '').trim().slice(0, 120) || 'Verrouillage actif',
                    // for marche / arrêt and mode: the interlock can block only one of the two values
                    when: ['on', 'off', 'all'].includes(l.when) ? l.when : (c.type === 'setpoint' ? 'all' : 'on')
                };
            })
        };
        if (result.type === 'setpoint' && result.min !== null && result.max !== null && result.min > result.max) {
            throw httpError(400, 'invalid_request', `${name} : minimum supérieur au maximum.`, { index: i, field: 'min' });
        }
        return result;
    });
}

function withNames(c, tags) {
    const t = id => (id && tags[id]) || null;
    return Object.assign({}, c, {
        tagName: t(c.tag) ? t(c.tag).name : c.tag, device: t(c.tag) ? t(c.tag).device : null,
        feedbackTagName: c.feedbackTag ? (t(c.feedbackTag) ? t(c.feedbackTag).name : c.feedbackTag) : null,
        interlocks: c.interlocks.map(l => Object.assign({}, l, { tagName: t(l.tag) ? t(l.tag).name : l.tag }))
    });
}

function getConfig() {
    const tags = tagsById();
    return { commands: config.commands.map(c => withNames(c, tags)) };
}

function setConfig(input) {
    const commands = cleanCommands(input.commands);
    config = { commands };
    fs.writeFileSync(path.join(dir, 'commandes.json'), JSON.stringify(config, null, 2));
    return getConfig();
}

/** commands of a pumping station with the tags of the simulator (sim_p1_..., sim_v1_...) */
function preset() {
    const tags = tagsById();
    const has = id => !!tags[id];
    const list = [];
    ['p1', 'p2'].forEach(p => {
        const n = p.slice(1);
        if (!has(`sim_${p}_marche`)) { return; }
        list.push({
            name: `Pompe ${n} : marche / arrêt`, type: 'onoff', equipment: `Pompe ${n}`, tag: `sim_${p}_marche`, feedbackTag: has(`sim_${p}_etat_marche`) ? `sim_${p}_etat_marche` : '',
            timeout: 10, confirm: true, critical: false, minRole: 'operateur',
            interlocks: [
                has(`sim_${p}_mode_auto`) ? { tag: `sim_${p}_mode_auto`, op: '=', value: 1, text: 'Pompe en mode automatique : passer en manuel', when: 'all' } : null,
                has(`sim_${p}_defaut`) ? { tag: `sim_${p}_defaut`, op: '=', value: 1, text: 'Pompe en défaut', when: 'on' } : null,
                has('sim_r1_niveau_haut') ? { tag: 'sim_r1_niveau_haut', op: '=', value: 1, text: 'Réservoir au niveau haut', when: 'on' } : null
            ].filter(Boolean)
        });
        if (has(`sim_${p}_mode_auto`)) {
            list.push({
                name: `Pompe ${n} : mode auto / manuel`, type: 'mode', equipment: `Pompe ${n}`, tag: `sim_${p}_mode_auto`, feedbackTag: `sim_${p}_mode_auto`,
                timeout: 5, confirm: true, critical: false, minRole: 'operateur', interlocks: []
            });
        }
    });
    if (has('sim_v1_consigne_ouverture')) {
        list.push({
            name: 'Vanne de sortie : consigne d’ouverture', type: 'setpoint', equipment: 'Vanne de sortie', tag: 'sim_v1_consigne_ouverture',
            feedbackTag: has('sim_v1_ouverture') ? 'sim_v1_ouverture' : '', timeout: 30, tolerance: 1, min: 0, max: 100, unit: '%',
            confirm: true, critical: true, minRole: 'ingenieur',
            interlocks: has('sim_v1_defaut') ? [{ tag: 'sim_v1_defaut', op: '=', value: 1, text: 'Vanne en défaut', when: 'all' }] : []
        });
    }
    return list;
}

// ---------------------------------------------------------------- state of the commands
function valueText(def, value) {
    if (value === null || value === undefined) { return ''; }
    if (def.type === 'setpoint') { return `${value}${def.unit ? ' ' + def.unit : ''}`; }
    return LABELS[def.type][Number(value) ? 1 : 0];
}

/** interlocks active for a value (null: for all the values) */
function blocking(def, value) {
    const tags = tagsById();
    return def.interlocks.filter(l => {
        if (value !== null && def.type !== 'setpoint' && l.when !== 'all' && (l.when === 'on') !== !!Number(value)) {
            return false;
        }
        const v = valueOf(l.tag);
        return v === null || test(v, l.op, l.value);
    }).map(l => {
        const v = valueOf(l.tag);
        return { text: v === null ? `${l.text} (valeur de ${(tags[l.tag] || {}).name || l.tag} inconnue)` : l.text, tag: (tags[l.tag] || {}).name || l.tag, value: v, when: l.when };
    });
}

/** commands with the current values, for the page */
function list(user) {
    const tags = tagsById();
    return config.commands.map(c => {
        const def = withNames(c, tags);
        const tag = tags[c.tag];
        const waiting = Object.values(pending).find(p => p.def.id === c.id);
        const rights = rightsOf(c, user);
        return Object.assign(def, {
            value: valueOf(c.tag), valueText: valueText(c, valueOf(c.tag)),
            feedback: c.feedbackTag ? valueOf(c.feedbackTag) : null, feedbackText: c.feedbackTag ? valueText(c, valueOf(c.feedbackTag)) : null,
            connected: tag ? deviceConnected(tag.deviceId) : false,
            interlocksActive: blocking(c, null),
            pending: waiting ? waiting.record : null,
            allowed: rights.ok, notAllowedReason: rights.ok ? null : rights.reason,
            labels: LABELS[c.type] || null
        });
    });
}

function rightsOf(def, user) {
    if (!user) {
        return { ok: true };
    }
    if (ROLES.indexOf(user.role) < ROLES.indexOf(def.minRole)) {
        return { ok: false, reason: `rôle ${def.minRole} nécessaire (rôle actuel : ${user.role || 'aucun'})` };
    }
    const tag = tagsById()[def.tag];
    if (user.equipments && user.equipments.length && (!tag || !user.equipments.includes(tag.device))) {
        return { ok: false, reason: `équipement ${tag ? tag.device : '?'} non autorisé pour ${user.username}` };
    }
    return { ok: true };
}

// ---------------------------------------------------------------- execution
function save(record) {
    try {
        fs.appendFileSync(path.join(dir, 'commandes.jsonl'), JSON.stringify(record) + '\n');
    } catch (err) {
        logger.error(`commands: ${err.message}`);
    }
    if (audit) {
        audit.write({
            type: 'commande', user: record.user, tag: record.tagName, device: record.device, value: record.value,
            action: `commande ${record.name} : ${record.valueText}`, result: record.status === 'exécutée' || record.status === 'envoyée' ? 'ok' : 'refus',
            detail: record.reason || null
        });
    }
}

function finish(record, status, reason) {
    record.status = status;
    record.reason = reason || null;
    record.endTime = Date.now();
    record.duration = record.endTime - record.time;
    recent = [record].concat(recent.filter(r => r.id !== record.id)).slice(0, 200);
    save(record);
    return record;
}

/**
 * @param user user checked by the main FUXA (null: security of the sites disabled)
 */
async function execute(id, input, user) {
    const def = config.commands.find(c => c.id === id);
    if (!def) {
        throw httpError(404, 'command_not_found', `Commande « ${id} » inconnue.`);
    }
    const tags = tagsById();
    const tag = tags[def.tag];
    let value = input.value === true ? 1 : input.value === false ? 0 : Number(input.value);
    const record = {
        id: crypto.randomUUID(), command: def.id, name: def.name, equipment: def.equipment, type: def.type,
        tag: def.tag, tagName: tag ? tag.name : def.tag, device: tag ? tag.device : null,
        value: Number.isFinite(value) ? value : input.value, valueText: Number.isFinite(value) ? valueText(def, value) : String(input.value),
        user: user ? user.username : null, userName: user ? user.name || null : null, role: user ? user.role : null,
        time: Date.now(), status: 'en cours', reason: null, feedbackTag: def.feedbackTag ? (tags[def.feedbackTag] || {}).name || def.feedbackTag : null,
        feedback: null, endTime: null, duration: null
    };
    const refuse = (reason, status) => {
        finish(record, 'refusée', reason);
        const err = httpError(status || 409, 'command_refused', `Commande refusée : ${reason}.`, { record });
        throw err;
    };
    if (!def.enabled) { refuse('commande désactivée'); }
    const rights = rightsOf(def, user);
    if (!rights.ok) { refuse(rights.reason, 403); }
    // the answers asked to the user are not kept in the history (password, confirmation)
    if (def.critical && user && !user.confirmed) {
        throw httpError(403, 'confirmation_required', 'Commande critique : confirmer le mot de passe (POST /api/v1/auth/confirm).');
    }
    if (def.confirm && input.confirmed !== true) {
        throw httpError(409, 'confirmation_needed', `Commande sensible : confirmer l'envoi de « ${def.name} : ${record.valueText} » (confirmed: true).`);
    }
    if (!Number.isFinite(value)) { refuse('valeur invalide', 400); }
    if (def.type !== 'setpoint') {
        if (value !== 0 && value !== 1) { refuse('valeur invalide (0 ou 1)', 400); }
    } else {
        if (def.min !== null && value < def.min) { refuse(`valeur inférieure au minimum (${def.min})`, 400); }
        if (def.max !== null && value > def.max) { refuse(`valeur supérieure au maximum (${def.max})`, 400); }
    }
    if (!tag) { refuse('tag de la commande introuvable'); }
    if (!deviceConnected(tag.deviceId)) { refuse(`équipement ${tag.device} non connecté`); }
    const locks = blocking(def, value);
    if (locks.length) { refuse(`verrouillage : ${locks.map(l => l.text).join(', ')}`); }
    if (Object.values(pending).some(p => p.def.tag === def.tag)) { refuse('une commande de ce tag attend encore son retour d’état'); }
    // writing (the PLC keeps its protections)
    let written = null;
    try {
        written = await runtime.devices.setTagValue(def.tag, tag.type === 'Boolean' ? !!value : value);
    } catch (err) {
        written = false;
    }
    if (written === false) {
        finish(record, 'échec', 'écriture refusée par l’équipement');
        throw httpError(502, 'command_failed', 'Commande non envoyée : écriture refusée par l’équipement.', { record });
    }
    if (!def.feedbackTag) {
        return finish(record, 'envoyée', 'sans retour d’état');
    }
    record.until = record.time + def.timeout * 1000;
    pending[record.id] = { record, def, expected: value };
    recent = [record].concat(recent).slice(0, 200);
    return record;
}

function feedbackOk(p) {
    const v = valueOf(p.def.feedbackTag);
    p.record.feedback = v;
    if (v === null) { return false; }
    if (p.def.type === 'setpoint') { return Math.abs(v - p.expected) <= p.def.tolerance; }
    return !!v === !!p.expected;
}

function watch() {
    const now = Date.now();
    Object.keys(pending).forEach(id => {
        const p = pending[id];
        if (feedbackOk(p)) {
            delete pending[id];
            finish(p.record, 'exécutée', null);
        } else if (now >= p.record.until) {
            delete pending[id];
            finish(p.record, 'expirée', `pas de retour d’état en ${p.def.timeout} s (${p.record.feedbackTag} = ${p.record.feedback === null ? 'inconnu' : p.record.feedback})`);
        }
    });
}

function get(execId) {
    const p = pending[execId];
    return p ? p.record : recent.find(r => r.id === execId) || readHistory().find(r => r.id === execId) || null;
}

function readHistory() {
    try {
        return fs.readFileSync(path.join(dir, 'commandes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
    } catch (err) {
        return [];
    }
}

/** executions (in progress first, then the history, newest first) */
function history(filter) {
    const f = filter || {};
    const items = Object.values(pending).map(p => p.record).concat(readHistory());
    return items.filter(r => (!f.from || r.time >= f.from) && (!f.to || r.time <= f.to) &&
        (!f.status || String(f.status).split(',').includes(r.status)) && (!f.command || r.command === f.command) &&
        (!f.user || r.user === f.user) && (!f.equipment || r.equipment === f.equipment));
}

module.exports = { init, getConfig, setConfig, preset, list, execute, get, history, TYPES };
