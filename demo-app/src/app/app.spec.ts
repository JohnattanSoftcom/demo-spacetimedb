import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { SpacetimeService } from './core/spacetime.service';

/** Minimal fake so the shell test never opens a WebSocket. */
const fakeSpacetime = {
  status: signal('connected'),
  identityHex: signal('c200aabbccdd'),
  lastError: signal(undefined),
  me: signal(undefined),
  newIdentity: () => {},
};

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), { provide: SpacetimeService, useValue: fakeSpacetime }],
    }).compileComponents();
  });

  it('renders the top bar with brand and connection status', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('header')?.textContent).toContain('TransVille');
    expect(el.textContent).toContain('Connecté');
  });
});
