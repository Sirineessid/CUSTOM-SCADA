/**
 * custom-SCADA: integrated simulator of a site (runs in the FUXA instance of the site)
 *
 * Virtual equipments (pumps, valves, tanks, sensors) computed every second with a simple physics
 * (the level of a tank follows the flow of its pumps and of its consumption), exposed by an OPC UA server
 * inside the site (opc.tcp://localhost:<port>). FUXA reads them with a normal OPC UA connection « Simulateur »,
 * so the simulated data goes through the same path as the real data (tags, history, alarms, diagnostic).
 * - faults can be injected (pump fault, null flow, high consumption, frozen or out of range sensor, leak, stuck valve)
 * - a loss of communication stops the OPC UA server for a while (FUXA sees the connection error, then reconnects)
 * - the simulation mode is independent of the real mode: only the connection « Simulateur » is started / stopped
 * - the simulated values can also be written in a PostgreSQL table (simulator-pg.js)
 * Configuration: _appdata/simulateur.json { enabled, port, equipments: [{ id, type, name, params }] }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'simulateur.json';
const DEVICE_ID = 'd_simulateur';
const DEVICE_NAME = 'Simulateur';
const STEP = 1000;
const MAX_EQUIPMENTS = 50;

/** types of equipments: parameters (default values) and variables (OPC UA nodes, FUXA tags) */
const TYPES = {
    pompe: {
        label: 'Pompe',
        params: { debitNominal: 120, pressionNominale: 4.5, puissance: 15, reservoir: '', niveauMarche: 1.5, niveauArret: 4 },
        vars: {
            Marche: { type: 'Boolean', write: true, text: 'commande marche (1) / arrêt (0)' },
            Mode_Auto: { type: 'Boolean', write: true, text: 'mode automatique (marche / arrêt selon le niveau du réservoir)' },
            Etat_Marche: { type: 'Boolean', text: 'retour : la pompe tourne' },
            Defaut: { type: 'Boolean', text: 'défaut pompe' },
            Debit: { type: 'Double', unit: 'm³/h', text: 'débit' },
            Pression: { type: 'Double', unit: 'bar', text: 'pression de refoulement' },
            Puissance: { type: 'Double', unit: 'kW', text: 'puissance électrique' },
            Energie: { type: 'Double', unit: 'kWh', text: 'énergie consommée (cumul)' },
            Heures: { type: 'Double', unit: 'h', text: 'heures de fonctionnement (cumul)' }
        },
        faults: { defaut: 'Défaut pompe', debit_nul: 'Débit nul pompe en marche', surconsommation: 'Énergie consommée anormalement élevée' }
    },
    vanne: {
        label: 'Vanne',
        params: { reservoir: '', vitesse: 10 },
        vars: {
            Consigne_Ouverture: { type: 'Double', write: true, unit: '%', text: 'consigne d’ouverture' },
            Ouverture: { type: 'Double', unit: '%', text: 'position réelle' },
            Ouverte: { type: 'Boolean', text: 'fin de course ouverte' },
            Fermee: { type: 'Boolean', text: 'fin de course fermée' },
            Defaut: { type: 'Boolean', text: 'défaut vanne' }
        },
        faults: { bloquee: 'Vanne bloquée', defaut: 'Défaut vanne' }
    },
    reservoir: {
        label: 'Réservoir',
        params: { surface: 25, hauteur: 5, niveauInitial: 2.5, consommation: 60, seuilBas: 1, seuilHaut: 4.5 },
        vars: {
            Niveau: { type: 'Double', unit: 'm', text: 'niveau' },
            Volume: { type: 'Double', unit: 'm³', text: 'volume' },
            Debit_Entree: { type: 'Double', unit: 'm³/h', text: 'débit entrant (pompes)' },
            Debit_Sortie: { type: 'Double', unit: 'm³/h', text: 'débit sortant (consommation)' },
            Niveau_Bas: { type: 'Boolean', text: 'niveau bas' },
            Niveau_Haut: { type: 'Boolean', text: 'niveau haut' }
        },
        faults: { fuite: 'Fuite (débit sortant + 40 m³/h)' }
    },
    capteur: {
        label: 'Capteur',
        params: { unite: 'bar', valeur: 3, amplitude: 0.5, periode: 120, bruit: 0.05, min: 0, max: 10 },
        vars: {
            Valeur: { type: 'Double', text: 'mesure' },
            Defaut: { type: 'Boolean', text: 'défaut capteur' }
        },
        faults: { bloque: 'Mesure figée', hors_plage: 'Mesure hors plage', defaut: 'Défaut capteur' }
    }
};

