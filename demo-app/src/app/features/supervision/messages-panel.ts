import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { byTimestampDesc, formatAge, formatShortTime } from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import type { DriverMessage } from '../../../module_bindings/types';
import { SupervisionStore } from './supervision-store';

const MAX_LEN = 280;
const TEMPLATES = [
  'Merci de rappeler le PCC dès que possible.',
  'Déviation en cours, suivez les consignes du régulateur.',
  "Vous êtes en avance, merci de réguler à l'arrêt suivant.",
  'Intervention en route, restez à bord et sécurisez les voyageurs.',
  'Fin de service : retour au dépôt après le terminus.',
];

@Component({
  selector: 'app-messages-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="space-y-2 border-b border-slate-200 bg-slate-50 p-4" (submit)="$event.preventDefault(); send()">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-slate-900">Message à un chauffeur</h3>
        <span class="text-[11px] text-slate-500">Destinataire résolu par le serveur</span>
      </div>
      <select
        class="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        aria-label="Véhicule destinataire"
        (change)="store.messageVehicleId.set(toId($any($event.target).value))"
      >
        <option value="" [selected]="!store.messageVehicleId()">— Choisir un véhicule —</option>
        @for (o of options(); track o.id) {
          <option [value]="o.id" [disabled]="!o.driver" [selected]="store.messageVehicleId() === o.id">{{ o.label }}</option>
        }
      </select>
      <textarea
        rows="3"
        [attr.maxlength]="maxLen"
        class="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        placeholder="Votre message (pas de données personnelles inutiles)"
        aria-label="Message"
        [value]="body()"
        (input)="body.set($any($event.target).value)"
      ></textarea>
      <div class="flex flex-wrap gap-1">
        @for (t of templates; track t) {
          <button
            type="button"
            class="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-sky-400 hover:text-sky-700"
            (click)="body.set(t)"
          >
            {{ t.length > 34 ? t.slice(0, 32) + '…' : t }}
          </button>
        }
      </div>
      <div class="flex items-center justify-between">
        <span class="text-xs tabular-nums" [class]="body().length > maxLen ? 'text-red-600' : 'text-slate-500'">{{ body().length }}/{{ maxLen }}</span>
        <button
          type="submit"
          class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 disabled:opacity-50"
          [disabled]="!stdb.isConnected() || store.isPending('send-message') || !store.messageVehicleId() || !body().trim()"
        >
          {{ store.isPending('send-message') ? 'Envoi…' : 'Envoyer' }}
        </button>
      </div>
      <p class="text-[11px] leading-snug text-slate-500">
        🔒 Seul le chauffeur du véhicule reçoit ce message (vue <code>MyMessages</code> filtrée par identité côté serveur). Les autres
        chauffeurs et les bornes ne le voient jamais.
      </p>
    </form>

    <div class="flex items-center justify-between px-4 pt-3 pb-1">
      <h3 class="text-xs font-semibold tracking-wider text-slate-500 uppercase">Messages envoyés</h3>
      <span class="text-[11px] text-slate-400">50 derniers</span>
    </div>
    <ul class="space-y-2 px-4 pb-4">
      @for (m of messages(); track m.id) {
        <li class="rounded-lg border border-slate-200 bg-white p-2.5 text-sm shadow-sm">
          <div class="flex items-center gap-2 text-xs">
            <span class="font-semibold text-slate-800">{{ vehicleLabel(m) }}</span>
            <span class="text-slate-500">→ {{ driverName(m) }}</span>
            <span class="ml-auto text-slate-400" [title]="short(m.sentAt)">{{ age(m) }}</span>
          </div>
          <p class="mt-1 break-words text-slate-700">{{ m.body }}</p>
          <div class="mt-1 flex items-center justify-between text-[11px]">
            <span class="text-slate-400">par {{ m.fromName }}</span>
            @if (m.acknowledged) {
              <span class="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">Lu ✓ {{ short(m.acknowledgedAt) }}</span>
            } @else {
              <span class="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">Non lu</span>
            }
          </div>
        </li>
      } @empty {
        <li class="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Aucun message envoyé.</li>
      }
    </ul>
  `,
})
export class MessagesPanel {
  protected readonly stdb = inject(SpacetimeService);
  protected readonly store = inject(SupervisionStore);
  protected readonly maxLen = MAX_LEN;
  protected readonly templates = TEMPLATES;

  protected readonly body = signal('');
  private readonly sending = signal(false);

  protected readonly options = computed(() => {
    const asg = this.stdb.assignmentByVehicleId();
    const online = this.stdb.onlineIdentities();
    const lineById = this.stdb.lineById();
    return [...this.stdb.vehicles()]
      .sort((a, b) => a.lineId - b.lineId || a.label.localeCompare(b.label))
      .map((v) => {
        const a = asg.get(v.id);
        const line = lineById.get(v.lineId);
        const who = a ? `${a.driverName}${online.has(a.driverIdentity.toHexString()) ? '' : ' (hors ligne)'}` : 'sans chauffeur';
        return { id: v.id, driver: !!a, label: `${v.label} · Ligne ${line?.code ?? '?'} — ${who}` };
      });
  });

  protected readonly messages = computed(() => [...this.stdb.supervisorMessages()].sort(byTimestampDesc((m) => m.sentAt)));

  protected toId(v: string): number | undefined {
    return v ? Number(v) : undefined;
  }
  protected vehicleLabel(m: DriverMessage): string {
    return this.stdb.vehicleById().get(m.vehicleId)?.label ?? `Véhicule ${m.vehicleId}`;
  }
  protected driverName(m: DriverMessage): string {
    return this.stdb.userByIdentity().get(m.toDriver.toHexString())?.name ?? 'chauffeur';
  }
  protected age(m: DriverMessage): string {
    return formatAge(m.sentAt, this.store.now());
  }
  protected short(ts: DriverMessage['acknowledgedAt']): string {
    return formatShortTime(ts);
  }

  protected send(): void {
    const vehicleId = this.store.messageVehicleId();
    const body = this.body().trim();
    if (vehicleId === undefined || !body || this.sending()) return;
    this.sending.set(true);
    void this.store
      .run('send-message', 'Envoyer un message', () => this.stdb.conn.reducers.sendDriverMessage({ vehicleId, body }))
      .then((ok) => {
        this.sending.set(false);
        if (ok) this.body.set('');
      });
  }
}
