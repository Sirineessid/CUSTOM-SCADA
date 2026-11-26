'use strict';

const express = require('express');
const { Pool } = require('pg');
const authJwt = require('../jwt-helper');

const poolConfig = {
    host: process.env.PG_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD
};

const pools = new Map();
let runtime;
let secureFnc;
let checkGroupsFnc;

function getPool(database) {
    if (!poolConfig.user || !poolConfig.password) {
        throw new Error('PG_USER and PG_PASSWORD must be configured');
    }

    if (!pools.has(database)) {
        const pool = new Pool({
            ...poolConfig,
            database,
            max: 2,
            idleTimeoutMillis: 30000
        });
        pool.on('error', error => {
            runtime.logger.error(`[API DBEXPLORER] PostgreSQL pool error (${database}): ${error}`);
        });
        pools.set(database, pool);
    }

    return pools.get(database);
}

function logError(operation, error) {
    runtime.logger.error(`[API DBEXPLORER] ${operation} failed: ${error}`);
}

function requireAdmin(req, res) {
    if (!authJwt.haveAdminPermission(checkGroupsFnc(req))) {
        res.status(401).json({ error: 'unauthorized_error', message: 'Administrator permission required' });
        return false;
    }
    return true;
}

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        const dbExplorerApp = express();

        dbExplorerApp.get('/api/dbexplorer/databases', secureFnc, async (req, res) => {
            if (!requireAdmin(req, res)) return;

            try {
                const result = await getPool('postgres').query(`
                    SELECT datname
                    FROM pg_database
                    WHERE datistemplate = false AND datallowconn = true
                    ORDER BY datname`);
                res.json(result.rows.map(row => row.datname));
            } catch (error) {
                logError('listing databases', error);
                res.status(500).json({ error: 'database_error', message: 'Unable to list databases' });
            }
        });

        dbExplorerApp.get('/api/dbexplorer/tables', secureFnc, async (req, res) => {
            if (!requireAdmin(req, res)) return;

            const database = req.query.db;
            if (typeof database !== 'string' || database.length === 0) {
                return res.status(400).json({ error: 'invalid_request', message: 'A database name is required' });
            }

            try {
                const check = await getPool('postgres').query(
                    'SELECT 1 FROM pg_database WHERE datname = $1 AND datallowconn = true',
                    [database]
                );
                if (check.rowCount === 0) {
                    return res.status(400).json({ error: 'unknown_database', message: 'Unknown database' });
                }

                const result = await getPool(database).query(`
                    SELECT table_schema, table_name
                    FROM information_schema.tables
                    WHERE table_type = 'BASE TABLE'
                      AND table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name`);
                res.json(result.rows.map(row =>
                    row.table_schema === 'public'
                        ? row.table_name
                        : `${row.table_schema}.${row.table_name}`
                ));
            } catch (error) {
                logError(`listing tables for database ${database}`, error);
                res.status(500).json({ error: 'database_error', message: 'Unable to list tables' });
            }
        });

        return dbExplorerApp;
    }
};