var runtime;
var logger;
var settings;
var config = { enabled: false, port: 0, equipments: [] };
var state = {};             // equipment id: { var: value }
var faults = {};            // equipment id: { fault: until (ms, 0 = until cleared) }
var commLossUntil = 0;
var server = null;
var opcua = null;
var timer = null;
var starting = null;
var sink = null;            // PostgreSQL (simulator-pg.js)

function init(_runtime, _settings, _logger) {
    runtime = _runtime;
    settings = _settings;
    logger = _logger;
    config = readConfig();
    sink = require('./simulator-pg').create(settings, logger, snapshot);
    if (config.enabled) {
        // after the loading of the project of the site
        setTimeout(() => start().catch(err => logger.error(`simulator: ${err.message}`)), 8000);
    }
}

function file() {
    return path.join(path.dirname(settings.workDir), '_appdata', FILE);
}

function readConfig() {
    try {
        const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
        return { enabled: !!saved.enabled, port: Number(saved.port) || defaultPort(), equipments: Array.isArray(saved.equipments) ? saved.equipments : [] };
    } catch (err) {
        return { enabled: false, port: defaultPort(), equipments: [] };
    }
}

function writeConfig() {
    fs.writeFileSync(file(), JSON.stringify(config, null, 2));
}

/** port of the OPC UA server: port of the site + 1000 (1981 -> 2981) */
function defaultPort() {
    return (Number(settings.uiPort) || 1881) + 1000;
}

function httpError(status, code, message, details) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    err.details = details;
    return err;
}

// ---------------------------------------------------------------- configuration

/** checked list of equipments (ids unique, params of the type with default values) */
function cleanEquipments(list) {
    if (!Array.isArray(list) || list.length > MAX_EQUIPMENTS) {
        throw httpError(400, 'invalid_request', `Liste des équipements invalide (${MAX_EQUIPMENTS} au plus).`, { field: 'equipments' });
    }
    const ids = new Set();
    const result = list.map((e, i) => {
        const type = TYPES[e && e.type];
        if (!type) {
            throw httpError(400, 'invalid_request', `Équipement ${i + 1} : type inconnu (${Object.keys(TYPES).join(', ')}).`, { index: i, field: 'type' });
        }
        const id = String(e.id || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(id)) {
            throw httpError(400, 'invalid_request', `Équipement ${i + 1} : identifiant invalide (lettres, chiffres et _, commence par une lettre, ex. P1).`, { index: i, field: 'id' });
        }
        if (ids.has(id.toLowerCase())) {
            throw httpError(400, 'invalid_request', `Identifiant en double : ${id}.`, { index: i, field: 'id' });
        }
        ids.add(id.toLowerCase());
        const params = {};
        Object.keys(type.params).forEach(k => {
            const def = type.params[k];
            const value = e.params && e.params[k] !== undefined && e.params[k] !== '' ? e.params[k] : def;
            if (typeof def === 'number') {
                const n = Number(value);
                if (!Number.isFinite(n)) {
                    throw httpError(400, 'invalid_request', `${id} : paramètre ${k} invalide (nombre attendu).`, { index: i, field: k });
                }
                params[k] = n;
            } else {
                params[k] = String(value).slice(0, 40);
            }
        });
        return { id, type: e.type, name: String(e.name || id).trim().slice(0, 60) || id, params };
    });
    // a pump or a valve linked to a tank of the list
    result.forEach(e => {
        if (e.params.reservoir && !result.some(r => r.type === 'reservoir' && r.id === e.params.reservoir)) {
            throw httpError(400, 'invalid_request', `${e.id} : réservoir inconnu (${e.params.reservoir}).`, { field: 'reservoir' });
        }
    });
    return result;
}

/** save the equipments: the connection « Simulateur » and its tags are updated */
async function setEquipments(list) {
    const equipments = cleanEquipments(list);
    config.equipments = equipments;
    writeConfig();
    equipments.forEach(e => { state[e.id] = state[e.id] || initialState(e); });
    Object.keys(state).forEach(id => { if (!equipments.some(e => e.id === id)) { delete state[id]; delete faults[id]; } });
    await syncDevice();
    if (server) {
        // the address space is made again with the new equipments
        await restartServer();
    }
    return equipments;
}

