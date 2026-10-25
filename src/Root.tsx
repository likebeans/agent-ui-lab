import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isDocsHash } from '../shared/doc-navigation';
import { ChatWorkspace } from './ChatWorkspace';

const Labs = lazy(() => import('./App').then((module) => ({ default: module.App })));
const DocsReader = lazy(() => import('./DocsReader'));

export function Root() {
  const [route, setRoute] = useState(() => {
    const hash = window.location.hash;
    const workspace = isDocsHash(hash) ? '#chat' : hash || '#chat';
    return {
      hash,
      workspace,
      chatVisited: workspace === '#chat',
      labHash: workspace === '#chat' ? null : workspace,
    };
  });
  const reading = isDocsHash(route.hash);
  const chatting = route.workspace === '#chat';
  const returnFocus = useRef<Record<'chat' | 'labs', HTMLElement | null>>({
    chat: null,
    labs: null,
  });
  const workspaceScroll = useRef({ chat: 0, labs: 0 });
  const previousWorkspace = useRef(route.workspace);
  const wasReading = useRef(reading);

  useEffect(() => {
    const changed = () => {
      const hash = window.location.hash;
      const nextReading = isDocsHash(hash);
      const nextWorkspace = nextReading ? previousWorkspace.current : hash || '#chat';
      const leavingWorkspace =
        (previousWorkspace.current === '#chat') !== (nextWorkspace === '#chat');
      if (!wasReading.current && (nextReading || leavingWorkspace)) {
        const key = previousWorkspace.current === '#chat' ? 'chat' : 'labs';
        returnFocus.current[key] =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        workspaceScroll.current[key] = window.scrollY;
      }
      setRoute((previous) => ({
        hash,
        workspace: nextWorkspace,
        chatVisited: previous.chatVisited || nextWorkspace === '#chat',
        labHash: nextWorkspace === '#chat' ? previous.labHash : nextWorkspace,
      }));
      previousWorkspace.current = nextWorkspace;
      wasReading.current = nextReading;
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  useEffect(() => {
    if (reading) return;
    const key = chatting ? 'chat' : 'labs';
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: workspaceScroll.current[key], behavior: 'instant' });
      const target = returnFocus.current[key];
      if (target?.isConnected && target.getClientRects().length)
        target.focus({ preventScroll: true });
      returnFocus.current[key] = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [reading, chatting]);

  return (
    <>
      <div hidden={reading || !chatting} inert={reading || !chatting}>
        {route.chatVisited && <ChatWorkspace active={!reading && chatting} />}
      </div>
      <div hidden={reading || chatting} inert={reading || chatting}>
        {route.labHash !== null && (
          <Suspense fallback={<p style={{ padding: 32 }}>正在打开实验…</p>}>
            <Labs hash={route.labHash} active={!reading && !chatting} />
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
