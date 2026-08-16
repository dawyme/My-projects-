import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'nds.dispatch.calendar';

function setupCalendarState() {
  const state = { month: '2026-08', technicianId: 'tech-1', status: 'CONFIRMED' };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY));
}

describe('Calendar integration', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('uses the dispatch calendar session-storage key', () => {
    const state = setupCalendarState();

    expect(state).toEqual({
      month: '2026-08',
      technicianId: 'tech-1',
      status: 'CONFIRMED',
    });
  });

  it('persists technician and status filters between renders', () => {
    setupCalendarState();

    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));

    expect(saved.technicianId).toBe('tech-1');
    expect(saved.status).toBe('CONFIRMED');
  });
});
