# FUXA PostgreSQL Explorer

A small integration for FUXA 1.3.x that loads PostgreSQL database and table names into two dropdowns. It includes a custom widget for FUXA views and a standalone page for checking the connection.

This is an integration overlay, not a standalone FUXA server or native Angular control. FUXA's built-in `pg` dependency is used.

## Requirements

- FUXA 1.3.x
- PostgreSQL reachable from the FUXA server
- A PostgreSQL role with read-only access to the databases and tables you want to display

Configure these environment variables for the FUXA process. Do not commit database credentials:

| Variable | Default | Description |
| --- | --- | --- |
| `PG_HOST` | `127.0.0.1` | PostgreSQL server host |
| `PG_PORT` | `5432` | PostgreSQL server port |
| `PG_USER` | Required | Read-only PostgreSQL role |
| `PG_PASSWORD` | Required | Password for that role |

The role must be able to connect to the `postgres` database to list databases and connect to each database whose tables should be listed.

## Install into FUXA

1. Copy `api/dbexplorer` into the FUXA installation's `api/dbexplorer` folder.
2. Copy `_widgets/controls/postgres-database-select.svg` into FUXA's `_widgets/controls` folder.
3. Optionally copy `_widgets/dbexplorer.html` into FUXA's `_widgets` folder.
4. In FUXA's `api/index.js`, require and register the module alongside the other API modules:

   ```js
   var dbExplorerApi = require('./dbexplorer');

   // After authMiddleware and verifyGroups have been created:
   dbExplorerApi.init(runtime, authMiddleware, verifyGroups);
   apiApp.use(dbExplorerApi.app());
   ```

5. Set the PostgreSQL environment variables for the FUXA process and restart FUXA.
6. Open **Editor → Widgets → controls** and choose the preview containing two dropdowns. The standalone picker is available at `http://localhost:1881/_widgets/dbexplorer.html` (replace the host/port as needed).

## API

- `GET /api/dbexplorer/databases` returns a JSON array of database names.
- `GET /api/dbexplorer/tables?db=DATABASE` returns a JSON array of base-table names. Tables outside the `public` schema are returned as `schema.table`.

The routes use FUXA's shared API authentication middleware and additionally require an administrator permission. Use a read-only PostgreSQL role; the endpoint only lists database and table names.
