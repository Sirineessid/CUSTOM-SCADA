/**
 * custom-SCADA: alarms by scenario of a site (runs in the FUXA instance of the site)
 *
 * A scenario combines conditions on tags (and / or) that must stay true during a delay; it then gives a
 * synthetic event, shown with the alarms of FUXA (list, history, acknowledgement, statistics, notifications).
 * Example (pumping station): « pump running AND flow = 0 during 30 s » -> « Débit nul pompe en marche ».
 * Alarms of communication: one automatic alarm per connection when FUXA loses it (equipment disconnected).
 * The events follow the states of FUXA: N active, NA active acknowledged, NF ended not acknowledged; an event
 * ended and acknowledged (or ended without acknowledgement mode) goes to the history (_appdata/evenements.jsonl).
 * Configuration: _appdata/scenarios.json { commAlarms, commDelay, rules: [{ id, name, level, logic, conditions, delay, text, group, ackmode, enabled }] }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = ['highhigh', 'high', 'low', 'info'];
const OPS = ['>', '>=', '<', '<=', '=', '!='];
const MAX_RULES = 100;
const STEP = 1000;

var runtime;
var logger;
var dir;
var config = { commAlarms: true, commDelay: 10, rules: [] };
var states = {};        // event id: { since, active, ontime, offtime, acktime, userack, value, status }
var timer = null;

function init(_runtime, settings, _logger) {
    runtime = _runtime;
    logger = _logger;
    dir = path.join(path.dirname(settings.workDir), '_appdata');
    try {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scenarios.json'), 'utf8'));
        config = { commAlarms: saved.commAlarms !== false, commDelay: Number(saved.commDelay) || 10, rules: Array.isArray(saved.rules) ? saved.rules : [] };
    } catch (err) {
        // default: alarms of communication, no scenario
    }
    // after the loading of the project of the site
    setTimeout(() => { timer = setInterval(check, STEP); }, 10000);
}

function httpError(status, code, message, details) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    err.details = details;
    return err;
}

// ---------------------------------------------------------------- configuration

function tagsById() {
    const tags = {};
    try {
        Object.values(runtime.project.getDevices() || {}).forEach(d => Object.values(d.tags || {}).forEach(t => {
            if (!t.sysType) { tags[t.id] = { id: t.id, name: t.name, device: d.name }; }
        }));
    } catch (err) {
        // project not loaded
    }
    return tags;
}

/** checked scenarios; tags by id or name */
function cleanRules(list) {
    if (!Array.isArray(list) || list.length > MAX_RULES) {
        throw httpError(400, 'invalid_request', `Liste des scénarios invalide (${MAX_RULES} au plus).`, { field: 'rules' });
    }
    const tags = tagsById();
    const byName = {};
    Object.values(tags).forEach(t => { byName[t.name] = t; });
    const ids = new Set();
    return list.map((r, i) => {
        const name = String(r.name || '').trim().slice(0, 100);
        if (!name) {
            throw httpError(400, 'invalid_request', `Scénario ${i + 1} : nom manquant.`, { index: i, field: 'name' });
        }
        let id = /^[A-Za-z0-9_-]{1,40}$/.test(r.id || '') ? r.id : `sc${Date.now().toString(36)}${i}`;
        while (ids.has(id)) { id += 'x'; }
        ids.add(id);
        if (!LEVELS.includes(r.level)) {
            throw httpError(400, 'invalid_request', `${name} : niveau invalide (${LEVELS.join(', ')}).`, { index: i, field: 'level' });
        }
        const conditions = (Array.isArray(r.conditions) ? r.conditions : []).slice(0, 10).map((c, k) => {
            const tag = tags[c.tag] || byName[c.tag];
            if (!tag) {
                throw httpError(400, 'invalid_request', `${name} : condition ${k + 1}, tag inconnu (${c.tag || 'aucun'}).`, { index: i, field: 'conditions' });
            }
            if (!OPS.includes(c.op)) {
                throw httpError(400, 'invalid_request', `${name} : condition ${k + 1}, opérateur invalide (${OPS.join(' ')}).`, { index: i, field: 'conditions' });
            }
            const value = Number(c.value === true ? 1 : c.value === false ? 0 : c.value);
            if (!Number.isFinite(value)) {
                throw httpError(400, 'invalid_request', `${name} : condition ${k + 1}, valeur invalide (nombre attendu, 1 / 0 pour un tag logique).`, { index: i, field: 'conditions' });
            }
            return { tag: tag.id, op: c.op, value };
        });
        if (!conditions.length) {
            throw httpError(400, 'invalid_request', `${name} : au moins une condition.`, { index: i, field: 'conditions' });
        }
        const delay = Number(r.delay);
        return {
            id, name, level: r.level, logic: r.logic === 'or' ? 'or' : 'and', conditions,
            delay: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 86400) : 5,
            text: String(r.text || name).trim().slice(0, 200), group: String(r.group || '').trim().slice(0, 60),
            ackmode: ['ackactive', 'float'].includes(r.ackmode) ? r.ackmode : 'ackactive',
            enabled: r.enabled !== false
        };
    });
}

