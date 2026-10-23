import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isDocsHash } from '../shared/doc-navigation';
import { ChatWorkspace } from './ChatWorkspace';

const Labs = lazy(() => import('./App').then((module) => ({ default: module.App })));
const DocsReader = lazy(() => import('./DocsReader'));

export function Root() {
  const [route, setRoute] = useState(() => {
    const hash = window.location.hash;
    return { hash, workspace: isDocsHash(hash) ? '#chat' : hash || '#chat' };
  });
  const reading = isDocsHash(route.hash);
  const returnFocus = useRef<HTMLElement | null>(null);
  const workspaceScroll = useRef(0);
  const wasReading = useRef(reading);

  useEffect(() => {
    const changed = () => {
      const hash = window.location.hash;
      if (isDocsHash(hash) && !wasReading.current) {
        returnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        workspaceScroll.current = window.scrollY;
      }
      setRoute((previous) => ({
        hash,
        workspace: isDocsHash(hash) ? previous.workspace : hash || '#chat',
      }));
      wasReading.current = isDocsHash(hash);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  useEffect(() => {
    if (reading) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: workspaceScroll.current, behavior: 'instant' });
      const target = returnFocus.current;
      if (target?.isConnected && target.getClientRects().length)
        target.focus({ preventScroll: true });
      returnFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [reading]);

  return (
    <>
      <div hidden={reading} inert={reading}>
        {route.workspace === '#chat' ? (
          <ChatWorkspace active={!reading} />
        ) : (
          <Suspense fallback={<p style={{ padding: 32 }}>正在打开实验…</p>}>
            <Labs hash={route.workspace} active={!reading} />
          </Suspense>
        )}
      </div>
      {reading && (
        <Suspense
          fallback={
            <p role="status" style={{ padding: 32 }}>
              正在打开学习文档…
            </p>
          }
        >
          <DocsReader hash={route.hash} returnTo={route.workspace} />
        </Suspense>
      )}
    </>
  );
}
