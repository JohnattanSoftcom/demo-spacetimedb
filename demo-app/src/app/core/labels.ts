import type { Timestamp } from 'spacetimedb';
import type {
  IncidentKind,
  IncidentSeverity,
  IncidentStatus,
  Role,
  VehicleStatus,
} from '../../module_bindings/types';

/** Tag unions of the generated enums (`{ tag: 'Open' }` → `'Open'`). */
export type RoleTag = Role['tag'];
export type IncidentKindTag = IncidentKind['tag'];
export type IncidentSeverityTag = IncidentSeverity['tag'];
export type IncidentStatusTag = IncidentStatus['tag'];
export type VehicleStatusTag = VehicleStatus['tag'];

export const ROLE_LABELS: Record<RoleTag, string> = {
  Supervisor: 'Superviseur PCC',
  Driver: 'Chauffeur',
  Passenger: 'Voyageur',
};

export const INCIDENT_KIND_LABELS: Record<IncidentKindTag, string> = {
  Breakdown: 'Panne',
  Accident: 'Accident',
  Assault: 'Agression',
  PassengerIllness: 'Voyageur malaise',
  Delay: 'Retard',
};

/** Ordered list for the driver's "Signaler un incident" buttons. */
export const INCIDENT_KINDS: IncidentKindTag[] = [
  'Breakdown',
  'Accident',
  'Assault',
  'PassengerIllness',
  'Delay',
];

export const SEVERITY_LABELS: Record<IncidentSeverityTag, string> = {
  Low: 'Faible',
  Medium: 'Moyenne',
  High: 'Haute',
  Critical: 'Critique',
};

/** Numeric rank for sorting (higher = more severe). */
export const SEVERITY_RANK: Record<IncidentSeverityTag, number> = {
  Low: 0,
  Medium: 1,
  High: 2,
  Critical: 3,
};

/** Tailwind classes for severity chips. */
export const SEVERITY_CLASSES: Record<IncidentSeverityTag, string> = {
  Low: 'bg-slate-200 text-slate-800',
  Medium: 'bg-amber-200 text-amber-900',
  High: 'bg-orange-500 text-white',
  Critical: 'bg-red-600 text-white',
};

/** Hex colours for severity (map markers). */
export const SEVERITY_COLORS: Record<IncidentSeverityTag, string> = {
  Low: '#64748b',
  Medium: '#f59e0b',
  High: '#f97316',
  Critical: '#dc2626',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatusTag, string> = {
  Open: 'Ouvert',
  InProgress: 'Pris en charge',
  Resolved: 'Résolu',
};

export const VEHICLE_STATUS_LABELS: Record<VehicleStatusTag, string> = {
  EnRoute: 'En ligne',
  AtStop: "À l'arrêt",
  Layover: 'Battement au terminus',
  Immobilized: 'Immobilisé',
};

/** Builders for enum values sent to reducers. */
export const role = (tag: RoleTag): Role => ({ tag }) as Role;
export const incidentKind = (tag: IncidentKindTag): IncidentKind => ({ tag }) as IncidentKind;

/** "+2 min", "-30 s", "À l'heure" (|delay| < 60 s). Positive = late. */
export function formatDelay(delaySeconds: number): string {
  const abs = Math.abs(delaySeconds);
  if (abs < 60) return "À l'heure";
  const sign = delaySeconds > 0 ? '+' : '-';
  return `${sign}${Math.round(abs / 60)} min`;
}

/** Tailwind classes for a delay chip. */
export function delayClass(delaySeconds: number): string {
  if (delaySeconds >= 300) return 'bg-red-600 text-white';
  if (delaySeconds >= 120) return 'bg-amber-400 text-amber-950';
  if (delaySeconds <= -60) return 'bg-sky-200 text-sky-900';
  return 'bg-emerald-200 text-emerald-900';
}

/** Stop-board ETA: "À quai" (< 30 s), "Proche" (< 60 s), "N min". */
export function formatEta(etaSeconds: number): string {
  if (etaSeconds < 30) return 'À quai';
  if (etaSeconds < 60) return 'Proche';
  return `${Math.floor(etaSeconds / 60)} min`;
}

const timeFmt = new Intl.DateTimeFormat('fr-CH', { timeStyle: 'medium' });
const shortTimeFmt = new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' });

/** "10:42:13" */
export function formatTime(ts: Timestamp | undefined): string {
  return ts ? timeFmt.format(ts.toDate()) : '';
}

/** "10:42" */
export function formatShortTime(ts: Timestamp | undefined): string {
  return ts ? shortTimeFmt.format(ts.toDate()) : '';
}

/** "à l'instant", "il y a 2 min", "il y a 1 h". `nowMs` lets callers pass a ticking clock signal. */
export function formatAge(ts: Timestamp, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - ts.toDate().getTime()) / 1000));
  if (s < 30) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h`;
}

/** Microseconds since epoch, for sorting rows by a Timestamp column. */
export function tsMicros(ts: Timestamp | undefined): bigint {
  return ts ? ts.microsSinceUnixEpoch : 0n;
}

/** Comparator: newest first. Usage: `[...rows].sort(byTimestampDesc(r => r.reportedAt))`. */
export function byTimestampDesc<T>(get: (row: T) => Timestamp | undefined) {
  return (a: T, b: T): number => {
    const x = tsMicros(get(a));
    const y = tsMicros(get(b));
    return x === y ? 0 : x > y ? -1 : 1;
  };
}

/** Short identity for display: first 8 hex chars. */
export function shortIdentity(hex: string | undefined): string {
  return hex ? hex.slice(0, 8) : '—';
}