function setConfig(input) {
    const next = Object.assign({}, config);
    if (input.rules !== undefined) { next.rules = cleanRules(input.rules); }
    if (input.commAlarms !== undefined) { next.commAlarms = !!input.commAlarms; }
    if (input.commDelay !== undefined) {
        const d = Number(input.commDelay);
        if (!Number.isFinite(d) || d < 0 || d > 3600) {
            throw httpError(400, 'invalid_request', 'Délai des alarmes de communication invalide (0 à 3600 s).', { field: 'commDelay' });
        }
        next.commDelay = d;
    }
    config = next;
    fs.writeFileSync(path.join(dir, 'scenarios.json'), JSON.stringify(config, null, 2));
    // the events of the deleted or changed scenarios are ended
    Object.keys(states).filter(id => id.startsWith('evt:sc:')).forEach(id => {
        const ruleId = id.slice(7);
        if (!config.rules.some(r => r.id === ruleId && r.enabled)) {
            end(id, true);
        }
    });
    return getConfig();
}

function getConfig() {
    const tags = tagsById();
    return {
        commAlarms: config.commAlarms, commDelay: config.commDelay,
        rules: config.rules.map(r => Object.assign({}, r, {
            conditions: r.conditions.map(c => Object.assign({}, c, { tagName: (tags[c.tag] || {}).name || c.tag, device: (tags[c.tag] || {}).device || null }))
        }))
    };
}

/**
 * scenarios of a pumping station, with the tags of the simulator when they exist (sim_p1_..., sim_r1_...),
 * else with the tags given { pumpRunning, pumpFault, flow, level, power }
 */
