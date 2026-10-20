import { formatDelay, formatEta } from './labels';

describe('labels', () => {
  it('formats delays', () => {
    expect(formatDelay(20)).toBe("À l'heure");
    expect(formatDelay(130)).toBe('+2 min');
    expect(formatDelay(-90)).toBe('-2 min');
  });

  it('formats ETAs', () => {
    expect(formatEta(10)).toBe('À quai');
    expect(formatEta(45)).toBe('Proche');
    expect(formatEta(185)).toBe('3 min');
  });
});