/** demo: pumping station (2 pumps filling a tank, an outlet valve, a pressure sensor) */
function preset() {
    return [
        { id: 'P1', type: 'pompe', name: 'Pompe 1', params: { debitNominal: 120, pressionNominale: 4.5, puissance: 15, reservoir: 'R1', niveauMarche: 1.5, niveauArret: 4 } },
        { id: 'P2', type: 'pompe', name: 'Pompe 2', params: { debitNominal: 100, pressionNominale: 4.2, puissance: 12, reservoir: 'R1', niveauMarche: 1.2, niveauArret: 3.5 } },
        { id: 'R1', type: 'reservoir', name: 'Réservoir', params: { surface: 25, hauteur: 5, niveauInitial: 2.5, consommation: 90, seuilBas: 1, seuilHaut: 4.5 } },
        { id: 'V1', type: 'vanne', name: 'Vanne de sortie', params: { reservoir: 'R1', vitesse: 10 } },
        { id: 'PT1', type: 'capteur', name: 'Pression réseau', params: { unite: 'bar', valeur: 3.2, amplitude: 0.4, periode: 180, bruit: 0.05, min: 0, max: 10 } }
    ];
}

// ---------------------------------------------------------------- FUXA connection and tags

/** tag of a variable: id sim_<equipment>_<variable>, address ns=1;s=SIM.<equipment>.<variable> */
function tagOf(e, name, def) {
    return {
        id: `sim_${e.id}_${name}`.toLowerCase(),
        name: `sim_${e.id}_${name}`.toLowerCase(),
        address: `ns=1;s=SIM.${e.id}.${name}`,
        type: def.type,
        description: `${e.name} : ${def.text}${def.unit ? ` (${def.unit})` : ''} - simulateur`,
        daq: { enabled: true, interval: 5, changed: true, restored: false }
    };
}

async function syncDevice() {
    const project = await runtime.project.getProject(null, -1);
    const old = (project.devices || {})[DEVICE_ID];
    const tags = {};
    config.equipments.forEach(e => {
        const type = TYPES[e.type];
        Object.keys(type.vars).forEach(name => {
            const tag = tagOf(e, name, type.vars[name]);
            // the options changed in the editor (recording, scale...) are kept
            tags[tag.id] = Object.assign({}, old && old.tags && old.tags[tag.id], tag, old && old.tags && old.tags[tag.id] ? { daq: old.tags[tag.id].daq } : {});
        });
    });
    const device = Object.assign({}, old, {
        id: DEVICE_ID, name: DEVICE_NAME, type: 'OPCUA', enabled: !!server,
        polling: (old && old.polling) || 1000,
        property: Object.assign({}, old && old.property, { address: `opc.tcp://localhost:${config.port}` }),
        tags
    });
    await runtime.project.setProjectData('set-device', device);
    await runtime.update('set-device', device);
}

async function setDeviceEnabled(enabled) {
    const project = await runtime.project.getProject(null, -1);
    const device = (project.devices || {})[DEVICE_ID];
    if (device && device.enabled !== enabled) {
        device.enabled = enabled;
        await runtime.project.setProjectData('set-device', device);
        await runtime.update('set-device', device);
    }
}

// ---------------------------------------------------------------- physics

function initialState(e) {
    if (e.type === 'pompe') {
        return { Marche: false, Mode_Auto: true, Etat_Marche: false, Defaut: false, Debit: 0, Pression: 0, Puissance: 0, Energie: 0, Heures: 0 };
    }
    if (e.type === 'vanne') {
        return { Consigne_Ouverture: 50, Ouverture: 50, Ouverte: false, Fermee: false, Defaut: false };
    }
    if (e.type === 'reservoir') {
        const surface = Math.max(e.params.surface, 0.1);
        const niveau = Math.min(Math.max(e.params.niveauInitial, 0), e.params.hauteur);
        return { Niveau: niveau, Volume: niveau * surface, Debit_Entree: 0, Debit_Sortie: 0, Niveau_Bas: false, Niveau_Haut: false };
    }
    return { Valeur: e.params.valeur, Defaut: false };
}

function hasFault(id, fault) {
    const f = faults[id] && faults[id][fault];
    return f !== undefined && (f === 0 || f > Date.now());
}

const round = (v, d) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
const noise = (amplitude) => (Math.random() * 2 - 1) * amplitude;

