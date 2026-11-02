/** Presentation-only switching around one caller-owned browser session and viewport. */
export function createSurfaceHost<T extends object>({session, viewport, playPane, researchPane}: {
  session: T;
  viewport: HTMLElement;
  playPane: HTMLElement;
  researchPane: HTMLElement;
}) {
  if (!session || !viewport || !playPane || !researchPane ||
      viewport === playPane || viewport === researchPane || playPane === researchPane ||
      typeof viewport.contains !== 'function' || typeof playPane.contains !== 'function' || typeof researchPane.contains !== 'function' ||
      playPane.contains(viewport) || researchPane.contains(viewport) ||
      viewport.contains(playPane) || viewport.contains(researchPane) ||
      playPane.contains(researchPane) || researchPane.contains(playPane)) {
    throw new Error('Invalid surface panes or viewport');
  }
  let surface: 'play' | 'research' = 'play';
  playPane.hidden = false;
  researchPane.hidden = true;
  return Object.freeze({
    session,
    get surface() { return surface; },
    setSurface(next: 'play' | 'research') {
      if (next !== 'play' && next !== 'research') throw new Error('Invalid surface');
      playPane.hidden = next !== 'play';
      researchPane.hidden = next !== 'research';
      surface = next;
    },
  });
}


