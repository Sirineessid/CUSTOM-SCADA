'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { create } = require('./agent');

const token = process.env.FUXA_DEPLOYMENT_TOKEN || '';
if (Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('FUXA_DEPLOYMENT_TOKEN must contain at least 32 characters.');
}

const runtimeDir = path.resolve(process.env.FUXA_RUNTIME_HOME || path.resolve(__dirname, '..'));
const root = path.resolve(process.env.FUXA_DEPLOYMENT_ROOT || path.join(runtimeDir, '_deployments'));
const port = Number(process.env.FUXA_DEPLOYMENT_AGENT_PORT) || 1882;
const tlsKey = process.env.FUXA_DEPLOYMENT_TLS_KEY;
const tlsCert = process.env.FUXA_DEPLOYMENT_TLS_CERT;
if (!!tlsKey !== !!tlsCert) {
    throw new Error('Both FUXA_DEPLOYMENT_TLS_KEY and FUXA_DEPLOYMENT_TLS_CERT must be configured together.');
}
const tlsEnabled = !!(tlsKey && tlsCert);
const host = process.env.FUXA_DEPLOYMENT_AGENT_HOST || (tlsEnabled ? '0.0.0.0' : '127.0.0.1');
if (!tlsEnabled && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('The deployment agent must use HTTPS when listening on a network interface.');
}
const deploymentAgent = create({
    root,
    runtimeDir,
    token,
    nodePath: process.env.FUXA_NODE_PATH,
    runtimeTlsKey: tlsKey,
    runtimeTlsCert: tlsCert
});
const server = tlsKey && tlsCert
    ? https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, deploymentAgent.app)
    : http.createServer(deploymentAgent.app);

server.listen(port, host, async () => {
    console.log(`FUXA deployment agent listening on ${host}:${port} (${tlsCert ? 'HTTPS' : 'HTTP'})`);
    try {
        await deploymentAgent.restoreRunning();
    } catch (error) {
        console.error(`Unable to restore deployed runtimes: ${error.message}`);
    }
});

async function shutdown() {
    server.close();
    await deploymentAgent.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
