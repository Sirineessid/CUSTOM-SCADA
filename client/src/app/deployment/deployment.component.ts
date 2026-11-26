import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { exhaustMap, Subscription, timer } from 'rxjs';
import { EndPointApi } from '../_helpers/endpointapi';
import * as FileSaver from 'file-saver';

interface ApiResponse<T> {
    data: T;
}

interface DeploymentSite {
    site_id: string;
    state: string;
    port: number;
}

interface PreflightCheck {
    name: string;
    ok: boolean;
    pages?: number;
    devices?: number;
}

interface PreflightResult {
    ok: boolean;
    checks: PreflightCheck[];
    errors: string[];
    warnings: string[];
}

interface OperationLog {
    time: string;
    message: string;
}

interface DeploymentOperation {
    operation_id: string;
    state: string;
    progress: number;
    logs: OperationLog[];
    release?: string;
    url?: string;
}

interface DeploymentStatus {
    running: boolean;
    mode: string;
    current: string;
    previous: string | null;
    url: string;
    publishedAt: string;
}

interface DeploymentHistory {
    action: string;
    release: string;
    url?: string;
    time: string;
}

interface DeploymentTarget {
    agentUrl: string;
    mode: 'ip-port' | 'iis';
    runtimePort: number;
    publicHost: string;
    https: boolean;
    iisSiteName: string;
    iisPort: number;
    iisHost: string;
    certificateThumbprint: string;
}

@Component({
    selector: 'app-deployment',
    templateUrl: './deployment.component.html',
    styleUrls: ['./deployment.component.scss']
})
export class DeploymentComponent implements OnInit, OnDestroy {
    sites: DeploymentSite[] = [];
    siteId = '';
    target: DeploymentTarget = this.defaultTarget();
    latest: DeploymentHistory | null = null;
    checks: PreflightCheck[] = [];
    errors: string[] = [];
    warnings: string[] = [];
    operation: DeploymentOperation | null = null;
    remoteStatus: DeploymentStatus | null = null;
    busy = false;
    message = '';
    private endpoint = EndPointApi.getURL();
    private polling?: Subscription;

    constructor(private http: HttpClient, private route: ActivatedRoute) { }

    ngOnInit() {
        const requestedSite = this.route.snapshot.queryParamMap.get('site');
        this.http.get<ApiResponse<DeploymentSite[]>>(`${this.endpoint}/api/v1/sites`).subscribe({
            next: response => {
                this.sites = response.data || [];
                if (!this.siteId && this.sites.length) {
                    this.siteId = this.sites.find(site => site.site_id === requestedSite)?.site_id || this.sites[0].site_id;
                    this.loadSite();
                }
            },
            error: (error: unknown) => this.showError(error)
        });
    }

    ngOnDestroy() {
        if (this.polling) {
            this.polling.unsubscribe();
        }
    }

    onSiteChange() {
        this.polling?.unsubscribe();
        this.polling = undefined;
        this.operation = null;
        this.latest = null;
        this.remoteStatus = null;
        this.errors = [];
        this.warnings = [];
        this.checks = [];
        this.loadSite();
    }

    saveTarget() {
        this.busy = true;
        this.http.put<ApiResponse<DeploymentTarget>>(this.url('/target'), this.target).subscribe({
            next: response => {
                this.target = Object.assign(this.defaultTarget(), response.data || {});
                this.message = 'Configuration de la cible enregistrée.';
                this.busy = false;
            },
            error: (error: unknown) => {
                this.showError(error);
                this.busy = false;
            }
        });
    }

    verify() {
        this.busy = true;
        this.errors = [];
        this.warnings = [];
        this.checks = [];
        this.http.post<ApiResponse<PreflightResult>>(this.url('/preflight'), {}).subscribe({
            next: response => {
                this.applyPreflight(response.data);
                this.busy = false;
            },
            error: (error: unknown) => {
                if (error instanceof HttpErrorResponse && this.isRecord(error.error) && this.isPreflightResult(error.error.data)) {
                    this.applyPreflight(error.error.data);
                } else {
                    this.showError(error);
                }
                this.busy = false;
            }
        });
    }