/** one step of the simulation (dt in s) */
function step(dt) {
    const now = Date.now();
    // expired faults
    Object.keys(faults).forEach(id => Object.keys(faults[id]).forEach(f => {
        if (faults[id][f] && faults[id][f] <= now) {
            delete faults[id][f];
            log('info', `Fin du défaut simulé ${f} sur ${id}`);
        }
    }));
    const byId = {};
    config.equipments.forEach(e => { byId[e.id] = e; state[e.id] = state[e.id] || initialState(e); });
    // pumps (automatic mode: start below niveauMarche, stop above niveauArret)
    config.equipments.filter(e => e.type === 'pompe').forEach(e => {
        const s = state[e.id], p = e.params;
        const tank = p.reservoir && state[p.reservoir];
        if (s.Mode_Auto && tank) {
            if (tank.Niveau <= p.niveauMarche) { s.Marche = true; }
            if (tank.Niveau >= p.niveauArret) { s.Marche = false; }
        }
        s.Defaut = hasFault(e.id, 'defaut');
        s.Etat_Marche = !!s.Marche && !s.Defaut;
        const running = s.Etat_Marche;
        s.Debit = running && !hasFault(e.id, 'debit_nul') ? round(p.debitNominal * (1 + noise(0.02)), 2) : 0;
        s.Pression = running ? round(p.pressionNominale * (hasFault(e.id, 'debit_nul') ? 1.25 : 1) * (1 + noise(0.02)), 3) : 0;
        s.Puissance = running ? round(p.puissance * (hasFault(e.id, 'surconsommation') ? 1.6 : 1) * (1 + noise(0.02)), 2) : 0;
        s.Energie = round(s.Energie + s.Puissance * dt / 3600, 4);
        s.Heures = round(s.Heures + (running ? dt / 3600 : 0), 5);
    });
    // valves (position follows the setpoint at vitesse %/s, unless stuck)
    config.equipments.filter(e => e.type === 'vanne').forEach(e => {
        const s = state[e.id];
        s.Defaut = hasFault(e.id, 'defaut');
        s.Consigne_Ouverture = Math.min(Math.max(Number(s.Consigne_Ouverture) || 0, 0), 100);
        if (!hasFault(e.id, 'bloquee') && !s.Defaut) {
            const diff = s.Consigne_Ouverture - s.Ouverture, max = e.params.vitesse * dt;
            s.Ouverture = round(s.Ouverture + Math.max(-max, Math.min(max, diff)), 2);
        }
        s.Ouverte = s.Ouverture >= 99.5;
        s.Fermee = s.Ouverture <= 0.5;
    });
    // tanks: volume += (inflow - outflow) * dt
    config.equipments.filter(e => e.type === 'reservoir').forEach(e => {
        const s = state[e.id], p = e.params;
        const inflow = config.equipments.filter(x => x.type === 'pompe' && x.params.reservoir === e.id).reduce((sum, x) => sum + state[x.id].Debit, 0);
        const valves = config.equipments.filter(x => x.type === 'vanne' && x.params.reservoir === e.id);
        const opening = valves.length ? valves.reduce((sum, x) => sum + state[x.id].Ouverture, 0) / valves.length / 100 : 1;
        // consumption with a day profile (more at 7 h and 19 h) and some noise
        const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
        const profile = 0.7 + 0.3 * Math.cos((hour - 7) / 24 * 2 * Math.PI) + 0.2 * Math.cos((hour - 19) / 12 * 2 * Math.PI);
        let outflow = s.Volume > 0 ? p.consommation * profile * opening * (1 + noise(0.05)) : 0;
        if (hasFault(e.id, 'fuite')) {
            outflow += 40;
        }
        const capacity = Math.max(p.surface, 0.1) * p.hauteur;
        s.Volume = Math.min(Math.max(s.Volume + (inflow - outflow) * dt / 3600, 0), capacity);
        s.Niveau = round(s.Volume / Math.max(p.surface, 0.1), 3);
        s.Volume = round(s.Volume, 3);
        s.Debit_Entree = round(inflow, 2);
        s.Debit_Sortie = round(Math.max(outflow, 0), 2);
        s.Niveau_Bas = s.Niveau <= p.seuilBas;
        s.Niveau_Haut = s.Niveau >= p.seuilHaut;
    });
    // sensors: sine around the value + noise (frozen / out of range on fault)
    config.equipments.filter(e => e.type === 'capteur').forEach(e => {
        const s = state[e.id], p = e.params;
        s.Defaut = hasFault(e.id, 'defaut');
        if (hasFault(e.id, 'bloque')) {
            return;
        }
        if (hasFault(e.id, 'hors_plage')) {
            s.Valeur = round(p.max * 1.5, 3);
            return;
        }
        const v = p.valeur + p.amplitude * Math.sin(2 * Math.PI * (now / 1000) / Math.max(p.periode, 1)) + noise(p.bruit);
        s.Valeur = round(Math.min(Math.max(v, p.min), p.max), 3);
    });
}