function preset() {
    const tags = tagsById();
    const has = id => !!tags[id];
    const rules = [];
    const pumps = Object.keys(tags).filter(id => /^sim_[a-z0-9]+_etat_marche$/.test(id)).map(id => id.replace(/_etat_marche$/, ''));
    pumps.forEach(p => {
        const name = p.replace(/^sim_/, '').toUpperCase();
        if (has(`${p}_defaut`)) {
            rules.push({ name: `Défaut pompe ${name}`, level: 'highhigh', conditions: [{ tag: `${p}_defaut`, op: '=', value: 1 }], delay: 2, text: `Défaut de la pompe ${name}`, group: 'Défauts matériels' });
        }
        if (has(`${p}_debit`)) {
            rules.push({ name: `Débit nul pompe ${name} en marche`, level: 'high', logic: 'and',
                conditions: [{ tag: `${p}_etat_marche`, op: '=', value: 1 }, { tag: `${p}_debit`, op: '<', value: 1 }], delay: 10,
                text: `Débit nul alors que la pompe ${name} fonctionne`, group: 'Scénarios' });
        }
        if (has(`${p}_puissance`)) {
            rules.push({ name: `Énergie anormale pompe ${name}`, level: 'high', conditions: [{ tag: `${p}_puissance`, op: '>', value: 20 }], delay: 15,
                text: `Énergie consommée anormalement élevée par la pompe ${name} (puissance > 20 kW)`, group: 'Scénarios' });
        }
    });
    Object.keys(tags).filter(id => /^sim_[a-z0-9]+_niveau$/.test(id)).forEach(t => {
        const name = t.replace(/^sim_/, '').replace(/_niveau$/, '').toUpperCase();
        rules.push({ name: `Niveau ${name} sous le seuil minimal`, level: 'highhigh', conditions: [{ tag: t, op: '<', value: 1 }], delay: 5,
            text: `Niveau du réservoir ${name} inférieur au seuil minimal (1 m)`, group: 'Scénarios' });
    });
    if (!rules.length) {
        throw httpError(409, 'no_simulator_tags', 'Aucun tag de station de pompage simulée (sim_...) : créer la station de pompage type dans la page Simulateur, ou créer les scénarios à la main.');
    }
    return cleanRules(rules);
}

// ---------------------------------------------------------------- engine

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

/** events to check: scenarios + communication of each connection */
function definitions() {
    const list = [];
    config.rules.filter(r => r.enabled).forEach(r => {
        list.push({ id: `evt:sc:${r.id}`, source: 'scenario', name: r.name, level: r.level, delay: r.delay, text: r.text, group: r.group || 'Scénarios', ackmode: r.ackmode,
            check: () => {
                const results = r.conditions.map(c => test(valueOf(c.tag), c.op, c.value));
                return r.logic === 'or' ? results.some(x => x) : results.every(x => x);
            },
            value: () => r.conditions.map(c => `${(tagsById()[c.tag] || {}).name || c.tag}=${valueOf(c.tag)}`).join(', '),
            tag: r.conditions[0].tag, device: (tagsById()[r.conditions[0].tag] || {}).device || null });
    });
    if (config.commAlarms) {
        let devices = [];
        let status = {};
        try {
            devices = Object.values(runtime.project.getDevices() || {}).filter(d => d.enabled !== false && d.type !== 'FuxaServer' && d.type !== 'internal');
            status = runtime.devices.getDevicesStatus() || {};
        } catch (err) {
            // devices not loaded
        }
        devices.forEach(d => {
            const st = () => { const s = status[d.id]; return s ? String(s.status || s) : 'unknown'; };
            list.push({ id: `evt:com:${d.id}`, source: 'communication', name: `Communication ${d.name}`, level: 'highhigh', delay: config.commDelay,
                text: `Perte de communication avec ${d.name}`, group: 'Communication', ackmode: 'ackactive',
                check: () => !['connect-ok', 'unknown', 'connect-busy'].includes(st()), value: st, tag: null, device: d.name });
        });
    }
    return list;
}

function check() {
    const now = Date.now();
    const defs = definitions();
    defs.forEach(def => {
        let on = false;
        try {
            on = def.check();
        } catch (err) {
            on = false;
        }
        const info = { source: def.source, name: def.name, level: def.level, text: def.text, group: def.group, tag: def.tag, device: def.device, ackmode: def.ackmode };
        let s = states[def.id];
        if (s) {
            s.def = info;
        }
        if (on) {
            if (!s || (!s.active && s.status === '')) {
                s = states[def.id] = Object.assign(s || {}, { since: (s && s.since) || now, active: false, status: '', def: info });
            }
            if (s.status === 'NF') {
                // active again before the acknowledgement
                Object.assign(s, { status: 'N', active: true, ontime: now, offtime: 0, acktime: 0, userack: null, since: now });
                notifyChange(def, s, 'activation');
            } else if (!s.active && now - s.since >= def.delay * 1000) {
                Object.assign(s, { active: true, status: 'N', ontime: now, offtime: 0, acktime: 0, userack: null });
                s.value = def.value();
                notifyChange(def, s, 'activation');
            }
        } else if (s) {
            if (s.active) {
                s.active = false;
                s.offtime = now;
                s.status = s.acktime || def.ackmode === 'float' ? '' : 'NF';
                if (s.status === '') {
                    end(def.id, false);
                }
            } else if (s.status === '') {
                delete states[def.id];
            }
        }
    });
    // events of definitions removed (connection deleted...)
    Object.keys(states).filter(id => !defs.some(d => d.id === id)).forEach(id => end(id, true));
}

