import { Injectable, signal } from '@angular/core';
import type { IncidentSeverityTag } from './labels';

export type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'incident' | 'escalation' | 'resolved' | 'system' | 'message';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  severity?: IncidentSeverityTag;
  /** Date.now() when pushed. */
  at: number;
}

const MAX_TOASTS = 5;
const DEFAULT_DURATION_MS = 6000;

/**
 * Toast queue. Fed by SpacetimeService (AlertEvent inserts, new driver messages, reducer errors)
 * and by screens. Has no dependency on SpacetimeService (dependency direction: Spacetime → Toast).
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  push(toast: Omit<Toast, 'id' | 'at'>, durationMs = DEFAULT_DURATION_MS): number {
    const id = this.nextId++;
    const full: Toast = { ...toast, id, at: Date.now() };
    this._toasts.update((list) => [...list, full].slice(-MAX_TOASTS));
    if (durationMs > 0) setTimeout(() => this.dismiss(id), durationMs);
    return id;
  }

  info(title: string, body?: string): number {
    return this.push({ kind: 'info', title, body });
  }

  success(title: string, body?: string): number {
    return this.push({ kind: 'success', title, body }, 3500);
  }

  error(title: string, body?: string): number {
    return this.push({ kind: 'error', title, body }, 8000);
  }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  clear(): void {
    this._toasts.set([]);
  }
}
