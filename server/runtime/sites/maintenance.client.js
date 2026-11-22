(function () {
    'use strict';

    var root = document.getElementById('maintenance-app');
    if (!root || !window.SiteApi) {
        return;
    }

    var base = SiteApi.base + '/maintenance';
    var state = { data: null, metrics: null, tab: 'assets', selectedAsset: null };
    var tabs = [
        ['assets', 'Équipements'],
        ['workOrders', 'Interventions / pannes'],
        ['schedules', 'Maintenance préventive'],
        ['parts', 'Pièces de rechange']
    ];

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
    }

    function request(method, path, body) {
        return SiteApi.request(method, '/maintenance' + path, body);
    }

    function formatDate(value) {
        if (!value) {
            return '—';
        }
        var date = new Date(value);
        return isNaN(date.getTime()) ? '—' : date.toLocaleString('fr-FR');
    }

    function localDateTime(value) {
        if (!value) {
            return '';
        }
        var date = new Date(value);
        if (isNaN(date.getTime())) {
            return '';
        }
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }

    function status(message, error) {
        var node = document.getElementById('cmms-status');
        if (!node && root) {
            node = document.createElement('p');
            node.id = 'cmms-status';
            root.appendChild(node);
        }
        if (node) {
            node.textContent = message || '';
            node.className = 'cmms-status' + (error ? ' error' : '');
        }
    }

    function cell(value) {
        return '<td>' + escapeHtml(value) + '</td>';
    }

    function emptyRow(columns, message) {
        return '<tr><td colspan="' + columns + '" class="empty">' + escapeHtml(message) + '</td></tr>';
    }

    function table(headers, rows) {
        return '<div class="cmms-table-wrap"><table class="cmms-table"><thead><tr>' +
            headers.map(function (header) { return '<th>' + escapeHtml(header) + '</th>'; }).join('') +
            '</tr></thead><tbody>' + (rows.length ? rows.join('') : emptyRow(headers.length, 'Aucun élément enregistré.')) +
            '</tbody></table></div>';
    }

    function action(id, label, actionName, secondary) {
        return '<button type="button" class="cmms-button' + (secondary ? ' secondary' : '') +
            '" data-action="' + escapeHtml(actionName) + '" data-id="' + escapeHtml(id) + '">' + escapeHtml(label) + '</button>';
    }

    function assetName(id) {
        var asset = state.data.assets.filter(function (item) { return item.id === id; })[0];
        return asset ? asset.name : 'Équipement supprimé';
    }

    function summaryCards() {
        var summary = (state.metrics && state.metrics.summary) || {};
        return '<div class="cmms-cards">' +
            card('Équipements', summary.assets || 0, '') +
            card('Pannes ouvertes', summary.activeFailures || 0, summary.activeFailures ? 'warning' : '') +
            card('Maintenances en retard', summary.overdueMaintenance || 0, summary.overdueMaintenance ? 'danger' : '') +
            card('Références à réapprovisionner', summary.lowStock || 0, summary.lowStock ? 'warning' : '') +
            '</div>' + scheduleAlerts();
    }

    function scheduleAlerts() {
        var alerts = (state.metrics.schedules || []).filter(function (schedule) { return schedule.due || schedule.dueSoon; });
        if (!alerts.length) {
            return '';
        }
        return '<section class="cmms-alerts"><b>Échéances de maintenance</b><ul>' + alerts.map(function (schedule) {
            return '<li><span class="cmms-badge ' + (schedule.due ? 'danger' : 'warning') + '">' +
                (schedule.due ? 'En retard' : 'À prévoir') + '</span> ' + escapeHtml(schedule.assetName) +
                ' — ' + escapeHtml(schedule.title) + ' — ' +
                escapeHtml(schedule.nextDueAt ? formatDate(schedule.nextDueAt) : 'Compteur : ' + Number(schedule.nextDueHours || 0).toFixed(1) + ' h') + '</li>';
        }).join('') + '</ul></section>';
    }

    function card(label, value, style) {
        return '<div class="cmms-card ' + style + '"><span>' + escapeHtml(label) + '</span><b>' +
            escapeHtml(value) + '</b></div>';
    }

    function assetRows() {
        return state.data.assets.map(function (asset) {
            var metric = (state.metrics.metrics || {})[asset.id] || {};
            var stateText = metric.state === 'running' ? 'En marche' : metric.state === 'stopped' ? 'À l’arrêt' : 'Non configuré';
            var fault = metric.faultActive ? '<span class="cmms-badge danger">Défaut actif</span>' : '<span class="cmms-badge good">Aucun défaut</span>';
            var availability = metric.availabilityPercent === null || metric.availabilityPercent === undefined
                ? '—' : Number(metric.availabilityPercent).toFixed(1) + ' % (couverture ' +
                    Number(metric.dataCoveragePercent || 0).toFixed(1) + ' %)';
            var hours = metric.operatingHoursSource === 'tag'
                ? Number(metric.operatingHours).toFixed(1) + ' h (compteur)'
                : Number(metric.operatingHours || 0).toFixed(1) + ' h (saisi)';
            if (metric.runningHoursPeriod !== null && metric.runningHoursPeriod !== undefined) {
                hours += ' · ' + Number(metric.runningHoursPeriod).toFixed(1) + ' h observées / 30 j';
            }
            var orders = state.data.workOrders.filter(function (order) { return order.assetId === asset.id; }).length;
            var documents = (asset.documents || []).length;
            return '<tr>' +
                cell(asset.name) + cell(asset.equipmentType || '—') + cell(asset.location || '—') +
                '<td><span class="cmms-badge ' + (metric.state === 'running' ? 'good' : metric.state === 'stopped' ? 'neutral' : 'warning') + '">' + stateText + '</span></td>' +
                '<td>' + fault + '</td>' + cell(hours) + cell(availability) +
                cell(formatDate(metric.lastCommunicationAt)) + cell(orders) + cell(documents) +
                '<td class="cmms-actions">' +
                action(asset.id, 'Fiche', 'edit-asset') +
                action(asset.id, 'PDF', 'documents', true) +
                action(asset.id, 'Supprimer', 'delete-asset', true) + '</td></tr>';
        });
    }

    function ordersRows(filter) {
        return state.data.workOrders.filter(function (order) { return !filter || order.kind === filter; })
            .slice().sort(function (a, b) { return new Date(b.occurredAt) - new Date(a.occurredAt); })
            .map(function (order) {
                var kind = order.kind === 'failure' ? 'Panne' : 'Intervention';
                var statusText = { open: 'Ouvert', in_progress: 'En cours', closed: 'Clôturé' }[order.status] || order.status;
                var close = order.status === 'closed' ? '' : action(order.id, 'Clôturer', 'close-order', true);
                return '<tr>' + cell(formatDate(order.occurredAt)) + cell(assetName(order.assetId)) + cell(kind) +
                    cell(order.title) + cell(order.technician || '—') + cell(statusText) +
                    cell(Number(order.durationHours || 0).toFixed(1) + ' h') + cell(Number(order.cost || 0).toFixed(2)) +
                    '<td class="cmms-actions">' + close + action(order.id, 'Supprimer', 'delete-order', true) + '</td></tr>';
            });
    }

    function scheduleRows() {
        return (state.metrics.schedules || []).map(function (schedule) {
            var dueClass = schedule.due ? 'danger' : schedule.dueSoon ? 'warning' : 'good';
            var dueText = schedule.due ? 'En retard' : schedule.dueSoon ? 'À prévoir' : 'Planifiée';
            return '<tr>' + cell(assetName(schedule.assetId)) + cell(schedule.title) +
                cell(schedule.intervalDays ? schedule.intervalDays + ' j' : '—') +
                cell(schedule.intervalHours ? schedule.intervalHours + ' h' : '—') +
                cell((schedule.nextDueAt ? formatDate(schedule.nextDueAt) : '—') +
                    (schedule.nextDueHours !== null ? ' · compteur ' + Number(schedule.nextDueHours).toFixed(1) + ' h' : '')) +
                cell(schedule.assignedTo || '—') +
                '<td><span class="cmms-badge ' + dueClass + '">' + dueText + '</span></td>' +
                '<td class="cmms-actions">' + action(schedule.id, 'Modifier', 'edit-schedule') +
                action(schedule.id, 'Effectuée', 'complete-schedule') +
                action(schedule.id, 'Supprimer', 'delete-schedule', true) + '</td></tr>';
        });
    }

    function partRows() {
        return state.data.parts.map(function (part) {
            var low = part.quantity <= part.minimumQuantity;
            return '<tr>' + cell(part.name) + cell(part.sku || '—') +
                cell(Number(part.quantity).toFixed(2) + ' ' + part.unit) +
                cell(Number(part.minimumQuantity).toFixed(2)) + cell(part.location || '—') +
                '<td><span class="cmms-badge ' + (low ? 'warning' : 'good') + '">' + (low ? 'À commander' : 'Disponible') + '</span></td>' +
                '<td class="cmms-actions">' + action(part.id, 'Modifier', 'edit-part') +
                action(part.id, 'Supprimer', 'delete-part', true) + '</td></tr>';
        });
    }

    function draw() {
        if (!state.data || !state.metrics) {
            root.innerHTML = '<p class="cmms-status">Chargement du module de maintenance…</p>';
            return;
        }
        var tabButtons = tabs.map(function (item) {
            return '<button type="button" class="cmms-tab' + (state.tab === item[0] ? ' selected' : '') +
                '" data-tab="' + item[0] + '">' + item[1] + '</button>';
        }).join('');
        var content = '';
        if (state.tab === 'assets') {
            content = '<div class="cmms-toolbar"><h2>Équipements et fiches techniques</h2>' +
                '<button type="button" class="cmms-button primary" data-action="new-asset">+ Nouvel équipement</button></div>' +
                '<p class="cmms-hint">Le compteur horaire lié doit fournir une valeur cumulée en heures. Le tag de marche permet de calculer les heures observées et la disponibilité sur la période sélectionnée.</p>' +
                table(['Équipement', 'Type', 'Emplacement', 'État', 'Panne', 'Heures', 'Disponibilité (30 j)', 'Dernière communication', 'Historique', 'Docs PDF', 'Actions'], assetRows()) +
                '<div id="cmms-documents"></div>';
        } else if (state.tab === 'workOrders') {
            content = '<div class="cmms-toolbar"><h2>Historique des interventions et pannes</h2>' +
                '<button type="button" class="cmms-button primary" data-action="new-order">+ Ajouter une intervention / panne</button></div>' +
                table(['Date', 'Équipement', 'Type', 'Résumé', 'Technicien', 'Statut', 'Durée', 'Coût', 'Actions'], ordersRows());
        } else if (state.tab === 'schedules') {
            content = '<div class="cmms-toolbar"><h2>Maintenance préventive</h2>' +
                '<button type="button" class="cmms-button primary" data-action="new-schedule">+ Planifier une maintenance</button></div>' +
                '<p class="cmms-hint">Les alertes de retard et d’échéance proche sont calculées à l’ouverture et à chaque actualisation.</p>' +
                table(['Équipement', 'Opération', 'Périodicité date', 'Périodicité compteur', 'Prochaine échéance', 'Responsable', 'État', 'Actions'], scheduleRows());
        } else {
            content = '<div class="cmms-toolbar"><h2>Pièces de rechange</h2>' +
                '<button type="button" class="cmms-button primary" data-action="new-part">+ Ajouter une pièce</button></div>' +
                '<p class="cmms-hint">Les consommations saisies dans les interventions décrémentent automatiquement le stock. Le seuil minimum signale les réapprovisionnements.</p>' +
                table(['Pièce', 'Référence', 'Quantité', 'Seuil minimum', 'Emplacement', 'Stock', 'Actions'], partRows());
        }
        root.innerHTML = summaryCards() + '<div class="cmms-tabs">' + tabButtons + '</div>' +
            '<section class="cmms-panel">' + content + '</section><p id="cmms-status" class="cmms-status"></p><dialog id="cmms-dialog"></dialog>';
        bind();
    }

    function field(name, label, type, value, required, options) {
        var id = 'cmms-field-' + name;
        var input;
        if (type === 'select') {
            input = '<select id="' + id + '" name="' + name + '"' + (required ? ' required' : '') + '>' +
                '<option value="">— Aucun —</option>' + (options || []).map(function (option) {
                    var optionValue = typeof option === 'string' ? option : option.value;
                    var optionLabel = typeof option === 'string' ? option : option.label;
                    return '<option value="' + escapeHtml(optionValue) + '"' +
                        (String(value || '') === String(optionValue) ? ' selected' : '') + '>' + escapeHtml(optionLabel) + '</option>';
                }).join('') + '</select>';
        } else if (type === 'textarea') {
            input = '<textarea id="' + id + '" name="' + name + '" rows="3">' + escapeHtml(value || '') + '</textarea>';
        } else {
            var fieldValue = type === 'datetime-local' ? localDateTime(value) :
                type === 'date' && value ? new Date(value).toISOString().slice(0, 10) : value;
            input = '<input id="' + id + '" name="' + name + '" type="' + type + '" value="' +
                escapeHtml(fieldValue === undefined || fieldValue === null ? '' : fieldValue) +
                '"' + (required ? ' required' : '') + (type === 'number' ? ' step="any"' : '') + '>';
        }
        return '<label class="cmms-field" for="' + id + '"><span>' + escapeHtml(label) + (required ? ' *' : '') +
            '</span>' + input + '</label>';
    }

    function openForm(title, fields, value, save) {
        var dialog = document.getElementById('cmms-dialog');
        dialog.innerHTML = '<form method="dialog" class="cmms-form"><div class="cmms-toolbar"><h2>' +
            escapeHtml(title) + '</h2><button type="button" class="cmms-close" data-action="close-dialog">×</button></div>' +
            fields.map(function (item) {
                return field(item.name, item.label, item.type || 'text', value[item.name], !!item.required, item.options);
            }).join('') +
            '<div class="cmms-form-actions"><button type="button" class="cmms-button secondary" data-action="close-dialog">Annuler</button>' +
            '<button type="submit" class="cmms-button primary">Enregistrer</button></div></form>';
        dialog.showModal();
        dialog.querySelector('form').addEventListener('submit', function (event) {
            event.preventDefault();
            var result = Object.assign({}, value);
            fields.forEach(function (item) {
                var input = dialog.querySelector('[name="' + item.name + '"]');
                result[item.name] = input.value;
            });
            save(result);
        });
    }

    function assetForm(asset) {
        var tags = state.data.tags.map(function (tag) {
            return { value: tag.id, label: tag.device + ' / ' + tag.name + ' (' + tag.type + ')' };
        });
        var values = asset || {};
        openForm(asset ? 'Modifier la fiche équipement' : 'Nouvel équipement', [
            { name: 'name', label: 'Nom', required: true },
            { name: 'equipmentType', label: 'Type d’équipement' },
            { name: 'manufacturer', label: 'Fabricant' },
            { name: 'model', label: 'Modèle' },
            { name: 'serialNumber', label: 'Numéro de série' },
            { name: 'location', label: 'Emplacement' },
            { name: 'commissionedAt', label: 'Mise en service', type: 'date' },
            { name: 'deviceTagId', label: 'Tag de liaison (optionnel)', type: 'select', options: tags },
            { name: 'runtimeTagId', label: 'Compteur horaire (valeur en heures)', type: 'select', options: tags },
            { name: 'runStateTagId', label: 'Tag d’état marche / arrêt', type: 'select', options: tags },
            { name: 'faultTagId', label: 'Tag de défaut', type: 'select', options: tags },
            { name: 'runningThreshold', label: 'Seuil de marche pour un tag numérique', type: 'number' },
            { name: 'operatingHoursManual', label: 'Heures cumulées initiales / saisies', type: 'number' },
            { name: 'description', label: 'Fiche technique / notes', type: 'textarea' }
        ], values, function (result) {
            var path = asset ? '/assets/' + encodeURIComponent(asset.id) : '/assets';
            request(asset ? 'PUT' : 'POST', path, result).then(function () {
                closeDialog();
                return refresh();
            }).catch(showError);
        });
    }

    function orderForm() {
        if (!state.data.assets.length) {
            status('Créez d’abord un équipement.', true);
            return;
        }
        var assets = state.data.assets.map(function (asset) { return { value: asset.id, label: asset.name }; });
        var parts = state.data.parts.map(function (part) {
            return { value: part.id, label: part.name + ' (stock : ' + part.quantity + ' ' + part.unit + ')' };
        });
        openForm('Nouvelle intervention ou panne', [
            { name: 'assetId', label: 'Équipement', type: 'select', required: true, options: assets },
            { name: 'kind', label: 'Type', type: 'select', options: [
                { value: 'intervention', label: 'Intervention' },
                { value: 'failure', label: 'Panne' }
            ] },
            { name: 'title', label: 'Résumé', required: true },
            { name: 'occurredAt', label: 'Date', type: 'datetime-local', required: true },
            { name: 'technician', label: 'Technicien / intervenant' },
            { name: 'status', label: 'Statut', type: 'select', options: [
                { value: 'open', label: 'Ouvert' },
                { value: 'in_progress', label: 'En cours' },
                { value: 'closed', label: 'Clôturé' }
            ] },
            { name: 'durationHours', label: 'Durée (heures)', type: 'number' },
            { name: 'cost', label: 'Coût', type: 'number' },
            { name: 'partId', label: 'Pièce consommée (optionnel)', type: 'select', options: parts },
            { name: 'partQuantity', label: 'Quantité consommée', type: 'number' },
            { name: 'description', label: 'Compte rendu / panne', type: 'textarea' }
        ], { kind: 'intervention', status: 'closed', occurredAt: localDateTime(Date.now()), durationHours: 0, cost: 0, partQuantity: 1 }, function (result) {
            result.occurredAt = result.occurredAt ? new Date(result.occurredAt).toISOString() : '';
            result.partsUsed = result.partId ? [{ partId: result.partId, quantity: Number(result.partQuantity || 1) }] : [];
            delete result.partId;
            delete result.partQuantity;
            request('POST', '/work-orders', result).then(function () {
                closeDialog();
                return refresh();
            }).catch(showError);
        });
    }

    function scheduleForm(schedule) {
        if (!state.data.assets.length) {
            status('Créez d’abord un équipement.', true);
            return;
        }
        openForm(schedule ? 'Modifier une maintenance préventive' : 'Planifier une maintenance préventive', [
            { name: 'assetId', label: 'Équipement', type: 'select', required: true, options: state.data.assets.map(function (asset) {
                return { value: asset.id, label: asset.name };
            }) },
            { name: 'title', label: 'Opération à effectuer', required: true },
            { name: 'intervalDays', label: 'Répétition (jours, 0 si inutilisé)', type: 'number' },
            { name: 'intervalHours', label: 'Répétition (heures compteur, 0 si inutilisé)', type: 'number' },
            { name: 'lastDoneAt', label: 'Dernière réalisation', type: 'date' },
            { name: 'lastDoneHours', label: 'Compteur à la dernière réalisation', type: 'number' },
            { name: 'assignedTo', label: 'Responsable' },
            { name: 'notes', label: 'Consignes', type: 'textarea' }
        ], schedule || { intervalDays: 0, intervalHours: 0, lastDoneHours: 0, enabled: true }, function (result) {
            result.lastDoneAt = result.lastDoneAt ? new Date(result.lastDoneAt).toISOString() : null;
            result.intervalDays = Number(result.intervalDays || 0);
            result.intervalHours = Number(result.intervalHours || 0);
            result.lastDoneHours = Number(result.lastDoneHours || 0);
            var path = schedule ? '/schedules/' + encodeURIComponent(schedule.id) : '/schedules';
            request(schedule ? 'PUT' : 'POST', path, result).then(function () {
                closeDialog();
                return refresh();
            }).catch(showError);
        });
    }

    function partForm(part) {
        openForm(part ? 'Modifier une pièce' : 'Ajouter une pièce de rechange', [
            { name: 'name', label: 'Désignation', required: true },
            { name: 'sku', label: 'Référence' },
            { name: 'quantity', label: 'Quantité en stock', type: 'number' },
            { name: 'minimumQuantity', label: 'Seuil minimum', type: 'number' },
            { name: 'unit', label: 'Unité' },
            { name: 'location', label: 'Emplacement de stockage' }
        ], part || { quantity: 0, minimumQuantity: 0, unit: 'unité' }, function (result) {
            result.quantity = Number(result.quantity || 0);
            result.minimumQuantity = Number(result.minimumQuantity || 0);
            var path = part ? '/parts/' + encodeURIComponent(part.id) : '/parts';
            request(part ? 'PUT' : 'POST', path, result).then(function () {
                closeDialog();
                return refresh();
            }).catch(showError);
        });
    }

    function showDocuments(asset) {
        state.selectedAsset = asset.id;
        state.tab = 'assets';
        draw();
        var panel = document.getElementById('cmms-documents');
        panel.innerHTML = '<section class="cmms-doc-panel"><div class="cmms-toolbar"><h3>Documentation PDF — ' +
            escapeHtml(asset.name) + '</h3><label class="cmms-button primary">Ajouter un PDF<input type="file" id="cmms-pdf" accept="application/pdf,.pdf" hidden></label></div>' +
            (asset.documents && asset.documents.length ? '<ul>' + asset.documents.map(function (doc) {
                return '<li><button type="button" class="cmms-link" data-action="download-doc" data-id="' +
                    escapeHtml(doc.id) + '">' + escapeHtml(doc.name) + '</button> <small>' + formatDate(doc.uploadedAt) +
                    '</small> ' + action(doc.id, 'Supprimer', 'delete-doc', true) + '</li>';
            }).join('') + '</ul>' : '<p class="empty">Aucun document PDF.</p>') + '</section>';
        document.getElementById('cmms-pdf').addEventListener('change', uploadDocument);
    }

    function uploadDocument(event) {
        var file = event.target.files && event.target.files[0];
        if (!file || !state.selectedAsset) {
            return;
        }
        if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
            status('Sélectionnez un document PDF.', true);
            return;
        }
        if (file.size > 15 * 1024 * 1024) {
            status('Le PDF dépasse la limite de 15 Mo.', true);
            return;
        }
        fetch(base + '/assets/' + encodeURIComponent(state.selectedAsset) + '/documents?name=' + encodeURIComponent(file.name), {
            method: 'POST',
            headers: Object.assign({}, SiteApi.headers(false), { 'Content-Type': 'application/pdf' }),
            body: file
        }).then(function (response) {
            if (!response.ok) {
                return response.json().then(function (body) {
                    throw new Error(body && body.error ? body.error.message : 'Erreur ' + response.status);
                });
            }
            return refresh();
        }).then(function () {
            var asset = state.data.assets.filter(function (item) { return item.id === state.selectedAsset; })[0];
            if (asset) {
                showDocuments(asset);
            }
            status('Document PDF ajouté.');
        }).catch(showError);
    }

    function downloadDocument(id) {
        fetch(base + '/documents/' + encodeURIComponent(id), { headers: SiteApi.headers(false) })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('Téléchargement impossible (HTTP ' + response.status + ').');
                }
                return response.blob();
            }).then(function (blob) {
                var documentInfo;
                state.data.assets.some(function (asset) {
                    documentInfo = (asset.documents || []).filter(function (item) { return item.id === id; })[0];
                    return !!documentInfo;
                });
                SiteApi.download(blob, documentInfo ? documentInfo.name : 'document.pdf');
            }).catch(showError);
    }

    function closeDialog() {
        var dialog = document.getElementById('cmms-dialog');
        if (dialog && dialog.open) {
            dialog.close();
        }
    }

    function reload() {
        return Promise.all([
            request('GET', ''),
            request('GET', '/metrics')
        ]).then(function (results) {
            state.data = results[0].data;
            state.metrics = results[1].data;
            draw();
        });
    }

    function refresh() {
        status('Actualisation…');
        return reload().then(function () { status('Données actualisées.'); });
    }

    function showError(error) {
        status(error && error.message ? error.message : String(error), true);
    }

    function bind() {
        if (root.getAttribute('data-bound')) {
            return;
        }
        root.setAttribute('data-bound', 'true');
        root.addEventListener('click', function (event) {
            var target = event.target.closest('[data-tab], [data-action]');
            if (!target || !root.contains(target)) {
                return;
            }
            if (target.hasAttribute('data-tab')) {
                state.tab = target.getAttribute('data-tab');
                draw();
                return;
            }
            var name = target.getAttribute('data-action');
            var id = target.getAttribute('data-id');
            var asset = state.data.assets.filter(function (item) { return item.id === id; })[0];
            var order = state.data.workOrders.filter(function (item) { return item.id === id; })[0];
            var schedule = state.data.schedules.filter(function (item) { return item.id === id; })[0];
            var part = state.data.parts.filter(function (item) { return item.id === id; })[0];
            if (name === 'new-asset') {
                assetForm(null);
            } else if (name === 'edit-asset' && asset) {
                assetForm(asset);
            } else if (name === 'documents' && asset) {
                showDocuments(asset);
            } else if (name === 'delete-asset' && asset && window.confirm('Supprimer la fiche « ' + asset.name + ' » ?')) {
                request('DELETE', '/assets/' + encodeURIComponent(id)).then(refresh).catch(showError);
            } else if (name === 'new-order') {
                orderForm();
            } else if (name === 'close-order' && order) {
                request('PUT', '/work-orders/' + encodeURIComponent(id), Object.assign({}, order, { status: 'closed' })).then(refresh).catch(showError);
            } else if (name === 'delete-order' && order && window.confirm('Supprimer cette entrée d’historique ?')) {
                request('DELETE', '/work-orders/' + encodeURIComponent(id)).then(refresh).catch(showError);
            } else if (name === 'new-schedule') {
                scheduleForm(null);
            } else if (name === 'edit-schedule' && schedule) {
                scheduleForm(schedule);
            } else if (name === 'complete-schedule' && schedule) {
                var metric = (state.metrics.metrics || {})[schedule.assetId] || {};
                request('PUT', '/schedules/' + encodeURIComponent(id), Object.assign({}, schedule, {
                    lastDoneAt: new Date().toISOString(),
                    lastDoneHours: metric.operatingHours || schedule.lastDoneHours || 0
                })).then(refresh).catch(showError);
            } else if (name === 'delete-schedule' && schedule && window.confirm('Supprimer cette planification ?')) {
                request('DELETE', '/schedules/' + encodeURIComponent(id)).then(refresh).catch(showError);
            } else if (name === 'new-part') {
                partForm(null);
            } else if (name === 'edit-part' && part) {
                partForm(part);
            } else if (name === 'delete-part' && part && window.confirm('Supprimer la pièce « ' + part.name + ' » ?')) {
                request('DELETE', '/parts/' + encodeURIComponent(id)).then(refresh).catch(showError);
            } else if (name === 'delete-doc' && window.confirm('Supprimer ce document PDF ?')) {
                request('DELETE', '/documents/' + encodeURIComponent(id)).then(function () {
                    return refresh();
                }).then(function () {
                    var selected = state.data.assets.filter(function (item) { return item.id === state.selectedAsset; })[0];
                    if (selected) {
                        showDocuments(selected);
                    }
                }).catch(showError);
            } else if (name === 'download-doc') {
                downloadDocument(id);
            } else if (name === 'close-dialog') {
                closeDialog();
            }
        });
    }

    var style = document.createElement('style');
    style.textContent = [
        '.cmms-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:12px 0}',
        '.cmms-card{background:#fff;border:1px solid #cfd8dc;border-radius:6px;padding:12px 15px;color:#607d8b}',
        '.cmms-card b{display:block;color:#1f3864;font-size:25px;margin-top:5px}.cmms-card.warning{border-left:4px solid #ef6c00}.cmms-card.danger{border-left:4px solid #c62828}',
        '.cmms-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:2px solid #1f3864;margin:16px 0 8px}',
        '.cmms-tab{border:1px solid #cfd8dc;border-bottom:0;background:#eceff1;border-radius:5px 5px 0 0;padding:8px 14px;cursor:pointer}',
        '.cmms-tab.selected{background:#1f3864;color:#fff}.cmms-panel{background:#fff;border:1px solid #d5dce5;border-radius:6px;padding:14px;overflow:auto}',
        '.cmms-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.cmms-toolbar h2{margin:5px 0}',
        '.cmms-table-wrap{overflow:auto}.cmms-table{min-width:900px}.cmms-button{padding:6px 10px;border:1px solid #9eacb4;border-radius:4px;background:#fff;cursor:pointer;white-space:nowrap}',
        '.cmms-button.primary{background:#1e88e5;color:#fff;border:0}.cmms-button.secondary{background:#eceff1}.cmms-actions{white-space:nowrap}',
        '.cmms-actions .cmms-button{margin:2px}.cmms-badge{display:inline-block;border-radius:12px;padding:3px 8px;font-size:12px;white-space:nowrap}',
        '.cmms-badge.good{background:#e8f5e9;color:#1b5e20}.cmms-badge.warning{background:#fff3e0;color:#e65100}.cmms-badge.danger{background:#ffebee;color:#b71c1c}.cmms-badge.neutral{background:#eceff1;color:#546e7a}',
        '.cmms-hint{color:#607d8b;font-size:13px}.cmms-status{min-height:20px;color:#546e7a}.cmms-status.error{color:#c62828;font-weight:bold}',
        '.cmms-alerts{background:#fff8e1;border-left:4px solid #ef6c00;border-radius:4px;padding:8px 14px;margin:10px 0;color:#6d4c41}.cmms-alerts ul{margin:6px 0;padding-left:22px}.cmms-alerts li{padding:3px 0}',
        '.cmms-doc-panel{margin-top:16px;padding:12px;border:1px solid #cfd8dc;border-radius:6px;background:#f8fafc}.cmms-doc-panel li{padding:6px;border-bottom:1px solid #e0e0e0}',
        '.cmms-link{border:0;background:none;color:#1565c0;text-decoration:underline;cursor:pointer}.cmms-close{font-size:20px;border:0;background:none;cursor:pointer}',
        '.cmms-form{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:10px;min-width:min(720px,80vw);max-height:80vh;overflow:auto;padding:16px}',
        '.cmms-form .cmms-toolbar,.cmms-form-actions{grid-column:1/-1}.cmms-field{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#37474f}',
        '.cmms-field input,.cmms-field select,.cmms-field textarea{box-sizing:border-box;width:100%;padding:7px;border:1px solid #b0bec5;border-radius:3px;font:inherit}',
        '.cmms-field textarea{resize:vertical}.cmms-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}',
        '#cmms-dialog{border:0;border-radius:8px;padding:0;box-shadow:0 6px 24px #0005}#cmms-dialog::backdrop{background:#0006}',
        '@media(max-width:650px){.cmms-form{grid-template-columns:1fr;min-width:0}.cmms-form .cmms-toolbar,.cmms-form-actions{grid-column:auto}}'
    ].join('');
    document.head.appendChild(style);
    root.addEventListener('click', function (event) {
        if (event.target === document.getElementById('cmms-dialog')) {
            closeDialog();
        }
    });
    reload().catch(showError);
    window.setInterval(function () {
        var dialog = document.getElementById('cmms-dialog');
        if (!dialog || !dialog.open) {
            reload().catch(showError);
        }
    }, 60000);
})();
