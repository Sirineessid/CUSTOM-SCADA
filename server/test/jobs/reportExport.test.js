'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const Report = require('../../runtime/jobs/report');

describe('automatic report exports', function () {
    let directory;

    beforeEach(function () {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-report-export-'));
    });

    afterEach(function () {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('creates a comparable-period XLSX workbook and attaches PDF and Excel', async function () {
        const queryRanges = [];
        let attachments;
        const runtime = {
            settings: { reportsDir: directory },
            logger: { info() {}, warn() {}, error() {} },
            devices: { getTagFormat() { return 2; } },
            daqStorage: {
                async getNodesValues(ids, from, to) {
                    queryRanges.push([from, to]);
                    return from === queryRanges[0][0]
                        ? [['09/03/2026 00:00', '12'], ['09/03/2026 01:00', '20']]
                        : [['08/03/2026 00:00', '10'], ['08/03/2026 01:00', '15']];
                }
            },
            alarmsMgr: {
                async getAlarmsHistory() {
                    return [{ name: 'High flow', type: 'high', text: 'Flow exceeded', status: 'active', ontime: Date.now() }];
                }
            },
            notificatorMgr: {
                sendMailMessage(from, to, subject, text, html, files) {
                    attachments = files;
                    return Promise.resolve();
                }
            }
        };
        const report = Report.create({
            name: 'Daily flow',
            receiver: 'ops@example.test',
            scheduling: 'none',
            docproperty: {},
            content: { items: [
                { type: 'text', text: 'Daily operation' },
                {
                    type: 'table',
                    range: 'day',
                    interval: 'hour',
                    comparePreviousPeriod: true,
                    columns: [
                        { type: 0, tag: { name: 'Timestamp' }, label: 'Timestamp', width: 'auto' },
                        { type: 1, tag: { id: 'flow', name: 'Flow', type: 'Double' }, label: 'Flow', function: 'average', width: 'auto' }
                    ]
                },
                {
                    type: 'alarms',
                    range: 'day',
                    property: { name: true, text: true, type: true },
                    propertyText: { name: 'Name', text: 'Text', type: 'Type' },
                    priority: { high: true },
                    priorityText: { high: 'High' },
                    statusText: { active: 'Active' }
                }
            ] }
        }, runtime);

        const pdfPath = await report.execute(new Date(2026, 2, 10, 2, 30), true);
        const files = fs.readdirSync(directory);
        const excelName = files.find(file => file.endsWith('.xlsx'));
        assert.ok(pdfPath.endsWith('.pdf'));
        assert.ok(fs.existsSync(pdfPath));
        assert.ok(excelName);
        assert.deepEqual(queryRanges, [
            [new Date(2026, 2, 9).getTime(), new Date(2026, 2, 9, 23, 59, 59, 999).getTime()],
            [new Date(2026, 2, 8).getTime(), new Date(2026, 2, 8, 23, 59, 59, 999).getTime()]
        ]);
        assert.deepEqual(attachments.map(file => path.extname(file.path)).sort(), ['.pdf', '.xlsx']);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path.join(directory, excelName));
        const sheet = workbook.getWorksheet('Table 1');
        const alarms = workbook.getWorksheet('Alarms 1');
        assert.ok(sheet);
        assert.ok(alarms);
        assert.equal(workbook.getWorksheet('Summary').getCell('A3').value, 'Daily operation');
        assert.equal(alarms.getCell('A4').value, 'High flow');
        assert.equal(alarms.getCell('B4').value, 'Flow exceeded');
        assert.equal(alarms.getCell('C4').value, 'High');
        assert.equal(sheet.getCell('B4').value, 'Flow (current)');
        assert.equal(sheet.getCell('C4').value, 'Flow (previous)');
        assert.equal(sheet.getCell('D4').value, 'Flow (difference)');
        assert.equal(sheet.getCell('B5').value, 12);
        assert.equal(sheet.getCell('C5').value, 10);
        assert.equal(sheet.getCell('D5').value, 2);
        assert.equal(sheet.getCell('D6').value, 5);
    });

    it('uses the preceding calendar week and month for comparison ranges', async function () {
        const queryRanges = [];
        const runtime = {
            settings: { reportsDir: directory },
            logger: { info() {}, warn() {}, error() {} },
            devices: { getTagFormat() { return 0; } },
            daqStorage: {
                async getNodesValues(ids, from, to) {
                    queryRanges.push([from, to]);
                    return [];
                }
            }
        };
        const ranges = [
            {
                range: 'week',
                execution: new Date(2026, 0, 5, 2, 30),
                current: [new Date(2025, 11, 29).getTime(), new Date(2026, 0, 4, 23, 59, 59, 999).getTime()],
                previous: [new Date(2025, 11, 22).getTime(), new Date(2025, 11, 28, 23, 59, 59, 999).getTime()]
            },
            {
                range: 'month',
                execution: new Date(2026, 0, 1, 2, 30),
                current: [new Date(2025, 11, 1).getTime(), new Date(2025, 11, 31, 23, 59, 59, 999).getTime()],
                previous: [new Date(2025, 10, 1).getTime(), new Date(2025, 10, 30, 23, 59, 59, 999).getTime()]
            }
        ];

        for (const [index, item] of ranges.entries()) {
            const report = Report.create({
                name: `Comparison ${index}`,
                scheduling: 'none',
                docproperty: {},
                content: { items: [{
                    type: 'table',
                    range: item.range,
                    interval: 'day',
                    comparePreviousPeriod: true,
                    columns: [{ type: 1, tag: { id: 'value', name: 'Value' }, label: 'Value', function: 'sum', width: '*' }]
                }] }
            }, runtime);
            await report.execute(item.execution, true);
            assert.deepEqual(queryRanges.splice(0), [
                item.current,
                item.previous
            ]);
        }
    });
});