    generatePackage() {
        this.busy = true;
        this.http.get(this.url('/package'), { observe: 'response', responseType: 'blob' }).subscribe({
            next: response => {
                if (!response.body) {
                    this.message = 'Le serveur a retourné un package vide.';
                    this.busy = false;
                    return;
                }
                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/);
                FileSaver.saveAs(response.body, match ? match[1] : `FUXA_${this.siteId}.zip`);
                this.message = 'Package de déploiement généré.';
                this.busy = false;
            },
            error: (error: unknown) => {
                this.showError(error);
                this.busy = false;
            }
        });
    }

    publish() {
        this.busy = true;
        this.operation = null;
        this.http.post<ApiResponse<DeploymentOperation>>(this.url('/publish'), {}).subscribe({
            next: response => {
                this.operation = response.data;
                this.busy = false;
                this.pollOperation();
            },
            error: (error: unknown) => {
                this.showError(error);
                this.busy = false;
            }
        });
    }

    loadStatus() {
        this.http.get<ApiResponse<DeploymentStatus>>(this.url('/status')).subscribe({
            next: response => this.remoteStatus = response.data,
            error: (error: unknown) => {
                if (error instanceof HttpErrorResponse && error.status === 404) {
                    this.remoteStatus = null;
                } else {
                    this.showError(error);
                }
            }
        });
    }

    rollback() {
        if (!confirm('Restaurer la version précédemment publiée ?')) {
            return;
        }
        this.busy = true;
        this.http.post<ApiResponse<DeploymentStatus>>(this.url('/rollback'), {}).subscribe({
            next: response => {
                this.remoteStatus = response.data;
                this.latest = { action: 'rollback', release: response.data.current, url: response.data.url, time: new Date().toISOString() };
                this.message = 'Retour arrière effectué.';
                this.busy = false;
            },
            error: (error: unknown) => {
                this.showError(error);
                this.busy = false;
            }
        });
    }

    setMode(mode: 'ip-port' | 'iis') {
        this.target.mode = mode;
        if (mode === 'iis' && !this.target.iisPort) {
            this.target.iisPort = this.target.https ? 443 : 80;
        }
    }

    private loadSite() {
        if (!this.siteId) {
            return;
        }
        this.http.get<ApiResponse<{ target: DeploymentTarget | null; latest: DeploymentHistory | null }>>(this.url('')).subscribe({
            next: response => {
                const value = response.data;
                this.target = Object.assign(this.defaultTarget(), value.target || {});
                this.latest = value.latest || null;
                this.loadStatus();
            },
            error: (error: unknown) => {
                if (error instanceof HttpErrorResponse && error.status === 404) {
                    this.target = this.defaultTarget();
                    this.latest = null;
                } else {
                    this.showError(error);
                }
            }
        });
    }

    private pollOperation() {
        if (!this.operation) {
            return;
        }
        const operationId = this.operation.operation_id;
        this.polling = timer(0, 1000).pipe(
            exhaustMap(() => this.http.get<ApiResponse<DeploymentOperation>>(
                this.url(`/operations/${encodeURIComponent(operationId)}`)
            ))
        ).subscribe({
            next: response => {
                this.operation = response.data;
                if (['published', 'failed'].includes(this.operation.state)) {
                    this.polling?.unsubscribe();
                    this.polling = undefined;
                    if (this.operation.state === 'published') {
                        this.message = 'Publication terminée.';
                        this.latest = {
                            action: 'publish',
                            release: this.operation.release || '',
                            url: this.operation.url,
                            time: new Date().toISOString()
                        };
                        this.loadStatus();
                    } else {
                        this.message = this.operation.logs[this.operation.logs.length - 1]?.message || 'Échec de la publication.';
                    }
                }
            },
            error: (error: unknown) => {
                this.polling?.unsubscribe();
                this.polling = undefined;
                this.showError(error);
            }
        });
    }

    private applyPreflight(result: PreflightResult) {
        this.checks = result.checks || [];
        this.errors = result.errors || [];
        this.warnings = result.warnings || [];
        this.message = result.ok ? 'Vérification terminée : configuration prête.' : 'La vérification a détecté des points à corriger.';
    }

    private showError(error: unknown) {
        if (error instanceof HttpErrorResponse) {
            const body = this.isRecord(error.error) ? error.error : {};
            this.message = typeof body.message === 'string'
                ? body.message
                : typeof body.error === 'string' ? body.error : error.message;
            return;
        }
        this.message = error instanceof Error ? error.message : 'Une erreur est survenue.';
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object';
    }

    private isPreflightResult(value: unknown): value is PreflightResult {
        return this.isRecord(value) &&
            typeof value.ok === 'boolean' &&
            Array.isArray(value.checks) &&
            Array.isArray(value.errors) &&
            Array.isArray(value.warnings);
    }

    private url(suffix: string) {
        return `${this.endpoint}/api/v1/sites/${encodeURIComponent(this.siteId)}/deployment${suffix}`;
    }

    private defaultTarget(): DeploymentTarget {
        return {
            agentUrl: 'http://127.0.0.1:1882',
            mode: 'ip-port',
            runtimePort: 1881,
            publicHost: 'localhost',
            https: false,
            iisSiteName: '',
            iisPort: 80,
            iisHost: '',
            certificateThumbprint: ''
        };
    }
}