// ---------------------------------------------------------------- OPC UA server

function loadOpcua() {
    if (!opcua) {
        try {
            opcua = require(path.join(settings.packageDir, 'runtime', 'node_modules', 'node-opcua'));
        } catch (err) {
            opcua = require('node-opcua');
        }
    }
    return opcua;
}

async function startServer() {
    const ua = loadOpcua();
    const s = new ua.OPCUAServer({
        port: config.port,
        resourcePath: '/',
        buildInfo: { productName: 'Simulateur custom-SCADA' },
        allowAnonymous: true,
        securityModes: [ua.MessageSecurityMode.None],
        securityPolicies: [ua.SecurityPolicy.None]
    });
    await s.initialize();
    const space = s.engine.addressSpace;
    const ns = space.getOwnNamespace();
    const root = ns.addObject({ organizedBy: space.rootFolder.objects, browseName: 'Simulateur' });
    config.equipments.forEach(e => {
        const folder = ns.addObject({ componentOf: root, browseName: e.id });
        const type = TYPES[e.type];
        Object.keys(type.vars).forEach(name => {
            const def = type.vars[name];
            const dataType = def.type === 'Boolean' ? ua.DataType.Boolean : ua.DataType.Double;
            const variable = {
                componentOf: folder, nodeId: `s=SIM.${e.id}.${name}`, browseName: name, dataType: def.type,
                value: {
                    get: () => new ua.Variant({ dataType, value: def.type === 'Boolean' ? !!(state[e.id] || {})[name] : Number((state[e.id] || {})[name]) || 0 })
                }
            };
            if (def.write) {
                variable.value.set = (variant) => {
                    state[e.id] = state[e.id] || initialState(e);
                    state[e.id][name] = def.type === 'Boolean' ? !!variant.value : Number(variant.value);
                    log('info', `Écriture ${e.id}.${name} = ${state[e.id][name]}`);
                    return ua.StatusCodes.Good;
                };
            }
            ns.addVariable(variable);
        });
    });
    await s.start();
    server = s;
}

async function stopServer() {
    const s = server;
    server = null;
    if (s) {
        await s.shutdown(500).catch(() => {});
    }
}

async function restartServer() {
    await stopServer();
    await startServer();
}

// ---------------------------------------------------------------- start / stop

async function start() {
    if (starting) {
        return starting;
    }
    starting = (async () => {
        config.equipments.forEach(e => { state[e.id] = state[e.id] || initialState(e); });
        if (!server) {
            await startServer();
        }
        if (!timer) {
            let last = Date.now();
            timer = setInterval(() => {
                const now = Date.now();
                try {
                    step(Math.min((now - last) / 1000, 5));
                } catch (err) {
                    logger.error(`simulator: ${err.message}`);
                }
                last = now;
                checkCommLoss(now);
            }, STEP);
        }
        config.enabled = true;
        writeConfig();
        await syncDevice();
        sink.start();
        log('info', `Simulation démarrée (OPC UA opc.tcp://localhost:${config.port})`);
    })();
    try {
        await starting;
    } finally {
        starting = null;
    }
}

async function stop() {
    clearInterval(timer);
    timer = null;
    commLossUntil = 0;
    await stopServer();
    sink.stop();
    config.enabled = false;
    writeConfig();
    await setDeviceEnabled(false);
    log('info', 'Simulation arrêtée');
}

/** loss of communication: the OPC UA server stops, it starts again after the duration */
async function communicationLoss(seconds) {
    if (!timer) {
        throw httpError(409, 'simulator_stopped', 'La simulation est arrêtée : la démarrer d’abord.');
    }
    const duration = Math.min(Math.max(Number(seconds) || 30, 5), 3600);
    commLossUntil = Date.now() + duration * 1000;
    await stopServer();
    log('warning', `Perte de communication simulée pendant ${duration} s`);
    return { until: commLossUntil, duration };
}

function checkCommLoss(now) {
    if (commLossUntil && now >= commLossUntil) {
        commLossUntil = 0;
        startServer().then(() => log('info', 'Fin de la perte de communication simulée')).catch(err => logger.error(`simulator: ${err.message}`));
    }
}

async function endCommunicationLoss() {
    if (commLossUntil) {
        commLossUntil = 0;
        await startServer();
        log('info', 'Fin de la perte de communication simulée');
    }
}

