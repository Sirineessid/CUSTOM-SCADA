/**
 * custom-SCADA: recording of the simulated values in PostgreSQL (simulator.js)
 *
 * Every <interval> seconds, the values of all the simulated variables are inserted in a table
 * (created if missing): time, site, equipement, type, variable, valeur. Only when the simulation runs.
 * Configuration: _appdata/simulateur-pg.json (the password never goes back to the browser).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'simulateur-pg.json';
const DEFAULT = { enabled: false, host: '', port: 5432, database: '', user: '', password: '', table: 'simulation_valeurs', interval: 10 };
const TABLE = /^([a-z_][a-z0-9_]{0,40}\.)?[a-z_][a-z0-9_]{0,40}$/;

function create(settings, logger, snapshot) {
    const file = path.join(path.dirname(settings.workDir), '_appdata', FILE);
    let config = read();
    let timer = null, pool = null, busy = false;
    const info = { lastWrite: null, rows: 0, lastError: null };

    function read() {
        try {
            return Object.assign({}, DEFAULT, JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch (err) {
            return Object.assign({}, DEFAULT);
        }
    }

    function publicConfig(c) {
        const result = Object.assign({}, c);
        result.password = c.password ? '********' : '';
        return result;
    }

    function httpError(message, field) {
        const err = new Error(message);
        err.status = 400;
        err.code = 'invalid_request';
        err.details = field ? { field } : undefined;
        return err;
    }

    /** checked configuration; an empty or masked password keeps the saved password */
    function normalize(input) {
        const next = Object.assign({}, config, input || {});
        if (!input || input.password === undefined || input.password === '' || input.password === '********') {
            next.password = config.password;
        }
        delete next.restart;
        next.enabled = !!next.enabled;
        next.port = Number(next.port) || 5432;
        next.interval = Math.min(Math.max(Math.round(Number(next.interval) || 10), 1), 3600);
        next.table = String(next.table || DEFAULT.table).trim().toLowerCase();
        ['host', 'database', 'user'].forEach(k => { next[k] = String(next[k] || '').trim(); });
        if (!TABLE.test(next.table)) {
            throw httpError('Nom de table invalide (lettres minuscules, chiffres et _, schéma facultatif).', 'table');
        }
        if (next.enabled && (!next.host || !next.database || !next.user)) {
            throw httpError('Serveur, base et utilisateur obligatoires pour enregistrer dans PostgreSQL.', 'host');
        }
        return next;
    }

    function client(c) {
        const { Client } = require('pg');
        return new Client({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, connectionTimeoutMillis: 5000 });
    }

    const createTable = (c) => `CREATE TABLE IF NOT EXISTS ${c.table} (
        id BIGSERIAL PRIMARY KEY, time TIMESTAMPTZ NOT NULL, site TEXT NOT NULL, equipement TEXT NOT NULL,
        type TEXT, variable TEXT NOT NULL, valeur DOUBLE PRECISION)`;

    /** connection test: the table is created if it does not exist */
    async function test(input) {
        const c = normalize(Object.assign({}, input, { enabled: false }));
        const cl = client(c);
        try {
            await cl.connect();
            await cl.query(createTable(c));
            const count = await cl.query(`SELECT COUNT(*)::int AS n FROM ${c.table}`);
            return { ok: true, table: c.table, rows: count.rows[0].n };
        } finally {
            cl.end().catch(() => {});
        }
    }

    async function write() {
        if (busy || !config.enabled) {
            return;
        }
        busy = true;
        try {
            if (!pool) {
                const { Pool } = require('pg');
                pool = new Pool({ host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, max: 2,
                    connectionTimeoutMillis: 5000 });
                await pool.query(createTable(config));
            }
            const rows = snapshot();
            if (rows.length) {
                const time = new Date();
                const site = process.env.FUXA_SITE || 'principal';
                const values = [], params = [];
                rows.forEach((r, i) => {
                    const v = r.value === true ? 1 : r.value === false ? 0 : Number(r.value);
                    params.push(time, site, r.equipment, r.type, r.variable, Number.isFinite(v) ? v : null);
                    const k = i * 6;
                    values.push(`($${k + 1}, $${k + 2}, $${k + 3}, $${k + 4}, $${k + 5}, $${k + 6})`);
                });
                await pool.query(`INSERT INTO ${config.table} (time, site, equipement, type, variable, valeur) VALUES ${values.join(', ')}`, params);
                info.rows += rows.length;
                info.lastWrite = Date.now();
            }
            info.lastError = null;
        } catch (err) {
            if (!info.lastError) {
                logger.error(`simulator postgres: ${err.message}`);
            }
            info.lastError = { time: Date.now(), message: err.message };
            if (pool) {
                pool.end().catch(() => {});
                pool = null;
            }
        } finally {
            busy = false;
        }
    }

    function start() {
        stop();
        if (config.enabled) {
            timer = setInterval(write, config.interval * 1000);
        }
    }

    function stop() {
        clearInterval(timer);
        timer = null;
        if (pool) {
            pool.end().catch(() => {});
            pool = null;
        }
    }

    return {
        start,
        stop,
        test,
        getConfig: () => publicConfig(config),
        /** save; the recording starts again with the new configuration if it was running */
        setConfig: (input) => {
            const running = !!timer || input.restart;
            config = normalize(input);
            fs.writeFileSync(file, JSON.stringify(config, null, 2));
            if (running) {
                start();
            }
            return publicConfig(config);
        },
        status: () => ({ enabled: config.enabled, recording: !!timer, table: config.table, interval: config.interval,
            lastWrite: info.lastWrite, rows: info.rows, lastError: info.lastError })
    };
}

module.exports = { create };