function notifyChange(def, s, what) {
    logger.info(`scenarios: ${what} ${def.name}`);
}

/** the event goes to the history (ended and acknowledged, or removed) */
function end(id, force) {
    const s = states[id];
    if (!s) {
        return;
    }
    if (s.ontime) {
        write(Object.assign({ id, ontime: s.ontime, offtime: s.offtime || Date.now(), acktime: s.acktime || 0, userack: s.userack || null,
            value: s.value || null, status: force ? 'supprimé' : 'terminé' }, s.def || {}));
    }
    delete states[id];
}

function write(record) {
    try {
        fs.appendFileSync(path.join(dir, 'evenements.jsonl'), JSON.stringify(record) + '\n');
    } catch (err) {
        logger.error(`scenarios: ${err.message}`);
    }
}

// ---------------------------------------------------------------- alarms of the API

const STATUS = { N: 'N', NA: 'NA', NF: 'NF' };

/** active events in the format of the alarms of FUXA (api-v1-site.js alarmInfo) */
function active() {
    return Object.keys(states).filter(id => states[id].status && states[id].def).map(id => {
        const s = states[id];
        return {
            name: id, type: s.def.level, text: s.def.text, group: s.def.group, status: STATUS[s.status],
            value: s.value || null, ontime: s.ontime, offtime: s.offtime || null, acktime: s.acktime || null,
            toack: !s.acktime && s.def.ackmode !== 'float' ? 1 : 0, userack: s.userack || undefined,
            source: s.def.source, eventName: s.def.name, tagId: s.def.tag, tagName: s.def.tag ? (tagsById()[s.def.tag] || {}).name || s.def.tag : null, device: s.def.device
        };
    });
}

/** history between from and to (ms): finished events + active ones */
function history(from, to) {
    let records = [];
    try {
        records = fs.readFileSync(path.join(dir, 'evenements.jsonl'), 'utf8').trim().split('\n').filter(l => l).map(l => {
            try { return JSON.parse(l); } catch (err) { return null; }
        }).filter(r => r && r.ontime <= to && (r.offtime || r.ontime) >= from);
    } catch (err) {
        // no history yet
    }
    const tags = tagsById();
    return records.map(r => ({
        name: r.id, type: r.level, text: r.text, group: r.group, status: '', value: r.value, ontime: r.ontime, offtime: r.offtime,
        acktime: r.acktime || null, userack: r.userack || undefined, source: r.source, eventName: r.name, tagId: r.tag, tagName: r.tag ? (tags[r.tag] || {}).name || r.tag : null, device: r.device
    })).concat(active().filter(a => a.ontime >= from && a.ontime <= to));
}

/** acknowledgement of an event (id), or of all the events (null) */
function ack(id, user) {
    let changed = 0;
    Object.keys(states).filter(k => (id === null || k === id) && states[k].status && !states[k].acktime).forEach(k => {
        const s = states[k];
        s.acktime = Date.now();
        s.userack = user || null;
        if (s.status === 'N') {
            s.status = 'NA';
        } else if (s.status === 'NF') {
            s.status = '';
            end(k, false);
        }
        changed++;
    });
    return changed;
}

function exists(id) {
    return !!(states[id] && states[id].status);
}

module.exports = {
    init,
    getConfig,
    setConfig,
    preset,
    active,
    history,
    ack,
    exists,
    LEVELS,
    OPS
};
