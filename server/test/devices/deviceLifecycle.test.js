'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const Device = require('../../runtime/devices/device');

describe('device lifecycle', function () {
    it('exposes polling response time and last communication diagnostics', async function () {
        let lastReadAt = 0;
        const comm = {
            connect: async () => {},
            disconnect: async () => {},
            isConnected: () => true,
            polling: async () => {
                await new Promise(resolve => setTimeout(resolve, 5));
                lastReadAt = Date.now();
            },
            load() {},
            getStatus: () => 'connect-ok',
            getValues: () => ({}),
            getValue: () => null,
            getTagProperty: () => null,
            lastReadTimestamp: () => lastReadAt,
            bindAddDaq() {}
        };
        const originalPluginPath = require.resolve('../../runtime/devices/genericethernetip');
        const originalLoad = Module._load;
        Module._load = function (request) {
            if (request === 'fake-generic-enip-plugin') {
                return { create: () => comm };
            }
            return originalLoad.apply(this, arguments);
        };
        try {
            Device.loadPlugin(Device.DeviceType.GenericEthernetIP, 'fake-generic-enip-plugin');
        } finally {
            Module._load = originalLoad;
        }

        const runtime = {
            logger: { info() {}, warn() {}, error() {} },
            events: new EventEmitter(),
            plugins: { manager: {} },
            project: { getDeviceProperty() {} },
            settings: { daqEnabled: false }
        };
        const device = Device.create({
            id: 'device-diagnostics', name: 'PLC', type: Device.DeviceType.GenericEthernetIP,
            enabled: true, polling: 1000, property: {}, tags: {}
        }, runtime);

        try {
            device.start();
            await new Promise(resolve => setImmediate(resolve));
            await device.polling();

            const diagnostics = device.getDiagnostics();
            assert.strictEqual(diagnostics.lastCommunicationAt, lastReadAt);
            assert.ok(diagnostics.responseTimeMs >= 0);
            assert.strictEqual(diagnostics.pollingIntervalMs, 1000);
            assert.strictEqual(diagnostics.dataQuality, 'good');
        } finally {
            await device.stop();
            Device.loadPlugin(Device.DeviceType.GenericEthernetIP, originalPluginPath);
        }
    });

    it('does not report a polling-disabled device offline while its connection is healthy', function () {
        const comm = {
            connect: async () => {},
            disconnect: async () => {},
            isConnected: () => true,
            polling: async () => {},
            load() {},
            getStatus: () => 'connect-ok',
            getValues: () => ({}),
            getValue: () => null,
            getTagProperty: () => null,
            lastReadTimestamp: () => Date.now() - 60000,
            bindAddDaq() {}
        };
        const originalPluginPath = require.resolve('../../runtime/devices/genericethernetip');
        const originalLoad = Module._load;
        Module._load = function (request) {
            if (request === 'fake-generic-enip-plugin') {
                return { create: () => comm };
            }
            return originalLoad.apply(this, arguments);
        };
        try {
            Device.loadPlugin(Device.DeviceType.GenericEthernetIP, 'fake-generic-enip-plugin');
        } finally {
            Module._load = originalLoad;
        }

        const runtime = {
            logger: { info() {}, warn() {}, error() {} },
            events: new EventEmitter(),
            plugins: { manager: {} },
            project: { getDeviceProperty() {} },
            settings: { daqEnabled: false }
        };
        const device = Device.create({
            id: 'device-polling-disabled', name: 'Polling désactivé', type: Device.DeviceType.GenericEthernetIP,
            enabled: true, polling: -1, property: {}, tags: {}
        }, runtime);
        let reportedConnectionStatus;
        device.bindUpdateConnectionStatus((id, status) => { reportedConnectionStatus = status; });

        try {
            device.checkStatus();
            assert.strictEqual(reportedConnectionStatus, 5);
            assert.strictEqual(device.getDiagnostics().dataQuality, 'unknown');
        } finally {
            Device.loadPlugin(Device.DeviceType.GenericEthernetIP, originalPluginPath);
        }
    });

    it('does not start polling when a pending connection completes after stop', async function () {
        let resolveConnect;
        let disconnectCount = 0;
        let pollingCount = 0;
        const comm = {
            connect: () => new Promise(resolve => { resolveConnect = resolve; }),
            disconnect: async () => { disconnectCount++; },
            isConnected: () => false,
            polling: () => { pollingCount++; },
            load() {},
            getStatus: () => 'connect-off',
            getValues: () => ({}),
            getValue: () => null,
            getTagProperty: () => null,
            lastReadTimestamp: () => 0,
            bindAddDaq() {}
        };
        const originalPluginPath = require.resolve('../../runtime/devices/genericethernetip');
        const originalLoad = Module._load;
        Module._load = function (request) {
            if (request === 'fake-generic-enip-plugin') {
                return { create: () => comm };
            }
            return originalLoad.apply(this, arguments);
        };
        try {
            Device.loadPlugin(Device.DeviceType.GenericEthernetIP, 'fake-generic-enip-plugin');
        } finally {
            Module._load = originalLoad;
        }

        const runtime = {
            logger: { info() {}, warn() {}, error() {} },
            events: new EventEmitter(),
            plugins: { manager: {} },
            project: { getDeviceProperty() {} },
            settings: { daqEnabled: false }
        };
        const device = Device.create({
            id: 'device-lifecycle', name: 'PLC', type: Device.DeviceType.GenericEthernetIP,
            enabled: true, polling: 10, property: {}, tags: {}
        }, runtime);

        try {
            device.start();
            assert.strictEqual(typeof resolveConnect, 'function');
            await device.stop();
            resolveConnect();
            await new Promise(resolve => setTimeout(resolve, 30));

            assert.strictEqual(pollingCount, 0);
            assert.strictEqual(disconnectCount, 2);
        } finally {
            Device.loadPlugin(Device.DeviceType.GenericEthernetIP, originalPluginPath);
        }
    });
});
