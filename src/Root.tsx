import { useEffect, useRef, useState } from 'react';
import { isDocsHash } from '../shared/doc-navigation';
import { ChatWorkspace } from './ChatWorkspace';
import { RecoverableModule } from './components/RecoverableModule';

const loadLabs = () => import('./App').then((module) => ({ default: module.App }));
const loadDocs = () => import('./DocsReader');

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
          <RecoverableModule
            load={loadLabs}
            componentProps={{ hash: route.labHash, active: !reading && !chatting }}
            name="独立实验"
            returnTo="#chat"
            returnLabel="返回 Agent 对话"
            active={!reading && !chatting}
          />
        )}
      </div>
      {reading && (
        <RecoverableModule
          load={loadDocs}
          componentProps={{ hash: route.hash, returnTo: route.workspace }}
          name="学习文档"
          returnTo={route.workspace}
          returnLabel={route.workspace === '#chat' ? '返回 Agent 对话' : '返回独立实验'}
        />
      )}
    </>
  );
}