// ---------------------------------------------------------------- faults

function setFault(equipmentId, fault, seconds) {
    const e = config.equipments.find(x => x.id === equipmentId);
    if (!e) {
        throw httpError(404, 'equipment_not_found', `Équipement simulé inconnu : ${equipmentId}`);
    }
    if (!TYPES[e.type].faults[fault]) {
        throw httpError(400, 'invalid_request', `Défaut inconnu pour ${e.id} : ${Object.keys(TYPES[e.type].faults).join(', ')}.`, { field: 'fault' });
    }
    const duration = Number(seconds) > 0 ? Math.min(Number(seconds), 86400) : 0;
    faults[e.id] = faults[e.id] || {};
    faults[e.id][fault] = duration ? Date.now() + duration * 1000 : 0;
    log('warning', `Défaut simulé : ${TYPES[e.type].faults[fault]} sur ${e.name}${duration ? ` pendant ${duration} s` : ''}`);
    return { equipment: e.id, fault, until: faults[e.id][fault] || null };
}

function clearFault(equipmentId, fault) {
    if (faults[equipmentId] && faults[equipmentId][fault] !== undefined) {
        delete faults[equipmentId][fault];
        log('info', `Défaut simulé supprimé : ${fault} sur ${equipmentId}`);
        return true;
    }
    return false;
}

/** write a variable that can be written (command of a pump, setpoint of a valve) */
function writeVariable(equipmentId, name, value) {
    const e = config.equipments.find(x => x.id === equipmentId);
    const def = e && TYPES[e.type].vars[name];
    if (!def || !def.write) {
        throw httpError(400, 'invalid_request', `Variable non modifiable : ${equipmentId}.${name}`);
    }
    state[e.id] = state[e.id] || initialState(e);
    state[e.id][name] = def.type === 'Boolean' ? (value === true || value === 1 || value === 'true' || value === '1') : Number(value) || 0;
    return state[e.id][name];
}

// ---------------------------------------------------------------- state

/** values now: [{ equipment, type, name, variable, value }] (used by simulator-pg.js) */
function snapshot() {
    const rows = [];
    config.equipments.forEach(e => {
        Object.keys(TYPES[e.type].vars).forEach(name => rows.push({ equipment: e.id, name: e.name, type: e.type, variable: name, value: (state[e.id] || {})[name] }));
    });
    return rows;
}

function status() {
    const now = Date.now();
    return {
        running: !!timer,
        serverRunning: !!server,
        communicationLoss: commLossUntil ? { until: commLossUntil, remaining: Math.max(0, Math.round((commLossUntil - now) / 1000)) } : null,
        endpoint: `opc.tcp://localhost:${config.port}`,
        port: config.port,
        device: { id: DEVICE_ID, name: DEVICE_NAME },
        equipments: config.equipments.map(e => ({
            id: e.id, type: e.type, typeText: TYPES[e.type].label, name: e.name, params: e.params,
            values: Object.assign({}, state[e.id] || initialState(e)),
            faults: Object.keys(faults[e.id] || {}).filter(f => hasFault(e.id, f)).map(f => ({ fault: f, text: TYPES[e.type].faults[f], until: faults[e.id][f] || null })),
            tags: Object.keys(TYPES[e.type].vars).map(name => tagOf(e, name, TYPES[e.type].vars[name]).name)
        })),
        postgres: sink.status()
    };
}

function types() {
    const result = {};
    Object.keys(TYPES).forEach(k => {
        result[k] = { label: TYPES[k].label, params: TYPES[k].params, faults: TYPES[k].faults,
            vars: Object.keys(TYPES[k].vars).map(name => Object.assign({ name }, TYPES[k].vars[name])) };
    });
    return result;
}

/** event of the simulator in the diagnostic journal of the site */
function log(level, message) {
    try {
        require('./diagnostic').add({ level, type: 'simulator', device: DEVICE_NAME, message });
    } catch (err) {
        // diagnostic not started
    }
    if (level === 'info') {
        logger.info(`simulator: ${message}`);
    }
}

module.exports = {
    init,
    start,
    stop,
    setEquipments,
    preset,
    setFault,
    clearFault,
    writeVariable,
    communicationLoss,
    endCommunicationLoss,
    status,
    types,
    snapshot,
    getConfig: () => ({ enabled: config.enabled, port: config.port, equipments: config.equipments }),
    sink: () => sink,
    DEVICE_ID,
    TYPES
};
