'use strict';

const path = require('path');
const { Service } = require('node-windows');

const service = new Service({
    name: 'FUXA Deployment Agent',
    description: 'Receives authenticated FUXA releases and manages production runtimes.',
    script: path.join(__dirname, 'main.js'),
    env: [
        'FUXA_DEPLOYMENT_TOKEN',
        'FUXA_DEPLOYMENT_AGENT_HOST',
        'FUXA_DEPLOYMENT_AGENT_PORT',
        'FUXA_DEPLOYMENT_ROOT',
        'FUXA_RUNTIME_HOME',
        'FUXA_NODE_PATH',
        'FUXA_DEPLOYMENT_TLS_KEY',
        'FUXA_DEPLOYMENT_TLS_CERT'
    ].filter(name => process.env[name]).map(name => ({ name, value: process.env[name] }))
});

const action = process.argv[2];
if (action === 'install') {
    service.on('install', () => service.start());
    service.install();
} else if (action === 'uninstall') {
    service.on('uninstall', () => console.log('FUXA Deployment Agent service removed.'));
    service.uninstall();
} else {
    console.error('Usage: node windows-service.js install|uninstall');
    process.exitCode = 2;
}
