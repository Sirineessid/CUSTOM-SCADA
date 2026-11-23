/*
* Report: get data, create/send/store PDF and Excel workbooks
*/
const utils = require('../utils');
const Pdfmake = require('pdfmake');
const ExcelJS = require('exceljs');
var fs = require('fs')
var path = require('path');
var imageGenerator = require('./helper/image-generator');

'use strict';

function Report(_property, _runtime) {
    var property = _property;
    var runtime = _runtime;
    var logger = runtime.logger;
    var currentTime = 0;
    var lastExecuted;
    var reportDataCache = new WeakMap();

    this.execute = function (time, force) {
        currentTime = time;
        return new Promise(async function (resolve, reject) {
            try {
                if (!_isToExecute(time) && !force) {
                    resolve(true);
                } else {
                    reportDataCache = new WeakMap();
                    await _createReportFiles().then(files => {
                        if (property.receiver) {
                            let subject = `Report ${property.name}`;
                            let attachments = [{ path: files.pdf }, { path: files.xlsx }];
                            runtime.notificatorMgr.sendMailMessage(null, property.receiver, subject, '', null, attachments).then(function () {
                                logger.info(`report.sended.successful: ${new Date()} ${property.receiver} ${property.name}`);
                            }).catch(function (senderr) {
                                logger.error(`report.send.failed: ${senderr}`);
                            });
                        }
                        lastExecuted = currentTime;
                        resolve(files.pdf);
                    }).catch(function (err) {
                        reject(err);
                    });
                }
            } catch (err) {
                reject(err);
            }
        });
    }

    this.getProperty = function () {
        return property;
    }

    this.getChartImage = function (itemChart, values) {
        return _getChartImage(itemChart, values);
    }

    var _getSampleValues = function (lines, timeRange) {
        let result = {};
        lines.forEach(line => {
            result[line.id] = [{x: timeRange.begin, y: Math.floor(Math.random() * 100)},
                {x: timeRange.end, y: Math.floor(Math.random() * 100)}];
        });
        return result;
    }

    var _isToExecute = function (date) {
        if (inTimeToExecute(date.getHours()) && utils.dayOfYear(lastExecuted) !== utils.dayOfYear(date)) {
            if (property.scheduling === ReportSchedulingType.day) {
                return true;
            } else if (property.scheduling === ReportSchedulingType.week && date.getDay() === 1) {      // monday
                return true;
            } else if (property.scheduling === ReportSchedulingType.month && date.getDate() === 1) {
                return true;
            }
        }
        return false;
    }

    var _createPdfBinary = function () {
        return new Promise(async function (resolve, reject) {
            var fonts = {
                Roboto: {
                    normal: path.join(__dirname, 'fonts/Roboto-Regular.ttf'),
                    bold: path.join(__dirname, 'fonts/Roboto-Medium.ttf'),
                    italics: path.join(__dirname, 'fonts/Roboto-Italic.ttf'),
                    bolditalics: path.join(__dirname, 'fonts/Roboto-MediumItalic.ttf')
                }
              };
            let pdfmake = new Pdfmake(fonts);
            await _getPdfContent(property).then(content => {
                let docPath = path.join(runtime.settings.reportsDir,`${property.name}_${utils.getDate(new Date())}.pdf`);
                const pdfDoc = pdfmake.createPdfKitDocument(content, {});
                const stream = fs.createWriteStream(docPath);
                pdfDoc.pipe(stream);
                pdfDoc.end();
                stream.once('error', reject);
                stream.once('finish', function() {
                    resolve(docPath);
                });
            }).catch(function (err) {
                reject(err);
            });
        });
    }

    var _createReportFiles = async function () {
        const pdfPath = await _createPdfBinary();
        try {
            const excelPath = await _createExcelBinary();
            return { pdf: pdfPath, xlsx: excelPath };
        } catch (err) {
            try {
                fs.unlinkSync(pdfPath);
            } catch (cleanupError) {
                logger.warn(`report.cleanup.failed: ${cleanupError}`);
            }
            throw err;
        }
    }

    var _createExcelBinary = async function () {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'FUXA';
        workbook.created = new Date();
        workbook.modified = new Date();
        const summary = workbook.addWorksheet('Summary');
        summary.addRow([property.name]);
        summary.addRow([new Date(currentTime || Date.now())]);
        summary.getRow(1).font = { bold: true, size: 16 };

        let tableCount = 0, alarmCount = 0, chartCount = 0;
        for (const item of (property.content && property.content.items) || []) {
            if (item.type === 'text') {
                summary.addRow([item.text || '']);
            } else if (item.type === 'table') {
                const data = await _getTableData(item);
                const worksheet = workbook.addWorksheet(`Table ${++tableCount}`);
                worksheet.addRow([property.name]);
                worksheet.addRow([_formatRange(data.currentRange)]);
                if (data.previousRange) {
                    worksheet.addRow([`Comparison: ${_formatRange(data.previousRange)}`]);
                }
                const header = worksheet.addRow(data.headers);
                header.font = { bold: true };
                _getExcelTableRows(item, data).forEach(row => worksheet.addRow(row));
                _formatWorksheet(worksheet, header.number);
            } else if (item.type === 'alarms') {
                const data = await _getAlarmData(item);
                const worksheet = workbook.addWorksheet(`Alarms ${++alarmCount}`);
                worksheet.addRow([property.name]);
                worksheet.addRow([_formatRange(data.timeRange)]);
                const header = worksheet.addRow(data.headers);
                header.font = { bold: true };
                data.rows.forEach(row => worksheet.addRow(row));
                _formatWorksheet(worksheet, header.number);
            } else if (item.type === 'chart') {
                const timeRange = _getDateRange(item.range);
                const ids = item.chart.lines.map(line => line.id);
                const values = await _getChartData(item);
                const worksheet = workbook.addWorksheet(`Chart ${++chartCount}`);
                worksheet.addRow([property.name]);
                worksheet.addRow([_formatRange(timeRange)]);
                const lines = item.chart.lines;
                const header = worksheet.addRow(['Timestamp', ...lines.map(line => line.name || line.id)]);
                header.font = { bold: true };
                const rowsByTime = new Map();
                lines.forEach((line, index) => {
                    (values && values[line.id] || []).forEach(point => {
                        const timestamp = new Date(point.x).getTime();
                        if (!rowsByTime.has(timestamp)) {
                            rowsByTime.set(timestamp, [new Date(timestamp), ...lines.map(() => null)]);
                        }
                        rowsByTime.get(timestamp)[index + 1] = point.y;
                    });
                });
                Array.from(rowsByTime.keys()).sort((a, b) => a - b).forEach(timestamp => worksheet.addRow(rowsByTime.get(timestamp)));
                _formatWorksheet(worksheet, header.number);
            }
        }

        const filePath = path.join(runtime.settings.reportsDir, `${property.name}_${utils.getDate(new Date())}.xlsx`);
        await workbook.xlsx.writeFile(filePath);
        return filePath;
    }

    var _formatWorksheet = function (worksheet, headerRow) {
        worksheet.views = [{ state: 'frozen', ySplit: headerRow }];
        worksheet.columns.forEach(column => { column.width = Math.min(Math.max(column.width || 14, 14), 40); });
        worksheet.autoFilter = {
            from: { row: headerRow, column: 1 },
            to: { row: headerRow, column: worksheet.columnCount }
        };
    }

    var _formatRange = function (range) {
        return `${range.begin.toLocaleString()} - ${range.end.toLocaleString()}`;
    }

    var _getExcelTableRows = function (item, data) {
        return data.rows.map(row => {
            const result = [];
            let sourceIndex = 0;
            item.columns.forEach(col => {
                if (col.type === 0) {
                    result.push(row[sourceIndex++] || '');
                } else if (data.previousRange) {
                    result.push(
                        _excelValue(row[sourceIndex++], col.tag),
                        _excelValue(row[sourceIndex++], col.tag),
                        row[sourceIndex++] === '' ? null : row[sourceIndex - 1]
                    );
                } else {
                    result.push(_excelValue(row[sourceIndex++], col.tag));
                }
            });
            return result;
        });
    }

    var _excelValue = function (value, tag) {
        if (value === null || value === undefined || value === '') {
            return null;
        }
        const type = String(tag && tag.type || '');
        if (/^(bool|boolean)$/i.test(type)) {
            if (value === true || value === 1 || String(value).toLowerCase() === 'true') {
                return true;
            }
            if (value === false || value === 0 || String(value).toLowerCase() === 'false') {
                return false;
            }
        }
        if (/^(?:u?int|u?dint|word|dword|byte|float|double|number|real|decimal)/i.test(type)) {
            const numeric = Number(value);
            if (Number.isFinite(numeric)) {
                return numeric;
            }
        }
        return value;
    }

    var _getPreviousDateRange = function (type, currentRange) {
        if (type === ReportDateRangeType.day) {
            const begin = new Date(currentRange.begin);
            begin.setDate(begin.getDate() - 1);
            return {
                begin: new Date(begin.getFullYear(), begin.getMonth(), begin.getDate()),
                end: new Date(begin.getFullYear(), begin.getMonth(), begin.getDate(), 23, 59, 59, 999)
            };
        }
        if (type === ReportDateRangeType.week) {
            const begin = new Date(currentRange.begin);
            begin.setDate(begin.getDate() - 7);
            const end = new Date(currentRange.end);
            end.setDate(end.getDate() - 7);
            return { begin, end };
        }
        if (type === ReportDateRangeType.month) {
            return {
                begin: new Date(currentRange.begin.getFullYear(), currentRange.begin.getMonth() - 1, 1),
                end: new Date(currentRange.begin.getFullYear(), currentRange.begin.getMonth(), 0, 23, 59, 59, 999)
            };
        }
        return null;
    }

    var _difference = function (current, previous, tag) {
        if (current === undefined || current === null || current === '' ||
            previous === undefined || previous === null || previous === '') {
            return '';
        }
        const type = String(tag && tag.type || '');
        if (type && !/^(?:u?int|u?dint|word|dword|byte|float|double|number|real|decimal)/i.test(type)) {
            return '';
        }
        const currentNumber = Number(current), previousNumber = Number(previous);
        return Number.isFinite(currentNumber) && Number.isFinite(previousNumber)
            ? currentNumber - previousNumber : '';
    }

    var _getAlarmData = function (item) {
        if (!reportDataCache.has(item)) {
            reportDataCache.set(item, _loadAlarmData(item));
        }
        return reportDataCache.get(item);
    }

    var _loadAlarmData = async function (item) {
        const timeRange = _getDateRange(item.range);
        const selectedProperties = Object.keys(item.property).filter(prop => item.property[prop]);
        const headers = selectedProperties.map(prop => item.propertyText[prop] || prop);
        const alarms = await runtime.alarmsMgr.getAlarmsHistory({
            start: timeRange.begin.getTime(), end: timeRange.end.getTime()
        }, -1);
        const filteredAlarms = (alarms || []).filter(alarm =>
            item.priority[alarm.type] &&
            (!item.alarmFilter || !item.alarmFilter.length || item.alarmFilter.includes(alarm.name))
        );
        const valueFor = (alarm, prop) => {
            if ((prop === 'ontime' || prop === 'offtime' || prop === 'acktime') && alarm[prop]) {
                return utils.getFormatDate(new Date(Number(alarm[prop])), 'ymd');
            }
            if (prop === 'status') {
                return item.statusText[alarm.status] || alarm.status;
            }
            if (prop === 'type') {
                return item.priorityText[alarm.type] || alarm.type;
            }
            return alarm[prop] === undefined || alarm[prop] === null ? '' : alarm[prop];
        };
        const rows = filteredAlarms.map(alarm => selectedProperties.map(prop => valueFor(alarm, prop)));
        const pdfRows = filteredAlarms.length
            ? filteredAlarms.map(alarm => selectedProperties.map(prop => ({
                text: valueFor(alarm, prop),
                style: [{ fillColor: alarm.bkcolor, color: alarm.color }]
            })))
            : [headers.map(() => ({ text: '', style: [{ alignment: 'left' }] }))];
        return { timeRange, headers, rows, pdfRows };
    }

    var _getChartData = function (item) {
        if (!reportDataCache.has(item)) {
            const timeRange = _getDateRange(item.range);
            const ids = item.chart.lines.map(line => line.id);
            reportDataCache.set(item, runtime.daqStorage.getNodesValues(
                ids, timeRange.begin.getTime(), timeRange.end.getTime(), null
            ));
        }
        return reportDataCache.get(item);
    }

    var _getPdfContent = function (report) {
        return new Promise(async function (resolve, reject) {
            try {
                let docDefinition = {...report.docproperty };
                docDefinition['header'] = { text: 'FUXA by frangoteam', style:[{fontSize: 6}]};
                docDefinition['footer'] = function(currentPage, pageCount) {
                    return { text: currentPage.toString() + ' / ' + pageCount, style:[{alignment: 'right', fontSize: 8}]} ;
                },
                docDefinition['content'] = [];
                for (let i = 0; i < report.content.items.length; i++) {
                    let item = report.content.items[i];
                    if (item.type === 'text') {
                        docDefinition['content'].push({ text: item.text, style: [{ alignment: item.align, fontSize: item.size }] });
                    } else if (item.type === 'table') {
                        const data = await _getTableData(item);
                        const itemTable = _getTableContent(item, data);
                        docDefinition['content'].push({ text: data.previousRange
                                ? `${_formatRange(data.currentRange)} | Comparaison : ${_formatRange(data.previousRange)}`
                                : _formatRange(data.currentRange),
                                style: [{ fontSize: item.size }] });
                        docDefinition['content'].push(itemTable);
                    } else if (item.type === 'alarms') {
                        await _getAlarmsContent(item).then(itemAlarms => {
                            const alarmsDateRange = _getDateRange(item.range);
                            docDefinition['content'].push({ text: `${alarmsDateRange.begin.toLocaleDateString()} - ${alarmsDateRange.end.toLocaleDateString()}`,
                                style: [{ fontSize: item.size }] });
                            docDefinition['content'].push(itemAlarms);
                        });
                    } else if (item.type === 'chart') {
                        await _getChartContent(item).then(itemChart => {
                            docDefinition['content'].push(itemChart);
                        });
                    }
                }
                resolve(docDefinition);
            } catch (err) {
                reject(err);
            }
        });
    }

    var _getTableData = function (item) {
        if (!reportDataCache.has(item)) {
            reportDataCache.set(item, _loadTableData(item));
        }
        return reportDataCache.get(item);
    }

    var _loadTableData = async function (item) {
        const currentRange = _getDateRange(item.range);
        const tagColumns = item.columns.filter(col => col.type !== 0);
        const tagIds = tagColumns.map(col => col.tag.id);
        const options = {
            interval: item.interval,
            functions: tagColumns.map(col => col.function),
            formats: tagColumns.map(col => runtime.devices.getTagFormat(col.tag.id))
        };
        const currentRows = await runtime.daqStorage.getNodesValues(
            tagIds, currentRange.begin.getTime(), currentRange.end.getTime(), options
        );
        const currentValues = currentRows && currentRows.length
            ? currentRows : [item.columns.map(() => '')];
        const previousRange = item.comparePreviousPeriod ? _getPreviousDateRange(item.range, currentRange) : null;
        if (!previousRange) {
            return {
                headers: item.columns.map(col => col.label || col.tag.label || col.tag.name),
                rows: currentValues,
                currentRange,
                previousRange: null
            };
        }

        const previousRows = await runtime.daqStorage.getNodesValues(
            tagIds, previousRange.begin.getTime(), previousRange.end.getTime(), options
        );
        const previousValues = previousRows || [];
        const headers = [];
        item.columns.forEach(col => {
            const label = col.label || col.tag.label || col.tag.name;
            if (col.type === 0) {
                headers.push(label);
            } else {
                headers.push(`${label} (current)`, `${label} (previous)`, `${label} (difference)`);
            }
        });

        const rowCount = Math.max(currentValues.length, previousValues.length);
        const rows = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
            const currentRow = currentValues[rowIndex] || [];
            const previousRow = previousValues[rowIndex] || [];
            const row = [];
            let currentTagIndex = 0;
            item.columns.forEach(col => {
                if (col.type === 0) {
                    row.push(currentRow[0] === undefined ? '' : currentRow[0]);
                } else {
                    const current = currentRow[currentTagIndex + 1];
                    const previous = previousRow[currentTagIndex + 1];
                    row.push(current === undefined ? '' : current, previous === undefined ? '' : previous, _difference(current, previous, col.tag));
                    currentTagIndex++;
                }
            });
            rows.push(row);
        }
        return { headers, rows, currentRange, previousRange };
    }

    var _getTableContent = function (item, data) {
        const header = data.headers.map((label, index) => {
            const col = item.columns[Math.min(index, item.columns.length - 1)];
            return { text: label, bold: true, style: [{ alignment: col && col.align || 'left' }] };
        });
        const widths = [];
        item.columns.forEach(col => {
            if (col.type === 0) {
                widths.push(col.width);
            } else if (data.previousRange) {
                widths.push(col.width, col.width, col.width);
            } else {
                widths.push(col.width);
            }
        });
        return {
            layout: 'lightHorizontalLines',
            fontSize: item.size,
            table: {
                headerRows: 1,
                widths,
                body: [header, ...data.rows.map(row => row.slice())]
            }
        };
    }

    var _getChartContent = function (itemChart) {
        return new Promise(async function (resolve, reject) {
            try {
                let values = await _getChartData(itemChart);
                await _getChartImage(itemChart, values).then((imageData) => {
                    content = {
                        layout: 'lightHorizontalLines',
                        image: `data:image/png;base64,${imageData.toString('base64')}`,
                        // if you specify both width and height - image will be stretched
                        width: itemChart.width || 500,
                        height: itemChart.height || 350,
                        // height: 70
                    }
                    resolve(content);
                }).catch(function (err) {
                    reject(err);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    var _getChartImage = function (itemChart, values) {
        return new Promise(async function (resolve, reject) {
            const timeRange = _getDateRange(itemChart.range);
            if (!values) {
                values = _getSampleValues(itemChart.chart.lines, timeRange);
            }
            try {
                // TODO wait compatibility with arm
                imageGenerator.createImage(itemChart, values).then((content) => {
                    resolve(content.toString('base64'));
                }).catch(function (err) {
                    reject(err);
                    logger.error("createImage: " + err);
                });
            }  catch {
                reject('TODO node create image from canvas is not supported!');
            }
        });
    }

    var _getDateRange = function (dateRange) {
        if (dateRange === ReportDateRangeType.day) {
            var yesterday = new Date(currentTime || Date.now());
            yesterday.setDate(yesterday.getDate() - 1);
            return {
                begin: new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()),
                end: new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999)
            };
        } else if (dateRange === ReportDateRangeType.week) {
            var lastWeek = new Date(currentTime || Date.now());
            lastWeek = new Date(lastWeek.setDate(lastWeek.getDate() - 7 - (lastWeek.getDay() + 6 ) % 7));
            var diff = lastWeek.getDate() - lastWeek.getDay() + (lastWeek.getDay() == 0 ? -6 : 1); // adjust when day is sunday
            lastWeek = new Date(lastWeek.setDate(diff));
            return {
                begin: new Date(lastWeek.getFullYear(), lastWeek.getMonth(), lastWeek.getDate()),
                end: new Date(lastWeek.getFullYear(), lastWeek.getMonth(), lastWeek.getDate() + 6, 23, 59, 59, 999)
            };
        } else if (dateRange === ReportDateRangeType.month) {
            var lastMonth = new Date(currentTime || Date.now());
            return {
                begin: new Date(lastMonth.getFullYear(), lastMonth.getMonth() - 1, 1, 0, 0, 0),
                end: new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 0, 23, 59, 59, 999)
            };
        } else {
            return {
                begin: new Date(currentTime || Date.now()),
                end: new Date(currentTime || Date.now())
            };
        }
    }

    var _getAlarmsContent = function (item) {
        return _getAlarmData(item).then(data => ({
            layout: 'lightHorizontalLines',
            fontSize: item.size,
            table: {
                headerRows: 1,
                widths: data.headers.map(() => '*'),
                body: [
                    data.headers.map(col => ({ text: col, bold: true, style: [{ alignment: 'left' }] })),
                    ...data.pdfRows
                ]
            }
        }));
    }
}

function inTimeToExecute(hour) {
    return (hour >= 2 && hour <= 3);
}

const ReportSchedulingType = {
    none: 'none',
    day: 'day',
    week: 'week',
    month: 'month',
}

const ReportDateRangeType = {
    none: 'none',
    day: 'day',
    week: 'week',
    month: 'month',
}

module.exports = {
    create: function (property, runtime) {
        return new Report(property, runtime);
    },
    ReportSchedulingType: ReportSchedulingType
}
